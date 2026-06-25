# Data Access Architecture

## Core Decision

**All reads go through the query builder infrastructure. Writes use controlled, parameterized raw SQL.**

This split was made deliberately:

| Concern | Reads (query builder) | Writes (raw SQL) |
|---|---|---|
| SQL injection | Parameterized `?` placeholders throughout | Parameterized `pool.query(sql, params)` |
| Column allowlist | `resourceDef.json` → `sqlBuilder.js` filters via schema cache | Schema cache (`SHOW COLUMNS`, cached) |
| Company scoping | `securityInjector.js` appends `company_id = ?` | `WHERE id = ? AND company_id = ?` in every UPDATE/DELETE |
| Pagination | `paginationBuilder.js` (integer-cast LIMIT/OFFSET) | N/A |
| Ordering | `paginationBuilder.js` (field validated against `resourceDef.json`) | N/A |

---

## Read Path

```
Client request
  → buildQuery({ resource, filters, orderBy, pagination, jwt })
      ├── parseResource(resource)           // resourceDef.json → table, alias, fields, fieldTypes
      ├── buildSelectQuery(parsedResource)  // SELECT ... FROM ... JOIN ..., cols validated via schemaCache
      ├── buildWhere(filters, fieldTypes)   // returns { sql: "WHERE ...", params: [...] }
      ├── injectSecurity(whereSql, whereParams, jwt, resource)
      │     // appends company_id = ? and/or team_id IN (?) for non-global tables
      │     // returns { sql, params } (params merged)
      ├── buildOrderBy(orderBy, allowedFields)  // field validated against resourceDef.json allowlist
      └── addPagination(pagination)        // LIMIT/OFFSET cast to integer; throws on NaN
  → returns { sql, params }
  → pool.query(sql, params)               // MySQL2 handles all value escaping
```

### Who uses the read path

| Caller | File |
|---|---|
| Authenticated user queries | `core/query/userController.js` |
| Admin / resource QUERY operation | `core/query/baseResourceRoute.js` (operation = "query") |
| Public API endpoints | `core/public/publicController.js` |
| Versioned query endpoint | `core/query/queryController.js` |
| App-specific routes (audio upload, etc.) | `apps/<slug>/controllers/*` use `buildQuery` directly for reads |

### Public endpoints

Public endpoints (`/api/public/*`) pass `jwt: null`. The security injector is a no-op when `jwt` is null, so no company/team filtering is applied. All public endpoints add a hard cap of `LIMIT 200` to prevent unbounded scans.

**Exception:** `getCompanyApps` performs a single parameterized key-lookup (`SELECT id FROM companies WHERE slug = ? LIMIT 1`) to resolve the company slug to an ID, then passes that ID as a filter into `buildQuery`. This is acceptable because it is a controlled single-row lookup with a parameterized input, not a user-driven scan.

### Global tables (no company scoping)

These resources bypass `company_id` injection even when a JWT is present:
- `features`
- `features_capability`
- `companies`
- `apps`

Defined in `utils/queryBuilder/securityInjector.js`.

---

## Write Path

All writes (INSERT / UPDATE / DELETE) go through `routes/baseResourceRoute.js` and use **parameterized raw SQL** executed directly via `pool.query(sql, params)`.

```
Client request (operation = insert | update | delete)
  → Validate fields against schema cache (getTableColumns → SHOW COLUMNS, cached per table)
  → Build SQL string with ? placeholders
  → pool.query(sql, params)
```

### INSERT

```js
query = `INSERT INTO ${resource} SET ?`;
params = [filteredData];   // MySQL2 expands SET ? as key=val pairs
```

- `company_id` is **always overwritten** from `req.user.company_id` (not client-supplied) for non-global tables.
- `recorded_by` / `recorded_by_role` auto-filled from JWT for `audio_recordings`.
- `password` is bcrypt-hashed before insert for `users`.
- Column filtering: only columns that exist in the DB schema cache are allowed through; unknown keys are dropped.

### UPDATE

```js
query = `UPDATE ${resource} SET ? WHERE id = ? AND company_id = ?`;
params = [filteredData, targetId, companyId];
```

