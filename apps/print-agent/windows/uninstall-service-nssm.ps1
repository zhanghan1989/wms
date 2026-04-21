param(
  [Parameter(Mandatory = $false)]
  [string]$ServiceName = "WMSPrintAgent",

  [Parameter(Mandatory = $false)]
  [string]$NssmPath = "nssm.exe"
)

$ErrorActionPreference = "Stop"

$nssm = (Get-Command $NssmPath -ErrorAction Stop).Source
& $nssm stop $ServiceName
& $nssm remove $ServiceName confirm

Write-Host "Removed NSSM service: $ServiceName"
