param(
  [ValidateSet("unit", "smoke")]
  [string]$Mode = "unit",
  [int]$Port = 9222
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$cliPath = Join-Path $projectRoot "src\cli.js"
$workspaceRoot = Resolve-Path (Join-Path $projectRoot "..")

function Assert-Condition {
  param(
    [bool]$Condition,
    [string]$Message
  )
  if (-not $Condition) {
    throw $Message
  }
}

function Invoke-Node {
  param(
    [string[]]$CommandArgs
  )

  & node @CommandArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: node $($CommandArgs -join ' ')"
  }
}

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
    # Retry by extracting the first full JSON object from noisy output.
    $jsonBlockMatch = [regex]::Match($jsonText, '(?s)\{.*\}')
    if ($jsonBlockMatch.Success) {
      try {
        return $jsonBlockMatch.Value | ConvertFrom-Json
      } catch {
        # Continue to regex fallback below.
      }
    }

    $statusMatch = [regex]::Match($jsonText, '"status"\s*:\s*"([^"]+)"')
    $errorCodeMatch = [regex]::Match($jsonText, '"code"\s*:\s*"([^"]+)"')
    $errorMessageMatch = [regex]::Match($jsonText, '"message"\s*:\s*"([^"]+)"')
    if (-not $statusMatch.Success) {
      throw "Output is not valid JSON and status cannot be extracted. Raw output: $jsonText"
    }
    return [pscustomobject]@{
      status = $statusMatch.Groups[1].Value
      error = if ($errorCodeMatch.Success) {
        [pscustomobject]@{
          code = $errorCodeMatch.Groups[1].Value
          message = if ($errorMessageMatch.Success) { $errorMessageMatch.Groups[1].Value } else { $null }
        }
      } else {
        $null
      }
      _raw = $jsonText
    }
  }
}

function New-SmokeFiles {
  $fixturesDir = Join-Path $projectRoot ".smoke-fixtures"
  New-Item -ItemType Directory -Path $fixturesDir -Force | Out-Null

  $requestPath = Join-Path $fixturesDir "request.txt"
  $confirmationPath = Join-Path $fixturesDir "confirmation.json"
  $overridesPath = Join-Path $fixturesDir "overrides.json"

  $requestText = "Search and screen candidates on BOSS. schools: 985/211; target_count: 1000."
  Set-Content -LiteralPath $requestPath -Encoding UTF8 -Value $requestText

  $confirmationObj = [ordered]@{
    keyword_confirmed = $true
    keyword_value = [string]::Concat([char]0x6838, [char]0x8F90, [char]0x5C04)
    search_params_confirmed = $true
    criteria_confirmed = $true
    use_default_for_missing = $true
  }
  $confirmationJson = $confirmationObj | ConvertTo-Json -Depth 5
  Set-Content -LiteralPath $confirmationPath -Encoding UTF8 -Value $confirmationJson

  $overridesObj = [ordered]@{
    city = [string]::Concat([char]0x676D, [char]0x5DDE)
    degree = [string]::Concat([char]0x672C, [char]0x79D1)
    schools = @("985", "211")
    keyword = [string]::Concat([char]0x6838, [char]0x8F90, [char]0x5C04)
    filter_recent_viewed = $false
    target_count = 1000
  }
  $overridesJson = $overridesObj | ConvertTo-Json -Depth 5
  Set-Content -LiteralPath $overridesPath -Encoding UTF8 -Value $overridesJson

  Assert-Condition (Test-Path -LiteralPath $requestPath) "request file was not created: $requestPath"
  Assert-Condition (Test-Path -LiteralPath $confirmationPath) "confirmation file was not created: $confirmationPath"
  Assert-Condition (Test-Path -LiteralPath $overridesPath) "overrides file was not created: $overridesPath"

  return @{
    Request = $requestPath
    Confirmation = $confirmationPath
    Overrides = $overridesPath
  }
}

Write-Host "=== verify-multi-round-protocol ($Mode) ==="
Write-Host "Project root: $projectRoot"

