param(
  [switch]$SkipOpen,
  [switch]$RebuildApi,
  [switch]$UseSnapshotDb
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$localUrl = 'http://127.0.0.1:3000/'
$composeArgs = @('compose', '-f', 'docker-compose.yml')

if ($UseSnapshotDb) {
  $composeArgs += @('-f', 'docker-compose.local-snapshot.yml')
}

function Test-LocalUrlReady {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url
  )

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

Push-Location $projectRoot
try {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker Desktop is not available. Install or start Docker Desktop first.'
  }

  Write-Output 'Starting local WMS containers...'
  & docker @composeArgs up -d db redis | Out-Host

  if ($RebuildApi) {
    Write-Output 'Rebuilding and starting API container...'
    & docker @composeArgs up -d api --build | Out-Host
  } else {
    Write-Output 'Starting API container...'
    & docker @composeArgs up -d api | Out-Host
  }

  $deadline = (Get-Date).AddMinutes(2)
  while ((Get-Date) -lt $deadline) {
    if (Test-LocalUrlReady -Url $localUrl) {
      Write-Output "Local WMS is ready: $localUrl"
      if (-not $SkipOpen) {
        Write-Output 'Opening browser...'
        Start-Process $localUrl
      }
      return
    }

    Start-Sleep -Seconds 2
  }

  Write-Output 'Timed out waiting for local WMS. Current container status:'
  & docker @composeArgs ps | Out-Host
  throw "Local WMS did not become ready within 2 minutes: $localUrl"
} finally {
  Pop-Location
}
