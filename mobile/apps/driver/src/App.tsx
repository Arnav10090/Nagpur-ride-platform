import React, { useMemo } from 'react';
import { DriverController } from '@rides/client';
import { apiBaseUrl, expoPlatform } from '@rides/expo-platform';
import { DriverApp } from './DriverApp';

/** The real app: Expo platform adapters + the configured API address. (Kept separate so tests never load native modules.) */
export default function App() {
  const controller = useMemo(() => new DriverController(expoPlatform, { baseUrl: apiBaseUrl }), []);
  return <DriverApp controller={controller} openUrl={expoPlatform.openUrl} />;
}
