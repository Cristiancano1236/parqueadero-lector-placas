# Prepara HTTPS local para ParkSystem (instalador o manual).
# Uso:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-https.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\setup-https.ps1 -AppRoot "C:\Program Files\ParkSystem"
#
# Usa tools\mkcert.exe si existe; si no, mkcert del PATH.

param(
    [string]$AppRoot = ""
)

$ErrorActionPreference = "Stop"

if (-not $AppRoot) {
    $AppRoot = Split-Path -Parent $PSScriptRoot
}
$AppRoot = [System.IO.Path]::GetFullPath($AppRoot)
$CertsDir = Join-Path $AppRoot "certs"
$CaRoot = Join-Path $CertsDir "ca"
$ToolsMkcert = Join-Path $AppRoot "tools\mkcert.exe"
$EnvFile = Join-Path $AppRoot ".env"
$EnvExample = Join-Path $AppRoot ".env.example"

function Get-LanIpv4List {
    $ips = @()
    $candidates = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -notlike "127.*" -and
            $_.PrefixOrigin -ne "WellKnown" -and
            ($_.AddressState -eq "Preferred" -or -not $_.AddressState)
        } |
        Sort-Object -Property InterfaceMetric, SkipAsSource

    foreach ($c in $candidates) {
        if ($c.IPAddress -and ($ips -notcontains $c.IPAddress)) {
            $ips += $c.IPAddress
        }
    }

    if ($ips.Count -eq 0) {
        $cfg = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
            Where-Object { $_.IPv4Address -and $_.NetAdapter.Status -eq "Up" } |
            Select-Object -First 3
        foreach ($item in $cfg) {
            $ip = $item.IPv4Address.IPAddress
            if ($ip -and ($ips -notcontains $ip)) { $ips += $ip }
        }
    }
    return $ips
}

function Resolve-Mkcert {
    if (Test-Path $ToolsMkcert) {
        return $ToolsMkcert
    }
    $cmd = Get-Command mkcert -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }
    return $null
}

function Set-HttpsEnvFlag {
    if (-not (Test-Path $EnvFile)) {
        if (Test-Path $EnvExample) {
            Copy-Item $EnvExample $EnvFile
            Write-Host "Se creo .env desde .env.example"
        } else {
            @"
PORT=3000
HTTPS=true
PORT_SETUP=3080
JWT_SECRET=cambiar_este_secreto_local
APP_ENCRYPTION_KEY=cambiar_esta_clave_de_cifrado
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=parqueadero
"@ | Set-Content -Path $EnvFile -Encoding UTF8
            Write-Host "Se creo .env basico"
        }
    }

    $lines = Get-Content $EnvFile
    $foundHttps = $false
    $foundSetup = $false
    $out = foreach ($line in $lines) {
        if ($line -match '^\s*HTTPS\s*=') {
            $foundHttps = $true
            "HTTPS=true"
        } elseif ($line -match '^\s*PORT_SETUP\s*=') {
            $foundSetup = $true
            "PORT_SETUP=3080"
        } else {
            $line
        }
    }
    if (-not $foundHttps) { $out += "HTTPS=true" }
    if (-not $foundSetup) { $out += "PORT_SETUP=3080" }
    $out | Set-Content -Path $EnvFile -Encoding UTF8
}

Write-Host "=== ParkSystem: preparar HTTPS ===" -ForegroundColor Cyan
Write-Host "AppRoot: $AppRoot"

$mkcert = Resolve-Mkcert
if (-not $mkcert) {
    Write-Host "ERROR: no se encontro mkcert." -ForegroundColor Red
    Write-Host "Coloca tools\mkcert.exe junto a la app o instala mkcert en el PATH."
    exit 1
}
Write-Host "mkcert: $mkcert"

New-Item -ItemType Directory -Force -Path $CertsDir | Out-Null
New-Item -ItemType Directory -Force -Path $CaRoot | Out-Null

$env:CAROOT = $CaRoot
Write-Host "CAROOT: $CaRoot"
Write-Host "Instalando CA en el almacén de Windows (puede pedir permisos de administrador)..."
& $mkcert -install
if ($LASTEXITCODE -ne 0) {
    throw "Falló mkcert -install (ejecuta como administrador)"
}

$lanIps = @(Get-LanIpv4List)
$hosts = @("localhost", "127.0.0.1")
foreach ($ip in $lanIps) {
    $hosts += $ip
    Write-Host "IP LAN: $ip"
}
if ($lanIps.Count -eq 0) {
    Write-Host "No se detectó IP LAN; certificado solo para localhost." -ForegroundColor Yellow
}

$certOut = Join-Path $CertsDir "dev-cert.pem"
$keyOut = Join-Path $CertsDir "dev-key.pem"
$rootCaSrc = Join-Path $CaRoot "rootCA.pem"
$rootCaPub = Join-Path $CertsDir "rootCA.pem"

Push-Location $CertsDir
try {
    Write-Host ("Generando certificado para: " + ($hosts -join ", "))
    & $mkcert -cert-file "dev-cert.pem" -key-file "dev-key.pem" @hosts
    if ($LASTEXITCODE -ne 0) {
        throw "Falló la generación del certificado"
    }
} finally {
    Pop-Location
}

if (-not (Test-Path $certOut) -or -not (Test-Path $keyOut)) {
    throw "No se generaron certs/dev-cert.pem o certs/dev-key.pem"
}
if (-not (Test-Path $rootCaSrc)) {
    throw "No se encontro rootCA.pem en CAROOT"
}

Copy-Item -Force $rootCaSrc $rootCaPub
Set-HttpsEnvFlag

Write-Host ""
Write-Host "Listo:" -ForegroundColor Green
Write-Host "  $certOut"
Write-Host "  $keyOut"
Write-Host "  $rootCaPub"
Write-Host "  .env -> HTTPS=true"
Write-Host ""
Write-Host "Reinicia parqueadero.exe y en el movil abre http://IP:3080 para instalar la CA."
