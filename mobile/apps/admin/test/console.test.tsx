// @vitest-environment jsdom
import React from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, within, waitFor } from '@testing-library/react';
import { DriverController, RiderController, formatINR } from '@rides/client';
import { FakeProvider } from '../../../../apps/api/src/domain/payments/fakeProvider';
import { SECRET, TestServer, fakePlatform, idFromToken, startServer } from '../../../packages/client/test/harness';
import { AdminApi, sessionTokenStore } from '../src/api';
import { ConsoleApp } from '../src/App';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let srv: TestServer; const T = { timeout: 8000 };
const STAFF = { support: '9000000002', ops: '9000000005',   // (…01 is used by the test harness to approve drivers, so it is rate-limited)
   finance: '9000000003', root: '9000000004' } as const; type R = keyof typeof STAFF;
let world: { rideId: string; fare: number; riderPhone: string; driverPhone: string; pendingReg: string };

beforeAll(async () => {
  srv = await startServer();
  // --- a realistic world, created through the real apps' logic: an approved driver with a completed, UPI-paid ride, and a driver awaiting approval ---
  const dfp = fakePlatform(); const d = new DriverController(dfp.platform, { baseUrl: srv.baseUrl, pollMs: 60_000 }, 0); await d.start();
  await d.requestOtp('9890000001'); await d.verifyOtp(srv.otpFor('9890000001')); await d.onboard('MH 31 AB 5001'); await srv.approve(idFromToken(dfp.store.t!.accessToken)); await d.refreshStatus(); await d.goOnline();
  const rfp = fakePlatform(); const r = new RiderController(rfp.platform, { baseUrl: srv.baseUrl, pollMs: 60_000 }); await r.start(); await r.requestOtp('9891000001'); await r.verifyOtp(srv.otpFor('9891000001'));
  await r.getQuote({ lat: 21.1458, lng: 79.0882 }, { lat: 21.1, lng: 79.05 }); await r.book('UPI');
  for (let i = 0; i < 100 && !d.store.get().offers[0]; i++) await new Promise(x => setTimeout(x, 40)); await d.accept(d.store.get().offers[0]!.id);
  for (const s of ['en-route', 'arrive', 'start', 'complete'] as const) await d.advance(s);
  for (let i = 0; i < 100 && !r.store.get().payment?.intent; i++) await new Promise(x => setTimeout(x, 40));
  const pay = r.store.get().payment!; const ref = new URL(pay.intent!.upiUri).searchParams.get('tr')!;
  await srv.webhook(new FakeProvider({ secret: SECRET, now: Date.now }).signedEvent({ type: 'payment.succeeded', providerRef: ref, amountMinor: pay.amountMinor }));
  world = { rideId: r.store.get().ride!.id, fare: pay.amountMinor, riderPhone: '+919891000001', driverPhone: '+919890000001', pendingReg: 'MH31AB5002' };
  d.stop(); r.stop(); await srv.db.tx(async x => { const dr = await x.getDriver(idFromToken(dfp.store.t!.accessToken)); if (dr) await x.saveDriver({ ...dr, online: false }); });
  const pfp = fakePlatform(); const p = new DriverController(pfp.platform, { baseUrl: srv.baseUrl, pollMs: 60_000 }, 0); await p.start(); await p.requestOtp('9890000002'); await p.verifyOtp(srv.otpFor('9890000002')); await p.onboard('MH 31 AB 5002'); p.stop();
});
afterEach(() => { cleanup(); document.body.innerHTML = ''; window.location.hash = '#/'; });
afterAll(async () => { cleanup(); await srv.stop(); });

