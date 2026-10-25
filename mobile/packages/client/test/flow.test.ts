import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { DriverController, RiderController, driverPhase, riderPhase, ClientConfig } from '../src';
import { A, B, FakeLocation, MemoryTokenStore, TestServer, fakePlatform, idFromToken, startServer, waitFor, SECRET } from './harness';
import { FakeProvider } from '../../../../apps/api/src/domain/payments/fakeProvider';

let srv: TestServer; let n = 0; const live: { stop(): void }[] = []; const driverIds: string[] = [];
beforeAll(async () => { srv = await startServer(); });
// Each test must leave the shared server with nothing in flight, or a stale ride could be re-offered to a later test's driver.
afterEach(async () => { driverIds.length = 0; await srv.resetWorld(); });
afterAll(async () => { live.forEach(c => c.stop()); await srv.stop(); });
const cfg = (extra: Partial<ClientConfig> = {}): ClientConfig => ({ baseUrl: srv.baseUrl, pollMs: 60_000, ...extra });   // slow polling: these tests prove the REALTIME path
const num = () => { n++; return { driver: `98100${String(n).padStart(5, '0')}`, rider: `98200${String(n).padStart(5, '0')}` }; };

async function newDriver(phone: string, reg: string, opts: { approve?: boolean; fp?: ReturnType<typeof fakePlatform> } = {}) {
  const fp = opts.fp ?? fakePlatform(); const c = new DriverController(fp.platform, cfg(), 0); live.push(c);
  await c.start(); expect(driverPhase(c.store.get())).toBe('LOGIN');
  expect(await c.requestOtp(phone)).toBe(true); expect(await c.verifyOtp(srv.otpFor(phone))).toBe(true);
  expect(driverPhase(c.store.get())).toBe('ONBOARDING'); expect(await c.onboard(reg)).toBe(true); expect(driverPhase(c.store.get())).toBe('PENDING_APPROVAL');
  driverIds.push(idFromToken(fp.store.t!.accessToken));
  if (opts.approve !== false) { await srv.approve(idFromToken(fp.store.t!.accessToken)); await c.refreshStatus(); expect(driverPhase(c.store.get())).toBe('OFFLINE'); }
  return { c, fp };
}
async function newRider(phone: string, fp = fakePlatform(), extra: Partial<ClientConfig> = {}) {
  const c = new RiderController(fp.platform, cfg(extra)); live.push(c); await c.start();
  expect(await c.requestOtp(phone)).toBe(true); expect(await c.verifyOtp(srv.otpFor(phone))).toBe(true); return { c, fp };
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('rider + driver apps against the real server', () => {
  it('a full UPI trip: book, realtime offer, accept, drive, complete, pay in UPI app, confirmed by the provider', async () => {
    const p = num(); const { c: driver, fp: dfp } = await newDriver(p.driver, 'MH 31 AB 1001');
    expect(await driver.goOnline()).toBe(true); expect(driverPhase(driver.store.get())).toBe('ONLINE'); expect(driver.store.get().gps).toBe('OK');
    const { c: rider, fp: rfp } = await newRider(p.rider);

    expect(await rider.getQuote(A, B)).toBe(true); const q = rider.store.get().quote!; expect(q.fare.totalMinor).toBeGreaterThan(0); expect(riderPhase(rider.store.get())).toBe('QUOTE');
    expect(await rider.book('UPI')).toBe(true); expect(riderPhase(rider.store.get())).toBe('SEARCHING');

    const offer = await waitFor(() => driver.store.get().offers[0], 5000, 'offer pushed to driver');          // arrives by socket (polling is 60s)
    expect(offer.pickup).toEqual(A); expect(await driver.accept(offer.id)).toBe(true); expect(driverPhase(driver.store.get())).toBe('ACTIVE_RIDE');
    const dr = driver.store.get().ride!; expect(dr.destination).toEqual(B); expect(dr.vehicle).toBeNull();

    await waitFor(() => riderPhase(rider.store.get()) === 'DRIVER_COMING', 5000, 'rider sees driver coming');
    expect(rider.store.get().ride!.vehicle).toEqual({ category: 'AUTO', registration: 'MH31AB1001' });

    dfp.location.emit({ lat: 21.147, lng: 79.09 });                                                            // live tracking, rider only
    await waitFor(() => rider.store.get().driverLocation?.lat === 21.147, 5000, 'live location');
    for (const step of ['en-route', 'arrive', 'start'] as const) expect(await driver.advance(step)).toBe(true);
    await waitFor(() => riderPhase(rider.store.get()) === 'ON_TRIP', 5000, 'rider on trip');
    expect(await driver.advance('complete')).toBe(true); expect(driverPhase(driver.store.get())).toBe('SUMMARY');

    await waitFor(() => riderPhase(rider.store.get()) === 'PAY', 5000, 'rider asked to pay');
    const pay = rider.store.get().payment!; expect(pay.status).toBe('REQUIRES_ACTION'); expect(pay.amountMinor).toBe(q.fare.totalMinor);
    expect(driver.store.get().completed!.payment?.intent ?? null).toBeNull();                                  // the driver never gets the UPI intent
    expect(await rider.payNow()).toBe(true); expect(rfp.opened[0]).toMatch(/^upi:\/\/pay\?/);

    const ref = new URL(pay.intent!.upiUri).searchParams.get('tr')!;                                           // the customer pays in their UPI app...
    expect((await srv.webhook(new FakeProvider({ secret: SECRET, now: Date.now }).signedEvent({ type: 'payment.succeeded', providerRef: ref, amountMinor: pay.amountMinor }))).status).toBe(200);
    await waitFor(() => riderPhase(rider.store.get()) === 'DONE', 5000, 'payment confirmed on rider screen');  // ...and the server, not the app, confirms it
    await waitFor(() => driver.store.get().completed?.payment?.status === 'SUCCEEDED', 5000, 'driver sees paid');
    rider.dismiss(); expect(riderPhase(rider.store.get())).toBe('HOME'); await waitFor(() => rider.store.get().history[0]?.status === 'COMPLETED', 3000, 'history');
    driver.dismissSummary(); expect(driverPhase(driver.store.get())).toBe('ONLINE');
  });

  it('a dropped connection during booking can never create two rides (idempotency key survives the retry)', async () => {
    const p = num(); const { c: driver } = await newDriver(p.driver, 'MH 31 AB 1002'); await driver.goOnline();
    let dropped = false; const flaky = (async (url: string, init: any) => { const res = await fetch(url, init); if (!dropped && init?.method === 'POST' && String(url).endsWith('/rides')) { dropped = true; throw new TypeError('connection lost after server processed it'); } return res; }) as any;
    const { c: rider } = await newRider(p.rider, fakePlatform(), { fetchImpl: flaky });
    await rider.getQuote(A, B); expect(await rider.book('CASH')).toBe(false); expect(rider.store.get().error).toMatch(/connection/i); expect(rider.store.get().quote).not.toBeNull(); // user can simply retry
    const key = rider.store.get().bookingKey; expect(key).toBeTruthy();
    expect(await rider.book('CASH')).toBe(true); expect(rider.store.get().bookingKey).toBeNull();
    expect((await rider.api.rides()).length).toBe(1);                                                          // exactly one ride exists
    expect((await rider.api.rides())[0]!.id).toBe(rider.store.get().ride!.id);
  });

  it('killing and reopening BOTH apps mid-trip resumes exactly where they were', async () => {
    const p = num(); const { c: d1, fp: dfp } = await newDriver(p.driver, 'MH 31 AB 1003'); await d1.goOnline();
    const { c: r1, fp: rfp } = await newRider(p.rider); await r1.getQuote(A, B); await r1.book('CASH');
    const offer = await waitFor(() => d1.store.get().offers[0]); await d1.accept(offer.id); await d1.advance('en-route');
    d1.stop(); r1.stop();                                                                                      // "swipe away" both apps

    const rider2 = new RiderController(rfp.platform, cfg()); live.push(rider2); await rider2.start();          // same storage = same phone
    expect(rider2.store.get().auth).toBe('LOGGED_IN'); expect(riderPhase(rider2.store.get())).toBe('DRIVER_COMING'); expect(rider2.store.get().ride!.status).toBe('DRIVER_ARRIVING');
    const drv2 = new DriverController(dfp.platform, cfg(), 0); live.push(drv2); await drv2.start();
    expect(driverPhase(drv2.store.get())).toBe('ACTIVE_RIDE'); expect(drv2.store.get().ride!.status).toBe('DRIVER_ARRIVING'); expect(drv2.store.get().online).toBe(true); expect(dfp.location.watching).toBeGreaterThanOrEqual(1);
    await drv2.advance('arrive'); await waitFor(() => rider2.store.get().ride!.status === 'DRIVER_ARRIVED', 5000, 'resumed rider receives live updates');
    // location sequence numbers still increase after a restart (otherwise the server would silently ignore the driver)
    const before = (await srv.db.tx(r => r.getDriver(idFromToken(dfp.store.t!.accessToken))))!.lastLocationAt; await sleep(30); await drv2.pushFix({ lat: 21.147, lng: 79.09, accuracyMeters: 5, at: Date.now() }, true);
    expect((await srv.db.tx(r => r.getDriver(idFromToken(dfp.store.t!.accessToken))))!.lastLocationAt).toBeGreaterThan(before);
  });

  it('missed events while offline are recovered on reconnect (the socket is only a hint; REST is truth)', async () => {
    const p = num(); const { c: driver } = await newDriver(p.driver, 'MH 31 AB 1004'); await driver.goOnline();
    const { c: rider } = await newRider(p.rider); await rider.getQuote(A, B); await rider.book('CASH');
    const offer = await waitFor(() => driver.store.get().offers[0]); await driver.accept(offer.id);
    await waitFor(() => rider.store.get().ride?.status === 'DRIVER_ASSIGNED');
    rider.realtime.stop(); expect(rider.store.get().connection).toBe('DISCONNECTED');                         // tunnel / dead zone
    await driver.advance('en-route'); await driver.advance('arrive'); await sleep(400);
    expect(rider.store.get().ride!.status).toBe('DRIVER_ASSIGNED');                                           // stale while offline, as expected
    rider.realtime.start();
    await waitFor(() => rider.store.get().ride!.status === 'DRIVER_ARRIVED', 6000, 'resync after reconnect'); expect(riderPhase(rider.store.get())).toBe('DRIVER_ARRIVED');
  });

  it('rider cancels while searching: the driver\'s offer disappears; cancelling after assignment tells the driver', async () => {
    const p = num(); const { c: driver } = await newDriver(p.driver, 'MH 31 AB 1005'); await driver.goOnline();
    const { c: rider } = await newRider(p.rider); await rider.getQuote(A, B); await rider.book('CASH');
    await waitFor(() => driver.store.get().offers[0]); expect(await rider.cancel()).toBe(true); expect(riderPhase(rider.store.get())).toBe('ENDED');
    await waitFor(() => driver.store.get().offers.length === 0, 5000, 'offer withdrawn');

    await rider.dismiss(); await rider.getQuote(A, B); await rider.book('CASH'); const o2 = await waitFor(() => driver.store.get().offers[0]); await driver.accept(o2.id);
    await waitFor(() => rider.store.get().ride?.status === 'DRIVER_ASSIGNED'); await rider.cancel();
    await waitFor(() => driverPhase(driver.store.get()) === 'ONLINE' && driver.store.get().notice, 5000, 'driver told the rider cancelled'); expect(driver.store.get().notice).toMatch(/cancelled/i);
  });

  it('guards: unapproved driver cannot go online; denied location permission keeps the driver offline', async () => {
    const p = num(); const { c: pending } = await newDriver(p.driver, 'MH 31 AB 1006', { approve: false });
    expect(await pending.goOnline()).toBe(false); expect(pending.store.get().online).toBe(false); expect(pending.store.get().error).toBeTruthy();
    const p2 = num(); const fp = fakePlatform(); fp.location.granted = false; const { c: d2 } = await newDriver(p2.driver, 'MH 31 AB 1007', { fp });
    expect(await d2.goOnline()).toBe(false); expect(d2.store.get().gps).toBe('DENIED'); expect(d2.store.get().online).toBe(false);
  });

  it('input and login errors are friendly and never reach the server when obviously wrong', async () => {
    const fp = fakePlatform(); const c = new RiderController(fp.platform, cfg()); live.push(c); await c.start();
    expect(await c.requestOtp('12345')).toBe(false); expect(c.store.get().error).toMatch(/valid 10-digit/i);
    const ph = num().rider; expect(await c.requestOtp(ph)).toBe(true); expect(await c.verifyOtp('000000')).toBe(false); expect(c.store.get().error).toMatch(/wrong or has expired/i);
    expect(await c.verifyOtp('12')).toBe(false); expect(await c.verifyOtp(srv.otpFor(ph))).toBe(true); expect(c.store.get().auth).toBe('LOGGED_IN');
  });

  it('a suspended account is signed out of the app cleanly', async () => {
    const { c: rider, fp } = await newRider(num().rider); const id = idFromToken(fp.store.t!.accessToken);
    await srv.db.tx(async r => { await r.setUserStatus(id, 'SUSPENDED'); await r.revokeUserSessions(id); });   // what the admin suspend action does
    expect(await rider.getQuote(A, B)).toBe(false);
    await waitFor(() => rider.store.get().auth === 'LOGGED_OUT', 4000, 'signed out'); expect(fp.store.t).toBeNull();
  });
});
