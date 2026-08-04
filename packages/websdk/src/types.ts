/** Public surface of the embeddable verification widget. */

export interface KycMountOptions {
  /** Element, or a CSS selector for one, to render into. */
  container: HTMLElement | string;
  /** Short-lived applicant token from POST /v1/sdk/tokens. */
  token: string;
  /** The applicant the token was issued for. */
  applicantId: string;
  /** Origin of the KYC API. Defaults to the page's own origin. */
  apiBaseUrl?: string;
  /** BCP-47 tag. Only 'en' ships today; unknown tags fall back to it. */
  locale?: string;
  /** Fired once the applicant has submitted and the flow reaches a resting state. */
  onComplete?: (result: { status: string; canResubmit: boolean }) => void;
  /** Fired for anything the widget could not recover from. */
  onError?: (error: Error) => void;
  /**
   * Suppress the widget's own "simulated checks" banner.
   *
   * Only set this when the surrounding page already carries the warning — the
   * default is to show it, because a host that forgets is worse than a
   * duplicate. Never set it to hide the fact.
   */
  hideSimulationNotice?: boolean;
  /** Fired on every step transition, for host-page analytics. */
  onEvent?: (event: KycEvent) => void;
}

export interface KycEvent {
  type:
    | 'loaded'
    | 'step_started'
    | 'document_captured'
    | 'document_uploaded'
    | 'submitted'
    | 'status_changed'
    | 'error';
  stepId?: string;
  documentType?: string;
  status?: string;
  message?: string;
}

export interface KycHandle {
  /** Removes the widget and releases the camera if it is open. */
  destroy(): void;
  /** Re-reads requirements and status from the API. */
  refresh(): Promise<void>;
}

export interface Requirement {
  id: string;
  type: string;
  label: string;
  acceptedDocumentTypes: string[];
  requireBothSides: boolean;
}

export interface RequirementsResponse {
  levelName: string;
  status: string;
  /** Whatever the applicant has already supplied, for prefilling the form. */
  applicantData?: Record<string, string>;
  /** True when no real document or biometric provider is wired in. */
  simulated?: boolean;
  outstanding: Requirement[];
  allSteps: Array<{
    id: string;
    type: string;
    label?: string;
    required: boolean;
    satisfied: boolean;
    /** False for steps the platform performs itself, e.g. sanctions screening. */
    applicantFacing?: boolean;
    /** Present for every step, so a completed one can be revisited. */
    acceptedDocumentTypes?: string[];
    requireBothSides?: boolean;
  }>;
}

export interface ApplicantStatus {
  id: string;
  reviewStatus: string;
  levelName?: string;
  documents: Array<{ id: string; type: string; status: string; rejectLabels: string[] }>;
  latestReview?: {
    decision: string;
    rejectLabels: string[];
    clientComment: string | null;
  } | null;
}
