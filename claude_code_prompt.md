# MISSION BRIEF FOR CLAUDE CODE: finish the Nagpur ride-hailing platform

You are taking over an in-progress, well-tested codebase and driving it toward the
PRD. Read this whole brief first. It is long on purpose: it encodes lessons that
cost real debugging time.

---------------------------------------------------------------------------------
## 0. THE THREE INPUTS (put them in your working directory)

1. `nagpur-ride-platform.zip`  - the current project (backend, rider app, driver app,
   staff console, tests). Unzip it to `./nagpur-ride-platform`.
2. `context.txt`               - a 19-section briefing: what exists, how it is built,
   how it was verified, what is NOT verified, every gap, every deviation from the
   PRD, owner decisions needed, and what a successful ride-hailing product looks like.
3. `Nagpur_Ride_Hailing_Platform_PRD.docx` - the contract. Convert to text first
   (`pandoc -t plain` or python-docx) so you can grep it.

**Authority order when they disagree:** PRD (requirements) > actual code and tests
(what is true today) > context.txt (a faithful but human-written summary that may
contain errors; VERIFY its claims before relying on them).

---------------------------------------------------------------------------------
## 1. YOUR JOB IN ONE PARAGRAPH

Implement everything the PRD requires that can be implemented and PROVEN by engineering
alone, in the PRD's own build order, keeping every existing invariant and test green,
and produce evidence for each step. For work that genuinely needs the owner (business
decisions, provider contracts, legal review, staffing, physical devices you do not
have), build the engineering side behind interfaces with sandbox/fake implementations,
document exactly what remains, and STOP to ask rather than guess. "Complete" means:
every PRD functional requirement (RDR-01..10, DRV-01..10, ADM-01..08) and acceptance
scenario (AC-01..12) is implemented with automated evidence, the engineering-owned items
of the go/no-go checklist (PRD 17.1) are evidenced, and a final readiness report honestly
lists what only humans can close. It does NOT mean "the app is ready for real riders".

---------------------------------------------------------------------------------
## 2. FIRST HOUR: ORIENT AND ESTABLISH A TRUSTED BASELINE (do not skip)

1. Read `context.txt` fully. Then read the PRD sections it points at (esp. 5-7, 9-11,
   13-17). Skim the code: `apps/api/src/domain/*`, `apps/api/src/http/*`,
   `mobile/packages/client/src/*`.
2. Install and run EVERYTHING before changing anything:
   - Node 22+, PostgreSQL 16 + PostGIS (install if missing; start the cluster).
     Test DB: user `ride`/`ride` (superuser), database `ride_test`.
   - Backend (repo root): `npm install`, `npm run typecheck`, `npm test` (memory only),
     then `TEST_DATABASE_URL=postgres://ride:ride@localhost:5432/ride_test npm test`.
     Expected baseline: **165 passed on Postgres**.
   - Mobile (`cd mobile`): `npm install`, `npm run typecheck`, `npm test`
     (expected **39 passed**), `npm run build:admin`.
   - Bundle both apps once: `npm --workspace @rides/rider-app run export:web` etc., and
     `npx expo export --platform android` from each app folder.
3. If your numbers differ from the baseline, STOP and find out why (environment? a
   latent bug? a flaky test?) before building. Record your baseline in `docs/BASELINE.md`.
4. Write a short plan (<= 1 page) and the ordered task list. Post it to the user and
   proceed unless they object. Use your todo/plan mechanism and keep it current.

---------------------------------------------------------------------------------
## 3. NON-NEGOTIABLE ENGINEERING RULES

These come from the PRD and from bugs already found. Violating them is a defect.

**Correctness**
- The backend owns every business decision. Clients never send a fare, a status, or a
  payment result. Add endpoints as named domain commands, never "set status".
- Postgres is the final referee. New invariants belong in constraints/triggers/partial
  unique indexes, with a test that attacks them using RAW SQL (see `pg.test.ts`).
- Redis (if you add it) is NEVER the only guard for assignment or money.
- Money is integer paise. Ledger is append-only double-entry; corrections are
  compensating entries; every ledger transaction has a deterministic idempotent id.
- Concurrency lock order is OFFER -> RIDE -> DRIVER. Preserve it. Add a concurrency test
  with real parallel connections for any new write path that can race.
