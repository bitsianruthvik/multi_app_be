<#
  Sumangal ERP agent: setup. Run in Windows PowerShell 5.1, signed in as the Windows user that will run the agent
  (its saved secrets can only be read by that user). No admin rights needed. See README.md.

    powershell -ExecutionPolicy Bypass -File setup.ps1
    powershell -ExecutionPolicy Bypass -File setup.ps1 -Server 192.168.1.10 -Port 1434 -User reader

  What it does: makes the agent folder, downloads the official portable Node.js (checked against nodejs.org's
  SHA-256 list) and the agent files from the dashboard, asks for the SQL Server and the login, saves the password
  encrypted (DPAPI, this user only), tests the connection, registers the agent (an admin approves it on the
  dashboard side) and creates the scheduled tasks. It changes nothing in the ERP.

  Tasks: by default they run while this user is signed in (no password, no admin right needed); a run missed while
  the PC was off starts when it is next on. Option 2 runs them signed out too, which needs this user's Windows
  password and the "Log on as a batch job" right.
#>
param(
  [string]$Api = 'https://api.ceofactory.vc',
  [string]$Company = 'sumangal',
  [string]$Dir = 'C:\SumangalDashboardAgent',
  [string]$NodeVersion = 'v22.17.0',
  [string]$Server = '',
  [string]$Port = '',
  [string]$User = '',
  [string]$At = '02:00',
  [string]$DayFrom = '08:00',
  [string]$DayUntil = '21:00'
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }

Step "This PC"
$v = [Environment]::OSVersion.Version
Write-Host "  $((Get-CimInstance Win32_OperatingSystem).Caption) ($v), $env:COMPUTERNAME, user $env:USERDOMAIN\$env:USERNAME"
if ($v.Major -lt 10 -and -not ($v.Major -eq 6 -and $v.Minor -eq 3)) { throw "This Windows is too old for the agent (it needs Windows 10/11, Server 2016 or later, or Server 2012 R2). Use another PC on the same network." }
if ($v.Major -lt 10) {
  # Server 2012 R2 / Windows 8.1 (6.3): Node 22 runs there once told to skip its own OS check.
  $env:NODE_SKIP_PLATFORM_CHECK = "1"
  [Environment]::SetEnvironmentVariable("NODE_SKIP_PLATFORM_CHECK", "1", "User")
  Write-Host "  Windows 8.1 / Server 2012 R2: Node.js runs with NODE_SKIP_PLATFORM_CHECK=1" -ForegroundColor Yellow
}
if (-not [Environment]::Is64BitOperatingSystem) { throw "The agent needs 64-bit Windows. Use another PC on the same network." }
$free = [math]::Round((Get-PSDrive ($Dir.Substring(0, 1))).Free / 1GB, 1)
Write-Host "  free disk on $($Dir.Substring(0, 2)) $free GB"
if ($free -lt 2.5) { Write-Host "  Warning: about 2.5 GB free is needed." -ForegroundColor Yellow }

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
  if (Get-Command Expand-Archive -ErrorAction SilentlyContinue) { Expand-Archive $tmp -DestinationPath "$Dir\work" -Force }
  else { Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($tmp, "$Dir\work") }  # PowerShell 4 (Server 2012 R2)
  Move-Item "$Dir\work\node-$NodeVersion-win-x64" "$Dir\node"
  Remove-Item $tmp
}
& $node --version

Step "Agent files from the dashboard"
foreach ($f in @('agent.mjs', 'build-d.mjs', 'supp.mjs', 'hist.mjs', 'build-v15.mjs', 'tables.json', 'README.md', 'run-hidden.vbs')) {
  Invoke-WebRequest "$Api/api/$Company/sumangal_dashboard/agent/files/$f" -OutFile "$Dir\$f" -UseBasicParsing
  Write-Host "  $f"
}

