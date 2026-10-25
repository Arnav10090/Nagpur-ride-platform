import React, { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { DriverController, driverPhase } from '@rides/client';
import { ConnectionBanner, ErrorBanner, LoginFlow, Spinner, useStore } from '@rides/ui';
import { ActiveRideScreen, HomeScreen, OnboardingScreen, PendingScreen, RejectedScreen, SummaryScreen } from './screens';

export function DriverApp({ controller, openUrl }: { controller: DriverController; openUrl: (u: string) => Promise<void> }) {
  const s = useStore(controller.store); const phase = driverPhase(s);
  useEffect(() => { void controller.start(); return () => controller.stop(); }, [controller]);
  if (phase === 'LOADING') return <Spinner label="Loading…" />;
  if (phase === 'LOGIN') return <LoginFlow title="Driver sign in" subtitle="Sign in with your mobile number." otpSentTo={s.otpSentTo} busy={s.busy} error={s.error}
    onRequest={p => void controller.requestOtp(p)} onVerify={c => void controller.verifyOtp(c)} onChangeNumber={() => controller.changeNumber()} onDismissError={() => controller.clearError()} />;
  const logout = () => void controller.logout();
  return (
    <View style={{ flex: 1 }}>
      <StatusBar style="dark" /><ConnectionBanner connected={s.connection === 'CONNECTED'} />
      <View style={{ paddingHorizontal: 16 }}><ErrorBanner message={s.error} onDismiss={() => controller.clearError()} /></View>
      {phase === 'ONBOARDING' ? <OnboardingScreen busy={s.busy} onSubmit={r => void controller.onboard(r)} onLogout={logout} /> : null}
      {phase === 'PENDING_APPROVAL' ? <PendingScreen busy={s.busy} onRefresh={() => void controller.refreshStatus()} onLogout={logout} /> : null}
      {phase === 'REJECTED' ? <RejectedScreen onLogout={logout} /> : null}
      {(phase === 'OFFLINE' || phase === 'ONLINE') ? <HomeScreen online={s.online} gps={s.gps} offers={s.offers} busy={s.busy} notice={s.notice} now={() => controller.api.now()}
        onToggle={() => void (s.online ? controller.goOffline() : controller.goOnline())} onAccept={id => void controller.accept(id)} onReject={id => void controller.reject(id)} onLogout={logout} /> : null}
      {phase === 'ACTIVE_RIDE' && s.ride ? <ActiveRideScreen ride={s.ride} busy={s.busy} notice={s.notice} onStep={st => void controller.advance(st)} onNavigate={u => void openUrl(u).catch(() => undefined)} /> : null}
      {phase === 'SUMMARY' && s.completed ? <SummaryScreen ride={s.completed.ride} payment={s.completed.payment} onDone={() => controller.dismissSummary()} /> : null}
    </View>);
}
