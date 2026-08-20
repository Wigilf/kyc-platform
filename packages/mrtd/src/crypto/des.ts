/**
 * DES and triple DES, in plain JavaScript.
 *
 * Written out because the phone has nowhere to borrow it from. A passport chip
 * speaks 3DES and nothing else; Node's default provider has dropped single DES
 * and React Native has no crypto module at all, so the alternatives were a
 * native dependency on every platform or this.
 *
 * Hand-rolling a cipher is normally a bad idea, and it is defensible here for
 * one reason: it is checkable. DES is a fixed function with published test
 * vectors, and the tests alongside this also run thousands of random inputs
 * through both this and OpenSSL and require the answers to be identical. An
 * implementation that agrees with OpenSSL everywhere is not "probably right".
 *
 * Written with bit arrays rather than packed integers. It is slower and it is
 * far easier to check against the tables in the standard, which is the correct
 * trade for something run a handful of times per passport.
 */

// --- Tables, FIPS 46-3 -----------------------------------------------------

const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];

const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];

const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];

const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];

const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
  10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
  14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];

const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];

const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

const S = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7, 0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8, 4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0, 15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10, 3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5, 0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15, 13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8, 13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1, 13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7, 1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15, 13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9, 10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4, 3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9, 14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6, 4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14, 11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11, 10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8, 9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6, 4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1, 13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6, 1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2, 6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7, 1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2, 7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8, 2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
];

// --- Bits ------------------------------------------------------------------

function toBits(bytes: Uint8Array): Uint8Array {
  const bits = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (bytes[i]! >> (7 - b)) & 1;
  }
  return bits;
}

function toBytes(bits: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bytes.length; i++) {
    let value = 0;
    for (let b = 0; b < 8; b++) value = (value << 1) | bits[i * 8 + b]!;
    bytes[i] = value;
  }
  return bytes;
}

/** Applies a permutation table, whose entries are 1-based positions. */
function permute(bits: Uint8Array, table: readonly number[]): Uint8Array {
  const out = new Uint8Array(table.length);
  for (let i = 0; i < table.length; i++) out[i] = bits[table[i]! - 1]!;
  return out;
}

function rotate(bits: Uint8Array, by: number): Uint8Array {
  const out = new Uint8Array(bits.length);
  for (let i = 0; i < bits.length; i++) out[i] = bits[(i + by) % bits.length]!;
  return out;
}

// --- The cipher ------------------------------------------------------------

/** The sixteen round keys, in encryption order. */
function schedule(key: Uint8Array): Uint8Array[] {
  const permuted = permute(toBits(key), PC1);
  let c = permuted.subarray(0, 28);
  let d = permuted.subarray(28, 56);

  const keys: Uint8Array[] = [];
  for (const shift of SHIFTS) {
    c = rotate(c, shift);
    d = rotate(d, shift);
    const merged = new Uint8Array(56);
    merged.set(c, 0);
    merged.set(d, 28);
    keys.push(permute(merged, PC2));
  }
  return keys;
}

/** The Feistel function: expand, mix in the round key, substitute, permute. */
function feistel(right: Uint8Array, roundKey: Uint8Array): Uint8Array {
  const expanded = permute(right, E);
  for (let i = 0; i < 48; i++) expanded[i] = expanded[i]! ^ roundKey[i]!;

  const substituted = new Uint8Array(32);
  for (let box = 0; box < 8; box++) {
    const o = box * 6;
    // Outer bits pick the row, the middle four pick the column.
    const row = (expanded[o]! << 1) | expanded[o + 5]!;
    const column =
      (expanded[o + 1]! << 3) | (expanded[o + 2]! << 2) | (expanded[o + 3]! << 1) | expanded[o + 4]!;
    const value = S[box]![row * 16 + column]!;
    for (let b = 0; b < 4; b++) substituted[box * 4 + b] = (value >> (3 - b)) & 1;
  }
  return permute(substituted, P);
}

function crypt(block: Uint8Array, roundKeys: Uint8Array[], decrypt: boolean): Uint8Array {
  const permuted = permute(toBits(block), IP);
  let left: Uint8Array = new Uint8Array(permuted.subarray(0, 32));
  let right: Uint8Array = new Uint8Array(permuted.subarray(32, 64));

  for (let round = 0; round < 16; round++) {
    const key = roundKeys[decrypt ? 15 - round : round]!;
    const mixed = feistel(right, key);
    for (let i = 0; i < 32; i++) mixed[i] = mixed[i]! ^ left[i]!;
    left = right;
    right = mixed;
  }

  // The halves are swapped once more before the final permutation.
  const merged = new Uint8Array(64);
  merged.set(right, 0);
  merged.set(left, 32);
  return toBytes(permute(merged, FP));
}

/** One 8-byte block under one 8-byte key. */
export function desBlock(key: Uint8Array, block: Uint8Array, decrypt = false): Uint8Array {
  if (key.length !== 8) throw new Error('A DES key is 8 bytes');
  if (block.length !== 8) throw new Error('A DES block is 8 bytes');
  return crypt(block, schedule(key), decrypt);
}

/**
 * Triple DES, encrypt-decrypt-encrypt.
 *
 * Accepts 8, 16 or 24 bytes: a single key is repeated, and two keys use the
 * first again as the third, which is what ICAO's two-key form means.
 */
export function tripleDesBlock(key: Uint8Array, block: Uint8Array, decrypt = false): Uint8Array {
  const [k1, k2, k3] = splitKey(key);
  return decrypt
    ? desBlock(k1, desBlock(k2, desBlock(k3, block, true), false), true)
    : desBlock(k3, desBlock(k2, desBlock(k1, block, false), true), false);
}

function splitKey(key: Uint8Array): [Uint8Array, Uint8Array, Uint8Array] {
  if (key.length === 8) return [key, key, key];
  if (key.length === 16) return [key.subarray(0, 8), key.subarray(8, 16), key.subarray(0, 8)];
  if (key.length === 24) return [key.subarray(0, 8), key.subarray(8, 16), key.subarray(16, 24)];
  throw new Error('A 3DES key is 8, 16 or 24 bytes');
}

// --- CBC -------------------------------------------------------------------

/** No padding, deliberately: ICAO does its own, and adding more corrupts it. */
export function tripleDesCbcEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
): Uint8Array {
  if (data.length % 8 !== 0) throw new Error('CBC input must be a whole number of blocks');
  const out = new Uint8Array(data.length);
  let previous = iv;

  for (let offset = 0; offset < data.length; offset += 8) {
    // A copy, explicitly. `Buffer.prototype.slice` returns a *view* rather than
    // a copy — it is an alias for `subarray` — so XORing in place here silently
    // rewrote the caller's plaintext and corrupted every block after the first.
    const block = new Uint8Array(data.subarray(offset, offset + 8));
    for (let i = 0; i < 8; i++) block[i] = block[i]! ^ previous[i]!;
    const encrypted = tripleDesBlock(key, block, false);
    out.set(encrypted, offset);
    previous = encrypted;
  }
  return out;
}

export function tripleDesCbcDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
): Uint8Array {
  if (data.length % 8 !== 0) throw new Error('CBC input must be a whole number of blocks');
  const out = new Uint8Array(data.length);
  let previous = iv;

  for (let offset = 0; offset < data.length; offset += 8) {
    const block = data.subarray(offset, offset + 8);
    const decrypted = tripleDesBlock(key, block, true);
    for (let i = 0; i < 8; i++) decrypted[i] = decrypted[i]! ^ previous[i]!;
    out.set(decrypted, offset);
    previous = block;
  }
  return out;
}
