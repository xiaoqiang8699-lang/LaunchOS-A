# Requires Administrator.
# Installs LaunchOS Deployment Worker as a Windows service via WinSW.
$ErrorActionPreference = 'Stop'

$serviceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$workerDir = Resolve-Path (Join-Path $serviceDir '..\..')
$repoRoot = Resolve-Path (Join-Path $workerDir '..\..')
$exe = Join-Path $serviceDir 'launchos-deployment-worker.exe'
$xml = Join-Path $serviceDir 'launchos-deployment-worker.xml'
$serviceName = 'launchos-deployment-worker'
$node = (Get-Command node).Source

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
  Write-Error 'Administrator privileges are required to install the Windows service.'
}

if (-not (Test-Path (Join-Path $workerDir 'dist\main.js'))) {
  Write-Error 'Missing apps/worker/dist/main.js. Run: pnpm --filter @launchos/worker build'
}

# Refresh XML absolute paths for this machine.
$xmlContent = @"
<service>
  <id>$serviceName</id>
  <name>LaunchOS Deployment Worker</name>
  <description>LaunchOS managed-hosting deployment worker. Profile=deployment. Consumes deploymentQueue and systemCertQueue only.</description>
  <executable>$node</executable>
  <arguments>dist/main.js</arguments>
  <workingdirectory>$workerDir</workingdirectory>
  <env name="WORKER_PROFILE" value="deployment" />
  <env name="NODE_ENV" value="production" />
  <logpath>$(Join-Path $workerDir 'logs')</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <onfailure action="restart" delay="60 sec" />
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>60 sec</stoptimeout>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
</service>
"@
Set-Content -Path $xml -Value $xmlContent -Encoding UTF8
New-Item -ItemType Directory -Force -Path (Join-Path $workerDir 'logs') | Out-Null

# Stop any prior service registration.
if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
  & $exe stop 2>$null
  Start-Sleep -Seconds 2
  & $exe uninstall 2>$null
  Start-Sleep -Seconds 1
}

& $exe install
if ($LASTEXITCODE -ne 0) {
  Write-Error "WinSW install failed with exit code $LASTEXITCODE"
}

Write-Output "Installed service=$serviceName"
Write-Output "workingDirectory=$workerDir"
Write-Output "executable=$node dist/main.js"
Write-Output "WORKER_PROFILE=deployment"
Write-Output "envFiles=apps/worker/.env (optional) + repo .env via dotenv (not copied into service XML)"
