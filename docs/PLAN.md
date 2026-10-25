# Implementation Plan

**Created:** 2026-10-24  
**Baseline:** 95 backend tests (memory), 39 mobile tests, all typechecks clean, admin builds.  
**Target:** PRD completeness with automated evidence at each phase.

---

## Phase 1: Contracts & Delivery Spine
1. Create `packages/contracts` with shared DTOs, event schemas (schemaVersion, eventId, occurredAt), error codes, and zod validation schemas
2. Create `packages/validation` with shared zod schemas for API request/response validation
3. Write OpenAPI 3.1 spec for all existing + new endpoints; validate in CI
4. Add `/health` (liveness) and `/ready` (DB + migrations + workers) endpoints
5. Structured JSON logging with request-id propagation and redaction (phones, tokens, coordinates)
6. Dockerfiles + docker-compose (api + postgres/postgis) + `.env.example`
7. CI pipeline config (GitHub Actions): install, lint, typecheck, tests, builds, migration checks
8. Delete hand-copied client types; import from contracts package

**Exit criteria:** CI green on fresh clone; OpenAPI validates; shared contracts; baseline tests green.

## Phase 2: Security Hardening
1. Rate limiting (per IP + per account) on OTP, booking, location, search, webhooks
2. Location ingestion rate limit (DRV-03); `DriverLocation` history table; bigint sequence column
3. Staff MFA (TOTP) for privileged roles; session list + forced sign-out; staff management UI
4. Refund + admin POST idempotency keys
5. Missing foreign keys; retention/cleanup jobs (OTP, sessions, idempotency, outbox)
6. Webhook hardening; secure headers (HSTS); secrets via env abstraction
7. Security test suite: IDOR/privilege escalation across every route

**Exit criteria:** Authorization matrix 100% coverage; rate-limit tests pass.

## Phase 3: Core Domain Completion
1. Data model: `Vehicle`, `DriverDocument`, `ServiceZone` (PostGIS), `PricingRule`, `Rating`, `Payout`, `SupportTicket`, `SafetyIncident`, `Notification`, `DriverLocation`
2. Pricing/zone admin (ADM-03): versioned rules, activation, audit
3. Cancellation policy + fee (RDR-06): rules, ledger, driver compensation
4. Arrival/start checks (DRV-06/07): proximity, rider trip PIN, no-show
5. Cash workflow (PRD 11.3): confirm collection, clearing, balances, limits
6. Earnings (DRV-09) + payouts model
7. Ratings (RDR-09), receipts (RDR-08), history pagination, profile endpoints
8. Account deletion + data export

**Exit criteria:** All RDR/DRV tests on memory + Postgres; ledger balanced in property tests; AC-07/AC-12 fully evidenced.

## Phase 4: Safety, Support & Operations
1. Rider/driver safety: SOS, trusted contacts, share-trip, incident report
2. Safety incident queue (ADM-06): severity, access, escalation, SLA
3. Support tickets with trip linkage
4. Live operations view: filters, stuck-ride detection, live map
5. Finance depth: ledger explorer, cash ageing, CSV export
6. Notifications service + push provider interface (fake + Expo/FCM)

**Exit criteria:** ADM-01..08 all implemented; incident/ticket flows role-tested; push proven with fake.

## Phase 5: Maps & Dispatch Quality
1. Geocoding/autocomplete (`GET /places/autocomplete`)
2. Routing for real distance/time in quotes and ETA in dispatch
3. Map screens in both apps (live tracking, pin, route)
4. ETA display; persisted last driver location (RDR-05)
5. Dispatch metrics; radius expansion; per-zone tunables

**Exit criteria:** Routing-based ETA with tested fallback; metrics emitted.

## Phase 6: Real Providers (needs owner credentials)
1. Payment gateway adapter → sandbox validation
2. SMS/OTP adapter
3. Push, maps, object storage adapters
4. Remove production start-up refusal when all required providers are real

**Exit criteria:** Provider contract tests pass in sandbox; failure injection passes.

## Phase 7: Mobile Reality (needs device access)
1. EAS development builds
2. Background location (Android foreground service, iOS background modes)
3. Handle lock/kill/battery/GPS-loss
4. Secure storage review; UPI deep links
5. Crash reporting; Hindi/Marathi localisation; accessibility

**Exit criteria:** Device evidence or explicit DEVICE_TEST_PLAN.md.

## Phase 8: Observability & Resilience
1. Metrics (Prometheus/OTel) + dashboards + alerts
2. Redis: Socket.IO adapter, presence, rate limits
3. Load tests at declared baseline; failure injection
4. Backup/restore and rollback drills

**Exit criteria:** NFR results in PERFORMANCE.md; drills documented.

## Phase 9: Pilot Readiness
1. Go/no-go checklist evidence (PRD 17.1)
2. Readiness report, updated context.txt
3. Staging guide, operations handbook, playbooks

**Exit criteria:** Honest GO/NO-GO per gate in READINESS_REPORT.md.

---

## Current Status
- [x] Orient and read context.txt + PRD
- [x] Install all dependencies
- [x] Establish memory-only backend baseline (95 passed)
- [x] Establish mobile baseline (39 passed after workspace.test.ts fix)
- [x] Backend typecheck clean
- [x] Mobile typecheck clean
- [x] Admin console builds
- [ ] Install PostGIS and run Postgres-backed tests (165 target)
- [ ] Begin Phase 1
