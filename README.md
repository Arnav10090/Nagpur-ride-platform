# Nagpur Ride Platform

    npm install
    npm test            # memory-backed suites only (no database needed)
    npm run test:pg     # everything, incl. real-Postgres suites (needs Postgres 16 + PostGIS)
                        # default URL postgres://ride:ride@localhost:5432/ride_test (superuser, db must exist)

    DATABASE_URL=postgres://... ACCESS_TOKEN_SIGNING_KEY=<random> npm start   # applies migrations, then serves
    DATABASE_URL=... npm run migrate                                           # migrations only

## Architecture
- `domain/`: state machine, fares (integer paise), ledger math, DispatchService written against a `Repo`/`Db` port.
- `domain/memory.ts`: in-memory Repo (fast tests, dev with no DB).
- `pg/PgDb.ts`: Postgres Repo. One transaction per operation, row locks in a fixed order (offer, ride, driver),
  retry on deadlock/serialization failure, constraint violations mapped to stable domain errors.
- `migrations/`: forward-only SQL. 0002 makes the DATABASE enforce the invariants: one active assignment per ride and
  per driver, one live offer per ride, legal ride transitions only (terminal states final, version +1), immutable final
  fare, append-only audit, balanced append-only ledger.
- `http/`: NestJS API, OTP auth, role/ownership guards, rides, drivers, admin.

## Persisted in Postgres
users, OTP challenges (hashed), sessions (hashed refresh tokens), rides, offers, assignments, ride events, driver presence
(PostGIS GiST), driver profiles, fare quotes, idempotency keys, outbox, double-entry ledger, audit log.
Logins, in-flight rides and queued events all survive a restart.

## Auth
Phone OTP (hash only stored, 5 min expiry, single use even under concurrency, 5 attempts, 30 s resend throttle).
Refresh tokens rotate; presenting a used token revokes all of that user's sessions. Suspension revokes sessions at once.
Staff roles come only from the server-side `ADMIN_PHONES="+91...:OPS_ADMIN,..."` allow-list.

## Realtime
Transactional outbox -> `OutboxWorker` (at-least-once, SKIP LOCKED, exponential backoff, dead-letter after 6 tries)
-> `LiveHub` (Socket.IO). Clients are only ever placed in their own `user:<id>` room and cannot subscribe to anything else.
Events carry `eventId` (dedupe) and `stateVersion` (ordering). Driver GPS is streamed only to the rider of an ACTIVE ride and is
never queued. Sockets are re-validated every 30 s (expired token / suspended account => disconnected).
Workers (outbox 300 ms, offer sweep 1 s, socket revalidation 30 s) start with `npm start`.

## Payments (UPI) - behind a provider interface, FAKE provider only
`domain/payments/provider.ts` is the whole contract a real gateway must implement (create payment, verify webhook, fetch/list for
reconciliation, refund; create and refund MUST be idempotent). `FakeProvider` implements it with HMAC-signed, timestamped webhooks and
controllable failure, and is the only provider wired in. **Production start-up refuses to run until a real provider is supplied.**
- Cash ride: ledger split posts at completion. UPI ride: a PENDING payment is created in the completion transaction; the provider call
  happens after commit (worker retries if the gateway is down); the ledger is written ONLY when a verified provider event confirms capture.
