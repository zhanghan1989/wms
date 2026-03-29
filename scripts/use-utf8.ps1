$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom
$PSDefaultParameterValues['Get-Content:Encoding'] = 'utf8'
$PSDefaultParameterValues['Select-String:Encoding'] = 'utf8'
$PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'
$PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'

Write-Output 'PowerShell text I/O defaults set to UTF-8.'
Write-Output 'Current session defaults:'
Write-Output "  Get-Content / Select-String / Set-Content / Add-Content / Out-File => utf8"
Write-Output 'Recommended usage examples:'
Write-Output "  Get-Content -Path README.md"
Write-Output "  Get-ChildItem -Recurse | Select-String -Pattern 'TODO'"
