import React, { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { LocationService, RiderController, riderPhase } from '@rides/client';
import { ConnectionBanner, ErrorBanner, LoginFlow, Spinner, useStore } from '@rides/ui';
import { DoneScreen, DriverComingScreen, EndedScreen, HomeScreen, OnTripScreen, PayScreen, QuoteScreen, SearchingScreen } from './screens';
import { Place } from './places';

export function RiderApp({ controller, location }: { controller: RiderController; location: LocationService }) {
  const s = useStore(controller.store); const phase = riderPhase(s);
  useEffect(() => { void controller.start(); return () => controller.stop(); }, [controller]);
  if (s.auth === 'UNKNOWN') return <Spinner label="Loading…" />;
  if (s.auth === 'LOGGED_OUT') return <LoginFlow title="Nagpur Rides" subtitle="Sign in with your mobile number." otpSentTo={s.otpSentTo} busy={s.busy} error={s.error}
    onRequest={p => void controller.requestOtp(p)} onVerify={c => void controller.verifyOtp(c)} onChangeNumber={() => controller.changeNumber()} onDismissError={() => controller.clearError()} />;
  const r = s.ride;
  const useMe = async (): Promise<Place | null> => { try { if (!(await location.requestPermission())) return null; const f = await location.current(); return { id: 'me', name: 'Current location', at: { lat: f.lat, lng: f.lng } }; } catch { return null; } };
  return (
    <View style={{ flex: 1 }}>
      <StatusBar style="dark" /><ConnectionBanner connected={s.connection === 'CONNECTED'} />
      <View style={{ paddingHorizontal: 16 }}><ErrorBanner message={s.error} onDismiss={() => controller.clearError()} /></View>
      {phase === 'HOME' ? <HomeScreen busy={s.busy} history={s.history} onQuote={(a, b) => void controller.getQuote(a.at, b.at)} onUseMyLocation={useMe} onLogout={() => void controller.logout()} /> : null}
      {phase === 'QUOTE' && s.quote ? <QuoteScreen quote={s.quote} busy={s.busy} onBook={m => void controller.book(m)} onBack={() => controller.clearQuote()} /> : null}
      {phase === 'SEARCHING' ? <SearchingScreen busy={s.busy} onCancel={() => void controller.cancel()} /> : null}
      {(phase === 'DRIVER_COMING' || phase === 'DRIVER_ARRIVED') && r ? <DriverComingScreen ride={r} arrived={phase === 'DRIVER_ARRIVED'} driverAt={s.driverLocation} busy={s.busy} onCancel={() => void controller.cancel()} /> : null}
      {phase === 'ON_TRIP' && r ? <OnTripScreen ride={r} /> : null}
      {phase === 'PAY' && r ? <PayScreen ride={r} payment={s.payment} busy={s.busy} onPay={() => void controller.payNow()} onRetry={() => void controller.retryPayment()} /> : null}
      {phase === 'DONE' && r ? <DoneScreen ride={r} payment={s.payment} onDone={() => controller.dismiss()} /> : null}
      {phase === 'ENDED' && r ? <EndedScreen status={r.status} onBack={() => controller.dismiss()} /> : null}
    </View>);
}