- Any state that must survive a refusal (OTP attempts, offer expiry) must be COMMITTED,
  then the error thrown AFTER the transaction. The in-memory `Store` does not roll back;
  never write-then-throw in domain code.
- Authorization checks run actor/ownership FIRST, then state. Outsiders get 404.
- Events are at-least-once: include `eventId`, dedupe consumers, order by `stateVersion`.
  Realtime is a hint; apps resync from REST.

**Security**
- No secrets, OTPs, tokens, or raw payment data in logs or in the repo. Hash at rest.
- Staff roles come only from the server allow-list / staff admin tooling, never from a
  client-supplied role.
- Never loosen the console CSP (no `unsafe-inline`/`unsafe-eval`). No inline styles.
- Every privileged action needs a written reason and an audit row (actor, target,
  reason, time, before/after).

**Process**
- Migrations are forward-only SQL files `apps/api/migrations/NNNN_name.sql`. NEVER edit
  an already-applied migration; add a new one. Test against a clean DB AND the previous
  schema. Keep Postgres and in-memory repositories in feature parity; the SAME suite
  must pass on both (`describe.each(['memory','postgres'])` pattern).
- Keep the existing 165 + 39 tests green at every commit. NEVER delete, skip, or weaken
  a test to get green. If a test is wrong, fix it and say why in the commit message.
- Prefer small vertical slices (route + domain + DB + client + UI + tests), committed
  when green. Conventional commit messages. No giant rewrites.
- Type-safe end to end. No `any` in new domain code. Shared types must come from one
  source (see Phase 1: contracts package).
- One copy of react/react-dom/react-native in `mobile/` (the guard test enforces it).

---------------------------------------------------------------------------------
## 4. HONESTY AND EVIDENCE RULES (this project's culture)

- Never claim something works unless a test or a run you performed shows it. Say what
  KIND of evidence (unit, real-Postgres, jsdom UI, real device, sandbox provider).
- Distinguish clearly: verified on a device / verified in jsdom / not verified.
- Never fabricate provider behaviour. A payment/SMS/maps adapter is "implemented" only if
  validated against that provider's real sandbox. Without credentials, build the adapter
  to the documented API, mark it UNVERIFIED, and keep the fake for tests.
- Never claim legal or regulatory compliance. Produce engineering support (data export,
  deletion, retention jobs, audit) and list legal questions for counsel.
- If a requirement is ambiguous or conflicts with another, say so and propose the safest
  reading; do not silently pick.
- Update `context.txt` as you go (sections 6, 9, 10, 11, 12, 13) so it stays true. It is
  a living document. Also keep `CHANGELOG.md` and a PRD traceability table
  (`docs/TRACEABILITY.md`) mapping each RDR/DRV/ADM/AC id to code + tests.

---------------------------------------------------------------------------------
## 5. HANDLING THINGS ONLY THE OWNER CAN DECIDE

Create `docs/DECISIONS_NEEDED.md` immediately (seed it from context.txt section 14).
For each decision list: question, why it matters, options, your recommended default,
what it blocks, and what you built meanwhile. Ask the human at the checkpoints below.
**Until answered, proceed with these REVERSIBLE defaults** (put them in configuration/
database, never scatter them through code):

- Vehicle category: AUTO only for the pilot. Zone: the existing bounding box, but moved
  into a `ServiceZone` row with a PostGIS polygon column (still a placeholder).
- Fares: existing placeholder rates, moved into versioned `PricingRule` rows.
- Commission 15% (placeholder), cancellation fee INR 20 after driver arrival or 3 minutes
  post-assignment (placeholder), GST handling configurable and OFF.
- Payment provider: keep the `PaymentProvider` interface; implement a SECOND adapter
  against a real gateway's documented sandbox only if the user supplies credentials/choice.
- Maps: implement behind `GeocodingProvider` / `RoutingProvider` interfaces with a fake
  and one real adapter if a provider + key is supplied.
Mark every placeholder with a visible `PLACEHOLDER(decision #n)` comment and list it in
DECISIONS_NEEDED.md.

---------------------------------------------------------------------------------
## 6. THE WORK PLAN (follow this order; each phase has exit criteria)

Stop at each phase boundary with a short report (section 9). Do not start a phase while
the previous one's exit criteria are unmet.

