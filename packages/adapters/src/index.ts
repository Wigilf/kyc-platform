import { MockDocAuthAdapter, MockNfcAdapter, MockOcrAdapter } from './mock/documents.js';
import { MockFaceMatchAdapter, MockLivenessAdapter } from './mock/biometrics.js';
import { InMemoryWatchlistSource, LocalScreeningAdapter } from './mock/screening.js';
import { MockRegistryAdapter } from './mock/registry.js';
import {
  MockChainAnalysisAdapter,
  MockContactRiskAdapter,
  MockDeviceAdapter,
} from './mock/signals.js';
import {
  DiditDocAuthAdapter,
  DiditFaceMatchAdapter,
  DiditLivenessAdapter,
  DiditOcrAdapter,
} from './live/didit.js';
import { IcaoNfcAdapter } from './live/nfc-icao.js';
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
  DiditOcrAdapter,
  DiditDocAuthAdapter,
  DiditLivenessAdapter,
  DiditFaceMatchAdapter,
} from './live/didit.js';
export type { DiditOptions } from './live/didit.js';
export { IcaoNfcAdapter } from './live/nfc-icao.js';
export type { IcaoNfcOptions } from './live/nfc-icao.js';
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
  ocr?: 'mock' | 'tesseract' | 'didit';
  /**
   * Credentials for the verification provider.
   *
   * Supplying them is what turns liveness, face matching and document
   * authenticity from simulations into checks. Absent, the mocks stay and both
   * UIs keep saying so.
   */
  didit?: { apiKey: string; faceMatchThreshold?: number; livenessThreshold?: number };
  /**
   * Budget for reading one document image. Worth raising on slow hardware: a
   * shared-CPU instance can take a hundred times longer than a laptop.
   */
  ocrTimeoutMs?: number;
  /** Logs raw recognised text. Debugging only — it is passport contents. */
  ocrDebugText?: boolean;
  /**
   * Trusted Country Signing CA certificates, enabling real chip verification.
   *
   * With none supplied the simulated reader stays in place: an empty trust
   * store cannot verify anything, and a chip check that trusts nobody would
   * either refuse every genuine passport or, worse, be tempted to wave them
   * through.
   */
  trustedCscas?: Array<Buffer | string>;
  storage: {
    driver: 'local' | 's3' | 'postgres';
    localDir?: string;
    signingSecret: string;
    /**
     * Pre-built Postgres driver, supplied by the caller.
     *
     * Injected rather than constructed here for the same reason as the
     * watchlist source: @kyc/adapters stays free of a database dependency, so
     * it can be used by anything that speaks the interface.
     */
    postgres?: StorageAdapter;
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
  if (config.mode === 'live' && !config.didit) {
    throw new Error(
      'ADAPTER_MODE=live requires a verification provider. Set DIDIT_API_KEY, or ' +
        'implement another provider against the interfaces in @kyc/adapters/src/live/. ' +
        'Refusing to fall back to mock adapters, which would produce fabricated ' +
        'verification results in a production environment.',
    );
  }

  const declared = config.declaredSubjectSource ?? nullDeclaredSubjectSource();
  const storage = createStorage(config.storage);

  // One provider, three checks. Constructed once so they share the cache that
  // stops a single document being paid for twice.
  const didit = config.didit
    ? {
        ocr: new DiditOcrAdapter({ ...config.didit, storage, logger: config.logger }),
        docAuth: new DiditDocAuthAdapter({ ...config.didit, storage, logger: config.logger }),
        liveness: new DiditLivenessAdapter({ ...config.didit, storage, logger: config.logger }),
        faceMatch: new DiditFaceMatchAdapter({ ...config.didit, storage, logger: config.logger }),
      }
    : null;

  return {
    ocr:
      config.ocr === 'didit' && didit
        ? didit.ocr
        : config.ocr === 'tesseract'
          ? new TesseractOcrAdapter({
              storage,
              logger: config.logger,
              ...(config.ocrTimeoutMs ? { timeoutMs: config.ocrTimeoutMs } : {}),
              debugText: config.ocrDebugText ?? false,
            })
          : new MockOcrAdapter(declared),
    // These three have no honest local implementation, so the provider is the
    // only thing that makes them real.
    docAuth: didit?.docAuth ?? new MockDocAuthAdapter(),
    liveness: didit?.liveness ?? new MockLivenessAdapter(),
    faceMatch: didit?.faceMatch ?? new MockFaceMatchAdapter(),
    nfc:
      config.trustedCscas && config.trustedCscas.length > 0
        ? new IcaoNfcAdapter({ trustedCscas: config.trustedCscas, logger: config.logger })
        : new MockNfcAdapter(),
    screening: new LocalScreeningAdapter(config.watchlistSource),
    registry: new MockRegistryAdapter(),
    device: new MockDeviceAdapter(declared),
    contactRisk: new MockContactRiskAdapter(),
    chain: new MockChainAnalysisAdapter(),
    storage: createStorage(config.storage),
    notifications: new ConsoleNotificationAdapter(config.logger),
  };
}

/**
 * Which checks are still generated rather than performed.
 *
 * Derived from the adapters actually wired, not from an environment variable.
 * `ADAPTER_MODE` was a single switch when everything was simulated together,
 * and it stopped telling the truth the moment one capability could be real
 * while another was not — a deployment reading documents for real but
 * simulating liveness would either claim everything was real or claim nothing
 * was. Both are wrong in a way that matters: a reviewer must not read a
 * generated pass as evidence.
 */
export function simulatedCapabilities(registry: AdapterRegistry): string[] {
  const capabilities: Array<[string, { name: string }]> = [
    ['document reading', registry.ocr],
    ['document authenticity', registry.docAuth],
    ['liveness', registry.liveness],
    ['face matching', registry.faceMatch],
    ['device intelligence', registry.device],
  ];
  return capabilities.filter(([, a]) => a.name.startsWith('mock')).map(([label]) => label);
}

export function createStorage(config: AdapterConfig['storage']): StorageAdapter {
  if (config.driver === 's3') {
    if (!config.s3) throw new Error('STORAGE_DRIVER=s3 requires S3 configuration');
    return new S3StorageAdapter(config.s3);
  }
  if (config.driver === 'postgres') {
    // Constructed by the caller, because this package deliberately has no
    // database dependency and the Postgres driver needs one.
    if (!config.postgres) {
      throw new Error(
        'STORAGE_DRIVER=postgres requires the caller to supply the adapter; see ' +
          'adaptersFor() in @kyc/worker.',
      );
    }
    return config.postgres;
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
