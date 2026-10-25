import React, { useState } from 'react';
import { Body, Button, ErrorBanner, Field, Screen, Title } from './components';

/** Phone number, then the 6-digit code. Shared by both apps; all validation lives in the controller. */
export function LoginFlow(p: { title: string; subtitle: string; otpSentTo: string | null; busy: boolean; error: string | null; onRequest: (phone: string) => void; onVerify: (code: string) => void; onChangeNumber: () => void; onDismissError: () => void }) {
  const [phone, setPhone] = useState(''); const [code, setCode] = useState('');
  return (
    <Screen>
      <Title>{p.title}</Title><Body dim>{p.subtitle}</Body>
      <ErrorBanner message={p.error} onDismiss={p.onDismissError} />
      {!p.otpSentTo ? (<>
        <Field label="Mobile number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={16} placeholder="98765 43210" />
        <Button title="Send code" loading={p.busy} onPress={() => p.onRequest(phone)} />
      </>) : (<>
        <Body>We sent a 6-digit code to +91 {p.otpSentTo}.</Body>
        <Field label="6-digit code" value={code} onChangeText={t => setCode(t.replace(/\D/g, ''))} keyboardType="number-pad" maxLength={6} placeholder="••••••" />
        <Button title="Verify and continue" loading={p.busy} disabled={code.length !== 6} onPress={() => p.onVerify(code)} />
        <Button title="Use a different number" variant="secondary" onPress={() => { setCode(''); p.onChangeNumber(); }} />
      </>)}
    </Screen>);
}
