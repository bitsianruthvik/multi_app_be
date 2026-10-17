# Karni Dashboard connector - one-time setup (no admin rights needed).
#
#   1. downloads run.ps1 next to this script
#   2. asks for the SAP password (typed here, stored encrypted for THIS Windows user)
#   3. makes a connector secret and registers it with the dashboard (it then
#      waits for an admin's approval on the Connection screen)
#
# It does NOT schedule anything: how run.ps1 is repeated is the owner's choice
# (see README.md). Re-running it is safe: it keeps the connector identity and
# asks whether to replace the stored SAP password.

param(
  [string]$ApiBase = 'https://multi-app-be-svpc.onrender.com/api/karni/karni_dashboard',
  [string]$SlUrl = 'https://10.0.0.10:50000/b1s/v1',
  [string]$CompanyDb = 'KPPL_LIVE',
  [string]$SapUser = 'manager'
)
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$CfgFile = Join-Path $Here 'config.json'

Write-Host "`nKarni Dashboard connector setup - folder $Here`n"

# 1. run.ps1
& curl.exe -s -f -o (Join-Path $Here 'run.ps1') ($ApiBase.TrimEnd('/') + '/connector/files/run.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Could not download run.ps1 from the dashboard.' }
Write-Host '[1/3] run.ps1 downloaded'

# 2. SAP password (DPAPI, this Windows user only)
$pwFile = Join-Path $Here 'sap.pw'
$ask = $true
if (Test-Path $pwFile) { $ask = (Read-Host 'A SAP password is stored. Replace it? (y/N)') -match '^[yY]' }
if ($ask) {
  $sec = Read-Host "SAP password for $SapUser" -AsSecureString
  $sec | ConvertFrom-SecureString | Set-Content $pwFile
}
Write-Host '[2/3] SAP password stored (encrypted for this Windows user)'

# 3. Connector identity + secret
if (Test-Path $CfgFile) { $cfg = Get-Content $CfgFile -Raw | ConvertFrom-Json; $uid = $cfg.connectorUid } else { $uid = [guid]::NewGuid().ToString() }
$keyFile = Join-Path $Here 'secret.key'
if (-not (Test-Path $keyFile)) {
  $bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  ConvertTo-SecureString $secret -AsPlainText -Force | ConvertFrom-SecureString | Set-Content $keyFile
} else {
  $s = Get-Content $keyFile | ConvertTo-SecureString
  $secret = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}
@{ apiBase = $ApiBase; slUrl = $SlUrl; companyDb = $CompanyDb; sapUser = $SapUser; connectorUid = $uid } |
  ConvertTo-Json | Set-Content $CfgFile -Encoding UTF8
$hash = -join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($secret)) | ForEach-Object { $_.ToString('x2') })
$secret = $null
$reg = Join-Path $env:TEMP 'kd_register.json'
[IO.File]::WriteAllText($reg, (@{ connectorUid = $uid; secretHash = $hash; machine = $env:COMPUTERNAME; winUser = "$env:USERDOMAIN\$env:USERNAME" } | ConvertTo-Json))
$res = & curl.exe -s -X POST -H 'Content-Type: application/json' --data-binary "@$reg" ($ApiBase.TrimEnd('/') + '/connector/register')
Remove-Item $reg -Force
Write-Host "[3/3] Registered with the dashboard: $res"
Write-Host "`nNext: approve the connector on the dashboard (Connection screen), then run run.ps1. Its log is $Here\connector.log`n"
