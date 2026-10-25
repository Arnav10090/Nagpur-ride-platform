import React, { useId, useState } from 'react';
import { adminMessage } from './api';

export const Pill = ({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'neutral'; children: React.ReactNode }) => <span className={`pill pill-${tone}`}>{children}</span>;
const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'neutral'> = { APPROVED: 'ok', ACTIVE: 'ok', SUCCEEDED: 'ok', COMPLETED: 'ok', RESOLVED: 'ok', PENDING: 'warn', REQUIRES_ACTION: 'warn', OPEN: 'warn', SEARCHING: 'warn', IN_PROGRESS: 'warn', PARTIALLY_REFUNDED: 'warn',
  REJECTED: 'bad', SUSPENDED: 'bad', FAILED: 'bad', CANCELLED: 'bad', EXPIRED: 'bad', REFUNDED: 'neutral' };
export const Status = ({ value }: { value: string | null }) => (value ? <Pill tone={TONE[value] ?? 'neutral'}>{value.replace(/_/g, ' ').toLowerCase()}</Pill> : <span className="muted">—</span>);
export const Err = ({ message }: { message: string | null }) => (message ? <p role="alert" className="alert">{message}</p> : null);
export const Ok = ({ message }: { message: string | null }) => (message ? <p role="status" className="notice">{message}</p> : null);
export const Loading = () => <p role="status" className="muted">Loading…</p>;
export const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const shortId = (id: string) => id.slice(0, 8);

/**
 * A consequential action: nothing happens on the first click. It opens a form that REQUIRES a written reason (it is written to the audit log),
 * then asks for an explicit confirm. Errors stay visible next to the action.
 */
export function ReasonAction(p: { label: string; confirmLabel: string; prompt: string; minLength?: number; danger?: boolean; onSubmit: (reason: string) => Promise<unknown>; onDone: (msg: string) => void; extra?: React.ReactNode }) {
  const [open, setOpen] = useState(false); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const id = useId(); const min = p.minLength ?? 3;
  if (!open) return <button type="button" className={p.danger ? 'btn btn-danger' : 'btn'} onClick={() => setOpen(true)}>{p.label}</button>;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (reason.trim().length < min) return setErr(`Please write at least ${min} characters.`);
    setBusy(true); setErr(null);
    try { await p.onSubmit(reason.trim()); setOpen(false); setReason(''); p.onDone(`${p.confirmLabel}: done.`); } catch (x) { setErr(adminMessage(x)); } finally { setBusy(false); }
  };
  return (
    <form className="inline-form" onSubmit={submit} aria-label={p.label}>
      {p.extra}
      <label htmlFor={id}>{p.prompt}</label>
      <textarea id={id} value={reason} onChange={e => setReason(e.target.value)} rows={2} maxLength={500} />
      <Err message={err} />
      <div className="row">
        <button type="submit" className={p.danger ? 'btn btn-danger' : 'btn btn-primary'} disabled={busy}>{busy ? 'Working…' : p.confirmLabel}</button>
        <button type="button" className="btn" onClick={() => { setOpen(false); setErr(null); }}>Cancel</button>
      </div>
    </form>);
}
