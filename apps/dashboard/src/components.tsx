import type { ReactNode } from 'react';
import type { MouseEvent } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from './api';

/**
 * Makes a whole table row navigate, not just the link inside it.
 *
 * The link stays in the cell and remains the keyboard and screen-reader path;
 * this only adds the mouse affordance a person expects from a dense table.
 * Clicks that land on another control inside the row are left alone.
 */
export function rowLink(navigate: (to: string) => void, to: string) {
  return {
    className: 'row-go',
    onClick: (event: MouseEvent<HTMLTableRowElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest('a, button, input, select, textarea, label')) return;
      navigate(to);
    },
  };
}

/** Verdict colouring, in one place so a PASS is never green on one screen and grey on another. */
export function tone(value: string | null | undefined): 'pass' | 'warn' | 'fail' | 'info' {
  switch (value) {
    case 'PASS':
    case 'APPROVED':
    case 'COMPLETED':
    case 'FALSE_POSITIVE':
    case 'RESOLVED':
    case 'CLOSED':
      return 'pass';
    case 'WARNING':
    case 'QUEUED':
    case 'ON_HOLD':
    case 'IN_REVIEW':
    case 'PENDING':
    case 'UNABLE_TO_DETERMINE':
      return 'warn';
    case 'FAIL':
    case 'FAILED':
    case 'REJECTED_FINAL':
    case 'REJECTED_RETRY':
    case 'TRUE_POSITIVE':
      return 'fail';
    default:
      return 'info';
  }
}

export function riskTone(level: string): 'pass' | 'warn' | 'fail' | 'info' {
  if (level === 'LOW') return 'pass';
  if (level === 'MEDIUM') return 'warn';
  if (level === 'HIGH' || level === 'CRITICAL') return 'fail';
  return 'info';
}

export function Badge({ value, kind }: { value: string; kind?: string }) {
  return <span className={`badge ${kind ?? tone(value)}`}>{value.replace(/_/g, ' ')}</span>;
}

export function Labels({ items }: { items: string[] }) {
  if (!items.length) return <span className="muted">—</span>;
  return (
    <div className="labels">
      {items.map((l) => (
        <span key={l} className="label-chip">
          {l}
        </span>
      ))}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof ApiError
      ? `${error.message}${error.code && error.code !== 'ERROR' ? ` (${error.code})` : ''}`
      : error instanceof Error
        ? error.message
        : String(error);
  return <div className="error">{message}</div>;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Data loading with an explicit reload handle.
 *
 * Every screen that acts on a record needs to re-read it afterwards, so `reload`
 * is part of the contract rather than something each page reinvents.
 */
export function useApi<T>(path: string | null): {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    api
      .get<T>(path)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}
