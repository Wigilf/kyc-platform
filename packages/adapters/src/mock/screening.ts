import { nameSimilarity, normalizeCountry, normalizeName, toDateOnly } from '@kyc/core';
import type {
  AdapterContext,
  AdapterResult,
  Finding,
  ScreeningAdapter,
  ScreeningHit,
  ScreeningRequest,
  ScreeningResult,
} from '../types.js';
import { simulateLatency } from '../deterministic.js';

/**
 * Local screening adapter.
 *
 * This is the one "mock" adapter whose matching logic is production-grade,
 * because match quality is not something you can defer to a vendor and forget:
 * the false-positive rate determines how much analyst time the platform consumes,
 * and the false-negative rate determines whether it works at all.
 *
 * The corpus is supplied by the caller (in practice, the WatchlistEntry table),
 * so the same code path serves mock mode and a cached-provider deployment.
 */

export interface WatchlistCandidate {
  id: string;
  listType: string;
  listName: string;
  entityType: 'INDIVIDUAL' | 'COMPANY';
  fullName: string;
  aliases: string[];
  dob?: string | null;
  yobOnly?: number | null;
  countries: string[];
  positions?: string[];
  pepTier?: number | null;
  program?: string | null;
  remarks?: string | null;
  categories?: string[];
  listedAt?: string | null;
  raw?: Record<string, unknown>;
}

export interface WatchlistSource {
  /**
   * Returns candidates worth scoring. Implementations should pre-filter cheaply
   * (list type, entity type, a name token or two) and leave scoring to us —
   * pre-filtering on exact name would defeat fuzzy matching entirely.
   */
  load(req: {
    listTypes: string[];
    entityType: 'INDIVIDUAL' | 'COMPANY';
    nameTokens: string[];
  }): Promise<WatchlistCandidate[]>;
}

/** Used when a caller supplies no usable threshold. Matches the level default. */
const DEFAULT_FUZZINESS = 0.75;

/** Corroboration weights, applied after the base name similarity. */
const DOB_EXACT_BOOST = 0.12;
const YOB_MATCH_BOOST = 0.05;
const COUNTRY_MATCH_BOOST = 0.04;
/**
 * A confirmed different date of birth is the single most useful discriminator
 * available for clearing false positives, so it is weighted heavily. Two people
 * with the same name and different birthdays are two people.
 */
const DOB_CONFLICT_PENALTY = 0.35;
const COUNTRY_CONFLICT_PENALTY = 0.03;

export function scoreCandidate(
  req: Pick<ScreeningRequest, 'name' | 'dob' | 'yearOfBirth' | 'country' | 'nationality'>,
  candidate: WatchlistCandidate,
): { score: number; matchedFields: string[]; matchedName: string } {
  const names = [candidate.fullName, ...candidate.aliases].filter(Boolean);

  let best = 0;
  let bestName = candidate.fullName;
  for (const name of names) {
    const s = nameSimilarity(req.name, name);
    if (s > best) {
      best = s;
      bestName = name;
    }
  }

  const matchedFields: string[] = [];
  if (best >= 0.99) matchedFields.push('NAME_EXACT');
  else if (best >= 0.85) matchedFields.push('NAME_STRONG');
  else if (best > 0) matchedFields.push('NAME_PARTIAL');

  let score = best;

  const reqDob = toDateOnly(req.dob);
  const candDob = toDateOnly(candidate.dob);
  if (reqDob && candDob) {
    if (reqDob === candDob) {
      score += DOB_EXACT_BOOST;
      matchedFields.push('DOB');
    } else {
      const sameYear = reqDob.slice(0, 4) === candDob.slice(0, 4);
      // Same year but a different day is often a transcription artefact in
      // sanctions data, so penalise less than a wholly different year.
      score -= sameYear ? DOB_CONFLICT_PENALTY / 2 : DOB_CONFLICT_PENALTY;
      matchedFields.push('DOB_CONFLICT');
    }
  } else if (reqDob && candidate.yobOnly) {
    // Many list entries carry only a year of birth.
    if (Number(reqDob.slice(0, 4)) === candidate.yobOnly) {
      score += YOB_MATCH_BOOST;
      matchedFields.push('YOB');
    } else {
      score -= DOB_CONFLICT_PENALTY / 2;
      matchedFields.push('YOB_CONFLICT');
    }
  }

  const reqCountries = [normalizeCountry(req.country), normalizeCountry(req.nationality)]
    .filter((c): c is string => Boolean(c));
  const candCountries = candidate.countries
    .map((c) => normalizeCountry(c))
    .filter((c): c is string => Boolean(c));
  if (reqCountries.length && candCountries.length) {
    if (reqCountries.some((c) => candCountries.includes(c))) {
      score += COUNTRY_MATCH_BOOST;
      matchedFields.push('COUNTRY');
    } else {
      // Weak signal only: people move, and list country data is often the
      // country of listing rather than of residence.
      score -= COUNTRY_CONFLICT_PENALTY;
    }
  }

  return {
    score: Math.max(0, Math.min(1, Math.round(score * 1000) / 1000)),
    matchedFields,
    matchedName: bestName,
  };
}

export class LocalScreeningAdapter implements ScreeningAdapter {
  readonly name: string;

  constructor(
    private readonly source: WatchlistSource,
    name = 'local-watchlist',
  ) {
    this.name = name;
  }