const sessions = new Set<R>();
function open(role: R, idleMs?: number) {
  const api = new AdminApi(srv.baseUrl, sessionTokenStore(`test-session-${role}`)); const el = document.createElement('div'); document.body.appendChild(el);
  render(<ConsoleApp api={api} idleMs={idleMs} />, { container: el }); return { api, q: within(el), el };
}
const go = async (hash: string) => { window.location.hash = hash; await new Promise(r => setTimeout(r, 30)); };
async function signInViaScreen(role: R) {
  const s = open(role); await s.q.findByRole('heading', { name: 'Staff console' }, T);
  fireEvent.change(await s.q.findByLabelText('Mobile number'), { target: { value: STAFF[role] } }); fireEvent.click(await s.q.findByRole('button', { name: 'Send code' }));
  const code = await s.q.findByLabelText('6-digit code', undefined, T); fireEvent.change(code, { target: { value: srv.otpFor(STAFF[role]) } }); fireEvent.click(await s.q.findByRole('button', { name: 'Verify and sign in' }));
  await s.q.findByRole('heading', { name: 'Overview' }, T); sessions.add(role); return s;
}
const nav = (s: ReturnType<typeof open>) => within(s.q.getByRole('navigation', { name: 'Main' })).getAllByRole('link').map(a => a.textContent);

