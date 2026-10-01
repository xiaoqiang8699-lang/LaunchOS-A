# Requires Administrator. Uninstalls LaunchOS Deployment Worker Windows service.
$ErrorActionPreference = 'Stop'
$serviceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $serviceDir 'launchos-deployment-worker.exe'
$serviceName = 'launchos-deployment-worker'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
  Write-Error 'Administrator privileges are required.'
}
if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
  & $exe stop
  & $exe uninstall
}
Write-Output "Uninstalled service=$serviceName"
