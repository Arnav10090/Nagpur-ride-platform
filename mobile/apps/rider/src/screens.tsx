import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatINR, PaymentView, Quote, RideSummary, RideView } from '@rides/client';
import { Big, Body, Button, Card, colors, font, H2, Pill, Row, Screen, space, Spinner, Title } from '@rides/ui';
import { distanceKm, LANDMARKS, Place } from './places';

function PlaceList({ title, value, onPick, extra }: { title: string; value: Place | null; onPick: (p: Place) => void; extra?: React.ReactNode }) {
  return (
    <View role="radiogroup" aria-label={title} style={{ gap: space.sm }}>
      <H2>{title}</H2>{extra}
      {LANDMARKS.map(p => {
        const on = value?.id === p.id;
        return (<Pressable key={p.id} role="radio" aria-label={`${title}: ${p.name}`} aria-checked={on} onPress={() => onPick(p)}
          style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: space.md, borderRadius: 12, borderWidth: 2, borderColor: on ? colors.primary : colors.line, backgroundColor: on ? '#EAF1FF' : colors.card }}>
          <Text style={{ fontSize: font.body, color: colors.ink, fontWeight: on ? '700' : '400' }}>{p.name}</Text></Pressable>);
      })}
    </View>);
}

export function HomeScreen(p: { busy: boolean; history: RideSummary[]; onQuote: (a: Place, b: Place) => void; onUseMyLocation: () => Promise<Place | null>; onLogout: () => void }) {
  const [pickup, setPickup] = useState<Place | null>(null); const [dest, setDest] = useState<Place | null>(null); const [locMsg, setLocMsg] = useState<string | null>(null);
  const same = !!pickup && !!dest && pickup.id === dest.id;
  return (
    <Screen>
      <Title>Where to?</Title>
      <PlaceList title="Pickup" value={pickup} onPick={setPickup} extra={<>
        <Button title="Use my current location" variant="secondary" onPress={async () => { const pl = await p.onUseMyLocation(); if (pl) { setPickup(pl); setLocMsg(null); } else setLocMsg('We could not get your location. Choose a pickup from the list.'); }} />
        {pickup?.id === 'me' ? <Pill text="Using your current location" /> : null}{locMsg ? <Body dim>{locMsg}</Body> : null}</>} />
      <PlaceList title="Destination" value={dest} onPick={setDest} />
      {same ? <Body dim>Pickup and destination are the same.</Body> : null}
      <Button title="Get fare" loading={p.busy} disabled={!pickup || !dest || same} onPress={() => p.onQuote(pickup!, dest!)} />
      {p.history.length ? (<View style={{ gap: space.sm }}><H2>Recent rides</H2>
        {p.history.slice(0, 5).map(r => (<Card key={r.id}><Row label={new Date(r.createdAt).toLocaleDateString()} value={r.fareMinor != null ? formatINR(r.fareMinor) : '—'} /><Pill text={r.status.replace(/_/g, ' ').toLowerCase()} tone={r.status === 'COMPLETED' ? 'ok' : r.status === 'CANCELLED' || r.status === 'EXPIRED' ? 'bad' : 'warn'} /></Card>))}</View>) : null}
      <Button title="Sign out" variant="secondary" onPress={p.onLogout} />
    </Screen>);
}

export function QuoteScreen(p: { quote: Quote; busy: boolean; onBook: (m: 'CASH' | 'UPI') => void; onBack: () => void }) {
  const [method, setMethod] = useState<'CASH' | 'UPI'>('CASH'); const f = p.quote.fare;
  return (
    <Screen>
      <Title>Your fare</Title>
      <Card>
        <Row label="Base fare" value={formatINR(f.baseMinor)} /><Row label="Distance" value={formatINR(f.distanceMinor)} /><Row label="Time" value={formatINR(f.timeMinor)} />
        {f.minimumAdjustmentMinor > 0 ? <Row label="Minimum fare adjustment" value={formatINR(f.minimumAdjustmentMinor)} /> : null}
        <Row label="Total" value={formatINR(f.totalMinor)} strong />
      </Card>
      <View role="radiogroup" aria-label="Payment method" style={{ gap: space.sm }}>
        <H2>How will you pay?</H2>
        {([['CASH', 'Cash to the driver'], ['UPI', 'UPI (after the trip)']] as const).map(([m, label]) => (
          <Pressable key={m} role="radio" aria-label={label} aria-checked={method === m} onPress={() => setMethod(m)}
            style={{ minHeight: 52, justifyContent: 'center', paddingHorizontal: space.md, borderRadius: 12, borderWidth: 2, borderColor: method === m ? colors.primary : colors.line, backgroundColor: colors.card }}>
            <Text style={{ fontSize: font.body, color: colors.ink, fontWeight: method === m ? '700' : '400' }}>{label}</Text></Pressable>))}
      </View>
      <Button title="Book ride" loading={p.busy} onPress={() => p.onBook(method)} />
      <Button title="Change trip" variant="secondary" onPress={p.onBack} />
    </Screen>);
}

