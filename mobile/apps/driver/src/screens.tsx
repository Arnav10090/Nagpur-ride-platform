import React, { useState } from 'react';
import { View } from 'react-native';
import { formatINR, navigationUrl, normalizeRegistration, OfferView, PaymentView, RideView } from '@rides/client';
import { Big, Body, Button, Card, Countdown, Field, H2, Notice, Pill, Row, Screen, space, Spinner, Title } from '@rides/ui';

export function OnboardingScreen(p: { busy: boolean; onSubmit: (reg: string) => void; onLogout: () => void }) {
  const [reg, setReg] = useState('');
  return (
    <Screen>
      <Title>Register your vehicle</Title><Body dim>Enter your auto-rickshaw registration number. Our team will verify your documents before you can take rides.</Body>
      <Field label="Vehicle registration number" value={reg} onChangeText={t => setReg(t.toUpperCase())} autoCapitalize="characters" maxLength={14} placeholder="MH 31 AB 1234" />
      {reg ? <Body dim>We will save it as {normalizeRegistration(reg)}</Body> : null}
      <Button title="Submit for verification" loading={p.busy} disabled={reg.trim().length < 6} onPress={() => p.onSubmit(reg)} />
      <Button title="Sign out" variant="secondary" onPress={p.onLogout} />
    </Screen>);
}
export const PendingScreen = (p: { busy: boolean; onRefresh: () => void; onLogout: () => void }) => (
  <Screen><Title>Verification in progress</Title><Body dim>We are checking your details. This can take a little while. You will be able to go online as soon as you are approved.</Body>
    <Button title="Check status" loading={p.busy} onPress={p.onRefresh} /><Button title="Sign out" variant="secondary" onPress={p.onLogout} /></Screen>);
export const RejectedScreen = (p: { onLogout: () => void }) => (
  <Screen><Title>We could not approve your account</Title><Body dim>Please contact driver support to find out what is needed.</Body><Button title="Sign out" variant="secondary" onPress={p.onLogout} /></Screen>);

const GPS: Record<string, [string, 'ok' | 'warn' | 'bad']> = { OK: ['GPS active', 'ok'], OFF: ['GPS off', 'warn'], DENIED: ['Location permission needed. Turn it on in Settings.', 'bad'], ERROR: ['GPS problem. Move to open sky.', 'bad'] };

export function HomeScreen(p: { online: boolean; gps: string; offers: OfferView[]; busy: boolean; notice: string | null; now: () => number; onToggle: () => void; onAccept: (id: string) => void; onReject: (id: string) => void; onLogout: () => void }) {
  const [g, tone] = GPS[p.gps] ?? GPS.OFF!;
  return (
    <Screen>
      <Title>{p.online ? 'You are online' : 'You are offline'}</Title>
      <Notice message={p.notice} /><Pill text={g} tone={tone} />
      <Button title={p.online ? 'Go offline' : 'Go online'} variant={p.online ? 'secondary' : 'primary'} loading={p.busy} onPress={p.onToggle} />
      {p.online && p.offers.length === 0 ? <Spinner label="Waiting for ride requests…" /> : null}
      {p.offers.map(o => (
        <Card key={o.id}>
          <H2>New ride request</H2><Body dim>Pickup is near you.</Body>
          <Countdown until={o.expiresAt} now={p.now} />
          <Button title="Accept ride" loading={p.busy} onPress={() => p.onAccept(o.id)} />
          <Button title="Decline" variant="secondary" onPress={() => p.onReject(o.id)} />
        </Card>))}
      {!p.online ? <Button title="Sign out" variant="secondary" onPress={p.onLogout} /> : null}
    </Screen>);
}

const STEP: Record<string, { title: string; action?: string; step?: 'en-route' | 'arrive' | 'start' | 'complete'; toward: 'pickup' | 'destination' | null }> = {
  DRIVER_ASSIGNED: { title: 'Go to the pickup point', action: 'I am on my way', step: 'en-route', toward: 'pickup' },
  DRIVER_ARRIVING: { title: 'Heading to pickup', action: 'I have arrived', step: 'arrive', toward: 'pickup' },
  DRIVER_ARRIVED: { title: 'Waiting for the rider', action: 'Start trip', step: 'start', toward: null },
  IN_PROGRESS: { title: 'Trip in progress', action: 'Complete trip', step: 'complete', toward: 'destination' },
};
export function ActiveRideScreen(p: { ride: RideView; busy: boolean; notice: string | null; onStep: (s: 'en-route' | 'arrive' | 'start' | 'complete') => void; onNavigate: (url: string) => void }) {
  const [confirm, setConfirm] = useState(false); const s = STEP[p.ride.status];
  if (!s) return <Screen><Spinner label="Updating…" /></Screen>;
  const target = s.toward === 'pickup' ? p.ride.pickup : s.toward === 'destination' ? p.ride.destination : null;
  return (
    <Screen>
      <Title>{s.title}</Title><Notice message={p.notice} />
      <Card><Row label="Rider pays" value={p.ride.paymentMethod === 'UPI' ? 'UPI' : 'Cash'} /><Row label="Fare" value={p.ride.estimatedFareMinor != null ? formatINR(p.ride.estimatedFareMinor) : '—'} strong /></Card>
      {target ? <Button title={s.toward === 'pickup' ? 'Navigate to pickup' : 'Navigate to destination'} variant="secondary" onPress={() => p.onNavigate(navigationUrl(target.lat, target.lng))} /> : null}
      {s.step === 'complete' && !confirm ? <Button title={s.action!} onPress={() => setConfirm(true)} /> : null}
      {s.step === 'complete' && confirm ? (<Card><Body>Have you reached the destination? This ends the trip.</Body>
        <Button title="Yes, complete trip" loading={p.busy} onPress={() => p.onStep('complete')} /><Button title="Not yet" variant="secondary" onPress={() => setConfirm(false)} /></Card>) : null}
      {s.step && s.step !== 'complete' ? <Button title={s.action!} loading={p.busy} onPress={() => p.onStep(s.step!)} /> : null}
    </Screen>);
}

export function SummaryScreen(p: { ride: RideView; payment: PaymentView | null; onDone: () => void }) {
  const fare = p.ride.finalFareMinor ?? 0; const cash = p.ride.paymentMethod === 'CASH'; const st = p.payment?.status;
  return (
    <Screen>
      <Title>Trip complete</Title>
      <Card><Row label="Fare" value={formatINR(fare)} strong /><Row label="Rider pays by" value={cash ? 'Cash' : 'UPI'} /></Card>
      {cash ? (<Card><H2>Collect {formatINR(fare)} in cash</H2><Body dim>Please collect the fare from the rider before they leave.</Body></Card>) : (<View style={{ gap: space.sm }}>
        {st === 'SUCCEEDED' || st === 'PARTIALLY_REFUNDED' || st === 'REFUNDED' ? <Pill text="Paid by UPI" /> : st === 'FAILED' ? <Pill text="Payment failed. The rider can try again." tone="bad" /> : <Pill text="Waiting for the rider to pay by UPI" tone="warn" />}
        <Body dim>You do not need to collect anything. Your earnings are updated once the payment is confirmed.</Body></View>)}
      <Button title="Done" onPress={p.onDone} />
    </Screen>);
}
