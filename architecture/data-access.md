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

- `company_id` is **always overwritten** from `req.user.company_id` (never client-supplied) on any table that has a `company_id` column, and update/delete scope their WHERE clause by it. The write path asks the schema for that column rather than consulting a hardcoded list: the old `globalTables` list was read by the insert branch only — so update and delete appended `AND company_id = ?` to every table and 500'd on the ones without the column — and it had drifted from the schema in both directions (it missed `fab_nodes`, `fab_node_relationships` and the two `fab_excel_import_*` tables, and it named `apps`, which does have a `company_id`). Service callers (`WORKER_SERVICE_TOKEN`) stay unscoped by design. **This is the write path only** — `securityInjector.js` keeps its own separate list for reads.
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
- `writable` — **the gate.** `true` opts the resource into the generic write path (`operation: insert | update | delete`). Anything else, including absent, means the generic API refuses to write it — the resource is owned by a service that enforces rules the generic path cannot see.
- `writeFields` — extra writable columns for a resource that is *already* `writable`, on top of those derivable from `fields` (server-set columns such as `password`). **`writeFields` is not a gate:** an empty array on a resource without `writable: true` is redundant, and a non-empty one on such a resource grants nothing.

### Bootstrap & collisions
1. `core/query/resourceRegistry.js` synchronously loads the core `resourceDef.json` on module init.
2. `apps/_loader.js` iterates every `app.js` manifest and calls `registerResources(slug, app.resourceDefs)`.
3. Duplicate slugs throw at startup with the colliding source identified — silent shadowing is never possible.

`resourceParser.js` delegates to `resourceRegistry.getResource(slug)`; nothing reads JSON from disk per-request.

**Writes resolve `resource` through the registry exactly as reads do.** `resolveWriteTarget(slug)` returns the table name from the definition — the client never names a table. A request naming a raw table (`cf_classification_nodes`) is a 400; a registered resource that is not `writable: true` is a 403. There is no schema-cache fallback on the write path. For a writable resource the column allowlist is (a) field expressions whose alias matches the resource's own table alias plus (b) the explicit `writeFields` array.

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

## Write-Path Allowlist

`resourceDef.json` is the authoritative answer to both write questions, in this order:

**1. May this resource be written generically at all?** Only if its definition says `writable: true`. Opt-in, deny by default. 33 resources are opted in — core, `audio_intelligence` and `fab_flow`, the ones with real callers. Every `fab_erp` and `cf_erp` resource is denied: those apps write through their own routes (`POST /api/:company/fab_erp/mutate`, the `cf_erp` service routes), which enforce the rules the generic path knows nothing about.

**2. Which columns may it set?** For a writable resource, `getResourceWriteAllowlist(slug)` returns field expressions on the resource's own table alias plus `writeFields`. For a resource that is not writable it returns an **empty set**; for an unregistered slug, `null`.

`id` is always excluded. It is derivable from `fields` on every resource and requested by none, and leaving it in let a client choose its own primary key on insert. On update the id addresses the row — it is read from the payload for the WHERE clause, never set.

**Two traps this replaced, both of which made the allowlist decorative:**

- *`writeFields: []` was documentation, not a gate.* The allowlist unioned `writeFields` with every column derivable from `fields` — and every readable column is in `fields` — so `writeFields: []` still yielded the resource's full column set. 48 definitions were relying on it as if it were a gate.
- *Writes accepted a raw table name; reads did not.* `resource` was interpolated straight into `INSERT INTO ${resource}`, while the allowlist lookup was keyed on the camelCase slug. So `cfErpClassificationNode` found an allowlist but produced invalid SQL, whereas `cf_classification_nodes` found no allowlist, fell through to `SHOW COLUMNS` — every column in the table — and wrote successfully. The allowlist was skipped on the only path that worked.

Adding a resource does **not** make it writable. Opt in deliberately, and only when no service owns the table's rules.

### What `writable: true` actually opens

**It opens the resource to every authenticated user of the tenant, whatever their role.** `/api/query/v1` is mounted with `protect` alone (`index.js`), and `appContext` does not run for it, so `req.company` is null and the membership / `app_user_access` / `uiPermissions` checks never happen. The route itself checks no role and no capability. What stops a write is the resource-level opt-in and nothing else.

Verified against a `fab_user` — a non-admin with 7 permission tags — which could insert into `role_capability`, `app_user_access`, `roles`, `users` and `features` through this endpoint. Granting yourself a capability is a supported operation for any logged-in account. The `company_id` stamp bounds the blast radius to the caller's own tenant; it does not bound their privileges inside it.

So there are two questions, and only the first is answered here:

- *May this resource be written generically?* — `writable: true` answers it.
- *May **this caller** write it?* — **nobody asks.** If that matters for a resource, it needs its own route with its own guard.

This is why the opt-in list is short and why app-owned resources stay off it. On TiDB the point is sharper still: CHECK constraints are not enforced there, so a service's rules are not the first line of defence, they are the only one.