describe('staff console', () => {
  it('each role signs in through the screen and sees only its own navigation', async () => {
    const expected: Record<R, string[]> = { support: ['Overview', 'Drivers', 'Rides'], ops: ['Overview', 'Drivers', 'Rides', 'Audit log'], finance: ['Overview', 'Rides', 'Reconciliation', 'Audit log'], root: ['Overview', 'Drivers', 'Rides', 'Reconciliation', 'Audit log'] };
    for (const role of ['support', 'ops', 'finance', 'root'] as R[]) { const s = await signInViaScreen(role); expect(nav(s), role).toEqual(expected[role]); cleanup(); document.body.innerHTML = ''; }
  });

  it('a rider account cannot use the console: it is refused with a clear message and its session is discarded', async () => {
    await srv.post('/api/v1/auth/otp/request', null, { phone: '9893000001' }); const v = await srv.post('/api/v1/auth/otp/verify', null, { phone: '9893000001', code: srv.otpFor('9893000001'), role: 'RIDER' });
    const store = sessionTokenStore('test-session-rider'); await store.save({ accessToken: v.body.data.accessToken, refreshToken: v.body.data.refreshToken });   // a perfectly valid RIDER login
    const api = new AdminApi(srv.baseUrl, store); const el = document.createElement('div'); document.body.appendChild(el); const q = within(el); render(<ConsoleApp api={api} />, { container: el });
    await q.findByText('This account is not authorised for the staff console.', undefined, T); await q.findByRole('heading', { name: 'Staff console' }); expect(await store.load()).toBeNull();
    expect(q.queryByRole('navigation')).toBeNull();
  });

  it('driver approvals: reasons are mandatory, support sees masked phones and no buttons, ops can approve, suspend and reinstate', async () => {
    const sup = open('support'); await go('#/drivers'); await sup.q.findByRole('heading', { name: 'Drivers' }, T);
    const row = (await sup.q.findByText(world.pendingReg, undefined, T)).closest('tr')!; expect(row.textContent).toContain('+91 98•••••002'); expect(row.textContent).not.toContain('9890000002'); expect(within(row).queryByRole('button')).toBeNull();
    cleanup(); document.body.innerHTML = '';

    const ops = open('ops'); await go('#/drivers'); const r2 = (await ops.q.findByText(world.pendingReg, undefined, T)).closest('tr')!; expect(r2.textContent).toContain('+919890000002');
    fireEvent.click(within(r2).getByRole('button', { name: 'Approve' })); const form = await ops.q.findByRole('form', { name: 'Approve' }, T);
    fireEvent.click(within(form).getByRole('button', { name: 'Approve driver' })); await within(form).findByText('Please write at least 3 characters.');           // empty reason refused
    expect((await srv.db.tx(r => r.listProfiles())).find(p => p.registration === world.pendingReg)!.verification).toBe('PENDING');
    fireEvent.change(within(form).getByLabelText(/Why approve MH31AB5002/), { target: { value: 'Documents verified at office' } }); fireEvent.click(within(form).getByRole('button', { name: 'Approve driver' }));
    await ops.q.findByText('Approve driver: done.', undefined, T); await waitFor(() => expect(ops.q.queryByText(world.pendingReg)).toBeNull(), T);                 // leaves the "awaiting approval" list
    expect((await srv.db.tx(r => r.listProfiles())).find(p => p.registration === world.pendingReg)!.verification).toBe('APPROVED');

    fireEvent.change(ops.q.getByLabelText('Verification'), { target: { value: 'APPROVED' } }); const r3 = (await ops.q.findByText(world.pendingReg, undefined, T)).closest('tr')!;
    fireEvent.click(within(r3).getByRole('button', { name: 'Suspend' })); const sf = await ops.q.findByRole('form', { name: 'Suspend' }, T);
    fireEvent.change(within(sf).getByLabelText(/Why suspend/), { target: { value: 'Rider complaint under review' } }); fireEvent.click(within(sf).getByRole('button', { name: 'Suspend account' }));
    await waitFor(() => expect(within((ops.q.getByText(world.pendingReg)).closest('tr')!).getByText('suspended')).toBeTruthy(), T);
    const r4 = ops.q.getByText(world.pendingReg).closest('tr')!; fireEvent.click(within(r4).getByRole('button', { name: 'Reinstate' })); const rf = await ops.q.findByRole('form', { name: 'Reinstate' }, T);
    fireEvent.change(within(rf).getByLabelText(/Why reinstate/), { target: { value: 'Complaint dismissed' } }); fireEvent.click(within(rf).getByRole('button', { name: 'Reinstate account' }));
    await waitFor(() => expect(within(ops.q.getByText(world.pendingReg).closest('tr')!).queryByText('suspended')).toBeNull(), T);
  });

  it('ride dispute view: search, timeline, payment, ledger balance, validated refunds; support cannot refund', async () => {
    const fin = open('finance'); await go('#/rides'); await fin.q.findByRole('heading', { name: 'Rides' }, T);
    fireEvent.change(fin.q.getByLabelText(/Search/), { target: { value: world.riderPhone.slice(-6) } });
    const link = await fin.q.findByRole('link', { name: /Open ride/ }, T); const rrow = link.closest('tr')!; expect(rrow.textContent).toContain('+91 98•••••001'); expect(rrow.textContent).toContain(formatINR(world.fare)); fireEvent.click(link);
    await fin.q.findByRole('heading', { name: /^Ride / }, T); await fin.q.findByText('completed', { selector: 'span.pill' }, T); expect(fin.q.getAllByText(/driver assigned|in progress|completed/).length).toBeGreaterThanOrEqual(3);
    await fin.q.findByText(new RegExp(`Debits equal credits \\(${formatINR(world.fare).replace(/[₹.,]/g, m => '\\' + m)}\\)`), undefined, T);

    fireEvent.click(await fin.q.findByRole('button', { name: 'Refund rider' })); const form = await fin.q.findByRole('form', { name: 'Refund rider' }, T);
    fireEvent.change(within(form).getByLabelText(/Amount in rupees/), { target: { value: '12.345' } }); await within(form).findByText('Enter an amount like 25 or 25.50.');
    fireEvent.change(within(form).getByLabelText(/Amount in rupees/), { target: { value: '99999' } }); await within(form).findByText('That is more than is left to refund.');
    fireEvent.change(within(form).getByLabelText(/Amount in rupees/), { target: { value: '10' } }); fireEvent.change(within(form).getByLabelText(/Why is this refund/), { target: { value: 'Driver took a detour' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Issue refund' })); await fin.q.findByText('Issue refund: done.', undefined, T);
    await fin.q.findByText(/refunded ₹10\.00/, undefined, T); await fin.q.findByText('Driver took a detour'); await fin.q.findByText(/Debits equal credits/);
    cleanup(); document.body.innerHTML = '';

    const sup = open('support'); await go(`#/rides/${world.rideId}`); await sup.q.findByRole('heading', { name: /^Ride / }, T); await sup.q.findByText(/refunded ₹10\.00/, undefined, T);
    expect(sup.q.queryByRole('button', { name: 'Refund rider' })).toBeNull(); expect(sup.el.textContent).toContain('+91 98•••••001'); expect(sup.el.textContent).not.toContain('9891000001');
  });

  it('reconciliation: run, see the finding, resolve it with a real note; ops cannot open the page', async () => {
    srv.provider.injectOrphan(777); const fin = open('finance'); await go('#/finance'); await fin.q.findByRole('heading', { name: 'Reconciliation' }, T);
    fireEvent.click(fin.q.getByRole('button', { name: 'Run reconciliation now' })); await fin.q.findByText(/new finding/, undefined, T);
    const row = (await fin.q.findByText('orphan at provider', undefined, T)).closest('tr')!; fireEvent.click(within(row).getByRole('button', { name: 'Resolve' }));
    const form = await fin.q.findByRole('form', { name: 'Resolve' }, T); fireEvent.change(within(form).getByLabelText(/What did you check/), { target: { value: 'ok' } }); fireEvent.click(within(form).getByRole('button', { name: 'Mark resolved' }));
    await within(form).findByText('Please write at least 5 characters.');
    fireEvent.change(within(form).getByLabelText(/What did you check/), { target: { value: 'Matched to a manual payment in the gateway dashboard' } }); fireEvent.click(within(form).getByRole('button', { name: 'Mark resolved' }));
    await fin.q.findByText('Mark resolved: done.', undefined, T); await waitFor(() => expect(fin.q.queryByText('orphan at provider')).toBeNull(), T);
    fireEvent.change(fin.q.getByLabelText('Show'), { target: { value: 'RESOLVED' } }); await fin.q.findByText(/Matched to a manual payment/, undefined, T);
    cleanup(); document.body.innerHTML = '';
    const ops = open('ops'); await go('#/finance'); await ops.q.findByRole('heading', { name: 'Not available' }, T); expect(ops.q.queryByRole('link', { name: 'Reconciliation' })).toBeNull();
  });

  it('the audit log shows who did what and why, including viewing a ride', async () => {
    const root = open('root'); await go('#/audit'); await root.q.findByRole('heading', { name: 'Audit log' }, T);
    for (const t of ['Documents verified at office', 'Rider complaint under review', 'Complaint dismissed', 'Driver took a detour', 'Matched to a manual payment in the gateway dashboard', 'staff ride lookup']) await root.q.findAllByText(t, undefined, T);
    for (const a of ['driver review', 'suspend', 'reinstate', 'refund requested', 'finding resolved', 'view ride']) expect(root.q.getAllByText(a).length, a).toBeGreaterThan(0);
  });

  it('signs staff out after a period of inactivity', async () => {
    const s = open('support', 300); await s.q.findByRole('heading', { name: 'Overview' }, T);
    await s.q.findByRole('heading', { name: 'Staff console' }, T); await s.q.findByText('You were signed out after a period of inactivity.');
  });

  it('when the server ends the session (account suspended) the next action returns to the sign-in screen', async () => {
    const fin = open('finance'); await go('#/finance'); await fin.q.findByRole('heading', { name: 'Reconciliation' }, T);
    const id = idFromToken((await sessionTokenStore('test-session-finance').load())!.accessToken); await srv.db.tx(async r => { await r.setUserStatus(id, 'SUSPENDED'); await r.revokeUserSessions(id); });
    fireEvent.click(fin.q.getByRole('button', { name: 'Run reconciliation now' })); await fin.q.findByRole('heading', { name: 'Staff console' }, T); await fin.q.findByText('Your session has ended. Please sign in again.');
  });

  it('sign-out ends the session and returns to the login screen', async () => {      // last: it consumes the root session
    const s = open('root'); await s.q.findByRole('heading', { name: 'Overview' }, T); fireEvent.click(s.q.getByRole('button', { name: 'Sign out' }));
    await s.q.findByRole('heading', { name: 'Staff console' }, T); expect(await sessionTokenStore('test-session-root').load()).toBeNull();
  });
});