- `companyId` comes from JWT — clients cannot update records outside their company.
- Service workers (`req.user.is_service = true`) bypass company scoping; they authenticate via `WORKER_SERVICE_TOKEN`.
- Empty `SET` is rejected before SQL is built (returns 400).

### DELETE (soft delete)

```js
query = `UPDATE ${resource} SET deleted_at = NOW() WHERE id = ? AND company_id = ? AND deleted_at IS NULL`;
params = [data.id, companyId];
```

DELETE is implemented as a soft delete: rows are flagged with `deleted_at = NOW()` rather than physically removed. The `AND deleted_at IS NULL` clause makes the operation idempotent — re-deleting a row affects 0 rows.

Soft-deleted rows are filtered out of every read by `securityInjector.js`, which appends `AND <alias>.deleted_at IS NULL` to the WHERE clause unless `includeDeleted: true` is passed AND the JWT has `role === "admin"`. Non-admins cannot bypass the filter.

Same company-scoping rules as UPDATE.

---

## Resource Registry

The authoritative list of resources is now split across the platform and each app, merged in-memory at startup by `core/query/resourceRegistry.js`:

- `resourceDef.json` (project root) — **core** resources: `users`, `teams`, `companies`, `apps`, `roles`, `features`, `features_capability`, `role_capability`.
- `apps/<slug>/resourceDef.json` — that app's resources. For `audio_intelligence`: `audio_recordings`, `company_documents`, `team_documents`.

Each entry defines:

- `table` — actual DB table name
- `alias` — SQL alias used in SELECT
- `fields` — map of output key → `alias.column` expression (used in SELECT and ORDER BY validation)
- `fieldTypes` — map of field name → type hint (`"string"` | `"integer"` | `"text"` | `"datetime"` | `"json"`)
- `relations` — optional JOIN definitions
- `writeFields` — explicit list of writable columns for INSERT/UPDATE (in addition to those derivable from `fields`)

### Bootstrap & collisions
1. `core/query/resourceRegistry.js` synchronously loads the core `resourceDef.json` on module init.
2. `apps/_loader.js` iterates every `app.js` manifest and calls `registerResources(slug, app.resourceDefs)`.
3. Duplicate slugs throw at startup with the colliding source identified — silent shadowing is never possible.

`resourceParser.js` delegates to `resourceRegistry.getResource(slug)`; nothing reads JSON from disk per-request.

**Write operations use the registry's `getResourceWriteAllowlist(slug)` as the primary column allowlist (TODO 4 complete).** For each registered resource, the allowlist is built from (a) field expressions whose alias matches the resource's own table alias and (b) the explicit `writeFields` array for server-set columns (e.g. `password`, `new_tran`). Unregistered resources still fall back to the schema cache.

---

## Aggregation

`buildQuery` accepts an optional `aggregate` config to produce summary metrics in a single round trip:

```js
aggregate: {
  functions: [
    { fn: "COUNT", field: "*", alias: "total" },
    { fn: "SUM",   field: "duration_seconds", alias: "total_duration" }
  ],
  groupBy: ["status"],
  having: { total: { gte: 1 } }   // optional, uses whereBuilder semantics
}
```

Function names are restricted to `COUNT | SUM | AVG | MIN | MAX`. `field` is validated against the resource's `fields` allowlist (except `*`). `groupBy` entries are validated against the same allowlist (parallel to ORDER BY). Non-aggregate calls are unaffected — `aggregate` is strictly optional.

---

## Schema Cache (`schemaCache.js`)

`utils/queryBuilder/schemaCache.js` holds a `Map` that caches `SHOW COLUMNS` results per table. It is populated on first use and lives for the lifetime of the server process. This means:

- No `SHOW COLUMNS` is issued per-request — only once per table per deployment.
- Cache is invalidated by restarting the server (e.g., after a migration).
- `clearSchemaCache()` is exported for tests.

---

## Write-Path Allowlist (TODO 4 — Complete)

Write operations use `resourceDef.json` as the authoritative column allowlist. `getResourceWriteAllowlist(resource)` derives the allowed set from the resource's `fields` expressions (primary-table alias only) plus an explicit `writeFields` array. Unregistered tables fall back to `SHOW COLUMNS` (schema cache). This prevents clients from writing to undeclared columns (e.g., internal columns added to the DB schema but not registered in `resourceDef.json`).
