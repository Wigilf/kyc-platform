import { describe, expect, it, vi } from 'vitest';
import { parseSessionLink, submitChipRead } from '../src/api.js';

/**
 * The app's own logic, which is testable without a phone.
 *
 * Not the NFC transport — that needs a device and a passport. This is the
 * part around it: how a session arrives, and what gets sent to the server.
 * Both have failure modes worth pinning down, because a session token is a
 * bearer credential and a chip read is evidence.
 */

describe('the link that starts a session', () => {
  it('reads a well-formed one', () => {
    const session = parseSessionLink(
      'kyc://chip?token=abc.def&applicant=cmsj123&api=https://api.example.test',
    );

    expect(session).toEqual({
      token: 'abc.def',
      applicantId: 'cmsj123',
      apiBaseUrl: 'https://api.example.test',
    });
  });

  it('refuses to send a token over plain http', () => {
    // The token is a bearer credential. Over http it goes to everyone on the
    // same network, and a link is exactly the thing an attacker can craft.
    expect(
      parseSessionLink('kyc://chip?token=abc&applicant=a1&api=http://api.example.test'),
    ).toBeNull();
    // localhost is allowed, because development has to be possible.
    expect(
      parseSessionLink('kyc://chip?token=abc&applicant=a1&api=http://localhost:4000'),
    ).not.toBeNull();
  });

  it('returns nothing for a link missing any part, rather than half a session', () => {
    for (const link of [
      'kyc://chip?applicant=a1&api=https://x.test',
      'kyc://chip?token=abc&api=https://x.test',
      'kyc://chip?token=abc&applicant=a1',
      'not a url at all',
      '',
    ]) {
      expect(parseSessionLink(link)).toBeNull();
    }
  });

  it('tolerates a trailing slash on the API address', () => {
    expect(
      parseSessionLink('kyc://chip?token=t&applicant=a&api=https://x.test/')?.apiBaseUrl,
    ).toBe('https://x.test');
  });
});

describe('handing the chip read to the server', () => {
  const session = { token: 't', applicantId: 'a1', apiBaseUrl: 'https://x.test' };
  const read = {
    dataGroups: { DG1: Buffer.from('mrz bytes'), DG2: Buffer.from('portrait bytes') },
    sod: Buffer.from('security object'),
  };
  const mrz = { documentNumber: 'L898902C', dateOfBirth: '690806', dateOfExpiry: '940623' };

  it('sends the data groups and the security object, base64, and nothing else', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            passiveAuthPassed: true,
            certificateChainValid: true,
            activeAuthPassed: null,
            findings: [],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await submitChipRead(session, read, mrz);

    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('https://x.test/v1/applicants/a1/nfc');
    const body = JSON.parse(String(call?.[1]?.body));

    expect(Buffer.from(body.dataGroups.SOD, 'base64').toString()).toBe('security object');
    expect(Buffer.from(body.dataGroups.DG1, 'base64').toString()).toBe('mrz bytes');
    // No verdict of its own. The phone reads; the server decides — a phone
    // that judged its own passport would be one an attacker could reimplement.
    expect(Object.keys(body).sort()).toEqual([
      'dataGroups',
      'dateOfBirth',
      'dateOfExpiry',
      'documentNumber',
    ]);
    vi.unstubAllGlobals();
  });

  it('says plainly when the deployment has chip checking switched off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 501 })));

    await expect(submitChipRead(session, read, mrz)).rejects.toThrow(/not switched on/);
    vi.unstubAllGlobals();
  });

  it('surfaces the server\'s own message when it rejects the read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: 'Applicant is not accepting uploads' }), { status: 422 })),
    );

    await expect(submitChipRead(session, read, mrz)).rejects.toThrow(/not accepting uploads/);
    vi.unstubAllGlobals();
  });
});
