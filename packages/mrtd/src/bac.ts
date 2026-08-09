import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Basic Access Control — the conversation that opens a passport chip.
 *
 * A chip will not answer until the reader proves it is physically holding the
 * document, which it does by deriving keys from the machine-readable zone.
 * That is the point of BAC: the printed page is the shared secret, so a chip
 * cannot be read from a pocket or across a room.
 *
 * This lives in its own package because it is the part of chip reading that can
 * be *proved*. The NFC transport needs a phone and a real passport; the
 * cryptography does not — ICAO publishes worked examples with every
 * intermediate value, and the tests here check against them. An implementation
 * that agrees with itself is worth nothing; one that agrees with the standard's
 * own numbers is worth something.
 *
 * Deliberately not the newer PACE protocol. BAC is what every ICAO-compliant
 * passport in circulation supports, it is what these published vectors cover,
 * and a chip that requires PACE will say so — at which point this refuses
 * rather than guessing.
 *
 * The algorithms, from ICAO 9303 Part 11:
 *   - Keys are 3DES two-key, derived from a SHA-1 of the MRZ information.
 *   - Message authentication is ISO 9797-1 MAC Algorithm 3 with padding
 *     method 2 — DES-CBC across the whole message, then a final decrypt and
 *     re-encrypt with the second key half.
 */

/** Two-key 3DES: encryption and authentication halves. */
export interface BacKeys {
  kEnc: Buffer;
  kMac: Buffer;
  /** Retained for tests and diagnostics; it is not used after derivation. */
  kSeed: Buffer;
}

/**
 * The three fields from the machine-readable zone that unlock the chip, each
 * followed by its check digit.
 */
export interface MrzKeyInput {
  /** As printed, including any `<` padding. */
  documentNumber: string;
  /** YYMMDD. */
  dateOfBirth: string;
  /** YYMMDD. */
  dateOfExpiry: string;
}

/**
 * The key seed material: document number, birth date and expiry, each with the
 * check digit ICAO computes over it.
 *
 * Assembled here rather than taken as a string because getting it wrong yields
 * keys that simply do not work, with a chip that answers "6300" and no clue as
 * to which of the three fields was mistyped.
 */
export function mrzInformation(input: MrzKeyInput): string {
  const number = input.documentNumber.toUpperCase().padEnd(9, '<');
  return (
    number +
    checkDigit(number) +
    input.dateOfBirth +
    checkDigit(input.dateOfBirth) +
    input.dateOfExpiry +
    checkDigit(input.dateOfExpiry)
  );
}

/** ICAO 9303 check digit: weighted mod-10 over repeating 7-3-1 weights. */
export function checkDigit(input: string): string {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    const value =
      c >= '0' && c <= '9'
        ? c.charCodeAt(0) - 48
        : c >= 'A' && c <= 'Z'
          ? c.charCodeAt(0) - 55
          : 0; // '<' and anything unexpected contribute nothing.
    sum += value * weights[i % 3]!;
  }
  return String(sum % 10);
}

/**
 * Derives the two access keys from the machine-readable zone.
 *
 * SHA-1 of the MRZ information, truncated to 16 bytes, is the seed; each key is
 * then SHA-1 of the seed with a counter appended, truncated and parity-adjusted.
 */
export function deriveBacKeys(input: MrzKeyInput | string): BacKeys {
  const information = typeof input === 'string' ? input : mrzInformation(input);
  const kSeed = createHash('sha1').update(information, 'latin1').digest().subarray(0, 16);
  return {
    kSeed,
    kEnc: deriveKey(kSeed, 1),
    kMac: deriveKey(kSeed, 2),
  };
}

/** ICAO's key derivation: SHA-1 over seed ‖ counter, halved and parity-fixed. */
export function deriveKey(kSeed: Buffer, counter: 1 | 2): Buffer {
  const c = Buffer.alloc(4);
  c.writeUInt32BE(counter);
  const digest = createHash('sha1').update(Buffer.concat([kSeed, c])).digest();
  return Buffer.concat([adjustParity(digest.subarray(0, 8)), adjustParity(digest.subarray(8, 16))]);
}

/**
 * DES keys carry an odd-parity bit in each byte.
 *
 * Ignored by most implementations and specified by ICAO, so it is applied: a
 * key that differs from the chip's in a parity bit is a key that differs.
 */
