<#
  Sumangal ERP agent: setup. Run in Windows PowerShell 5.1, signed in as the Windows user that will run the nightly
  task (its saved secrets can only be read by that user). See README.md.

    powershell -ExecutionPolicy Bypass -File setup.ps1
    powershell -ExecutionPolicy Bypass -File setup.ps1 -Api https://multi-app-be-svpc.onrender.com -Company sumangal -Dir C:\SumangalDashboardAgent

  What it does: makes the agent folder, downloads the official portable Node.js (checked against nodejs.org's
  SHA-256 list) and the agent files from the dashboard, asks for the SQL Server and the read-only login, saves the
  password encrypted (DPAPI, this user only), tests the connection, registers the agent (an admin approves it on
  the dashboard side) and, if you agree, creates the nightly task at 02:00. It changes nothing in the ERP.
#>
param(
  [string]$Api = 'https://multi-app-be-svpc.onrender.com',
  [string]$Company = 'sumangal',
  [string]$Dir = 'C:\SumangalDashboardAgent',
  [string]$NodeVersion = 'v22.17.0',
  [string]$At = '02:00'
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }

Step "Agent folder $Dir"
New-Item -ItemType Directory -Force -Path $Dir, "$Dir\work", "$Dir\logs" | Out-Null

Step "Node.js $NodeVersion (portable, from nodejs.org)"
$node = "$Dir\node\node.exe"
if (-not (Test-Path $node)) {
  $zip = "node-$NodeVersion-win-x64.zip"; $tmp = "$Dir\work\$zip"
  Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/$zip" -OutFile $tmp -UseBasicParsing
  $sums = (Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt" -UseBasicParsing).Content
  $want = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($zip) } | Select-Object -First 1).Split(' ')[0]
  $have = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
  if (-not $want -or $have -ne $want.ToLower()) { throw "Node.js download does not match nodejs.org's checksum. Stopped." }
  Expand-Archive $tmp -DestinationPath "$Dir\work" -Force
  Move-Item "$Dir\work\node-$NodeVersion-win-x64" "$Dir\node"
  Remove-Item $tmp
}
& $node --version

Step "Agent files from the dashboard"
foreach ($f in @('agent.mjs', 'build-d.mjs', 'supp.mjs', 'hist.mjs', 'build-v15.mjs', 'tables.json', 'README.md')) {
  Invoke-WebRequest "$Api/api/$Company/sumangal_dashboard/agent/files/$f" -OutFile "$Dir\$f" -UseBasicParsing
  Write-Host "  $f"
}

Step "SQL Server and the read-only login"
$cfgFile = "$Dir\config.json"
$cfg = if (Test-Path $cfgFile) { Get-Content $cfgFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
function Ask($label, $default) { $v = Read-Host "$label [$default]"; if ([string]::IsNullOrWhiteSpace($v)) { $default } else { $v.Trim() } }
$server = Ask 'SQL Server (machine name or IP; add \INSTANCE for a named instance)' $(if ($cfg.server) { $cfg.server } else { 'localhost' })
$port = Ask 'Port (default instance only)' $(if ($cfg.port) { $cfg.port } else { '1433' })
$database = Ask 'Database' $(if ($cfg.database) { $cfg.database } else { 'Casting_DB' })
$auth = Ask 'Login type: sql or windows' $(if ($cfg.auth) { $cfg.auth } else { 'sql' })
$user = Ask 'Login (for windows: DOMAIN\user)' $(if ($cfg.user) { $cfg.user } else { 'dashboard_reader' })
$pw = Read-Host 'Password of that login (not shown)' -AsSecureString
($pw | ConvertFrom-SecureString) | Set-Content "$Dir\sql.sec" -Encoding ASCII
$out = [ordered]@{ api = $Api; company = $Company; server = $server; port = [int]$port; database = $database; auth = $auth; user = $user; encrypt = $false; tdsVersion = '7_3_B' }
if ($cfg.agentUid) { $out.agentUid = $cfg.agentUid }
$out | ConvertTo-Json | Set-Content $cfgFile -Encoding UTF8

Step "Testing the connection (read-only)"
Push-Location $Dir
& $node --no-warnings agent.mjs test
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "The test did not pass. Check the server, the login and the password, then run setup again." }

Step "Registering this agent with the dashboard"
& $node --no-warnings agent.mjs register
Pop-Location

Step "Nightly task"
$yes = Read-Host "Create the scheduled task 'Sumangal dashboard agent' daily at $At under $env:USERDOMAIN\$env:USERNAME? (y/n)"
if ($yes -match '^[yY]') {
  $tp = Read-Host "Windows password of $env:USERDOMAIN\$env:USERNAME (so the task runs when nobody is signed in)" -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($tp))
  $action = New-ScheduledTaskAction -Execute $node -Argument "--no-warnings `"$Dir\agent.mjs`" run" -WorkingDirectory $Dir
  $trigger = New-ScheduledTaskTrigger -Daily -At $At
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName 'Sumangal dashboard agent' -Action $action -Trigger $trigger -Settings $settings -User "$env:USERDOMAIN\$env:USERNAME" -Password $plain -RunLevel Limited -Force | Out-Null
  $plain = $null
  Write-Host "  Task created. Run it now from Task Scheduler, or: & '$node' --no-warnings '$Dir\agent.mjs' run"
}
Write-Host "`nDone. Logs: $Dir\logs. The dashboard shows the data after an admin approves this agent and the first run finishes." -ForegroundColor Green
