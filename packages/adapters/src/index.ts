import { MockDocAuthAdapter, MockNfcAdapter, MockOcrAdapter } from './mock/documents.js';
import { MockFaceMatchAdapter, MockLivenessAdapter } from './mock/biometrics.js';
import { InMemoryWatchlistSource, LocalScreeningAdapter } from './mock/screening.js';
import { MockRegistryAdapter } from './mock/registry.js';
import {
  MockChainAnalysisAdapter,
  MockContactRiskAdapter,
  MockDeviceAdapter,
} from './mock/signals.js';
import { TesseractOcrAdapter } from './live/ocr-tesseract.js';
import { ConsoleNotificationAdapter } from './notifications.js';
import { LocalStorageAdapter, S3StorageAdapter } from './storage.js';
import type { AdapterRegistry, DeclaredSubjectSource, StorageAdapter } from './types.js';
import type { WatchlistSource } from './mock/screening.js';

export * from './types.js';
export * from './deterministic.js';
export * from './storage.js';
export * from './notifications.js';
export { MockOcrAdapter, MockDocAuthAdapter, MockNfcAdapter } from './mock/documents.js';
export { TesseractOcrAdapter } from './live/ocr-tesseract.js';
export type { TesseractOcrOptions } from './live/ocr-tesseract.js';
export {
  MockLivenessAdapter,
  MockFaceMatchAdapter,
  mockEmbedding,
  cosineSimilarity,
  embeddingBucket,
} from './mock/biometrics.js';
export {
  LocalScreeningAdapter,
  InMemoryWatchlistSource,
  scoreCandidate,
} from './mock/screening.js';
export type { WatchlistCandidate, WatchlistSource } from './mock/screening.js';
export { MockRegistryAdapter } from './mock/registry.js';
export {
  MockDeviceAdapter,
  MockContactRiskAdapter,
  MockChainAnalysisAdapter,
} from './mock/signals.js';

export interface AdapterConfig {
  mode: 'mock' | 'live';
  /**
   * Which document reader to use.
   *
   * Separate from `mode` because the capabilities are not all the same kind of
   * problem. Reading a document is something this project can genuinely do;
   * deciding whether one is forged is not, and no amount of code here changes
   * that. Pinning them to a single switch would mean either shipping a real
   * reader that nobody can turn on, or implying an authenticity check exists.
   */
  ocr?: 'mock' | 'tesseract';
  /**
   * Budget for reading one document image. Worth raising on slow hardware: a
   * shared-CPU instance can take a hundred times longer than a laptop.
   */
  ocrTimeoutMs?: number;
  /** Logs raw recognised text. Debugging only — it is passport contents. */
  ocrDebugText?: boolean;
  storage: {
    driver: 'local' | 's3';
    localDir?: string;
    signingSecret: string;
    s3?: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle?: boolean;
    };
  };
  /**
   * Supplies watchlist candidates to the screening adapter. Injected rather than
   * imported so @kyc/adapters stays free of a database dependency.
   */
  watchlistSource: WatchlistSource;
  /**
   * Supplies the applicant's declared identity to the *mock* adapters only, so
   * they can emit documents and geolocation that agree with the applicant rather
   * than inventing contradictions. Injected for the same reason as
   * `watchlistSource`, and kept off the adapter request types so a live provider
   * implementation cannot be handed declared PII it has no need for.
   */
  declaredSubjectSource?: DeclaredSubjectSource;
  logger?: (msg: string) => void;
}

/**
 * Builds the adapter set for a process.
 *
 * `live` mode is where real provider clients get wired in. It intentionally
 * throws today rather than silently falling back to mocks: a deployment that
 * thinks it is calling a real sanctions provider and is not would be a far worse
 * failure than a startup error.
 */
export function createAdapters(config: AdapterConfig): AdapterRegistry {
  if (config.mode === 'live') {
    throw new Error(
      'ADAPTER_MODE=live requires real provider implementations. Implement the ' +
        'adapter interfaces in @kyc/adapters/src/live/ and register them here. ' +
        'Refusing to fall back to mock adapters, which would produce fabricated ' +
        'verification results in a production environment.',
    );
  }

  const declared = config.declaredSubjectSource ?? nullDeclaredSubjectSource();

  return {
    ocr:
      config.ocr === 'tesseract'
        ? new TesseractOcrAdapter({
            storage: createStorage(config.storage),
            logger: config.logger,
            ...(config.ocrTimeoutMs ? { timeoutMs: config.ocrTimeoutMs } : {}),
            debugText: config.ocrDebugText ?? false,
          })
        : new MockOcrAdapter(declared),
    docAuth: new MockDocAuthAdapter(),
    liveness: new MockLivenessAdapter(),
    faceMatch: new MockFaceMatchAdapter(),
    nfc: new MockNfcAdapter(),
    screening: new LocalScreeningAdapter(config.watchlistSource),
    registry: new MockRegistryAdapter(),
    device: new MockDeviceAdapter(declared),
    contactRisk: new MockContactRiskAdapter(),
    chain: new MockChainAnalysisAdapter(),
    storage: createStorage(config.storage),
    notifications: new ConsoleNotificationAdapter(config.logger),
  };
}

export function createStorage(config: AdapterConfig['storage']): StorageAdapter {
  if (config.driver === 's3') {
    if (!config.s3) throw new Error('STORAGE_DRIVER=s3 requires S3 configuration');
    return new S3StorageAdapter(config.s3);
  }
  return new LocalStorageAdapter(
    config.localDir ?? './.data/uploads',
    config.signingSecret,
  );
}

/** Empty source, for tests that do not care about screening. */
export function emptyWatchlistSource(): WatchlistSource {
  return new InMemoryWatchlistSource([]);
}

/**
 * Knows nothing about anyone. Mocks then invent an identity, which is the right
 * behaviour for a caller that never told us who the applicant is.
 */
export function nullDeclaredSubjectSource(): DeclaredSubjectSource {
  return { load: async () => null };
}
