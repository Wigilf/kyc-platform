import { PostgresStorageAdapter } from '@kyc/db';
import { createStorage, type StorageAdapter } from '@kyc/adapters';

/**
 * The one storage driver this process uses.
 *
 * Built once, and by everything: the upload path, the file-serving route and
 * the presigner all have to agree about where documents live. They previously
 * did not — uploads went wherever the worker was configured to write while the
 * API's two routes each constructed their own driver defaulting to the local
 * filesystem. With matching defaults that happened to work; the moment the
 * default changed it would have meant writing to one place and reading from
 * another, and the symptom would have been documents that upload successfully
 * and then cannot be found.
 */

let cached: StorageAdapter | null = null;

export function storageForProcess(): StorageAdapter {
  if (cached) return cached;

  const driver = (process.env.STORAGE_DRIVER ?? 'postgres') as 'local' | 's3' | 'postgres';

  cached = createStorage({
    driver,
    localDir: process.env.STORAGE_LOCAL_DIR ?? './.data/uploads',
    signingSecret: process.env.APP_SECRET ?? 'dev-secret',
    ...(driver === 'postgres'
      ? {
          postgres: new PostgresStorageAdapter(
            process.env.APP_SECRET ?? 'dev-secret',
            process.env.PII_ENCRYPTION_KEY ?? '',
          ),
        }
      : {}),
    ...(driver === 's3'
      ? {
          s3: {
            endpoint: process.env.S3_ENDPOINT!,
            region: process.env.S3_REGION ?? 'us-east-1',
            bucket: process.env.S3_BUCKET!,
            accessKeyId: process.env.S3_ACCESS_KEY_ID!,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
            forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
          },
        }
      : {}),
  });

  return cached;
}

/** Drivers this API serves bytes for, which are the ones that sign their own URLs. */
interface SignedAccess {
  verifyPresigned(key: string, expires: number, signature: string): boolean;
}

/**
 * Whether a driver issues links this API is expected to honour.
 *
 * S3 presigns against S3, so a request never reaches us; local and Postgres
 * both sign links we serve ourselves and must therefore verify.
 */
export function signsItsOwnUrls(storage: StorageAdapter): storage is StorageAdapter &
  SignedAccess {
  return typeof (storage as Partial<SignedAccess>).verifyPresigned === 'function';
}

/** Clears the cached driver. Tests only, where the environment changes. */
export function resetStorageForTests(): void {
  cached = null;
}
