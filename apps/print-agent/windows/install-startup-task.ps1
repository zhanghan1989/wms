param(
  [Parameter(Mandatory = $false)]
  [string]$TaskName = "WMS Print Agent"
)

$ErrorActionPreference = "Stop"

$agentDir = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $agentDir "index.js"))) {
  $agentDir = Split-Path -Parent $PSScriptRoot
}
$startScript = Join-Path $agentDir "start-agent.ps1"
if (-not (Test-Path -LiteralPath $startScript)) {
  $startScript = Join-Path $agentDir "windows\start-agent.ps1"
}

if (-not (Test-Path -LiteralPath $startScript)) {
  throw "Missing start script: $startScript"
}

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`"" `
  -WorkingDirectory $agentDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Force | Out-Null

Write-Host "Installed scheduled task: $TaskName"
Write-Host "It will start after this Windows user logs in."
Write-Host "To start now, run: Start-ScheduledTask -TaskName `"$TaskName`""
