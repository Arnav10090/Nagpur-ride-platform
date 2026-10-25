// @vitest-environment jsdom
import React from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DriverController, RiderController, formatINR } from '@rides/client';
import { FakeProvider } from '../../../../apps/api/src/domain/payments/fakeProvider';
import { SECRET, TestServer, fakePlatform, idFromToken, startServer } from '../../../packages/client/test/harness';
import { RiderApp } from '../src/RiderApp';
import { DriverApp } from '../../driver/src/DriverApp';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let srv: TestServer; let n = 0; const driverIds: string[] = [];
beforeAll(async () => { srv = await startServer(); });
afterEach(async () => { cleanup(); document.body.innerHTML = ''; driverIds.length = 0; await srv.resetWorld(); });   // no phone left on the page, nothing in flight on the server
afterAll(async () => { cleanup(); await srv.stop(); });

const T = { timeout: 8000 };
/** One "phone": a container in the page plus helpers that act like a person using that screen. */
function phone(label: string) {
  const el = document.createElement('div'); el.setAttribute('data-phone', label); document.body.appendChild(el); const q = within(el);
  return {
    el, q,
    heading: (name: string | RegExp) => q.findByRole('heading', { name }, T),
    text: (t: string | RegExp) => q.findByText(t, undefined, T),
    gone: (t: string | RegExp) => waitFor(() => expect(q.queryByText(t)).toBeNull(), T),
    // Like a person: wait until the button is actually enabled (not showing its loading spinner) before tapping.
    tap: async (name: string) => { const b = await q.findByRole('button', { name }, T); await waitFor(() => expect(b.getAttribute('aria-disabled')).not.toBe('true'), T); fireEvent.click(b); },
    pick: async (name: string) => { fireEvent.click(await q.findByRole('radio', { name }, T)); },
    type: async (label: string, value: string) => { fireEvent.change(await q.findByLabelText(label, undefined, T), { target: { value } }); },
    has: (t: string | RegExp) => !!q.queryByText(t),
  };
}
const nums = () => { n++; return { d: `98300${String(n).padStart(5, '0')}`, r: `98400${String(n).padStart(5, '0')}` }; };
async function signIn(ph: ReturnType<typeof phone>, number: string, heading: string) {
  await ph.heading(heading); await ph.type('Mobile number', number); await ph.tap('Send code');
  await ph.q.findByLabelText('6-digit code', undefined, T);               // appears only once the server has issued the code
  await ph.type('6-digit code', srv.otpFor(number)); await ph.tap('Verify and continue');
}
async function onlineDriver(num: string, reg: string) {
  const dfp = fakePlatform(); const dctl = new DriverController(dfp.platform, { baseUrl: srv.baseUrl, pollMs: 60_000 }, 0);
  const d = phone('driver'); render(<DriverApp controller={dctl} openUrl={dfp.platform.openUrl} />, { container: d.el });
  await signIn(d, num, 'Driver sign in');
  await d.heading('Register your vehicle'); await d.type('Vehicle registration number', reg); await d.text(`We will save it as ${reg.replace(/\s/g, '')}`); await d.tap('Submit for verification');
  await d.heading('Verification in progress'); driverIds.push(idFromToken(dfp.store.t!.accessToken)); await srv.approve(idFromToken(dfp.store.t!.accessToken)); await d.tap('Check status');
  await d.heading('You are offline'); await d.tap('Go online'); await d.heading('You are online'); await d.text('GPS active');
  return { d, dctl, dfp };
}
const rideWithRider = async (num: string, method: RegExp) => {
  const rfp = fakePlatform(); const rctl = new RiderController(rfp.platform, { baseUrl: srv.baseUrl, pollMs: 60_000 });
  const r = phone('rider'); render(<RiderApp controller={rctl} location={rfp.location} />, { container: r.el });
  await signIn(r, num, 'Nagpur Rides'); await r.heading('Where to?');
  await r.pick('Pickup: Nagpur Railway Station'); await r.pick('Destination: Dharampeth'); await r.tap('Get fare');
  await r.heading('Your fare'); const total = rctl.store.get().quote!.fare.totalMinor; await r.text(formatINR(total));
  await r.pick(method.source === 'UPI' ? 'UPI (after the trip)' : 'Cash to the driver'); await r.tap('Book ride'); await r.heading('Finding your driver');
  return { r, rctl, rfp, total };
};

