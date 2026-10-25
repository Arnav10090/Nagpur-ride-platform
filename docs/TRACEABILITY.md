# PRD Traceability Matrix

Maps each PRD requirement ID to implementation code and tests.

**Status legend:** ✅ DONE | 🔶 PARTIAL | ❌ NOT DONE

## Rider Requirements (RDR)

| ID | Requirement | Status | Code | Tests | Notes |
|----|------------|--------|------|-------|-------|
| RDR-01 | Phone auth | ✅ | `auth.ts`, `controllers.ts` | `auth.test.ts` (12) | OTP expiry, replay, throttle, attempt limit |
| RDR-02 | Pickup selection | 🔶 | `places.ts` (rider app) | `two-phones.test.tsx` | GPS + 6 landmarks; NO search/pin/map |
| RDR-03 | Fare quote | ✅ | `fare.ts`, `platform.ts`, `controllers.ts` | `domain.test.ts` | Straight-line ×1.3; `GET /fare-quotes/:id` now implemented |
| RDR-04 | Book ride | ✅ | `controllers.ts`, `dispatch.ts` | `e2e.test.ts`, `pg.test.ts` | Idempotent; client never sends fare |
| RDR-05 | Track driver | 🔶 | `realtime.ts`, rider screens | `realtime.test.ts` | Live location works; no ETA; no persisted last position |
| RDR-06 | Cancel ride | ✅ | `platform.ts`, `rideStateMachine.ts` | `domain.test.ts`, `ratings.e2e.test.ts` | Cancellation fee after driver assignment; balanced ledger |
| RDR-07 | Pay | 🔶 | `payments/service.ts` | `payments.test.ts` (22) | FAKE provider only |
| RDR-08 | Ride history | ✅ | `controllers.ts` | `views.e2e.test.ts`, `ratings.e2e.test.ts` | Paginated with cursor; nextCursor |
| RDR-09 | Rate/report | ✅ | `controllers.ts`, `memory.ts`, `PgDb.ts` | `ratings.e2e.test.ts` (6) | 1-5 stars, comment, one per role per ride, duplicate blocked |
| RDR-10 | Safety (SOS) | ✅ | `controllers.ts`, `memory.ts`, `PgDb.ts` | `safety.e2e.test.ts` (2) | SOS panic button, outbox event, admin list/resolve |

## Driver Requirements (DRV)

| ID | Requirement | Status | Code | Tests | Notes |
|----|------------|--------|------|-------|-------|
| DRV-01 | Onboarding | 🔶 | `controllers.ts` | `e2e.test.ts` | Registration only; no documents/vehicle |
| DRV-02 | Availability | ✅ | `controllers.ts` | `e2e.test.ts` | Server-side eligibility |
| DRV-03 | Location | ✅ | `controllers.ts`, `rateLimit.ts` | `e2e.test.ts`, `rateLimit.test.ts` | Rate-limited (2/sec per driver) |
| DRV-04 | Offer | ✅ | `dispatch.ts` | `domain.test.ts` | Expiry + pickup shown |
| DRV-05 | Accept | ✅ | `dispatch.ts` | `domain.test.ts`, `pg.test.ts` | One winner; expired rejected |
| DRV-06 | Arrival | 🔶 | `rideStateMachine.ts` | `e2e.test.ts` | No proximity check |
| DRV-07 | Start trip | 🔶 | `rideStateMachine.ts` | `e2e.test.ts` | No rider PIN/proximity |
| DRV-08 | Complete trip | ✅ | `platform.ts` | `payments.test.ts` | Retry-safe |
| DRV-09 | Earnings | ✅ | `controllers.ts`, `memory.ts`, `PgDb.ts` | `ratings.e2e.test.ts` | Endpoint returns total earnings, commission, rides completed |
| DRV-10 | Offline | ✅ | `dispatch.ts` | `domain.test.ts` | Invalidates offers |

## Admin Requirements (ADM)

| ID | Requirement | Status | Code | Tests | Notes |
|----|------------|--------|------|-------|-------|
| ADM-01 | Driver review | ✅ | `controllers.ts` | `admin.e2e.test.ts` | Reason recorded, audited |
| ADM-02 | Live operations | 🔶 | `controllers.ts` | `admin.e2e.test.ts` | Ride list; no zone/driver/age filters, no live map |
| ADM-03 | Pricing config | ❌ | — | — | Rates are code constants |
| ADM-04 | Reconciliation | ✅ | `payments/service.ts` | `payments.test.ts` | No export/ageing/bulk |
| ADM-05 | Refunds | 🔶 | `controllers.ts` | `payments.e2e.test.ts` | Not idempotency-keyed |
| ADM-06 | Safety incidents | ✅ | `controllers.ts`, `memory.ts`, `PgDb.ts` | `safety.e2e.test.ts` | List/resolve SOS, audited, summary count |
| ADM-07 | Restrictions | ✅ | `controllers.ts` | `admin.e2e.test.ts` | Suspend/reinstate, audited |
| ADM-08 | Audit trail | ✅ | `controllers.ts` | `admin.e2e.test.ts` | Actor, target, reason, time, before/after |

## Security & Infrastructure

| ID | Requirement | Status | Code | Tests | Notes |
|----|------------|--------|------|-------|-------|
| SEC-01 | Rate limiting | ✅ | `rateLimit.ts` | `rateLimit.test.ts` (6) | Per-phone OTP, per-IP OTP, booking, location, webhook, general |
| SEC-02 | Health probes | ✅ | `health.ts` | `health.test.ts` (3) | K8s liveness + readiness |
| SEC-03 | Docker | ✅ | `Dockerfile`, `docker-compose.yml` | CI pipeline | Multi-stage, non-root, PostGIS |
| SEC-04 | CI pipeline | ✅ | `.github/workflows/ci.yml` | — | Backend, mobile, migration idempotency |

## Acceptance Scenarios (AC)

| ID | Scenario | Status | Test | Notes |
|----|----------|--------|------|-------|
| AC-01 | Two drivers accept one ride | ✅ | `pg.test.ts` | 12 rides race for 1 driver |
| AC-02 | Expired offer accepted | ✅ | `domain.test.ts` | Rejected, no assignment |
| AC-03 | Duplicate booking | ✅ | `pg.test.ts` | 15 identical bookings → 1 ride |
| AC-04 | Invalid trip transition | ✅ | `domain.test.ts`, `pg.test.ts` | Structured conflict, DB unchanged |
| AC-05 | Forged UPI success | ✅ | `payments.test.ts` | Client callback alone cannot settle |
| AC-06 | Duplicate payment webhook | ✅ | `payments.test.ts` | 8 concurrent events → 1 effect |
| AC-07 | Cash collection retry | 🔶 | `payments.test.ts` | Idempotent ledger; no "confirm collection" action |
| AC-08 | Unauthorized trip access | ✅ | `e2e.test.ts` | Other users get 404 |
| AC-09 | Stale GPS | ✅ | `domain.test.ts` | Driver excluded from matching |
| AC-10 | Reconnect after network loss | ✅ | `flow.test.ts` | REST state restored |
| AC-11 | Driver goes offline | ✅ | `domain.test.ts` | No new offers after offline |
| AC-12 | DB/worker restart | 🔶 | `pg.test.ts`, `smoke.ts` | Survives restart; no kill-under-load drill |
