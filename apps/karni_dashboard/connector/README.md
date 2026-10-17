# Karni Dashboard connector

Runs on a Windows machine inside Karni's network (today: `CUS0458KPPLPS`, Windows user
`kpp.prof01`), reads SAP Business One through the Service Layer at `https://10.0.0.10:50000/b1s/v1`
and pushes the rows to the Karni Dashboard backend.

**STRICTLY READ-ONLY towards SAP** (user's rule, 2026-10-17): GET only, plus `POST /Login` and
`POST /Logout`. `run.ps1` refuses any other call in code (`Assert-ReadOnly`), whatever the plan from
the backend says. What it reads is decided by the backend (`lib/datasets.js`), so a new report needs
no change on this machine.

## Files (in the connector folder, e.g. `%USERPROFILE%\karni_connector`)

| File | What |
|---|---|
| `setup.ps1` | One-time setup: downloads `run.ps1`, asks for the SAP password, registers the connector |
| `run.ps1` | One sync run: plan → SAP login → read every dataset (paged) → push → logout → report |
| `config.json` | Backend URL, Service Layer URL, company DB, SAP user, connector id (no secrets) |
| `sap.pw`, `secret.key` | The SAP password and the connector secret, encrypted with Windows DPAPI — only this Windows user on this machine can read them |
| `connector.log` | One line per run and per problem (rolls over at 2 MB) |

## Setup

```powershell
$d = "$env:USERPROFILE\karni_connector"; New-Item -ItemType Directory -Force $d | Out-Null
curl.exe -s -o "$d\setup.ps1" https://multi-app-be-svpc.onrender.com/api/karni/karni_dashboard/connector/files/setup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "$d\setup.ps1"
```

Then an admin approves the connector on the dashboard's **Connection** screen, and `run.ps1` is run
once by hand to check (`powershell -NoProfile -ExecutionPolicy Bypass -File "$d\run.ps1"`).

## Repeating it

`setup.ps1` deliberately does not schedule anything — that is the machine owner's decision. The
usual choice is a Windows Task Scheduler task for this user, every 10 minutes, running
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<folder>\run.ps1"`. Without admin rights it
runs only while the user is signed in (a disconnected Remote Desktop session counts as signed in;
signing out stops it).

## Notes

- Windows PowerShell 5.1 reads a `.ps1` without a BOM as ANSI: keep these files plain ASCII.
- PowerShell 5.1's own web commands fail TLS on that server; everything goes through `curl.exe`.
