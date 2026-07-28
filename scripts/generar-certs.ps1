# Genera certificados HTTPS locales con mkcert (localhost + IP LAN)
# Uso: npm run certs

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$CertsDir = Join-Path $Root "certs"

function Get-LanIpv4 {
    $candidates = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -notlike "127.*" -and
            $_.PrefixOrigin -ne "WellKnown" -and
            ($_.AddressState -eq "Preferred" -or -not $_.AddressState)
        } |
        Sort-Object -Property InterfaceMetric, SkipAsSource

    if ($candidates) {
        return $candidates[0].IPAddress
    }

    # Fallback
    $ip = (Get-NetIPConfiguration | Where-Object { $_.IPv4Address -and $_.NetAdapter.Status -eq "Up" } |
        Select-Object -First 1).IPv4Address.IPAddress
    return $ip
}

Write-Host "=== Generar certificados HTTPS locales ===" -ForegroundColor Cyan

$mkcert = Get-Command mkcert -ErrorAction SilentlyContinue
if (-not $mkcert) {
    Write-Host "ERROR: mkcert no está instalado." -ForegroundColor Red
    Write-Host "Instálalo con una de estas opciones:"
    Write-Host "  winget install FiloSottile.mkcert"
    Write-Host "  choco install mkcert"
    Write-Host "  scoop install mkcert"
    Write-Host "Luego vuelve a ejecutar: npm run certs"
    exit 1
}

if (-not (Test-Path $CertsDir)) {
    New-Item -ItemType Directory -Path $CertsDir | Out-Null
}

Write-Host "Instalando CA local de mkcert (puede pedir permisos)..."
& mkcert -install
if ($LASTEXITCODE -ne 0) {
    throw "Falló mkcert -install"
}

$lanIp = Get-LanIpv4
$hosts = @("localhost", "127.0.0.1")
if ($lanIp) {
    $hosts += $lanIp
    Write-Host "IP LAN detectada: $lanIp"
} else {
    Write-Host "No se detectó IP LAN; se generará solo para localhost." -ForegroundColor Yellow
}

$certOut = Join-Path $CertsDir "dev-cert.pem"
$keyOut = Join-Path $CertsDir "dev-key.pem"

Push-Location $CertsDir
try {
    Write-Host ("Generando certificado para: " + ($hosts -join ", "))
    & mkcert -cert-file "dev-cert.pem" -key-file "dev-key.pem" @hosts
    if ($LASTEXITCODE -ne 0) {
        throw "Falló la generación del certificado"
    }
} finally {
    Pop-Location
}

if (-not (Test-Path $certOut) -or -not (Test-Path $keyOut)) {
    throw "No se generaron los archivos en certs/"
}

Write-Host ""
Write-Host "Listo:" -ForegroundColor Green
Write-Host "  $certOut"
Write-Host "  $keyOut"
Write-Host ""
Write-Host "Siguiente: npm start  (o npm run dev)"
Write-Host "Móvil: instala la CA de mkcert (mkcert -CAROOT → rootCA.pem) en el teléfono."
$caRoot = & mkcert -CAROOT
Write-Host "CA root en: $caRoot"
