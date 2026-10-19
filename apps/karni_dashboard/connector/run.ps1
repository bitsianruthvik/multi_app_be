# Karni Dashboard connector - one run.
#
# Reads SAP Business One through the Service Layer and pushes the rows to the
# Karni Dashboard. Run every 10 minutes by the scheduled task setup.ps1 makes.
#
# STRICTLY READ-ONLY towards SAP: the only calls are GET, plus POST /Login and
# POST /Logout for the session. Invoke-SL refuses anything else, whatever the
# plan from the dashboard says.
#
# SAVED REPORTS: after the sync, until 9 minutes after the run began, it asks
# the dashboard every 10 seconds for saved SAP queries people want to run, and
# runs them on the SAP database (HANA, through ODBC) with a database user that
# may only SELECT. Three locks: that user's rights, a READ ONLY transaction,
# and Assert-SelectOnly here. Without config.json "db" and db.pw it only tells
# the dashboard that saved reports are not set up.
#
# Needs: Windows PowerShell 5.1, curl.exe (Windows Server 2019+ / Windows 10+),
# for saved reports the SAP HANA ODBC driver (HDBODBC, comes with the SAP client).
# Files (next to this script): config.json, sap.pw, secret.key and db.pw (all
# encrypted with Windows DPAPI for this Windows user), connector.log.

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cfg = Get-Content (Join-Path $Here 'config.json') -Raw | ConvertFrom-Json
$Log = Join-Path $Here 'connector.log'
$Tmp = Join-Path $env:TEMP ('kd_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Tmp | Out-Null
$Jar = Join-Path $Tmp 'sl.cookies'

function Write-Log($msg) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg
  Add-Content -Path $Log -Value $line -Encoding UTF8
  if ((Get-Item $Log).Length -gt 2MB) { Move-Item $Log "$Log.old" -Force }
}