export function adjustParity(key: Buffer): Buffer {
  const out = Buffer.from(key);
  for (let i = 0; i < out.length; i++) {
    let byte = out[i]!;
    // Count the bits in the top seven; the low bit makes the total odd.
    let ones = 0;
    for (let bit = 1; bit < 8; bit++) if ((byte >> bit) & 1) ones++;
    byte = ones % 2 === 0 ? byte | 1 : byte & 0xfe;
    out[i] = byte;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Message authentication
// ---------------------------------------------------------------------------

/**
 * ISO 9797-1 MAC Algorithm 3, which ICAO uses throughout.
 *
 * Single-DES CBC across the message under the first key half, then the final
 * block is decrypted with the second half and re-encrypted with the first. Not
 * the same as a 3DES CBC-MAC, and implementing it as one produces a MAC the
 * chip rejects with no explanation.
 */
export function mac(key: Buffer, data: Buffer): Buffer {
  const ka = key.subarray(0, 8);
  const kb = key.subarray(8, 16);
  const padded = padIso9797Method2(data);

  const encrypted = desCbcEncrypt(ka, padded);
  const last = encrypted.subarray(encrypted.length - 8);
  return desEcbEncrypt(ka, desEcbDecrypt(kb, last));
}

/**
 * Single DES, expressed as triple DES with one key.
 *
 * Node's default OpenSSL provider dropped single DES — `des-cbc` and `des-ecb`
 * now throw "unsupported" — while triple DES remains. Since 3DES is
 * encrypt-decrypt-encrypt, giving it the same key three times cancels the
 * middle step and leaves exactly single DES. That avoids either shipping a
 * hand-rolled DES or asking every deployment to start Node with a legacy flag.
 *
 * The published test vectors are what prove the equivalence holds in practice
 * rather than only on paper.
 */
function tripled(key: Buffer): Buffer {
  return Buffer.concat([key, key, key]);
}

function desCbcEncrypt(key: Buffer, data: Buffer): Buffer {
  const cipher = createCipheriv('des-ede3-cbc', tripled(key), Buffer.alloc(8));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function desEcbEncrypt(key: Buffer, block: Buffer): Buffer {
  // ECB over one block is CBC with a zero IV over one block.
  return desCbcEncrypt(key, block);
}

function desEcbDecrypt(key: Buffer, block: Buffer): Buffer {
  const decipher = createDecipheriv('des-ede3-cbc', tripled(key), Buffer.alloc(8));
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(block), decipher.final()]);
}

/** A mandatory 0x80 then zeroes to the block boundary — always added. */
export function padIso9797Method2(data: Buffer): Buffer {
  const padLength = 8 - (data.length % 8);
  return Buffer.concat([data, Buffer.from([0x80]), Buffer.alloc(padLength - 1)]);
}

export function unpadIso9797Method2(data: Buffer): Buffer {
  let end = data.length - 1;
  while (end >= 0 && data[end] === 0x00) end--;
  if (end < 0 || data[end] !== 0x80) throw new Error('Padding is not ISO 9797-1 method 2');
  return data.subarray(0, end);
}

// ---------------------------------------------------------------------------
// Mutual authentication
// ---------------------------------------------------------------------------

export interface MutualAuthChallenge {
  /** The 40 bytes sent to the chip as the MUTUAL AUTHENTICATE command data. */
  commandData: Buffer;
  rndIfd: Buffer;
  kIfd: Buffer;
}

/**
 * Builds the reader's half of the exchange.
 *
 * The chip has already supplied its own random. The reader answers with its
 * random and its key material, encrypted and authenticated with the keys
 * derived from the printed page — which is how it proves it holds the document.
 *
 * The randoms are parameters rather than generated inside, so the published
 * worked example can be reproduced exactly. Left out, they are generated.
 */
export function buildMutualAuthenticate(
  keys: BacKeys,
  rndIc: Buffer,
  rndIfd: Buffer = randomBytes(8),
  kIfd: Buffer = randomBytes(16),
): MutualAuthChallenge {
  if (rndIc.length !== 8) throw new Error("The chip's random must be 8 bytes");

  const s = Buffer.concat([rndIfd, rndIc, kIfd]);
  const cipher = createCipheriv('des-ede3-cbc', expand3des(keys.kEnc), Buffer.alloc(8));
  cipher.setAutoPadding(false);
  const eIfd = Buffer.concat([cipher.update(s), cipher.final()]);
  const mIfd = mac(keys.kMac, eIfd);

  return { commandData: Buffer.concat([eIfd, mIfd]), rndIfd, kIfd };
}

export interface SessionKeys {
  ksEnc: Buffer;
  ksMac: Buffer;
  /** Send sequence counter, the first eight bytes of every subsequent MAC. */
  ssc: Buffer;
}

/**
 * Verifies the chip's answer and derives the session keys.
 *
 * Throws rather than returning a flag: a mutual authentication that did not
 * authenticate has no usable result, and a caller that forgets to check a
 * boolean would go on to read a chip it has not proved anything about.
 */
export function completeMutualAuthenticate(
  keys: BacKeys,
  response: Buffer,
  challenge: MutualAuthChallenge,
  rndIc: Buffer,
): SessionKeys {
  if (response.length < 40) throw new Error('The chip returned too short a response');

  const eIc = response.subarray(0, 32);
  const mIc = response.subarray(32, 40);
  if (!mac(keys.kMac, eIc).equals(mIc)) {
    throw new Error("The chip's response failed authentication; the keys do not match");
  }

  const decipher = createDecipheriv('des-ede3-cbc', expand3des(keys.kEnc), Buffer.alloc(8));
  decipher.setAutoPadding(false);
  const r = Buffer.concat([decipher.update(eIc), decipher.final()]);

  // The chip echoes our random back. If it does not, something is replaying.
  if (!r.subarray(8, 16).equals(challenge.rndIfd)) {
    throw new Error('The chip did not echo our challenge; this is not a live exchange');
  }
  if (!r.subarray(0, 8).equals(rndIc)) {
    throw new Error('The chip did not echo its own challenge');
  }

  const kIc = r.subarray(16, 32);
  const seed = xor(challenge.kIfd, kIc);

  return {
    ksEnc: deriveKey(seed, 1),
    ksMac: deriveKey(seed, 2),
    // The counter starts as the low halves of both randoms, and increments
    // before every message thereafter.
    ssc: Buffer.concat([rndIc.subarray(4, 8), challenge.rndIfd.subarray(4, 8)]),
  };
}

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(Math.min(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

/** Node wants a 24-byte key for two-key 3DES; ICAO specifies 16. */
export function expand3des(key: Buffer): Buffer {
  return key.length === 24 ? key : Buffer.concat([key, key.subarray(0, 8)]);
}

/** Adds one to the send sequence counter, big-endian, in place of a bigint. */
export function incrementSsc(ssc: Buffer): Buffer {
  const out = Buffer.from(ssc);
  for (let i = out.length - 1; i >= 0; i--) {
    out[i] = (out[i]! + 1) & 0xff;
    if (out[i] !== 0) break;
  }
  return out;
}
