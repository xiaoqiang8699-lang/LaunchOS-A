# Configure GitHub App credentials into LaunchOS .env without printing the private key.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/configure-github-app.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/configure-github-app.ps1 -PemPath "C:\path\to\key.pem"

param(
  [string]$PemPath = ''
)

$ErrorActionPreference = 'Stop'

function Test-LaunchOsRoot {
  param([string]$Path)
  $pkg = Join-Path $Path 'package.json'
  $ws = Join-Path $Path 'pnpm-workspace.yaml'
  return (Test-Path -LiteralPath $pkg) -and (Test-Path -LiteralPath $ws)
}

$root = (Get-Location).Path
if (-not (Test-LaunchOsRoot -Path $root)) {
  $fromScript = Split-Path -Parent $PSScriptRoot
  if (Test-LaunchOsRoot -Path $fromScript) {
    $root = $fromScript
    Set-Location -LiteralPath $root
  }
  else {
    Write-Host 'Please run this script from the LaunchOS repo root.'
    exit 1
  }
}

$envPath = Join-Path $root '.env'
if (-not (Test-Path -LiteralPath $envPath)) {
  Write-Host '.env not found. Create it from .env.example first.'
  exit 1
}

if (-not $PemPath) {
  $PemPath = Read-Host 'Enter local path to GitHub App private key PEM'
}

$PemPath = $PemPath.Trim().Trim('"')
if (-not $PemPath) {
  Write-Host 'PEM path is empty.'
  exit 1
}
if (-not (Test-Path -LiteralPath $PemPath)) {
  Write-Host 'PEM file not found.'
  exit 1
}

# Read PEM locally; never print the content.
$pemRaw = [System.IO.File]::ReadAllText($PemPath)
if ($pemRaw -notmatch 'BEGIN .*PRIVATE KEY') {
  Write-Host 'PEM file does not look like a private key.'
  exit 1
}

$normalized = ($pemRaw -replace "`r`n", "`n" -replace "`r", "`n").Trim()
$escaped = $normalized.Replace('\', '\\').Replace("`n", '\n').Replace('"', '\"')

$appId = '4951692'
$appSlug = 'launchos-dev'
$callbackUrl = 'http://localhost:3000/git/github/callback'


$original = [System.IO.File]::ReadAllText($envPath)
$lines = [System.Collections.Generic.List[string]]::new()
foreach ($line in ($original -split "`r?`n", -1)) {
  [void]$lines.Add($line)
}

function Set-EnvLine {
  param(
    [System.Collections.Generic.List[string]]$InputLines,
    [string]$Key,
    [string]$Value
  )
  $pattern = '^' + [regex]::Escape($Key) + '='
  $replacement = "$Key=$Value"
  $found = $false
  for ($i = 0; $i -lt $InputLines.Count; $i++) {
    if ($InputLines[$i] -match $pattern) {
      $InputLines[$i] = $replacement
      $found = $true
      break
    }
  }
  if (-not $found) {
    if ($InputLines.Count -gt 0 -and $InputLines[$InputLines.Count - 1] -ne '') {
      [void]$InputLines.Add('')
    }
    [void]$InputLines.Add($replacement)
  }
}

Set-EnvLine -InputLines $lines -Key 'GITHUB_APP_ID' -Value $appId
Set-EnvLine -InputLines $lines -Key 'GITHUB_APP_SLUG' -Value $appSlug
Set-EnvLine -InputLines $lines -Key 'GITHUB_APP_CALLBACK_URL' -Value $callbackUrl
Set-EnvLine -InputLines $lines -Key 'GITHUB_APP_PRIVATE_KEY' -Value ('"' + $escaped + '"')

$text = ($lines -join "`n").TrimEnd() + "`n"
[System.IO.File]::WriteAllText($envPath, $text, [System.Text.UTF8Encoding]::new($false))

$pemRaw = $null
$normalized = $null
$escaped = $null
[GC]::Collect()

Write-Host ''
Write-Host 'GitHub App ID：已配置'
Write-Host 'GitHub App slug：已配置'
Write-Host 'Callback URL：已配置（本地 Web bridge）'
Write-Host '  http://localhost:3000/git/github/callback'
Write-Host 'External Alpha 请改用：'
Write-Host '  https://web-launchos.zsaos.com/git/github/callback'
Write-Host '  （见 .env.alpha.example；禁止 production fallback 到 localhost）'
Write-Host 'Private Key：已配置'
Write-Host ''
Write-Host 'PEM 未复制到项目目录；私钥未打印。'