### Phase 1: Contracts and delivery spine (foundation for everything else)
- Create `packages/contracts` (and `packages/validation`) with shared DTOs, event schemas
  (with `schemaVersion`, `eventId`, `occurredAt`), error codes, and zod schemas; make the
  API and all three clients import them. Delete the hand-copied client types.
- Write the OpenAPI 3.1 spec for ALL endpoints (existing + new) and validate it in CI;
  align names with PRD section 9 where cheap; document the remaining deviations.
- Add `/health` (liveness) and `/ready` (DB + migrations + workers) endpoints.
- Structured JSON logging with request-id propagation (the same id in the response
  `meta.requestId`, logs, outbox events and jobs) and redaction (phones, tokens,
  precise coordinates).
- Dockerfile(s), docker-compose (api + postgres/postgis [+ redis]), `.env.example`,
  environment configs (dev/staging/prod) with distinct app identifiers.
- CI (GitHub Actions or equivalent): install locked, lint/format/typecheck, backend tests
  on Postgres service, mobile tests, builds (console, expo export), migration check on a
  clean DB and from the previous schema, dependency audit, SAST (e.g. CodeQL/semgrep).
EXIT: CI green on a fresh clone; OpenAPI validates; shared contracts used everywhere;
baseline tests unchanged and green.

### Phase 2: Security hardening
- Rate limiting (per IP and per account) on OTP request/verify, booking, location,
  search, webhook; abuse/ban hooks; tests that prove limits and that legitimate use is
  unaffected. Use Postgres or Redis; if Redis, keep Postgres authoritative for money/
  assignment.
- Location ingestion rate limit (DRV-03) and a short, retention-limited `DriverLocation`
  history; change the location sequence column to `bigint` (it overflows int4 in ~2032).
- Staff MFA (TOTP and/or WebAuthn) for privileged roles; session list + forced sign-out;
  staff account management UI (SUPER_ADMIN) replacing the env allow-list for steady state.
- Refund and other admin POSTs accept client idempotency keys.
- Missing foreign keys; retention/cleanup jobs (OTP, sessions, idempotency keys, outbox
  archival) with tests.
- Webhook hardening (rate limit, optional provider IP allow-list config), secure headers
  (HSTS etc.) on the API, secrets via env/secret-manager abstraction, key-rotation support.
- Security test suite: IDOR/privilege escalation across every route (generate from the
  OpenAPI role matrix), replay, forgery, mass-assignment.
EXIT: automated authorization matrix test covers 100% of routes; rate-limit tests pass;
no new high/critical audit findings.

### Phase 3: Finish the core domain (PRD sections 5, 6, 8, 11)
- Data model: `Vehicle` (1:N drivers->vehicles), `DriverDocument` (+ object-storage
  interface with local-disk fake), `ServiceZone` (PostGIS polygon), `PricingRule`
  (versioned, non-overlapping), `Rating`, `Payout`, `SupportTicket`, `SafetyIncident`,
  `Notification`, `DriverLocation`. Each with constraints and raw-SQL attack tests.
- Pricing/zone admin (ADM-03) with versioning, activation, audit; quotes read the active
  rule; the quote stores the rule version used.
- Cancellation policy and fee (RDR-06): rules, ledger entries, authoritative result to
  both apps, driver compensation; tests for every branch and for concurrent cancel/accept.
- Arrival/start checks (DRV-06/07): proximity to pickup (configurable), rider trip PIN,
  no-show/wait handling; fare finalisation from actual trip data where available.
- Cash workflow (PRD 11.3): driver "confirm collection", clearing of the cash receivable,
  per-driver outstanding commission balance, limits/blocks, remittance recording,
  dispute/adjustment entries, AC-07 fully (retry creates no duplicate effects).
- Earnings (DRV-09) endpoints + screens; payouts model + batch run + statements (using a
  payout-provider interface with a fake).
- Ratings (RDR-09), receipts/invoices (RDR-08), history pagination, profile endpoints
  (`/users/me`), account deletion and data export workflows honouring retention.
EXIT: every RDR/DRV requirement implemented with tests on memory + Postgres; ledger always
balances in randomized/property tests; AC-07 and AC-12 fully evidenced (add DB-restart and
worker-kill-mid-job tests).

