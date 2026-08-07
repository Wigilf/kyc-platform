import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ApplicantDetail as Detail, Check } from '../api';
import { DocumentViewer } from '../components/DocumentViewer';
import { api } from '../api';
import { Badge, ErrorNote, Labels, relativeTime, riskTone, tone, useApi } from '../components';

type Decision = 'APPROVED' | 'REJECTED_RETRY' | 'REJECTED_FINAL' | 'ON_HOLD';

export default function ApplicantDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApi<{ applicant: Detail }>(
    id ? `/v1/applicants/${id}` : null,
  );

  if (loading && !data) return <div className="spinner">Loading…</div>;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const a = data.applicant;
  const name = [a.firstName, a.lastName].filter(Boolean).join(' ') || '(no name)';
  const hits = a.screening.flatMap((r) => r.hits);

  return (
    <>
      <p className="subtitle" style={{ marginBottom: 6 }}>
        <Link to="/applicants">← Applicants</Link>
      </p>
      <h1>{name}</h1>
      <p className="subtitle">
        <span className="mono">{a.externalUserId}</span>
        {a.levelDisplayName || a.levelName ? ` · ${a.levelDisplayName || a.levelName}` : null}
      </p>

      <div className="stat-row">
        <div className="stat">
          <div className="label">Review status</div>
          <div className="value" style={{ fontSize: 18, marginTop: 8 }}>
            <Badge value={a.reviewStatus} />
          </div>
        </div>
        <div className="stat">
          <div className="label">Risk</div>
          <div className="value">
            {a.riskScore}
            <span className={`badge ${riskTone(a.riskLevel)}`} style={{ marginLeft: 8 }}>
              {a.riskLevel}
            </span>
          </div>
          <div className="sub">Due diligence: {a.ddLevel}</div>
        </div>
        <div className="stat">
          <div className="label">Screening hits</div>
          <div className="value">{hits.length}</div>
          <div className="sub">{hits.filter((h) => h.status === 'OPEN').length} open</div>
        </div>
        <div className="stat">
          <div className="label">Submitted</div>
          <div className="value" style={{ fontSize: 18, marginTop: 8 }}>
            {relativeTime(a.submittedAt)}
          </div>
          <div className="sub">Decided {relativeTime(a.reviewedAt)}</div>
        </div>
      </div>

      <div className="detail-grid">
        <div>
          <div className="card">
            <h2>Checks</h2>
            {!a.checks.length ? (
              <div className="empty">No checks have run.</div>
            ) : (
              dedupeChecks(a.checks).map((c) => <CheckRow key={c.id} check={c} />)
            )}
          </div>

          <div className="card">
            <h2>Documents</h2>
            {!a.documents.length ? (
              <div className="empty">Nothing uploaded.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Status</th>
                      <th>Country</th>
                      <th>Expires</th>
                      <th>Image</th>
                      <th>Labels</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.documents.map((d) => (
                      <tr key={d.id}>
                        <td>
                          {d.type.replace(/_/g, ' ')}
                          {d.subType ? <span className="muted"> · {d.subType}</span> : null}
                        </td>
                        <td>
                          <Badge value={d.status} />
                        </td>
                        <td className="mono">{d.country ?? '—'}</td>
                        <td className="muted">
                          {d.expiryDate ? d.expiryDate.slice(0, 10) : '—'}
                        </td>
                        <td>
                          <DocumentViewer
                            images={d.images ?? []}
                            extracted={d.extracted}
                            title={d.type.replace(/_/g, ' ')}
                          />
                        </td>
                        <td>
                          <Labels items={d.rejectLabels} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {hits.length > 0 && (
            <div className="card">
              <h2>Screening hits</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>List</th>
                      <th>Matched name</th>
                      <th className="num">Score</th>
                      <th>Matched on</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hits.map((h) => (
                      <tr key={h.id}>
                        <td>
                          <Badge value={h.listType} kind="info" />
                          <div className="muted" style={{ fontSize: 12 }}>
                            {h.listName}
                          </div>
                        </td>
                        <td>{h.matchedName}</td>
                        <td className="num">{h.matchScore.toFixed(3)}</td>
                        <td className="mono">{h.matchedFields.join(', ')}</td>
                        <td>
                          <Badge value={h.resolution ?? h.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
                Resolve hits from <Link to="/screening">Screening</Link>.
              </p>
            </div>
          )}

          {a.reviews.length > 0 && (
            <div className="card">
              <h2>Decision history</h2>
              {a.reviews.map((r) => (
                <div key={r.id} className="check-row">
                  <div className="check-head">
                    <Badge value={r.decision ?? r.reviewStatus} />
                    <span className="muted" style={{ fontSize: 12 }}>
                      {r.reviewSource} · {relativeTime(r.createdAt)}
                    </span>
                  </div>
                  {r.rejectLabels.length > 0 && (
                    <div style={{ marginTop: 6 }}>
                      <Labels items={r.rejectLabels} />
                    </div>
                  )}
                  {r.moderationComment && (
                    <p className="muted" style={{ margin: '6px 0 0', fontSize: 12.5 }}>
                      {r.moderationComment}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <DecisionPanel applicant={a} onDecided={reload} />
      </div>
    </>
  );
}

/**
 * One row per check type, newest first.
 *
 * The API returns the full history and a reviewer wants the current state; the
 * superseded attempts are visible in decision history instead.
 */
function dedupeChecks(checks: Check[]): Check[] {
  const seen = new Set<string>();
  return checks.filter((c) => {
    if (seen.has(c.type)) return false;
    seen.add(c.type);
    return true;
  });
}

function CheckRow({ check }: { check: Check }) {
  const [open, setOpen] = useState(false);
  const verdict = check.result ?? check.status;
  const findings = check.findings ?? [];

  return (
    <div className="check-row">
      <div className="check-head">
        <span className={`badge ${tone(verdict)}`}>{verdict}</span>
        <span className="name">{check.type.replace(/_/g, ' ')}</span>
        {check.score !== null && <span className="muted">score {check.score}</span>}
        <span className="provider">{check.provider ?? ''}</span>
      </div>
      {check.rejectLabels.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <Labels items={check.rejectLabels} />
        </div>
      )}
      {findings.length > 0 && (
        <>
          <button
            onClick={() => setOpen((v) => !v)}
            style={{ marginTop: 8, padding: '3px 8px', fontSize: 12 }}
          >
            {open ? 'Hide' : `${findings.length} finding${findings.length === 1 ? '' : 's'}`}
          </button>
          {open &&
            findings.map((f, i) => (
              <div key={i} className={`finding ${f.severity}`}>
                <code>{f.code}</code> · {f.severity}
                <div>{f.message}</div>
              </div>
            ))}
        </>
      )}
    </div>
  );
}

function DecisionPanel({ applicant, onDecided }: { applicant: Detail; onDecided: () => void }) {
  const [decision, setDecision] = useState<Decision>('APPROVED');
  const [labels, setLabels] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  // Reject labels drive downstream behaviour (whether the applicant may retry,
  // what the SDK tells them), so a rejection without one is refused by the API.
  const suggested = [
    ...new Set(applicant.checks.flatMap((c) => c.rejectLabels)),
  ].slice(0, 8);
  const isRejection = decision === 'REJECTED_RETRY' || decision === 'REJECTED_FINAL';

  async function submit() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const rejectLabels = labels
        .split(',')
        .map((l) => l.trim().toUpperCase())
        .filter(Boolean);
      await api.post(`/v1/applicants/${applicant.id}/decision`, {
        decision,
        rejectLabels,
        ...(comment ? { moderationComment: comment } : {}),
      });
      setDone(`Recorded ${decision.replace(/_/g, ' ').toLowerCase()}.`);
      setComment('');
      setLabels('');
      onDecided();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Record a decision</h2>
      <ErrorNote error={error} />
      {done && (
        <div className="error" style={{ background: 'var(--pass-soft)', color: 'var(--pass)' }}>
          {done}
        </div>
      )}

      <div className="field">
        <label htmlFor="decision">Decision</label>
        <select
          id="decision"
          value={decision}
          onChange={(e) => setDecision(e.target.value as Decision)}
        >
          <option value="APPROVED">Approve</option>
          <option value="REJECTED_RETRY">Reject — may resubmit</option>
          <option value="REJECTED_FINAL">Reject — final</option>
          <option value="ON_HOLD">Put on hold</option>
        </select>
      </div>

      {isRejection && (
        <div className="field">
          <label htmlFor="labels">Reject labels (comma separated, required)</label>
          <input
            id="labels"
            value={labels}
            placeholder="BLURRY_IMAGE, NAME_MISMATCH"
            onChange={(e) => setLabels(e.target.value)}
          />
          {suggested.length > 0 && (
            <div className="labels" style={{ marginTop: 6 }}>
              {suggested.map((l) => (
                <button
                  key={l}
                  type="button"
                  className="label-chip neutral"
                  style={{ border: 'none', cursor: 'pointer' }}
                  onClick={() =>
                    setLabels((prev) => (prev ? `${prev}, ${l}` : l))
                  }
                >
                  + {l}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="field">
        <label htmlFor="comment">Internal note</label>
        <textarea
          id="comment"
          rows={4}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Why this decision was reached."
        />
      </div>

      <button
        className={isRejection ? 'danger' : 'primary'}
        onClick={submit}
        disabled={busy || (isRejection && !labels.trim())}
        style={{ width: '100%' }}
      >
        {busy ? 'Submitting…' : 'Submit decision'}
      </button>

      <p className="muted" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
        A final rejection, or overturning a decision that has already been made,
        requires a compliance officer, MLRO, or administrator.
      </p>
    </div>
  );
}
