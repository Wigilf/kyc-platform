/**
 * Imports the trust anchors that make chip verification possible.
 *
 * A passport's chip is signed by the country that issued it. Verifying that
 * signature means holding the issuing country's signing certificate, and
 * countries publish theirs collectively in a "master list" — a signed bundle of
 * every CSCA certificate the publisher has collected and chosen to vouch for.
 *
 * Germany's Federal Office for Information Security publishes one openly, which
 * is why it is the default here: no membership, no terms gate, a direct
 * download. ICAO publishes one too, behind a terms acceptance that a person has
 * to click; pass `--file` to import that or any other list once downloaded.
 *
 * **Importing is not the same as trusting.** The list is somebody's curation,
 * and which countries to accept is a compliance decision rather than a
 * technical one. This tool says what it found, per country, so that decision
 * can be made with the facts in front of you — and writes each certificate as
 * its own file so a country can be removed by deleting one.
 *
 *   npm run csca:import                       # fetch and import the German list
 *   npm run csca:import -- --file some.ml     # import a list already downloaded
 *   npm run csca:import -- --dry-run
 */

import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const GERMAN_MASTER_LIST =
  'https://www.bsi.bund.de/SharedDocs/Downloads/DE/BSI/ElekAusweise/CSCA/GermanMasterList.zip?__blob=publicationFile';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const dryRun = argv.includes('--dry-run');
const outDir = resolve(flag('--out') ?? process.env.CSCA_DIR ?? './.data/cscas');

async function main() {
  const bytes = flag('--file') ? readFileSync(resolve(flag('--file')!)) : await fetchGermanList();
  console.log(`  master list: ${Math.round(bytes.length / 1024)}kB`);

  const { certificates, signer } = parseMasterList(bytes);
  console.log(`  signed by: ${signer ?? 'unknown'}`);
  console.log(`  certificates: ${certificates.length}`);

  const byCountry = new Map<string, number>();
  const now = new Date();
  let expired = 0;
  let unreadable = 0;
  const written: string[] = [];

  for (const [index, der] of certificates.entries()) {
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(der);
    } catch {
      unreadable++;
      continue;
    }

    const country = countryOf(certificate.subject) ?? 'XX';
    byCountry.set(country, (byCountry.get(country) ?? 0) + 1);

    // Expired anchors are kept, deliberately. A passport issued in 2019 was
    // signed by a certificate that has since lapsed, and that signature is
    // still good — discarding the anchor would fail every older document. What
    // matters is that the certificate was valid when it signed, and passive
    // authentication checks that separately.
    if (new Date(certificate.validTo) < now) expired++;

    const name = `${country}-${index.toString().padStart(3, '0')}-${fingerprint(certificate)}.pem`;
    written.push(name);
    if (!dryRun) writeFileSync(join(outDir, name), certificate.toString());
  }

  // A hand-rolled parser that walks slightly wrong does not throw — it returns
  // a plausible-looking handful of things that are not certificates. An earlier
  // version of this reported "certificates: 2" and imported none, and only the
  // number being obviously absurd gave it away. Published lists carry hundreds
  // from a hundred-odd countries, so anything else is a parse that went astray.
  if (certificates.length < 50 || byCountry.size < 20) {
    throw new Error(
      `Only ${certificates.length} certificate(s) across ${byCountry.size} countries were ` +
        `read. A real master list holds hundreds from a hundred or more, so this is a ` +
        `parsing failure rather than a small list. Nothing has been written.`,
    );
  }
  if (unreadable > certificates.length / 10) {
    throw new Error(
      `${unreadable} of ${certificates.length} entries did not parse as certificates. ` +
        `Nothing has been written.`,
    );
  }

  console.log(`  countries: ${byCountry.size}`);
  console.log(`  expired but retained: ${expired}  (an old passport's signer has often lapsed)`);
  if (unreadable) console.log(`  unreadable and skipped: ${unreadable}`);

  const top = [...byCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`  e.g. ${top.map(([c, n]) => `${c}:${n}`).join('  ')}`);

  if (dryRun) {
    console.log(`\n(dry run: would write ${written.length} certificates to ${outDir})`);
    return;
  }

  console.log(`\n✓ ${written.length} certificates in ${outDir}`);
  console.log(`  Set CSCA_DIR=${outDir} and chip verification switches from refusing to running.`);
  console.log(
    `  Trusting this list means trusting its publisher's curation. Remove a country by\n` +
      `  deleting its files; each certificate is its own file for exactly that reason.`,
  );
}

