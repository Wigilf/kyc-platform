import { beforeAll, describe, expect, it } from 'vitest';
import { IcaoNfcAdapter } from '../src/live/nfc-icao.js';
import {
  buildSod,
  issuedBy,
  selfSigned,
  type Authority,
} from '../../core/test/passport-pki.js';

/**
 * The chip adapter, end to end.
 *
 * The cryptography is tested next to the function that performs it; what is
 * tested here is the layer around it — base64 in, verdict and findings out —
 * because that translation is where a real verdict gets quietly turned into
 * the wrong shape of answer.
 */

const DATA_GROUPS = {
  DG1: Buffer.from('P<UTOSPECIMEN<<ADA<MARIE<<<<<<<<<<<<<<<<<<<<', 'ascii'),
  DG2: Buffer.from('a portrait, as far as this test is concerned', 'ascii'),
};

const ctx = { tenantId: 'test', applicantId: 'test', requestId: 'test' };

let csca: Authority;
let signer: Authority;
let request: { dataGroups: Record<string, string> };

beforeAll(async () => {
  csca = await selfSigned('Utopia Country Signing CA');
  signer = await issuedBy(csca, 'Utopia Document Signer 01');
  const sod = await buildSod(signer, DATA_GROUPS);
  request = {
    dataGroups: {
      SOD: sod.toString('base64'),
      DG1: DATA_GROUPS.DG1.toString('base64'),
      DG2: DATA_GROUPS.DG2.toString('base64'),
    },
  };
}, 60_000);

const read = (adapter: IcaoNfcAdapter, dataGroups: Record<string, string>) =>
  adapter.read(
    { dataGroups, documentNumber: 'UT7431852', dateOfBirth: '900512', dateOfExpiry: '310814' },
    ctx,
  );

describe('verifying a chip', () => {
  it('passes a genuine one and names the signer', async () => {
    const adapter = new IcaoNfcAdapter({ trustedCscas: [csca.pem] });

    const result = await read(adapter, request.dataGroups);

    expect(result.ok).toBe(true);
    expect(result.data!.passiveAuthPassed).toBe(true);
    expect(result.data!.certificateChainValid).toBe(true);
    expect(result.providerRef).toContain('Utopia Document Signer 01');
  }, 60_000);

  it('never claims the chip is not a clone', async () => {
    const adapter = new IcaoNfcAdapter({ trustedCscas: [csca.pem] });

    const result = await read(adapter, request.dataGroups);

    // Passive authentication cannot answer this, so it must not be reported as
    // answered. `false` would be a finding nobody made; `null` is the truth.
    expect(result.data!.activeAuthPassed).toBeNull();
    expect(result.data!.findings.map((f) => f.code)).toContain('CHIP_CLONE_NOT_CHECKED');
  }, 60_000);

  it('fails a chip whose data has been altered', async () => {
    const adapter = new IcaoNfcAdapter({ trustedCscas: [csca.pem] });

    const result = await read(adapter, {
      ...request.dataGroups,
      DG1: Buffer.from('P<UTOSPECIMEN<<BOB<<<<<<<<<<<<<<<<<<<<<<<<<<').toString('base64'),
    });

    expect(result.ok).toBe(true); // The adapter worked; the document did not.
    expect(result.data!.passiveAuthPassed).toBe(false);
    expect(result.data!.findings.some((f) => f.severity === 'CRITICAL')).toBe(true);
  }, 60_000);

  it('reports an error rather than a verdict when the security object is absent', async () => {
    const adapter = new IcaoNfcAdapter({ trustedCscas: [csca.pem] });

    const result = await read(adapter, { DG1: request.dataGroups.DG1! });

    // No security object means no verification happened at all. A `false`
    // verdict would say the document failed; it was never checked.
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NO_SECURITY_OBJECT');
    expect(result.data).toBeUndefined();
  }, 60_000);
});
