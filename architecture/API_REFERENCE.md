# Backend API Reference

> **For AI agents:** This document covers every endpoint the backend exposes.
> Base URL: `http://localhost:4000` (dev) or `https://<heroku-app>.herokuapp.com` (prod).
> All company/app-scoped routes use slugs: `/api/:company/:appSlug/...`

---

## Auth Pattern

**JWT stored in httpOnly cookie** (`token`) **OR** `Authorization: Bearer <token>` header.

```
Cookie: token=<jwt>
# OR
Authorization: Bearer <jwt>
```

Service workers (background jobs) use a special token:
```
Authorization: Bearer <WORKER_SERVICE_TOKEN>   → sets req.user = { is_service: true, role: "service" }
```

Company/app context is resolved from the URL path by `appContext` middleware and attached as `req.company`, `req.app`.

---

## Error Shape (all endpoints)

```json
{ "message": "Human readable error" }
// or
{ "error": "error string" }
```

---

## 1. Health & Debug

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | DB connectivity + uptime |
| GET | `/debug/data` | JWT + Admin | All companies/roles/teams/users |
| GET | `/debug/jwt` | JWT + Admin | Decoded JWT from cookie |

**`GET /health` response:**
```json
{ "status": "ok", "uptime": 123.4, "db": { "status": "connected", "pool": { "limit": 10, "total": 2, "idle": 2, "waiting": 0 } } }
```

---

## 2. Public API (no auth, 60 req/min rate limit)

