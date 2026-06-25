# Routes, Layers & Table Hits

## Middleware Stack (global, in order)
| Middleware | File | What it does |
|---|---|---|
| CORS | `index.js` | Origin whitelist + credentials |
| cookieParser | `index.js` | Reads JWT from cookies |
| express.json (50MB) | `index.js` | Parses body; large limit for audio base64 |
| appContext | `core/middleware/appContext.js` | Resolves `req.company` + `req.app`; 60s TTL in-process cache |
| versionControl | `core/middleware/versionControl.js` | Validates `/v1/` segment, attaches feature flags |
| protect | `core/middleware/authmiddleware.js` | JWT verify (cookie or Authorization header) → `req.user`; service-token bypass |

---

## Auth Routes — `/api/:company/:appSlug/auth/*`
Router: `core/auth/authRoute.js`

| Method | Path | Handler | Middleware | Tables Hit |
|---|---|---|---|---|
| POST | `/login` | `loginUser` | appContext | companies, users, roles, teams, role_capability + features (single JSON_TABLE join) |
| GET | `/verify` | `verifyUser` | appContext | _(JWT only)_ |
| POST | `/logout` | `logoutUser` | appContext | _(clears cookie)_ |

---

## Admin Routes — `/api/:company/:appSlug/admin/*`
Router: `core/auth/adminRoute.js`

| Method | Path | Handler | Middleware | Tables Hit |
|---|---|---|---|---|
| POST | `/register` | `registerAdmin` | appContext | companies, users, teams, roles |

---

## User Routes — `/api/:company/:appSlug/user/*`
Router: `core/query/userRoute.js`

| Method | Path | Handler | Middleware | Tables Hit |
|---|---|---|---|---|
| POST | `/query` | `handleDBQuery` | protect | dynamic (via `buildQuery`) |

---

## App Routes — `/api/:company/:appSlug/app/*`
Router: `core/query/appRoute.js`

| Method | Path | Handler | Middleware | Tables Hit |
|---|---|---|---|---|
| GET | `/query` | `getAppQuery` | none | companies, apps |

---

## Public Routes — `/api/public/*`
Router: `core/public/publicApiRoute.js` — **No auth, 60 req/min rate limit**

All endpoints route through `buildQuery` with `jwt: null` and a hard `LIMIT 200`.

| Method | Path | Tables Hit |
|---|---|---|
| GET | `/companies` | companies |
| GET | `/companies/:slug/apps` | apps |
| GET | `/teams` | teams |
| GET | `/roles` | roles |
| GET | `/capabilities` | features_capability |
| GET | `/features` | features |

---

## Core Query Routes — `/api/query/v1/*`
Router: `core/query/baseResourceRoute.js` (~295 lines after Group 3 extraction)

### `POST /base_resource`
Auth: `protect` (skipped if service token). Dispatcher routes by `operation` field in body.

| Operation | Tables Hit | Notes |
|---|---|---|
| QUERY | any (resource registry) | `buildQuery` → SELECT |
| INSERT | any | Generic INSERT only — no per-resource side effects (audio pipeline lives in the app route now) |
| UPDATE | any | Scoped by `company_id` |
| DELETE | any | Hard delete; scoped by `company_id` (soft delete lands in Group 4) |

---

## App-mounted Routes — `apps/<slug>/`

Each app's `register(server)` adds its routes here. Resource definitions are merged into the global registry at startup.

### audio_intelligence — `apps/audio_intelligence/`

| Method | Path | Handler | Auth | Tables Hit |
|---|---|---|---|---|
| POST | `/api/query/v1/audio/upload` | `audioController.uploadAudio` | protect + multer | audio_recordings |
| POST | `/api/query/v1/audio/transcribe` | `audioController.transcribe` | protect | audio_recordings (UPDATE via worker) |
| POST | `/api/query/v1/documents/upload` | `documentController.uploadDocument` | protect + multer | company_documents or team_documents |
| POST | `/api/query/v1/documents/update_medicine` | `documentController.updateMedicine` | protect | company_documents or team_documents |

**Audio upload call chain:**
```
POST /api/query/v1/audio/upload
  → protect + multer
  → audioController.uploadAudio
      → ffmpeg conversion (async via runPipeline)
      → INSERT audio_recordings
      → spawn(apps/audio_intelligence/workers/transcriptionWorker.cjs)  ← detached, fire-and-forget
```

Transcription worker writes results back via the generic `/base_resource` UPDATE path using `WORKER_SERVICE_TOKEN`.

---

## Health & Debug Endpoints (index.js)
| Method | Path | Auth | Tables Hit |
|---|---|---|---|
| GET | `/health` | none | `SELECT 1` + pool stats (`{ db: { status, pool: { limit, total, idle, waiting } }, uptime }`) |
| GET | `/debug/data` | protect + requireAdmin | companies, roles, teams, users |
| GET | `/debug/jwt` | protect + requireAdmin | _(JWT decode only)_ |

## Admin: Jobs (`core/jobs/jobsStatusRoute.js`)
| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/api/admin/jobs/status` | protect + requireAdmin | `{ available, queues: [{ name, waiting, active, completed, failed, delayed }] }` |

## Rate Limiting (index.js)
| Routes | Limit |
|---|---|
| `/api/:company/:appSlug/auth/*`, `/api/:company/:appSlug/login` | 5 req/min per IP |
| `/api/public/*` | 60 req/min per IP |
