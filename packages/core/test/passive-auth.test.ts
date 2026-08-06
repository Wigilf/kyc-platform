import { beforeAll, describe, expect, it } from 'vitest';
import { verifyPassiveAuthentication } from '../src/passive-auth.js';
import { buildSod, issuedBy, selfSigned, type Authority } from './passport-pki.js';

/**
 * Passive authentication, against a synthetic passport PKI.
 *
 * There is no way to unit-test this with a real passport — quite deliberately,
 * since the whole point is that only an issuing state can produce a valid one.
 * So the test builds its own: a country signing CA, a document signer it
 * issues, and a security object signed over real data group hashes. That
 * exercises the same code paths a genuine chip would, and lets each of the
 * ways a forgery fails be produced on demand.
 *
 * The cases below are the four things an attacker would try: change the data,
 * change the data and re-sign it with their own key, present a document signer
 * no country vouches for, and add a data group the issuer never committed to.
 */

/** The chip's contents: the machine-readable zone and a portrait. */
const DATA_GROUPS = {
  DG1: Buffer.from('P<UTOSPECIMEN<<ADA<MARIE<<<<<<<<<<<<<<<<<<<<', 'ascii'),
  DG2: Buffer.from('a portrait, as far as this test is concerned', 'ascii'),
};

let csca: Authority;
let documentSigner: Authority;
/** A country nobody trusts, for the "who vouches for this?" case. */
let rogueCsca: Authority;
let rogueSigner: Authority;

beforeAll(async () => {
  csca = await selfSigned('Utopia Country Signing CA');
  documentSigner = await issuedBy(csca, 'Utopia Document Signer 01');
  rogueCsca = await selfSigned('Definitely Legitimate CA');
  rogueSigner = await issuedBy(rogueCsca, 'Definitely Legitimate Signer');
}, 60_000);

describe('a genuine chip', () => {
  it('verifies, and reports which data groups were proven', async () => {
    const sod = await buildSod(documentSigner, DATA_GROUPS);

    const result = await verifyPassiveAuthentication({
      sod,
      dataGroups: DATA_GROUPS,
      trustedCscas: [csca.pem],
    });

    expect(result.signatureValid).toBe(true);
    expect(result.chainValid).toBe(true);
    expect(result.hashesMatch).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.hashAlgorithm).toBe('sha256');
    expect(result.dataGroups.filter((d) => d.matches).map((d) => d.group)).toEqual([
      'DG1',
      'DG2',
    ]);
    expect(result.errors).toEqual([]);
  }, 60_000);
});

describe('a tampered chip', () => {
  it('rejects a data group that has been altered since issue', async () => {
    // The security object is genuine and untouched; one data group is not.
    const sod = await buildSod(documentSigner, DATA_GROUPS);
    const altered = {
      ...DATA_GROUPS,
      DG1: Buffer.from('P<UTOSPECIMEN<<BOB<<<<<<<<<<<<<<<<<<<<<<<<<<', 'ascii'),
    };

    const result = await verifyPassiveAuthentication({
      sod,
      dataGroups: altered,
      trustedCscas: [csca.pem],
    });

    // The signature is still good — it is the data underneath that moved.
    expect(result.signatureValid).toBe(true);
    expect(result.hashesMatch).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('DG1 does not match');
  }, 60_000);

  it('rejects data re-signed by a signer no country vouches for', async () => {
    // The thorough forgery: alter the data *and* rebuild the security object so
    // the hashes agree again. Internally consistent, and worthless — producing
    // one a country would vouch for needs that country's signing key.
    const altered = {
      ...DATA_GROUPS,
      DG1: Buffer.from('P<UTOSPECIMEN<<BOB<<<<<<<<<<<<<<<<<<<<<<<<<<', 'ascii'),
    };
    const sod = await buildSod(rogueSigner, altered);

    const result = await verifyPassiveAuthentication({
      sod,
      dataGroups: altered,
      trustedCscas: [csca.pem],
    });

    expect(result.signatureValid).toBe(true);
    expect(result.hashesMatch).toBe(true);
    expect(result.chainValid).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('does not chain to any trusted');
  }, 60_000);

  it('refuses a data group the issuer never committed to', async () => {
    const sod = await buildSod(documentSigner, DATA_GROUPS);

    const result = await verifyPassiveAuthentication({
      sod,
      dataGroups: { ...DATA_GROUPS, DG7: Buffer.from('a signature I added myself') },
      trustedCscas: [csca.pem],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('DG7 was supplied but the issuer did not sign');
  }, 60_000);
});

describe('refusing to pass on a technicality', () => {
  it('fails when there are no trust anchors at all', async () => {
    const sod = await buildSod(documentSigner, DATA_GROUPS);

    const result = await verifyPassiveAuthentication({
      sod,
      dataGroups: DATA_GROUPS,
      trustedCscas: [],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('No trusted CSCA certificates');
  }, 60_000);

  it('fails when the signature is good but no data groups were supplied', async () => {
    // Everything cryptographic checks out and nothing has been verified, which
    // is precisely the shape of answer that should never read as success.
    const sod = await buildSod(documentSigner, DATA_GROUPS);

    const result = await verifyPassiveAuthentication({
      sod,
      dataGroups: {},
      trustedCscas: [csca.pem],
    });

    expect(result.signatureValid).toBe(true);
    expect(result.chainValid).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('nothing was actually verified');
  }, 60_000);

  it('warns, rather than fails, when identity data was not read', async () => {
    const sod = await buildSod(documentSigner, DATA_GROUPS);

    const result = await verifyPassiveAuthentication({
      sod,
      dataGroups: { DG2: DATA_GROUPS.DG2 },
      trustedCscas: [csca.pem],
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toContain('DG1 was not supplied');
  }, 60_000);
});
