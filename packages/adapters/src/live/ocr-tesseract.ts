import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createWorker, PSM, type Worker } from 'tesseract.js';
import {
  computeCheckDigit,
  hasMachineReadableZone,
  isKnownAlpha3,
  parseMrz,
  type MrzParseResult,
} from '@kyc/core';
import type {
  AdapterContext,
  AdapterResult,
  Finding,
  ImageInput,
  OcrAdapter,
  OcrRequest,
  OcrResult,
  StorageAdapter,
} from '../types.js';

/**
 * Real optical character recognition, over Tesseract.
 *
 * This adapter reads actual pixels. Where the mock invents a document that
 * agrees with the applicant, this one is perfectly capable of returning nothing
 * — and does, when handed a blurred photo or a document it cannot find a
 * machine-readable zone on. That is the point of it.
 *
 * **Scope.** It reads the MRZ: the two or three lines of `<<<`-padded capitals
 * at the bottom of a passport or ID card, defined by ICAO 9303. Those lines
 * carry check digits, so a successful read is self-validating — a transcription
 * error almost always fails the checksum rather than passing as different data.
 * That is what makes MRZ worth reading and the printed part of the document not:
 * OCR of free-form printed fields has no such error detection, so a misread date
 * of birth would simply be believed.
 *
 * **What it is not.** Reading a document is not authenticating one. Nothing here
 * says the passport is genuine; a competent forgery carries a perfectly valid
 * MRZ, because computing check digits is arithmetic. This adapter answers "what
 * does this document say, and is it internally consistent" — no more.
 *
 * WASM rather than the native binary, so it installs over npm and runs the same
 * on a laptop, in CI and in the container. Slower, but a real check that runs
 * everywhere beats a faster one that only runs where someone ran apt-get.
 */

class TimeoutError extends Error {}

/** Returned by the reader when the time budget ran out before anything was read. */
const TIMED_OUT = Symbol('ocr-timed-out');

/**
 * How much of the budget the page-locating pass may spend.
 *
 * Exported so the split stays honest: it must leave the majority to the zoomed
 * pass, which is the one that actually transcribes the zone.
 */
export function locateBudgetFor(totalMs: number): number {
  return Math.min(totalMs * 0.4, 20_000);
}

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

/** The MRZ alphabet, and nothing else. Halves the ways a read can go wrong. */
const MRZ_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<';

/** ICAO 9303 line lengths: TD1 is 3×30, TD2 2×36, TD3 (passports) 2×44. */
const MRZ_LINE_LENGTHS = [30, 36, 44];

/**
 * Glyphs Tesseract confuses in OCR-B, in both directions.
 *
 * Which direction to apply is never guessed: ICAO 9303 fixes the type of every
 * position in the zone, so a character read as `1` where the standard requires a
 * letter can only be `I`, and a `Q` where it requires a digit can only be `0`.
 * That is what `coerce` below uses, and it is why this is far more reliable than
 * substituting hopefully and seeing what sticks.
 */
const LETTER_FOR_DIGIT: Record<string, string> = {
  '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '6': 'G', '8': 'B',
};
const DIGIT_FOR_LETTER: Record<string, string> = {
  O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', T: '1', Z: '2', S: '5',
  G: '6', B: '8', A: '4', E: '8',
};

/** Positional field types, per ICAO 9303. `a` alpha, `n` numeric, `x` either. */
type Layout = { line: number; start: number; end: number; kind: 'a' | 'n' }[];

const LAYOUTS: Record<'TD1' | 'TD2' | 'TD3', Layout> = {
  // Line 2 of a passport: doc number, check, nationality, birth date, check,
  // sex, expiry, check, personal number, check, composite check.
  TD3: [
    { line: 1, start: 9, end: 10, kind: 'n' },
    { line: 1, start: 10, end: 13, kind: 'a' },
    { line: 1, start: 13, end: 20, kind: 'n' },
    { line: 1, start: 21, end: 28, kind: 'n' },
    { line: 1, start: 42, end: 44, kind: 'n' },
  ],
  TD2: [
    { line: 1, start: 9, end: 10, kind: 'n' },
    { line: 1, start: 10, end: 13, kind: 'a' },
    { line: 1, start: 13, end: 20, kind: 'n' },
    { line: 1, start: 21, end: 28, kind: 'n' },
    { line: 1, start: 35, end: 36, kind: 'n' },
  ],
  // TD1 splits differently: the dates live on line 2, the names on line 3.
  TD1: [
    { line: 0, start: 15, end: 16, kind: 'n' },
    { line: 1, start: 0, end: 7, kind: 'n' },
    { line: 1, start: 8, end: 15, kind: 'n' },
    { line: 1, start: 15, end: 18, kind: 'a' },
    { line: 1, start: 29, end: 30, kind: 'n' },
  ],
};

export interface TesseractOcrOptions {
  storage?: StorageAdapter;
  /** Where eng.traineddata lives. Defaults to the copy shipped in this package. */
  langPath?: string;
  /** Total budget for reading one image, across both passes. Default 45s. */
  timeoutMs?: number;
  /**
   * Release the recognition engine after this long with no documents to read.
   * Default 5 minutes; 0 keeps it resident.
   */
  idleMs?: number;
  logger?: (msg: string) => void;
}

