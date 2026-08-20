import { createHash, randomBytes as nodeRandom } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { randomBytes, sha1 } from '../src/crypto/sha1.js';

/**
 * The digest, checked against the one in the standard library.
 *
 * Same argument as the cipher: written out because the phone has no crypto
 * module, and defensible only because it is checked against an implementation
 * nobody doubts, across inputs of every length that matters — including the
 * boundaries where padding overflows into another block, which is where
 * hand-written digests go wrong.
 */

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const node = (b: Uint8Array) => createHash('sha1').update(Buffer.from(b)).digest('hex');

describe('against the published values', () => {
  it('matches the classic vectors', () => {
    expect(hex(sha1(new Uint8Array(0)))).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(hex(sha1(Buffer.from('abc')))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(hex(sha1(Buffer.from('The quick brown fox jumps over the lazy dog')))).toBe(
      '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12',
    );
  });
});

describe('against the standard library', () => {
  it('agrees at every length around the block boundaries', () => {
    // 55/56/64 and 119/120/128 are where the length field forces another
    // block. A digest that is wrong is usually wrong exactly here.
    for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129]) {
      const data = nodeRandom(length);
      expect(hex(sha1(data))).toBe(node(data));
    }
  });

  it('agrees on a thousand random inputs', () => {
    for (let i = 0; i < 1000; i++) {
      const data = nodeRandom(Math.floor(Math.random() * 300));
      expect(hex(sha1(data))).toBe(node(data));
    }
  }, 60_000);
});

describe('randomness', () => {
  it('produces the requested length, and not the same twice', () => {
    const a = randomBytes(16);
    const b = randomBytes(16);
    expect(a).toHaveLength(16);
    expect(hex(a)).not.toBe(hex(b));
  });
});
