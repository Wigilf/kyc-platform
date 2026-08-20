/**
 * SHA-1, in plain JavaScript.
 *
 * Here for the same reason as the cipher next door: the phone has no crypto
 * module to borrow one from, and this is the digest ICAO's key derivation
 * specifies. Broken for signatures and perfectly sound for deriving a key from
 * a shared secret, which is all it does here.
 *
 * Checked against Node's own implementation across random inputs in the tests.
 */
export function sha1(data: Uint8Array): Uint8Array {
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];

  // Append a 1 bit, pad with zeroes, then the length in bits as 64 bits.
  const length = data.length;
  const withPadding = new Uint8Array((((length + 8) >> 6) + 1) * 64);
  withPadding.set(data);
  withPadding[length] = 0x80;
  const bits = length * 8;
  // Lengths beyond 2^32 bits cannot occur here; the high word stays zero.
  new DataView(withPadding.buffer).setUint32(withPadding.length - 4, bits >>> 0, false);
  new DataView(withPadding.buffer).setUint32(withPadding.length - 8, Math.floor(bits / 2 ** 32), false);

  const w = new Int32Array(80);
  const view = new DataView(withPadding.buffer);

  for (let offset = 0; offset < withPadding.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4, false);
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    }

    let [a, b, c, d, e] = h as [number, number, number, number, number];
    for (let i = 0; i < 80; i++) {
      const [f, k] =
        i < 20
          ? [(b & c) | (~b & d), 0x5a827999]
          : i < 40
            ? [b ^ c ^ d, 0x6ed9eba1]
            : i < 60
              ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
              : [b ^ c ^ d, 0xca62c1d6];

      const temp = (rotl(a, 5) + f + e + k + w[i]!) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h[0] = (h[0]! + a) | 0;
    h[1] = (h[1]! + b) | 0;
    h[2] = (h[2]! + c) | 0;
    h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 5; i++) outView.setInt32(i * 4, h[i]!, false);
  return out;
}

function rotl(value: number, by: number): number {
  return ((value << by) | (value >>> (32 - by))) | 0;
}

/**
 * Random bytes, from whichever platform this is running on.
 *
 * `globalThis.crypto` is present in Node and in React Native once the standard
 * polyfill is installed, which keeps one code path for both. It throws rather
 * than falling back to `Math.random`, because a predictable challenge would
 * quietly turn mutual authentication into a formality.
 */
export function randomBytes(length: number): Uint8Array {
  const source = globalThis.crypto;
  if (!source?.getRandomValues) {
    throw new Error(
      'No secure random source. On React Native, import "react-native-get-random-values" ' +
        'before this module.',
    );
  }
  return source.getRandomValues(new Uint8Array(length));
}
