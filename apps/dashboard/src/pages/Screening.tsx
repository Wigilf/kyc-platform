import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ScreeningHit } from '../api';
import { api } from '../api';
import { Badge, ErrorNote, useApi } from '../components';

type Resolution = 'TRUE_POSITIVE' | 'FALSE_POSITIVE' | 'UNABLE_TO_DETERMINE';

export default function Screening() {
  const { data, error, loading, reload } = useApi<{ hits: ScreeningHit[] }>(
    '/v1/screening/hits?status=OPEN',
  );

  return (
    <>
      <h1>Screening hits</h1>
      <p className="subtitle">
        Open sanctions, PEP, and adverse-media matches awaiting a disposition.
      </p>

      <ErrorNote error={error} />

      {loading && !data ? (
        <div className="spinner">Loading…</div>
      ) : !data?.hits.length ? (
        <div className="card">
          <div className="empty">No open hits. Everything has been dispositioned.</div>
        </div>
      ) : (
        data.hits.map((hit) => <HitCard key={hit.id} hit={hit} onResolved={reload} />)
      )}
    </>
  );
}

function HitCard({ hit, onResolved }: { hit: ScreeningHit; onResolved: () => void }) {
  const [resolution, setResolution] = useState<Resolution>('FALSE_POSITIVE');
  const [note, setNote] = useState('');
  const [allowlist, setAllowlist] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const applicant = hit.run?.applicant ?? null;
  const snapshot = (hit.snapshot ?? {}) as Record<string, unknown>;
  const aliases = Array.isArray(snapshot.aliases) ? (snapshot.aliases as string[]) : [];
  const positions = Array.isArray(snapshot.positions) ? (snapshot.positions as string[]) : [];

  async function resolve() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/screening/hits/${hit.id}/resolve`, {
        resolution,
        note,
        addToAllowlist: allowlist,
      });
      onResolved();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="check-head" style={{ marginBottom: 12 }}>
        <Badge value={hit.listType} kind={hit.listType === 'SANCTIONS' ? 'fail' : 'warn'} />
        <span className="name">{hit.matchedName}</span>
        <span className="badge info">{hit.matchScore.toFixed(3)}</span>
        <span className="provider">{hit.listName}</span>
      </div>

      <div className="detail-grid">
        <div>
          <dl className="kv">
            <dt>Applicant</dt>
            <dd>
              {applicant ? (
                <>
                  <Link to={`/applicants/${applicant.id}`}>
                    {[applicant.firstName, applicant.lastName].filter(Boolean).join(' ') ||
                      applicant.externalUserId}
                  </Link>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {applicant.dob ? applicant.dob.slice(0, 10) : 'no dob'} ·{' '}
                    {applicant.country ?? '—'}
                  </div>
                </>
              ) : (
                '—'
              )}
            </dd>
            <dt>Matched on</dt>
            <dd className="mono">{hit.matchedFields.join(', ')}</dd>
            {snapshot.dob ? (
              <>
                <dt>Listed DOB</dt>
                <dd className="mono">{String(snapshot.dob)}</dd>
              </>
            ) : null}
            {aliases.length > 0 && (
              <>
                <dt>Aliases</dt>
                <dd>{aliases.join(', ')}</dd>
              </>
            )}
            {positions.length > 0 && (
              <>
                <dt>Positions</dt>
                <dd>{positions.join('; ')}</dd>
              </>
            )}
            {snapshot.program ? (
              <>
                <dt>Programme</dt>
                <dd>{String(snapshot.program)}</dd>
              </>
            ) : null}
          </dl>
        </div>

        <div>
          <ErrorNote error={error} />
          <div className="field">
            <label htmlFor={`res-${hit.id}`}>Disposition</label>
            <select
              id={`res-${hit.id}`}
              value={resolution}
              onChange={(e) => setResolution(e.target.value as Resolution)}
            >
              <option value="FALSE_POSITIVE">False positive</option>
              <option value="TRUE_POSITIVE">True positive</option>
              <option value="UNABLE_TO_DETERMINE">Unable to determine</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={`note-${hit.id}`}>Rationale (required)</label>
            <textarea
              id={`note-${hit.id}`}
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What distinguishes this person from the listed entity, or confirms them as it."
            />
          </div>
          {resolution === 'FALSE_POSITIVE' && (
            <label
              style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, fontSize: 13 }}
            >
              <input
                type="checkbox"
                checked={allowlist}
                onChange={(e) => setAllowlist(e.target.checked)}
                style={{ width: 'auto' }}
              />
              Suppress this match for this applicant in future screenings
            </label>
          )}
          <button
            className="primary"
            onClick={resolve}
            disabled={busy || !note.trim()}
            style={{ width: '100%' }}
          >
            {busy ? 'Saving…' : 'Resolve hit'}
          </button>
        </div>
      </div>
    </div>
  );
}