- Webhooks `POST /api/v1/webhooks/payments/:provider`: HMAC over the RAW body (constant-time), 5-minute replay window, amount must match,
  events de-duplicated by (provider, eventId) in the same transaction as their effect. Bad signature 401; duplicate 200; reference we cannot
  place yet 503 (not consumed, so the provider's retry succeeds).
- Double payment (old QR paid after a retry) is booked as a liability and refunded automatically; first capture wins.
- Refunds (FINANCE_ADMIN/SUPER_ADMIN, audited): reserved up front so concurrent refunds cannot exceed the payment; ledger is reversed by
  compensating entries; works with synchronous and asynchronous providers; failures release the reservation.
- Reconciliation (worker every 60 s + `POST /admin/reconciliation/run`): repairs lost webhooks via the same idempotent path; records
  AMOUNT_MISMATCH, MISSING_AT_PROVIDER, ORPHAN_AT_PROVIDER findings (one per kind+reference, re-runs add nothing).
- Database refuses, even from raw SQL: refunding more than paid, editing a payment amount, changing a REFUNDED payment, duplicate provider
  events, a second payment per ride, a captured payment without a provider reference, two automatic refunds for one duplicate capture.
- Dev only: `ENABLE_DEV_TOOLS=1` exposes `POST /api/v1/dev/fake-pay/:providerRef`.

## Live checks against a running server
    DATABASE_URL=... ACCESS_TOKEN_SIGNING_KEY=... ADMIN_PHONES=+919000000009:OPS_ADMIN,+919000000008:FINANCE_ADMIN ENABLE_DEV_TOOLS=1 PORT=3997 npm start > /tmp/pay.log &
    BASE=http://localhost:3997 LOG=/tmp/pay.log npx tsx apps/api/scripts/smoke-pay.ts phase1   # restart the server, then: phase2
    (apps/api/scripts/smoke.ts does the same for dispatch + realtime)

## Mobile apps
`mobile/` holds the rider and driver apps (Expo/React Native), their shared client logic and UI. See `mobile/README.md`.
The API gained what they needed: `GET /rides/:id` returns a role-aware view (pickup/destination/fare; vehicle for the rider only), `GET /rides`
returns history summaries, `GET /drivers/me/active-ride` and `online` in `/drivers/me/status` allow resuming, and cancelling now notifies
drivers holding a live offer.

## Staff console (admin dashboard)
React + Vite app in `mobile/apps/admin`, served by the API itself at `/console` (same origin, no CORS).

    cd mobile && npm install && npm run build:admin      # then `npm start` in the API prints "staff console: /console"
    # sign in at http://localhost:3000/console/ with a phone listed in ADMIN_PHONES, e.g. ADMIN_PHONES="+919000000002:SUPPORT,+919000000005:OPS_ADMIN,+919000000003:FINANCE_ADMIN,+919000000004:SUPER_ADMIN"

- Pages: overview, drivers (approve/reject/suspend/reinstate), rides (search by id/phone/status, full dispute view: timeline, payment,
  refunds, ledger with a debits=credits check), reconciliation (run, resolve with a note), audit log.
- Roles enforced on the SERVER (UI only hides): SUPPORT reads rides/drivers with masked phones; OPS_ADMIN manages drivers and sees full phones;
  FINANCE_ADMIN refunds and reconciles; SUPER_ADMIN everything. Every consequential action requires a written reason that goes to the audit log;
  viewing a ride is itself audited. Resolved findings cannot be reopened (database trigger).
- Security: tokens in sessionStorage only, 15-minute inactivity sign-out, strict CSP (no inline script/style, no framing), no-store shell.

## Not built
Any REAL payment gateway (the fake's signature scheme is a stand-in; a real adapter must map the gateway's own scheme, event names and
refund model, and be tested against its sandbox), settlement/payout of provider funds and driver payouts, chargebacks/disputes, a UI/endpoint
to resolve reconciliation findings, refund status polling for refunds whose webhook is lost, real OTP/SMS, maps/routing and push providers,
per-IP rate limiting, OpenAPI, CI, device testing of the mobile apps (see mobile/README.md), browser testing of the staff console (CSP is NOT enforced by the jsdom test environment; open it in a real browser and check the console for violations), staff-account management UI (staff are granted only via ADMIN_PHONES), exporting/reporting, load/security tests, multi-instance Socket.IO (Redis adapter),
outbox ordering across concurrent workers (clients use stateVersion).
Placeholders needing business decisions (PRD 19.1): fare rates, commission, zone polygon (bounding box now), real payment provider.
Prisma was not used: its engine host is not reachable from the build sandbox. prisma/schema.prisma is reference only.
