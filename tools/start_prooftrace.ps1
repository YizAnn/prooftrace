[CmdletBinding()]
param(
  [int]$Port = 8787,
  [switch]$NoBrowser,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Step([string]$Text) { Write-Host "[ProofTrace] $Text" }
function Test-PortInUse([int]$p) {
  $client = New-Object System.Net.Sockets.TcpClient
  try { $client.Connect('127.0.0.1', $p); $client.Close(); return $true }
  catch { try { $client.Close() } catch {}; return $false }
}
function Get-Health([int]$p) {
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$p/api/health" -TimeoutSec 3 -ErrorAction Stop }
  catch { return $null }
}
function Get-DiskAgentVersion {
  $file = Join-Path $root 'server\agent.js'
  if (-not (Test-Path $file)) { return '' }
  $m = Select-String -Path $file -Pattern "const AGENT_VERSION = '([^']+)'" | Select-Object -First 1
  if ($m -and $m.Matches.Count -gt 0) { return $m.Matches[0].Groups[1].Value }
  return ''
}
function Get-DiskServerVersion {
  $file = Join-Path $root 'server\server.js'
  if (-not (Test-Path $file)) { return '' }
  $m = Select-String -Path $file -Pattern "version: '([0-9.]+)'" | Select-Object -First 1
  if ($m -and $m.Matches.Count -gt 0) { return $m.Matches[0].Groups[1].Value }
  return ''
}

Write-Step '检查 Node.js ...'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Host '[ProofTrace] 未找到 Node.js。请安装 Node.js 18 或以上版本，并确保 node 在 PATH 中。' -ForegroundColor Red
  exit 1
}
$nodeVersion = (& node -v).Trim()
$major = 0
try { $major = [int](($nodeVersion.TrimStart('v') -split '\.')[0]) } catch {}
if ($major -lt 18) {
  Write-Host "[ProofTrace] 当前 Node.js 版本为 $nodeVersion，需要 18 或以上。" -ForegroundColor Red
  exit 1
}
$diskAgentVersion = Get-DiskAgentVersion
$diskServerVersion = Get-DiskServerVersion
Write-Step "Node.js $nodeVersion 可用；本机代码 服务 v$diskServerVersion / Agent v$diskAgentVersion。"

# 1) 优先复用同版本的现有服务；2) 旧版本或端口被占用时自动选择下一个端口。
$targetPort = $Port
$existing = $null
for ($p = $Port; $p -lt ($Port + 20); $p++) {
  if (-not (Test-PortInUse $p)) { $targetPort = $p; break }
  $h = Get-Health $p
  if ($h -and $h.service -eq 'prooftrace-ai-proxy') {
    $sv = [string]$h.version
    $av = ''
    if ($h.agent -and $h.agent.version) { $av = [string]$h.agent.version }
    if ($sv -eq $diskServerVersion -and $av -eq $diskAgentVersion) {
      $existing = $h
      $targetPort = $p
      break
    }
    Write-Step "端口 $p 上是旧版服务（服务 v$sv / Agent v$av），不会复用；继续查找可用端口。"
  } else {
    Write-Step "端口 $p 已被其他程序占用，继续查找可用端口。"
  }
}

if ($existing) {
  Write-Step "检测到同版本服务已在运行：http://127.0.0.1:$targetPort/ （服务 v$($existing.version) / Agent v$($existing.agent.version)），模型=$($existing.model)，configured=$($existing.configured)"
  if ($existing.configured -ne $true) {
    Write-Host '[ProofTrace] 服务已启动，但还没有模型密钥。页面会引导你完成首次配置。' -ForegroundColor Yellow
  }
  if ($CheckOnly) { exit 0 }
  if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$targetPort/" }
  Write-Step '已打开工作台。关闭服务请关闭对应的最小化 Node 窗口。'
  exit 0
}

if ($CheckOnly) {
  Write-Step "启动前检查通过；将使用端口 $targetPort（未启动服务）。"
  exit 0
}

$env:PORT = [string]$targetPort
$env:HOST = '127.0.0.1'
if ([string]::IsNullOrWhiteSpace($env:AI_API_BASE)) {
  $env:AI_API_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
}
if ([string]::IsNullOrWhiteSpace($env:AI_MODEL)) { $env:AI_MODEL = 'qwen-plus' }

Write-Step "启动本地服务（127.0.0.1:$targetPort）..."
$proc = Start-Process -FilePath $nodeCmd.Source -ArgumentList @('server/run_local.js') -WorkingDirectory $root -PassThru -WindowStyle Minimized
Remove-Item Env:PORT -ErrorAction SilentlyContinue

$health = $null
$healthy = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  $health = Get-Health $targetPort
  if ($health -and $health.ok -eq $true) { $healthy = $true; break }
}

if (-not $healthy) {
  Write-Host '[ProofTrace] 服务未在 20 秒内响应。请查看启动的最小化窗口中的 Node 错误信息。' -ForegroundColor Red
  exit 1
}

Write-Step "健康检查通过：服务 v$($health.version) / Agent v$($health.agent.version)，模型=$($health.model)，configured=$($health.configured)"
if ($health.configured -ne $true) {
  Write-Host '[ProofTrace] 首次使用：页面会要求填写一次百炼 API Key，验证通过后用 Windows DPAPI 加密保存。' -ForegroundColor Yellow
  Write-Host '[ProofTrace] 密钥不会写入页面、localStorage、日志或交付包。' -ForegroundColor Yellow
}
if (-not $NoBrowser) {
  Start-Process "http://127.0.0.1:$targetPort/"
  Write-Step '已打开工作台。'
} else {
  Write-Step "已跳过打开浏览器。地址：http://127.0.0.1:$targetPort/"
}
Write-Step '服务运行在最小化的 Node 窗口中；使用完毕后关闭该窗口即可停止服务。'
exit 0
