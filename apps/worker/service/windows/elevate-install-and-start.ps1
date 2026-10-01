# Elevates and installs the LaunchOS Deployment Worker Windows service, then starts it.
$ErrorActionPreference = 'Stop'
$install = Join-Path $PSScriptRoot 'install-service.ps1'
$exe = Join-Path $PSScriptRoot 'launchos-deployment-worker.exe'

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'powershell.exe'
$psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$install`""
$psi.Verb = 'runas'
$psi.UseShellExecute = $true
$p = [System.Diagnostics.Process]::Start($psi)
if (-not $p) { throw 'Elevation cancelled' }
$p.WaitForExit()
if ($p.ExitCode -ne 0) { throw "install-service exited $($p.ExitCode)" }

Start-Sleep -Seconds 1
Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  "Start-Service launchos-deployment-worker; Get-Service launchos-deployment-worker | Format-List Status,Name,StartType"
)
Write-Output 'elevate-install-and-start done'