Mounted at `/api/public/...` — use these to bootstrap the UI before login.

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/public/companies` | `[{ id, name, slug, settings }]` |
| GET | `/api/public/companies/:companySlug/apps` | `[{ id, name, slug, company_id }]` |
| GET | `/api/public/teams` | `[{ id, name, company_id }]` |
| GET | `/api/public/roles` | `[{ id, name, company_id }]` |
| GET | `/api/public/capabilities` | `[{ id, name, ... }]` |
| GET | `/api/public/features` | `[{ id, name, ... }]` |

---

## 3. App/Company Context

```
GET /api/:company/:appSlug/app/query
```
No auth. Returns company/app config for landing pages (logo, settings, etc.)

**Response:**
```json
{
  "appSlug": "sales_control",
  "companyName": "Acme Corp",
  "settings": { /* JSON from apps.settings */ },
  "raw": { /* full company or app row */ }
}
```

---

## 4. Authentication (5 req/min rate limit on login)

All routes scoped to `/api/:company/:appSlug/...`

### Login
```
POST /api/:company/:appSlug/login
POST /api/:company/:appSlug/auth/login   ← duplicate route
```
**Body:** `{ "email": "user@co.com", "password": "min8chars" }`

**Response 200:**
```json
{
  "message": "Login successful",
  "user": {
    "id": 1, "name": "Jane", "email": "jane@co.com",
    "role": "admin",
    "team": "Sales",
    "company": "acme", "companyId": 1, "company_id": 1,
    "uiPermissions": ["feature_slug_1", "feature_slug_2"]
  },
  "token": "<jwt>",
  "dashboardRoute": "/acme/sales_control/admin/dashboard",
  "company": { "slug": "acme", "name": "Acme Corp" }
}
```
Sets `token` httpOnly cookie. `dashboardRoute` is `/quick-actions` for regular users, `/admin/dashboard` for admins.

**Errors:** `400` bad input · `401` wrong password · `403` user not in this company · `404` user not found

---

### Verify Token
```
GET /api/:company/:appSlug/verify
GET /api/:company/:appSlug/auth/verify
```
No body. Token from cookie or header.
**Response:** `{ "user": { /* decoded JWT payload */ } }`

---

### Logout
```
POST /api/:company/:appSlug/auth/logout
```
No body. Clears token cookie.
**Response:** `{ "message": "Logout successful" }`

---

### Register Admin
```
POST /api/:company/:appSlug/admin/register
```
Admin self-registration. Payload TBD (see `adminController.js`).

---

## 5. Base Resource API — Main Data Layer

```
POST /api/query/v1/base_resource
```

**This is the primary CRUD API.** All data operations (except file uploads) go through this single endpoint.

### Auth rules
- `operation=query` on `companies` or `apps` → **public** (no token needed)
- Everything else → **JWT required**
- Service token → bypasses company scoping (used by background workers)

### Request shape
```json
{
  "operation": "query | insert | update | delete",
  "resource": "<table_name>",
  "fields": ["id", "name"],          // query only — omit for all fields
  "filters": { "status": "new" },    // WHERE clauses (AND)
  "orderBy": [{ "field": "created_at", "order": "DESC" }],
  "pagination": { "limit": 20, "offset": 0 },
  "include_deleted": false,           // include soft-deleted rows
  "data": { /* insert/update payload or { "id": 5 } for delete */ }
}
```

### Response shape
```json
{ "success": true, "data": [ /* rows */ ] }
// insert returns result with insertId
// update/delete returns affectedRows info
```

### Behaviour notes
- **`company_id` is auto-injected** from JWT on insert/update — never send it from the frontend.
- **Soft delete:** sets `deleted_at = NOW()`, never hard-deletes rows.
- **Passwords** in `users` table are auto-hashed (bcrypt, 10 rounds) on insert/update.
- **Write allowlist:** only fields declared in `writeFields` (resourceDef.json or DB schema) are accepted on insert/update.
- `include_deleted: true` lifts the `deleted_at IS NULL` filter.

### Available resources (known tables)

| Resource | Key Writable Fields | Notes |
|----------|---------------------|-------|
| `users` | name, email, password, role_id, team_id, company_id | password auto-hashed |
| `companies` | name, slug, settings | public query |
| `apps` | name, slug, company_id, settings | public query |
| `roles` | name, company_id | |
| `teams` | name, company_id | |
| `features` | name, slug, capability_id | global, no company scope |
| `features_capability` | feature_id, capability_id | junction |
| `role_capability` | role_id, capability_id, company_id | |
| `audio_recordings` | title, recorded_by, recorded_by_role, audio_url, processed_url, audio_data, transcription, analysis, score, keywords_of_improvement, medicine, status, duration_seconds, track, history_block, new_tran | |
| `company_documents` | uploader_id, company_id, doc_path, doc_name | |
| `team_documents` | team_id, company_id, doc_path, doc_name, medicines | |

### Examples

**Fetch audio recordings for current company:**
```json
{ "operation": "query", "resource": "audio_recordings", "orderBy": [{ "field": "created_at", "order": "DESC" }], "pagination": { "limit": 50, "offset": 0 } }
```

**Fetch specific user:**
```json
{ "operation": "query", "resource": "users", "filters": { "id": 3 } }
```

**Update audio status:**
```json
{ "operation": "update", "resource": "audio_recordings", "data": { "id": 12, "status": "reviewed" } }
```

**Soft-delete a document:**
```json
{ "operation": "delete", "resource": "team_documents", "data": { "id": 7 } }
```

---

## 6. Audio Intelligence

All routes require JWT. Use `multipart/form-data` for uploads.

### Upload Audio
```
POST /api/:company/:appSlug/audio/upload
Content-Type: multipart/form-data
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `audio_file` | File | Yes | Any format; converted to MP3 internally |
| `title` | string | No | Defaults to "Recording" |
| `status` | string | No | Defaults to "new" |
| `idempotencyKey` | string | No | Prevents duplicate uploads; also accepted as `Idempotency-Key` header |

**Response 200:**
```json
{
  "success": true,
  "id": 42,
  "originalAudioUrl": "https://.../uploads/original_1234567890.mp3",
  "processedAudioUrl": "https://.../uploads/processed_1234567890.mp3",
  "transcript": null
}
```
- Transcription runs **async in background** — poll via base_resource query on `audio_recordings` by `id`.
- `transcript` in response is always `null` at upload time.
- Auto-fills `recorded_by`, `recorded_by_role`, `company_id` from JWT.

---

### Trigger Transcription
```
POST /api/:company/:appSlug/audio/transcribe
```
**Body:** `{ "audio_id": 42 }` or `{ "audioId": 42 }`

**Response 200:**
```json
{
  "success": true,
  "originalAudioUrl": "...",
  "processedAudioUrl": "...",
  "transcript": "Hello, I'm calling about...",
  "debug": { "stdout": "...", "stderr": "...", "status": 0 }
}
```
Use this to re-trigger transcription or check its result synchronously (blocks until complete).

---

## 7. Documents

All routes require JWT. Use `multipart/form-data`.

