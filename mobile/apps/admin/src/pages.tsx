import React, { useState } from 'react';
import { formatINR } from '@rides/client';
import { AdminApi, adminMessage } from './api';
import { useLoad } from './hooks';
import { Err, Loading, Ok, ReasonAction, Status, shortId, when } from './ui';
import { can, PERMS, Role, RideDetail } from './types';

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <label className="field"><span>{label}</span>{children}</label>;

export function Dashboard({ api, role }: { api: AdminApi; role: Role }) {
  const { data, error, loading } = useLoad(() => api.summary(), []);
  if (loading && !data) return <Loading />;
  const card = (label: string, v: number | undefined, href?: string, warn = false) => (
    <li className={`card${warn && v ? ' card-warn' : ''}`}><span className="card-n">{v ?? '—'}</span>{href ? <a href={href}>{label}</a> : <span>{label}</span>}</li>);
  return (<section aria-labelledby="h-dash"><h1 id="h-dash">Overview</h1><Err message={error} />
    <ul className="cards">{card('Drivers awaiting approval', data?.pendingDrivers, can(role, PERMS.drivers) ? '#/drivers' : undefined, true)}{card('Drivers online', data?.onlineDrivers)}
      {card('Rides in progress', data?.activeRides, '#/rides')}{card('Payments awaiting the rider', data?.openPayments)}{can(role, PERMS.finance) ? card('Open reconciliation findings', data?.openFindings, '#/finance', true) : null}</ul></section>);
}

export function Drivers({ api, role }: { api: AdminApi; role: Role }) {
  const [verification, setV] = useState('PENDING'); const [q, setQ] = useState(''); const [msg, setMsg] = useState<string | null>(null);
  const qOk = q.trim().length === 0 || q.trim().length >= 3;
  const { data, error, loading, reload } = useLoad(() => (qOk ? api.drivers({ verification: verification || undefined, q: q.trim() || undefined }) : Promise.resolve([])), [verification, q, qOk]);
  const edit = can(role, PERMS.reviewDrivers); const done = (m: string) => { setMsg(m); reload(); };
  return (<section aria-labelledby="h-drv"><h1 id="h-drv">Drivers</h1>
    <div className="toolbar">
      <Field label="Verification"><select value={verification} onChange={e => setV(e.target.value)}><option value="">All</option><option value="PENDING">Awaiting approval</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option></select></Field>
      <Field label="Search (phone ending or vehicle)"><input value={q} onChange={e => setQ(e.target.value)} inputMode="search" maxLength={40} /></Field>
    </div>
    {!qOk ? <p className="muted">Type at least 3 characters to search.</p> : null}<Err message={error} /><Ok message={msg} />
    {loading && !data ? <Loading /> : (
      <table><caption className="sr-only">Drivers</caption>
        <thead><tr><th scope="col">Phone</th><th scope="col">Vehicle</th><th scope="col">Verification</th><th scope="col">Account</th><th scope="col">Online</th>{edit ? <th scope="col">Actions</th> : null}</tr></thead>
        <tbody>{(data ?? []).map(d => (
          <tr key={d.userId}><td>{d.phone}</td><td>{d.registration}</td><td><Status value={d.verification} /></td><td><Status value={d.accountStatus} /></td><td>{d.online ? 'Yes' : 'No'}</td>
            {edit ? <td className="actions">
              {d.verification !== 'APPROVED' && d.accountStatus === 'ACTIVE' ? <ReasonAction label="Approve" confirmLabel="Approve driver" prompt={`Why approve ${d.registration}? (saved to the audit log)`} onSubmit={r => api.review(d.userId, 'APPROVED', r)} onDone={done} /> : null}
              {d.verification === 'PENDING' ? <ReasonAction danger label="Reject" confirmLabel="Reject driver" prompt={`Why reject ${d.registration}?`} onSubmit={r => api.review(d.userId, 'REJECTED', r)} onDone={done} /> : null}
              {d.accountStatus === 'ACTIVE' ? <ReasonAction danger label="Suspend" confirmLabel="Suspend account" prompt="Why suspend this account? They are signed out immediately." onSubmit={r => api.suspend(d.userId, r)} onDone={done} /> : null}
              {d.accountStatus === 'SUSPENDED' ? <ReasonAction label="Reinstate" confirmLabel="Reinstate account" prompt="Why reinstate? They must sign in and go online themselves." onSubmit={r => api.reinstate(d.userId, r)} onDone={done} /> : null}
            </td> : null}</tr>))}</tbody></table>)}
    {data && data.length === 0 && qOk && !loading ? <p className="muted">No drivers match.</p> : null}
  </section>);
}

