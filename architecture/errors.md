# Backend Error Audit
Generated: 2026-05-17

Full audit of `multi_app_be/` cross-referenced against the frontend at `multi_app_fe/`. Only errors that would **break the build / crash at startup** or **break a documented frontend flow** are listed. Each entry includes exact file + function + lines. Grouped by severity: Blocking → High → Medium.

Findings were produced by six parallel read-only audit agents (startup/entry, query layer, auth/middleware, audio_intelligence app, public+jobs, schema/manifest cross-check) and consolidated below. Duplicate findings from multiple agents have been merged.

---

## BLOCKING ERRORS
> Crash the process at startup, or make a core feature unusable end-to-end.

---

### B01 — `logger` used without import in `apps/_loader.js`
**File:** `apps/_loader.js`
**Function:** `loadApps`
**Lines:** 37, 55
**Problem:** Uses `logger.warn(...)` and `logger.info(...)` but never imports `logger`. The summary log at line 55 always runs at startup → `ReferenceError: logger is not defined` → app loader throws → no app modules mount → every audio/document route returns 404.
**Fix:** Add `import { logger } from "../core/utils/logger.js";` at the top.

---

### B02 — `logger` used without import in `core/jobs/jobRegistry.js`
**File:** `core/jobs/jobRegistry.js`
**Function:** `registerAllJobHandlers`
**Lines:** 17, 33, 42, 50, 52 (≈)
**Problem:** Five `logger.*` calls, no import. Invoked from `index.js:198` via top-level `await loadApps(app)` → unhandled rejection → process crashes on boot when Redis init runs.
**Fix:** Add `import { logger } from "../utils/logger.js";` at the top.

---

### B03 — `logger` used without import in `core/jobs/dispatcher.js`
**File:** `core/jobs/dispatcher.js`
**Function:** `enqueue`
**Lines:** 33, 47
**Problem:** `logger.error(...)` calls with no import. First queue failure raises `ReferenceError`, returning 500 instead of the intended inline fallback.
**Fix:** Add `import { logger } from "../utils/logger.js";`.

---

### B04 — `logger` used without import in `apps/audio_intelligence/workers/jobHandlers.js`
**File:** `apps/audio_intelligence/workers/jobHandlers.js`
**Function:** `runDocIntelligenceAsync`, `register`
**Lines:** 69, 76, 77, 93, 112, 122, 127, 141, 148
**Problem:** Nine `logger.*` calls; module never imports `logger`. First job firing throws ReferenceError; all transcription / doc-intelligence jobs fail.
**Fix:** Add `import { logger } from "../../../core/utils/logger.js";`.

---

### B05 — `logger` used without import in `core/query/resourceRegistry.js`
**File:** `core/query/resourceRegistry.js`
**Function:** module-level bootstrap (catch branch)
**Lines:** 86–87
**Problem:** `logger.error(...)` in the bootstrap `catch` with no import. If `resourceDef.json` ever fails to load, you get `ReferenceError: logger is not defined` instead of a real error message — masks the root cause and crashes startup.
**Fix:** Add `import { logger } from "../utils/logger.js";`.

---

### B06 — Missing `/history_analysis` route (matches FE error E04)
**File:** `apps/audio_intelligence/routes/audioRoute.js` (and nowhere else)
**Function:** —
**Lines:** —
**Problem:** The FE `multi_app_fe/src/pages/user/CallHistory.tsx:runHistoryAnalysis` calls `POST /api/${companySlug}/${appSlug}/history_analysis`. Grep across `apps/` and `core/` confirms the route is registered nowhere. Every "Analyze History" click returns 404. Entire CallHistory analysis flow (trajectory, section trends, coaching focus) is broken.
**Fix:** Register a `history_analysis` handler. Two options:
1. Add `router.post("/history_analysis", protect, historyAnalysisController)` in `audioRoute.js` so it lives at `/api/query/v1/audio/history_analysis` (then update the FE to match), OR
2. Add a company/app-scoped route in `apps/audio_intelligence/app.js` so the existing FE path works without FE changes (preferred — preserves the FE convention).

---

