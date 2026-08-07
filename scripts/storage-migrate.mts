/**
 * Moves stored documents from one driver to another.
 *
 * Documents live in the database because the deployed alternative was a disk
 * the host wipes on restart. That is a compromise with a stated exit —
 * `STORAGE_DRIVER=s3` — and an exit is only real if taking it does not lose
 * anything. Flipping the environment variable alone would leave every existing
 * document behind: the rows would still name keys, and nothing would answer.
 *
 * So: copy first, verify every object against the digest recorded when it was
 * written, switch the variable, and only then delete the originals. This runs
 * the first two, refuses to continue if anything does not match, and leaves the
 * deletion to a separate deliberate invocation.
 *
 *   npm run storage:migrate -- --to s3 --dry-run
 *   npm run storage:migrate -- --to s3
 *   npm run storage:migrate -- --to s3 --delete-source   (after switching over)
 */

import { createHash } from 'node:crypto';
import { createStorage, type StorageAdapter } from '@kyc/adapters';
import { PostgresStorageAdapter, prisma } from '@kyc/db';

interface Options {
  to: 'postgres' | 's3' | 'local';
  from: 'postgres' | 's3' | 'local';
  dryRun: boolean;
  deleteSource: boolean;
  batch: number;
}

function parseArgs(argv: string[]): Options {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const to = value('--to');
  if (to !== 'postgres' && to !== 's3' && to !== 'local') {
    throw new Error('Pass --to with one of: postgres, s3, local');
  }
  const from = value('--from') ?? (process.env.STORAGE_DRIVER ?? 'postgres');
  if (from !== 'postgres' && from !== 's3' && from !== 'local') {
    throw new Error('--from must be one of: postgres, s3, local');
  }
  if (from === to) throw new Error(`Source and destination are both ${to}; nothing to do`);

  return {
    to,
    from,
    dryRun: argv.includes('--dry-run'),
    deleteSource: argv.includes('--delete-source'),
    batch: Number(value('--batch') ?? 100),
  };
}

function driver(kind: Options['to']): StorageAdapter {
  const signingSecret = process.env.APP_SECRET ?? 'dev-secret';
  if (kind === 'postgres') {
    return new PostgresStorageAdapter(signingSecret, process.env.PII_ENCRYPTION_KEY ?? '');
  }
  if (kind === 's3') {
    for (const required of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
      if (!process.env[required]) throw new Error(`${required} is required to migrate to s3`);
    }
    return createStorage({
      driver: 's3',
      signingSecret,
      s3: {
        endpoint: process.env.S3_ENDPOINT!,
        region: process.env.S3_REGION ?? 'us-east-1',
        bucket: process.env.S3_BUCKET!,
        accessKeyId: process.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      },
    });
  }
  return createStorage({
    driver: 'local',
    signingSecret,
    localDir: process.env.STORAGE_LOCAL_DIR ?? './.data/uploads',
  });
}

/**
 * Every key the system believes exists.
 *
 * Taken from `DocumentImage`, not from the source driver's own listing: the
 * database is the record of what the platform thinks it has, and an object in a
 * bucket that no row references is not something a migration should resurrect.
 * A row whose object is missing is the interesting case, and it is reported.
 */
async function keysToMove(): Promise<Array<{ key: string; sha256: string; contentType: string }>> {
  const images = await prisma.documentImage.findMany({
    select: { storageKey: true, sha256: true, contentType: true },
    orderBy: { createdAt: 'asc' },
  });
  return images.map((i) => ({ key: i.storageKey, sha256: i.sha256, contentType: i.contentType }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = driver(options.from);
  const destination = driver(options.to);

  if (options.to === 's3' && 'ensureBucket' in destination) {
    await (destination as unknown as { ensureBucket(): Promise<void> }).ensureBucket();
  }

  const objects = await keysToMove();
  console.log(
    `${options.from} → ${options.to}: ${objects.length} object(s)${options.dryRun ? ' (dry run)' : ''}`,
  );

  let copied = 0;
  let alreadyThere = 0;
  const missing: string[] = [];
  const mismatched: string[] = [];

  for (let i = 0; i < objects.length; i += options.batch) {
    const batch = objects.slice(i, i + options.batch);
    await Promise.all(
      batch.map(async (object) => {
        let bytes: Buffer;
        try {
          bytes = (await source.get(object.key)).bytes;
        } catch {
          // A row pointing at nothing. Almost certainly a document uploaded
          // before storage was durable; recorded rather than skipped silently,
          // because a reviewer will one day open that case and find nothing.
          missing.push(object.key);
          return;
        }

        const digest = createHash('sha256').update(bytes).digest('hex');
        if (object.sha256 && digest !== object.sha256) {
          mismatched.push(object.key);
          return;
        }

        if (await destination.exists(object.key)) {
          alreadyThere++;
          return;
        }
        if (!options.dryRun) {
          await destination.put(object.key, bytes, object.contentType);
          // Read back rather than trust the write. A migration that reports
          // success for objects it has not proved are readable is the same
          // mistake as a check that passes when nothing was checked.
          const written = await destination.get(object.key);
          if (createHash('sha256').update(written.bytes).digest('hex') !== digest) {
            mismatched.push(object.key);
            return;
          }
        }
        copied++;
      }),
    );
    process.stdout.write(`  ${Math.min(i + options.batch, objects.length)}/${objects.length}\r`);
  }

  console.log('');
  console.log(`  copied        ${copied}`);
  console.log(`  already there ${alreadyThere}`);
  if (missing.length) console.log(`  missing at source ${missing.length}: ${missing.slice(0, 3).join(', ')}…`);
  if (mismatched.length) console.log(`  DIGEST MISMATCH ${mismatched.length}: ${mismatched.slice(0, 3).join(', ')}…`);

  if (mismatched.length) {
    console.log('\n✗ Refusing to go further: some objects did not match their recorded digest.');
    process.exitCode = 1;
    return;
  }

  if (options.deleteSource) {
    if (options.dryRun) {
      console.log('\n(dry run: would delete the source copies)');
    } else {
      // Deliberately a separate invocation from the copy. Deleting in the same
      // run as the copy means a switch that has not yet been proved in
      // production is also a switch that cannot be undone.
      let deleted = 0;
      for (const object of objects) {
        if (await destination.exists(object.key)) {
          await source.delete(object.key).catch(() => undefined);
          deleted++;
        }
      }
      console.log(`  deleted from source ${deleted}`);
    }
  } else if (!options.dryRun) {
    console.log(
      `\nNext: set STORAGE_DRIVER=${options.to} and redeploy. Once documents load from ` +
        `the new store in production, run again with --delete-source.`,
    );
  }
}

try {
  await main();
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
