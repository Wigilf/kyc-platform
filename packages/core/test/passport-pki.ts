/**
 * A synthetic passport PKI, for tests.
 *
 * Not a `.test.ts` file: it is imported by suites in more than one package,
 * because the chip adapter and the verifier underneath it both need a
 * genuinely signed security object to work against and there is no other way
 * to obtain one — only an issuing state can produce a real one, which is the
 * entire point of the check.
 */

import { createHash, webcrypto } from 'node:crypto';
import * as asn1js from 'asn1js';
import {
  AlgorithmIdentifier,
  Attribute,
  AttributeTypeAndValue,
  Certificate,
  ContentInfo,
  CryptoEngine,
  EncapsulatedContentInfo,
  IssuerAndSerialNumber,
  SignedAndUnsignedAttributes,
  SignedData,
  SignerInfo,
  getCrypto,
  setEngine,
} from 'pkijs';

setEngine('node', new CryptoEngine({ crypto: webcrypto as unknown as Crypto }));

const SHA256_OID = '2.16.840.1.101.3.4.2.1';
const RSA_SHA256_OID = '1.2.840.113549.1.1.11';
const LDS_SECURITY_OBJECT_OID = '2.23.136.1.1.1';
const CONTENT_TYPE_OID = '1.2.840.113549.1.9.3';
const MESSAGE_DIGEST_OID = '1.2.840.113549.1.9.4';

export interface Authority {
  certificate: Certificate;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  pem: string;
}



export async function keyPair(): Promise<CryptoKeyPair> {
  return (await getCrypto(true).generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

export async function selfSigned(commonName: string): Promise<Authority> {
  const keys = await keyPair();
  const certificate = newCertificate(commonName, commonName);
  await certificate.subjectPublicKeyInfo.importKey(keys.publicKey);
  await certificate.sign(keys.privateKey, 'SHA-256');
  return {
    certificate,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    pem: toPem(certificate),
  };
}

export async function issuedBy(issuer: Authority, commonName: string): Promise<Authority> {
  const keys = await keyPair();
  const certificate = newCertificate(
    commonName,
    (issuer.certificate.subject.typesAndValues[0]!.value as asn1js.Utf8String).valueBlock
      .value,
  );
  await certificate.subjectPublicKeyInfo.importKey(keys.publicKey);
  await certificate.sign(issuer.privateKey, 'SHA-256');
  return {
    certificate,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    pem: toPem(certificate),
  };
}

function newCertificate(subjectCn: string, issuerCn: string): Certificate {
  const certificate = new Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1js.Integer({ value: Date.parse('2026-01-01') });
  certificate.issuer.typesAndValues.push(
    new AttributeTypeAndValue({
      type: '2.5.4.3',
      value: new asn1js.Utf8String({ value: issuerCn }),
    }),
  );
  certificate.subject.typesAndValues.push(
    new AttributeTypeAndValue({
      type: '2.5.4.3',
      value: new asn1js.Utf8String({ value: subjectCn }),
    }),
  );
  certificate.notBefore.value = new Date('2026-01-01');
  certificate.notAfter.value = new Date('2036-01-01');
  return certificate;
}

export function toPem(certificate: Certificate): string {
  const body = Buffer.from(certificate.toSchema().toBER(false)).toString('base64');
  return `-----BEGIN CERTIFICATE-----\n${body.replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
}

/** An LDS security object listing the SHA-256 of each data group, CMS-signed. */
export async function buildSod(
  signer: Authority,
  dataGroups: Record<string, Buffer>,
): Promise<Buffer> {
  const hashes = Object.entries(dataGroups).map(
    ([group, bytes]) =>
      new asn1js.Sequence({
        value: [
          new asn1js.Integer({ value: Number(group.replace(/\D/g, '')) }),
          new asn1js.OctetString({
            valueHex: createHash('sha256').update(bytes).digest(),
          }),
        ],
      }),
  );

  const ldsSecurityObject = new asn1js.Sequence({
    value: [
      new asn1js.Integer({ value: 0 }),
      new asn1js.Sequence({
        value: [new asn1js.ObjectIdentifier({ value: SHA256_OID }), new asn1js.Null()],
      }),
      new asn1js.Sequence({ value: hashes }),
    ],
  });
  const eContent = Buffer.from(ldsSecurityObject.toBER(false));

  const signedData = new SignedData({
    version: 3,
    encapContentInfo: new EncapsulatedContentInfo({
      eContentType: LDS_SECURITY_OBJECT_OID,
      eContent: new asn1js.OctetString({ valueHex: eContent }),
    }),
    certificates: [signer.certificate],
    signerInfos: [
      new SignerInfo({
        version: 1,
        sid: new IssuerAndSerialNumber({
          issuer: signer.certificate.issuer,
          serialNumber: signer.certificate.serialNumber,
        }),
        digestAlgorithm: new AlgorithmIdentifier({ algorithmId: SHA256_OID }),
        signatureAlgorithm: new AlgorithmIdentifier({ algorithmId: RSA_SHA256_OID }),
        signedAttrs: new SignedAndUnsignedAttributes({
          type: 0,
          attributes: [
            new Attribute({
              type: CONTENT_TYPE_OID,
              values: [new asn1js.ObjectIdentifier({ value: LDS_SECURITY_OBJECT_OID })],
            }),
            new Attribute({
              type: MESSAGE_DIGEST_OID,
              values: [
                new asn1js.OctetString({
                  valueHex: createHash('sha256').update(eContent).digest(),
                }),
              ],
            }),
          ],
        }),
      }),
    ],
  });
  signedData.digestAlgorithms.push(new AlgorithmIdentifier({ algorithmId: SHA256_OID }));

  await signedData.sign(signer.privateKey, 0, 'SHA-256');

  const contentInfo = new ContentInfo({
    contentType: ContentInfo.SIGNED_DATA,
    content: signedData.toSchema(true),
  });
  return Buffer.from(contentInfo.toSchema().toBER(false));
}
