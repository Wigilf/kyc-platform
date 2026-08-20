import NfcManager, { NfcTech } from 'react-native-nfc-manager';
import { Buffer } from 'buffer';
import type { ChipTransport } from '@kyc/mrtd';

/**
 * The radio.
 *
 * This is the whole of what could not be tested without a phone and a
 * passport: roughly forty lines that hand bytes to a chip and hand the answer
 * back. Everything it is handed to — key agreement, secure messaging, the send
 * counter, file reading — is exercised against a simulated chip in
 * `packages/mrtd`, so a fault here shows up as "no answer" rather than as a
 * subtly wrong verification.
 *
 * The two platforms differ in a way worth knowing about. Android exposes
 * ISO-DEP directly and will talk to anything. iOS requires the application
 * identifier to be declared up front in the entitlement, will only talk to
 * tags matching it, and needs a paid developer account before the entitlement
 * can be issued at all — there is no way to read a passport on an iPhone
 * without one.
 */

/** The ePassport application, as registered with ICAO. */
const PASSPORT_AID = 'A0000002471001';

export async function isAvailable(): Promise<boolean> {
  try {
    return await NfcManager.isSupported();
  } catch {
    return false;
  }
}

/**
 * Holds a session open for the length of one read.
 *
 * The chip loses power the moment the phone moves away, and a half-finished
 * session cannot be resumed — the send counter is gone with it. So the whole
 * read happens inside `withChip`, and anything that goes wrong ends the
 * session rather than trying to continue.
 */
export async function withChip<T>(
  onProgress: (message: string) => void,
  work: (transport: ChipTransport) => Promise<T>,
): Promise<T> {
  await NfcManager.start();
  onProgress('Hold your passport against the phone');

  try {
    await NfcManager.requestTechnology(NfcTech.IsoDep, {
      alertMessage: 'Hold the top of your phone against your passport',
    });

    const transport: ChipTransport = {
      async transceive(command: Buffer): Promise<Buffer> {
        const response = await NfcManager.isoDepHandler.transceive([...command]);
        return Buffer.from(response);
      },
    };

    // Selecting the passport application is the first thing any reader does;
    // a chip that refuses this is not an ePassport.
    const selected = await transport.transceive(
      Buffer.concat([
        Buffer.from([0x00, 0xa4, 0x04, 0x0c, PASSPORT_AID.length / 2]),
        Buffer.from(PASSPORT_AID, 'hex'),
      ]),
    );
    const status = selected.subarray(selected.length - 2).toString('hex');
    if (status !== '9000') {
      throw new Error('This does not appear to be a passport chip');
    }

    onProgress('Reading — keep it still');
    return await work(transport);
  } finally {
    // Always, including on the error paths: leaving the reader session open
    // blocks the next attempt and, on iOS, leaves the system sheet on screen.
    await NfcManager.cancelTechnologyRequest().catch(() => undefined);
  }
}

/**
 * Turns whatever went wrong into something an applicant can act on.
 *
 * The underlying errors are about status words and authentication, which are
 * meaningless to the person holding the phone and actively unhelpful — someone
 * told "6300" will try the same thing again.
 */
export function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/failed authentication|do not match|6300/i.test(message)) {
    return 'The details did not match this passport. Check the document number, date of birth and expiry date against the bottom of the photo page.';
  }
  if (/not appear to be a passport/i.test(message)) {
    return 'No passport chip found. Some older passports have no chip; the photo page alone will do.';
  }
  if (/cancelled|canceled|user/i.test(message)) {
    return 'Cancelled.';
  }
  if (/tag was lost|connection|transceive/i.test(message)) {
    return 'The passport moved away too soon. Hold it still against the back of the phone until it finishes.';
  }
  return 'The chip could not be read. You can continue without it — a reviewer will check the photo page.';
}
