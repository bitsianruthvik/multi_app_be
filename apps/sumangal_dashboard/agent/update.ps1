<#
  Sumangal ERP agent: update an installed agent (2026-11-26). Run in Windows PowerShell, signed in as the Windows user
  the agent runs as (on Sumangal's server: Administrator). It keeps config.json, the saved secrets and the working copy.

    powershell -ExecutionPolicy Bypass -File C:\SumangalDashboardAgent\update.ps1

  What it does:
   1. downloads the agent files from the dashboard and checks each against the list signed by the platform team
   2. stops the old day listener (08:00-21:00, not Wednesdays)
   3. creates the tasks again: the nightly full read at 02:00, and the listener: any hour, every day, started at sign-in
      and checked every 10 minutes (only one runs; a stopped one starts again by itself)
   4. starts the listener and asks the dashboard whether the agent is approved
  From this version on the agent updates itself (hourly, and before the nightly run) when the platform team signs a
  new version, so this script is needed once.
#>
param([string]$Dir = 'C:\SumangalDashboardAgent', [string]$At = '02:00')
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
if (-not (Test-Path "$Dir\config.json")) { throw "No agent in $Dir (config.json not found). Use -Dir <folder>." }
$cfg = Get-Content "$Dir\config.json" -Raw | ConvertFrom-Json
$base = "$($cfg.api.TrimEnd('/'))/api/$($cfg.company)/sumangal_dashboard/agent/files"
$node = "$Dir\node\node.exe"
$v = [Environment]::OSVersion.Version
if ($v.Major -lt 10) { $env:NODE_SKIP_PLATFORM_CHECK = "1" }   # Server 2012 R2

Step "Agent files from $($cfg.api)"
$new = "$Dir\work\update"; New-Item -ItemType Directory -Force -Path $new | Out-Null
Invoke-WebRequest "$base/release.json" -OutFile "$new\release.json" -UseBasicParsing
Invoke-WebRequest "$base/release.sig" -OutFile "$new\release.sig" -UseBasicParsing
$rel = Get-Content "$new\release.json" -Raw | ConvertFrom-Json
foreach ($p in $rel.files.PSObject.Properties) {
  $f = $p.Name
  if ($f -notmatch '^[a-z0-9-]+\.(mjs|json|vbs|ps1|md)$') { throw "Bad file name in the release: $f" }
  Invoke-WebRequest "$base/$f" -OutFile "$new\$f" -UseBasicParsing
  if ((Get-FileHash "$new\$f" -Algorithm SHA256).Hash.ToLower() -ne $p.Value) { throw "$f does not match the release list. Nothing was changed." }
  Write-Host "  $f"
}
# the signature, checked by the new agent itself (Ed25519; PowerShell 4 cannot)
Push-Location $new
& $node --no-warnings agent.mjs verify-release
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "The release is not signed by the platform team. Nothing was changed." }
Pop-Location

Step "Stopping the old listener"
foreach ($t in @('Sumangal dashboard agent (day)', 'Sumangal dashboard agent (listen)')) {
  if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue }
}
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*agent.mjs*' -and $_.CommandLine -match ' (day|listen)( |$)' } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null; Write-Host "  stopped process $($_.ProcessId)" }

Step "Installing version $($rel.version)"
$old = "$Dir\work\previous-version"; New-Item -ItemType Directory -Force -Path $old | Out-Null
foreach ($p in $rel.files.PSObject.Properties) { $f = $p.Name; if (Test-Path "$Dir\$f") { Copy-Item "$Dir\$f" "$old\$f" -Force } }
foreach ($p in ($rel.files.PSObject.Properties | Sort-Object { $_.Name -eq 'agent.mjs' })) { Copy-Item "$new\$($p.Name)" "$Dir\$($p.Name)" -Force }
Write-Host "  the old files are in $old"

Step "Scheduled tasks"
$who = "$env:USERDOMAIN\$env:USERNAME"
$p = New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Limited
$nightAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$Dir\run-hidden.vbs`" run" -WorkingDirectory $Dir
$nightSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Sumangal dashboard agent' -Action $nightAction -Trigger (New-ScheduledTaskTrigger -Daily -At $At) -Settings $nightSettings -Principal $p -Force | Out-Null
$listenAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$Dir\run-hidden.vbs`" listen" -WorkingDirectory $Dir
# at sign-in, and every 10 minutes (IgnoreNew: only one listener; a stopped one is back within 10 minutes); no time limit
$listenTriggers = @((New-ScheduledTaskTrigger -AtLogOn -User $who), (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)))
$listenSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Sumangal dashboard agent (listen)' -Action $listenAction -Trigger $listenTriggers -Settings $listenSettings -Principal $p -Force | Out-Null
if (Get-ScheduledTask -TaskName 'Sumangal dashboard agent (day)' -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName 'Sumangal dashboard agent (day)' -Confirm:$false }
Write-Host "  'Sumangal dashboard agent'          nightly full read at $At"
Write-Host "  'Sumangal dashboard agent (listen)' any hour, every day (they run while $env:USERNAME is signed in; locking the screen is fine)"

Step "Starting the listener"
Start-ScheduledTask -TaskName 'Sumangal dashboard agent (listen)'
Push-Location $Dir; & $node --no-warnings agent.mjs status; Pop-Location
Write-Host "`nDone. Open the dashboard and press Refresh: today's entries arrive in about a minute. Log: $Dir\logs" -ForegroundColor Green
