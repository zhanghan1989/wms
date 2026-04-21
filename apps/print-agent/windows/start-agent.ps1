$ErrorActionPreference = "Stop"

$agentDir = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $agentDir "index.js"))) {
  $agentDir = Split-Path -Parent $PSScriptRoot
}

Set-Location -LiteralPath $agentDir

$exePath = Join-Path $agentDir "wms-print-agent.exe"
if (Test-Path -LiteralPath $exePath) {
  & $exePath
  exit $LASTEXITCODE
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Neither wms-print-agent.exe nor Node.js was found. Copy the exe package or install Node.js LTS first."
}

node .\index.js
