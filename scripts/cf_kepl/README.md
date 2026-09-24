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
| `cf_reconcile_dims.mjs` | checks every part against **two independent authorities** — the blank it is cut from, and the BOQ — and repairs only where both name the same replacement. Read-only without `--fix`. It exists because a part can drift from the order it belongs to without any self-consistency check noticing: the model compared to itself still balances |

## The interrupted-run hazard

These scripts are idempotent, which makes it tempting to interrupt a slow run against
production and resume it. **A resumed run only writes what is missing.** Rows the first
pass already wrote keep their old values, and nothing looks at them again — so a value
corrected between the two passes never reaches the rows the first pass created.

That is exactly what happened to girder 1's web cover plate: it kept `THICKNESS 30`
while the BOQ, the blank it is cut from, and the other three girders all said 25. It
inflated the span by 720.63 kg and the order by 1,441 kg. Every existing check passed,
because every existing check compared the model to itself.

`cf_reconcile_dims.mjs` is the answer to that class of error, and the reason the weight
check in `cf_recode_order.mjs` is a **hardcoded figure from the customer's document**
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
