import { normalizeCountry, normalizeName } from './normalize.js';
import { OFFSHORE_SECRECY_JURISDICTIONS } from './countries.js';

/**
 * Ultimate beneficial ownership resolution.
 *
 * The regulatory question is simple to state and awkward to compute: which
 * natural persons ultimately own or control at least X% of this entity? The
 * awkwardness comes from real structures — chains of holding companies, the same
 * person owning via several paths, circular cross-holdings, and gaps where a
 * shareholder is simply unknown.
 *
 * Rules applied here:
 *  - Effective ownership along a path is the product of the percentages.
 *  - A person reachable by several paths has their effective stakes summed.
 *  - Cycles are broken by refusing to revisit a company already on the current
 *    path. Cross-holdings are common and must not hang the resolver.
 *  - Ownership that cannot be attributed to a natural person within the depth
 *    limit is reported as unresolved rather than silently dropped. Understating
 *    unresolved ownership is the failure mode that lets a laundering structure
 *    through, so gaps are surfaced loudly.
 */

export interface PersonNode {
  kind: 'person';
  name: string;
  dob?: string | null;
  country?: string | null;
}

export interface CompanyNode {
  kind: 'company';
  id: string;
  legalName: string;
  country?: string | null;
}

export interface OwnershipEdgeInput {
  /** Company being owned. */
  childId: string;
  /** Set when the owner is another company. */
  parentCompanyId?: string | null;
  /** Set when the owner is a natural person (a leaf). */
  parentPersonName?: string | null;
  parentPersonDob?: string | null;
  parentPersonCountry?: string | null;
  ownershipPercent: number;
  votingPercent?: number | null;
  controlType?: string;
  isNominee?: boolean;
}

export interface UboGraphInput {
  rootCompanyId: string;
  companies: CompanyNode[];
  edges: OwnershipEdgeInput[];
}

export interface ResolvedUbo {
  name: string;
  dob?: string | null;
  country?: string | null;
  /** Summed effective ownership across all paths, 0-100. */
  effectivePercent: number;
  /** Highest single-path voting influence, where declared. */
  effectiveVotingPercent: number;
  /** Every path from the root to this person, for the audit file. */
  paths: Array<{
    companies: string[];
    percent: number;
    viaNominee: boolean;
  }>;
  /** True when any path to this person runs through a nominee holding. */
  viaNominee: boolean;
  isUbo: boolean;
}

export interface UboResolution {
  ubos: ResolvedUbo[];
  /** Persons found but below the reporting threshold. */
  minorityHolders: ResolvedUbo[];
  /** Ownership that terminates at a company with no known shareholders. */
  unresolvedPercent: number;
  unresolvedNodes: Array<{ companyId: string; legalName: string; percent: number }>;
  /** Deepest resolved chain length, in companies traversed. */
  maxDepth: number;
  /** Companies whose edges were skipped because they formed a cycle. */
  cycles: string[][];
  /** Intermediate holding companies incorporated in secrecy jurisdictions. */
  offshoreLayerCount: number;
  hasNomineeShareholders: boolean;
  /** Total declared ownership at the root; ≠100 means the register is incomplete. */
  rootDeclaredPercent: number;
  thresholdPercent: number;
}

function personKey(name: string, dob?: string | null): string {
  return `${normalizeName(name)}|${dob ?? ''}`;
}

