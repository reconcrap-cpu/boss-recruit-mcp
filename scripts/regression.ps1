param(
  [ValidateSet("quick", "full", "negative")]
  [string]$Mode = "quick",
  [int]$Port = 9222
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$cliPath = Join-Path $projectRoot "src\cli.js"

function Invoke-JsonCommand {
  param(
    [string[]]$CommandArgs
  )

  $raw = & node $cliPath @CommandArgs | Out-String
  $jsonText = $raw.Trim()
  if (-not $jsonText) {
    throw "Command returned empty output: node $cliPath $($CommandArgs -join ' ')"
  }
  try {
    return $jsonText | ConvertFrom-Json
  } catch {
    # Some Windows terminals may decode native UTF-8 output with legacy code page,
    # which can corrupt non-ASCII text and make ConvertFrom-Json fail.
    # Fallback to regex extraction for the few fields this regression script needs.
    $statusMatch = [regex]::Match($jsonText, '"status"\s*:\s*"([^"]+)"')
    $errorCodeMatch = [regex]::Match($jsonText, '"code"\s*:\s*"([^"]+)"')
    if (-not $statusMatch.Success) {
      throw "Output is not valid JSON and status cannot be extracted. Raw output: $jsonText"
    }
    return [pscustomobject]@{
      status = $statusMatch.Groups[1].Value
      error = if ($errorCodeMatch.Success) {
        [pscustomobject]@{
          code = $errorCodeMatch.Groups[1].Value
        }
      } else {
        $null
      }
      _raw = $jsonText
    }
  }
}

function Assert-Condition {
  param(
    [bool]$Condition,
    [string]$Message
  )
  if (-not $Condition) {
    throw $Message
  }
}

function New-TestFiles {
  $tmpDir = Join-Path $env:TEMP "boss-recruit-mcp-regression"
  New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

  $confirmationPath = Join-Path $tmpDir "confirmation.json"
  $overridesPath = Join-Path $tmpDir "overrides.json"

  @'
{
  "keyword_confirmed": true,
  "keyword_value": "algorithm",
  "search_params_confirmed": true
}
'@ | Set-Content -Encoding UTF8 $confirmationPath

  @'
{
  "city": "Hangzhou",
  "degree": "Master and above",
  "schools": ["985", "211", "qs100"],
  "keyword": "algorithm",
  "target_count": 5,
  "filter_recent_viewed": true
}
'@ | Set-Content -Encoding UTF8 $overridesPath

  return @{
    Confirmation = $confirmationPath
    Overrides = $overridesPath
  }
}

Write-Host "=== boss-recruit-mcp regression ($Mode) ==="

# Step 1: parser-level sanity check (no browser dependency)
$needInput = Invoke-JsonCommand -CommandArgs @("run", "--instruction", "find algorithm engineer")
Assert-Condition ($needInput.status -eq "NEED_INPUT") "Expected NEED_INPUT, got $($needInput.status)"
Write-Host "[OK] parser sanity check"

# Step 2: CLI JSON input robustness via file mode
$files = New-TestFiles
$fullRun = Invoke-JsonCommand -CommandArgs @(
  "run",
  "--instruction", "find candidates who did algorithms",
  "--confirmation-file", $files.Confirmation,
  "--overrides-file", $files.Overrides
)

Assert-Condition ($fullRun.status -ne "FAILED" -or $fullRun.error.code -ne "INVALID_CLI_INPUT") "Should not fail with INVALID_CLI_INPUT in file mode"
Write-Host "[OK] confirmation/overrides file mode accepted"

if ($Mode -eq "quick") {
  Write-Host "Quick mode done."
  exit 0
}

# Step 3: full/negative mode requires real Boss page + Chrome debug session
if ($Mode -eq "full") {
  Assert-Condition (
    ($fullRun.status -eq "COMPLETED") -or ($fullRun.status -eq "FAILED")
  ) "Expected COMPLETED or FAILED, got $($fullRun.status)"
  if ($fullRun.status -eq "FAILED") {
    Assert-Condition ($fullRun.error.code -ne "INVALID_CLI_INPUT") "Full mode should not fail with INVALID_CLI_INPUT"
  }
  Write-Host "[OK] full pipeline executed (COMPLETED or actionable FAILED)"
  exit 0
}

# Step 4: negative mode verifies wrong debug port does not return COMPLETED
$badOverridesPath = Join-Path $env:TEMP "boss-recruit-mcp-regression\overrides_bad_port.json"
@"
{
  "city": "Hangzhou",
  "degree": "Master and above",
  "schools": ["985", "211", "qs100"],
  "keyword": "algorithm",
  "target_count": 5,
  "filter_recent_viewed": true
}
"@ | Set-Content -Encoding UTF8 $badOverridesPath

$env:BOSS_RECRUIT_CHROME_PORT = "65530"
try {
  $negative = Invoke-JsonCommand -CommandArgs @(
    "run",
    "--instruction", "find candidates who did algorithms",
    "--confirmation-file", $files.Confirmation,
    "--overrides-file", $badOverridesPath
  )
} finally {
  Remove-Item Env:BOSS_RECRUIT_CHROME_PORT -ErrorAction SilentlyContinue
}

Assert-Condition ($negative.status -eq "FAILED") "Expected FAILED for wrong debug port, got $($negative.status)"
Assert-Condition ($negative.error.code -ne "INVALID_CLI_INPUT") "Negative mode should not fail with INVALID_CLI_INPUT"
Write-Host "[OK] wrong-port negative case"
Write-Host "Negative mode done."
