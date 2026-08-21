import { mountWidget } from './widget.js';
import type { KycHandle, KycMountOptions } from './types.js';

export { KycApiError } from './client.js';
export { chipLink } from './widget.js';
export type {
  ApplicantStatus,
  KycEvent,
  KycHandle,
  KycMountOptions,
  Requirement,
  RequirementsResponse,
} from './types.js';

/**
 * @kyc/websdk — the applicant-facing verification widget.
 *
 * Your backend mints a short-lived applicant token and hands it to the page:
 *
 *   POST /v1/sdk/tokens  { externalUserId, levelName }
 *     -> { token, applicantId }
 *
 * The page then mounts the widget with it:
 *
 *   KycVerification.mount({
 *     container: '#kyc',
 *     token, applicantId,
 *     apiBaseUrl: 'https://kyc.example.com',
 *     onComplete: ({ status }) => console.log(status),
 *   });
 *
 * The token is scoped to a single applicant and expires, so it is safe in a
 * browser. A tenant API key never is, and the widget has no use for one.
 */
export function mount(options: KycMountOptions): KycHandle {
  return mountWidget(options);
}

/**
 * Convenience namespace for ESM consumers.
 *
 * No default export: the IIFE global is the module namespace, so a default
 * would make the script-tag call `KycVerification.default.mount(...)`. A
 * top-level `mount` keeps it `KycVerification.mount(...)` in both worlds.
 */
export const KycVerification = { mount };
