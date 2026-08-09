import { describe, expect, it } from 'vitest';
import {
  adjustParity,
  buildMutualAuthenticate,
  checkDigit,
  completeMutualAuthenticate,
  deriveBacKeys,
  mac,
  mrzInformation,
  padIso9797Method2,
} from '../src/bac.js';

/**
 * Basic Access Control, against ICAO's own published numbers.
 *
 * Every value below is taken from the worked example in Doc 9303 Part 11. That
 * matters more than it might sound: a cryptographic implementation can be
 * entirely self-consistent and entirely wrong, and the only way to tell from a
 * desk — with no passport and no reader — is to reproduce the standard's
 * intermediate values exactly. If these pass, the chip will talk to it; if
 * they do not, the chip answers "6300" and says nothing about why.
 */

// The example document: ERIKSSON, ANNA MARIA, Utopia.
const MRZ_INFO = 'L898902C<369080619406236';
const K_SEED = '239ab9cb282daf66231dc5a4df6bfbae';
const K_ENC = 'ab94fdecf2674fdfb9b391f85d7f76f2';
const K_MAC = '7962d9ece03d1acd4c76089dce131543';

const hex = (b: Buffer) => b.toString('hex');
const bin = (h: string) => Buffer.from(h, 'hex');

describe('assembling the key material from the printed page', () => {
  it('builds the MRZ information the standard uses', () => {
    expect(
      mrzInformation({
        documentNumber: 'L898902C<',
        dateOfBirth: '690806',
        dateOfExpiry: '940623',
      }),
    ).toBe(MRZ_INFO);
  });

  it('computes the check digits ICAO computes', () => {
    // From the same worked example.
    expect(checkDigit('L898902C<')).toBe('3');
    expect(checkDigit('690806')).toBe('1');
    expect(checkDigit('940623')).toBe('6');
    expect(checkDigit('D23145890734')).toBe('9');
  });
});

describe('deriving the access keys', () => {
  it('reproduces the published seed and both keys', () => {
    const keys = deriveBacKeys(MRZ_INFO);

    expect(hex(keys.kSeed)).toBe(K_SEED);
    expect(hex(keys.kEnc)).toBe(K_ENC);
    expect(hex(keys.kMac)).toBe(K_MAC);
  });

  it('gets there from the three printed fields as well', () => {
    const keys = deriveBacKeys({
      documentNumber: 'L898902C<',
      dateOfBirth: '690806',
      dateOfExpiry: '940623',
    });
    expect(hex(keys.kEnc)).toBe(K_ENC);
    expect(hex(keys.kMac)).toBe(K_MAC);
  });

  it('sets odd parity on every key byte', () => {
    // Specified, ignored by many implementations, and a key that differs in a
    // parity bit is a key that differs.
    const adjusted = adjustParity(bin('ab94fcedf2664edf'));
    expect(hex(adjusted)).toBe('ab94fdecf2674fdf');

    for (const byte of adjusted) {
      const ones = byte.toString(2).split('').filter((b) => b === '1').length;
      expect(ones % 2).toBe(1);
    }
  });
});

describe('message authentication', () => {
  it('pads the way ISO 9797-1 method 2 requires, always', () => {
    // The 0x80 is mandatory even when the data already fills a block; leaving
    // it out on an aligned message is a classic and silent mistake.
    expect(hex(padIso9797Method2(Buffer.alloc(8)))).toBe('00000000000000008000000000000000');
    expect(hex(padIso9797Method2(bin('01')))).toBe('0180000000000000');
  });

  it('produces the MAC from the worked example', () => {
    const eIfd = bin(
      '72c29c2371cc9bdb65b779b8e8d37b29ecc154aa56a8799fae2f498f76ed92f2',
    );
    expect(hex(mac(bin(K_MAC), eIfd))).toBe('5f1448eea8ad90a7');
  });
});

describe('the exchange that opens the chip', () => {
  // The randoms are the published ones, so the whole command can be checked
  // byte for byte rather than merely "looking plausible".
  const RND_IC = bin('4608f91988702212');
  const RND_IFD = bin('781723860c06c226');
  const K_IFD = bin('0b795240cb7049b01c19b33e32804f0b');

  it('builds the command data byte for byte', () => {
    const keys = deriveBacKeys(MRZ_INFO);
    const challenge = buildMutualAuthenticate(keys, RND_IC, RND_IFD, K_IFD);

    expect(hex(challenge.commandData)).toBe(
      '72c29c2371cc9bdb65b779b8e8d37b29ecc154aa56a8799fae2f498f76ed92f2' + '5f1448eea8ad90a7',
    );
  });

  it('rejects a reply whose authentication does not check out', () => {
    const keys = deriveBacKeys(MRZ_INFO);
    const challenge = buildMutualAuthenticate(keys, RND_IC, RND_IFD, K_IFD);

    // A chip that cannot produce a valid MAC does not hold these keys, which
    // means it is not this passport.
    const rubbish = Buffer.concat([Buffer.alloc(32, 0xaa), Buffer.alloc(8, 0xbb)]);
    expect(() => completeMutualAuthenticate(keys, rubbish, challenge, RND_IC)).toThrow(
      /failed authentication/,
    );
  });

  it('rejects a reply that does not echo our own challenge', () => {
    const keys = deriveBacKeys(MRZ_INFO);
    const challenge = buildMutualAuthenticate(keys, RND_IC, RND_IFD, K_IFD);

    // Build a well-formed response that echoes the wrong random — which is what
    // a replay of an earlier session looks like.
    const { createCipheriv } = require('node:crypto') as typeof import('node:crypto');
    const wrong = Buffer.concat([RND_IC, Buffer.alloc(8, 0x11), Buffer.alloc(16, 0x22)]);
    const cipher = createCipheriv(
      'des-ede3-cbc',
      Buffer.concat([keys.kEnc, keys.kEnc.subarray(0, 8)]),
      Buffer.alloc(8),
    );
    cipher.setAutoPadding(false);
    const eIc = Buffer.concat([cipher.update(wrong), cipher.final()]);
    const response = Buffer.concat([eIc, mac(keys.kMac, eIc)]);

    expect(() => completeMutualAuthenticate(keys, response, challenge, RND_IC)).toThrow(
      /did not echo our challenge/,
    );
  });

  it('derives session keys and a counter from a well-formed reply', () => {
    const keys = deriveBacKeys(MRZ_INFO);
    const challenge = buildMutualAuthenticate(keys, RND_IC, RND_IFD, K_IFD);

    const kIc = Buffer.alloc(16, 0x33);
    const { createCipheriv } = require('node:crypto') as typeof import('node:crypto');
    const plain = Buffer.concat([RND_IC, RND_IFD, kIc]);
    const cipher = createCipheriv(
      'des-ede3-cbc',
      Buffer.concat([keys.kEnc, keys.kEnc.subarray(0, 8)]),
      Buffer.alloc(8),
    );
    cipher.setAutoPadding(false);
    const eIc = Buffer.concat([cipher.update(plain), cipher.final()]);
    const response = Buffer.concat([eIc, mac(keys.kMac, eIc)]);

    const session = completeMutualAuthenticate(keys, response, challenge, RND_IC);

    expect(session.ksEnc).toHaveLength(16);
    expect(session.ksMac).toHaveLength(16);
    // The counter is the low half of each random, in that order.
    expect(hex(session.ssc)).toBe('887022120c06c226');
  });
});
