# Important Files

## Entry & Config

### `index.js`
Server bootstrap. Registers core routers (auth, admin, user, app, baseResource, public), CORS, static file serving. After core routes are wired, calls `loadApps(app)` which discovers each app under `apps/<slug>/app.js` and mounts its routes.
**Debt:** Two protected debug endpoints (`/debug/data`, `/debug/jwt`) remain — admin-gated but should be reviewed before prod.

### `db.js`
MySQL connection pool. Pool size configurable via `DB_POOL_SIZE` (default 10). Emits a `warn` log when wait-queue depth exceeds `DB_POOL_WARN_THRESHOLD` (default 3). Exports `getPoolStats()` for the `/health` endpoint. Includes manual `.env` fallback parser if dotenv fails.

### `resourceDef.json` _(project root)_
Core resources only: `users`, `teams`, `companies`, `apps`, `roles`, `features`, `features_capability`, `role_capability`. Loaded synchronously by `core/query/resourceRegistry.js` at module init. Each app owns its own `resourceDef.json` under `apps/<slug>/`.

---

## Core (`core/`) — shared platform infrastructure

### `core/middleware/appContext.js`
Runs on every `/:company/:appSlug/*` request. Populates `req.company` and `req.app`, backed by an in-process TTL cache keyed by `"${companySlug}:${appSlug}"`. TTL configurable via `APP_CONTEXT_TTL_MS` (default 60s). On hit, both DB lookups are skipped.

### `core/middleware/authmiddleware.js`
JWT extraction (cookie → Authorization header only), verification, and company-scope check. `WORKER_SERVICE_TOKEN` bearer bypasses all scoping.

### `core/middleware/versionControl.js`
Validates URL version segment (`/v1/`), attaches feature flags to `req.apiVersion`.

### `core/auth/authController.js`
**Functions:** `loginUser`, `verifyUser`, `logoutUser`.

`loginUser` is a single-round-trip flow: collapsed company query + user + role/team + features via `JSON_TABLE` join.
**Debt:** N+1 capability fetch was eliminated by TODO 6; check `architecture/todo.md` for the remaining items.

### `core/auth/adminController.js`
**Functions:** `registerAdmin`, plus thin helpers (`addUser`, `addFeature`, etc.) that pre-date the generic `/base_resource` dispatcher.

### `core/auth/authRoute.js`, `core/auth/adminRoute.js`
Mount `/api/:company/:appSlug/auth/*` and `/api/:company/:appSlug/admin/*` respectively.

### `core/query/baseResourceRoute.js`
Generic CRUD dispatcher only (~295 lines after the Group 3 extraction). Handles `POST /base_resource` with `operation: query | insert | update | delete`. No app-specific logic — audio/document/transcription routes are in `apps/audio_intelligence/`. The DELETE operation issues a soft-delete `UPDATE ... SET deleted_at = NOW()` rather than a hard `DELETE`.

### `core/query/resourceRegistry.js`
In-memory map of resource slug → definition. Bootstraps with core `resourceDef.json` at module load; each app's `resourceDefs` is merged in by `apps/_loader.js`. Throws at startup on slug collisions. Exports `getResource`, `getAllResources`, `hasResource`, `getResourceWriteAllowlist`, `registerResources`.

### `core/query/userController.js`, `userRoute.js`
`POST /api/:company/:appSlug/user/query` — thin wrapper around `buildQuery`.

### `core/query/appController.js`, `appRoute.js`
`GET /api/:company/:appSlug/app/query` — returns company/app config + settings.

### `core/query/queryController.js`, `queryRoute.js`
Versioned query endpoint (`/query/v1/:resource`). Not currently mounted from `index.js` — kept for compatibility.

### `core/query/queryBuilder/` (8 files)
- `queryBuilder.js` — orchestrator. Calls resourceParser → sqlBuilder → whereBuilder → securityInjector → paginationBuilder. Accepts optional `aggregate` and `includeDeleted` on the config.
- `resourceParser.js` — delegates to `resourceRegistry.getResource()`.
- `sqlBuilder.js` — builds SELECT + JOIN, validates columns via schema cache. When `aggregate` is supplied, builds aggregate SELECT (`COUNT/SUM/AVG/MIN/MAX`) with allowlist-validated `groupBy` columns.
- `whereBuilder.js` — parameterized WHERE clause (`?` placeholders for all operators).
- `securityInjector.js` — appends `company_id = ?` (and optional `team_id IN (?)`); no-op for global tables and when `jwt === null`. Also appends `<alias>.deleted_at IS NULL` by default. Admins can pass `includeDeleted: true` to skip the soft-delete filter; non-admins cannot bypass.
- `paginationBuilder.js` — `ORDER BY` validated against `resourceDef`, `LIMIT/OFFSET` cast to integer.
- `schemaCache.js` — `Map`-backed `SHOW COLUMNS` cache, populated once per table per server lifetime.
- `joinMapper.js` — resolves JOIN definitions.

### `core/public/publicController.js`, `publicApiRoute.js`
Six read-only public endpoints. All route through `buildQuery` with `jwt: null` and a hard `LIMIT 200`. Public-mounted at `/api/public/*` with a 60 req/min rate limiter.

### `core/utils/jwt.js`
`signToken` and `verifyToken` wrappers around `jsonwebtoken`. `JWT_SECRET` presence is validated at server startup in `index.js`.

