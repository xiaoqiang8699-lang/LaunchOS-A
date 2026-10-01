# Requires Administrator. Reinstalls service using ASCII junction path.
$ErrorActionPreference = 'Stop'
$serviceDir = 'D:\launchos-zidonghua\apps\worker\service\windows'
$workerDir = 'D:\launchos-zidonghua\apps\worker'
$exe = Join-Path $serviceDir 'launchos-deployment-worker.exe'
$xml = Join-Path $serviceDir 'launchos-deployment-worker.xml'
$serviceName = 'launchos-deployment-worker'
$node = (Get-Command node).Source
$logs = Join-Path $workerDir 'logs'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) { throw 'Administrator required' }

New-Item -ItemType Directory -Force -Path $logs | Out-Null

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
  <env name="PATH" value="C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem;D:\Program Files (x86)\node" />
  <env name="SystemRoot" value="C:\Windows" />
  <logpath>$logs</logpath>
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

if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
  & $exe stop 2>$null
  Start-Sleep -Seconds 2
  & $exe uninstall 2>$null
  Start-Sleep -Seconds 1
}

& $exe install
if ($LASTEXITCODE -ne 0) { throw "install failed $LASTEXITCODE" }
Start-Service $serviceName
Start-Sleep -Seconds 3
Get-Service $serviceName | Format-List Name, Status, StartType
Get-Content (Join-Path $logs 'launchos-deployment-worker.wrapper.log') -Tail 20
Get-Content (Join-Path $logs 'launchos-deployment-worker.out.log') -Tail 30 -ErrorAction SilentlyContinue
Get-Content (Join-Path $logs 'launchos-deployment-worker.err.log') -Tail 30 -ErrorAction SilentlyContinue
