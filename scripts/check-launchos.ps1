$ErrorActionPreference = 'Continue'

function Test-LaunchOsRoot {
  param([string]$Path)

  return (Test-Path -LiteralPath (Join-Path $Path 'package.json')) -and
    (Test-Path -LiteralPath (Join-Path $Path 'pnpm-workspace.yaml')) -and
    (Test-Path -LiteralPath (Join-Path $Path 'docker-compose.yml'))
}

function Test-ListenPort {
  param([int]$Port)

  try {
    $found = @(
      Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
    )
    return $found.Count -gt 0
  } catch {
    $escaped = [regex]::Escape(":$Port")
    $hit = netstat -ano | Select-String -Pattern "$escaped\s+.+LISTENING\s+\d+\s*$"
    return $null -ne $hit
  }
}

function Get-ContainerStatus {
  param(
    [string[]]$Lines,
    [string]$Keyword
  )

  foreach ($line in $Lines) {
    $parts = $line.Split('|')
    if ($parts.Count -lt 2) {
      continue
    }
    $name = $parts[0].ToLowerInvariant()
    $image = if ($parts.Count -ge 3) { $parts[2].ToLowerInvariant() } else { '' }
    $status = $parts[1]
    if (("$name $image") -match $Keyword) {
      return @{
        Found = $true
        Running = ($status -match 'Up')
        Status = $status
      }
    }
  }

  return @{
    Found = $false
    Running = $false
    Status = '未运行'
  }
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

$okRoot = $true
$okDocker = $false
$okPostgres = $false
$okRedis = $false
$okMinio = $false
$okWeb = $false
$okApi = $false
$okGateway = $false
$missing = @()

Write-Host 'LaunchOS 环境检查'
Write-Host ''

Write-Host '1. 当前目录'
Write-Host '   已确认是 LaunchOS 根目录'
Write-Host ''

Write-Host '2. Docker'
docker info *> $null
if ($LASTEXITCODE -eq 0) {
  $okDocker = $true
  Write-Host '   Docker运行正常'
} else {
  Write-Host '   Docker未启动'
  $missing += 'Docker'
}
Write-Host ''

$containerLines = @()
if ($okDocker) {
  $raw = docker ps --format '{{.Names}}|{{.Status}}|{{.Image}}' 2>$null
  if ($LASTEXITCODE -eq 0 -and $raw) {
    $containerLines = @($raw)
  }
}

$postgres = Get-ContainerStatus -Lines $containerLines -Keyword 'postgres'
$redis = Get-ContainerStatus -Lines $containerLines -Keyword 'redis'
$minio = Get-ContainerStatus -Lines $containerLines -Keyword 'minio'
$okPostgres = [bool]$postgres.Running
$okRedis = [bool]$redis.Running
$okMinio = [bool]$minio.Running

Write-Host '3. PostgreSQL'
if ($okPostgres) {
  Write-Host ("   正常 ({0})" -f $postgres.Status)
} else {
  Write-Host ("   没有启动 ({0})" -f $postgres.Status)
  $missing += 'PostgreSQL'
}
Write-Host ''

Write-Host '4. Redis'
if ($okRedis) {
  Write-Host ("   正常 ({0})" -f $redis.Status)
} else {
  Write-Host ("   没有启动 ({0})" -f $redis.Status)
  $missing += 'Redis'
}
Write-Host ''

Write-Host '5. MinIO'
if ($okMinio) {
  Write-Host ("   正常 ({0})" -f $minio.Status)
} else {
  Write-Host ("   没有启动 ({0})" -f $minio.Status)
  $missing += 'MinIO'
}
Write-Host ''

if ($okDocker) {
  pnpm db:verify *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host '   数据库连接异常，PostgreSQL 可能未就绪'
    if ($okPostgres -and ($missing -notcontains 'PostgreSQL')) {
      $missing += 'PostgreSQL'
      $okPostgres = $false
    }
  }
}

Write-Host '6. Web 端口 3000'
$okWeb = Test-ListenPort -Port 3000
if ($okWeb) {
  Write-Host '   Web: 已监听 http://localhost:3000'
} else {
  Write-Host '   Web: 未监听 3000'
  $missing += 'Web'
}
Write-Host ''

Write-Host '7. API 端口 3001'
$okApi = Test-ListenPort -Port 3001
if ($okApi) {
  Write-Host '   API: 已监听 http://localhost:3001'
} else {
  Write-Host '   API: 未监听 3001'
  $missing += 'API'
}
Write-Host ''

Write-Host '8. Gateway 端口 8080'
$okGateway = Test-ListenPort -Port 8080
if ($okGateway) {
  Write-Host '   Gateway: 已监听 http://localhost:8080'
} else {
  Write-Host '   Gateway: 未监听 8080'
  $missing += 'Gateway'
}
Write-Host ''

Write-Host '检查报告'
Write-Host ''

function Write-SummaryItem {
  param([bool]$Ok, [string]$Name)
  if ($Ok) {
    Write-Host ("✓ {0}" -f $Name)
  } else {
    Write-Host ("✗ {0}  没有启动" -f $Name)
  }
}

Write-SummaryItem -Ok $okRoot -Name '当前目录'
Write-SummaryItem -Ok $okDocker -Name 'Docker'
Write-SummaryItem -Ok $okPostgres -Name 'PostgreSQL'
Write-SummaryItem -Ok $okRedis -Name 'Redis'
Write-SummaryItem -Ok $okMinio -Name 'MinIO'
Write-SummaryItem -Ok $okWeb -Name 'Web'
Write-SummaryItem -Ok $okApi -Name 'API'
Write-SummaryItem -Ok $okGateway -Name 'Gateway'
Write-Host ''

if ($missing.Count -eq 0) {
  Write-Host '全部正常。'
  exit 0
}

Write-Host '以下服务没有启动：'
foreach ($item in $missing) {
  Write-Host ("- {0}" -f $item)
}
exit 1
