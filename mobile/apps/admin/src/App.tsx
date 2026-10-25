import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { isOtp, parsePhone, userMessage, ApiError } from '@rides/client';
import { AdminApi, adminMessage } from './api';
import { Audit, Dashboard, Drivers, Finance, RideDetailPage, Rides } from './pages';
import { useHash, useIdle } from './hooks';
import { Err, Loading } from './ui';
import { can, PERMS, Role } from './types';

function Login({ api, onIn, notice }: { api: AdminApi; onIn: () => void; notice: string | null }) {
  const [phone, setPhone] = useState(''); const [code, setCode] = useState(''); const [sent, setSent] = useState<string | null>(null); const [err, setErr] = useState<string | null>(notice); const [busy, setBusy] = useState(false);
  const go = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(adminMessage(e)); } finally { setBusy(false); } };
  return (<main className="login"><h1>Staff console</h1><p className="muted">Sign in with your staff mobile number.</p><Err message={err} />
    {!sent ? (<form onSubmit={e => { e.preventDefault(); void go(async () => { const p = parsePhone(phone); if (!p) throw new ApiError(400, 'INVALID_PHONE', ''); await api.requestOtp(p); setSent(p); }); }}>
      <label className="field"><span>Mobile number</span><input value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" autoFocus /></label><button className="btn btn-primary" disabled={busy}>Send code</button></form>)
      : (<form onSubmit={e => { e.preventDefault(); void go(async () => { if (!isOtp(code)) throw new ApiError(401, 'OTP_INVALID', ''); await api.verifyOtp(sent, code); onIn(); }); }}>
        <p>We sent a 6-digit code to +91 {sent}.</p><label className="field"><span>6-digit code</span><input value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus /></label>
        <div className="row"><button className="btn btn-primary" disabled={busy || code.length !== 6}>Verify and sign in</button><button type="button" className="btn" onClick={() => { setSent(null); setCode(''); }}>Different number</button></div></form>)}
  </main>);
}

const NAV: { href: string; label: string; show: (r: Role) => boolean }[] = [
  { href: '#/', label: 'Overview', show: () => true }, { href: '#/drivers', label: 'Drivers', show: r => can(r, PERMS.drivers) }, { href: '#/rides', label: 'Rides', show: r => can(r, PERMS.rides) },
  { href: '#/finance', label: 'Reconciliation', show: r => can(r, PERMS.finance) }, { href: '#/audit', label: 'Audit log', show: r => can(r, PERMS.audit) },
];
const ROLE_LABEL: Record<Role, string> = { SUPPORT: 'Support', OPS_ADMIN: 'Operations', FINANCE_ADMIN: 'Finance', SUPER_ADMIN: 'Administrator' };

export function ConsoleApp({ api, idleMs = 15 * 60_000 }: { api: AdminApi; idleMs?: number }) {
  const [phase, setPhase] = useState<'LOADING' | 'OUT' | 'IN'>('LOADING'); const [role, setRole] = useState<Role | null>(null); const [notice, setNotice] = useState<string | null>(null); const hash = useHash();
  const signOut = useCallback(async (msg: string | null = null) => { await api.logout(); setRole(null); setNotice(msg); setPhase('OUT'); window.location.hash = '#/'; }, [api]);
  const enter = useCallback(async () => {
    try { const me = await api.me(); setRole(me.role); setPhase('IN'); }
    catch (e) { const forbidden = e instanceof ApiError && e.code === 'FORBIDDEN'; if (forbidden) await signOut('This account is not authorised for the staff console.'); else if (e instanceof ApiError && e.isNetwork) { setNotice(userMessage(e)); setPhase('OUT'); } else await signOut(adminMessage(e)); }
  }, [api, signOut]);
  useEffect(() => { api.onExpired(() => { setRole(null); setNotice('Your session has ended. Please sign in again.'); setPhase('OUT'); window.location.hash = '#/'; }); }, [api]);
  useEffect(() => { void (async () => { if (await api.hasSession()) await enter(); else setPhase('OUT'); })(); }, [api, enter]);
  useIdle(idleMs, () => void signOut('You were signed out after a period of inactivity.'), phase === 'IN');
  if (phase === 'LOADING') return <Loading />;
  if (phase === 'OUT' || !role) return <Login api={api} onIn={() => void enter()} notice={notice} />;
  const rideId = /^\/rides\/([0-9a-f-]{36})$/i.exec(hash)?.[1];
  let page: React.ReactNode;
  if (hash === '/') page = <Dashboard api={api} role={role} />;
  else if (hash.startsWith('/drivers') && can(role, PERMS.drivers)) page = <Drivers api={api} role={role} />;
  else if (rideId) page = <RideDetailPage api={api} role={role} id={rideId} />;
  else if (hash.startsWith('/rides')) page = <Rides api={api} />;
  else if (hash.startsWith('/finance') && can(role, PERMS.finance)) page = <Finance api={api} />;
  else if (hash.startsWith('/audit') && can(role, PERMS.audit)) page = <Audit api={api} />;
  else page = <section><h1>Not available</h1><p>That page does not exist, or your role cannot open it.</p></section>;
  return (<><a className="skip" href="#main">Skip to content</a>
    <header className="top"><strong>Nagpur Rides · Staff</strong><nav aria-label="Main">{NAV.filter(n => n.show(role)).map(n => <a key={n.href} href={n.href} aria-current={(n.href === '#/' ? hash === '/' : hash.startsWith(n.href.slice(1))) ? 'page' : undefined}>{n.label}</a>)}</nav>
      <span className="who">{ROLE_LABEL[role]} <button type="button" className="btn" onClick={() => void signOut()}>Sign out</button></span></header>
    <main id="main" tabIndex={-1}>{page}</main></>);
}