function Unprotect($file) {
  $sec = Get-Content (Join-Path $Here $file) | ConvertTo-SecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { [Runtime.InteropServices.Marshal]::PtrToStringAuto($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

# -- SAP Service Layer: READ-ONLY -------------------------------------------
function Assert-ReadOnly($method, $path) {
  $p = ($path -split '\?')[0]
  if ($method -eq 'GET') { return }
  if ($method -eq 'POST' -and ($p -eq 'Login' -or $p -eq 'Logout')) { return }
  throw "READ-ONLY: refused $method $p"
}

function Invoke-SL($method, $path, $bodyFile) {
  Assert-ReadOnly $method $path
  $out = Join-Path $Tmp 'sl.out'
  $ca = @('-sk', '-m', '300', '-b', $Jar, '-c', $Jar, '-o', $out, '-w', '%{http_code}',
            '-H', ('Prefer: odata.maxpagesize=' + $script:PageSize))
  if ($method -eq 'POST') {
    $ca += @('-X', 'POST', '-H', 'Content-Type: application/json')
    if ($bodyFile) { $ca += @('-d', "@$bodyFile") }
  }
  $code = & curl.exe @ca ($Cfg.slUrl.TrimEnd('/') + '/' + $path)
  $text = if (Test-Path $out) { [IO.File]::ReadAllText($out, [Text.Encoding]::UTF8) } else { '' }
  Remove-Item $out -Force -ErrorAction SilentlyContinue
  return @{ code = [int]$code; text = $text }
}

function Connect-SL {
  $bf = Join-Path $Tmp 'login.json'
  $pw = Unprotect 'sap.pw'
  [IO.File]::WriteAllText($bf, (@{ CompanyDB = $Cfg.companyDb; UserName = $Cfg.sapUser; Password = $pw } | ConvertTo-Json))
  $pw = $null
  try { $r = Invoke-SL 'POST' 'Login' $bf } finally { Remove-Item $bf -Force -ErrorAction SilentlyContinue }
  if ($r.code -ne 200) { throw "SAP login failed ($($r.code)): $(Get-SlError $r.text)" }
}

function Get-SlError($text) {
  try { $j = $text | ConvertFrom-Json; if ($j.error.message.value) { return $j.error.message.value } } catch {}
  if ($text.Length -gt 300) { return $text.Substring(0, 300) } else { return $text }
}

# -- Dashboard API ----------------------------------------------------------
function Invoke-Api($method, $path, $bodyFile) {
  $out = Join-Path $Tmp 'api.out'
  $ca = @('-s', '-m', '300', '-o', $out, '-w', '%{http_code}',
            '-H', ('X-Connector-Id: ' + $Cfg.connectorUid), '-H', ('Authorization: Bearer ' + $script:Secret))
  if ($method -eq 'POST') { $ca += @('-X', 'POST', '-H', 'Content-Type: application/json; charset=utf-8', '--data-binary', "@$bodyFile") }
  $code = & curl.exe @ca ($Cfg.apiBase.TrimEnd('/') + '/' + $path)
  $text = if (Test-Path $out) { [IO.File]::ReadAllText($out, [Text.Encoding]::UTF8) } else { '' }
  Remove-Item $out -Force -ErrorAction SilentlyContinue
  return @{ code = [int]$code; text = $text }
}

function Send-Pages($dataset, [string[]]$pages, $done, $startedAt) {
  # The pages go as SAP returned them; the dashboard reads each page's "value".
  $bf = Join-Path $Tmp 'push.json'
  $head = '{"dataset":' + (ConvertTo-Json $dataset) + ',"done":' + ($(if ($done) { 'true' } else { 'false' })) +
          ',"startedAt":' + (ConvertTo-Json $startedAt) + ',"pages":['
  [IO.File]::WriteAllText($bf, $head + ($pages -join ',') + ']}')
  $r = Invoke-Api 'POST' 'connector/push' $bf
  Remove-Item $bf -Force -ErrorAction SilentlyContinue
  if ($r.code -ne 200) { throw "push $dataset failed ($($r.code)): $($r.text)" }
}

# -- Saved reports: SELECT only on the SAP database --------------------------
# The same check as the dashboard's (services/queryService.js classify).
function Get-Skeleton([string]$sql) {
  $s = [regex]::Replace($sql, '/\*[\s\S]*?\*/', ' ')
  $s = [regex]::Replace($s, '--[^\n]*', ' ')
  $s = [regex]::Replace($s, "'(?:[^']|'')*'", "''")
  $s = [regex]::Replace($s, '"(?:[^"]|"")*"', '""')
  return [regex]::Replace($s, '\[[^\]]*\]', '[]')
}

function Assert-SelectOnly([string]$sql) {
  $s = (Get-Skeleton $sql).Trim() -replace ';\s*$', ''
  $bad = [regex]::Match($s, '(?i)\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|EXEC|EXECUTE|COMMIT|ROLLBACK|LOCK|RENAME|IMPORT|EXPORT|UNLOAD)\b')
  if ($bad.Success) { throw "READ-ONLY: refused $($bad.Value)" }
  if ([regex]::IsMatch($s, '(?i)\bREPLACE\b(?!\s*\()')) { throw 'READ-ONLY: refused REPLACE' }
  if ([regex]::IsMatch($s, '(?i)\bDO\s+BEGIN\b')) { throw 'READ-ONLY: refused DO BEGIN' }
  $parts = @($s -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($parts.Count -eq 1 -and $parts[0] -match '^(?i)\(*\s*(SELECT|WITH)\b') { return 'select' }
  foreach ($p in $parts) {
    if ($p -notmatch '^(?i)(\(*\s*(SELECT|WITH)\b|DECLARE\b|IF\b|ELSE\b|ELSEIF\b|END\b|[A-Za-z_]\w*\s*(\[[^\]]*\])?\s*:=)') { throw 'READ-ONLY: only SELECT and variable statements' }
  }
  return 'script'
}

function Get-DbConnectionString {
  if (-not $Cfg.db -or -not (Test-Path (Join-Path $Here 'db.pw'))) { return $null }
  $pw = Unprotect 'db.pw'
  if ($Cfg.db.connectionString) { return $Cfg.db.connectionString.Replace('{PWD}', $pw) }
  $drv = if ($Cfg.db.driver) { $Cfg.db.driver } else { 'HDBODBC' }
  $schema = if ($Cfg.db.schema) { $Cfg.db.schema } else { $Cfg.companyDb }
  return "DRIVER={$drv};SERVERNODE=$($Cfg.db.server);UID=$($Cfg.db.user);PWD=$pw;CURRENTSCHEMA=$schema;"
}

function Format-Cell($v) {
  if ($v -is [DBNull] -or $null -eq $v) { return $null }
  if ($v -is [DateTime]) { if ($v.TimeOfDay.Ticks -eq 0) { return $v.ToString('yyyy-MM-dd') } else { return $v.ToString('yyyy-MM-dd HH:mm:ss') } }
  if ($v -is [decimal] -or $v -is [double] -or $v -is [single]) { return [double]$v }
  if ($v -is [int] -or $v -is [long] -or $v -is [int16] -or $v -is [byte]) { return [long]$v }
  if ($v -is [byte[]]) { return '(binary)' }
  return [string]$v
}

function Invoke-SavedQuery($job, [string]$connStr) {
  $kind = Assert-SelectOnly $job.sql
  $sql = ($job.sql.Trim() -replace ';\s*$', '')
  if ($kind -eq 'script') { $sql = "DO BEGIN`n$sql;`nEND" }
  $max = if ($job.maxRows) { [int]$job.maxRows } else { 5000 }
  $conn = New-Object System.Data.Odbc.OdbcConnection $connStr
  $conn.Open()
  try {
    # The transaction exists to hold READ ONLY. Only a local test config (a driver
    # without transactions) sets readOnlyStatement to '' - never on the SAP server.
    $ro = 'SET TRANSACTION READ ONLY'
    if ($Cfg.db.PSObject.Properties['readOnlyStatement']) { $ro = [string]$Cfg.db.readOnlyStatement }
    $tx = $null
    if ($ro) {
      $tx = $conn.BeginTransaction()
      $c0 = $conn.CreateCommand(); $c0.Transaction = $tx; $c0.CommandText = $ro; [void]$c0.ExecuteNonQuery()
    }
    $cmd = $conn.CreateCommand(); $cmd.Transaction = $tx; $cmd.CommandText = $sql; $cmd.CommandTimeout = 240
    $rd = $cmd.ExecuteReader()
    $cols = $null; $rows = New-Object System.Collections.ArrayList; $cut = $false
    do {
      # A script may return several result sets: keep the last one that has columns.
      if ($rd.FieldCount -gt 0) {
        $cols = @(0..($rd.FieldCount - 1) | ForEach-Object { $rd.GetName($_) })
        $rows = New-Object System.Collections.ArrayList; $cut = $false
        while ($rd.Read()) {
          if ($rows.Count -ge $max) { $cut = $true; break }
          $vals = New-Object object[] $rd.FieldCount
          for ($i = 0; $i -lt $rd.FieldCount; $i++) { $vals[$i] = Format-Cell $rd.GetValue($i) }
          [void]$rows.Add($vals)
        }
      }
    } while ($rd.NextResult())
    $rd.Close()
    if ($tx) { $tx.Rollback() }
    if ($null -eq $cols) { $cols = @() }
    return @{ id = $job.id; columns = $cols; rows = $rows.ToArray(); truncated = $cut }
  } finally { $conn.Close() }
}

function Send-Json($path, $obj) {
  Add-Type -AssemblyName System.Web.Extensions
  $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $ser.MaxJsonLength = [int]::MaxValue
  $bf = Join-Path $Tmp 'q.json'
  [IO.File]::WriteAllText($bf, $ser.Serialize($obj), (New-Object Text.UTF8Encoding $false))
  $r = Invoke-Api 'POST' $path $bf
  Remove-Item $bf -Force -ErrorAction SilentlyContinue
  return $r
}

# Ask for waiting saved reports and run them. Returns $false when saved reports are not set up.
function Invoke-QueryJobs {
  $state = 'not_configured'; $msg = ''
  $connStr = $null
  try { $connStr = Get-DbConnectionString } catch { $state = 'error'; $msg = $_.Exception.Message }
  if ($connStr) {
    if (-not $script:DbChecked) {
      try { $t = New-Object System.Data.Odbc.OdbcConnection $connStr; $t.Open(); $t.Close(); $script:DbChecked = $true }
      catch { $state = 'error'; $msg = $_.Exception.Message; $connStr = $null }
    }
    if ($connStr) { $state = 'ready' }
  }
  $q = 'connector/query-jobs?runner=' + $state + '&message=' + [uri]::EscapeDataString($msg)
  $r = Invoke-Api 'GET' $q
  if ($r.code -ne 200) { Write-Log "query-jobs failed ($($r.code))"; return ($state -eq 'ready') }
  if ($state -eq 'error') { Write-Log "saved reports: $msg" }
  foreach ($job in @(($r.text | ConvertFrom-Json).jobs)) {
    if (-not $job) { continue }
    $t0 = Get-Date
    try {
      $res = Invoke-SavedQuery $job $connStr
      Write-Log "saved report $($job.id): $($res.rows.Count) rows in $([int]((Get-Date) - $t0).TotalSeconds)s"
    } catch {
      $res = @{ id = $job.id; error = $_.Exception.Message }
      Write-Log "saved report $($job.id): $($_.Exception.Message)"
    }
    $p = Send-Json 'connector/query-result' $res
    if ($p.code -ne 200) { Write-Log "query-result $($job.id) failed ($($p.code)): $($p.text)" }
  }
  return ($state -eq 'ready')
}

# -- One run ----------------------------------------------------------------
$script:Secret = Unprotect 'secret.key'
$script:PageSize = 500
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$results = @{}
$loggedIn = $false
$approved = $false
try {
  $plan = Invoke-Api 'GET' 'connector/plan'
  if ($plan.code -eq 403) { Write-Log "Waiting for approval on the dashboard's Connection screen."; return }
  if ($plan.code -ne 200) { throw "plan failed ($($plan.code)): $($plan.text)" }
  $plan = $plan.text | ConvertFrom-Json
  if ($plan.pageSize) { $script:PageSize = [int]$plan.pageSize }

  $approved = $true
  # Reports already waiting go first, so they don't wait for the whole sync.
  try { [void](Invoke-QueryJobs) } catch { Write-Log "saved reports: $($_.Exception.Message)" }
  Connect-SL; $loggedIn = $true
  foreach ($ds in $plan.datasets) {
    $rows = 0
    try {
      $skip = 0; $held = New-Object System.Collections.Generic.List[string]
      while ($true) {
        $sep = if ($ds.path.Contains('?')) { '&' } else { '?' }
        $r = Invoke-SL 'GET' ($ds.path + $sep + '$skip=' + $skip)
        if ($r.code -eq 401) { Connect-SL; $r = Invoke-SL 'GET' ($ds.path + $sep + '$skip=' + $skip) }
        if ($r.code -ne 200) { throw "SAP $($r.code): $(Get-SlError $r.text)" }
        $page = $r.text | ConvertFrom-Json
        $n = @($page.value).Count
        $more = $n -gt 0 -and ($page.'odata.nextLink' -or $page.'@odata.nextLink')
        if ($ds.full) { $held.Add($r.text) }
        elseif ($n -gt 0 -or $skip -eq 0) { Send-Pages $ds.key @($r.text) (-not $more) $startedAt }
        $rows += $n; $skip += $n
        if (-not $more) { break }
      }
      if ($ds.full) { Send-Pages $ds.key $held.ToArray() $true $startedAt }
      $results[$ds.key] = @{ rows = $rows }
    } catch {
      $results[$ds.key] = @{ rows = $rows; error = $_.Exception.Message }
      Write-Log "$($ds.key): $($_.Exception.Message)"
    }
  }
} catch {
  $results['_run'] = @{ error = $_.Exception.Message }
  Write-Log "run: $($_.Exception.Message)"
} finally {
  if ($loggedIn) { Invoke-SL 'POST' 'Logout' | Out-Null }
  try {
    $bf = Join-Path $Tmp 'report.json'
    $rep = @{ startedAt = $startedAt; finishedAt = (Get-Date).ToUniversalTime().ToString('o'); results = $results }
    [IO.File]::WriteAllText($bf, ($rep | ConvertTo-Json -Depth 4))
    if ($results.Count) { Invoke-Api 'POST' 'connector/report' $bf | Out-Null }
  } catch {}
  $sum = ($results.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value.rows)$(if ($_.Value.error) { '!' })" }) -join ' '
  if ($sum) { Write-Log "done  $sum" }
  # Saved reports until 9 minutes after the run began (the next run starts at 10).
  if ($approved) {
    try {
      $until = ([DateTime]::Parse($startedAt)).ToLocalTime().AddMinutes(9)
      while ((Get-Date) -lt $until) {
        if (-not (Invoke-QueryJobs)) { break }
        Start-Sleep -Seconds 10
      }
    } catch { Write-Log "saved reports: $($_.Exception.Message)" }
  }
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