export function resolveUbos(
  graph: UboGraphInput,
  options: { thresholdPercent?: number; maxDepth?: number } = {},
): UboResolution {
  const threshold = options.thresholdPercent ?? 25;
  const maxDepth = options.maxDepth ?? 6;

  const companyById = new Map(graph.companies.map((c) => [c.id, c]));
  const edgesByChild = new Map<string, OwnershipEdgeInput[]>();
  for (const edge of graph.edges) {
    const list = edgesByChild.get(edge.childId) ?? [];
    list.push(edge);
    edgesByChild.set(edge.childId, list);
  }

  const people = new Map<string, ResolvedUbo>();
  const unresolved = new Map<string, { companyId: string; legalName: string; percent: number }>();
  const cycles: string[][] = [];
  const offshoreLayers = new Set<string>();
  let maxDepthSeen = 0;
  let hasNominee = false;

  const walk = (
    companyId: string,
    carriedPercent: number,
    carriedVoting: number,
    path: string[],
    viaNominee: boolean,
  ): void => {
    const depth = path.length;
    maxDepthSeen = Math.max(maxDepthSeen, depth);

    const company = companyById.get(companyId);
    if (depth > 1 && company?.country) {
      // Layer 1 is the customer itself; only intermediaries count as layering.
      if (OFFSHORE_SECRECY_JURISDICTIONS.includes(normalizeCountry(company.country) ?? '')) {
        offshoreLayers.add(companyId);
      }
    }

    if (depth >= maxDepth) {
      // Depth exhausted: the remaining ownership is unattributed, not zero.
      recordUnresolved(companyId, carriedPercent);
      return;
    }

    const edges = edgesByChild.get(companyId) ?? [];
    if (edges.length === 0) {
      recordUnresolved(companyId, carriedPercent);
      return;
    }

    const declared = edges.reduce((sum, e) => sum + (e.ownershipPercent || 0), 0);
    // A register that only accounts for part of the equity leaves a real gap.
    if (declared < 99.5) {
      recordUnresolved(companyId, (carriedPercent * (100 - declared)) / 100);
    }

    for (const edge of edges) {
      if (edge.isNominee) hasNominee = true;
      const share = (carriedPercent * (edge.ownershipPercent || 0)) / 100;
      if (share <= 0) continue;
      const votingShare =
        (carriedVoting * (edge.votingPercent ?? edge.ownershipPercent ?? 0)) / 100;
      const nomineePath = viaNominee || Boolean(edge.isNominee);

      if (edge.parentPersonName) {
        const key = personKey(edge.parentPersonName, edge.parentPersonDob);
        const existing = people.get(key);
        const entry: ResolvedUbo = existing ?? {
          name: edge.parentPersonName,
          dob: edge.parentPersonDob ?? null,
          country: normalizeCountry(edge.parentPersonCountry),
          effectivePercent: 0,
          effectiveVotingPercent: 0,
          paths: [],
          viaNominee: false,
          isUbo: false,
        };
        // Multiple paths to the same person aggregate: 15% direct plus 15% via a
        // holding company is a 30% beneficial owner, not two 15% minorities.
        entry.effectivePercent += share;
        entry.effectiveVotingPercent = Math.max(entry.effectiveVotingPercent, votingShare);
        entry.paths.push({
          companies: [...path, companyId],
          percent: share,
          viaNominee: nomineePath,
        });
        entry.viaNominee = entry.viaNominee || nomineePath;
        people.set(key, entry);
        continue;
      }

      const parentId = edge.parentCompanyId;
      if (!parentId) {
        // An edge naming neither a person nor a company is an incomplete record.
        recordUnresolved(companyId, share);
        continue;
      }
      if (path.includes(parentId) || parentId === companyId) {
        // Circular holding. Record it and stop rather than recursing forever.
        cycles.push([...path, companyId, parentId]);
        recordUnresolved(parentId, share);
        continue;
      }
      walk(parentId, share, votingShare, [...path, companyId], nomineePath);
    }
  };

  function recordUnresolved(companyId: string, percent: number) {
    if (percent <= 0.01) return;
    const company = companyById.get(companyId);
    const existing = unresolved.get(companyId);
    unresolved.set(companyId, {
      companyId,
      legalName: company?.legalName ?? companyId,
      percent: (existing?.percent ?? 0) + percent,
    });
  }

  walk(graph.rootCompanyId, 100, 100, [], false);

  const all = [...people.values()]
    .map((p) => ({
      ...p,
      effectivePercent: Math.round(p.effectivePercent * 100) / 100,
      effectiveVotingPercent: Math.round(p.effectiveVotingPercent * 100) / 100,
    }))
    .map((p) => ({
      ...p,
      // Control can arise from voting rights without matching equity, so either
      // route over the threshold makes someone a beneficial owner.
      isUbo: p.effectivePercent >= threshold || p.effectiveVotingPercent >= threshold,
    }))
    .sort((a, b) => b.effectivePercent - a.effectivePercent);

  const rootEdges = edgesByChild.get(graph.rootCompanyId) ?? [];

  return {
    ubos: all.filter((p) => p.isUbo),
    minorityHolders: all.filter((p) => !p.isUbo),
    unresolvedPercent:
      Math.round([...unresolved.values()].reduce((s, u) => s + u.percent, 0) * 100) / 100,
    unresolvedNodes: [...unresolved.values()]
      .map((u) => ({ ...u, percent: Math.round(u.percent * 100) / 100 }))
      .sort((a, b) => b.percent - a.percent),
    maxDepth: maxDepthSeen,
    cycles,
    offshoreLayerCount: offshoreLayers.size,
    hasNomineeShareholders: hasNominee,
    rootDeclaredPercent:
      Math.round(rootEdges.reduce((s, e) => s + (e.ownershipPercent || 0), 0) * 100) / 100,
    thresholdPercent: threshold,
  };
}

/**
 * The "50 percent rule": an entity majority-owned by sanctioned persons is
 * itself treated as sanctioned, even when not separately listed. Aggregating
 * across several listed owners matters — two listed persons at 30% each are
 * jointly a control position.
 */
export function sanctionedOwnershipPercent(
  resolution: UboResolution,
  isSanctioned: (person: { name: string; dob?: string | null }) => boolean,
): number {
  const all = [...resolution.ubos, ...resolution.minorityHolders];
  const total = all
    .filter((p) => isSanctioned({ name: p.name, dob: p.dob }))
    .reduce((sum, p) => sum + p.effectivePercent, 0);
  return Math.round(total * 100) / 100;
}

/** Flattens the resolution into the fact shape the COMPANY rules expect. */
export function uboFacts(resolution: UboResolution): Record<string, unknown> {
  return {
    uboCount: resolution.ubos.length,
    uboUnresolved: resolution.unresolvedPercent >= 1,
    unresolvedOwnershipPercent: resolution.unresolvedPercent,
    uboDepth: resolution.maxDepth,
    offshoreLayerCount: resolution.offshoreLayerCount,
    hasNomineeShareholders: resolution.hasNomineeShareholders,
    hasCircularOwnership: resolution.cycles.length > 0,
    rootDeclaredPercent: resolution.rootDeclaredPercent,
    registerIncomplete: resolution.rootDeclaredPercent < 99.5,
  };
}

/** Renders the ownership chain as indented text for the case file. */
export function describeOwnership(resolution: UboResolution): string[] {
  const lines: string[] = [];
  for (const ubo of resolution.ubos) {
    lines.push(
      `${ubo.name}${ubo.dob ? ` (b. ${ubo.dob})` : ''} — ${ubo.effectivePercent}% effective${ubo.viaNominee ? ' [via nominee]' : ''}`,
    );
    for (const path of ubo.paths) {
      lines.push(`    ${path.companies.join(' → ')}: ${Math.round(path.percent * 100) / 100}%`);
    }
  }
  for (const node of resolution.unresolvedNodes) {
    lines.push(`UNRESOLVED — ${node.percent}% stops at ${node.legalName}`);
  }
  return lines;
}
