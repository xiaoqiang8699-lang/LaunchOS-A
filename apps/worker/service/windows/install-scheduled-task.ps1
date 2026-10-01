# Registers a long-running Scheduled Task for the Deployment Worker.
# Preferred on this host because LocalSystem Windows Service cannot start node.exe (0xC0000142).
$ErrorActionPreference = 'Stop'
$taskName = 'LaunchOS-Deployment-Worker'
$cmd = 'D:\launchos-zidonghua\apps\worker\service\windows\run-deployment-worker.cmd'
$workerDir = 'D:\launchos-zidonghua\apps\worker'

if (-not (Test-Path (Join-Path $workerDir 'dist\main.js'))) {
  throw 'Missing dist/main.js — build the worker first'
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute $cmd -WorkingDirectory $workerDir
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartOnIdle:$false
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $triggerLogon `
  -Settings $settings `
  -Principal $principal `
  -Description 'LaunchOS deployment worker (WORKER_PROFILE=deployment). Auto-restart on crash. Single instance.' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
Get-ScheduledTask -TaskName $taskName | Format-List TaskName, State
Get-ScheduledTaskInfo -TaskName $taskName | Format-List LastRunTime, LastTaskResult, NumberOfMissedRuns
Write-Output "Registered task=$taskName"
Write-Output 'WORKER_PROFILE=deployment'
Write-Output "workingDirectory=$workerDir"
Write-Output 'restart=supervisor loop 10s + task RestartInterval 1m x999; MultipleInstances=IgnoreNew; AtLogOn'