### Phase 4: Safety, support and operations (PRD ADM-02/06, RDR-10)
- Rider/driver safety: SOS, trusted contacts, share-trip link (expiring, read-only,
  privacy-aware), in-trip incident report, route-deviation/long-stop detection hooks,
  masked calling interface (fake provider).
- Admin: safety incident queue (severity, restricted access, assignment, escalation
  history, SLA timers), support tickets (`support.case.updated` event), live operations
  view (filters by state/zone/driver/age, stuck-ride detection, a live map), finance depth
  (ledger explorer, cash-receivable ageing, settlement-file import + matching, manual
  adjustments with dual approval, CSV export), pagination everywhere.
- Notifications service + push provider interface (fake + Expo/FCM adapter) for offers,
  ride status, payment states; in-app inbox.
EXIT: ADM-01..08 all implemented with tests; incident and ticket flows covered by role-
matrix tests; push fan-out proven with the fake provider.

### Phase 5: Maps and dispatch quality
- Geocoding/autocomplete (`GET /places/autocomplete`), routing for real distance/time in
  quotes and for pickup ETA in dispatch (`EtaFn` hook), map screens in both apps (live
  tracking, pin placement, route), ETA display, persisted last driver location so reconnect
  restores it (RDR-05).
- Dispatch metrics (candidate count, offer delivery, response time, acceptance, match
  latency, no-driver rate), optional radius expansion by zone policy, per-zone tunables.
EXIT: routing-based ETA used when available with a tested fallback; metrics emitted.

### Phase 6: Real providers (only with owner input/credentials)
- Payment gateway adapter validated in its SANDBOX (success, failure, timeout, delayed and
  duplicate callbacks, refunds, settlement report ingestion). SMS/OTP adapter. Push, maps,
  object storage. Remove the production start-up refusal ONLY when every required provider
  is real and sandbox-validated. Keep all fakes for tests.
EXIT: provider contract tests pass in sandbox; failure-injection tests (timeouts, 5xx,
duplicates) pass. If credentials are not available, mark UNVERIFIED and stop here.

### Phase 7: Mobile reality (physical devices)
- Create EAS development builds; implement background location (Android foreground
  service + required disclosures, iOS background modes), handle lock/kill/battery
  optimisation/GPS loss/data loss, stop claiming availability when freshness cannot be
  kept; secure storage review; deep links for UPI intents; crash reporting; Hindi and
  Marathi localisation (externalise all strings); accessibility pass (TalkBack/VoiceOver,
  font scaling, contrast); low-end device performance budget.
- If you have an Android emulator, run the critical flows on it and capture evidence. If
  you do NOT have device access, write `docs/DEVICE_TEST_PLAN.md` (step-by-step, expected
  results) for a human to execute, and say clearly that device verification is pending.
EXIT: device evidence attached, or an explicit pending-device list.

### Phase 8: Observability, scale and resilience
- Metrics (Prometheus/OpenTelemetry) + dashboards + alerts for the PRD 14.1 technical and
  business lists; error tracking; runbooks in `docs/runbooks/` (outage, payment provider
  down, stuck rides, reconciliation break, safety incident).
- Redis where justified: Socket.IO adapter for multiple API instances, presence, rate
  limits. Token verification caching. Connection pooling guidance.
- Load tests at a DECLARED baseline (bookings, GPS updates, concurrent dispatch) against the
  PRD NFR table; failure-injection (kill DB/Redis/worker/provider); backup + restore and
  rollback drills with measured RPO/RTO.
EXIT: NFR results recorded in `docs/PERFORMANCE.md` (pass/fail per PRD 14 row); drills
documented with outcomes.

### Phase 9: Pilot readiness package
- Walk the PRD 17.1 go/no-go table; for each gate attach evidence or mark BLOCKED-ON-OWNER.
- Produce: `docs/READINESS_REPORT.md`, updated `context.txt`, staging deployment guide,
  operations handbook, support/safety playbooks, driver and rider help content, data
  protection documentation, and the open legal questions list for counsel.
EXIT: readiness report with an honest GO / NO-GO per gate.

---------------------------------------------------------------------------------
## 7. KNOWN TRAPS (all of these already bit once)

- NestJS: decorators need `experimentalDecorators`; vitest/esbuild has no
  `emitDecoratorMetadata`, so always use explicit `@Inject(...)`. Webhook verification needs
  the RAW body: create apps with `{ rawBody: true }`.
