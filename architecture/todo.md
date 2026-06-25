# Production Readiness TODOs

Ordered by risk × impact.

> **Legend:** ✅ Done | ⚠️ Partially addressed | 🔲 Pending

---

## ✅ 1. Merge Redundant Company Queries in `loginUser`
**File:** `controller/authController.js`  
**Done:** Collapsed into `SELECT id, slug, name FROM companies WHERE slug = ?`. `companysID` removed; all references updated to `companys[0].id`.

---

## ✅ 2. Eliminate Third Company Query (slug re-fetch from id)
**File:** `controller/authController.js`  
**Done:** Third `pool.query('SELECT slug FROM companies WHERE id = ?')` removed. `userCompanySlug` now reuses `companys[0].slug` already in scope.

---

## ✅ 3. Public Endpoints Bypass Query Builder — No Pagination or Field Selection
**File:** `controller/publicController.js`  
**Done:** All 6 public endpoints now route through `buildQuery` with `pagination: { limit: 200 }` and `jwt: null`. `getCompanyApps` retains a single parameterized company-slug lookup to resolve the `company_id` filter, then delegates to `buildQuery` for the apps read. See `architecture/data-access.md` for the exception rationale.

---

## ✅ 4. INSERT/UPDATE Skip `resourceDef.json` — Use Live Schema Instead of Cache
**File:** `routes/baseResourceRoute.js`, `utils/resourceDef.json`  
**Done:** Added `getResourceWriteAllowlist(resource)` helper that reads `resourceDef.json` and builds a write-column `Set` from (a) field expressions matching the resource's own alias and (b) an explicit `writeFields` array for server-set/write-only columns (password, new_tran, etc.). INSERT and UPDATE now prefer this allowlist over `getTableColumns`; unregistered resources still fall back to schema cache. `writeFields` added to all 11 registered resources in `resourceDef.json`.

---

## ✅ 5. `LIMIT`/`OFFSET` Values Not Cast to Integers in `paginationBuilder.js`
**File:** `utils/queryBuilder/paginationBuilder.js`  
**Done:** `parseInt(limit, 10)` / `parseInt(offset, 10)` applied; throws `Error` on `NaN` or negative values before SQL is built. MySQL2 cannot parameterize LIMIT/OFFSET, so integer casting is the correct defense.

---

## ✅ 6. `loginUser` Features Still Fetched in a Second Round Trip
**File:** `controller/authController.js`  
**Done:** Replaced the two-query pattern (capabilities JOIN → parse features_json → features IN (...)) with a single three-way JOIN using `JSON_TABLE` (MySQL 8.0+). If `JSON_TABLE` is not available (MySQL < 8.0) the query throws and the handler falls back transparently to the original two-query approach. Login with permissions now fires at most 1 DB round trip for the feature lookup instead of 2.

---

## ✅ 7. Replace Blocking `spawnSync` with Async Job Queue
**Files:** `core/jobs/{queue,dispatcher,jobRegistry,jobsStatusRoute}.js`, `apps/audio_intelligence/workers/jobHandlers.js`, `apps/audio_intelligence/controllers/*`  
**Done:** `spawnSync` already replaced by async `spawn`. Background work (transcription + doc-intel) now dispatches through a Bull queue via `core/jobs/dispatcher.enqueue(...)`. Default policy: 3 attempts, exponential backoff from 5s. If Redis is not configured, the dispatcher silently falls back to inline `spawn()` so dev environments without Redis still function. Queue depth and failure counts surface at `GET /api/admin/jobs/status`.

---

## ✅ 8. Cache Schema — Stop Calling `SHOW COLUMNS` Per Request
**File:** `utils/queryBuilder/schemaCache.js`  
**Already implemented:** `schemaCache.js` uses a `Map` keyed by table name. `SHOW COLUMNS` is called at most once per table per server lifetime. Both `sqlBuilder.js` and `baseResourceRoute.js` use `getTableColumns()` which returns the cached `Set` on subsequent calls.

---