async function fetchGermanList(): Promise<Buffer> {
  console.log('▸ Fetching the German CSCA master list (openly published, no membership)');
  const response = await fetch(GERMAN_MASTER_LIST, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(
      `The master list could not be downloaded (${response.status}). Fetch it by hand and ` +
        `pass --file.`,
    );
  }
  const zip = Buffer.from(await response.arrayBuffer());

  // A zip containing one `.ml`. Unzipped with the system tool rather than a
  // dependency, since this runs occasionally and by hand.
  const scratch = mkdtempSync(join(tmpdir(), 'csca-'));
  try {
    const archive = join(scratch, 'ml.zip');
    writeFileSync(archive, zip);
    execFileSync('unzip', ['-q', '-o', archive, '-d', scratch]);
    const found = readdirSync(scratch).find((f) => f.toLowerCase().endsWith('.ml'));
    if (!found) throw new Error('The archive contained no .ml master list');
    console.log(`  ${found}`);
    return readFileSync(join(scratch, found));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * A master list is CMS SignedData whose content is:
 *
 *   CscaMasterList ::= SEQUENCE {
 *     version   INTEGER,
 *     certList  SET OF Certificate }
 *
 * so the certificates are inside the *signed content*, not in the CMS
 * `certificates` field — that one holds whoever signed the list.
 *
 * The CMS envelope is unwrapped with openssl rather than in process. The
 * published lists use long-form lengths that the JavaScript parser rejected,
 * and openssl is already a dependency of this project — it is what Prisma's
 * query engine needs, and the container installs it. Reaching for a tool that
 * is already there beats fighting a parser over a file format nobody controls.
 */
function parseMasterList(bytes: Buffer): { certificates: Buffer[]; signer: string | null } {
  const scratch = mkdtempSync(join(tmpdir(), 'csca-parse-'));
  try {
    const input = join(scratch, 'list.ml');
    const content = join(scratch, 'content.der');
    writeFileSync(input, bytes);

    // `-noverify` skips checking the list signature against a trust store we do
    // not have — the point here is to read the contents. Whose signature it
    // carries is reported separately so the choice to trust it is a visible one.
    const signers = join(scratch, 'signers.pem');
    execFileSync('openssl', [
      'cms', '-verify', '-noverify',
      '-inform', 'DER', '-in', input,
      '-out', content, '-outform', 'DER',
      // Extracted in the same pass. `openssl pkcs7` cannot read these files —
      // the signer info uses a form the older PKCS#7 parser rejects — but the
      // CMS reader hands them over happily.
      '-certsout', signers,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    // Walked by hand rather than with an ASN.1 library.
    //
    // Two JavaScript parsers refused this file. The published lists are large
    // and use long-form lengths throughout, and the structure needed here is
    // three levels deep and entirely fixed — a sequence, an integer, and a set
    // of certificates. Reading those lengths directly is thirty lines that
    // cannot be surprised by a file format nobody here controls.
    const outer = derChildren(readFileSync(content));
    const list = outer.find((child) => child.tag === 0x31); // SET OF Certificate
    if (!list) throw new Error('The signed content contains no certificate set');

    // `list.der`, not `list.value`: the walker steps into a container, so it
    // needs the whole tag-length-value. Handing it the contents made it step
    // into the first certificate and enumerate that certificate's own parts.
    const certificates = derChildren(list.der)
      .filter((child) => child.tag === 0x30) // each Certificate is a SEQUENCE
      .map((child) => child.der);

    return { certificates, signer: signerOf(signers) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Who signed the list. Reported, not trusted — trusting it is a decision. */
function signerOf(signersPem: string): string | null {
  try {
    const first = readFileSync(signersPem, 'utf8').split('-----END CERTIFICATE-----')[0];
    if (!first?.includes('BEGIN CERTIFICATE')) return null;
    return new X509Certificate(`${first}-----END CERTIFICATE-----\n`).subject.replace(/\n/g, ', ');
  } catch {
    return null;
  }
}

/**
 * The immediate children of a DER container.
 *
 * Returns each child's tag, its contents, and the full tag-length-value bytes —
 * a certificate has to be handed on complete, not just its interior.
 */
function derChildren(buffer: Buffer): Array<{ tag: number; value: Buffer; der: Buffer }> {
  const children: Array<{ tag: number; value: Buffer; der: Buffer }> = [];

  // Step into the outer container first: its own header is not a child.
  const outer = readHeader(buffer, 0);
  if (!outer) return children;

  let cursor = outer.contentStart;
  const end = outer.contentStart + outer.length;

  while (cursor < end && cursor < buffer.length) {
    const header = readHeader(buffer, cursor);
    if (!header) break;
    const finish = header.contentStart + header.length;
    children.push({
      tag: header.tag,
      value: buffer.subarray(header.contentStart, finish),
      der: buffer.subarray(cursor, finish),
    });
    cursor = finish;
  }
  return children;
}

/** Tag and length at `offset`, handling the long form. */
function readHeader(
  buffer: Buffer,
  offset: number,
): { tag: number; length: number; contentStart: number } | null {
  if (offset + 2 > buffer.length) return null;
  const tag = buffer[offset]!;
  const first = buffer[offset + 1]!;

  if (first < 0x80) return { tag, length: first, contentStart: offset + 2 };

  const byteCount = first & 0x7f;
  // Indefinite length, which DER forbids and these files do not use.
  if (byteCount === 0 || offset + 2 + byteCount > buffer.length) return null;

  let length = 0;
  for (let i = 0; i < byteCount; i++) length = length * 256 + buffer[offset + 2 + i]!;
  return { tag, length, contentStart: offset + 2 + byteCount };
}

/** The two-letter country from a subject line, which is where CSCAs put it. */
function countryOf(subject: string): string | null {
  return /(?:^|\n|,\s*)C=([A-Z]{2})/.exec(subject)?.[1] ?? null;
}

function fingerprint(certificate: X509Certificate): string {
  return certificate.fingerprint256.replace(/:/g, '').slice(0, 12).toLowerCase();
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

try {
  mkdirSync(outDir, { recursive: true });
  await main();
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