Write-Host "[1/2] Running deterministic unit checks..."
Push-Location $projectRoot
try {
  Invoke-Node -CommandArgs @("src/test-parser.js")
  Invoke-Node -CommandArgs @("src/test-pipeline.js")
} finally {
  Pop-Location
}
Write-Host "[OK] unit checks passed"

if ($Mode -eq "unit") {
  Write-Host "Unit mode done."
  exit 0
}

Write-Host "[2/2] Running smoke check on real browser session..."
Write-Host "Port: $Port"
Write-Host "Workspace root: $workspaceRoot"

Invoke-Node -CommandArgs @($cliPath, "set-port", "--port", "$Port")
Invoke-Node -CommandArgs @($cliPath, "doctor", "--port", "$Port")
Invoke-Node -CommandArgs @($cliPath, "launch-chrome", "--port", "$Port")

$files = New-SmokeFiles
Write-Host "Smoke input files:"
Write-Host "  request=$($files.Request)"
Write-Host "  confirmation=$($files.Confirmation)"
Write-Host "  overrides=$($files.Overrides)"

Assert-Condition (Test-Path -LiteralPath $files.Request) "request file missing before run: $($files.Request)"
Assert-Condition (Test-Path -LiteralPath $files.Confirmation) "confirmation file missing before run: $($files.Confirmation)"
Assert-Condition (Test-Path -LiteralPath $files.Overrides) "overrides file missing before run: $($files.Overrides)"

$smoke = Invoke-JsonCommand -CommandArgs @(
  "run",
  "--workspace-root", "$workspaceRoot",
  "--instruction-file", $files.Request,
  "--confirmation-file", $files.Confirmation,
  "--overrides-file", $files.Overrides
)

Write-Host "Smoke status: $($smoke.status)"

if ($smoke.status -eq "COMPLETED") {
  $reason = $smoke.result.completion_reason
  Assert-Condition (
    ($reason -eq "processed_target_reached") -or ($reason -eq "search_exhausted_no_candidates")
  ) "Unexpected completion_reason: $reason"
  Assert-Condition ([int]$smoke.result.round_count -ge 1) "round_count should be >= 1"
  Write-Host "[OK] COMPLETED response shape is valid"
  Write-Host "completion_reason=$reason round_count=$($smoke.result.round_count)"
  Write-Host "output_csv=$($smoke.result.output_csv)"
  exit 0
}

if ($smoke.status -eq "FAILED") {
  $code = $smoke.error.code
  $message = $smoke.error.message
  $allowed = @(
    "SCREEN_NO_PROGRESS",
    "BOSS_LOGIN_REQUIRED",
    "BOSS_SEARCH_PAGE_NOT_READY",
    "SEARCH_CLI_FAILED",
    "SEARCH_TIMEOUT",
    "SEARCH_RESULT_UNVERIFIED",
    "SCREEN_CLI_FAILED",
    "SCREEN_TIMEOUT",
    "CALIBRATION_REQUIRED"
  )
  if (-not ($allowed -contains $code)) {
    $raw = if ($smoke.PSObject.Properties.Name -contains "_raw") { $smoke._raw } else { "" }
    throw "Unexpected FAILED error code: $code`nerror_message=$message`nraw=$raw"
  }
  if ($code -eq "SCREEN_NO_PROGRESS") {
    $diag = $smoke.diagnostics
    Assert-Condition ($null -ne $diag) "SCREEN_NO_PROGRESS diagnostics should exist"
    Assert-Condition ($diag.PSObject.Properties.Name -contains "output_csv") "SCREEN_NO_PROGRESS diagnostics.output_csv should exist"
  }
  Write-Host "[OK] FAILED response is actionable: $code"
  if ($message) {
    Write-Host "error_message=$message"
  }
  exit 0
}

$rawHint = if ($smoke.PSObject.Properties.Name -contains "_raw") { $smoke._raw } else { "" }
throw "Unexpected smoke status: $($smoke.status)`nRaw output: $rawHint"