interface Preprocessed {
  full: Buffer;
  width: number;
  height: number;
  quality: OcrResult['quality'];
}

export class TesseractOcrAdapter implements OcrAdapter {
  readonly name = 'tesseract-ocr';

  private worker: Promise<Worker> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private busy = 0;
  private readonly langPath: string;
  private readonly timeoutMs: number;
  private readonly idleMs: number;

  constructor(private readonly options: TesseractOcrOptions = {}) {
    this.langPath = options.langPath ?? defaultLangPath();
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.idleMs = options.idleMs ?? 300_000;
  }

  /**
   * One worker per process, started on first use.
   *
   * Tesseract's WASM heap is the expensive part — tens of megabytes that stay
   * resident. Creating one per request would make document reading the largest
   * memory consumer in the service; creating none until a document arrives keeps
   * a deployment that never reads one from paying for it.
   */
  private getWorker(): Promise<Worker> {
    this.worker ??= createWorker(
      'eng',
      1,
      {
        langPath: this.langPath,
        gzip: false,
        // Everything local. A verification that silently depends on a CDN being
        // up is a verification that fails in ways nobody can debug.
        cachePath: this.langPath,
        logger: () => {},
      },
      // Set at initialisation because Tesseract loads its dictionaries then and
      // refuses to drop them afterwards. Without this it "corrects" a document
      // number into whatever English word it most resembles.
      { load_system_dawg: '0', load_freq_dawg: '0' },
    ).then(async (worker) => {
      await worker.setParameters({
        tessedit_char_whitelist: MRZ_CHARSET,
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      });
      return worker;
    });
    return this.worker;
  }

