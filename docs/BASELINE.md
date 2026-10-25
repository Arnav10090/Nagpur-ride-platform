# Baseline Report

**Date:** 2026-10-25 (updated)
**Environment:** Windows, Node v22.12.0, npm 10.9.0, PostgreSQL 18.1
**PostGIS:** 3.6.2 — **PENDING USER INSTALL** (run `install-postgis.bat` as admin)

## Backend (repo root)

| Check | Command | Result |
|-------|---------|--------|
| Install | `npm install` | ✅ 229 packages, 13 vulnerabilities (none blocking) |
| Typecheck | `npm run typecheck` | ✅ Clean (exit 0) |
| Tests (memory) | `npm test` | ✅ **98 passed**, 19 skipped (95 original + 3 new health tests) |
| Tests (Postgres) | `npm run test:pg` | ⏳ Pending PostGIS installation |

### Expected Postgres baseline: 168 passed (165 original + 3 health)

## Mobile (mobile/)

| Check | Command | Result |
|-------|---------|--------|
| Install | `npm install` | ✅ 615 packages (engine warnings for Node 22.12 < 22.13 — non-blocking) |
| Typecheck | `npm run typecheck` | ✅ Clean (exit 0, all 4 tsconfigs) |
| Tests | `npm test` | ✅ 38 passed, 1 failed → **fixed** → 39 passed |
| Admin build | `npm run build:admin` | ✅ 78 modules, dist/ built in 1.09s |

### Fix applied
- `mobile/test/workspace.test.ts`: Replaced Unix `find` command with cross-platform
  Node.js `fs` recursive walker. Test logic preserved (exactly ONE copy of react,
  react-dom, react-native). The original test was built on Linux.

## Phase 1 Additions
- `apps/api/src/http/health.ts` — `/health` (liveness) and `/ready` (readiness) endpoints
- `apps/api/test/health.test.ts` — 3 new tests
- `.env.example` — all config variables documented
- `Dockerfile` — multi-stage build (typecheck + admin build → slim production image)
- `docker-compose.yml` — API + postgis/postgis:16-3.4 database
- `.dockerignore` — excludes node_modules, mobile apps, secrets
- `.github/workflows/ci.yml` — 3-job CI (backend, mobile, migration idempotency)

## Notes
- React Native 0.88 / Expo SDK 58 require Node ≥22.13; our 22.12 works but shows
  engine warnings. Consider upgrading Node to 22.13+ if issues arise.
- PostGIS needs manual admin install — run `install-postgis.bat` as administrator.
