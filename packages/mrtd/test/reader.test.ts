import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveBacKeys, lengthFromHeader, openSession, readPassport } from '../src/index.js';
import { SimulatedChip } from './simulated-chip.js';

/**
 * The whole conversation, against a chip that implements the other half.
 *
 * The reader and the simulated chip were written from the same standard but
 * not from each other, so their agreeing is evidence rather than tautology.
 * What this cannot prove is that a real chip behaves as specified — that needs
 * a phone and a passport. What it does prove is everything above the radio:
 * key agreement, secure messaging, the send counter, chunked file reads, and
 * what happens when any of it goes wrong.
 */

const MRZ = { documentNumber: 'L898902C<', dateOfBirth: '690806', dateOfExpiry: '940623' };

/** A DER file of a given size, so the length header is real. */
function derFile(size: number): Buffer {
  const body = randomBytes(size);
  const header = Buffer.from([0x60, 0x82, (size >> 8) & 0xff, size & 0xff]);
  return Buffer.concat([header, body]);
}

const files = () => ({
  0x01: derFile(88), // DG1, a machine-readable zone
  0x02: derFile(2400), // DG2, a portrait — several reads' worth
  0x1d: derFile(1100), // EF.SOD
});

describe('opening the chip', () => {
  it('agrees a session from the printed page alone', async () => {
    const chip = new SimulatedChip(MRZ, files());
    const session = await openSession(chip, deriveBacKeys(MRZ));

    expect(session.ksEnc).toHaveLength(16);
    expect(session.ksMac).toHaveLength(16);
    expect(session.ssc).toHaveLength(8);
  });

  it('refuses when the printed details are wrong', async () => {
    const chip = new SimulatedChip(MRZ, files());
    // One digit out in the date of birth — a mistyped form, or a chip that is
    // not the document in the reader's hand.
    const wrong = { ...MRZ, dateOfBirth: '690807' };

    await expect(openSession(chip, deriveBacKeys(wrong))).rejects.toThrow();
  });
});

describe('reading it', () => {
  it('returns the data groups and the security object intact', async () => {
    const contents = files();
    const chip = new SimulatedChip(MRZ, contents);

    const read = await readPassport(chip, MRZ);

    expect(read.dataGroups.DG1!.equals(contents[0x01])).toBe(true);
    // Larger than one exchange, so this is the chunked path.
    expect(read.dataGroups.DG2!.equals(contents[0x02])).toBe(true);
    expect(read.sod.equals(contents[0x1d])).toBe(true);
  });

  it('reads a file that spans many exchanges without losing a byte', async () => {
    const contents = { ...files(), 0x02: derFile(20_000) };
    const chip = new SimulatedChip(MRZ, contents);

    const read = await readPassport(chip, MRZ);

    expect(read.dataGroups.DG2).toHaveLength(20_004);
    expect(read.dataGroups.DG2!.equals(contents[0x02])).toBe(true);
  });

  it('stops rather than continuing when a response fails authentication', async () => {
    const chip = new SimulatedChip(MRZ, files());
    const keys = deriveBacKeys(MRZ);
    await openSession(chip, keys);

    chip.corruptNextResponse = true;

    // A response whose checksum does not verify means the session is no longer
    // trustworthy. Carrying on and returning the bytes anyway would hand back
    // data nobody has authenticated.
    await expect(readPassport(chip, MRZ)).rejects.toThrow(/failed authentication|refused/);
  });
});

describe('reading a file length', () => {
  it('handles short and long form headers', () => {
    expect(lengthFromHeader(Buffer.from([0x60, 0x20]))).toBe(0x22);
    expect(lengthFromHeader(Buffer.from([0x60, 0x81, 0x90]))).toBe(3 + 0x90);
    expect(lengthFromHeader(Buffer.from([0x60, 0x82, 0x09, 0x60]))).toBe(4 + 0x0960);
  });

  it('refuses a header it cannot read rather than guessing a length', () => {
    // Reading until the chip stops answering works on some chips and hangs on
    // others, so an unreadable length is an error, not a reason to improvise.
    expect(() => lengthFromHeader(Buffer.from([0x60]))).toThrow();
    expect(() => lengthFromHeader(Buffer.from([0x60, 0x84, 0x01]))).toThrow();
  });
});
