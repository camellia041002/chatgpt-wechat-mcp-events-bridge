$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ConnectionFile = Join-Path $ProjectRoot 'runtime\local-connection.json'
if (-not (Test-Path -LiteralPath $ConnectionFile)) {
  Write-Output 'No isolated local connection record exists.'
  exit 0
}
$Connection = Get-Content -LiteralPath $ConnectionFile -Raw | ConvertFrom-Json
$Process = Get-Process -Id $Connection.serverPid -ErrorAction SilentlyContinue
if ($Process) {
  Stop-Process -Id $Process.Id
  $Process.WaitForExit(5000)
}
Remove-Item -LiteralPath $ConnectionFile -Force
Write-Output 'Stopped only the recorded isolated local transport process.'

