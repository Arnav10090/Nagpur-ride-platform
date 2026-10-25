# Mobile apps (Expo SDK 58 / React Native 0.88 / React 19)

    cd mobile && npm install
    npm run typecheck          # all packages + both apps
    npm test                   # 13 unit + 8 client-vs-real-server flows + 8 two-phone UI tests
    EXPO_PUBLIC_API_URL=https://your-api npm run rider    # or: npm run driver   (Expo dev server; scan the QR with Expo Go / a dev build)

Layout
- `packages/client`  framework-free logic: typed API client (single-flight token refresh, never signs out on a bad network), socket client
  (backoff, fresh tokens, de-dupe), `RiderController` / `DriverController` (all behaviour and state machines).
- `packages/ui`      React Native components (44px+ touch targets, roles/labels for screen readers) and the shared login flow.
- `packages/expo-platform`  the ONLY device-specific code: SecureStore (tokens), expo-location, Linking.
- `apps/rider`, `apps/driver`  screens + app shells (`App.tsx` = real wiring, `RiderApp.tsx`/`DriverApp.tsx` = testable component).

Design rules the tests enforce
- The socket is only a hint that something changed; REST is the source of truth. Missed events are recovered on reconnect.
- A booking's idempotency key is created once per quote and reused on retry, so a dropped connection can never create two rides.
- Both apps resume after being killed (rider: active ride or unpaid trip; driver: active ride, online state, GPS).
- Payment is confirmed only by the server (provider webhook); returning from the UPI app proves nothing.
- Drivers never receive rider identity or the UPI intent; riders see the vehicle registration, not the driver's phone.
- Countdowns use the server clock (Date header), so a wrong phone clock cannot show an expired request as live.

What was and was NOT verified
- Verified: typecheck; Metro bundles for web, Android (Hermes bytecode) and iOS for BOTH apps; controllers against the real API server;
  the actual screens rendered with react-native-web and operated through accessible roles/labels by a test acting as a person, rider and
  driver phones at the same time, against the real server, covering a full UPI trip, a cash trip, cancellations, relaunch, reconnect.
- NOT verified: running on a physical device or emulator (GPS, keychain, UPI app handoff, permission prompts), visual design on real
  screens/sizes/dark mode, performance, Hindi/Marathi (English only; strings are not yet externalised), push notifications (none),
  background location (foreground only: a driver's location stops when the app is backgrounded, which a real launch must solve with a
  foreground service / background-location entitlement and store review), maps (no map SDK; landmark list + "current location" + deep
  link to the user's maps app), store builds/signing (bundle ids are placeholders `com.example...`), accessibility audit with TalkBack/VoiceOver.
- Landmark coordinates in `apps/rider/src/places.ts` are approximate placeholders until a places provider is chosen.