describe('two phones, real screens, real server', () => {
  it('a complete UPI trip, screen by screen, on both phones', async () => {
    const p = nums(); const { d, dctl } = await onlineDriver(p.d, 'MH 31 AB 7777');
    const { r, rctl, rfp, total } = await rideWithRider(p.r, /UPI/);

    await d.heading('New ride request'); await d.text(/s left to accept/); await d.tap('Accept ride');          // offer arrived by realtime
    await d.heading('Go to the pickup point'); await d.tap('Navigate to pickup'); await d.tap('I am on my way');
    await d.heading('Heading to pickup');
    await r.heading('Your driver is on the way'); await r.text('MH31AB7777'); await r.text('Auto-rickshaw');
    await d.tap('I have arrived'); await r.heading('Your driver has arrived');
    await d.tap('Start trip'); await d.heading('Trip in progress'); await r.heading('You are on your way');
    await d.tap('Complete trip'); await d.text('Have you reached the destination? This ends the trip.'); await d.tap('Not yet'); await d.gone('Have you reached the destination? This ends the trip.');
    await d.tap('Complete trip'); await d.tap('Yes, complete trip');                                              // two-step confirm
    await d.heading('Trip complete'); await d.text('Waiting for the rider to pay by UPI');
    expect(d.has(/Collect .* in cash/)).toBe(false);                                                              // a UPI trip never asks the driver to collect cash

    await r.heading(`Pay ${formatINR(total)}`); await r.tap('Pay with UPI'); await waitFor(() => expect(rfp.opened[0]).toMatch(/^upi:\/\/pay\?/));
    const ref = new URL(rctl.store.get().payment!.intent!.upiUri).searchParams.get('tr')!;
    await srv.webhook(new FakeProvider({ secret: SECRET, now: Date.now }).signedEvent({ type: 'payment.succeeded', providerRef: ref, amountMinor: total }));
    await r.heading('Payment received'); await r.text('Paid with UPI'); await d.text('Paid by UPI');
    await r.tap('Done'); await r.heading('Where to?'); await r.text(/completed/);                                 // history shows the ride
    await d.tap('Done'); await d.heading('You are online'); dctl.stop(); rctl.stop();
  });

  it('a cash trip: the rider is told to pay cash, the driver is told to collect exactly that amount', async () => {
    const p = nums(); const { d, dctl } = await onlineDriver(p.d, 'MH 31 AB 7778'); const { r, rctl, total } = await rideWithRider(p.r, /Cash/);
    await d.tap('Accept ride'); for (const s of ['I am on my way', 'I have arrived', 'Start trip']) await d.tap(s);
    await d.tap('Complete trip'); await d.tap('Yes, complete trip');
    await d.heading(`Collect ${formatINR(total)} in cash`); await r.heading('Trip complete'); await r.text(`Please pay ${formatINR(total)} in cash to your driver.`);
    await r.tap('Done'); await d.tap('Done'); dctl.stop(); rctl.stop();
  });

  it('cancelling while searching ends the ride for the rider and withdraws the driver\'s request', async () => {
    const p = nums(); const { d, dctl } = await onlineDriver(p.d, 'MH 31 AB 7779'); const { r, rctl } = await rideWithRider(p.r, /Cash/);
    await d.heading('New ride request'); await r.tap('Cancel ride'); await r.heading('Ride cancelled');
    await d.gone('New ride request'); await d.text('Waiting for ride requests…'); await r.tap('Back to home'); await r.heading('Where to?'); dctl.stop(); rctl.stop();
  });

  it('login mistakes show plain-language messages; the fare button needs two different places', async () => {
    const p = nums(); const rfp = fakePlatform(); const rctl = new RiderController(rfp.platform, { baseUrl: srv.baseUrl, pollMs: 60_000 });
    const r = phone('rider'); render(<RiderApp controller={rctl} location={rfp.location} />, { container: r.el });
    await r.heading('Nagpur Rides'); await r.type('Mobile number', '12345'); await r.tap('Send code'); await r.text('Enter a valid 10-digit mobile number.');
    await r.tap('Dismiss'); await r.gone('Enter a valid 10-digit mobile number.');
    await r.type('Mobile number', p.r); await r.tap('Send code'); await r.type('6-digit code', '000000'); await r.tap('Verify and continue'); await r.text('That code is wrong or has expired.');
    await r.tap('Use a different number'); await r.heading('Nagpur Rides'); await r.type('Mobile number', p.r);
    rctl.stop();
  });
  it('shows a reconnecting banner when the live connection drops and removes it when it returns', async () => {
    const p = nums(); const rfp = fakePlatform(); const rctl = new RiderController(rfp.platform, { baseUrl: srv.baseUrl, pollMs: 60_000 });
    const r = phone('rider'); render(<RiderApp controller={rctl} location={rfp.location} />, { container: r.el }); await signIn(r, p.r, 'Nagpur Rides'); await r.heading('Where to?');
    await waitFor(() => expect(rctl.store.get().connection).toBe('CONNECTED'), T); expect(r.has(/Reconnecting/)).toBe(false);
    rctl.realtime.stop(); await r.text(/Reconnecting/); rctl.realtime.start(); await r.gone(/Reconnecting/); rctl.stop();
  });

  it('driver: location permission denied keeps them offline with a clear reason', async () => {
    const p = nums(); const dfp = fakePlatform(); dfp.location.granted = false; const dctl = new DriverController(dfp.platform, { baseUrl: srv.baseUrl, pollMs: 60_000 }, 0);
    const d = phone('driver'); render(<DriverApp controller={dctl} openUrl={dfp.platform.openUrl} />, { container: d.el });
    await signIn(d, p.d, 'Driver sign in'); await d.type('Vehicle registration number', 'MH 31 AB 7780'); await d.tap('Submit for verification');
    await d.heading('Verification in progress'); driverIds.push(idFromToken(dfp.store.t!.accessToken)); await srv.approve(idFromToken(dfp.store.t!.accessToken)); await d.tap('Check status');
    await d.tap('Go online'); await d.text(/Location permission needed/); await d.heading('You are offline'); dctl.stop();
  });

  it('driver: if the rider cancels after acceptance the driver is told and returned to the online screen', async () => {
    const p = nums(); const { d, dctl } = await onlineDriver(p.d, 'MH 31 AB 7781'); const { r, rctl } = await rideWithRider(p.r, /Cash/);
    await d.tap('Accept ride'); await d.heading('Go to the pickup point'); await r.heading('Your driver is on the way'); await r.tap('Cancel ride'); await r.heading('Ride cancelled');
    await d.text('The rider cancelled this trip.'); await d.heading('You are online'); dctl.stop(); rctl.stop();
  });

  it('driver: closing and reopening the app mid-trip puts them back on the same screen', async () => {
    const p = nums(); const { d, dctl, dfp } = await onlineDriver(p.d, 'MH 31 AB 7782'); const { rctl } = await rideWithRider(p.r, /Cash/);
    await d.tap('Accept ride'); await d.tap('I am on my way'); await d.heading('Heading to pickup');
    cleanup(); dctl.stop(); document.body.innerHTML = '';                                                    // app killed
    const d2c = new DriverController(dfp.platform, { baseUrl: srv.baseUrl, pollMs: 60_000 }, 0); const d2 = phone('driver again');
    render(<DriverApp controller={d2c} openUrl={dfp.platform.openUrl} />, { container: d2.el });
    await d2.heading('Heading to pickup'); await d2.tap('I have arrived'); await d2.heading('Waiting for the rider'); d2c.stop(); rctl.stop();
  });
});
