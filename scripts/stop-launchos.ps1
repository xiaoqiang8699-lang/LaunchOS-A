$ErrorActionPreference = 'Continue'

function Test-LaunchOsRoot {
  param([string]$Path)

  return (Test-Path -LiteralPath (Join-Path $Path 'package.json')) -and
    (Test-Path -LiteralPath (Join-Path $Path 'pnpm-workspace.yaml')) -and
    (Test-Path -LiteralPath (Join-Path $Path 'docker-compose.yml'))
}

$root = (Get-Location).Path
if (-not (Test-LaunchOsRoot -Path $root)) {
  $fromScript = Split-Path -Parent $PSScriptRoot
  if (Test-LaunchOsRoot -Path $fromScript) {
    $root = $fromScript
    Set-Location -LiteralPath $root
  } else {
    Write-Host '请在 LaunchOS 根目录运行此脚本'
    exit 1
  }
}

function Stop-ListenPort {
  param([int]$Port)

  $procIds = @()
  try {
    $procIds = @(
      Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
        Select-Object -ExpandProperty OwningProcess -Unique
    )
  } catch {
    $escaped = [regex]::Escape(":$Port")
    $procIds = @(
      netstat -ano |
        Select-String -Pattern "$escaped\s+.+LISTENING\s+(\d+)\s*$" |
        ForEach-Object { [int]$_.Matches[0].Groups[1].Value } |
        Select-Object -Unique
    )
  }

  foreach ($procId in $procIds) {
    if ($procId -and $procId -gt 0) {
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Stop-RepoDevProcesses {
  $escapedRoot = [regex]::Escape($root)
  $pattern = 'apps\\web|apps/web|apps\\api|apps/api|apps\\worker|apps/worker|apps\\gateway|apps/gateway|turbo run dev|@launchos/web|@launchos/api|@launchos/worker|@launchos/gateway|next dev|nest start'
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -match $escapedRoot -and
      $_.CommandLine -match $pattern
    } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

Write-Host '停止 LaunchOS 服务 (Web / API / Worker / Gateway)...'

$pidFile = Join-Path $env:TEMP 'launchos-dev-pids.txt'
if (Test-Path -LiteralPath $pidFile) {
  Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue |
    ForEach-Object {
      $procId = 0
      if ([int]::TryParse($_.Trim(), [ref]$procId) -and $procId -gt 0) {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
      }
    }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

Stop-ListenPort -Port 3000
Stop-ListenPort -Port 3001
Stop-ListenPort -Port 8080
Stop-ListenPort -Port 8443
Stop-RepoDevProcesses

Write-Host '已停止 Web / API / Worker / Gateway'
Write-Host 'Docker 数据已保留'
