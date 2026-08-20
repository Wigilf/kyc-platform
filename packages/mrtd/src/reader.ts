import { tripleDesCbcDecrypt, tripleDesCbcEncrypt } from './crypto/des.js';
import {
  buildMutualAuthenticate,
  completeMutualAuthenticate,
  deriveBacKeys,
  expand3des,
  incrementSsc,
  mac,
  padIso9797Method2,
  unpadIso9797Method2,
  type BacKeys,
  type MrzKeyInput,
  type SessionKeys,
} from './bac.js';

/**
 * Reading a passport chip, everything except the radio.
 *
 * The transport is an interface with one method, so the protocol can be
 * exercised in full against a chip simulated in memory. That is deliberate:
 * the parts that go wrong are secure messaging and file reading, not the
 * antenna, and those can be proved on a desk. What genuinely needs a phone and
 * a passport is one small binding that hands bytes to `transceive` — everything
 * above it is tested.
 *
 * Reads the three things that matter: the machine-readable zone, the portrait,
 * and the security object the issuing state signed. The server verifies that
 * signature; this only fetches it. A reader that decided for itself whether a
 * document was genuine would be a reader an attacker could reimplement.
 */

const ZERO_IV = new Uint8Array(8);

/** Whatever moves bytes to the chip. A phone's NFC stack, or a test double. */
export interface ChipTransport {
  /** Sends a command APDU and returns the response, status word included. */
  transceive(command: Buffer): Promise<Buffer>;
}

export interface PassportRead {
  /** Data groups, keyed as the security object names them: DG1, DG2, … */
  dataGroups: Record<string, Buffer>;
  /** The Document Security Object, for the server to verify. */
  sod: Buffer;
}

/** ICAO short file identifiers for the files this reads. */
const FILES = {
  EF_COM: 0x1e,
  DG1: 0x01,
  DG2: 0x02,
  EF_SOD: 0x1d,
} as const;

/**
 * Opens the chip and reads it.
 *
 * The MRZ is the key: without the printed page there is no conversation, which
 * is what stops a chip being read through a coat pocket.
 */
export async function readPassport(
  transport: ChipTransport,
  mrz: MrzKeyInput,
): Promise<PassportRead> {
  const keys = deriveBacKeys(mrz);
  const session = await openSession(transport, keys);

  const dataGroups: Record<string, Buffer> = {};
  // DG1 and DG2 are the identity and the face. Others exist — fingerprints,
  // iris — and are not read: they are additional biometrics behind additional
  // access control, and asking for data we have no use for is not free.
  dataGroups.DG1 = await readFile(transport, session, FILES.DG1);
  dataGroups.DG2 = await readFile(transport, session, FILES.DG2);
  const sod = await readFile(transport, session, FILES.EF_SOD);

  return { dataGroups, sod };
}

/** Basic Access Control, start to finish. */
export async function openSession(
  transport: ChipTransport,
  keys: BacKeys,
): Promise<SessionKeys> {
  // GET CHALLENGE — the chip's random, which anchors the exchange.
  const challengeResponse = await transport.transceive(
    Buffer.from([0x00, 0x84, 0x00, 0x00, 0x08]),
  );
  const rndIc = expectOk(challengeResponse, 'GET CHALLENGE').subarray(0, 8);
  if (rndIc.length !== 8) throw new Error('The chip did not return a challenge');

  const challenge = buildMutualAuthenticate(keys, rndIc);
  const command = Buffer.concat([
    Buffer.from([0x00, 0x82, 0x00, 0x00, challenge.commandData.length]),
    challenge.commandData,
    Buffer.from([0x28]), // Expected length: 40 bytes back.
  ]);

  const response = expectOk(await transport.transceive(command), 'MUTUAL AUTHENTICATE');
  return completeMutualAuthenticate(keys, response, challenge, rndIc);
}

/**
 * Reads one file whole.
 *
 * Every exchange after authentication is wrapped: encrypted, authenticated, and
 * counted. The counter is why a captured exchange cannot be replayed, and why
 * losing track of it ends the session rather than corrupting it quietly.
 */
export async function readFile(
  transport: ChipTransport,
  session: SessionKeys,
  shortFileId: number,
): Promise<Buffer> {
  // SELECT by short file identifier.
  await secureTransceive(transport, session, Buffer.from([0x00, 0xa4, 0x02, 0x0c, 0x02, 0x01, shortFileId]));

  // The first few bytes give the length, so the rest can be asked for in one go.
  const head = await secureTransceive(
    transport,
    session,
    Buffer.from([0x00, 0xb0, 0x00, 0x00, 0x04]),
  );
  const total = lengthFromHeader(head);

  const chunks: Buffer[] = [head];
  let offset = head.length;
  // 0xDF keeps each response inside the 256-byte short-APDU limit with room
  // for the secure-messaging wrapper, which is what makes this work on chips
  // that do not support extended lengths.
  const chunk = 0xdf;
  while (offset < total) {
    const want = Math.min(chunk, total - offset);
    const read = await secureTransceive(
      transport,
      session,
      Buffer.from([0x00, 0xb0, (offset >> 8) & 0xff, offset & 0xff, want]),
    );
    if (read.length === 0) throw new Error('The chip stopped returning data before the file ended');
    chunks.push(read);
    offset += read.length;
  }

  return Buffer.concat(chunks).subarray(0, total);
}

