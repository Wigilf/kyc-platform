import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api';
import { ErrorNote, useApi } from '../components';

/**
 * Turning on a second factor.
 *
 * Enrolment is two steps on purpose. The first hands over a secret and a set of
 * recovery codes; the second will not switch anything on until a code proves
 * the authenticator was actually configured. Enabling it optimistically locks
 * out anyone who mistypes the setup, and the person best placed to help them is
 * the console they can no longer reach.
 */

interface Status {
  enabled: boolean;
  required: boolean;
  recoveryCodesLeft: number;
  enabledAt: string | null;
}

interface Enrolment {
  secret: string;
  uri: string;
  recoveryCodes: string[];
}

export default function Security() {
  const status = useApi<Status>('/v1/me/2fa');
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!enrolment) {
      setQr(null);
      return;
    }
    // Rendered in the browser from the URI the server returned, so the secret
    // is not round-tripped through an image service.
    void QRCode.toDataURL(enrolment.uri, { margin: 1, width: 220 }).then(setQr).catch(() => setQr(null));
  }, [enrolment]);

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      setEnrolment(await api.post<Enrolment>('/v1/me/2fa/enrol'));
      setSaved(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/v1/me/2fa/confirm', { code });
      setEnrolment(null);
      setCode('');
      status.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <h1>Security</h1>

      <div className="card">
        <h2>Two-factor authentication</h2>
        <ErrorNote error={error} />

        {status.data?.enabled && !enrolment ? (
          <>
            <p>
              <strong>On.</strong> A code from your authenticator is required each
              time you sign in.
            </p>
            <p className="muted">
              {status.data.recoveryCodesLeft} recovery code
              {status.data.recoveryCodesLeft === 1 ? '' : 's'} remaining.
              {status.data.recoveryCodesLeft <= 2
                ? ' Running low — regenerate them before you are down to none.'
                : ''}
            </p>
            {status.data.required ? (
              <p className="muted">
                Your organisation requires two-factor authentication, so it cannot
                be turned off here.
              </p>
            ) : null}
          </>
        ) : null}

        {!status.data?.enabled && !enrolment ? (
          <>
            <p>
              This console shows identity documents, dates of birth and addresses
              for everyone your business has verified. A password on its own is
              one credential, and credentials leak.
            </p>
            <button type="button" className="primary" onClick={begin} disabled={busy}>
              {busy ? 'Preparing…' : 'Set up two-factor authentication'}
            </button>
          </>
        ) : null}

        {enrolment ? (
          <div className="enrol">
            <ol className="enrol-steps">
              <li>
                <h3>Scan this with your authenticator</h3>
                {qr ? <img src={qr} alt="Enrolment QR code" width={220} height={220} /> : null}
                <p className="muted">
                  Cannot scan? Enter this key by hand:
                  <br />
                  <code className="mono">{enrolment.secret}</code>
                </p>
              </li>

              <li>
                <h3>Save your recovery codes</h3>
                <p className="muted">
                  These are shown once and never again. Each works a single time,
                  and they are the only way back in if you lose your phone.
                </p>
                <ul className="recovery-codes mono">
                  {enrolment.recoveryCodes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                <div className="enrol-actions">
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(enrolment.recoveryCodes.join('\n'));
                      setSaved(true);
                    }}
                  >
                    Copy codes
                  </button>
                  <label>
                    <input
                      type="checkbox"
                      checked={saved}
                      onChange={(e) => setSaved(e.target.checked)}
                    />{' '}
                    I have saved these somewhere safe
                  </label>
                </div>
              </li>

              <li>
                <h3>Enter a code to finish</h3>
                <form onSubmit={confirm} className="enrol-confirm">
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="123456"
                    autoComplete="one-time-code"
                    aria-label="Code from your authenticator"
                  />
                  {/* Gated on the codes being saved: the moment after this is
                      the moment a lost phone becomes a locked account. */}
                  <button
                    type="submit"
                    className="primary"
                    disabled={busy || code.trim().length < 6 || !saved}
                  >
                    {busy ? 'Checking…' : 'Turn on'}
                  </button>
                </form>
                {!saved ? (
                  <p className="muted">Confirm you have saved the recovery codes first.</p>
                ) : null}
              </li>
            </ol>
          </div>
        ) : null}
      </div>
    </div>
  );
}
