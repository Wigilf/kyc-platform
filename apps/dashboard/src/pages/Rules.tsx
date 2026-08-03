import { ErrorNote, useApi } from '../components';

interface Rule {
  id: string;
  name: string;
  description: string | null;
  scope: string;
  priority: number;
  isActive: boolean;
  isShadow: boolean;
  version: number;
  actions: Array<{ type: string; reason?: string }> | null;
}

export default function Rules() {
  const { data, error, loading } = useApi<{ rules: Rule[] }>('/v1/rules');

  const rules = [...(data?.rules ?? [])].sort(
    (a, b) => a.scope.localeCompare(b.scope) || a.priority - b.priority,
  );

  return (
    <>
      <h1>Rules</h1>
      <p className="subtitle">
        The decision rules applied to every verification, in priority order.
        Shadow rules are evaluated and logged but never affect an outcome.
      </p>

      <ErrorNote error={error} />

      <div className="card" style={{ padding: 0 }}>
        {loading && !data ? (
          <div className="spinner">Loading…</div>
        ) : !rules.length ? (
          <div className="empty">No rules configured.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">Priority</th>
                  <th>Rule</th>
                  <th>Scope</th>
                  <th>Actions</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id}>
                    <td className="num muted">{r.priority}</td>
                    <td>
                      <span className="mono">{r.name}</span>
                      {r.description && (
                        <div className="muted" style={{ fontSize: 12, maxWidth: 520 }}>
                          {r.description}
                        </div>
                      )}
                    </td>
                    <td className="muted">{r.scope.replace(/_/g, ' ').toLowerCase()}</td>
                    <td>
                      <div className="labels">
                        {(r.actions ?? []).map((a, i) => (
                          <span key={i} className="label-chip neutral">
                            {a.type}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      {!r.isActive ? (
                        <span className="badge info">inactive</span>
                      ) : r.isShadow ? (
                        <span className="badge warn">shadow</span>
                      ) : (
                        <span className="badge pass">active</span>
                      )}
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
