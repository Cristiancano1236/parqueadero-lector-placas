# Compatibilidad: delega en setup-https.ps1 (fuente unica).
# Uso: npm run certs

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
& powershell -ExecutionPolicy Bypass -File (Join-Path $here "setup-https.ps1")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
