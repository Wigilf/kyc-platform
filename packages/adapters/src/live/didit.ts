import { createHash } from 'node:crypto';
import type {
  AdapterContext,
  AdapterResult,
  DocAuthAdapter,
  DocAuthRequest,
  DocAuthResult,
  FaceMatchAdapter,
  FaceMatchRequest,
  FaceMatchResult,
  Finding,
  ImageInput,
  LivenessAdapter,
  LivenessRequest,
  LivenessResult,
  OcrAdapter,
  OcrRequest,
  OcrResult,
  StorageAdapter,
} from '../types.js';

/**
 * Didit — document verification, liveness and face matching, for real.
 *
 * The three checks this platform could not perform itself. Reading a document
 * it can do; deciding whether the document is a forgery needs a licensed
 * library of what every issue of every document should look like, and deciding
 * whether a living person is holding it needs a model somebody has certified.
 * Those are products, not code, and this is the boundary they attach to.
 *
 * **Every call costs money.** Not a lot — the published free allowance is 500
 * verifications a month and $0.33 after — but a pipeline that calls an endpoint
 * twice for one document spends twice. The document response carries both what
 * the document says *and* whether it is authentic, so the two adapters that
 * need it share one call through a short-lived cache keyed on the image
 * itself.
 *
 * **A provider that errors is our problem, not the applicant's.** Anything that
 * is not a clear verdict comes back `ok: false` and retryable, which the
 * pipeline records as a FAILED check rather than a failed applicant. The one
 * thing that must never happen is a network timeout reading as "this person is
 * not who they say they are".
 */

const DEFAULT_BASE = 'https://verification.didit.me/v3';

export interface DiditOptions {
  apiKey: string;
  /**
   * Where their API lives. Overridable so the adapters can be exercised
   * against a stand-in that answers exactly as the documented contract says —
   * the alternative is testing a mock of our own code, which proves only that
   * the mock agrees with itself.
   */
  baseUrl?: string;
  storage?: StorageAdapter;
  /** Below this, the provider declines a face match. Their default is 30. */
  faceMatchThreshold?: number;
  /** Below this, the provider declines liveness. */
  livenessThreshold?: number;
  timeoutMs?: number;
  logger?: (msg: string) => void;
}

type DiditStatus = 'Approved' | 'Declined' | 'In Review';

interface DocumentResponse {
  request_id: string;
  id_verification: {
    status: DiditStatus;
    document_type?: string;
    document_number?: string;
    personal_number?: string;
    first_name?: string;
    last_name?: string;
    full_name?: string;
    date_of_birth?: string;
    age?: number;
    gender?: string;
    nationality?: string;
    issuing_state?: string;
    expiration_date?: string;
    date_of_issue?: string;
    address?: string;
    place_of_birth?: string;
    portrait_image?: string;
    mrz?: Record<string, string>;
    warnings?: Array<{ risk?: string; additional_data?: unknown; log_type?: string; short_description?: string; long_description?: string } | string>;
  };
}

/**
 * One document read, shared between the two adapters that need it.
 *
 * Keyed on the bytes, not on the applicant: the same photograph asked about
 * twice is one question. Short-lived because it exists only to span a single
 * pipeline run, and holding document responses any longer would be holding
 * somebody's passport in memory for no reason.
 */
class DocumentCache {
  private readonly entries = new Map<string, { at: number; value: Promise<DocumentResponse> }>();
  constructor(private readonly ttlMs = 120_000) {}

  get(key: string): Promise<DocumentResponse> | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: Promise<DocumentResponse>) {
    this.entries.set(key, { at: Date.now(), value });
    // Bounded, so a long-running worker cannot accumulate them.
    if (this.entries.size > 64) {
      for (const [k, v] of this.entries) {
        if (Date.now() - v.at > this.ttlMs) this.entries.delete(k);
      }
    }
  }
}

const documents = new DocumentCache();

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

class DiditClient {
  constructor(private readonly options: DiditOptions) {
    if (!options.apiKey) throw new Error('Didit adapters require an API key');
  }

