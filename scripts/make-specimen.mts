/**
 * Generates the specimen document the hosted demo offers for testing.
 *
 * With a real reader turned on, a demo has a problem it did not have with a
 * simulated one: a visitor with nothing to hand uploads a screenshot, gets a
 * truthful "we could not read this", and concludes the product is broken. The
 * honest fix is to give them something that does read.
 *
 * Deliberately not a facsimile of any real passport. The country is UTO —
 * Utopia, the fictional state ICAO 9303 uses throughout its own examples — the
 * design belongs to no issuing authority, there is no portrait, and the word
 * SPECIMEN is across the middle of it. It exists to exercise a checksum, and it
 * should be impossible to mistake for anything else.
 *
 *   npm run make:specimen
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { buildTd3Mrz, parseMrz } from '@kyc/core';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'verify', 'public');

const HOLDER = {
  documentCode: 'P',
  issuingState: 'UTO',
  surname: 'SPECIMEN',
  givenNames: 'ADA MARIE',
  // Chosen to be legible rather than adversarial: no runs of 0/O or 1/I, which
  // are the pairs OCR-B readers confuse. The point of the specimen is to
  // exercise the checksum end to end, not to stress-test glyph disambiguation.
  documentNumber: 'UT7431852',
  nationality: 'UTO',
  dateOfBirth: '1990-05-12',
  sex: 'F' as const,
  dateOfExpiry: '2031-08-14',
};

const mrz = buildTd3Mrz(HOLDER);
const parsed = parseMrz(mrz);
if (!parsed.valid) {
  throw new Error(`Refusing to ship a specimen whose own checksums fail: ${parsed.errors.join('; ')}`);
}

const [line1, line2] = mrz.split('\n').map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;'));

const W = 1500;
const H = 1000;

const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="#eceadf"/>
  <rect x="0" y="0" width="${W}" height="150" fill="#2f4858"/>
  <text x="60" y="72" font-family="Helvetica" font-size="34" fill="#ffffff" letter-spacing="3">REPUBLIC OF UTOPIA</text>
  <text x="60" y="118" font-family="Helvetica" font-size="26" fill="#c8d6de" letter-spacing="2">SPECIMEN TRAVEL DOCUMENT — NOT VALID FOR TRAVEL</text>

  <rect x="60" y="210" width="240" height="300" fill="#d5d0be" stroke="#b3ac96" stroke-width="3"/>
  <text x="118" y="370" font-family="Helvetica" font-size="22" fill="#8a8371">NO</text>
  <text x="96" y="400" font-family="Helvetica" font-size="22" fill="#8a8371">PORTRAIT</text>

  ${field(360, 250, 'Surname', HOLDER.surname)}
  ${field(360, 340, 'Given names', HOLDER.givenNames)}
  ${field(360, 430, 'Date of birth', '12 MAY 1990')}
  ${field(980, 250, 'Passport No.', HOLDER.documentNumber)}
  ${field(980, 340, 'Nationality', 'UTOPIAN')}
  ${field(980, 430, 'Date of expiry', '14 AUG 2031')}

  <text x="${W / 2}" y="560" font-family="Helvetica" font-size="96" fill="#b03030" opacity="0.28"
        text-anchor="middle" letter-spacing="14" transform="rotate(-8 ${W / 2} 560)">SPECIMEN</text>

  <line x1="60" y1="640" x2="${W - 60}" y2="640" stroke="#b3ac96" stroke-width="2"/>
  <text x="60" y="690" font-family="Helvetica" font-size="20" fill="#6f6a5a">
    Test document for the verification demo. The zone below carries valid ICAO 9303 check digits.
  </text>

  <rect x="40" y="740" width="${W - 80}" height="200" fill="#f7f6f1"/>
  <!-- No extra tracking: the zone is fixed-pitch by definition, and adding
       letter-spacing on top of a monospace face splits characters apart in a
       way the reader's segmentation does not expect. -->
  <text x="70" y="836" font-family="monospace" font-size="44" fill="#111111">${line1}</text>
  <text x="70" y="906" font-family="monospace" font-size="44" fill="#111111">${line2}</text>
</svg>`;

function field(x: number, y: number, label: string, value: string): string {
  return `<text x="${x}" y="${y}" font-family="Helvetica" font-size="19" fill="#7a7365" letter-spacing="1">${label.toUpperCase()}</text>
    <text x="${x}" y="${y + 38}" font-family="Helvetica" font-size="34" fill="#1a1a1a">${value}</text>`;
}

await sharp(Buffer.from(svg)).png().toFile(join(OUT, 'specimen-passport.png'));
console.log(`wrote ${join(OUT, 'specimen-passport.png')}`);
console.log(mrz);
console.log('check digits valid:', parsed.valid);
