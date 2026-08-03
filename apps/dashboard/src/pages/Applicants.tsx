import { Link, useSearchParams } from 'react-router-dom';
import type { ApplicantRow } from '../api';
import { Badge, ErrorNote, relativeTime, riskTone, useApi } from '../components';

const REVIEW_STATUSES = [
  'INIT',
  'PENDING',
  'QUEUED',
  'ON_HOLD',
  'APPROVED',
  'REJECTED_RETRY',
  'REJECTED_FINAL',
];
const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export default function Applicants() {
  const [params, setParams] = useSearchParams();

  const query = new URLSearchParams();
  for (const key of ['reviewStatus', 'riskLevel', 'search']) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  query.set('limit', '50');

  const { data, error, loading } = useApi<{ applicants: ApplicantRow[]; hasMore: boolean }>(
    `/v1/applicants?${query.toString()}`,
  );

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  return (
    <>
      <h1>Applicants</h1>
      <p className="subtitle">
        {data ? `${data.applicants.length}${data.hasMore ? '+' : ''} matching` : 'Loading…'}
      </p>

      <div className="filters">
        <input
          type="search"
          placeholder="Name, email, or external id"
          defaultValue={params.get('search') ?? ''}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setFilter('search', (e.target as HTMLInputElement).value.trim());
          }}
          onBlur={(e) => setFilter('search', e.target.value.trim())}
        />
        <select
          value={params.get('reviewStatus') ?? ''}
          onChange={(e) => setFilter('reviewStatus', e.target.value)}
        >
          <option value="">Any status</option>
          {REVIEW_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        <select
          value={params.get('riskLevel') ?? ''}
          onChange={(e) => setFilter('riskLevel', e.target.value)}
        >
          <option value="">Any risk</option>
          {RISK_LEVELS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        {[...params.keys()].length > 0 && (
          <button onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear</button>
        )}
      </div>

      <ErrorNote error={error} />

      <div className="card" style={{ padding: 0 }}>
        {loading && !data ? (
          <div className="spinner">Loading…</div>
        ) : !data?.applicants.length ? (
          <div className="empty">No applicants match these filters.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Applicant</th>
                  <th>External id</th>
                  <th>Status</th>
                  <th className="num">Risk</th>
                  <th>DD</th>
                  <th>Country</th>
                  <th>Level</th>
                  <th>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {data.applicants.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Link to={`/applicants/${a.id}`}>
                        {[a.firstName, a.lastName].filter(Boolean).join(' ') || '(no name)'}
                      </Link>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {a.email ?? '—'}
                      </div>
                    </td>
                    <td className="mono">{a.externalUserId}</td>
                    <td>
                      <Badge value={a.reviewStatus} />
                    </td>
                    <td className="num">
                      <span className={`badge ${riskTone(a.riskLevel)}`}>
                        {a.riskScore} {a.riskLevel}
                      </span>
                    </td>
                    <td className="muted">{a.ddLevel}</td>
                    <td className="mono">{a.country ?? '—'}</td>
                    <td className="muted">{a.levelDisplayName}</td>
                    <td className="muted">{relativeTime(a.submittedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
