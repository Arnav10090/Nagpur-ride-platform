import React, { useMemo } from 'react';
import { RiderController } from '@rides/client';
import { apiBaseUrl, expoPlatform } from '@rides/expo-platform';
import { RiderApp } from './RiderApp';

/** The real app: Expo platform adapters + the configured API address. (Kept separate so tests never load native modules.) */
export default function App() {
  const controller = useMemo(() => new RiderController(expoPlatform, { baseUrl: apiBaseUrl }), []);
  return <RiderApp controller={controller} location={expoPlatform.location} />;
}