  async search(
    req: ScreeningRequest,
    ctx: AdapterContext,
  ): Promise<AdapterResult<ScreeningResult>> {
    const started = Date.now();
    await simulateLatency(`${ctx.applicantId ?? 'x'}:screening`, 30, 180);

    const tokens = normalizeName(req.name).split(' ').filter((t) => t.length > 1);
    if (tokens.length === 0) {
      return {
        ok: false,
        provider: this.name,
        latencyMs: Date.now() - started,
        error: {
          code: 'EMPTY_QUERY',
          message: 'Screening requires a name with at least one usable token',
          retryable: false,
        },
      };
    }

    let candidates: WatchlistCandidate[];
    try {
      candidates = await this.source.load({
        listTypes: req.listTypes,
        entityType: req.entityType,
        nameTokens: tokens,
      });
    } catch (error) {
      return {
        ok: false,
        provider: this.name,
        latencyMs: Date.now() - started,
        error: {
          code: 'CORPUS_UNAVAILABLE',
          message: error instanceof Error ? error.message : 'watchlist load failed',
          // A screening failure must never be silently treated as "no hits", so
          // this is retryable and the check stays incomplete until it succeeds.
          retryable: true,
        },
      };
    }

    const suppressed = new Set(req.suppressedEntryIds ?? []);
    // A missing or nonsensical threshold must not mean "match everything".
    // `score < undefined` is false, so an omitted fuzziness would silently turn
    // every scanned candidate into a hit — against the real consolidated lists
    // that is tens of thousands of false positives, not a degraded result.
    const threshold =
      Number.isFinite(req.fuzziness) && req.fuzziness > 0 && req.fuzziness <= 1
        ? req.fuzziness
        : DEFAULT_FUZZINESS;
    const hits: ScreeningHit[] = [];

    for (const candidate of candidates) {
      if (suppressed.has(candidate.id)) continue;
      const { score, matchedFields, matchedName } = scoreCandidate(req, candidate);
      if (score < threshold) continue;

      hits.push({
        entryId: candidate.id,
        listType: candidate.listType,
        listName: candidate.listName,
        matchedName,
        aliases: candidate.aliases,
        matchScore: score,
        matchedFields,
        dob: candidate.dob ?? null,
        countries: candidate.countries,
        positions: candidate.positions ?? [],
        pepTier: candidate.pepTier ?? null,
        program: candidate.program ?? null,
        remarks: candidate.remarks ?? null,
        categories: candidate.categories ?? [],
        listedAt: candidate.listedAt ?? null,
        snapshot: {
          fullName: candidate.fullName,
          aliases: candidate.aliases,
          dob: candidate.dob,
          countries: candidate.countries,
          listType: candidate.listType,
          listName: candidate.listName,
          // Snapshotting the entry is what lets an analyst's decision stay
          // reviewable after the underlying list changes.
          capturedAt: new Date().toISOString(),
          ...candidate.raw,
        },
      });
    }

    // Strongest matches first: an analyst should see the one that matters at the
    // top, not hunt for it.
    hits.sort((a, b) => b.matchScore - a.matchScore);

    const findings: Finding[] = [];
    const sanctionsHits = hits.filter((h) => h.listType === 'SANCTIONS');
    if (sanctionsHits.length) {
      findings.push({
        code: 'SANCTIONS_HIT',
        severity: 'CRITICAL',
        message: `${sanctionsHits.length} potential sanctions match(es).`,
        detail: { lists: [...new Set(sanctionsHits.map((h) => h.listName))] },
      });
    }
    const pepHits = hits.filter((h) => h.listType === 'PEP');
    if (pepHits.length) {
      findings.push({
        code: 'PEP_HIT',
        severity: 'HIGH',
        message: `${pepHits.length} potential PEP match(es).`,
        detail: {
          minTier: Math.min(...pepHits.map((h) => h.pepTier ?? 99)),
          positions: [...new Set(pepHits.flatMap((h) => h.positions ?? []))].slice(0, 5),
        },
      });
    }
    if (hits.length > 12) {
      // A very common name generates dozens of weak matches. Say so, rather than
      // letting an analyst assume the applicant is unusually notorious.
      findings.push({
        code: 'HIGH_MATCH_VOLUME',
        severity: 'INFO',
        message:
          'Large number of weak matches, typical of a common name. Consider tightening fuzziness for this query.',
        detail: { hitCount: hits.length, threshold },
      });
    }

    return {
      ok: true,
      data: {
        hits,
        searchedEntries: candidates.length,
        listsSearched: [...new Set(candidates.map((c) => c.listName))],
        findings,
      },
      provider: this.name,
      latencyMs: Date.now() - started,
      raw: { threshold, tokens },
    };
  }
}

/** In-memory source, used by tests and by the seeded demo corpus. */
export class InMemoryWatchlistSource implements WatchlistSource {
  constructor(private readonly entries: WatchlistCandidate[]) {}

  async load(req: {
    listTypes: string[];
    entityType: 'INDIVIDUAL' | 'COMPANY';
    nameTokens: string[];
  }): Promise<WatchlistCandidate[]> {
    return this.entries.filter((e) => {
      if (!req.listTypes.includes(e.listType)) return false;
      if (e.entityType !== req.entityType) return false;
      // Cheap token pre-filter mirroring what a SQL implementation would do.
      const haystack = normalizeName([e.fullName, ...e.aliases].join(' '));
      return req.nameTokens.some((t) => haystack.includes(t.slice(0, 4)));
    });
  }
}
