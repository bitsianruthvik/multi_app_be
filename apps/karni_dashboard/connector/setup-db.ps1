# Karni Dashboard connector - set up SAVED REPORTS (one time, no admin rights).
#
# Saved SAP queries run on the SAP HANA database with a database user that may
# only SELECT (Karni's SAP partner creates it). This script:
#   1. downloads the latest run.ps1 next to this script
#   2. asks for that database user's password (stored encrypted for THIS Windows user)
#   3. adds the database details to config.json
#   4. tests the connection in a READ ONLY transaction (SELECT 1 FROM DUMMY)
#
# Run it from the connector folder, after setup.ps1:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-db.ps1 -Server 10.0.0.10:30015 -User KD_READER

param(
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$User,
  [string]$Schema = '',
  [string]$Driver = 'HDBODBC'
)
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$CfgFile = Join-Path $Here 'config.json'
if (-not (Test-Path $CfgFile)) { throw 'config.json not found: run setup.ps1 first.' }
$cfg = Get-Content $CfgFile -Raw | ConvertFrom-Json

Write-Host "`nKarni Dashboard - saved reports setup - folder $Here`n"

# 1. run.ps1
& curl.exe -s -f -o (Join-Path $Here 'run.ps1') ($cfg.apiBase.TrimEnd('/') + '/connector/files/run.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Could not download run.ps1 from the dashboard.' }
Write-Host '[1/4] run.ps1 updated'

# 2. password
$sec = Read-Host "Password of database user $User" -AsSecureString
$sec | ConvertFrom-SecureString | Set-Content (Join-Path $Here 'db.pw')
Write-Host '[2/4] password stored (encrypted for this Windows user)'

# 3. config.json
if (-not $Schema) { $Schema = $cfg.companyDb }
$db = [pscustomobject]@{ driver = $Driver; server = $Server; user = $User; schema = $Schema }
$cfg | Add-Member -NotePropertyName db -NotePropertyValue $db -Force
$cfg | ConvertTo-Json -Depth 4 | Set-Content $CfgFile -Encoding UTF8
Write-Host "[3/4] config.json: $Driver $Server user $User schema $Schema"

# 4. test
$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
$conn = New-Object System.Data.Odbc.OdbcConnection "DRIVER={$Driver};SERVERNODE=$Server;UID=$User;PWD=$pw;CURRENTSCHEMA=$Schema;"
$pw = $null
try {
  $conn.Open()
  $tx = $conn.BeginTransaction()
  $c = $conn.CreateCommand(); $c.Transaction = $tx; $c.CommandText = 'SET TRANSACTION READ ONLY'; [void]$c.ExecuteNonQuery()
  $c = $conn.CreateCommand(); $c.Transaction = $tx; $c.CommandText = 'SELECT COUNT(*) FROM "OADM"'; $n = $c.ExecuteScalar()
  $tx.Rollback()
  Write-Host "[4/4] connected, read-only transaction works (OADM rows: $n)"
  Write-Host "`nDone. Saved reports start running from the next connector run (within 10 minutes).`n"
} catch {
  Write-Host "[4/4] TEST FAILED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Check the server:port, user, password, and that the HANA ODBC driver (HDBODBC) is installed (Get-OdbcDriver).'
} finally { $conn.Close() }
