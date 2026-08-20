import { Buffer } from 'buffer';
import type { PassportRead } from '@kyc/mrtd';

/**
 * The server side of a chip read.
 *
 * The phone reads; the server decides. Passive authentication — checking the
 * issuing state's signature over the chip's contents — happens on a machine
 * the applicant does not control, against a trust store they cannot edit. A
 * phone that decided for itself whether a passport was genuine would be a
 * phone an attacker could reimplement, and the answer would be worth nothing.
 *
 * So this hands over exactly what was read, and nothing else: no verdict, no
 * "looks fine to me".
 */

export interface Session {
  apiBaseUrl: string;
  applicantId: string;
  /** Short-lived, scoped to this one applicant. */
  token: string;
}

export interface ChipVerdict {
  passiveAuthPassed: boolean;
  certificateChainValid: boolean;
  /** Never `false`: a clone cannot be detected by passive authentication. */
  activeAuthPassed: boolean | null;
  findings: Array<{ code: string; severity: string; message: string }>;
}

export async function submitChipRead(
  session: Session,
  read: PassportRead,
  mrz: { documentNumber: string; dateOfBirth: string; dateOfExpiry: string },
): Promise<ChipVerdict> {
  const dataGroups: Record<string, string> = {
    SOD: Buffer.from(read.sod).toString('base64'),
  };
  for (const [name, bytes] of Object.entries(read.dataGroups)) {
    dataGroups[name] = Buffer.from(bytes).toString('base64');
  }

  const response = await fetch(`${session.apiBaseUrl}/v1/applicants/${session.applicantId}/nfc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      dataGroups,
      documentNumber: mrz.documentNumber,
      dateOfBirth: mrz.dateOfBirth,
      dateOfExpiry: mrz.dateOfExpiry,
    }),
  });

  if (response.status === 501) {
    throw new Error(
      'Chip verification is not switched on for this deployment. The photo page will be reviewed instead.',
    );
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `The server rejected the chip read (${response.status})`);
  }

  return (await response.json()) as ChipVerdict;
}

/**
 * Parses the session a QR code or link carries.
 *
 * An applicant gets here from a link the business sent them, so the app never
 * asks anyone to type an identifier. Malformed input returns null rather than
 * throwing: a mistyped link is an ordinary thing, not an exception.
 */
export function parseSessionLink(link: string): Session | null {
  try {
    const url = new URL(link);
    const token = url.searchParams.get('token');
    const applicantId = url.searchParams.get('applicant');
    const apiBaseUrl = url.searchParams.get('api');
    if (!token || !applicantId || !apiBaseUrl) return null;
    // Only over TLS. A session token is a bearer credential and http:// would
    // hand it to anyone on the same network.
    if (!apiBaseUrl.startsWith('https://') && !apiBaseUrl.startsWith('http://localhost')) {
      return null;
    }
    return { token, applicantId, apiBaseUrl: apiBaseUrl.replace(/\/$/, '') };
  } catch {
    return null;
  }
}