### Upload Document
```
POST /api/:company/:appSlug/document/upload
Content-Type: multipart/form-data
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `doc_file` | File | Yes | Any file type |
| `resource` | string | Yes | `"company_documents"` or `"team_documents"` |
| `team_id` | int | Cond. | Required when resource=team_documents |
| `medicine` | string | No | Drug/medicine tag |
| `id` | int | No | If provided, replaces existing document record |

**Response 200:**
```json
{ "success": true, "data": { /* full document row */ } }
```
Document intelligence (RAG embedding) runs async in background after upload.

---

### Update Medicine Tag
```
POST /api/:company/:appSlug/document/update_medicine
```
**Body:** `{ "document_id": 7, "medicine": "Metformin" }`

Only updates `team_documents`. Scoped to `company_id` from JWT.

**Response:** `{ "success": true }`

---

## 8. Job Queue Status (Admin only)

```
GET /api/admin/jobs/status
Authorization: Bearer <admin-jwt>
```

**Response:**
```json
{
  "available": true,
  "queues": [
    { "name": "audio_intelligence", "waiting": 0, "active": 1, "completed": 45, "failed": 2, "delayed": 0 }
  ]
}
```

---

## Key Design Patterns for Frontend

### 1. Bootstrap sequence
```
GET /api/public/companies                     → find company slug
GET /api/public/companies/:slug/apps          → find app slug
GET /api/:company/:app/app/query              → load settings/theme
```

### 2. Login → persist token → verify on reload
```
POST /api/:company/:app/login                 → sets httpOnly cookie
GET  /api/:company/:app/verify                → call on app load to restore session
POST /api/:company/:app/auth/logout           → clear session
```

### 3. All data via base_resource
```
POST /api/query/v1/base_resource              → single endpoint for all CRUD
```
Frontend never constructs table-specific SQL — it sends structured JSON.

### 4. File uploads are separate
```
POST /api/:company/:app/audio/upload          → multipart, returns id immediately
POST /api/:company/:app/document/upload       → multipart, returns doc row
```
Transcription/analysis runs async. Poll `audio_recordings` by `id` to check `status` and `transcription` fields.

### 5. `uiPermissions` gates features
After login, `user.uiPermissions` is an array of feature slugs the user can access. Use this to show/hide UI sections — the backend enforces nothing on public routes, so the FE must apply these gates.

### 6. CORS & Cookies
Allowed origins (configured in `index.js`):
- `http://localhost:5173`
- `http://localhost:4000`
- `https://multi-app-fe.vercel.app`
- `*.trycloudflare.com`

Requests must include `credentials: true` (axios: `withCredentials: true`) for cookie-based auth to work cross-origin.

### 7. Scoping — never send `company_id`
The backend reads `company_id` from the JWT. Any `company_id` in the request body is ignored or overwritten. Do not send it.

---

## Resource Field Reference

### `audio_recordings`
| Field | Type | Writable | Notes |
|-------|------|----------|-------|
| id | int | No | PK |
| title | string | Yes | |
| recorded_by | string | Yes | Name/email of recorder |
| recorded_by_role | string | Yes | Role at time of recording |
| audio_url | string | Yes | Original MP3 URL |
| processed_url | string | Yes | Processed MP3 URL |
| audio_data | text | Yes | Base64 data URL (large) |
| transcription | string | Yes | Whisper transcript |
| analysis | text | Yes | AI analysis JSON |
| score | int | Yes | Numeric score |
| keywords_of_improvement | text | Yes | JSON array |
| medicine | string | Yes | Drug discussed |
| status | string | Yes | `new` / `transcribed` / `analysed` |
| duration_seconds | int | Yes | |
| track | json | Yes | |
| history_block | json | Yes | |
| new_tran | — | Yes | |
| company_id | int | Yes (auto) | Auto-set from JWT |
| created_at | datetime | No | |
| updated_at | datetime | No | |

### `company_documents`
| Field | Type | Notes |
|-------|------|-------|
| id | int | PK |
| uploader_id | int | User ID |
| company_id | int | Auto-set |
| doc_path | string | Accessible URL |
| doc_name | string | |
| uploaded_at | datetime | |

### `team_documents`
| Field | Type | Notes |
|-------|------|-------|
| id | int | PK |
| team_id | int | |
| company_id | int | Auto-set |
| doc_path | string | Accessible URL |
| doc_name | string | |
| medicines | string | Comma-sep or JSON |
| uploaded_at | datetime | |