export const SearchingScreen = (p: { busy: boolean; onCancel: () => void }) => (
  <Screen><Title>Finding your driver</Title><Spinner label="Looking for a driver near you…" /><Button title="Cancel ride" variant="danger" loading={p.busy} onPress={p.onCancel} /></Screen>);

export function DriverComingScreen(p: { ride: RideView; arrived: boolean; driverAt: { lat: number; lng: number } | null; busy: boolean; onCancel: () => void }) {
  const km = p.driverAt && p.ride.pickup ? distanceKm(p.driverAt, p.ride.pickup) : null;
  return (
    <Screen>
      <Title>{p.arrived ? 'Your driver has arrived' : 'Your driver is on the way'}</Title>
      {p.ride.vehicle ? (<Card><Body dim>Look for this vehicle</Body><Big>{p.ride.vehicle.registration}</Big><Body dim>{p.ride.vehicle.category === 'AUTO' ? 'Auto-rickshaw' : p.ride.vehicle.category}</Body></Card>) : null}
      {!p.arrived && km != null ? <Pill text={km < 0.1 ? 'Nearly there' : `About ${km.toFixed(1)} km away`} tone="warn" /> : null}
      <Body dim>Payment: {p.ride.paymentMethod === 'UPI' ? 'UPI after the trip' : 'Cash to the driver'}</Body>
      <Button title="Cancel ride" variant="danger" loading={p.busy} onPress={p.onCancel} />
    </Screen>);
}

export const OnTripScreen = (p: { ride: RideView }) => (
  <Screen><Title>You are on your way</Title><Card><Row label="Fare" value={p.ride.estimatedFareMinor != null ? formatINR(p.ride.estimatedFareMinor) : '—'} strong /><Row label="Payment" value={p.ride.paymentMethod === 'UPI' ? 'UPI' : 'Cash'} /></Card><Body dim>Sit back. We will ask for payment when you arrive.</Body></Screen>);

export function PayScreen(p: { ride: RideView; payment: PaymentView | null; busy: boolean; onPay: () => void; onRetry: () => void }) {
  const st = p.payment?.status; const fare = p.ride.finalFareMinor ?? p.payment?.amountMinor ?? 0;
  return (
    <Screen>
      <Title>Pay {formatINR(fare)}</Title>
      {st === 'REQUIRES_ACTION' && p.payment?.intent ? (<>
        <Button title="Pay with UPI" loading={p.busy} onPress={p.onPay} />
        <Body dim>After you pay in your UPI app, this screen updates by itself. Please do not pay twice.</Body></>) : null}
      {st === 'FAILED' || st === 'CANCELLED' ? (<><Card><Body>That payment did not go through. You have not been charged unless your bank says otherwise.</Body></Card><Button title="Try payment again" loading={p.busy} onPress={p.onRetry} /></>) : null}
      {!p.payment || st === 'PENDING' ? <Spinner label="Preparing your payment…" /> : null}
    </Screen>);
}

export function DoneScreen(p: { ride: RideView; payment: PaymentView | null; onDone: () => void }) {
  const fare = p.ride.finalFareMinor ?? 0; const cash = p.ride.paymentMethod === 'CASH';
  return (
    <Screen>
      <Title>{cash ? 'Trip complete' : 'Payment received'}</Title>
      <Card><Row label="Fare" value={formatINR(fare)} strong /><Row label="Paid by" value={cash ? 'Cash' : 'UPI'} />
        {p.payment && p.payment.refundedMinor > 0 ? <Row label="Refunded" value={formatINR(p.payment.refundedMinor)} /> : null}</Card>
      {cash ? <Card><Body>Please pay {formatINR(fare)} in cash to your driver.</Body></Card> : <Pill text="Paid with UPI" />}
      <Button title="Done" onPress={p.onDone} />
    </Screen>);
}

export const EndedScreen = (p: { status: string; onBack: () => void }) => (
  <Screen><Title>{p.status === 'EXPIRED' ? 'No drivers available' : 'Ride cancelled'}</Title>
    <Body dim>{p.status === 'EXPIRED' ? 'We could not find a driver right now. Please try again in a few minutes.' : 'This ride was cancelled.'}</Body><Button title="Back to home" onPress={p.onBack} /></Screen>);
