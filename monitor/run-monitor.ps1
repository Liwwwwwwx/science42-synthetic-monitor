param([string]$SuiteRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$artifact = Join-Path $SuiteRoot "artifacts\monitor-$stamp"
New-Item -ItemType Directory -Force -Path $artifact | Out-Null
$env:HEADLESS = 'true'
npm --prefix $SuiteRoot run test:s10 -- --output=$artifact
if ($LASTEXITCODE -ne 0) { Write-Warning "S-10 failed; preserve artifacts at $artifact"; exit $LASTEXITCODE }
Write-Output "Monitor passed: $artifact"
