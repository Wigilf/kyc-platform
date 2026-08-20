import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  desBlock,
  tripleDesBlock,
  tripleDesCbcDecrypt,
  tripleDesCbcEncrypt,
} from '../src/crypto/des.js';

/**
 * A hand-written cipher, checked against one nobody doubts.
 *
 * Writing DES out is normally a bad idea; it is defensible here only because
 * the claim is falsifiable. These run thousands of random keys and messages
 * through both this implementation and OpenSSL and require identical output.
 * Agreement across that many independent inputs is not "probably right" — a
 * single wrong entry in any of the fourteen tables would break within a
 * handful of cases.
 *
 * The reason it exists at all: a passport chip speaks 3DES, Node's default
 * provider has dropped single DES, and React Native has no crypto module. The
 * phone needs an implementation that is proven, not one that is merely present.
 */

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('against the published test vectors', () => {
  it('matches the FIPS known-answer values', () => {
    // The classic vectors: all-zero key and plaintext, and the "now is the
    // time" example from the original specification.
    expect(hex(desBlock(Buffer.alloc(8), Buffer.alloc(8)))).toBe('8ca64de9c1b123a7');
    expect(
      hex(desBlock(Buffer.from('0123456789abcdef', 'hex'), Buffer.from('4e6f772069732074', 'hex'))),
    ).toBe('3fa40e8a984d4815');
  });

  it('decrypts back to where it started', () => {
    const key = Buffer.from('133457799bbcdff1', 'hex');
    const plain = Buffer.from('0123456789abcdef', 'hex');
    const encrypted = desBlock(key, plain);
    expect(hex(encrypted)).toBe('85e813540f0ab405');
    expect(hex(desBlock(key, encrypted, true))).toBe(hex(plain));
  });
});

describe('against OpenSSL', () => {
  /** OpenSSL still has 3DES, which is what makes this comparison possible. */
  const openssl = (key: Buffer, iv: Buffer, data: Buffer, decrypt: boolean) => {
    const full = key.length === 24 ? key : Buffer.concat([key, key.subarray(0, 8)]);
    const cipher = decrypt
      ? createDecipheriv('des-ede3-cbc', full, iv)
      : createCipheriv('des-ede3-cbc', full, iv);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(data), cipher.final()]);
  };

  it('agrees on two thousand random single blocks', () => {
    for (let i = 0; i < 2000; i++) {
      const key = randomBytes(16);
      const block = randomBytes(8);
      expect(hex(tripleDesBlock(key, block))).toBe(
        hex(openssl(key, Buffer.alloc(8), block, false)),
      );
    }
  }, 120_000);

  it('agrees on random multi-block CBC, in both directions', () => {
    for (let i = 0; i < 400; i++) {
      const key = randomBytes(16);
      const iv = randomBytes(8);
      const data = randomBytes(8 * (1 + (i % 12)));

      const mine = tripleDesCbcEncrypt(key, iv, data);
      expect(hex(mine)).toBe(hex(openssl(key, iv, data, false)));
      // And back again, which catches an encryptor and decryptor that are
      // wrong in the same way.
      expect(hex(tripleDesCbcDecrypt(key, iv, Buffer.from(mine)))).toBe(hex(data));
    }
  }, 120_000);

  it('agrees when a three-key bundle is used', () => {
    for (let i = 0; i < 200; i++) {
      const key = randomBytes(24);
      const iv = randomBytes(8);
      const data = randomBytes(24);
      expect(hex(tripleDesCbcEncrypt(key, iv, data))).toBe(hex(openssl(key, iv, data, false)));
    }
  }, 60_000);
});

describe('refusing what it cannot do', () => {
  it('rejects a wrong-sized key or block rather than truncating', () => {
    expect(() => desBlock(Buffer.alloc(7), Buffer.alloc(8))).toThrow();
    expect(() => desBlock(Buffer.alloc(8), Buffer.alloc(9))).toThrow();
    expect(() => tripleDesBlock(Buffer.alloc(20), Buffer.alloc(8))).toThrow();
  });

  it('rejects CBC input that is not whole blocks, rather than padding it', () => {
    // ICAO applies its own padding. Silently adding more would corrupt every
    // message, and doing it inside a cipher is where that mistake hides.
    expect(() => tripleDesCbcEncrypt(Buffer.alloc(16), Buffer.alloc(8), Buffer.alloc(9))).toThrow();
  });
});
