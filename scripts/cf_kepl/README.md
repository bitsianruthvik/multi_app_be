# cf_kepl — the KEPL ROB bridge, and the raw materials under it

Re-runnable seed scripts that build a real customer job in `cf_erp`: the raw-material
catalog imported from `fab_erp`, then the **KEPL ROB 59.3 m, 2 spans** bridge from the
customer's own BOQ (drawing `P103-VDB-WK-DD-MJB-200+003-401`, 08-07-2026).

Everything is written through the cf_erp **services**, never with raw `INSERT`s, so every
rule is enforced and every history row is written. Every script reuses by code and creates
only what is missing — an interrupted run is resumed by running it again, and a second run
reports `created: {}`.

## Running

Run from `multi_app_be` (the scripts resolve the app's own `db.js` from the working
directory). The target tenant is `CF_BRIDGE_COMPANY` (`CF_IMPORT_COMPANY` for the raw
materials), defaulting to 2 — the local dev tenant.

```
cd multi_app_be
node scripts/cf_kepl/cf_rm_import.mjs        # 1,425 raw materials, ~15,000 spec values
node scripts/cf_kepl/cf_bridge_setup.mjs     # classification, specs, formulas, rules, coding rules
node scripts/cf_kepl/cf_bridge_catalog.mjs   # 38 catalog items and their Standard BOMs
node scripts/cf_kepl/cf_bridge_order.mjs     # definitions, customer, sales order, resolved structure
node scripts/cf_kepl/cf_shop_import.mjs      # the shop floor: 16 machine types, 19 machines
node scripts/cf_kepl/cf_ops_import.mjs       # 14 operations, 5 flows of 43 steps, 14 machine rules
```

Order matters: `cf_bridge_setup` needs the `PLATE_WEIGHT` and `SECTION_WEIGHT` formulas that
`cf_rm_import` creates, and fails with a clear message if they are absent. `cf_ops_import`
needs the machine types `cf_shop_import` builds — without them the operations and flows still
land and the machine rules are listed as waiting, so it is safe to run early and run again.
Every script except `cf_ops_import` takes `--verify-only` to check without writing.

To seed production, use `TM/seed-cf-prod-data.sh`, which sets the tenant and points the
app's pool at TiDB.

## The files