/**
 * The total length of a DER file from its first bytes.
 *
 * Files are DER, so the length is in the header — reading until the chip stops
 * answering would work on some chips and hang on others.
 */
export function lengthFromHeader(head: Buffer): number {
  if (head.length < 2) throw new Error('The file header is too short to read a length from');
  const first = head[1]!;
  if (first < 0x80) return 2 + first;

  const byteCount = first & 0x7f;
  if (byteCount === 0 || head.length < 2 + byteCount) {
    throw new Error('The file uses a length encoding this reader does not handle');
  }
  let length = 0;
  for (let i = 0; i < byteCount; i++) length = length * 256 + head[2 + i]!;
  return 2 + byteCount + length;
}

// ---------------------------------------------------------------------------
// Secure messaging
// ---------------------------------------------------------------------------

/** Sends a wrapped command and returns the unwrapped data. */
export async function secureTransceive(
  transport: ChipTransport,
  session: SessionKeys,
  plain: Buffer,
): Promise<Buffer> {
  // The counter increments before the command and again before the response,
  // and both sides must agree. Mutating it here keeps the two in step for the
  // life of the session.
  session.ssc = incrementSsc(session.ssc);
  const wrapped = wrapCommand(session, plain);

  const response = await transport.transceive(wrapped);
  session.ssc = incrementSsc(session.ssc);
  return unwrapResponse(session, response);
}

export function wrapCommand(session: SessionKeys, plain: Buffer): Buffer {
  const header = Buffer.from(plain.subarray(0, 4));
  // The class byte marks the command as secure-messaged.
  header[0] = header[0]! | 0x0c;

  const lc = plain.length > 4 ? plain[4]! : 0;
  const hasData = plain.length > 5 + lc - 1 && lc > 0 && plain.length > 5;
  const body = hasData ? plain.subarray(5, 5 + lc) : Buffer.alloc(0);
  const le = hasData ? (plain.length > 5 + lc ? plain[5 + lc] : undefined) : lc || undefined;

  const parts: Buffer[] = [];
  if (body.length > 0) {
    const encrypted = Buffer.from(
      tripleDesCbcEncrypt(session.ksEnc, ZERO_IV, padIso9797Method2(body)),
    );
    // Tag 0x87, with a leading 0x01 marking ISO padding.
    parts.push(tlv(0x87, Buffer.concat([Buffer.from([0x01]), encrypted])));
  }
  if (le !== undefined) parts.push(tlv(0x97, Buffer.from([le])));

  const payload = Buffer.concat(parts);
  const authenticated = Buffer.concat([session.ssc, padIso9797Method2(header), payload]);
  const checksum = mac(session.ksMac, padIso9797Method2(authenticated).subarray(0, macLength(authenticated)));

  const data = Buffer.concat([payload, tlv(0x8e, checksum)]);
  return Buffer.concat([header, Buffer.from([data.length]), data, Buffer.from([0x00])]);
}

export function unwrapResponse(session: SessionKeys, response: Buffer): Buffer {
  if (response.length < 2) throw new Error('The chip returned nothing');
  const status = response.subarray(response.length - 2);
  const body = response.subarray(0, response.length - 2);

  const fields = parseTlv(body);
  const checksum = fields.get(0x8e);
  if (!checksum) throw new Error('The chip returned an unauthenticated response');

  // Everything before the checksum is what was authenticated.
  const upTo = body.length - (checksum.length + 2);
  const authenticated = Buffer.concat([session.ssc, body.subarray(0, upTo)]);
  const expected = mac(session.ksMac, padIso9797Method2(authenticated).subarray(0, macLength(authenticated)));
  if (!expected.equals(checksum)) {
    throw new Error('The response failed authentication; the session is no longer trustworthy');
  }

  if (!status.equals(Buffer.from([0x90, 0x00]))) {
    const sw = fields.get(0x99);
    throw new Error(`The chip refused the command: ${(sw ?? status).toString('hex')}`);
  }

  const encrypted = fields.get(0x87);
  if (!encrypted) return Buffer.alloc(0);

  const plain = Buffer.from(tripleDesCbcDecrypt(session.ksEnc, ZERO_IV, encrypted.subarray(1)));
  return unpadIso9797Method2(plain);
}

/** The MAC covers the padded data; this is how much of it. */
function macLength(authenticated: Buffer): number {
  return Math.ceil((authenticated.length + 1) / 8) * 8;
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag, value.length]), value]);
}

function parseTlv(buffer: Buffer): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  let i = 0;
  while (i + 2 <= buffer.length) {
    const tag = buffer[i]!;
    const length = buffer[i + 1]!;
    out.set(tag, buffer.subarray(i + 2, i + 2 + length));
    i += 2 + length;
  }
  return out;
}

function expectOk(response: Buffer, what: string): Buffer {
  if (response.length < 2) throw new Error(`${what}: the chip returned nothing`);
  const status = response.subarray(response.length - 2).toString('hex');
  if (status !== '9000') throw new Error(`${what} failed with status ${status}`);
  return response.subarray(0, response.length - 2);
}