### B07 — `securityInjector` adds `deleted_at IS NULL` to tables without that column
**File:** `core/query/queryBuilder/securityInjector.js`
**Function:** `injectSecurity`
**Lines:** 37–40
**Problem:** Any resource not in `globalTables` gets `deleted_at IS NULL` appended. `roles`, `teams`, `role_capability` are not in `globalTables`, and per `models/core-init.sql` they have no `deleted_at` column. MySQL throws `Unknown column 'deleted_at'` → 500 on every `query()` for these resources.
**FE impact:** `AddUser.tsx` (loads roles + teams), `RoleMapping.tsx` (loads roles + capabilities), and any FE flow needing role/team selection breaks entirely.
**Fix:** Add `roles`, `teams`, `role_capability` to the `globalTables` allowlist (or add `deleted_at` columns to those tables).

---

### B08 — `audio_recordings` INSERT references columns absent from schema
**File:** `apps/audio_intelligence/controllers/audioController.js`
**Function:** `uploadAudio`
**Lines:** 57–61, 270–278
**Problem:** Insert payload includes `audio_data`, `status`, `duration_seconds`. `models/core-init.sql` for `audio_recordings` does not declare these columns. `resourceDef.json` lists them in `writeFields`, so the validator passes, but the actual SQL fails with `ER_BAD_FIELD_ERROR`. Audio uploads from `AudioRecorder.tsx` / `Dashboard.tsx` 500.
**Fix:** Either add the columns to `models/core-init.sql` (and write a migration) or remove them from `writeFields` + the controller's insert payload.

---

### B09 — `company_documents` INSERT writes nonexistent `medicines` column
**File:** `apps/audio_intelligence/controllers/documentController.js`
**Function:** `uploadDocument`
**Lines:** 205–208
**Problem:** SQL is `INSERT INTO company_documents (uploader_id, company_id, doc_path, medicines) VALUES (...)`. `models/core-init.sql` defines `company_documents` with `id, uploader_id, company_id, doc_path, uploaded_at, deleted_at` — no `medicines` column. Every company-tab upload in `CompanyDocuments.tsx` returns 500.
**Fix:** Drop `medicines` from the `company_documents` INSERT (it belongs only to `team_documents`).

---

### B10 — FE `team_documents.medicine` field has no BE mapping
**Files:**
- `multi_app_fe/src/api-builder/manifest.json` (`team_documents.fields` uses `"medicine"`)
- `apps/audio_intelligence/resourceDef.json` (`team_documents.fields` / `writeFields` declare `"medicines"`)
- `models/core-init.sql` (column is `medicines`)
**Function:** any `query({ resource: "team_documents", fields: ["medicine"] })`, e.g. `Dashboard.tsx:loadMedicines` (after FE fix E03 the FE now sends `medicine`)
**Problem:** Field name mismatch: FE sends `medicine` (singular); BE resourceDef + SQL use `medicines` (plural). `sqlBuilder.js` silently drops unknown fields → query returns `SELECT 1 AS _empty` → empty result. Dashboard medicine-selector dropdown is always empty → user cannot start a practice session.
**Fix:** Pick one canonical name. Recommended: add `"medicine": "td.medicines"` as an alias in the BE `team_documents.fields` (and same alias in `writeFields`) so the FE's `medicine` resolves to the real DB column. Alternative: rename the DB column to `medicine` and update BE resourceDef + the `updateMedicine` controller mapping.

---

### B11 — `features_capability` missing `id` and `feature_id` in BE resourceDef
**Files:**
- `resourceDef.json` (root) `features_capability.fields` — only `capability_id`, `name`, `features_json`
- `multi_app_fe/src/pages/admin/RoleMapping.tsx` (after FE fix E07) requests `fields: ["id", "feature_id", "capability_id"]`
**Problem:** Unknown fields are dropped by `sqlBuilder.js`; both `id` and `feature_id` are absent from the BE def, so the SELECT falls back to `SELECT 1 AS _empty`. `RoleMapping.tsx` capability list is empty → admin can never assign capabilities to roles.
**Fix:** Add `"id": "fc.id"` and `"feature_id": "fc.feature_id"` to `features_capability.fields` (and matching `fieldTypes`).

---

