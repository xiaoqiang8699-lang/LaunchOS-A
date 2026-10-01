$ErrorActionPreference = 'Stop'
$taskName = 'LaunchOS-Deployment-Worker'
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Output "Removed scheduled task=$taskName"
