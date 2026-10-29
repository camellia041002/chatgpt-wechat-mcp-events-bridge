param(
  [int]$Port = 8792,
  [string[]]$McpAliasPath = @(),
  [string[]]$OAuthAliasPath = @(),
  [string[]]$LegacyOAuthClientId = @()
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $ProjectRoot 'runtime'
$ConnectionFile = Join-Path $RuntimeDir 'local-connection.json'
New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null

if (Test-Path -LiteralPath $ConnectionFile) {
  $Existing = Get-Content -LiteralPath $ConnectionFile -Raw | ConvertFrom-Json
  if ($Existing.serverPid -and (Get-Process -Id $Existing.serverPid -ErrorAction SilentlyContinue)) {
    throw "The isolated transport is already running with PID $($Existing.serverPid)."
  }
}

$RouteToken = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(36)).TrimEnd('=').Replace('+','-').Replace('/','_')
$Stdout = Join-Path $RuntimeDir 'server.stdout.log'
$Stderr = Join-Path $RuntimeDir 'server.stderr.log'

$Previous = @{
  TRANSPORT_ROUTE_TOKEN = $env:TRANSPORT_ROUTE_TOKEN
  TRANSPORT_PORT = $env:TRANSPORT_PORT
  TRANSPORT_HOST = $env:TRANSPORT_HOST
  TRANSPORT_STATE_DIR = $env:TRANSPORT_STATE_DIR
  TRANSPORT_MODE = $env:TRANSPORT_MODE
  TRANSPORT_POLLING_ENABLED = $env:TRANSPORT_POLLING_ENABLED
  TRANSPORT_CHANNEL_ID = $env:TRANSPORT_CHANNEL_ID
  TRANSPORT_MCP_ALIASES = $env:TRANSPORT_MCP_ALIASES
  TRANSPORT_OAUTH_ALIASES = $env:TRANSPORT_OAUTH_ALIASES
  TRANSPORT_LEGACY_OAUTH_CLIENT_IDS = $env:TRANSPORT_LEGACY_OAUTH_CLIENT_IDS
}
try {
  $env:TRANSPORT_ROUTE_TOKEN = $RouteToken
  $env:TRANSPORT_PORT = [string]$Port
  $env:TRANSPORT_HOST = '127.0.0.1'
  $env:TRANSPORT_STATE_DIR = $RuntimeDir
  $env:TRANSPORT_MODE = 'simulation'
  $env:TRANSPORT_POLLING_ENABLED = 'false'
  $env:TRANSPORT_CHANNEL_ID = 'wechat'
  $env:TRANSPORT_MCP_ALIASES = ($McpAliasPath -join ',')
  $env:TRANSPORT_OAUTH_ALIASES = ($OAuthAliasPath -join ',')
  $env:TRANSPORT_LEGACY_OAUTH_CLIENT_IDS = ($LegacyOAuthClientId -join ',')
  $Process = Start-Process -FilePath 'node' -ArgumentList 'src/server.mjs' -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr -PassThru
} finally {
  foreach ($Name in $Previous.Keys) {
    if ($null -eq $Previous[$Name]) { Remove-Item -Path "Env:$Name" -ErrorAction SilentlyContinue }
    else { Set-Item -Path "Env:$Name" -Value $Previous[$Name] }
  }
}

$Deadline = (Get-Date).AddSeconds(10)
do {
  Start-Sleep -Milliseconds 200
  try { $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2 } catch { $Health = $null }
} until ($Health.ok -or (Get-Date) -ge $Deadline -or $Process.HasExited)

if (-not $Health.ok) { throw 'The isolated transport did not become healthy.' }

[pscustomobject]@{
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
  serverPid = $Process.Id
  port = $Port
  routeToken = $RouteToken
  localMcpUrl = "http://127.0.0.1:$Port/$RouteToken/mcp"
  mcpAliasPaths = @($McpAliasPath)
  oauthAliasPaths = @($OAuthAliasPath)
  legacyOAuthClientIds = @($LegacyOAuthClientId)
  mode = 'simulation'
} | ConvertTo-Json | Set-Content -LiteralPath $ConnectionFile -Encoding utf8

Write-Output "Isolated simulation transport is healthy on 127.0.0.1:$Port (PID $($Process.Id))."

