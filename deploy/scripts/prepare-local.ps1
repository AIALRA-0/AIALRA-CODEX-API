param(
  [string]$CodexAuthDir = (Join-Path $env:USERPROFILE ".codex"),
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$deployRoot = Resolve-Path (Join-Path $scriptRoot "..")
$secretRoot = Join-Path $deployRoot "secrets"
$environmentPath = Join-Path $deployRoot "local.env"
$resolvedCodexAuthDir = Resolve-Path -LiteralPath $CodexAuthDir
$authFile = Join-Path $resolvedCodexAuthDir "auth.json"

# Stop before creating runtime secrets when the dedicated Codex login is unavailable
if (-not (Test-Path -LiteralPath $authFile -PathType Leaf)) {
  throw "Codex auth.json was not found in $resolvedCodexAuthDir. Run codex login first."
}

# Preserve existing secrets unless the operator explicitly requests replacement
if ((Test-Path -LiteralPath $secretRoot) -and -not $Force) {
  throw "The deploy/secrets directory already exists. Use -Force only when rotating every local secret."
}

# Create fresh service credentials with cryptographically secure random bytes
New-Item -ItemType Directory -Path $secretRoot -Force | Out-Null
function New-RandomBase64Url([int]$ByteCount) {
  $bytes = [byte[]]::new($ByteCount)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

# Write each secret as UTF-8 without a byte-order mark so containers receive the exact value
$utf8 = [System.Text.UTF8Encoding]::new($false)
$databasePassword = New-RandomBase64Url 32
$secrets = @{
  postgres_password = $databasePassword
  database_url = "postgresql://router:$databasePassword@postgres:5432/router"
  payload_master_key = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
  api_key_pepper = New-RandomBase64Url 48
  session_pepper = New-RandomBase64Url 48
  bootstrap_admin_token = New-RandomBase64Url 32
  internal_proxy_secret = New-RandomBase64Url 48
  edge_proxy_secret = New-RandomBase64Url 48
  runner_api_token = New-RandomBase64Url 48
  chatgpt_bridge_api_token = New-RandomBase64Url 48
  chatgpt_web_diagnostic_token = New-RandomBase64Url 48
  chatgpt_vnc_password = New-RandomBase64Url 24
}
foreach ($entry in $secrets.GetEnumerator()) {
  [IO.File]::WriteAllText((Join-Path $secretRoot $entry.Key), $entry.Value, $utf8)
}

# Generate the Compose environment with an HTTP-only local Passkey origin
$environment = @(
  "SECRETS_DIR=./secrets"
  "CODEX_AUTH_DIR=$($resolvedCodexAuthDir.Path -replace '\\', '/')"
  "CODEX_MAX_CONCURRENCY=1"
  "CHATGPT_WEB_ADAPTER_ENABLED=false"
  "CHATGPT_WEB_DIAGNOSTIC_ENABLED=false"
  "CHATGPT_WEB_MAX_CONCURRENCY=1"
  "CHATGPT_CHROMIUM_NO_SANDBOX=false"
  "CHATGPT_BROWSER_SECCOMP_PROFILE=./chatgpt-browser/chromium-seccomp.json"
  "CHATGPT_BROWSER_CONTROL_IP=10.253.240.2"
  "CHATGPT_CONTROL_SUBNET=10.253.240.0/28"
  "CHATGPT_PROXY_SUBNET=10.253.240.16/28"
  "CHATGPT_EGRESS_SUBNET=10.253.240.32/28"
  "WEBAUTHN_RP_ID=localhost"
  "WEBAUTHN_ORIGIN=http://localhost:13211"
  "SESSION_COOKIE_SECURE=false"
) -join [Environment]::NewLine
[IO.File]::WriteAllText($environmentPath, $environment, $utf8)

Write-Host "Local runtime files are ready"
Write-Host "Environment: $environmentPath"
Write-Host "Bootstrap token: $(Join-Path $secretRoot 'bootstrap_admin_token')"