## ✅ 9. Add Input Validation Layer
**File:** `controller/authController.js`  
**Done:**  
- Email format (regex) and password min-length (8 chars) validation already in place; kept and confirmed.  
- Removed all console.log calls that leaked sensitive data: raw request body, full user row (including hashed password), JWT payload contents, company validation debug objects.  
- Remaining `console.error` calls log only error messages, not user data.

---

## ✅ 10. Parameterize All Queries in `whereBuilder.js`
**Files:** `utils/queryBuilder/whereBuilder.js`, `securityInjector.js`, `queryBuilder.js`, all callers  
**Done:** `buildWhere` now returns `{ sql, params }` using `?` placeholders for all value types (=, !=, LIKE, NOT LIKE, IN, NOT IN, BETWEEN, comparison operators). `injectSecurity` updated to accept and return `{ sql, params }`. `buildQuery` threads params through and returns `{ sql, params }`. All 3 callers (`userController`, `queryController`, `baseResourceRoute` QUERY path) updated to `pool.query(sql, params)`.

---

## ✅ 11. Fix `role_capability` Schema & Migrate to FK-based Design
**Files:** `models/core-init.sql`, `migrations/core/002_role_capability_fk.sql`, `core/auth/authController.js`, `core/auth/adminController.js`, `resourceDef.json`  
**Done:** Replaced `role`/`team`/`company` string columns with `role_id`/`team_id`/`company_id` FKs to `roles(id)` / `teams(id)` / `companies(id)` (all with `ON DELETE CASCADE`). Migration script backfills via name-join before dropping the string columns. Login query (`authController.js`) and `addRoleCapability` / `updateRoleCapability` (`adminController.js`) updated to use the FK columns. `resourceDef.json` `role_capability` entry now declares the integer fields.

---

## ✅ 12. Add Rate Limiting & Brute-Force Protection
**File:** `index.js`  
**Done:** `express-rate-limit` installed and wired up.  
- Login routes (`/api/:company/:appSlug/auth/*` and `/api/:company/:appSlug/login`): 5 requests/min per IP.  
- Public routes (`/api/public/*`): 60 requests/min per IP.  
Both limiters use `standardHeaders: true` (RateLimit-* headers). A Redis store can be swapped in for multi-instance deployments.

---

## ✅ 13. Add Structured Logging + Health Check Endpoint
**Files:** `index.js`, `core/utils/logger.js`, all `core/` and `apps/` controllers/services/workers  
**Done:**  
- `GET /health` added — queries `SELECT 1` against the DB and returns `{ status, db, uptime }`. Returns 503 if DB is unreachable.  
- `JWT_SECRET` guard added at startup: process exits immediately with a clear fatal error if the env var is missing.  
- `pino` installed; `core/utils/logger.js` exports a configured pino instance (`level: process.env.LOG_LEVEL || 'info'`).  
- `pino-http` wired in `index.js` before all route registration — assigns a `requestId` to every incoming request via `req.id`.  
- All `console.log/warn/error` calls replaced with `logger.info/warn/error` across `index.js`, `db.js`, every file under `core/`, and every `.js` file under `apps/` (`.cjs` workers excluded — they run in a separate CommonJS process). Zero `console.*` remain in in-scope server files.

---

## Honourable Mentions (do these after the top 10)
- **Sync file copies** (`fs.copyFileSync` in audio path) → use `fs.promises.copyFile`
- **CORS** — replace `origin.endsWith(".trycloudflare.com")` with an exact whitelist
- ~~**Transcription worker — add retry logic and failure notification**~~ ✅ Done via Bull queue (TODO 7).
- ~~**Soft deletes**~~ ✅ Done — `deleted_at DATETIME` added to every table; `securityInjector.js` filters by default; DELETE handler converted to UPDATE; admin opt-in via `include_deleted: true`.
- ~~**`appContext` caching**~~ ✅ Done — 60s TTL `Map` keyed by `${companySlug}:${appSlug}`; configurable via `APP_CONTEXT_TTL_MS`.
- ~~**Structured logging**~~ ✅ Done — pino + pino-http installed; all `console.*` replaced across server files; `core/utils/logger.js` is the single logger instance.