### B12 — `roles.role_tag` requested by FE but not exposed by BE
**Files:**
- `resourceDef.json` (root) — `roles.fields` lists only `id`, `name`
- `multi_app_fe/src/pages/admin/AddUser.tsx` line 66 and `RoleMapping.tsx` line 48 request `["id", "name", "role_tag"]`
**Problem:** `role_tag` is silently dropped from SELECT. Any FE logic branching on role tag (permissions UI gating, role-type rendering) returns `undefined`.
**Fix:** Add `"role_tag": "r.role_tag"` to `roles.fields` and `"role_tag": "string"` to `roles.fieldTypes` in `resourceDef.json`. Also confirm the column exists in `models/core-init.sql` and add it if missing.

---

### B13 — Schema/manifest field drift on `users`, `companies`, `apps`, `features`, `audio_recordings`
**Files:**
- `models/core-init.sql`
- `resourceDef.json` (root)
- `multi_app_fe/src/api-builder/manifest.json`

**Problem:** Several fields listed in the FE manifest are missing from the BE SQL schema and/or BE resourceDef. SELECTs return NULL silently; INSERT/UPDATE validation may reject. Specific gaps:

| Resource | Field | In FE manifest? | In BE resourceDef? | In SQL schema? | Effect |
|---|---|---|---|---|---|
| `users` | `age` | ✅ | ✅ writeFields | ❌ | SELECT returns NULL; UPDATE → `Unknown column` |
| `users` | `status` | ✅ | ✅ writeFields | ❌ | same |
| `users` | `company_id` | ✅ (filter) | ❌ fields/fieldTypes | ✅ | `whereBuilder` defaults to string-type → LIKE on integer; team-member filter unreliable |
| `companies` | `status`, `created_at` | ✅ | ❌ | ❌ | FE company list reads return undefined |
| `apps` | `status`, `created_at` | ✅ | ❌ | ❌ | FE app list reads return undefined |
| `features` | `name` | ✅ | ✅ | ❌ | FE feature labels render undefined |
| `audio_recordings` | `processed_audio` | ✅ | ❌ | ❌ | FE audio review crashes / blank |

**Fix:** For each row, decide canonical location (SQL schema is authoritative), then add the column via migration + update `resourceDef.json` + (optionally) prune the FE manifest of fields that truly don't exist. The audit found this as a single class of bug — treat it as one ticket to walk through methodically.

---

## HIGH-PRIORITY ERRORS
> Important features broken, but other parts of the app remain usable.

---

### H01 — `loginUser` company-membership check is a no-op
**File:** `core/auth/authController.js`
**Function:** `loginUser`
**Lines:** 64–77
**Problem:** `userCompanySlug` is set unconditionally to `companys[0].slug` (i.e. the slug from the URL), then compared to itself. The branch always passes, so a user from Company A can log in at Company B's URL and receive a valid session. Auth is not company-scoped.
**FE impact:** Cross-company auth leakage; user objects returned to the FE will not match the company the user is actually associated with.
**Fix:** Compare `user.company_id === companys[0].id` (or use the `users.company` slug column), not the URL-derived slug.

---

### H02 — `loginUser` returns `uiPermissions` as objects, not slug strings
**File:** `core/auth/authController.js`
**Function:** `loginUser`
**Lines:** 125–130
**Problem:** `architecture/API_REFERENCE.md` §4 documents `uiPermissions: string[]` (array of feature slugs). The controller actually returns `[{ id, feature_name, feature_tag, type }, ...]`. The FE `AuthContext.tsx` types it `any[]`, so no crash, but any `uiPermissions.includes("some_tag")` check always returns false → every permission-gated UI element is silently hidden.
**FE impact:** All feature-flag-gated UI is invisible to every user.
**Fix:** Map to strings: `uiPermissions = featureRows.map(f => f.feature_tag)`.

---

