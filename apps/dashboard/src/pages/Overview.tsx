import { Link, useNavigate } from 'react-router-dom';
import type { Funnel, QueueRow } from '../api';
import { Badge, ErrorNote, Stat, rowLink, useApi } from '../components';

export default function Overview() {
  const navigate = useNavigate();
  const funnel = useApi<Funnel>('/v1/reports/funnel');
  const queues = useApi<{ queues: QueueRow[] }>('/v1/queues');

  const f = funnel.data;
  const byStatus = f?.byStatus ?? {};

  return (
    <>
      <h1>Overview</h1>
      <p className="subtitle">
        Verification funnel over the last {f?.windowDays ?? 30} days.
      </p>

      <ErrorNote error={funnel.error ?? queues.error} />

      <div className="stat-row">
        <Stat label="Applicants" value={f?.total ?? '—'} sub="in window" />
        <Stat
          label="Completion"
          value={f ? `${f.completionRate}%` : '—'}
          sub={`${f?.abandonedInFlow ?? 0} abandoned in flow`}
        />
        <Stat
          label="Approval rate"
          value={f ? `${f.approvalRateOfDecided}%` : '—'}
          sub="of decided applicants"
        />
        <Stat
          label="Automation"
          value={f ? `${f.automationRate}%` : '—'}
          sub="decided without a reviewer"
        />
      </div>

      <div className="card">
        <h2>By review status</h2>
        {Object.keys(byStatus).length === 0 ? (
          <div className="empty">No applicants in this window.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th className="num">Count</th>
                  <th style={{ width: '55%' }} />
                </tr>
              </thead>
              <tbody>
                {Object.entries(byStatus)
                  .sort((a, b) => b[1] - a[1])
                  .map(([status, count]) => (
                    <tr key={status} {...rowLink(navigate, `/applicants?reviewStatus=${status}`)}>
                      <td>
                        <Link to={`/applicants?reviewStatus=${status}`}>
                          <Badge value={status} />
                        </Link>
                      </td>
                      <td className="num">{count}</td>
                      <td>
                        <Bar value={count} max={f?.total ?? count} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Review queues</h2>
        {!queues.data?.queues.length ? (
          <div className="empty">No queues configured.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Queue</th>
                  <th>Description</th>
                  <th className="num">Open</th>
                  <th className="num">Total</th>
                  <th className="num">Response SLA</th>
                </tr>
              </thead>
              <tbody>
                {queues.data.queues.map((q) => (
                  <tr key={q.id} {...rowLink(navigate, `/cases?queue=${encodeURIComponent(q.name)}`)}>
                    <td>
                      <Link to={`/cases?queue=${encodeURIComponent(q.name)}`}>{q.name}</Link>
                      {q.isDefault ? <> <span className="badge info">default</span></> : null}
                    </td>
                    <td className="muted">{q.description ?? '—'}</td>
                    <td className="num">{q.openCases}</td>
                    <td className="num">{q.totalCases}</td>
                    <td className="num muted">{q.slaFirstResponseMinutes}m</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Top rejection reasons</h2>
        {!f?.topRejectReasons.length ? (
          <div className="empty">Nothing rejected in this window.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Label</th>
                  <th className="num">Occurrences</th>
                  <th style={{ width: '55%' }} />
                </tr>
              </thead>
              <tbody>
                {f.topRejectReasons.map((r) => (
                  <tr key={r.label}>
                    <td>
                      <span className="label-chip">{r.label}</span>
                    </td>
                    <td className="num">{r.count}</td>
                    <td>
                      <Bar value={r.count} max={f.topRejectReasons[0]!.count} />
                    </td>
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

function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div
      style={{ background: 'var(--surface-2)', borderRadius: 3, height: 6, overflow: 'hidden' }}
      role="presentation"
    >
      <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)' }} />
    </div>
  );
}
