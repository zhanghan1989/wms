param(
  [Parameter(Mandatory = $false)]
  [string]$ServiceName = "WMSPrintAgent",

  [Parameter(Mandatory = $false)]
  [string]$NssmPath = "nssm.exe"
)

$ErrorActionPreference = "Stop"

$agentDir = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $agentDir "index.js"))) {
  $agentDir = Split-Path -Parent $PSScriptRoot
}
$nssm = (Get-Command $NssmPath -ErrorAction Stop).Source
$exePath = Join-Path $agentDir "wms-print-agent.exe"

if (Test-Path -LiteralPath $exePath) {
  & $nssm install $ServiceName $exePath
} else {
  $node = (Get-Command node -ErrorAction Stop).Source
  & $nssm install $ServiceName $node "$agentDir\index.js"
}
& $nssm set $ServiceName AppDirectory $agentDir
& $nssm set $ServiceName AppStdout "$agentDir\print-agent.out.log"
& $nssm set $ServiceName AppStderr "$agentDir\print-agent.err.log"
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName Start SERVICE_AUTO_START
& $nssm start $ServiceName

Write-Host "Installed and started NSSM service: $ServiceName"
Write-Host "If PDF PrintTo does not work as a service, use install-startup-task.ps1 instead."
