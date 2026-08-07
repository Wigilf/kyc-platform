import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { ErrorNote } from '../components';

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('compliance@acme.test');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  /** Set once the password is accepted and a code is still owed. */
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(email, password);
      if (result.done) {
        navigate('/', { replace: true });
        return;
      }
      if (result.enrolmentRequired) {
        setError(
          new Error(
            'This organisation requires two-factor authentication and this account has ' +
              'none set up. An administrator needs to enrol it before you can sign in.',
          ),
        );
        return;
      }
      setChallenge(result.challenge);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.loginWithCode(challenge!, code);
      navigate('/', { replace: true });
    } catch (e) {
      setError(e);
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  if (challenge) {
    return (
      <div className="login-wrap">
        <form className="login-card" onSubmit={submitCode}>
          <h1>Two-factor code</h1>
          <p className="muted">
            Enter the six-digit code from your authenticator app, or one of your
            recovery codes.
          </p>
          <ErrorNote error={error} />
          <div className="field">
            <label htmlFor="code">Code</label>
            <input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              // `one-time-code` is what lets a phone offer the code from the
              // notification rather than making someone switch apps for it.
              autoComplete="one-time-code"
              inputMode="text"
              autoFocus
              required
            />
          </div>
          <button type="submit" className="primary" disabled={busy || code.trim().length < 6}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setChallenge(null);
              setCode('');
              setError(null);
            }}
          >
            Use a different account
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>KYC Operations</h1>
        <ErrorNote error={error} />
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            autoComplete="username"
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
