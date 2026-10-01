$ErrorActionPreference = 'Stop'

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

Write-Host '检查 Docker...'
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host '请先启动 Docker Desktop'
  exit 1
}

Write-Host '启动基础设施 (postgres / redis / minio)...'
docker compose up -d
if ($LASTEXITCODE -ne 0) {
  Write-Host '基础设施启动失败'
  exit 1
}

docker compose up -d --wait
if ($LASTEXITCODE -ne 0) {
  Write-Host '等待基础设施就绪失败'
  exit 1
}

Write-Host '检查数据库...'
pnpm db:verify
if ($LASTEXITCODE -ne 0) {
  Write-Host '数据库连接错误'
  exit 1
}

$pidFile = Join-Path $env:TEMP 'launchos-dev-pids.txt'
$startedPids = @()

Write-Host '启动 LaunchOS 服务...'
$devWindow = Start-Process -FilePath 'powershell.exe' -WorkingDirectory $root -PassThru -ArgumentList @(
  '-NoExit',
  '-ExecutionPolicy', 'Bypass',
  '-Command',
  "Set-Location -LiteralPath '$root'; Write-Host 'LaunchOS pnpm dev'; pnpm dev"
)
$startedPids += $devWindow.Id

Set-Content -LiteralPath $pidFile -Value ($startedPids | ForEach-Object { "$_" }) -Encoding ascii

Write-Host ''
Write-Host 'LaunchOS 已启动'
Write-Host ''
Write-Host '访问地址：'
Write-Host 'Web:'
Write-Host 'http://localhost:3000'
Write-Host ''
Write-Host 'API:'
Write-Host 'http://localhost:3001'
Write-Host ''
Write-Host 'Gateway:'
Write-Host 'http://localhost:8080'
