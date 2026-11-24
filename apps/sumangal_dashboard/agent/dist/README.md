# Sumangal ERP agent

Keeps the ERP dashboard (V15) up to date from Sumangal's ERP (SQL Server, `Casting_DB`). It runs on one Windows machine inside their network.

**Nightly (02:00, `agent.mjs run`):**

1. reads every table of the database afresh, with a **read-only** SQL login, into a working copy on that machine (`work\erp.sqlite`; on the snapshot 192 tables, 3.2 million rows, about 850 MB, about a minute). Password columns are never read; `dtproperties` and `sysdiagrams` are skipped. Only the dashboard dataset leaves the machine;
2. builds the dashboard dataset there (`build-v15.mjs`, the same code as `multi_app_be/apps/sumangal_dashboard/scripts/v15`);
3. sends it, gzipped (~2.3 MB), to `POST /api/<company>/sumangal_dashboard/agent/push` over HTTPS and reports the run. `last-sent.json.gz` keeps a copy of what was sent.

**Working hours (08:00–21:00, not Wednesdays, `agent.mjs day`):** no timer. Whenever someone opens the dashboard or presses **Refresh now** (the agent waits on `GET /agent/jobs`), it reads the rows changed since its last read, for the dashboard's tables (`tables.json`) and the headers they hang from, rebuilds and sends. About a minute end to end. The other tables refresh nightly. `--every=<minutes>` adds a timer if ever wanted.

- Changed rows: tables with `modified_date` / `created_date` give the rows touched since the last read (by SQL Server's clock, less 10 minutes). A table without dates follows its header (the first key-named column after its own key, worked out at the nightly read and logged): its lines are re-read for every header that changed, which also drops lines deleted under it. `tbl_combobox_master` (no dates, no header) is re-read whole.
- Rows deleted outright, or edited without their date changing, show after the next nightly read, which copies everything afresh.
- The working copy stays on this machine, inside their network.

Only outgoing HTTPS. Nothing is opened to the internet. The agent sends only generated `SELECT`s and `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED` (so it never blocks people entering data); anything else is refused in code (`assertSelectOnly`). The SQL login should have `db_datareader` only, plus `DENY INSERT, UPDATE, DELETE, EXECUTE, ALTER`.

## Needs

- Windows 10/11 or Server 2016+ (64-bit) inside their network, outgoing HTTPS to the dashboard and (once) to nodejs.org. If the SQL Server machine runs an older Windows, use another PC on the same network.
- A SQL login on `Casting_DB` that can read (read-only is best).
- About 2.5 GB free disk (the working copy plus the next one being built).

## Setup (once, about an hour)

Sign in to that machine **as the Windows user that will run the nightly task**. The secrets are encrypted for that user and nobody else can read them. Then, in PowerShell:

```powershell
Invoke-WebRequest https://api.ceofactory.vc/api/sumangal/sumangal_dashboard/agent/files/setup.ps1 -OutFile setup.ps1 -UseBasicParsing
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

No admin rights are needed. It checks the Windows version (10/11 or Server 2016+, 64-bit) and asks for the SQL Server (IP or `machine`, or `machine\INSTANCE`), the port, the database, the login and its password (`-Server`, `-Port`, `-User` fill the defaults). The test reports the login's rights: one that could also write is noted, not refused, since the agent only sends `SELECT`s. Then it registers the agent and creates the two tasks, which start `run-hidden.vbs` (node with no window):

- **1 (default): while the user is signed in.** No password and no admin right. Locking the screen is fine; signing out stops them. A run missed while the PC was off starts when it is next on, so a PC that is only on in the daytime does its full read in the morning.
- **2: signed in or not.** Needs the user's Windows password and the "Log on as a batch job" right.

Runs never overlap: a run waits for the one before it (`work\run.lock`).

**Approve the agent.** It is ignored until an admin approves it on our side:

```
node apps/sumangal_dashboard/scripts/v15/approve-agent.mjs --company=sumangal [--target=prod]
node apps/sumangal_dashboard/scripts/v15/approve-agent.mjs --company=sumangal --id=<id> --apply [--target=prod]
```

The agent reports to the AWS server (from 2026-11-24), so approve it THERE, where its database is:

```
ssh -i .lightsail-tm-trial.pem ubuntu@32.237.65.43 "cd /srv/tm/multi_app_be && node apps/sumangal_dashboard/scripts/v15/approve-agent.mjs --company=sumangal --target=server"
ssh -i .lightsail-tm-trial.pem ubuntu@32.237.65.43 "cd /srv/tm/multi_app_be && node apps/sumangal_dashboard/scripts/v15/approve-agent.mjs --company=sumangal --id=<id> --apply --target=server"
```

Then run it once by hand and check the dashboard:

```powershell
cd C:\SumangalDashboardAgent
.\node\node.exe --no-warnings agent.mjs run
```

## Commands

| | |
|---|---|
| `agent.mjs test` | connect, report the login's rights, count the rows of every table |
| `agent.mjs register` | make the agent's key and register (pending until approved) |
| `agent.mjs status` | pending, approved or revoked |
| `agent.mjs run` | the nightly run (full read) |
| `agent.mjs update` | one day-time update now (changed rows only) |
| `agent.mjs day [--until=21:00] [--every=<min>]` | working hours: an update whenever the dashboard asks |
| tests | `--server-sqlite=<file>` reads "the ERP" from an SQLite file instead of SQL Server; `--source=sqlite:<file>` builds from an existing copy; `--keep` keeps the intermediate files |

Logs: `logs\agent-YYYY-MM-DD.log`. On the dashboard side, `GET /api/<company>/sumangal_dashboard/agent/runs` (platform login) lists the agents and their last runs.

## Removing it

Delete the task and the folder, drop the SQL login, and revoke the agent: `approve-agent.mjs --id=<id> --revoke --apply`.

## For us: rebuilding `dist/`

`cd multi_app_be/apps/sumangal_dashboard/agent && npm install && node build.mjs` bundles `src/agent.mjs` with the SQL Server driver (tedious, TDS 7.3 for SQL Server 2008 R2) into `dist/agent.mjs`, copies the builders from `../scripts/v15` and writes `dist/tables.json` from the tables they read. Commit `dist/`: the backend serves it to `setup.ps1`.
