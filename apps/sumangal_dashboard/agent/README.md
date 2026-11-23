# Sumangal ERP agent

Keeps the ERP dashboard (V15) up to date from Sumangal's ERP (SQL Server, `Casting_DB`). It runs on one Windows machine inside their network, once a night:

1. reads the tables the dashboard needs (`tables.json`) with a **read-only** SQL login into a local working copy (`work\erp.sqlite`);
2. builds the dashboard dataset on that machine (`build-v15.mjs`, the same code as `multi_app_be/apps/sumangal_dashboard/scripts/v15`);
3. sends it, gzipped (~3 MB), to `POST /api/<company>/sumangal_dashboard/agent/push` over HTTPS, reports the run, deletes the working copy. `last-sent.json.gz` keeps a copy of what was sent.

Only outgoing HTTPS. Nothing is opened to the internet. The agent sends only generated `SELECT`s and `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED` (so it never blocks people entering data); anything else is refused in code (`assertSelectOnly`). The SQL login should have `db_datareader` only, plus `DENY INSERT, UPDATE, DELETE, EXECUTE, ALTER`.

## Needs

- Windows 10/11 or Server 2012+, always on at night, outgoing HTTPS to the dashboard and (once) to nodejs.org. If the SQL Server machine runs an older Windows, use another PC on the same network.
- A read-only SQL login on `Casting_DB` (or a Windows account with the same rights).
- About 1 GB free disk during a run.

## Setup (once, about an hour)

Sign in to that machine **as the Windows user that will run the nightly task**. The secrets are encrypted for that user and nobody else can read them. Then, in PowerShell:

```powershell
Invoke-WebRequest https://multi-app-be-svpc.onrender.com/api/sumangal/sumangal_dashboard/agent/files/setup.ps1 -OutFile setup.ps1 -UseBasicParsing
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

It asks for the SQL Server (`machine` or `machine\INSTANCE`), the database, the login and its password. It tests the connection and registers the agent. It can also create the task "Sumangal dashboard agent" daily at 02:00, which needs that user's Windows password and the right to "log on as a batch job".

**Approve the agent.** It is ignored until an admin approves it on our side:

```
node apps/sumangal_dashboard/scripts/v15/approve-agent.mjs --company=sumangal [--target=prod]
node apps/sumangal_dashboard/scripts/v15/approve-agent.mjs --company=sumangal --id=<id> --apply [--target=prod]
```

Then run it once by hand and check the dashboard:

```powershell
cd C:\SumangalDashboardAgent
.\node\node.exe --no-warnings agent.mjs run
```

## Commands

| | |
|---|---|
| `agent.mjs test` | connect and count the rows of every table it needs |
| `agent.mjs register` | make the agent's key and register (pending until approved) |
| `agent.mjs status` | pending, approved or revoked |
| `agent.mjs run` | the nightly run; `--keep` keeps the working copy, `--source=sqlite:<file>` builds from an existing copy |

Logs: `logs\agent-YYYY-MM-DD.log`. On the dashboard side, `GET /api/<company>/sumangal_dashboard/agent/runs` (platform login) lists the agents and their last runs.

## Removing it

Delete the task and the folder, drop the SQL login, and revoke the agent: `approve-agent.mjs --id=<id> --revoke --apply`.

## For us: rebuilding `dist/`

`cd multi_app_be/apps/sumangal_dashboard/agent && npm install && node build.mjs` bundles `src/agent.mjs` with the SQL Server driver (tedious, TDS 7.3 for SQL Server 2008 R2) into `dist/agent.mjs`, copies the builders from `../scripts/v15` and writes `dist/tables.json` from the tables they read. Commit `dist/`: the backend serves it to `setup.ps1`.
