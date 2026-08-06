import { createHash, X509Certificate } from 'node:crypto';
import * as asn1js from 'asn1js';
import { ContentInfo, SignedData } from 'pkijs';

/**
 * Passive authentication of an ePassport chip (ICAO 9303 part 11).
 *
 * This is the only check in the platform that *proves* a document is genuine
 * rather than forming an opinion about it. Everything else — reading the
 * printed page, judging a hologram from a photograph, comparing a face — is
 * inference. This is arithmetic over a signature made by the issuing state.
 *
 * How it works. The chip holds the holder's details in numbered data groups:
 * DG1 is the machine-readable zone, DG2 the portrait, and so on. Alongside them
 * sits the Document Security Object, a signed structure listing the hash of
 * every data group. The signature is made by a Document Signer Certificate,
 * itself issued by that country's Country Signing CA. So:
 *
 *   1. the SOD's signature checks out against the document signer, therefore
 *   2. the list of hashes is exactly what the issuer published, therefore
 *   3. any data group whose hash matches was written by the issuer, and
 *   4. the document signer was authorised by a country we trust.
 *
 * Alter one byte of the holder's name and its hash stops matching. Re-sign the
 * altered data and step 4 fails, because forging that requires a country's
 * signing key.
 *
 * **What it does not prove.** That this chip is not a copy of a real one.
 * Passive authentication verifies the data, not the medium — a bit-for-bit
 * clone passes it. Detecting that needs active or chip authentication, where
 * the chip proves it holds a private key it will not divulge, and that is a
 * conversation with the chip rather than a check on data it has already
 * handed over. `activeAuthPassed` is reported separately for that reason and
 * is not something this function can answer.
 *
 * **Trust anchors are an operational matter, not a code one.** The CSCA
 * certificates come from the ICAO Public Key Directory or from national
 * master lists, they expire and rotate, and which ones to trust is a
 * compliance decision. This function takes them as an argument and refuses to
 * proceed without any, because a chain that terminates nowhere is not a chain.
 */

/** Numbered data groups, as read from the chip. Keys like `DG1`, `DG2`. */
export type DataGroups = Record<string, Buffer>;

export interface PassiveAuthInput {
  /** The Document Security Object, DER-encoded. */
  sod: Buffer;
  /** Whatever data groups were read. Missing ones are reported, not fatal. */
  dataGroups: DataGroups;
  /** Trusted Country Signing CA certificates, PEM or DER. */
  trustedCscas: Array<Buffer | string>;
  /** Overridable so tests are not hostage to the calendar. */
  now?: Date;
}

export interface DataGroupResult {
  group: string;
  /** Present in the security object's list of hashes. */
  listed: boolean;
  /** Supplied by the caller, so it could be checked. */
  supplied: boolean;
  /** Supplied, listed, and the hashes agree. */
  matches: boolean;
}

export interface PassiveAuthResult {
  /** Every step passed: signature, chain, validity, and all supplied hashes. */
  ok: boolean;
  /** The security object's signature verifies against the document signer. */
  signatureValid: boolean;
  /** The document signer chains to one of the trusted country CAs. */
  chainValid: boolean;
  /** The document signer was within its validity period at `now`. */
  signerCurrent: boolean;
  /** Every data group supplied matched the hash the issuer published. */
  hashesMatch: boolean;
  hashAlgorithm: string | null;
  signerSubject: string | null;
  signerIssuer: string | null;
  dataGroups: DataGroupResult[];
  errors: string[];
  warnings: string[];
}

/** OIDs for the digest algorithms ICAO permits. SHA-1 is legacy and refused. */
const DIGEST_OIDS: Record<string, string> = {
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
  '2.16.840.1.101.3.4.2.4': 'sha224',
  '1.3.14.3.2.26': 'sha1',
};