  async post<T>(path: string, form: FormData): Promise<T> {
    const response = await fetch(`${this.options.baseUrl ?? DEFAULT_BASE}${path}`, {
      method: 'POST',
      headers: { 'x-api-key': this.options.apiKey },
      body: form,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // 403 is "out of credits", which is an operational failure of ours and
      // reads very differently from a document being rejected. Saying so here
      // saves somebody an afternoon.
      const hint =
        response.status === 403
          ? ' — out of credits, or the key lacks access. Top up at business.didit.me.'
          : response.status === 401
            ? ' — the API key was not accepted.'
            : '';
      throw new ProviderError(`Didit ${path} returned ${response.status}${hint}`, response.status);
    }
    return (await response.json()) as T;
  }

  async bytesFor(image: ImageInput): Promise<Buffer> {
    if (image.bytes) return image.bytes;
    if (!image.storageKey) throw new Error('Image has neither bytes nor a storage key');
    if (!this.options.storage) throw new Error('No storage adapter configured');
    return (await this.options.storage.get(image.storageKey)).bytes;
  }

  /** Reads a document, or returns the answer already obtained for these bytes. */
  async readDocument(front: Buffer, back: Buffer | null, vendorData: string): Promise<DocumentResponse> {
    const key = createHash('sha256')
      .update(front)
      .update(back ?? Buffer.alloc(0))
      .digest('hex');

    const cached = documents.get(key);
    if (cached) return cached;

    const form = new FormData();
    form.append('front_image', new Blob([new Uint8Array(front)]), 'front.jpg');
    if (back) form.append('back_image', new Blob([new Uint8Array(back)]), 'back.jpg');
    form.append('vendor_data', vendorData);

    const pending = this.post<DocumentResponse>('/id-verification/', form);
    documents.set(key, pending);
    return pending;
  }
}

class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Anything that is not a verdict is ours to own, and worth retrying. */
function asFailure<T>(name: string, started: number, error: unknown): AdapterResult<T> {
  const status = error instanceof ProviderError ? error.status : 0;
  return {
    ok: false,
    provider: name,
    latencyMs: Date.now() - started,
    error: {
      code: status === 401 || status === 403 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR',
      message: error instanceof Error ? error.message : String(error),
      // A misconfigured key will not fix itself, but the pipeline treating it
      // as retryable is still better than treating it as an applicant's fault.
      retryable: true,
    },
  };
}

/** Their warnings are objects or strings depending on the endpoint. */
function warningsOf(raw: unknown): Finding[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((w) => {
    if (typeof w === 'string') {
      return { code: w, severity: 'MEDIUM' as const, message: w };
    }
    const warning = w as { risk?: string; log_type?: string; short_description?: string; long_description?: string };
    return {
      code: warning.log_type ?? warning.risk ?? 'PROVIDER_WARNING',
      severity: (warning.risk === 'HIGH' ? 'HIGH' : 'MEDIUM') as 'HIGH' | 'MEDIUM',
      message: warning.long_description ?? warning.short_description ?? 'Provider raised a warning',
    };
  });
}

const pickFront = (images: ImageInput[]) =>
  images.find((i) => i.side === 'PAGE') ?? images.find((i) => i.side === 'FRONT_SIDE') ?? images[0];
const pickBack = (images: ImageInput[]) => images.find((i) => i.side === 'BACK_SIDE');

// ---------------------------------------------------------------------------
// Reading a document
// ---------------------------------------------------------------------------

export class DiditOcrAdapter implements OcrAdapter {
  readonly name = 'didit-id-verification';
  private readonly client: DiditClient;

  constructor(private readonly options: DiditOptions) {
    this.client = new DiditClient(options);
  }

