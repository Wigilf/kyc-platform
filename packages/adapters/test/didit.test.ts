import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DiditDocAuthAdapter,
  DiditFaceMatchAdapter,
  DiditLivenessAdapter,
  DiditOcrAdapter,
} from '../src/live/didit.js';

/**
 * The verification provider, against a stand-in that answers exactly as their
 * documented contract says.
 *
 * Not a mock of our own adapter — a fake of *their* server, so the code under
 * test is the real request building, the real response mapping and the real
 * error handling. What cannot be tested without an account is whether their
 * service behaves as documented; what can be tested, and is, is that we behave
 * correctly when it does.
 *
 * The cases that matter are the ones where a provider problem could be
 * mistaken for an applicant problem, and where one document could be paid for
 * twice.
 */

let server: Server;
let base: string;
/** Every request the adapters made, so double-billing is visible. */
let calls: string[] = [];
let nextStatus: 'Approved' | 'Declined' | 'In Review' = 'Approved';
let failWith: number | null = null;

/**
 * A distinct document per case.
 *
 * The adapters cache a document response against the bytes, so two cases
 * sharing one image share one answer — which is correct in production and
 * quietly wrong in a test that expects a different verdict from the same
 * photograph. The first version of this file did exactly that.
 */
let counter = 0;
const distinctImage = () => ({
  bytes: Buffer.from(`a passport, as far as this test is concerned #${counter++}`),
  contentType: 'image/png',
});
const image = distinctImage();
const ctx = { tenantId: 't', applicantId: 'applicant-1', requestId: 'r' };

beforeAll(async () => {
  server = createServer((req, res) => {
    calls.push(req.url ?? '');
    if (failWith) {
      res.writeHead(failWith, { 'content-type': 'application/json' });
      res.end('{"detail":"nope"}');
      return;
    }
    // Drain the multipart body before answering.
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url?.includes('id-verification')) {
        res.end(JSON.stringify({
          request_id: 'req-1',
          id_verification: {
            status: nextStatus,
            document_type: 'Passport',
            document_number: 'YZA123456',
            first_name: 'Elena',
            last_name: 'Martinez',
            date_of_birth: '1985-03-15',
            gender: 'F',
            nationality: 'ESP',
            issuing_state: 'ESP',
            expiration_date: '2030-08-21',
            warnings: nextStatus === 'Declined'
              ? [{ risk: 'HIGH', log_type: 'DOCUMENT_TAMPERED', long_description: 'Portrait appears manipulated' }]
              : [],
          },
        }));
      } else if (req.url?.includes('passive-liveness')) {
        res.end(JSON.stringify({
          request_id: 'req-2',
          liveness: { status: nextStatus, method: 'PASSIVE', score: nextStatus === 'Approved' ? 95 : 12,
            user_image: { entities: [{ age: 33.2, confidence: 0.9, gender: 'female' }] }, warnings: [] },
        }));
      } else {
        res.end(JSON.stringify({
          request_id: 'req-3',
          face_match: { status: nextStatus, score: nextStatus === 'Approved' ? 88 : 9, warnings: [] },
        }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v3`;
  process.env.DIDIT_BASE_URL = base;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const options = () => ({ apiKey: 'test-key', baseUrl: base });

describe('reading a document', () => {
  it('maps the provider fields onto ours', async () => {
    calls = []; nextStatus = 'Approved'; failWith = null;
    const result = await new DiditOcrAdapter(options()).extract(
      { images: [{ ...image, side: 'FRONT_SIDE' }], documentType: 'PASSPORT' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data!.fields).toMatchObject({
      firstName: 'Elena',
      lastName: 'Martinez',
      dob: '1985-03-15',
      documentNumber: 'YZA123456',
      nationality: 'ESP',
      expiryDate: '2030-08-21',
    });
    expect(result.providerRef).toBe('req-1');
  });

  it('does not present a declined document as merely uncertain', async () => {
    calls = []; nextStatus = 'Declined'; failWith = null;
    const result = await new DiditOcrAdapter(options()).extract(
      { images: [{ ...distinctImage(), side: 'FRONT_SIDE' }], documentType: 'PASSPORT' },
      ctx,
    );

    expect(result.data!.fieldConfidence.dob).toBeLessThan(0.2);
    expect(result.data!.findings.map((f) => f.code)).toContain('DOCUMENT_TAMPERED');
  });
});

describe('paying for one document once', () => {
  it('shares a single call between the reader and the authenticity check', async () => {
    calls = []; nextStatus = 'Approved'; failWith = null;
    const bytes = Buffer.from(`unique-${Date.now()}`);
    const req = { images: [{ bytes, contentType: 'image/png', side: 'FRONT_SIDE' as const }] };

    await new DiditOcrAdapter(options()).extract({ ...req, documentType: 'PASSPORT' }, ctx);
    await new DiditDocAuthAdapter(options()).verify(
      { ...req, documentType: 'PASSPORT', country: 'ESP' },
      ctx,
    );

    // Their response carries both answers. Asking twice would double the bill
    // for one document, every time, for every applicant.
    expect(calls.filter((c) => c.includes('id-verification'))).toHaveLength(1);
  });
});

describe('when the provider is unhappy', () => {
  it('reports a failure of ours, not a failure of the applicant', async () => {
    calls = []; failWith = 403;
    const result = await new DiditLivenessAdapter(options()).check(
      { media: image, mode: 'PASSIVE' },
      ctx,
    );

    // `ok: false` makes the pipeline record a FAILED check — our problem —
    // rather than a verdict about a person. Running out of credits must never
    // read as "this applicant is not alive".
    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.error?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(result.error?.message).toMatch(/credits|403/);
    expect(result.error?.retryable).toBe(true);
  });
});

describe('liveness', () => {
  it('scores a live face and admits what it cannot see', async () => {
    calls = []; nextStatus = 'Approved'; failWith = null;
    const result = await new DiditLivenessAdapter(options()).check(
      { media: image, mode: 'PASSIVE' },
      ctx,
    );

    expect(result.data!.score).toBeCloseTo(0.95, 2);
    expect(result.data!.spoofDetected).toBe(false);
    expect(result.data!.faceDetected).toBe(true);
    // Passive liveness cannot see a stream injected in place of the camera,
    // and a pass that does not say so invites being over-read.
    expect(result.data!.findings.map((f) => f.code)).toContain('INJECTION_NOT_CHECKED');
  });

  it('marks a declined selfie as a spoof', async () => {
    calls = []; nextStatus = 'Declined'; failWith = null;
    const result = await new DiditLivenessAdapter(options()).check(
      { media: image, mode: 'PASSIVE' },
      ctx,
    );
    expect(result.data!.spoofDetected).toBe(true);
    expect(result.data!.score).toBeLessThan(0.2);
  });
});

describe('face match', () => {
  it('returns a similarity and the threshold it was judged against', async () => {
    calls = []; nextStatus = 'Approved'; failWith = null;
    const result = await new DiditFaceMatchAdapter({ ...options(), faceMatchThreshold: 50 }).compare(
      { documentPortrait: image, selfie: image },
      ctx,
    );

    expect(result.data!.score).toBeCloseTo(0.88, 2);
    expect(result.data!.providerThreshold).toBeCloseTo(0.5, 2);
  });
});
