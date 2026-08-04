$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$artifact = Join-Path $RepoRoot "results\runs\smoke_s10\monitor-$stamp"
New-Item -ItemType Directory -Force -Path $artifact | Out-Null
$env:HEADLESS = 'true'
Push-Location $RepoRoot
try {
  npm run test:s10
  if ($LASTEXITCODE -ne 0) { Write-Warning "S-10 failed; see results/ and $artifact"; exit $LASTEXITCODE }
  Write-Output "Monitor passed"
} finally { Pop-Location }
