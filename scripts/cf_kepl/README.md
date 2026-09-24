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
```

Order matters: `cf_bridge_setup` needs the `PLATE_WEIGHT` and `SECTION_WEIGHT` formulas that
`cf_rm_import` creates, and fails with a clear message if they are absent. Each script takes
`--verify-only` to check without writing.

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