- `Store` (memory) vs `PgDb`: differences in rollback semantics, locking, ordering. Test both.
- OTP is throttled 30 s per phone: tests must use distinct phones or mocked clocks.
- Click-driven UI tests must wait for the button to be ENABLED; loading buttons keep their
  accessible name but ignore clicks.
- Shared-world tests leak state (a stale ride gets re-offered to a later test's driver).
  Use the world-reset helpers; never rely on test order.
- Duplicate React copies bundle fine and pass tests but crash on device. Keep the guard.
- Do not `pkill -f` a pattern that appears in your own command line (it kills the shell).
- Postgres in a sandbox may stop between commands; check `pg_lsclusters` and restart.
- Offer expiry on accept must COMMIT before throwing OFFER_EXPIRED.
- `availableAt` for outbox must be NULL (due now) for new events, never DB `now()`.
- Quotes and final fares are currently identical; do not break "client never sends a fare".
- The console must stay free of inline scripts/styles; CSP is strict by design.

---------------------------------------------------------------------------------
## 8. THINGS NOT TO DO

- Do not rewrite working modules for taste. Extend them.
- Do not remove the in-memory repository; it keeps the fast test loop.
- Do not change existing response shapes the apps depend on without updating contracts,
  clients, and tests in the same change (version the API if breaking).
- Do not add real credentials, real phone numbers, or real payment calls to tests.
- Do not turn on live payments, open registration, or enable production start-up bypasses.
- Do not mark a phase done because the screens render. The PRD forbids that explicitly.
- Do not hide failures: if something cannot be verified, say so in the report.

---------------------------------------------------------------------------------
## 9. CHECKPOINTS AND REPORTING

At each phase boundary (and any time you are blocked) post a report with:
1. WHAT CHANGED (features, migrations, endpoints, screens) in 5-10 bullets.
2. EVIDENCE: exact commands run and results (test counts on memory AND Postgres, mobile
   counts, typecheck, builds). Compare to the baseline.
3. VERIFIED vs UNVERIFIED (device? real browser? real provider?).
4. TRACEABILITY delta (which RDR/DRV/ADM/AC ids moved to DONE).
5. RISKS and any deviations from the PRD (with reasons).
6. DECISIONS NEEDED from the owner (numbered, with your recommended default).
7. NEXT PHASE and what it depends on.
Ask the user before: choosing vendors, spending money, enabling anything live, deleting
data/migrations, or changing a PRD requirement.

---------------------------------------------------------------------------------
## 10. ASK THESE QUESTIONS AT THE START (answers unblock the real work)

Give the user this short list now, with your defaults, and continue meanwhile:
1. Which UPI payment provider, and do you have sandbox credentials?
2. Which SMS/OTP provider (and DLT registration status)? Which maps provider/key?
3. Pilot vehicle categories, and the exact driver document list.
4. Real fare rates, cancellation policy, commission or subscription model.
5. The approved Nagpur service-area polygon and operating hours.
6. Payout model and cash-settlement cadence.
7. Do you have an Android device or emulator setup I should use for Phase 7?
8. Which hosting/cloud and region for staging/production?
9. Languages required at launch (Hindi/Marathi)?
10. Safety scope required for the pilot (SOS, trip PIN, share-trip, call masking)?

---------------------------------------------------------------------------------
## 11. DEFINITION OF DONE (per feature; copy into your PR descriptions)

[ ] Loading, error, empty, offline and recovery states exist where relevant
[ ] API + validation + authorization + persistence implemented; OpenAPI + contracts updated
[ ] State transitions and concurrency enforced server-side (and in the DB where possible)
[ ] Tests: unit + integration + (if racy) real-concurrency + (if UI) rendered-UI test
[ ] Retry/timeout/duplicate/provider-failure behaviour defined and tested
[ ] Logs/metrics/alerts for the new failure modes; no sensitive data in logs
[ ] Security/privacy checks; audit rows for privileged actions
[ ] Passing on memory AND Postgres; typecheck clean; builds succeed
[ ] Documentation + context.txt + traceability updated
[ ] Rollback/forward-fix noted for risky migrations

Begin with section 2. Report your baseline and plan before writing feature code.
