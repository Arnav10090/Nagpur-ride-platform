import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View, KeyboardTypeOptions } from 'react-native';
import { colors, font, MIN_TOUCH, space } from './theme';
import { useNow } from './hooks';

export function Screen({ children, scroll = true }: { children: React.ReactNode; scroll?: boolean }) {
  const inner = <View style={{ padding: space.md, paddingTop: space.lg, gap: space.md }}>{children}</View>;
  return <View style={{ flex: 1, backgroundColor: colors.bg }}>{scroll ? <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1 }}>{inner}</ScrollView> : inner}</View>;
}
export const Title = ({ children }: { children: React.ReactNode }) => <Text role="heading" style={{ fontSize: font.title, fontWeight: '700', color: colors.ink }}>{children}</Text>;
export const H2 = ({ children }: { children: React.ReactNode }) => <Text role="heading" style={{ fontSize: font.h2, fontWeight: '600', color: colors.ink }}>{children}</Text>;
export const Body = ({ children, dim }: { children: React.ReactNode; dim?: boolean }) => <Text style={{ fontSize: font.body, color: dim ? colors.sub : colors.ink, lineHeight: 22 }}>{children}</Text>;
export const Big = ({ children }: { children: React.ReactNode }) => <Text style={{ fontSize: font.big, fontWeight: '800', color: colors.ink, letterSpacing: 1 }}>{children}</Text>;
export const Card = ({ children }: { children: React.ReactNode }) => <View style={{ backgroundColor: colors.card, borderRadius: 14, padding: space.md, gap: space.sm, borderWidth: 1, borderColor: colors.line }}>{children}</View>;
export const Row = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => (
  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={{ fontSize: font.body, color: colors.sub }}>{label}</Text><Text style={{ fontSize: font.body, color: colors.ink, fontWeight: strong ? '700' : '400' }}>{value}</Text></View>);

export function Button({ title, onPress, variant = 'primary', disabled, loading }: { title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; loading?: boolean }) {
  const off = !!(disabled || loading);
  const bg = variant === 'primary' ? colors.primary : variant === 'danger' ? colors.danger : colors.card; const fg = variant === 'secondary' ? colors.ink : colors.primaryInk;
  return (
    <Pressable role="button" aria-label={title} aria-disabled={off} disabled={off} onPress={onPress}
      style={({ pressed }) => ({ minHeight: MIN_TOUCH, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.md, backgroundColor: bg, opacity: off ? 0.5 : pressed ? 0.85 : 1, borderWidth: variant === 'secondary' ? 1 : 0, borderColor: colors.line })}>
      {loading ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontSize: font.body, fontWeight: '600' }}>{title}</Text>}
    </Pressable>);
}
export function Field({ label, value, onChangeText, placeholder, keyboardType, maxLength, autoCapitalize = 'none', error }: { label: string; value: string; onChangeText: (s: string) => void; placeholder?: string; keyboardType?: KeyboardTypeOptions; maxLength?: number; autoCapitalize?: 'none' | 'characters'; error?: string | null }) {
  return (
    <View style={{ gap: space.xs }}>
      <Text style={{ fontSize: font.small, color: colors.sub }}>{label}</Text>
      <TextInput aria-label={label} value={value} onChangeText={onChangeText} placeholder={placeholder} keyboardType={keyboardType} maxLength={maxLength} autoCapitalize={autoCapitalize} autoCorrect={false}
        style={{ minHeight: MIN_TOUCH, borderWidth: 1, borderColor: error ? colors.danger : colors.line, borderRadius: 12, paddingHorizontal: space.md, fontSize: font.h2, backgroundColor: colors.card, color: colors.ink }} />
      {error ? <Text role="alert" style={{ color: colors.danger, fontSize: font.small }}>{error}</Text> : null}
    </View>);
}
export function ErrorBanner({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  if (!message) return null;
  return <View role="alert" style={{ backgroundColor: colors.dangerBg, borderRadius: 12, padding: space.md, gap: space.sm }}><Text style={{ color: colors.danger, fontSize: font.body }}>{message}</Text><Button title="Dismiss" variant="secondary" onPress={onDismiss} /></View>;
}
export const Notice = ({ message }: { message: string | null }) => message ? <View role="status" style={{ backgroundColor: colors.warnBg, borderRadius: 12, padding: space.md }}><Text style={{ color: colors.warn, fontSize: font.body }}>{message}</Text></View> : null;
/** Shown only while signed in and the live connection is down; data still refreshes in the background. */
export const ConnectionBanner = ({ connected }: { connected: boolean }) => connected ? null : <View role="status" style={{ backgroundColor: colors.warnBg, padding: space.sm }}><Text style={{ color: colors.warn, textAlign: 'center', fontSize: font.small }}>Reconnecting… updates may be delayed</Text></View>;
export const Spinner = ({ label }: { label: string }) => <View role="progressbar" aria-label={label} style={{ alignItems: 'center', gap: space.md, padding: space.lg }}><ActivityIndicator size="large" color={colors.primary} /><Body dim>{label}</Body></View>;
export const Pill = ({ text, tone = 'ok' }: { text: string; tone?: 'ok' | 'warn' | 'bad' }) => (
  <View style={{ alignSelf: 'flex-start', paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: 99, backgroundColor: tone === 'ok' ? colors.okBg : tone === 'warn' ? colors.warnBg : colors.dangerBg }}>
    <Text style={{ fontSize: font.small, fontWeight: '600', color: tone === 'ok' ? colors.ok : tone === 'warn' ? colors.warn : colors.danger }}>{text}</Text></View>);

/** "Ns left" until a server timestamp, using the server-corrected clock so a wrong phone clock cannot show a dead offer as live. */
export function Countdown({ until, now }: { until: number; now: () => number }) {
  const t = useNow(now); const left = Math.max(0, Math.ceil((until - t) / 1000));
  return <Pill text={left > 0 ? `${left}s left to accept` : 'Expired'} tone={left > 5 ? 'ok' : 'bad'} />;
}
