#requires -Version 7
<#
  Confidential Intake Vault - one-command live demo runner (testnet).

  Runs the full agent flow end to end, capturing the contract_id from
  `register` and locking the map ACLs to it automatically.

  Usage (PowerShell 7):
      $env:T3N_DEV_KEY = "0x<your-testnet-dev-key>"
      pwsh -File scripts/demo.ps1
      # re-run after the contract is already registered:
      pwsh -File scripts/demo.ps1 -ContractId 411

  Never hardcode the key. Rotate it after recording.
#>
param(
  [int]$ContractId = 0,
  [string]$ReportId = "r1"
)

$ErrorActionPreference = "Stop"

$cli = Join-Path $PSScriptRoot "..\apps\agent-cli"
$cli = (Resolve-Path $cli).Path

# The key can come from the environment OR the gitignored apps/agent-cli/.env
# (auto-loaded by the CLI). Only hard-fail if neither is present.
if (-not $env:T3N_DEV_KEY -and -not (Test-Path (Join-Path $cli ".env"))) {
  Write-Host "ERROR: set T3N_DEV_KEY or create apps/agent-cli/.env with T3N_DEV_KEY=0x..." -ForegroundColor Red
  exit 1
}

$tsx = Join-Path $cli "node_modules\.bin\tsx.cmd"
if (-not (Test-Path $tsx)) {
  Write-Host "ERROR: tsx not found. Run 'npm install' in apps/agent-cli first." -ForegroundColor Red
  exit 1
}
Push-Location $cli
try {
  function Step([string]$title, [string[]]$cmdArgs) {
    Write-Host "`n=== $title ===" -ForegroundColor Cyan
    & $tsx src/index.ts @cmdArgs
    if ($LASTEXITCODE -ne 0) { throw "step failed: $title" }
  }

  Step "1) auth - DID + testnet" @("auth")
  Step "2) me - tenant status + quotas" @("me")
  Step "3) grant - user-signed agent delegation credential" @("grant")

  # register: capture contract_id from the output (tolerant of re-runs)
  Write-Host "`n=== 4) register - publish intake_vault.wasm ===" -ForegroundColor Cyan
  $regOut = (& $tsx src/index.ts register 2>&1 | Out-String)
  $alreadyRegistered = $regOut -match 'not higher than current version'
  if ($alreadyRegistered) {
    # Benign on a re-run: the contract is already published at this version.
    # Hide the raw HTTP 400 so the demo reads clean; show only the session info.
    ($regOut -split "`n") | Where-Object { $_ -notmatch '^ERROR:' } | ForEach-Object { Write-Host $_.TrimEnd() }
    Write-Host "(already registered at this version - reusing existing contract)" -ForegroundColor Yellow
  } else {
    Write-Host $regOut
    if ($ContractId -le 0) {
      $m = [regex]::Match($regOut, '"contract_id"\s*:\s*(\d+)')
      if ($m.Success) { $ContractId = [int]$m.Groups[1].Value }
    }
  }
  if ($ContractId -le 0) {
    throw "could not determine contract_id (already registered?). Re-run with -ContractId <int>."
  }
  Write-Host "contract_id = $ContractId" -ForegroundColor Green

  Step "5) init-maps - lock reports/summaries ACLs to the contract id" @("init-maps", "$ContractId")

  $body = '{"id":"' + $ReportId + '","title":"Auth bypass","body":"Steps to reproduce: open the login page then replay the token. contact jane@example.com phone 441234567890 passport AB1234567","severity":"high","contact":"jane@example.com"}'
  # Write to a temp file and pass via @file to dodge cmd.exe quote mangling.
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "intake-$ReportId.json"
  Set-Content -Path $tmp -Value $body -Encoding utf8
  try {
    Step "6) submit - PII in, redacted out" @("submit", "@$tmp")
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
  Step "7) summary - public redacted summary" @("summary", $ReportId)
  Step "8) score - in-enclave breakdown" @("score", $ReportId)
  Step "9) logs - submitter DID + score only, NO PII" @("logs")
  Step "10) usage - token accounting" @("usage")

  Write-Host "`nDONE." -ForegroundColor Green
  Write-Host "Privacy 'aha': step 6/7 masked the e-mail/phone/passport and never returned the raw body; step 9 logs carry only the submitter DID + score." -ForegroundColor Green
}
finally {
  Pop-Location
}
