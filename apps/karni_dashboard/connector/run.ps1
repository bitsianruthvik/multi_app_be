# Karni Dashboard connector - one run.
#
# Reads SAP Business One through the Service Layer and pushes the rows to the
# Karni Dashboard. Run every 10 minutes by the scheduled task setup.ps1 makes.
#
# STRICTLY READ-ONLY towards SAP: the only calls are GET, plus POST /Login and
# POST /Logout for the session. Invoke-SL refuses anything else, whatever the
# plan from the dashboard says.
#
# Needs: Windows PowerShell 5.1, curl.exe (Windows Server 2019+ / Windows 10+).
# Files (next to this script): config.json, sap.pw and secret.key (both
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

# -- One run ----------------------------------------------------------------
$script:Secret = Unprotect 'secret.key'
$script:PageSize = 500
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$results = @{}
$loggedIn = $false
try {
  $plan = Invoke-Api 'GET' 'connector/plan'
  if ($plan.code -eq 403) { Write-Log "Waiting for approval on the dashboard's Connection screen."; return }
  if ($plan.code -ne 200) { throw "plan failed ($($plan.code)): $($plan.text)" }
  $plan = $plan.text | ConvertFrom-Json
  if ($plan.pageSize) { $script:PageSize = [int]$plan.pageSize }

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
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