  async extract(req: OcrRequest, ctx: AdapterContext): Promise<AdapterResult<OcrResult>> {
    const started = Date.now();
    try {
      const front = pickFront(req.images);
      if (!front) throw new Error('No image supplied');
      const back = pickBack(req.images);

      const response = await this.client.readDocument(
        await this.client.bytesFor(front),
        back ? await this.client.bytesFor(back) : null,
        ctx.applicantId ?? 'unknown',
      );
      const d = response.id_verification;

      const findings = warningsOf(d.warnings);
      if (d.status === 'In Review') {
        findings.push({
          code: 'PROVIDER_INCONCLUSIVE',
          severity: 'MEDIUM',
          message: 'The provider could not decide and has flagged this for manual review.',
        });
      }

      return {
        ok: true,
        provider: this.name,
        providerRef: response.request_id,
        latencyMs: Date.now() - started,
        data: {
          documentType: d.document_type ?? req.documentType,
          detectedCountry: d.issuing_state ?? null,
          fields: {
            firstName: d.first_name,
            lastName: d.last_name,
            fullName: d.full_name,
            documentNumber: d.document_number,
            dob: d.date_of_birth,
            sex: d.gender === 'M' || d.gender === 'F' ? d.gender : undefined,
            nationality: d.nationality,
            expiryDate: d.expiration_date,
            issuedDate: d.date_of_issue,
            address: d.address,
            placeOfBirth: d.place_of_birth,
            personalNumber: d.personal_number,
          },
          mrz: d.mrz ? mrzLinesFrom(d.mrz) : undefined,
          // Their confidence is expressed as a verdict rather than a number, so
          // it is mapped rather than invented: a declined document must not
          // come back looking merely uncertain.
          fieldConfidence: confidenceFor(d.status),
          quality: {
            sharpness: 1,
            glare: 0,
            brightness: 0.5,
            resolution: { width: 0, height: 0 },
            isColour: true,
            fullDocumentVisible: d.status !== 'Declined',
            screenCaptureSuspected: findings.some((f) => /screen|replay/i.test(f.code)),
          },
          findings,
        },
        raw: response,
      };
    } catch (error) {
      this.options.logger?.(`[didit] document read failed: ${String(error)}`);
      return asFailure(this.name, started, error);
    }
  }
}

/**
 * The MRZ, reassembled.
 *
 * They return the parsed fields rather than the raw lines, and the pipeline
 * validates check digits itself against the raw zone. Reconstructing a line
 * from parsed fields would produce a zone whose digits we computed, which
 * would then "validate" against itself and prove nothing — so this returns the
 * raw text only when they supply it, and otherwise nothing at all.
 */
function mrzLinesFrom(mrz: Record<string, string>): string | undefined {
  const raw = mrz.raw ?? mrz.raw_text ?? mrz.mrz_text;
  return typeof raw === 'string' && raw.includes('<') ? raw : undefined;
}

function confidenceFor(status: DiditStatus): Record<string, number> {
  const value = status === 'Approved' ? 0.97 : status === 'In Review' ? 0.5 : 0.1;
  return {
    documentNumber: value,
    dob: value,
    expiryDate: value,
    firstName: value,
    lastName: value,
    nationality: value,
  };
}

// ---------------------------------------------------------------------------
// Is the document genuine
// ---------------------------------------------------------------------------

export class DiditDocAuthAdapter implements DocAuthAdapter {
  readonly name = 'didit-id-verification';
  private readonly client: DiditClient;

  constructor(private readonly options: DiditOptions) {
    this.client = new DiditClient(options);
  }

  async verify(req: DocAuthRequest, ctx: AdapterContext): Promise<AdapterResult<DocAuthResult>> {
    const started = Date.now();
    try {
      const front = pickFront(req.images);
      if (!front) throw new Error('No image supplied');
      const back = pickBack(req.images);

      // The same call the reader made, answered from cache. Their response
      // carries both what the document says and whether it is authentic.
      const response = await this.client.readDocument(
        await this.client.bytesFor(front),
        back ? await this.client.bytesFor(back) : null,
        ctx.applicantId ?? 'unknown',
      );
      const d = response.id_verification;
      const findings = warningsOf(d.warnings);

      // Tamper indicators are whichever warnings speak to the document being
      // altered rather than to the photograph being poor.
      const tamperFlags = findings
        .filter((f) => /tamper|forg|manipul|fake|photoshop|edit/i.test(`${f.code} ${f.message}`))
        .map((f) => f.code);

      return {
        ok: true,
        provider: this.name,
        providerRef: response.request_id,
        latencyMs: Date.now() - started,
        data: {
          authenticityScore: d.status === 'Approved' ? 95 : d.status === 'In Review' ? 55 : 10,
          tamperFlags,
          // They match against their own template library but do not name it,
          // so this reports what is known and does not invent a template name.
          templateMatched: d.status !== 'Declined',
          securityFeatures: [],
          findings,
        },
        raw: response,
      };
    } catch (error) {
      this.options.logger?.(`[didit] authenticity check failed: ${String(error)}`);
      return asFailure(this.name, started, error);
    }
  }
}

// ---------------------------------------------------------------------------
// Is a live person there
// ---------------------------------------------------------------------------

interface LivenessResponse {
  request_id: string;
  liveness: {
    status: DiditStatus;
    method?: string;
    score?: number;
    user_image?: { entities?: Array<{ age?: number; confidence?: number; gender?: string }> };
    warnings?: unknown;
  };
}

export class DiditLivenessAdapter implements LivenessAdapter {
  readonly name = 'didit-passive-liveness';
  private readonly client: DiditClient;

