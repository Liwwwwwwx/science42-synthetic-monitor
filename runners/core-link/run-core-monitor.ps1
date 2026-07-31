$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$env:MONITOR_ARTIFACT_DIR = Join-Path $RepoRoot 'results\runs\core_link'
Push-Location $RepoRoot
try { node --env-file=.env runners\core-link\core-flow-monitor.mjs } finally { Pop-Location }
