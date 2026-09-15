# Retired scripts (2026-09-13)

These scripts are broken, not obsolete in intent — each one `import`s a service module deleted by
the 2026-09-12 review's decision 2 (legacy nesting-suggestor / board / sheet-import / order-items-import
retirement, EU-20). Running any of them as-is throws `ERR_MODULE_NOT_FOUND` at the `import` line.
Moved here (not deleted) so the history and the diagnostic/benchmark logic they contain stay
available if someone wants to rebuild an equivalent against the current services
(`blankPlanService.js`, `plateSourceService.js`, `nestingRunService.js`).

git history is preserved (`git mv`), so `git log --follow` on any file below still shows its
original life under `scripts/`.

| Script | Deleted module it depended on |
|---|---|
| `bench-nesting.mjs` | `services/nestingSuggestService.js` (`suggestNesting`) |
| `nesting-lab.mjs` | `services/nestingSuggestService.js` |
| `margin-sensitivity.mjs` | `services/nestingSuggestService.js` (`nestableParts`, `plateCatalog`, `offcutSpecs` — the latter two now live in `services/plateSourceService.js`, so this script's plate/offcut logic could be repointed there; `nestableParts` itself is gone) |
| `kepl-finish.mjs` | `services/nestingSuggestService.js` (`suggestNesting`, `acceptSuggestion`) |
| `kepl-vs-client.mjs` | `services/nestingSuggestService.js` (`suggestNesting`) |
| `kepl-nesting.mjs` | `services/nestingSuggestService.js` (`suggestNesting`, `acceptSuggestion`) |
| `compare-wizard.mjs` | `services/boqSheetService.js` (`buildWizardRows`) — the BOQ sheet format itself is gone, superseded by the structure wizard |
| `kepl/nest-accept-test.mjs` | `services/nestingSuggestService.js` |
| `kepl/prenesting-removal-test.mjs` | `services/nestingSuggestService.js` |
| `kepl/remnant-reuse-test.mjs` | `services/nestingSuggestService.js` |
| `kepl/three-axis-test.mjs` | `services/nestingSuggestService.js` |

All eleven are LOCAL-ONLY scripts (`import { pool } from '../../db.js'` or `'../db.js'`, i.e.
`multi_app_be/.env` / localhost:3306 `sqldb`) — none of them ever loaded `.env.tidb`, so moving them
here changes nothing about production exposure.

## `scripts/kepl/` more broadly — do not run against production

Everything else left in `scripts/kepl/` still imports live modules and still runs, but per
`EU_BRIEF_COMMON.md` and `ARCHITECTURE.md` §13 ("Prod data traps"), **no script in this repository
that loads `.env.tidb` may be run by an agent** — that includes most of `multi_app_be/scripts/*kepl*`
and `multi_app_be/scripts/build-kepl-order.mjs`, `rebuild-kepl.mjs`, `backfill-*.mjs`, and others
living directly under `scripts/` (not this folder) that read `../../.env.tidb`. `scripts/kepl/
ladder-equiv.mjs` is the one exception that is genuinely local-only (`../../db.js`, refuses to run
without `--local`) and was left in place rather than moved here, since it still runs cleanly.