### `core/utils/logger.js`
Exports a configured `pino` instance (`level: process.env.LOG_LEVEL || 'info'`, `base: { service: 'multi_app_be' }`). Optional pretty-print via `LOG_PRETTY=true` (requires `pino-pretty`). Imported by every server file that logs — this is the single logger for the entire process. `pino-http` is wired in `index.js` before routes, adding `req.id` (UUID) to every request. All `console.*` calls across `core/` and `apps/` `.js` files have been replaced with `logger.*`.

### `core/jobs/`
- `queue.js` — Bull queue singleton factory. Reads `REDIS_URL` (preferred) or `REDIS_HOST`/`REDIS_PORT`. If unreachable, `isQueueAvailable()` returns `false` and `getQueue(name)` returns `null` (callers fall back to inline execution). Default job options: 3 attempts, exponential backoff from 5s, keep 100 completed / 500 failed jobs. Each queue logs a structured `failed` event on retry exhaustion.
- `jobRegistry.js` — `registerAllJobHandlers(appManifests)` iterates each app and calls its `jobHandlers.register({ getQueue })` to attach processors. Called by `apps/_loader.js` after routes are mounted.
- `dispatcher.js` — `enqueue(queueName, jobName, payload, opts, inlineFallback)`. Returns `{ queued: true, jobId }` when Redis is up, otherwise calls the fallback synchronously and returns `{ queued: false, inline: true }`. Controllers only depend on this — they never touch Bull directly.
- `jobsStatusRoute.js` — `GET /api/admin/jobs/status` (protect + requireAdmin). Returns queue depths from `getJobCounts()` for every named queue. Returns `{ available: false, queues: [] }` if Redis is unconfigured.

---

## Apps (`apps/`)

### `apps/_loader.js`
Discovers each subdirectory containing an `app.js`, merges its `resourceDefs` into the registry, then calls `app.register(server)` to mount routes. Invoked once by `index.js` at startup.

### `apps/audio_intelligence/app.js`
Manifest. Exports `{ slug: "audio_intelligence", resourceDefs, register(server), migrations }`. Registers `/api/query/v1/audio` and `/api/query/v1/documents`.

### `apps/audio_intelligence/resourceDef.json`
Resources owned by this app: `audio_recordings`, `company_documents`, `team_documents`.

### `apps/audio_intelligence/routes/audioRoute.js`
- `POST /upload` (multer + protect) → `audioController.uploadAudio`
- `POST /transcribe` (protect) → `audioController.transcribe`

### `apps/audio_intelligence/routes/documentRoute.js`
- `POST /upload` (multer + protect) → `documentController.uploadDocument`
- `POST /update_medicine` (protect) → `documentController.updateMedicine`

### `apps/audio_intelligence/controllers/{audio,document}Controller.js`
Request handlers extracted from the old `baseResourceRoute.js`. The audio path remains the heavy one — ffmpeg conversion + Python pipeline (still inline via async `spawn`; Bull queue is Group 5's job).

### `apps/audio_intelligence/services/`
- `audioProcessor.js` — `runPipeline` async-spawn helper, `audioRecordingsHasIdempotency` helper.
- `docIntelligence.js` — wrapper that spawns the Python `workers/rag/doc_intelligence.py`.
- `transcribe.js` — whisper-node thin wrapper.

### `apps/audio_intelligence/workers/transcriptionWorker.cjs`
Spawned by the `transcription` Bull job processor. Calls AssemblyAI, writes transcription back via the generic `/base_resource` UPDATE path using `WORKER_SERVICE_TOKEN`.

### `apps/audio_intelligence/workers/jobHandlers.js`
Wires the `audio_intelligence` Bull queue. Two job types:
- `transcription` — spawns `transcriptionWorker.cjs --audio-id <n>`, awaits exit. Rejection triggers retry.
- `docIntelligence` — spawns the Python `workers/rag/doc_intelligence.py` and awaits exit.

When Redis is unavailable, controllers call the same logic inline as a fallback (no retry, but feature continues to work in dev).

### `apps/audio_intelligence/models/init.sql`
DDL for `audio_recordings`, `company_documents`, `team_documents`.

### `apps/manufacturing/`
Stub directory with only `domain-plan.md`. No code yet.

---

## Database

### `models/core-init.sql`
DDL for the 8 core tables (companies, apps, users, teams, roles, features, features_capability, role_capability).

### `migrations/core/`, `migrations/apps/audio_intelligence/`
- `migrations/core/001_add_deleted_at.sql` — adds `deleted_at DATETIME NULL DEFAULT NULL` to each of the 8 core tables.
- `migrations/core/002_role_capability_fk.sql` — replaces `role`/`team`/`company` string columns on `role_capability` with `role_id`/`team_id`/`company_id` FKs.
- `migrations/apps/audio_intelligence/001_add_deleted_at.sql` — adds `deleted_at` to `audio_recordings`, `company_documents`, `team_documents`.
No runner change — these are plain SQL files run by the existing `run_migration.{js,mjs}` helpers at repo root.

---

## Workers (`workers/`)
Loose Python and CommonJS scripts that pre-date the app module system. Only `transcription_worker.cjs` was relocated under `apps/audio_intelligence/workers/` during Group 3; the rest (Python RAG scripts, `direct_update_pool.mjs`, etc.) remain at `workers/` and are spawned by full path.
