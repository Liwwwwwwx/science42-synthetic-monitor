param([string]$SuiteRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$env:MONITOR_ARTIFACT_DIR = Join-Path $SuiteRoot 'artifacts\core-monitor'
$env:SCIENCE42_STORAGE_STATE = $env:SCIENCE42_STORAGE_STATE
Push-Location $SuiteRoot
try { node monitor\core-flow-monitor.mjs } finally { Pop-Location }