  /** Releases the WASM heap. Called when the process is shutting down. */
  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const worker = this.worker;
    this.worker = null;
    if (worker) await (await worker).terminate().catch(() => undefined);
  }

  /**
   * Gives the WASM heap back after a quiet spell.
   *
   * Tesseract holds on the order of a couple of hundred megabytes while loaded,
   * which on a small instance is most of what there is. Verification traffic
   * arrives in bursts with long gaps, so holding it through the gaps means
   * paying for the reader all day to use it for minutes. Starting it again costs
   * a second or so on the next document, which is nothing beside the risk of the
   * whole service being killed for memory.
   */
  private scheduleIdleRelease() {
    if (this.idleMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.busy === 0) void this.close();
    }, this.idleMs);
    // Never hold the process open just to wait for this.
    this.idleTimer.unref?.();
  }

  async extract(req: OcrRequest, ctx: AdapterContext): Promise<AdapterResult<OcrResult>> {
    const started = Date.now();
    const findings: Finding[] = [];

    this.busy++;
    if (this.idleTimer) clearTimeout(this.idleTimer);

    try {
      const image = pickImage(req.images);
      if (!image) {
        return this.failed(started, 'NO_IMAGE', 'No image was supplied to read.', false);
      }

      const bytes = await this.loadBytes(image);
      const prepared = await preprocess(bytes);

      // A utility bill has no machine-readable zone, and neither does a driving
      // licence. Running the reader at them and reporting "unreadable" would
      // reject every legitimate proof of address — and take forty-five seconds
      // of a shared CPU to do it. Say plainly that there is nothing here this
      // reader can verify, and leave it to a person.
      if (!hasMachineReadableZone(req.documentType)) {
        findings.push({
          code: 'NO_MACHINE_READABLE_ZONE',
          severity: 'INFO',
          message:
            `A ${req.documentType.toLowerCase().replace(/_/g, ' ')} carries no machine-readable ` +
            'zone, so this reader cannot verify it. It needs a human, or a provider that reads ' +
            'printed fields.',
        });
        return {
          ok: true,
          provider: this.name,
          latencyMs: Date.now() - started,
          data: emptyResult(req.documentType, prepared.quality, findings),
          raw: { engine: 'tesseract', skipped: 'no-mrz-document-type' },
        };
      }

      // A photo too blurred or too dark to read is a retake, not a rejection.
      // Saying so before spending time on OCR gets the applicant a faster answer.
      if (prepared.quality.sharpness < 0.08) {
        findings.push({
          code: 'IMAGE_TOO_BLURRED',
          severity: 'MEDIUM',
          message: 'The photo is too blurred to read reliably. Ask for a retake.',
          detail: { sharpness: prepared.quality.sharpness },
        });
      }
      // A data page is mostly pale card, so the upper bound has to sit high or
      // every correctly exposed passport is reported as overexposed. Genuinely
      // blown-out photographs are caught by glare, which measures saturation
      // rather than average level.
      if (prepared.quality.brightness < 0.18 || prepared.quality.brightness > 0.97) {
        findings.push({
          code: 'IMAGE_POORLY_LIT',
          severity: 'MEDIUM',
          message: 'The photo is too dark or too bright to read reliably.',
          detail: { brightness: prepared.quality.brightness },
        });
      }

      const read = await this.readMrz(prepared, started);
      const latencyMs = Date.now() - started;

      if (read === TIMED_OUT) {
        // Out of time is an answer, not a fault.
        //
        // Returning an error here made the check FAILED, which is the pipeline's
        // "our problem, retry it" state — so the queue re-ran the whole job,
        // spent the budget again on the same unreadable image, and failed again.
        // An applicant who uploaded a photograph of their lunch waited minutes
        // for that. Whereas "we could not read this in the time available" is
        // true, terminal, and lands them in front of a reviewer at once.
        findings.push({
          code: 'OCR_TIMED_OUT',
          severity: 'MEDIUM',
          message:
            'Reading this image took longer than allowed, so it was not read. This ' +
            'usually means the photo does not contain a document the reader recognises.',
          detail: { budgetMs: this.timeoutMs },
        });
        return {
          ok: true,
          provider: this.name,
          latencyMs,
          data: emptyResult(req.documentType, prepared.quality, findings),
          raw: { engine: 'tesseract', timedOut: true },
        };
      }

      if (!read) {
        findings.push({
          code: 'MRZ_NOT_FOUND',
          severity: 'HIGH',
          message:
            'No machine-readable zone could be read from this document. It may be the ' +
            'wrong side, an unsupported document, or too poor a photo.',
        });
        return {
          ok: true,
          provider: this.name,
          latencyMs,
          data: emptyResult(req.documentType, prepared.quality, findings),
          raw: { engine: 'tesseract', mrzFound: false },
        };
      }

      const { parsed, mrz, repaired, confidence } = read;
      if (!parsed.ok || !parsed.fields) {
        // Something MRZ-shaped was there and could not be decoded. That is a
        // different answer from "no MRZ", and a reviewer wants to see the text.
        findings.push({
          code: 'MRZ_UNPARSEABLE',
          severity: 'HIGH',
          message:
            'A machine-readable zone was found but could not be decoded. The photo is ' +
            'probably too poor to read; ask for a retake.',
          detail: { errors: parsed.errors, read: mrz },
        });
        return {
          ok: true,
          provider: this.name,
          latencyMs,
          data: { ...emptyResult(req.documentType, prepared.quality, findings), mrz },
          raw: { engine: 'tesseract', mrzFound: true, parsed: false },
        };
      }
      const fields = parsed.fields;

      if (repaired) {
        findings.push({
          code: 'MRZ_REPAIRED',
          severity: 'LOW',
          message:
            'The machine-readable zone only validated after correcting characters ' +
            'Tesseract commonly confuses. Treat the extracted data as probable, not certain.',
          detail: { corrections: repaired },
        });
      }
      if (!parsed.valid) {
        // Absent and wrong are different problems, and a poor photo of an
        // altered document is both at once. A check digit the photo never
        // captured means take a better photo; one that is present and does not
        // add up means the document says something inconsistent with itself.
        // Reporting only the first would let a doctored zone hide behind a
        // blurred corner, so both are reported when both are true.
        const absent = missingDigits(mrz, parsed.format);
        const wrong = failedDigits(parsed.checkDigits).filter((d) => !absent.includes(d));

        if (absent.length > 0) {
          findings.push({
            code: 'MRZ_INCOMPLETE',
            severity: 'MEDIUM',
            message:
              'Part of the machine-readable zone was cut off or unreadable, so it ' +
              'could not be fully verified. Ask for a clearer photo of the whole page.',
            detail: { missing: absent, checkDigits: parsed.checkDigits },
          });
        }
        if (wrong.length > 0) {
          findings.push({
            code: 'MRZ_CHECK_DIGIT_FAILED',
            severity: 'HIGH',
            message:
              'The machine-readable zone was read but its check digits do not ' +
              'validate. Either the read is wrong or the document is not ' +
              'internally consistent.',
            detail: { failed: wrong, checkDigits: parsed.checkDigits, errors: parsed.errors },
          });
        }
      }

      // Confidence comes from the check digits, not from Tesseract's own score.
      //
      // Tesseract reports how sure it is about the glyphs, which on a page of
      // mixed print forced through an MRZ whitelist is pessimistic to the point
      // of useless. The checksums are the better evidence: a zone whose five
      // independent check digits all validate has almost certainly been read
      // correctly, whatever the engine thought of its own eyesight. Its score is
      // kept as a modest floor-raiser rather than the basis.
      const engine = clamp01(confidence);
      const fieldConfidence = parsed.valid
        // A repaired read is a hypothesis that happened to check out, so it is
        // never allowed to look as certain as a clean one.
        ? (repaired ? 0.75 : 0.95) * (0.9 + 0.1 * engine)
        : Math.min(0.35, engine);

      const data: OcrResult = {
        documentType: req.documentType,
        detectedCountry: fields.issuingState || null,
        fields: {
          firstName: firstOf(fields.givenNames),
          lastName: fields.surname || undefined,
          fullName: [fields.givenNames, fields.surname].filter(Boolean).join(' ') || undefined,
          documentNumber: fields.documentNumber || undefined,
          dob: fields.dateOfBirth ?? undefined,
          sex: fields.sex,
          nationality: fields.nationality || undefined,
          expiryDate: fields.dateOfExpiry ?? undefined,
          personalNumber: fields.personalNumber || undefined,
        },
        mrz,
        fieldConfidence: {
          documentNumber: fieldConfidence,
          dob: fieldConfidence,
          expiryDate: fieldConfidence,
          lastName: fieldConfidence,
          firstName: fieldConfidence,
          nationality: fieldConfidence,
        },
        quality: prepared.quality,
        findings,
      };

      return {
        ok: true,
        provider: this.name,
        latencyMs,
        providerRef: fields.documentNumber || undefined,
        data,
        raw: { engine: 'tesseract', mrz, repaired, valid: parsed.valid },
      };
    } catch (error) {
      this.options.logger?.(`[ocr] ${String(error)}`);
      // Unreadable for a reason we did not anticipate is a reason to look at it,
      // never a reason to guess. Retryable: a transient decode or worker fault
      // should not reject an applicant.
      return this.failed(
        started,
        'OCR_FAILED',
        error instanceof Error ? error.message : String(error),
        true,
      );
    } finally {
      this.busy--;
      this.scheduleIdleRelease();
    }
  }

  /**
   * Bounds one recognition pass.
   *
   * A photograph of gravel keeps Tesseract's layout analysis busy far longer
   * than a document does, and there is exactly one engine for the process — so
   * one pathological upload would otherwise stall every verification behind it.
   */
  private withTimeout<T>(work: Promise<T>, label: string, budgetMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new TimeoutError(`${label} exceeded ${Math.max(0, budgetMs)}ms`)),
        Math.max(0, budgetMs),
      );
      work.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  private failed(
    started: number,
    code: string,
    message: string,
    retryable: boolean,
  ): AdapterResult<OcrResult> {
    return {
      ok: false,
      provider: this.name,
      latencyMs: Date.now() - started,
      error: { code, message, retryable },
    };
  }

  private async loadBytes(image: ImageInput): Promise<Buffer> {
    if (image.bytes) return image.bytes;
    if (!image.storageKey) throw new Error('Image has neither bytes nor a storage key');
    if (!this.options.storage) throw new Error('No storage adapter configured for OCR');
    const stored = await this.options.storage.get(image.storageKey);
    return stored.bytes;
  }

  /**
   * Two passes.
   *
   * The first reads the whole image, which is enough to locate the MRZ but often
   * not to transcribe it: at typical phone-photo resolution the characters are
   * only a dozen pixels tall. The second crops to the band the first pass found,
   * scales it up and reads again. Whichever parses and validates wins; if
   * neither validates, the one that at least parses is returned with the failure
   * recorded, because a reviewer can read a wrong MRZ and see what happened.
   */
  private async readMrz(prepared: Preprocessed, started: number) {
    const worker = await this.getWorker();
    const left = () => this.timeoutMs - (Date.now() - started);

    // A pass that finished and found nothing is a different answer from a pass
    // that never finished. Both produce no zone; only the second means "we ran
    // out of time", and reporting a photograph of a wall as a timeout would
    // send the applicant to retake a picture rather than tell them the truth.
    let anyPassCompleted = false;

    /** Reads one image. Returns null on timeout, which is not the same as nothing found. */
    const attemptOn = async (image: Buffer, label: string, budget: number) => {
      try {
        const out = await this.withTimeout(worker.recognize(image), label, budget);
        anyPassCompleted = true;
        return interpret(out.data.text, (out.data.confidence ?? 0) / 100);
      } catch (error) {
        if (error instanceof TimeoutError) return null;
        throw error;
      }
    };

    // Look at the foot of the page first.
    //
    // Recognition cost scales with pixel count, and the machine-readable zone
    // occupies the bottom fifth of every ICAO document. Reading the whole page
    // to find it, then reading the strip again to transcribe it, is two passes
    // over four times the pixels — which a laptop absorbs and a shared-CPU
    // instance does not: the full-page approach exhausted a 45-second budget
    // there on a document that reads in well under a second locally.
    //
    // So: crop, enlarge, read. If that produces a zone whose check digits
    // validate, nothing else is needed, and the expensive path never runs.
    const footTop = Math.floor(prepared.height * 0.58);
    const foot = await sharp(prepared.full)
      .extract({ left: 0, top: footTop, width: prepared.width, height: prepared.height - footTop })
      .resize({ width: Math.min(2400, Math.round(prepared.width * 1.5)) })
      .sharpen()
      .toBuffer();

    const quick = await attemptOn(foot, 'foot-of-page recognition', Math.min(left(), 25_000));
    if (quick?.parsed.valid) return quick;

    // Otherwise fall back to reading the page and locating the zone properly —
    // the document may be photographed at an angle, or set within a larger
    // frame, so that the zone is not where it usually is.
    if (left() < 5_000) return quick ?? (anyPassCompleted ? null : TIMED_OUT);

    let wide = null;
    try {
      wide = await this.withTimeout(
        worker.recognize(prepared.full, {}, { text: true, blocks: true }),
        'full-page recognition',
        locateBudgetFor(left()),
      );
      anyPassCompleted = true;
    } catch (error) {
      if (!(error instanceof TimeoutError)) throw error;
    }

    const first = wide ? interpret(wide.data.text, (wide.data.confidence ?? 0) / 100) : null;
    const band = mrzBand(wide?.data.blocks, prepared.height);

    let second: ReturnType<typeof interpret> = null;
    if (band && left() > 3_000) {
      const top = Math.max(0, band.top);
      const height = Math.min(prepared.height - top, band.height);
      if (height > 8) {
        const cropped = await sharp(prepared.full)
          .extract({ left: 0, top, width: prepared.width, height })
          .resize({ width: Math.min(3000, prepared.width * 2) })
          .sharpen()
          .toBuffer();
        second = await attemptOn(cropped, 'zoomed recognition', left());
      }
    }

    const candidates = [second, first, quick].filter(Boolean) as NonNullable<
      ReturnType<typeof interpret>
    >[];
    if (candidates.length === 0) return anyPassCompleted ? null : TIMED_OUT;
    return candidates.find((c) => c.parsed.valid) ?? candidates[0]!;
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Turns raw OCR text into a parsed MRZ.
 *
 * Three unknowns get resolved: which format the zone is, which characters were
 * misread, and whether the read lost a character. Two different kinds of
 * evidence settle them.
 *
 * The first line of a passport carries no check digits at all — a misread name
 * is undetectable by arithmetic — but its issuing state has to be a code some
 * authority actually issues under, and that is evidence enough to fix a stray
 * character there on its own. The second line is covered end to end by check
 * digits, so hypotheses about it can simply be tested: try, and keep only what
 * validates.
 *
 * Keeping the two separate matters. Gating the first line's repair on the second
 * line validating means a passport with one unreadable corner comes back with a
 * mangled surname — which is exactly the bug this replaced.
 */
function interpret(text: string, confidence: number) {
  const raw = mrzLines(text);
  if (raw.length < 2) return null;

  const longest = Math.max(...raw.map((l) => l.length));
  const widths = MRZ_LINE_LENGTHS.filter((w) => w >= longest - 2);
  if (widths.length === 0) widths.push(MRZ_LINE_LENGTHS.at(-1)!);

  // When nothing validates, keep the best read rather than the first one tried.
  // The first is whichever width happened to come up first, which for a
  // truncated line is the narrowest and least likely to be right; the best is
  // the one that decoded and got the most check digits to agree. A reviewer
  // handed the narrow read sees "unparseable" for a document that was in fact
  // three-quarters readable.
  let fallback: ReturnType<typeof attempt> | null = null;
  let fallbackScore = -1;

  for (const width of widths) {
    const { lines: baseline, fixed } = repairHeader(atWidth(raw, width));
    const attempts = [baseline, ...repairs(baseline)];

    for (let i = 0; i < attempts.length; i++) {
      const result = attempt(attempts[i]!, confidence, i > 0 || fixed);
      if (result.parsed.ok && result.parsed.valid) return result;

      const score = scoreRead(result.parsed);
      if (score > fallbackScore) {
        fallback = result;
        fallbackScore = score;
      }
    }
  }
  return fallback;
}

/** How much of a read held together: decoded at all, then digits that agreed. */
function scoreRead(parsed: MrzParseResult): number {
  if (!parsed.ok) return 0;
  const digits = parsed.checkDigits;
  const agreed = digits
    ? [digits.documentNumber, digits.dateOfBirth, digits.dateOfExpiry, digits.composite].filter(
        (d) => d === true,
      ).length
    : 0;
  return 10 + agreed;
}

function attempt(lines: string[], confidence: number, repaired: boolean) {
  const mrz = lines.join('\n');
  const parsed = parseMrz(mrz);
  return { parsed, mrz, repaired: repaired ? lines : null, confidence };
}

/**
 * Removes a character OCR invented in the header of line 1.
 *
 * Positions 2-4 are the issuing state. If it is not a code anyone issues
 * documents under, and deleting a single character from the first few positions
 * makes it one, that character was not on the document — and everything after
 * it, the holder's surname included, was shifted along by its presence.
 */
function repairHeader(lines: string[]): { lines: string[]; fixed: boolean } {
  const first = lines[0];
  if (!first || isKnownAlpha3(first.slice(2, 5))) return { lines, fixed: false };

  for (let i = 0; i < 8; i++) {
    const candidate = first.slice(0, i) + first.slice(i + 1);
    if (isKnownAlpha3(candidate.slice(2, 5))) {
      return { lines: [candidate.padEnd(first.length, '<'), ...lines.slice(1)], fixed: true };
    }
  }
  return { lines, fixed: false };
}

/**
 * Candidate corrections for the checksum-protected line, least invasive first.
 *
 * Each is a hypothesis about how the read went wrong, and each is only accepted
 * if the corrected zone validates against its check digits. Those digits are a
 * weighted mod-10 over the field, so a wrong hypothesis has about a one-in-ten
 * chance of validating per digit and TD3 has four mandatory ones that have to
 * agree at once. Not proof — which is why a repaired read is recorded as
 * repaired and its confidence discounted — but a real bar, and much stronger
 * than believing whatever the OCR produced.
 */
function repairs(lines: string[]): string[][] {
  const out: string[][] = [];
  const format = guessFormat(lines);

  // 1. Coerce each position to the character class the standard requires there.
  if (format) out.push(coerce(lines, LAYOUTS[format]));

  // 2. A character dropped from the middle of line 2 shifts everything after it
  //    one place left, so the fields before the gap read correctly and every
  //    field after it is quietly wrong — the most dangerous shape of misread,
  //    because it looks like data rather than damage. Insert filler at each
  //    position in turn and keep only an insertion that makes the line validate.
  const second = lines[1];
  if (second) {
    for (let i = 9; i < second.length; i++) {
      const candidate = `${second.slice(0, i)}<${second.slice(i)}`.slice(0, second.length);
      const shifted = [lines[0]!, candidate, ...lines.slice(2)];
      out.push(shifted);
      if (format) out.push(coerce(shifted, LAYOUTS[format]));
    }
  }

  // 3. A single check digit the photo never captured can be put back, because
  //    it is computable from the field it protects. On its own that would be
  //    circular — deriving the answer from the data and then checking the data
  //    against it proves nothing. What makes it sound is the composite digit,
  //    which covers all of those fields at once and is not itself reconstructed:
  //    the restored zone is only accepted if the composite validates, and it
  //    only will if the underlying data was read correctly.
  if (format) {
    for (const variant of [...out, lines]) {
      const restored = restoreAbsentDigits(variant, format);
      if (restored) {
        out.push(restored);
        out.push(coerce(restored, LAYOUTS[format]));
      }
    }
  }

  return out;
}

/**
 * Field ranges each mandatory check digit protects, per ICAO 9303.
 * `[line, dataStart, dataEnd, digitLine, digitIndex]`.
 */
const PROTECTED_FIELDS: Record<'TD1' | 'TD2' | 'TD3', Array<[number, number, number, number, number]>> = {
  TD3: [
    [1, 0, 9, 1, 9],
    [1, 13, 19, 1, 19],
    [1, 21, 27, 1, 27],
  ],
  TD2: [
    [1, 0, 9, 1, 9],
    [1, 13, 19, 1, 19],
    [1, 21, 27, 1, 27],
  ],
  TD1: [
    [0, 5, 14, 0, 14],
    [1, 0, 6, 1, 6],
    [1, 8, 14, 1, 14],
  ],
};

/** The composite digit's own position — never reconstructed, only checked. */
const COMPOSITE_POSITION: Record<'TD1' | 'TD2' | 'TD3', [number, number]> = {
  TD3: [1, 43],
  TD2: [1, 35],
  TD1: [1, 29],
};

function restoreAbsentDigits(lines: string[], format: 'TD1' | 'TD2' | 'TD3'): string[] | null {
  const [compLine, compIndex] = COMPOSITE_POSITION[format];
  // Without a composite there is nothing to test the reconstruction against, so
  // reconstructing would be pure assertion. Leave it unread.
  if ((lines[compLine]?.[compIndex] ?? '<') === '<') return null;

  const out = lines.map((l) => l.split(''));
  let changed = 0;

  for (const [dataLine, from, to, digitLine, digitIndex] of PROTECTED_FIELDS[format]) {
    const target = out[digitLine];
    const source = lines[dataLine];
    if (!target || !source || target[digitIndex] !== '<') continue;
    target[digitIndex] = String(computeCheckDigit(source.slice(from, to)));
    changed++;
  }

  // More than one missing digit is a photo too poor to trust to arithmetic.
  return changed > 0 && changed <= 1 ? out.map((l) => l.join('')) : null;
}

/** Forces the character class ICAO fixes for each position. */
function coerce(lines: string[], layout: Layout): string[] {
  const out = lines.map((l) => l.split(''));
  for (const field of layout) {
    const line = out[field.line];
    if (!line) continue;
    for (let i = field.start; i < field.end && i < line.length; i++) {
      const char = line[i]!;
      if (char === '<') continue;
      if (field.kind === 'n' && /[A-Z]/.test(char)) line[i] = DIGIT_FOR_LETTER[char] ?? char;
      if (field.kind === 'a' && /[0-9]/.test(char)) line[i] = LETTER_FOR_DIGIT[char] ?? char;
    }
  }
  return out.map((l) => l.join(''));
}

/**
 * Which mandatory check digits the read did not capture at all.
 *
 * Positions come straight from ICAO 9303. Filler in one of them is not a
 * mismatch, it is an absence — nothing was there to check.
 */
const MANDATORY_DIGITS: Record<'TD1' | 'TD2' | 'TD3', Array<[number, number, string]>> = {
  TD3: [
    [1, 9, 'documentNumber'],
    [1, 19, 'dateOfBirth'],
    [1, 27, 'dateOfExpiry'],
    [1, 43, 'composite'],
  ],
  TD2: [
    [1, 9, 'documentNumber'],
    [1, 19, 'dateOfBirth'],
    [1, 27, 'dateOfExpiry'],
    [1, 35, 'composite'],
  ],
  TD1: [
    [0, 14, 'documentNumber'],
    [1, 6, 'dateOfBirth'],
    [1, 14, 'dateOfExpiry'],
    [1, 29, 'composite'],
  ],
};

/** Mandatory check digits that were present and did not add up. */
function failedDigits(digits: MrzParseResult['checkDigits']): string[] {
  if (!digits) return [];
  return (['documentNumber', 'dateOfBirth', 'dateOfExpiry', 'composite'] as const).filter(
    (name) => digits[name] === false,
  );
}

function missingDigits(mrz: string, format: 'TD1' | 'TD2' | 'TD3' | undefined): string[] {
  if (!format) return [];
  const lines = mrz.split('\n');
  return MANDATORY_DIGITS[format]
    .filter(([line, index]) => (lines[line]?.[index] ?? '<') === '<')
    .map(([, , name]) => name);
}

function guessFormat(lines: string[]): 'TD1' | 'TD2' | 'TD3' | null {
  const width = lines[0]?.length ?? 0;
  if (lines.length === 3 && width === 30) return 'TD1';
  if (lines.length === 2 && width === 36) return 'TD2';
  if (lines.length === 2 && width === 44) return 'TD3';
  return null;
}

/**
 * The MRZ-shaped lines in a page of OCR output, stripped but not yet sized.
 *
 * Choosing the width is left to the caller, because it cannot be decided here:
 * a line that OCR truncated to 36 characters is indistinguishable from a genuine
 * 36-character TD2 line by looking at it. The check digits can tell them apart,
 * so every plausible width is tried and the arithmetic decides.
 */
function mrzLines(text: string): string[] {
  const candidates = text
    .split('\n')
    .map((line) => line.replace(/[^A-Z0-9<]/gi, '').toUpperCase())
    .filter((line) => {
      if (line.length < 28) return false;
      // Real MRZ lines are dense with filler. Body text that survives the strip
      // above almost never is.
      const filler = (line.match(/</g) ?? []).length;
      return filler >= 2 || /^[A-Z0-9<]{28,}$/.test(line);
    })
    .slice(-3);

  return looksLikeMrz(candidates) ? candidates : [];
}

/**
 * Whether these lines are plausibly a machine-readable zone at all.
 *
 * Necessary because the reader is running with the MRZ alphabet as its only
 * permitted output. Point it at gravel and it will return capitals, digits and
 * chevrons, some of which will be long enough and filler-heavy enough to look
 * like a zone — and the pipeline then reports a document whose check digits
 * failed. "This photograph of a dog is an invalid passport" is a worse answer
 * than "there is no document here": one asks for a better photo, the other
 * carries a whiff of fraud into a case file.
 *
 * So require structure that noise does not produce: lines of matching length,
 * and either a recognisable header or a line with a date-shaped run of digits.
 */
function looksLikeMrz(lines: string[]): boolean {
  if (lines.length < 2) return false;

  // Deliberately not requiring the lines to be the same length. A run of
  // identical `<` glyphs at the end of a line is the first thing OCR gives up
  // on, so a genuine passport very often arrives as one full line and one short
  // one — and rejecting that pair threw away readable documents. Padding puts
  // the filler back; structure is what tells a document from gravel.
  const header = lines[0]!;
  // `P<UTO`, `IDDEU`, `ACGBR` — a document code followed by an issuing state.
  const headerLooksRight =
    /^[PIACV]/.test(header) && isKnownAlpha3(header.slice(2, 5).replace(/[^A-Z]/g, ''));

  // The data line carries a birth date, an expiry date and their check digits:
  // fourteen digits inside the first twenty-eight characters, near enough.
  const digits = (lines[1]!.slice(0, 28).match(/[0-9]/g) ?? []).length;

  return headerLooksRight || digits >= 12;
}

/** The same lines at one candidate width, padded with filler or trimmed. */
function atWidth(lines: string[], width: number): string[] {
  return lines.map((line) =>
    line.length > width ? line.slice(0, width) : line.padEnd(width, '<'),
  );
}

/**
 * The bounding box of the machine-readable lines, from Tesseract's own layout.
 *
 * Falls back to the bottom third of the page when the layout analysis found no
 * MRZ-shaped line — every ICAO document carries the zone at the foot, so that is
 * the right place to look harder.
 */
function mrzBand(
  blocks: unknown,
  imageHeight: number,
): { top: number; height: number } | null {
  // No layout at all — the page pass ran out of time. Look where the zone
  // always is.
  if (blocks === undefined) {
    return { top: Math.floor(imageHeight * 0.62), height: Math.ceil(imageHeight * 0.38) };
  }
  const lines = collectLines(blocks).filter((line) => {
    const stripped = line.text.replace(/[^A-Z0-9<]/gi, '');
    return stripped.length >= 24 && (stripped.match(/</g) ?? []).length >= 2;
  });

  if (lines.length === 0) {
    return { top: Math.floor(imageHeight * 0.62), height: Math.ceil(imageHeight * 0.38) };
  }

  const top = Math.min(...lines.map((l) => l.bbox.y0));
  const bottom = Math.max(...lines.map((l) => l.bbox.y1));
  // A little margin: character descenders and the odd row of filler sit outside
  // the box Tesseract reports.
  const margin = Math.max(6, Math.round((bottom - top) * 0.15));
  return { top: top - margin, height: bottom - top + margin * 2 };
}

interface LayoutLine {
  text: string;
  bbox: { y0: number; y1: number };
}

/** Flattens Tesseract's block → paragraph → line tree. */
function collectLines(blocks: unknown): LayoutLine[] {
  if (!Array.isArray(blocks)) return [];
  const out: LayoutLine[] = [];
  for (const block of blocks) {
    for (const paragraph of block?.paragraphs ?? []) {
      for (const line of paragraph?.lines ?? []) {
        if (typeof line?.text === 'string' && line?.bbox) out.push(line as LayoutLine);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Image handling
// ---------------------------------------------------------------------------

/** Prefers a page or front side; the MRZ is never on the back of a passport. */
function pickImage(images: ImageInput[]): ImageInput | null {
  return (
    images.find((i) => i.side === 'PAGE') ??
    images.find((i) => i.side === 'FRONT_SIDE') ??
    images[0] ??
    null
  );
}

/**
 * Normalises the photo and measures it.
 *
 * Greyscale and a mild contrast stretch, because colour carries no information
 * for character recognition and an under-exposed phone photo does. The measures
 * are returned whether or not the read succeeds — "we could not read it and here
 * is how bad the photo was" is a more useful answer to an applicant than "we
 * could not read it".
 */
async function preprocess(bytes: Buffer): Promise<Preprocessed> {
  const image = sharp(bytes, { failOn: 'none' }).rotate();
  const metadata = await image.metadata();

  // Measured before the contrast stretch below. Normalising is what makes a dim
  // photo readable, and measuring after it would report every photo as well lit —
  // which is exactly the advice an applicant does not need.
  const grey = await image.clone().greyscale().toBuffer();
  const normalised = await sharp(grey).normalise().toBuffer();
  const resized = await sharp(normalised)
    // 1600px wide, up or down.
    //
    // Tesseract's working set scales with image area, and on a small instance
    // that is the binding constraint rather than accuracy: measured across
    // 1000-2400px the machine-readable zone came out equally well everywhere,
    // while memory rose by about 100MB and time doubled. A phone photograph
    // downscaled to 1600 still leaves the characters some 27 pixels tall, which
    // is comfortably more than the reader needs.
    .resize({ width: 1600, withoutEnlargement: false })
    .toBuffer();
  const info = await sharp(resized).metadata();

  // One channel, explicitly. `grey` is an encoded image, and decoding it back to
  // raw can yield three channels plus alpha depending on how it was written —
  // at which point indexing it as a greyscale plane reads the alpha channel as
  // brightness and reports every photo as blown out. That is what it did.
  //
  // Measured at up to 1200px rather than thumbnail size. Sharpness is the
  // variance of a Laplacian, which is a measure of high-frequency detail —
  // downsampling averages that detail away, so measuring focus on a thumbnail
  // reports every photograph ever taken as blurred. It did that too.
  const { data, info: rawInfo } = await sharp(grey)
    .resize({ width: Math.min(1200, metadata.width ?? 1200), withoutEnlargement: true })
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    full: resized,
    width: info.width ?? 0,
    height: info.height ?? 0,
    quality: {
      ...measure(data, rawInfo.width, rawInfo.height, rawInfo.channels),
      resolution: { width: metadata.width ?? 0, height: metadata.height ?? 0 },
      isColour: (metadata.channels ?? 3) >= 3,
      // Genuine full-document detection needs edge finding this adapter does not
      // do. Reported as true rather than guessed at, and the MRZ_NOT_FOUND
      // finding is what actually catches a half-photographed document.
      fullDocumentVisible: true,
    },
  };
}

/**
 * Sharpness, brightness and glare from the greyscale pixels.
 *
 * Sharpness is the variance of a Laplacian — the standard cheap focus measure. A
 * blurred image has little high-frequency content, so neighbouring pixels differ
 * little and the variance collapses. Normalised to roughly 0–1 for a photo.
 */
function measure(data: Buffer, width: number, height: number, channels = 1) {
  let sum = 0;
  let bright = 0;
  let lapSum = 0;
  let lapSqSum = 0;
  let n = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * channels;
      const v = data[i]!;
      sum += v;
      if (v > 250) bright++;
      const lap =
        4 * v -
        data[i - channels]! -
        data[i + channels]! -
        data[i - width * channels]! -
        data[i + width * channels]!;
      lapSum += lap;
      lapSqSum += lap * lap;
      n++;
    }
  }

  const pixels = width * height;
  const mean = lapSum / Math.max(1, n);
  const variance = lapSqSum / Math.max(1, n) - mean * mean;

  return {
    sharpness: clamp01(variance / 2000),
    brightness: clamp01(sum / Math.max(1, n) / 255),
    // Blown-out highlights, which is what flash on a laminated document gives.
    glare: clamp01(bright / Math.max(1, pixels) / 0.15),
    // Moiré detection is the honest way to catch a photo of a screen and it is
    // not implemented. Reported false rather than guessed, so nothing downstream
    // treats a missing signal as a clean one.
    screenCaptureSuspected: false,
  };
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function firstOf(givenNames: string): string | undefined {
  return givenNames.trim().split(/\s+/)[0] || undefined;
}

function emptyResult(
  documentType: string,
  quality: OcrResult['quality'],
  findings: Finding[],
): OcrResult {
  return {
    documentType,
    detectedCountry: null,
    fields: {},
    fieldConfidence: {},
    quality,
    findings,
  };
}

/** The traineddata shipped alongside this package, resolved from either build layout. */
function defaultLangPath(): string {
  for (const candidate of [
    join(HERE, '..', '..', 'tessdata'),
    join(HERE, '..', '..', '..', 'tessdata'),
  ]) {
    try {
      require('node:fs').accessSync(join(candidate, 'eng.traineddata'));
      return candidate;
    } catch {
      // Try the next layout.
    }
  }
  throw new Error(
    'eng.traineddata not found. Expected it in packages/adapters/tessdata/ — ' +
      'it ships with the repository and is not downloaded at runtime.',
  );
}