export async function verifyPassiveAuthentication(
  input: PassiveAuthInput,
): Promise<PassiveAuthResult> {
  const now = input.now ?? new Date();
  const errors: string[] = [];
  const warnings: string[] = [];

  const result: PassiveAuthResult = {
    ok: false,
    signatureValid: false,
    chainValid: false,
    signerCurrent: false,
    hashesMatch: false,
    hashAlgorithm: null,
    signerSubject: null,
    signerIssuer: null,
    dataGroups: [],
    errors,
    warnings,
  };

  // No trust anchors means nothing can be trusted. Failing loudly beats
  // reporting a chain as valid because there was nothing to contradict it.
  if (input.trustedCscas.length === 0) {
    errors.push(
      'No trusted CSCA certificates were supplied, so the document signer cannot be ' +
        'anchored to any issuing state. Load the ICAO PKD master list.',
    );
    return result;
  }

  let signedData: SignedData;
  try {
    const contentInfo = ContentInfo.fromBER(toArrayBuffer(input.sod));
    signedData = new SignedData({ schema: contentInfo.content });
  } catch (error) {
    errors.push(`The security object could not be parsed: ${message(error)}`);
    return result;
  }

  // --- The document signer -------------------------------------------------
  const signerDer = signedData.certificates?.find(
    (c): c is NonNullable<typeof c> & { toSchema: () => asn1js.Sequence } =>
      typeof (c as { toSchema?: unknown }).toSchema === 'function',
  );
  if (!signerDer) {
    errors.push('The security object carries no document signer certificate.');
    return result;
  }

  let signer: X509Certificate;
  try {
    signer = new X509Certificate(
      Buffer.from(signerDer.toSchema().toBER(false)),
    );
  } catch (error) {
    errors.push(`The document signer certificate is unreadable: ${message(error)}`);
    return result;
  }

  result.signerSubject = signer.subject;
  result.signerIssuer = signer.issuer;

  const from = new Date(signer.validFrom);
  const to = new Date(signer.validTo);
  result.signerCurrent = now >= from && now <= to;
  if (!result.signerCurrent) {
    // Not automatically fatal for an old document: a passport issued in 2019 was
    // signed by a certificate that has since expired, and that signature is
    // still good. What matters is that it was valid when it signed.
    warnings.push(
      `The document signer certificate is outside its validity period ` +
        `(${signer.validFrom} to ${signer.validTo}). This is expected for an older ` +
        `document and does not by itself invalidate the signature.`,
    );
  }

  // --- Chain to a country we trust ----------------------------------------
  for (const anchor of input.trustedCscas) {
    try {
      const csca = new X509Certificate(
        typeof anchor === 'string' ? anchor : anchor,
      );
      if (signer.checkIssued(csca) && signer.verify(csca.publicKey)) {
        result.chainValid = true;
        break;
      }
    } catch {
      warnings.push('A supplied CSCA certificate could not be parsed and was skipped.');
    }
  }
  if (!result.chainValid) {
    errors.push(
      'The document signer does not chain to any trusted country signing CA. Either ' +
        'the issuing state is not in the trust list or the document is not genuine.',
    );
  }

  // --- The signature over the security object ------------------------------
  try {
    result.signatureValid = await signedData.verify({ signer: 0 });
  } catch (error) {
    result.signatureValid = false;
    errors.push(`The security object signature did not verify: ${message(error)}`);
  }
  if (!result.signatureValid && errors.length === 0) {
    errors.push('The security object signature did not verify.');
  }

  // --- The data groups the issuer committed to ------------------------------
  const listed = readDataGroupHashes(signedData, errors);
  if (!listed) return result;

  result.hashAlgorithm = listed.algorithm;
  if (listed.algorithm === 'sha1') {
    warnings.push(
      'The security object uses SHA-1, which is no longer considered collision ' +
        'resistant. Accepted for older documents; treat with suspicion on a new one.',
    );
  }

  const supplied = new Set(Object.keys(input.dataGroups));
  const everyGroup = new Set([...supplied, ...listed.hashes.keys()]);
  let mismatched = 0;
  let checked = 0;

  for (const group of [...everyGroup].sort(byGroupNumber)) {
    const expected = listed.hashes.get(group);
    const actual = input.dataGroups[group];
    const row: DataGroupResult = {
      group,
      listed: expected !== undefined,
      supplied: actual !== undefined,
      matches: false,
    };

    if (expected && actual) {
      const digest = createHash(listed.algorithm).update(actual).digest();
      row.matches = digest.equals(expected);
      checked++;
      if (!row.matches) {
        mismatched++;
        errors.push(
          `${group} does not match the hash the issuer signed. This data group has ` +
            `been altered since the document was issued.`,
        );
      }
    } else if (actual && !expected) {
      // A group the issuer never committed to is unverifiable, and passing it
      // off as chip-verified would be the whole point of adding one.
      errors.push(`${group} was supplied but the issuer did not sign a hash for it.`);
    } else if (expected && !actual) {
      warnings.push(`${group} was signed by the issuer but not read from the chip.`);
    }

    result.dataGroups.push(row);
  }

  // Nothing supplied means nothing verified, whatever the signature says.
  if (checked === 0) {
    errors.push('No data groups were supplied, so nothing was actually verified.');
  }
  result.hashesMatch = checked > 0 && mismatched === 0;

  // DG1 is the machine-readable zone: name, date of birth, document number,
  // expiry. Verifying a portrait and no identity would be a curious kind of
  // success, so say plainly that it did not happen.
  if (!input.dataGroups.DG1) {
    warnings.push('DG1 was not supplied, so no identity data has been chip-verified.');
  }

  // Any recorded error blocks, not just the ones named here.
  //
  // Listing the conditions individually meant a smuggled-in data group — one
  // the issuer never signed — recorded its error and still came out `ok: true`,
  // because it failed none of the named tests. A caller reading the flag alone
  // would have accepted it. Errors are by construction the things that should
  // stop this, so the flag is derived from their absence.
  result.ok =
    errors.length === 0 &&
    result.signatureValid &&
    result.chainValid &&
    result.hashesMatch &&
    checked > 0;
  return result;
}