export function Rides({ api }: { api: AdminApi }) {
  const [status, setStatus] = useState(''); const [q, setQ] = useState(''); const qOk = q.trim().length === 0 || q.trim().length >= 3;
  const { data, error, loading } = useLoad(() => (qOk ? api.rides({ status: status || undefined, q: q.trim() || undefined }) : Promise.resolve([])), [status, q, qOk]);
  return (<section aria-labelledby="h-rides"><h1 id="h-rides">Rides</h1>
    <div className="toolbar">
      <Field label="Status"><select value={status} onChange={e => setStatus(e.target.value)}><option value="">Any</option>{['SEARCHING', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXPIRED'].map(s => <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>)}</select></Field>
      <Field label="Search (ride id start, or phone ending)"><input value={q} onChange={e => setQ(e.target.value)} maxLength={40} /></Field>
    </div>
    {!qOk ? <p className="muted">Type at least 3 characters to search.</p> : null}<Err message={error} />
    {loading && !data ? <Loading /> : (
      <table><caption className="sr-only">Rides</caption>
        <thead><tr><th scope="col">Ride</th><th scope="col">Started</th><th scope="col">Status</th><th scope="col">Payment</th><th scope="col">Fare</th><th scope="col">Rider</th><th scope="col">Driver</th></tr></thead>
        <tbody>{(data ?? []).map(r => (<tr key={r.id}><td><a href={`#/rides/${r.id}`} aria-label={`Open ride ${shortId(r.id)}`}>{shortId(r.id)}</a></td><td>{when(r.createdAt)}</td><td><Status value={r.status} /></td>
          <td>{r.paymentMethod ?? '—'} {r.paymentStatus ? <Status value={r.paymentStatus} /> : null}</td><td>{r.fareMinor != null ? formatINR(r.fareMinor) : '—'}</td><td>{r.riderPhone ?? '—'}</td><td>{r.driverPhone ?? '—'}</td></tr>))}</tbody></table>)}
    {data && data.length === 0 && qOk && !loading ? <p className="muted">No rides match.</p> : null}
  </section>);
}

/** "123.45" -> 12345 paise using string maths only (no floating point). Returns null if it is not a valid positive amount with at most 2 decimals. */
export function rupeesToPaise(s: string): number | null {
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s.trim()); if (!m) return null;
  const v = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')); return v > 0 ? v : null;
}

function RefundForm({ api, d, onDone }: { api: AdminApi; d: RideDetail; onDone: (m: string) => void }) {
  const [amount, setAmount] = useState(''); const left = d.payment ? d.payment.amountMinor - d.payment.refundedMinor : 0; const paise = rupeesToPaise(amount);
  return (<ReasonAction label="Refund rider" confirmLabel="Issue refund" prompt="Why is this refund being issued? (saved to the audit log)" danger
    extra={<><label className="field"><span>Amount in rupees (up to {formatINR(left)})</span><input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" /></label>
      {amount && paise == null ? <p role="alert" className="alert">Enter an amount like 25 or 25.50.</p> : null}{paise != null && paise > left ? <p role="alert" className="alert">That is more than is left to refund.</p> : null}</>}
    onSubmit={async r => { if (paise == null) throw new Error('bad amount'); if (paise > left) throw Object.assign(new Error('too much'), {}); await api.refund(d.id, paise, r); }} onDone={m => { setAmount(''); onDone(m); }} />);
}

export function RideDetailPage({ api, role, id }: { api: AdminApi; role: Role; id: string }) {
  const { data: d, error, loading, reload } = useLoad(() => api.ride(id), [id]); const [msg, setMsg] = useState<string | null>(null);
  if (loading && !d) return <Loading />;
  if (!d) return <section><p><a href="#/rides">← Rides</a></p><Err message={error ?? 'Ride not found.'} /></section>;
  const sum = (dir: string) => d.ledger.filter(l => l.direction === dir).reduce((a, l) => a + l.amountMinor, 0);
  const captured = d.payment && ['SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(d.payment.status);
  return (<section aria-labelledby="h-ride"><p><a href="#/rides">← Rides</a></p><h1 id="h-ride">Ride {shortId(d.id)} <Status value={d.status} /></h1><Err message={error} /><Ok message={msg} />
    <div className="grid">
      <div className="panel"><h2>Trip</h2><dl><dt>Ride id</dt><dd className="mono">{d.id}</dd><dt>Payment method</dt><dd>{d.paymentMethod ?? '—'}</dd><dt>Fare</dt><dd>{d.finalFareMinor != null ? formatINR(d.finalFareMinor) : d.estimatedFareMinor != null ? `${formatINR(d.estimatedFareMinor)} (estimate)` : '—'}</dd>
        <dt>Rider</dt><dd>{d.rider.phone ?? '—'}</dd><dt>Driver</dt><dd>{d.driver ? `${d.driver.phone ?? '—'} · ${d.driver.registration ?? ''}` : '—'}</dd></dl></div>
      <div className="panel"><h2>Timeline</h2><ol className="timeline">{d.timeline.map(e => <li key={e.stateVersion}><span>{e.type.replace('STATE_', '').replace(/_/g, ' ').toLowerCase()}</span> <time>{when(e.at)}</time></li>)}</ol></div>
    </div>
    <div className="panel"><h2>Payment</h2>{d.payment ? (<>
      <p><Status value={d.payment.status} /> {formatINR(d.payment.amountMinor)} · attempt {d.payment.attempt} · refunded {formatINR(d.payment.refundedMinor)}</p>
      {d.payment.refunds.length ? (<table><caption className="sr-only">Refunds</caption><thead><tr><th scope="col">Refund</th><th scope="col">Amount</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Reason</th></tr></thead>
        <tbody>{d.payment.refunds.map(r => <tr key={r.id}><td>{shortId(r.id)}</td><td>{formatINR(r.amountMinor)}</td><td>{r.kind === 'CUSTOMER' ? 'customer' : 'duplicate payment'}</td><td><Status value={r.status} /></td><td>{r.reason}</td></tr>)}</tbody></table>) : null}
      {can(role, PERMS.finance) && captured ? <RefundForm api={api} d={d} onDone={m => { setMsg(m); reload(); }} /> : null}</>) : <p className="muted">{d.paymentMethod === 'CASH' ? 'Cash ride: no online payment.' : 'No payment recorded yet.'}</p>}</div>
    <div className="panel"><h2>Ledger</h2>{d.ledger.length ? (<><table><caption className="sr-only">Ledger entries</caption><thead><tr><th scope="col">Transaction</th><th scope="col">Account</th><th scope="col">Debit</th><th scope="col">Credit</th></tr></thead>
      <tbody>{d.ledger.map((l, i) => <tr key={i}><td className="mono">{l.transactionId.length > 22 ? l.transactionId.slice(0, 22) + '…' : l.transactionId}</td><td>{l.account.split(':')[0]}</td><td>{l.direction === 'DEBIT' ? formatINR(l.amountMinor) : ''}</td><td>{l.direction === 'CREDIT' ? formatINR(l.amountMinor) : ''}</td></tr>)}</tbody></table>
      <p className={sum('DEBIT') === sum('CREDIT') ? 'notice' : 'alert'} role="status">{sum('DEBIT') === sum('CREDIT') ? `Debits equal credits (${formatINR(sum('DEBIT'))}).` : 'Ledger does not balance. Escalate immediately.'}</p></>) : <p className="muted">No ledger entries yet.</p>}</div>
  </section>);
}

export function Finance({ api }: { api: AdminApi }) {
  const { data, error, loading, reload } = useLoad(() => api.findings(), []); const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [show, setShow] = useState<'OPEN' | 'RESOLVED'>('OPEN');
  const run = async () => { setBusy(true); setErr(null); setMsg(null); try { const r = await api.runReconciliation(); setMsg(`Checked ${r.checked} payments; repaired ${r.repaired}; ${r.findings} new finding${r.findings === 1 ? '' : 's'}.`); reload(); } catch (e) { setErr(adminMessage(e)); } finally { setBusy(false); } };
  const rows = (data ?? []).filter(f => f.status === show);
  return (<section aria-labelledby="h-fin"><h1 id="h-fin">Reconciliation</h1>
    <p className="muted">Compares our payment records with the payment provider. Lost confirmations are repaired automatically; anything else appears here for a person to check.</p>
    <div className="toolbar"><button type="button" className="btn btn-primary" onClick={run} disabled={busy}>{busy ? 'Running…' : 'Run reconciliation now'}</button>
      <Field label="Show"><select value={show} onChange={e => setShow(e.target.value as 'OPEN' | 'RESOLVED')}><option value="OPEN">Open</option><option value="RESOLVED">Resolved</option></select></Field></div>
    <Err message={err ?? error} /><Ok message={msg} />
    {loading && !data ? <Loading /> : (<table><caption className="sr-only">Findings</caption>
      <thead><tr><th scope="col">Type</th><th scope="col">Provider reference</th><th scope="col">Details</th><th scope="col">{show === 'OPEN' ? 'Action' : 'Resolution'}</th></tr></thead>
      <tbody>{rows.map(f => (<tr key={f.id}><td>{f.kind.replace(/_/g, ' ').toLowerCase()}</td><td className="mono">{f.providerRef}</td><td className="mono">{JSON.stringify(f.details)}</td>
        <td>{f.status === 'OPEN' ? <ReasonAction label="Resolve" confirmLabel="Mark resolved" minLength={5} prompt="What did you check, and what was done? (saved to the audit log)" onSubmit={n => api.resolveFinding(f.id, n)} onDone={m => { setMsg(m); reload(); }} /> : <span>{f.resolvedNote} <span className="muted">({when(f.resolvedAt)})</span></span>}</td></tr>))}</tbody></table>)}
    {!loading && rows.length === 0 ? <p className="muted">Nothing {show === 'OPEN' ? 'open' : 'resolved'}.</p> : null}
  </section>);
}

export function Audit({ api }: { api: AdminApi }) {
  const { data, error, loading } = useLoad(() => api.audit(), []);
  return (<section aria-labelledby="h-aud"><h1 id="h-aud">Audit log</h1><p className="muted">Most recent 300 actions. Entries cannot be edited or deleted.</p><Err message={error} />
    {loading && !data ? <Loading /> : (<table><caption className="sr-only">Audit log</caption><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Reason</th></tr></thead>
      <tbody>{(data ?? []).map((a, i) => <tr key={i}><td>{when(a.at)}</td><td className="mono">{shortId(a.actorId)}</td><td>{a.action.replace(/_/g, ' ').toLowerCase()}</td><td className="mono">{shortId(a.targetId)}</td><td>{a.reason}</td></tr>)}</tbody></table>)}</section>);
}
