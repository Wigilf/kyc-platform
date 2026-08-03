import type { ApplicantStatus, RequirementsResponse } from './types.js';

/**
 * The applicant-scoped API client.
 *
 * The token is an applicant token, not a backend key: it is scoped to one
 * applicant, expires, and the API refuses any record other than its own. That
 * is what makes it safe to hand to a browser, and it is why the widget never
 * needs — and must never be given — a tenant API key.
 */

export class KycApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KycApiError';
  }
}

export class KycClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly applicantId: string,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.token}`, ...init.headers },
      });
    } catch (cause) {
      // A network failure is not a verification outcome, and must not be
      // presented to the applicant as one.
      throw new KycApiError(0, 'NETWORK', 'Could not reach the verification service.');
    }

    const text = await response.text();
    const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (!response.ok) {
      throw new KycApiError(
        response.status,
        String(payload.code ?? 'ERROR'),
        String(payload.message ?? `Request failed (${response.status})`),
      );
    }
    return payload as T;
  }

  requirements(): Promise<RequirementsResponse> {
    return this.request(`/v1/applicants/${this.applicantId}/requirements`);
  }

  async status(): Promise<ApplicantStatus> {
    const payload = await this.request<{ applicant: ApplicantStatus & { reviews?: unknown[] } }>(
      `/v1/applicants/${this.applicantId}`,
    );
    return payload.applicant;
  }

  async uploadDocument(args: {
    file: Blob;
    filename: string;
    type: string;
    subType: string;
    capturedBy: 'WEB_SDK_CAMERA' | 'UPLOAD';
  }): Promise<{ id: string }> {
    const form = new FormData();
    form.append('file', args.file, args.filename);
    form.append('type', args.type);
    form.append('subType', args.subType);
    form.append('capturedBy', args.capturedBy);

    // No content-type header: the browser must set the multipart boundary.
    const payload = await this.request<{ document: { id: string } }>(
      `/v1/applicants/${this.applicantId}/documents`,
      { method: 'POST', body: form },
    );
    return payload.document ?? { id: '' };
  }

  updateInfo(info: Record<string, unknown>): Promise<unknown> {
    return this.request(`/v1/applicants/${this.applicantId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ info }),
    });
  }

  submit(): Promise<{ applicant: { reviewStatus: string } }> {
    return this.request(`/v1/applicants/${this.applicantId}/submit`, { method: 'POST' });
  }
}
