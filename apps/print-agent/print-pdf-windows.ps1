param(
  [Parameter(Mandatory = $true)]
  [string]$FilePath,

  [Parameter(Mandatory = $false)]
  [string]$PrinterName,

  [Parameter(Mandatory = $false)]
  [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $FilePath)) {
  throw "Print file not found: $FilePath"
}

$timeoutMs = [Math]::Max($TimeoutSeconds, 5) * 1000
if ([string]::IsNullOrWhiteSpace($PrinterName)) {
  $printerName = $null
} else {
  $printerName = $PrinterName.Trim()
}
$verbs = @()

if ($printerName) {
  $verbs += "PrintTo"
} else {
  $verbs += "Print"
}

$lastError = $null

foreach ($verb in $verbs) {
  try {
    $process = if ($verb -eq "PrintTo" -and $printerName) {
      Start-Process -FilePath $FilePath -Verb PrintTo -ArgumentList ('"{0}"' -f $printerName) -PassThru -WindowStyle Hidden
    } else {
      Start-Process -FilePath $FilePath -Verb Print -PassThru -WindowStyle Hidden
    }

    if ($process) {
      $null = $process.WaitForExit($timeoutMs)
      if (-not $process.HasExited) {
        try {
          Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        } catch {
        }
      }
      Write-Output ("windows-{0}-{1}" -f $verb.ToLowerInvariant(), $process.Id)
    } else {
      Write-Output ("windows-{0}" -f $verb.ToLowerInvariant())
    }
    exit 0
  } catch {
    $lastError = $_
  }
}

if ($lastError) {
  throw $lastError
}

throw "No Windows print verb succeeded."