/**
 * The LDS security object: the issuer's list of data group hashes.
 *
 * Structure, from ICAO 9303 part 10:
 *
 *   LDSSecurityObject ::= SEQUENCE {
 *     version              INTEGER,
 *     hashAlgorithm        AlgorithmIdentifier,
 *     dataGroupHashValues  SEQUENCE OF DataGroupHash }
 *   DataGroupHash ::= SEQUENCE {
 *     dataGroupNumber      INTEGER,
 *     dataGroupHashValue   OCTET STRING }
 */
function readDataGroupHashes(
  signedData: SignedData,
  errors: string[],
): { algorithm: string; hashes: Map<string, Buffer> } | null {
  const content = signedData.encapContentInfo.eContent;
  if (!content) {
    errors.push('The security object carries no content to check the data groups against.');
    return null;
  }

  let parsed: asn1js.AsnType;
  try {
    parsed = asn1js.fromBER(content.getValue()).result;
  } catch (error) {
    errors.push(`The security object content could not be parsed: ${message(error)}`);
    return null;
  }

  const root = parsed as asn1js.Sequence;
  const parts = root.valueBlock?.value;
  if (!Array.isArray(parts) || parts.length < 3) {
    errors.push('The security object content is not a well-formed LDS security object.');
    return null;
  }

  const algorithmOid = (
    (parts[1] as asn1js.Sequence).valueBlock.value[0] as asn1js.ObjectIdentifier
  )?.valueBlock?.toString();
  const algorithm = DIGEST_OIDS[algorithmOid ?? ''];
  if (!algorithm) {
    errors.push(`Unsupported data group hash algorithm: ${algorithmOid ?? 'unknown'}.`);
    return null;
  }

  const hashes = new Map<string, Buffer>();
  for (const entry of (parts[2] as asn1js.Sequence).valueBlock.value) {
    const pair = (entry as asn1js.Sequence).valueBlock.value;
    const number = Number((pair[0] as asn1js.Integer).valueBlock.valueDec);
    const value = Buffer.from(
      (pair[1] as asn1js.OctetString).valueBlock.valueHexView,
    );
    hashes.set(`DG${number}`, value);
  }

  if (hashes.size === 0) {
    errors.push('The security object lists no data group hashes.');
    return null;
  }

  return { algorithm, hashes };
}

function byGroupNumber(a: string, b: string): number {
  return Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''));
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
