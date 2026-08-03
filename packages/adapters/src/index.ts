import { MockDocAuthAdapter, MockNfcAdapter, MockOcrAdapter } from './mock/documents.js';
import { MockFaceMatchAdapter, MockLivenessAdapter } from './mock/biometrics.js';
import { InMemoryWatchlistSource, LocalScreeningAdapter } from './mock/screening.js';
import { MockRegistryAdapter } from './mock/registry.js';
import {
  MockChainAnalysisAdapter,
  MockContactRiskAdapter,
  MockDeviceAdapter,
} from './mock/signals.js';
import { ConsoleNotificationAdapter } from './notifications.js';
import { LocalStorageAdapter, S3StorageAdapter } from './storage.js';
import type { AdapterRegistry, StorageAdapter } from './types.js';
import type { WatchlistSource } from './mock/screening.js';

export * from './types.js';
export * from './deterministic.js';
export * from './storage.js';
export * from './notifications.js';
export { MockOcrAdapter, MockDocAuthAdapter, MockNfcAdapter } from './mock/documents.js';
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

  return {
    ocr: new MockOcrAdapter(),
    docAuth: new MockDocAuthAdapter(),
    liveness: new MockLivenessAdapter(),
    faceMatch: new MockFaceMatchAdapter(),
    nfc: new MockNfcAdapter(),
    screening: new LocalScreeningAdapter(config.watchlistSource),
    registry: new MockRegistryAdapter(),
    device: new MockDeviceAdapter(),
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