  constructor(private readonly options: DiditOptions) {
    this.client = new DiditClient(options);
  }

  async check(req: LivenessRequest, ctx: AdapterContext): Promise<AdapterResult<LivenessResult>> {
    const started = Date.now();
    try {
      const bytes = await this.client.bytesFor(req.media);
      const form = new FormData();
      form.append('user_image', new Blob([new Uint8Array(bytes)]), 'selfie.jpg');
      form.append('vendor_data', ctx.applicantId ?? 'unknown');
      if (this.options.livenessThreshold !== undefined) {
        form.append('face_liveness_score_decline_threshold', String(this.options.livenessThreshold));
      }

      const response = await this.client.post<LivenessResponse>('/passive-liveness/', form);
      const l = response.liveness;
      const findings = warningsOf(l.warnings);
      const faces = l.user_image?.entities ?? [];

      // Passive liveness detects a photograph, a screen or a mask presented to
      // the camera. It does not detect a video injected in place of the camera,
      // which is the attack that matters most and needs device attestation the
      // browser cannot give. Said out loud so a pass is not over-read.
      findings.push({
        code: 'INJECTION_NOT_CHECKED',
        severity: 'INFO',
        message:
          'Passive liveness covers presentation attacks — a photo, a screen, a mask. It ' +
          'cannot detect a stream injected in place of the camera; that needs a mobile ' +
          'SDK with device attestation.',
      });

      return {
        ok: true,
        provider: this.name,
        providerRef: response.request_id,
        latencyMs: Date.now() - started,
        data: {
          score: (l.score ?? 0) / 100,
          spoofDetected: l.status === 'Declined',
          attackType: l.status === 'Declined' ? 'PRINTED_PHOTO' : null,
          faceDetected: faces.length > 0,
          faceCount: faces.length,
          occlusions: [],
          estimatedAge: faces[0]?.age,
          findings,
        },
        raw: response,
      };
    } catch (error) {
      this.options.logger?.(`[didit] liveness failed: ${String(error)}`);
      return asFailure(this.name, started, error);
    }
  }
}

// ---------------------------------------------------------------------------
// Is it the same person
// ---------------------------------------------------------------------------

interface FaceMatchResponse {
  request_id: string;
  face_match: { status: DiditStatus; score?: number; warnings?: unknown };
}

export class DiditFaceMatchAdapter implements FaceMatchAdapter {
  readonly name = 'didit-face-match';
  private readonly client: DiditClient;

  constructor(private readonly options: DiditOptions) {
    this.client = new DiditClient(options);
  }

  async compare(req: FaceMatchRequest, ctx: AdapterContext): Promise<AdapterResult<FaceMatchResult>> {
    const started = Date.now();
    const threshold = this.options.faceMatchThreshold ?? 30;
    try {
      const form = new FormData();
      form.append(
        'user_image',
        new Blob([new Uint8Array(await this.client.bytesFor(req.selfie))]),
        'selfie.jpg',
      );
      form.append(
        'ref_image',
        new Blob([new Uint8Array(await this.client.bytesFor(req.documentPortrait))]),
        'portrait.jpg',
      );
      form.append('face_match_score_decline_threshold', String(threshold));
      form.append('vendor_data', ctx.applicantId ?? 'unknown');

      const response = await this.client.post<FaceMatchResponse>('/face-match/', form);

      return {
        ok: true,
        provider: this.name,
        providerRef: response.request_id,
        latencyMs: Date.now() - started,
        data: {
          score: (response.face_match.score ?? 0) / 100,
          providerThreshold: threshold / 100,
          findings: warningsOf(response.face_match.warnings),
        },
        raw: response,
      };
    } catch (error) {
      this.options.logger?.(`[didit] face match failed: ${String(error)}`);
      return asFailure(this.name, started, error);
    }
  }
}
