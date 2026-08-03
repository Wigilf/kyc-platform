import { Link, useSearchParams } from 'react-router-dom';
import type { CaseRow } from '../api';
import { Badge, ErrorNote, relativeTime, useApi } from '../components';

export default function Cases() {
  const [params] = useSearchParams();
  const queue = params.get('queue');

  const query = new URLSearchParams({ status: params.get('status') ?? 'OPEN' });
  if (queue) query.set('queue', queue);

  const { data, error, loading } = useApi<{ cases: CaseRow[] }>(`/v1/cases?${query.toString()}`);

  return (
    <>
      <h1>Cases</h1>
      <p className="subtitle">
        {queue ? (
          <>
            Queue <span className="mono">{queue}</span> · <Link to="/cases">all queues</Link>
          </>
        ) : (
          'Open review cases across every queue.'
        )}
      </p>

      <ErrorNote error={error} />

      <div className="card" style={{ padding: 0 }}>
        {loading && !data ? (
          <div className="spinner">Loading…</div>
        ) : !data?.cases.length ? (
          <div className="empty">No open cases.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Priority</th>
                  <th>Applicant</th>
                  <th>Summary</th>
                  <th>Queue</th>
                  <th>Assignee</th>
                  <th>Opened</th>
                </tr>
              </thead>
              <tbody>
                {data.cases.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.reference}</td>
                    <td>
                      <Badge
                        value={c.priority}
                        kind={
                          c.priority === 'CRITICAL' || c.priority === 'HIGH'
                            ? 'fail'
                            : c.priority === 'MEDIUM'
                              ? 'warn'
                              : 'info'
                        }
                      />
                    </td>
                    <td>
                      {c.applicant ? (
                        <Link to={`/applicants/${c.applicant.id}`}>
                          {[c.applicant.firstName, c.applicant.lastName]
                            .filter(Boolean)
                            .join(' ') || c.applicant.externalUserId}
                        </Link>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="muted">{c.summary ?? c.title}</td>
                    <td className="mono">{c.queue ?? '—'}</td>
                    <td className="muted">
                      {c.assignee ? (c.assignee.name ?? c.assignee.email) : 'unassigned'}
                    </td>
                    <td className="muted">{relativeTime(c.createdAt)}</td>
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