Step "SQL Server and the login"
$cfgFile = "$Dir\config.json"
$cfg = if (Test-Path $cfgFile) { Get-Content $cfgFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
function Ask($label, $default) { $a = Read-Host "$label [$default]"; if ([string]::IsNullOrWhiteSpace($a)) { $default } else { $a.Trim() } }
function Pick($given, $saved, $fallback) { if ($given) { $given } elseif ($saved) { $saved } else { $fallback } }
$server = Ask 'SQL Server (IP or machine name; add \INSTANCE for a named instance)' (Pick $Server $cfg.server 'localhost')
$port = Ask 'Port' (Pick $Port $cfg.port '1433')
$database = Ask 'Database' (Pick '' $cfg.database 'Casting_DB')
$auth = Ask 'Login type: sql or windows' (Pick '' $cfg.auth 'sql')
$user = Ask 'Login (for windows: DOMAIN\user)' (Pick $User $cfg.user 'dashboard_reader')
$pw = Read-Host 'Password of that login (not shown)' -AsSecureString
($pw | ConvertFrom-SecureString) | Set-Content "$Dir\sql.sec" -Encoding ASCII
$out = [ordered]@{ api = $Api; company = $Company; server = $server; port = [int]$port; database = $database; auth = $auth; user = $user; encrypt = $false; tdsVersion = '7_3_B' }
if ($cfg.agentUid) { $out.agentUid = $cfg.agentUid }
# UTF-8 WITHOUT a BOM: PowerShell 4/5 add one with -Encoding UTF8 and node's JSON.parse rejects it
[IO.File]::WriteAllText($cfgFile, ($out | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))

Step "Testing the connection (read-only)"
Push-Location $Dir
& $node --no-warnings agent.mjs test
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "The test did not pass. Check the server, the port, the login and the password, then run setup again." }

Step "Registering this agent with the dashboard"
& $node --no-warnings agent.mjs register
Pop-Location

Step "Scheduled tasks"
Write-Host "  1 = run while $env:USERNAME is signed in on this PC (no password, no admin right needed)"
Write-Host "  2 = run even when signed out (needs the Windows password and the 'Log on as a batch job' right)"
Write-Host "  n = do not create the tasks now"
$mode = Ask 'Choose' '1'
if ($mode -match '^[12]$') {
  $who = "$env:USERDOMAIN\$env:USERNAME"
  # wscript runs node with no window, so nobody sees or closes a console while signed in
  $nightAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$Dir\run-hidden.vbs`" run" -WorkingDirectory $Dir
  $dayAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$Dir\run-hidden.vbs`" day --until=$DayUntil" -WorkingDirectory $Dir
  $nightTrigger = New-ScheduledTaskTrigger -Daily -At $At
  # working hours: an update whenever the dashboard asks (opened, or "Refresh now"); Wednesday is the weekly off
  $dayTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Thursday, Friday, Saturday, Sunday -At $DayFrom
  # StartWhenAvailable: a run missed while the PC was off or nobody was signed in starts as soon as it can
  $nightSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $daySettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 15) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  if ($mode -eq '1') {
    $p = New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName 'Sumangal dashboard agent' -Action $nightAction -Trigger $nightTrigger -Settings $nightSettings -Principal $p -Force | Out-Null
    Register-ScheduledTask -TaskName 'Sumangal dashboard agent (day)' -Action $dayAction -Trigger $dayTrigger -Settings $daySettings -Principal $p -Force | Out-Null
    Write-Host "  Tasks created. They run while $env:USERNAME is signed in (locking the screen is fine; signing out stops them)."
  } else {
    $tp = Read-Host "Windows password of $who" -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($tp))
    Register-ScheduledTask -TaskName 'Sumangal dashboard agent' -Action $nightAction -Trigger $nightTrigger -Settings $nightSettings -User $who -Password $plain -RunLevel Limited -Force | Out-Null
    Register-ScheduledTask -TaskName 'Sumangal dashboard agent (day)' -Action $dayAction -Trigger $dayTrigger -Settings $daySettings -User $who -Password $plain -RunLevel Limited -Force | Out-Null
    $plain = $null
    Write-Host "  Tasks created. They run signed in or not (if they fail with a logon error, the user lacks 'Log on as a batch job')."
  }
  Write-Host "  Nightly at $At; working hours $DayFrom-$DayUntil, not Wednesdays."
}
Write-Host "`nDone. Logs: $Dir\logs. First full run by hand:  & '$node' --no-warnings '$Dir\agent.mjs' run" -ForegroundColor Green
Write-Host "The dashboard shows the data after an admin approves this agent and that run finishes." -ForegroundColor Green