| | |
|---|---|
| `boq.json` | the BOQ decoded from the customer's PDF — the only copy of the source numbers |
| `cf_bridge_data.mjs` | pure derivation over `boq.json`: the 29 distinct parts, 5 girder segment designs, sub-assemblies and the span layout. No database access. **Read its `ASSUMPTIONS` before trusting anything downstream** |
| `cf_bridge_setup.mjs` | the reusable framework — `Fabricated` and `Bought out` classification, 6 new specifications, `ASSEMBLY_WEIGHT`, the rules, and 8 coding rules |
| `cf_bridge_catalog.mjs` | the catalog items and their Standard BOMs |
| `cf_bridge_order.mjs` | the selection and template definitions, the customer, the order, and the 20 segment resolutions |
| `cf_rm_import.mjs` + `fab_rm_extract.tsv` | the raw materials, imported from a read-only extract of `fab_erp` production |
| `cf_shop_import.mjs` + `fab_shop_extract.tsv` | the shop floor, from the same kind of extract: a `Machines` family, 8 subfamilies grouped by what the machine does to the steel, 16 machine types and the 19 machines on them — 11 types and 14 machines from the extract, plus 5 decided in the script (`EDGEMILL`, `METALIZE` and three QC stations) because the flows use operations StartHub had no machine for. Machine codes are minted by coding rule `CFMC-ANY`, never carried over |
| `cf_ops_import.mjs` + `fab_ops_extract.tsv` + `fab_flows_extract.tsv` | the work itself: 14 operations and the 5 real flows, all 43 fab steps at their own sequence. A flow may run one operation several times — `LINESEG-FAB` welds, crane-turns the girder and welds again — so a step is keyed by (operation, sequence), never by operation alone. A step's resource type becomes a rule on the OPERATION in `cf_operation_machine_rules`, eligibility only; the fab time formulas need specifications CF does not have yet and are parked in each operation's description. The fab resource-type names are not the shop's machine-type names, so the mapping is decided in `MACHINE_TYPE_ALIASES` / `OPERATION_MACHINE_TYPE` and anything unmatched is reported, never guessed |
| `update-cf-prod.sh` | the runner that sequences all of the above against production, in the order they depend on each other: schema, shop floor, operations, flows, wiring, reconcile, rows without codes (it replaced the old re-code and range scripts, which were deleted), verify. Refuses without `--yes`, checks every file it needs exists BEFORE it touches production, and reads credentials from `TM/.env.tidb` — deliberately outside this repo, never committed (`CF_ENV_FILE` to override). Run it from anywhere |
| `cf_verify_against_boq.mjs` | the only check that compares the order to something OUTSIDE the database. Expands the span to its leaves, multiplying quantities the whole way, and compares the resulting bill — every rectangle and how many of it — against the same bill derived from `boq.json`. Also the stud count, each of the 20 segments against its own stated weight, and the span total. Read-only always: it reports a difference and never repairs one, because deciding which side is right is a reading of the customer's document |
| `cf_reconcile_dims.mjs` | checks every part against **two independent authorities** — the blank it is cut from, and the BOQ — and repairs only where both name the same replacement. Read-only without `--fix`. It exists because a part can drift from the order it belongs to without any self-consistency check noticing: the model compared to itself still balances |
| `cf_add_lock_stage.mjs` | puts the **Lock** stage into every process of the company, right after Cut pieces (or after Values where there is none), through `processService.replaceStages` so every other stage comes back exactly as it was. Idempotent; `--dry-run` says what it would do |
| `lock_test.mjs` | LOCK end to end on a fixture of its own, rolled back: what `lockPlan` shows is what `lockLine` writes piece for piece, positions without gaps, the frozen line refusing every change in one sentence, release taking the locked codes. Run in a company whose `FAB_PARTS` / `CUT_PLATE` codes are free (1 locally) |
| `bom_changes_test.mjs` | BOM batch saves on owned fixtures, including spreadsheet values, immediate copy references, reorder/move identity, inherited values, empty destinations, shared-record locks, combined cycles, dry-run/failed-save rollback and repeated-copy numbering. 137 checks as of 2026-09-28. Related FE DOM tests: `node scripts/cf_erp_bom_grid_test.mjs` from multi_app_fe |
| `bom_sheet_test.mjs` | Excel export, preview and apply for items, templates and orders on owned fixtures. Covers empty BOM additions, quantity/role/notes, omission versus deletion, shared child BOMs, wrong workbook, loops, locked orders and a machine list exceeding 500 assets. Local only, company 2 (`CF_SHEET_COMPANY` override), transaction rolled back and table counts verified |
| `plant_import_test.mjs` | Compares the plant importer with its original service path: all 566 assets, values, history, repeat safety and query counts. Requires the private workbook; local company 2 (`CF_PLANT_TEST_COMPANY` override), both runs roll back and every CF table is recounted. Private snapshots/logs remain in ignored `scripts/_scratch` |
| `operation_lookup_test.mjs` | Bulk machine/operation lookups compared with the unchanged serial timing resolver over 500+ owned machine fixtures: precedence, dates, formulas, exclusions, deleted/inactive rows and tenant isolation. Proves three queries per lookup (one for an operation with no rules). Local only, company 2 (`CF_LOOKUP_COMPANY` override); rollback and every CF table recounted |
| `time_estimate_test.mjs` | Operation times per BOM row (timeEstimateService, init.sql §30). Part 1, owned machine fixture: the machine TYPE's rate wins, the SLOWEST machine where only single machines carry values, equal to timingPreview, LOOKUP on a chart (step up, off-chart = missing), no-time and no-rule reasons, ineligible types. Part 2, the KEPL line (company 2, order 887, line 923): GET round trips (29 for 491 rows), formula values over the parts' real THICKNESS, totals, overrides set / clear / setup, refusals (not in flow, negative, another line, all or nothing), released = read-only. `CF_TIME_COMPANY` / `CF_TIME_ORDER` / `CF_TIME_LINE`; rollback and every CF table recounted |
| `work_order_test.mjs` | Contractor work orders (workOrderService). Locks the KEPL line inside the transaction, then: not-locked refusal, assign a subtree, reassign, open work order reuse, back to in-house (emptied draft removed), refusals, status transitions, cancel frees cells, dates/list/detail, a new revision (in a savepoint) retires the cells and cancels the empty open work order, release stamps `work_order_id` and `est_*` (typed time beats the formula), pending steps follow a reassignment, a started cell refuses the whole request. GET 7 round trips for 6,072 pieces, POST 13; the release itself is 74 round trips (bulk writes since 2026-09-29, was ~23k). `CF_WO_COMPANY` / `CF_WO_ORDER` / `CF_WO_LINE`; rollback and every CF table recounted |
| `planner_test.mjs` | The Planner backend (plannerService, routes/planner.js, init.sql §31). Periods (ISO weeks cut at month ends, this month + 2). Before lock: one whole-line unit, a lower level refused. Then, inside the transaction: every timing rule gets a time, one typed override, the KEPL line (company 2, order 887, line 923) locked, the Girder segment definition set SHIP_UNIT = yes, shifts + a day off + extra time on two machines, free stock and two open PO lines (and a draft suggestion that must not count), one segment cell to a contractor. GET: levels line/0/1/2 named Bridge span / Girder line / Girder segment, default = girder line; marks, groupKey, diaphragms as implicit marks; tonnes add up (line = Σ spans = 669.288 t, span = Σ its lines + diaphragms); work = the Times tab's total and Σ per function equal at every level; contractor load; materials add up; supply by date; capacity = Σ machineCalendar; bulk calendar = machineCalendar day by day. Writes: entries (move / unplan / refusals incl. another company's piece), priorities, line level, targets, settings. Round trips: GET 43 unlocked (1 unit) vs 45 locked (185 units, 6,072 pieces). `CF_PLAN_COMPANY` / `CF_PLAN_ORDER` / `CF_PLAN_LINE`; `PLAN_EXAMPLE=1` prints a trimmed GET; rollback and every CF table recounted |
| `floor_test.mjs` | The machine log (floorService, routes/floor.js, init.sql §32; contract TM/CF_ERP_FLOOR_LOG_PLAN.md). Inside the transaction: the local KEPL line (company 2, line 923) locked if needed, its order confirmed, the line RELEASED (release back-dated to 1 Sep so yesterday's paper notes are after it), plant clock Asia/Kolkata, two operators; the machine with the most work is used (CRANE10-01 locally). Queue: eligible operations only, done and contractor steps out, started → ready → waiting, the planner's ship date first (the line's own plan entries are retired and two set), search by piece code / operation / order code, limit vs total. Live: two steps together, pause (queued first with `pausedSessionId`), resume, finish done / stop with scrap, too many refused, a stop with a reason pauses running jobs, stopped-twice refused, back to work, starting a job ends an open stop. Refusals: done step, machine not set up, contractor step, future day. Day from paper (Tue 29 Sep 08:00–17:00): overlapping jobs, stops, gaps 14:00–15:00 + 16:00–17:00, totals 330/90/120/540; stop-over-work, stop-over-stop, same job twice, new work on a done step, backwards, off-day, lowering a done step's count all refused and nothing written; an edit (history kept via replaces_id) + a delete move the gaps; a count raised then corrected (one event per real change, none for a times-only edit). Night shift 22:00–06:00 on Monday keeps one day. Back-dated `at` on events and step start/finish; the tracker's `startStep` / `recordProgress` with `at` (future, before release, zone-less refused); readiness flagged not gated. Setup CRUD. Permission over HTTP (floor-only user reads + passes the record gate, 403 on tracker / planner / setup writes / plant clock; every production-manage role holds cf_erp_floor). Round trips on KEPL: GET queue 17, GET day 5 (6 with the zone uncached), GET machines 3. `CF_FLOOR_COMPANY` / `CF_FLOOR_LINE`; `CF_FLOOR_SAMPLE=<file>` writes example JSON; rollback and every CF table recounted |
| `release_batch_test.mjs` | Round trips and a GOLDEN SNAPSHOT of release on the real KEPL line (company 2, line 923): locks the line, confirms the order (fixed committed date) and makes a dispatch area if there is none, all inside the transaction, then releases through a query-counting proxy. The snapshot is every row release wrote (release, items, steps, dependencies, requirements, reservations — all columns) plus the tracker it returns, ids replaced by stable keys (item = sort_order, step = sort_order:flow_step_id, locked piece = path_key). `--save <file>` before a change to the write path, `--check <file>` after — every part must be identical. Fails above `CF_BATCH_MAX_TRIPS` (100; 74 on 2026-09-29, was 23,097). `CF_BATCH_TRACE=1` prints every query. `CF_BATCH_COMPANY` / `CF_BATCH_LINE`; rollback and every CF table recounted. Save snapshots to scratch, not the repo (~28 MB) |
| `reserve_batch_test.mjs` | Round trips and a GOLDEN SNAPSHOT of **reserve all** (`releaseService.reserveRelease`) on the real KEPL line (company 2, line 923, 2,952 requirements over 16 items). Locks, confirms and releases the line inside the transaction, then puts stock on the shelf THROUGH THE STOCK SERVICES (receipts, a transfer, batch holds and a rejection — `checkLedger` asserted): items fully covered, partly covered, covered exactly, quarantine-only, none at all; one item shared by 828 requirements over five batches in two usable areas (same-day batches tie-broken by id); a quantity-counted item. Two requirements are reserved one at a time first. Scenario 2 runs reserve all again on top (a new older batch, a reservation let go, a requirement issued, the `reserveRequirement` refusals recorded). The snapshot per scenario: every reservation row made, requirements, balances of the seeded items and the returned `reserved` / `short` / tracker, ids replaced by stable keys. `--save <file>` / `--check <file>`; fails above `CF_RESERVE_MAX_TRIPS` (60; 16 on 2026-09-29, was 16,167 / 12,129). `CF_RESERVE_TRACE=1` prints every query. `CF_RESERVE_COMPANY` / `CF_RESERVE_LINE`; rollback and every CF table recounted. Save snapshots to scratch (~40 MB) |
| `cf_lock_nested_lines.mjs` | locks the lines that were already **nested** before lock existed, each in its own transaction and committed only when every piece keeps the code the current rules gave it (captured first, compared by `path_key`). Leaves unnested and released lines alone and says why. Dry run unless `--commit`. Run AFTER `cf_add_lock_stage.mjs` and BEFORE `cf_rows_no_codes.mjs` |
| `cf_rows_no_codes.mjs` | takes the codes off an order's ROWS (user, 2026-09-26: a row is a design; its pieces are coded at lock): points the top piece rule at the order number and proves every existing top code comes out the same, retires the row rules (CFTMP-LINE/PART/SEGMENT; the cut plate rule stays), clears the codes of rows on unlocked lines. Every company, or `CF_COMPANY`; dry run unless `--commit` |
| `update-cf-prod-lock.sh` | the runner for the lock rework against production: schema, the Lock stage in every company's processes, lock the nested lines, rows without codes, BOQ check. `--dry-run` rehearses steps 2-4 and rolls them back; `--yes` does it |
| `cut_pieces_auto_test.mjs` · `code_range_test.mjs` | the automatic cut pieces (`refreshCutPieces`) and piece numbering + placeholders, each on a fixture of its own, rolled back |
| `revision_test.mjs` | REVISIONS end to end on a fixture of its own, rolled back: revise copies every line with identical structure and values and re-derives the cut pieces (same plate, same flow, `-R2` codes), the old revision refuses every kind of write in one sentence, locking the new revision retires the old pieces and gives identical codes, a dropped line frees its codes, a released line refuses, discard gives the previous revision back, lists show the latest revision only. Run in a company whose `FAB_PARTS` / `CUT_PLATE` / `PLATE` and `THICKNESS` / `LENGTH` / `WIDTH` / `GRADE` codes are all free (3 locally) |
| `packer_test.mjs` | the pure packer (no DB): Plate › Sequence › Row › Part, kerf at the rim, common boundaries, determinism |
| `nest_geometry_test.mjs` | the pure geometry (no DB): waste by cause adds up to the plate, offcut tests, DXF |
| `nesting_test.mjs` | plan / accept / getNesting / drift on a fixture of its own (company 2, `CF_NEST_COMPANY`), rolled back; the sheet round trip becomes imported nests; a full automatic plan over an import needs `replaceImported` |
| `nesting_sheet_test.mjs` | the quantity-level sheet (Nests / Needed / How to use this): download, another program's headers, every cell problem at once, download → upload is the same nests. Company 2, rolled back |
| `nesting_import_test.mjs` | imported nests: fits / tight / wont_fit, force rules, coverage short and over, code and size matching, import then nest the rest, re-accept keeps imported lots, waste identity, offcuts written. Real packer, company 2, rolled back |

## The interrupted-run hazard

These scripts are idempotent, which makes it tempting to interrupt a slow run against
production and resume it. **A resumed run only writes what is missing.** Rows the first
pass already wrote keep their old values, and nothing looks at them again — so a value
corrected between the two passes never reaches the rows the first pass created.

That is exactly what happened to girder 1's web cover plate: it kept `THICKNESS 30`
while the BOQ, the blank it is cut from, and the other three girders all said 25. It
inflated the span by 720.63 kg and the order by 1,441 kg. Every existing check passed,
because every existing check compared the model to itself.

`cf_verify_against_boq.mjs` is the answer to that class of error — and `cf_reconcile_dims.mjs`
is the narrower one that can also repair. Dimensions alone are not enough: reconcile_dims only
sees parts that HAVE a blank, and a wrong QUANTITY is invisible to it, so verify_against_boq is
what actually proves the order, and the reason the weight
check in the (since deleted) `cf_recode_order.mjs` was a **hardcoded figure from the customer's document**
rather than a before-and-after comparison. A before-and-after check would have confirmed
the wrong number was still the wrong number.

## Why this dataset is worth keeping

It is the proof that the specification framework carries a real job. Every assembly's weight
is a **rollup** computed from its BOM, not a number the scripts supply. The span comes to
**334,644.13 kg** against the BOQ's own stated 334,644, and **669.29 MT** for two spans
against its stated 669.29. A top-down rollup and a bottom-up sum of the 72 leaves agree to
0.000 kg.

Two readings of the source document had to be decided rather than copied — the steel grade,
which the BOQ never states, and an intermediate-stiffener label that the BOQ contradicts
itself on twice. Both are written out in full in `cf_bridge_data.mjs`'s `ASSUMPTIONS`, with
the evidence for the choice. Change them there, not in the scripts.
