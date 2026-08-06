import { verifyPassiveAuthentication, type DataGroups } from '@kyc/core';
import type {
  AdapterContext,
  AdapterResult,
  Finding,
  NfcAdapter,
  NfcRequest,
  NfcResult,
} from '../types.js';

/**
 * Real chip verification for an ePassport (ICAO 9303).
 *
 * Unlike every other document adapter here, this one is not an approximation
 * of a commercial product — it is the same check a commercial product performs,
 * because the check is defined by a public standard and settled by arithmetic.
 * A passport's chip is signed by the state that issued it; either the signature
 * verifies against a country we trust, or it does not.
 *
 * **This adapter does not talk to the chip.** Reading it requires physical
 * proximity and a conversation in APDUs, which a browser cannot have — Web NFC
 * handles a different, simpler kind of tag. So the reading happens in a mobile
 * app and the verifying happens here, which is the right split anyway: the
 * trust store and the verdict belong on a server the applicant does not
 * control.
 *
 * **Active authentication is not implemented and is reported as unknown, not
 * as passed.** Proving a chip is not a clone means challenging it to sign a
 * nonce, which is again a conversation with the chip. Until the mobile side
 * exists and forwards that exchange, `activeAuthPassed` stays null. A cloned
 * chip passes everything below.
 */

export interface IcaoNfcOptions {
  /**
   * Trusted Country Signing CA certificates, PEM or DER.
   *
   * From the ICAO Public Key Directory, or a national master list. Deliberately
   * required rather than defaulted: shipping a trust store with the code would
   * make an expiring, politically-maintained list look like a constant.
   */
  trustedCscas: Array<Buffer | string>;
  logger?: (msg: string) => void;
}

export class IcaoNfcAdapter implements NfcAdapter {
  readonly name = 'icao-passive-auth';

  constructor(private readonly options: IcaoNfcOptions) {}

  async read(req: NfcRequest, _ctx: AdapterContext): Promise<AdapterResult<NfcResult>> {
    const started = Date.now();
    const findings: Finding[] = [];

    const sodBase64 = req.dataGroups.SOD ?? req.dataGroups.EF_SOD;
    if (!sodBase64) {
      return {
        ok: false,
        provider: this.name,
        latencyMs: Date.now() - started,
        error: {
          code: 'NO_SECURITY_OBJECT',
          message:
            'The chip read did not include the security object, so nothing can be ' +
            'verified against the issuer.',
          retryable: false,
        },
      };
    }

    const dataGroups: DataGroups = {};
    for (const [name, value] of Object.entries(req.dataGroups)) {
      if (name === 'SOD' || name === 'EF_SOD') continue;
      dataGroups[name.toUpperCase()] = Buffer.from(value, 'base64');
    }

    const verdict = await verifyPassiveAuthentication({
      sod: Buffer.from(sodBase64, 'base64'),
      dataGroups,
      trustedCscas: this.options.trustedCscas,
    });

    for (const error of verdict.errors) {
      findings.push({ code: 'CHIP_VERIFICATION_FAILED', severity: 'CRITICAL', message: error });
    }
    for (const warning of verdict.warnings) {
      findings.push({ code: 'CHIP_VERIFICATION_NOTE', severity: 'LOW', message: warning });
    }
    findings.push({
      code: 'CHIP_CLONE_NOT_CHECKED',
      severity: 'INFO',
      message:
        'Passive authentication proves the data was written by the issuer and has not ' +
        'been altered. It does not prove this chip is not a copy of a genuine one.',
    });

    // The machine-readable zone from the chip, which — unlike the printed one —
    // is covered by the issuer's signature.
    const mrz = dataGroups.DG1?.toString('latin1').replace(/[^A-Z0-9<\n]/gi, '');

    this.options.logger?.(
      `[nfc] ${verdict.ok ? 'verified' : 'failed'}: signature ${verdict.signatureValid}, ` +
        `chain ${verdict.chainValid}, hashes ${verdict.hashesMatch}, ` +
        `signer ${verdict.signerSubject ?? 'unknown'}`,
    );

    return {
      ok: true,
      provider: this.name,
      latencyMs: Date.now() - started,
      providerRef: verdict.signerSubject ?? undefined,
      data: {
        passiveAuthPassed: verdict.ok,
        activeAuthPassed: null,
        certificateChainValid: verdict.chainValid,
        fields: mrz ? { fullName: undefined } : {},
        findings,
      },
      raw: {
        signatureValid: verdict.signatureValid,
        chainValid: verdict.chainValid,
        hashesMatch: verdict.hashesMatch,
        signerSubject: verdict.signerSubject,
        signerIssuer: verdict.signerIssuer,
        hashAlgorithm: verdict.hashAlgorithm,
        dataGroups: verdict.dataGroups,
        mrz,
      },
    };
  }
}