### H03 — Production cookie `sameSite: "strict"` + logout token-order bug
**File:** `core/auth/authController.js`
**Function:** `loginUser` (cookie set), `logoutUser`
**Lines:** 157–161 (cookie options)
**Problem:**
1. In production, the auth cookie is set with `sameSite: "strict"`, which a browser never sends on cross-origin requests. FE is hosted on a different origin → the cookie is set but never sent back, so cookie-based auth is non-functional in production deployments.
2. Separately, in `multi_app_fe/src/contexts/AuthContext.tsx` the `logout()` flow removes the token from `localStorage` *before* calling the backend logout, so the axios interceptor sends no `Authorization` header. With the cookie also unsent (above), the logout call hits the server unauthenticated → the httpOnly cookie is never cleared server-side.
**FE impact:** Logout does not actually invalidate the session; cross-origin auth requires bearer tokens for everything (it does work because of localStorage, but the cookie is dead weight that won't reset on logout).
**Fix:** Set `sameSite: "none", secure: true` in production. In the FE, call backend logout *before* clearing localStorage (note: cannot be fixed inside the BE — flag for FE follow-up).

---

### H04 — `loginUser` can build `dashboardRoute` with `null` appSlug
**File:** `core/auth/authController.js`
**Function:** `loginUser`
**Lines:** 163–168
**Problem:** `dashboardRoute` interpolates `appSlug`, which can be null if `appContext` didn't resolve `req.app`. Result: `/${companySlug}/null/quick-actions`. FE `Login.tsx` navigates into a broken URL.
**Fix:** Either return 400 when `req.app` is unresolved, or compute `dashboardRoute` only from `req.app?.slug` and short-circuit if it's missing.

---

### H05 — `ALLOWED_ORIGINS` hardcoded; routers mounted without `protect`
**File:** `index.js`
**Lines:** 40–45 (CORS list), 180–186 (route mounts)
**Problem:**
1. CORS hardcodes `https://multi-app-fe.vercel.app` and a few localhost entries. `multi_app_fe/.env` references a different production host. Any FE deployed at a non-listed origin gets CORS errors on every credentialed request.
2. `app.use("/api/:company/:appSlug/admin", adminRoutes)`, `.../user`, `.../app` are mounted **without** `protect` at the router boundary. Per `architecture/API_REFERENCE.md` these are JWT-required. Any controller that omits its own protect call is silently public.
**Fix:**
1. Drive `ALLOWED_ORIGINS` from `process.env.CORS_ORIGINS` (comma-separated). Document the contract.
2. Add `protect` as a second arg to each `app.use(...)` mount for admin/user/app routers.

---

### H06 — `team_documents` / `company_documents` field shape mismatch (`title`, `file_url`)
**Files:**
- `multi_app_fe/src/api-builder/manifest.json` (lines ≈147–167) — uses `title`, `file_url`
- `apps/audio_intelligence/resourceDef.json` (lines ≈51–93) — uses `doc_name`, `doc_path`
**Problem:** Any FE query that asks for `title` or `file_url` gets those fields silently dropped from the SELECT. Document-listing UI shows blank titles and unclickable rows.
**Fix:** Add aliases in BE resourceDef: `"title": "cd.doc_name"`, `"file_url": "cd.doc_path"` (and same for `td.*`). Alternatively rename FE manifest fields. The BE alias path is less risky.

---

### H07 — `getCapabilities` returns join-table rows, not capability objects
**File:** `core/public/publicController.js`
**Function:** `getCapabilities`
**Lines:** 92–96
**Problem:** Queries `resource: "features_capability"`, returning rows with `{feature_id, capability_id, ...}`. The documented public route shape (per `API_REFERENCE.md`) is `[{ id, name, ... }]`. Even after FE migration to api-builder for capabilities (RoleMapping), any caller of `/api/public/capabilities` (legacy or future) gets unrenderable rows.
**Fix:** Either query a true `capabilities` resource (add one to the registry), or restructure the response to `{ id, name, features: [...] }`.

---

## MEDIUM-PRIORITY ERRORS
> Will cause bugs, intermittent failures, or correctness drift, but core flows still work.

---

### M01 — Static frontend + SPA catch-all registered before app routes
**File:** `index.js`
**Lines:** 78–104 (static + SPA fallback), 198 (`await loadApps(app)`)
**Problem:** `express.static` and the SPA catch-all are registered before app-module routes mount. The path-regex correctly excludes `/api`, `/uploads`, `/debug`, but a static file whose path collides with an API segment can shadow it. Also, the `process.cwd() + "../frontend/dist"` path almost never resolves in production back-end deploys.
**Fix:** Move static + SPA fallback to after `await loadApps(app)`. Drive the path from an env var or document that this block is dev-only.

---

### M02 — `joinMapper.mapJoins` always LEFT JOINs every relation
**File:** `core/query/queryBuilder/joinMapper.js`
**Function:** `mapJoins`
**Lines:** 16–20 (legacy fallback branch)
**Problem:** `sqlBuilder.js` calls `mapJoins(parsedResource)` without `requestedFields`, hitting the fallback that joins every declared relation. For `users` this always joins `teams`, even when the FE asks only for `id, name, email`. Risk: row duplication on fan-out (e.g., a user with multiple team memberships in future schemas), unnecessary I/O.
**Fix:** Pass `requestedFields` from `sqlBuilder.js` → only emit joins required to project the requested fields.

---

### M03 — Double `protect` invocation in upload controllers
**File:** `apps/audio_intelligence/controllers/audioController.js`, `documentController.js`
**Function:** `uploadAudio` (lines 27–38), `uploadDocument` (lines 17–26)
**Problem:** `protect` is already on the route in `audioRoute.js` / `documentRoute.js`. Controllers also call `protect()` internally. The second invocation re-verifies JWT and checks `res.headersSent`; under certain edge cases (multer pre-write, error paths) it can spuriously 401 an authenticated request.
**Fix:** Remove the manual `protect()` call from inside the controllers.

---

### M04 — `runDocIntelligenceAsync` resolves Python path from `process.cwd()`
**File:** `apps/audio_intelligence/workers/jobHandlers.js`
**Function:** `runDocIntelligenceAsync`
**Lines:** 63–67
**Problem:** Uses `path.join(process.cwd(), "workers", "rag", "doc_intelligence.py")`. Works only if `cwd` is repo root; any process manager that sets `cwd` elsewhere makes the spawn silently fail (job retried, then marked failed; no startup crash).
**Fix:** Use `path.join(__dirname, "../../../workers/rag/doc_intelligence.py")` (resolved from file).

---

### M05 — `docIntelligence.js` does not null-guard `child.stdout` / `child.stderr`
**File:** `apps/audio_intelligence/services/docIntelligence.js`
**Function:** `runDocIntelligence`
**Lines:** 24–29
**Problem:** `child.stdout.on(...)` and `child.stderr.on(...)` called unconditionally. If `spawn` fails to open (Python missing), `stdout`/`stderr` can be `null` → `TypeError: Cannot read properties of null` → unhandled exception in async chain. `jobHandlers.js` already guards these; the inline fallback exported here does not.
**Fix:** Wrap both listeners in `if (child.stdout) { ... }` / `if (child.stderr) { ... }`.

---

### M06 — `adminController.addUser` is dead but mismatched with current FE
**File:** `core/auth/adminController.js`
**Function:** `addUser`
**Lines:** 9, 54–57
**Problem:** Accepts role/team as **names** and resolves server-side; FE `AddUser.tsx` now goes through `mutate({resource:"users"})` sending pre-resolved integer IDs. Not currently exercised, but if a path ever calls `POST /admin/register` directly, `role_id`/`team_id` will be inserted as null silently.
**Fix:** Either remove the endpoint, or rewrite it to accept IDs and validate against current schema.

---

### M07 — `protect` accepts empty-string service token
**File:** `core/middleware/authmiddleware.js`
**Function:** `protect`
**Lines:** 14–28
**Problem:** Service-token comparison is strict-equality. If `WORKER_SERVICE_TOKEN` env is set to `""`, an `Authorization: Bearer ` (empty bearer) request authenticates as a service user.
**Fix:** Guard: only honor the service token if it's set and ≥ 16 chars (`process.env.WORKER_SERVICE_TOKEN && process.env.WORKER_SERVICE_TOKEN.length >= 16`).

---

### M08 — `KNOWN_QUEUE_NAMES` hardcoded in jobs status route
**File:** `core/jobs/jobsStatusRoute.js`
**Function:** route handler
**Lines:** 13
**Problem:** Hardcoded `["audio_intelligence"]`. Future queues won't appear in the admin Jobs Status dashboard until this list is updated.
**Fix:** Export the canonical queue list from `core/jobs/queue.js` and reuse it here.

---

### M09 — `uploader_id` not in `company_documents.writeFields`
**File:** `apps/audio_intelligence/resourceDef.json`
**Resource:** `company_documents`
**Problem:** `uploader_id` is set correctly by the direct INSERT path in `uploadDocument`, but if a write ever goes through the generic `/base_resource` route, `uploader_id` is silently dropped → NULL uploader on the row.
**Fix:** Add `"uploader_id"` to `company_documents.writeFields`.

---

## SUMMARY TABLE

| ID | Severity | File | Lines | Description |
|----|----------|------|-------|-------------|
| B01 | **BLOCKING** | `apps/_loader.js` | 37, 55 | `logger` used without import |
| B02 | **BLOCKING** | `core/jobs/jobRegistry.js` | 17, 33, 42, 50, 52 | `logger` used without import |
| B03 | **BLOCKING** | `core/jobs/dispatcher.js` | 33, 47 | `logger` used without import |
| B04 | **BLOCKING** | `apps/audio_intelligence/workers/jobHandlers.js` | 69+ | `logger` used without import |
| B05 | **BLOCKING** | `core/query/resourceRegistry.js` | 86–87 | `logger` used without import |
| B06 | **BLOCKING** | `apps/audio_intelligence/routes/audioRoute.js` | — | Missing `history_analysis` route (FE E04) |
| B07 | **BLOCKING** | `core/query/queryBuilder/securityInjector.js` | 37–40 | `deleted_at` injected on tables w/o that column |
| B08 | **BLOCKING** | `apps/audio_intelligence/controllers/audioController.js` | 57–61, 270–278 | INSERT references missing columns (`audio_data`, `status`, `duration_seconds`) |
| B09 | **BLOCKING** | `apps/audio_intelligence/controllers/documentController.js` | 205–208 | `company_documents` INSERT writes nonexistent `medicines` column |
| B10 | **BLOCKING** | `apps/audio_intelligence/resourceDef.json` + `models/core-init.sql` | — | `team_documents.medicine` (FE) vs `medicines` (BE/SQL) — dropdown empty |
| B11 | **BLOCKING** | `resourceDef.json` (root) | — | `features_capability` missing `id`, `feature_id` fields |
| B12 | **BLOCKING** | `resourceDef.json` (root) | — | `roles.role_tag` not exposed |
| B13 | **BLOCKING** | multiple | — | Schema/manifest drift (users, companies, apps, features, audio_recordings) |
| H01 | **HIGH** | `core/auth/authController.js` | 64–77 | Company-membership check is a no-op |
| H02 | **HIGH** | `core/auth/authController.js` | 125–130 | `uiPermissions` returned as objects, not strings |
| H03 | **HIGH** | `core/auth/authController.js` | 157–161 | Prod cookie `sameSite:"strict"` blocks cross-origin |
| H04 | **HIGH** | `core/auth/authController.js` | 163–168 | `dashboardRoute` can contain `null` appSlug |
| H05 | **HIGH** | `index.js` | 40–45, 180–186 | CORS hardcoded; admin/user/app routers missing `protect` |
| H06 | **HIGH** | `apps/audio_intelligence/resourceDef.json` | 51–93 | `title`/`file_url` (FE) vs `doc_name`/`doc_path` (BE) |
| H07 | **HIGH** | `core/public/publicController.js` | 92–96 | `getCapabilities` returns wrong shape |
| M01 | **MEDIUM** | `index.js` | 78–104 | Static SPA fallback registered before app routes |
| M02 | **MEDIUM** | `core/query/queryBuilder/joinMapper.js` | 16–20 | Always joins all relations |
| M03 | **MEDIUM** | `apps/audio_intelligence/controllers/{audio,document}Controller.js` | 27–38 / 17–26 | Double `protect` invocation |
| M04 | **MEDIUM** | `apps/audio_intelligence/workers/jobHandlers.js` | 63–67 | Python path resolved from `process.cwd()` |
| M05 | **MEDIUM** | `apps/audio_intelligence/services/docIntelligence.js` | 24–29 | `child.stdout`/`stderr` not null-guarded |
| M06 | **MEDIUM** | `core/auth/adminController.js` | 9, 54–57 | `addUser` dead + mismatched with FE |
| M07 | **MEDIUM** | `core/middleware/authmiddleware.js` | 14–28 | Empty `WORKER_SERVICE_TOKEN` would grant service auth |
| M08 | **MEDIUM** | `core/jobs/jobsStatusRoute.js` | 13 | `KNOWN_QUEUE_NAMES` hardcoded |
| M09 | **MEDIUM** | `apps/audio_intelligence/resourceDef.json` | — | `uploader_id` not in `company_documents.writeFields` |
