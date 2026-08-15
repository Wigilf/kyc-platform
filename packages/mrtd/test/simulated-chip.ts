import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  deriveBacKeys,
  deriveKey,
  expand3des,
  incrementSsc,
  mac,
  padIso9797Method2,
  unpadIso9797Method2,
  type ChipTransport,
  type MrzKeyInput,
} from '../src/index.js';

/**
 * A passport chip, in memory.
 *
 * It implements the chip's side of the same standard the reader implements —
 * independently, so agreement between them means something. The reader could
 * be tested against a recording of a real chip, but a recording cannot be
 * asked a question it was not asked before; this can, which is how the
 * multi-chunk reads and the failure paths get covered.
 *
 * It is not a security model. It exists to answer correctly, and to be able to
 * answer wrongly on request.
 */
export class SimulatedChip implements ChipTransport {
  private ksEnc: Buffer | null = null;
  private ksMac: Buffer | null = null;
  private ssc: Buffer = Buffer.alloc(8);
  private rndIc: Buffer = Buffer.alloc(8);
  private selected: number | null = null;

  /** Set to have the chip mangle its next response, as a broken one would. */
  corruptNextResponse = false;

  constructor(
    private readonly mrz: MrzKeyInput,
    private readonly files: Record<number, Buffer>,
  ) {}

  async transceive(command: Buffer): Promise<Buffer> {
    const ins = command[1]!;

    if (ins === 0x84) {
      this.rndIc = randomBytes(8);
      return Buffer.concat([this.rndIc, ok()]);
    }
    if (ins === 0x82) return this.mutualAuthenticate(command);
    return this.secure(command);
  }

  private mutualAuthenticate(command: Buffer): Buffer {
    const keys = deriveBacKeys(this.mrz);
    const data = command.subarray(5, 5 + command[4]!);
    const eIfd = data.subarray(0, 32);
    const mIfd = data.subarray(32, 40);

    if (!mac(keys.kMac, eIfd).equals(mIfd)) return Buffer.from([0x63, 0x00]);

    const decipher = createDecipheriv('des-ede3-cbc', expand3des(keys.kEnc), Buffer.alloc(8));
    decipher.setAutoPadding(false);
    const s = Buffer.concat([decipher.update(eIfd), decipher.final()]);
    const rndIfd = s.subarray(0, 8);
    const kIfd = s.subarray(16, 32);

    const kIc = randomBytes(16);
    const r = Buffer.concat([this.rndIc, rndIfd, kIc]);
    const cipher = createCipheriv('des-ede3-cbc', expand3des(keys.kEnc), Buffer.alloc(8));
    cipher.setAutoPadding(false);
    const eIc = Buffer.concat([cipher.update(r), cipher.final()]);

    const seed = xor(kIfd, kIc);
    this.ksEnc = deriveKey(seed, 1);
    this.ksMac = deriveKey(seed, 2);
    this.ssc = Buffer.concat([this.rndIc.subarray(4, 8), rndIfd.subarray(4, 8)]);

    return Buffer.concat([eIc, mac(keys.kMac, eIc), ok()]);
  }

  private secure(command: Buffer): Buffer {
    if (!this.ksEnc || !this.ksMac) return Buffer.from([0x69, 0x82]);

    this.ssc = incrementSsc(this.ssc);
    const plain = this.unwrap(command);
    const response = this.handle(plain);
    this.ssc = incrementSsc(this.ssc);
    return this.wrap(response);
  }

  private unwrap(command: Buffer): Buffer {
    const header = Buffer.from(command.subarray(0, 4));
    header[0] = header[0]! & ~0x0c;
    const fields = parseTlv(command.subarray(5, 5 + command[4]!));

    const encrypted = fields.get(0x87);
    if (!encrypted) {
      const le = fields.get(0x97);
      return Buffer.concat([header, le ?? Buffer.alloc(0)]);
    }
    const decipher = createDecipheriv('des-ede3-cbc', expand3des(this.ksEnc!), Buffer.alloc(8));
    decipher.setAutoPadding(false);
    const body = unpadIso9797Method2(
      Buffer.concat([decipher.update(encrypted.subarray(1)), decipher.final()]),
    );
    return Buffer.concat([header, Buffer.from([body.length]), body]);
  }

  private handle(plain: Buffer): { data: Buffer; status: Buffer } {
    const ins = plain[1]!;
    if (ins === 0xa4) {
      this.selected = plain[plain.length - 1]!;
      return { data: Buffer.alloc(0), status: ok() };
    }
    if (ins === 0xb0) {
      const file = this.selected !== null ? this.files[this.selected] : undefined;
      if (!file) return { data: Buffer.alloc(0), status: Buffer.from([0x6a, 0x82]) };
      const offset = (plain[2]! << 8) | plain[3]!;
      const want = plain[4] ?? 0;
      return { data: file.subarray(offset, offset + want), status: ok() };
    }
    return { data: Buffer.alloc(0), status: Buffer.from([0x6d, 0x00]) };
  }

  private wrap({ data, status }: { data: Buffer; status: Buffer }): Buffer {
    const parts: Buffer[] = [];
    if (data.length > 0) {
      const cipher = createCipheriv('des-ede3-cbc', expand3des(this.ksEnc!), Buffer.alloc(8));
      cipher.setAutoPadding(false);
      const encrypted = Buffer.concat([cipher.update(padIso9797Method2(data)), cipher.final()]);
      parts.push(tlv(0x87, Buffer.concat([Buffer.from([0x01]), encrypted])));
    }
    parts.push(tlv(0x99, status));

    const payload = Buffer.concat(parts);
    const authenticated = Buffer.concat([this.ssc, payload]);
    let checksum = mac(
      this.ksMac!,
      padIso9797Method2(authenticated).subarray(0, Math.ceil((authenticated.length + 1) / 8) * 8),
    );
    if (this.corruptNextResponse) {
      checksum = Buffer.from(checksum);
      checksum[0] = checksum[0]! ^ 0xff;
      this.corruptNextResponse = false;
    }

    return Buffer.concat([payload, tlv(0x8e, checksum), status]);
  }
}

const ok = () => Buffer.from([0x90, 0x00]);

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag, value.length]), value]);
}

function parseTlv(buffer: Buffer): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  let i = 0;
  while (i + 2 <= buffer.length) {
    out.set(buffer[i]!, buffer.subarray(i + 2, i + 2 + buffer[i + 1]!));
    i += 2 + buffer[i + 1]!;
  }
  return out;
}
