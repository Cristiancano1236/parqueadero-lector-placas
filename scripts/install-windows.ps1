# Instala ParkSystem en Program Files, prepara HTTPS y crea accesos directos.
# Uso (como administrador):
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -SourceRoot "C:\ruta\dist"

param(
    [string]$SourceRoot = "",
    [string]$TargetRoot = ""
)

$ErrorActionPreference = "Stop"

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not $SourceRoot) {
    $SourceRoot = Split-Path -Parent $PSScriptRoot
}
$SourceRoot = [System.IO.Path]::GetFullPath($SourceRoot)

if (-not $TargetRoot) {
    $TargetRoot = Join-Path ${env:ProgramFiles} "ParkSystem"
}
$TargetRoot = [System.IO.Path]::GetFullPath($TargetRoot)

Write-Host "=== ParkSystem - Instalador ===" -ForegroundColor Cyan
Write-Host "Origen:  $SourceRoot"
Write-Host "Destino: $TargetRoot"

if (-not (Test-IsAdmin)) {
    throw "Ejecuta INSTALAR.bat como administrador (clic derecho -> Ejecutar como administrador)."
}

$exeSrc = Join-Path $SourceRoot "parqueadero.exe"
if (-not (Test-Path $exeSrc)) {
    throw "No se encontro parqueadero.exe en $SourceRoot"
}

New-Item -ItemType Directory -Force -Path $TargetRoot | Out-Null

$items = @(
    "parqueadero.exe",
    "public",
    "tools",
    "scripts",
    "schema.sql",
    ".env.example",
    "LEEME.txt",
    "Preparar-HTTPS.bat"
)

foreach ($name in $items) {
    $src = Join-Path $SourceRoot $name
    if (-not (Test-Path $src)) { continue }
    $dst = Join-Path $TargetRoot $name
    Write-Host "Copiando $name ..."
    if (Test-Path $dst) {
        Remove-Item -Recurse -Force $dst
    }
    Copy-Item -Recurse -Force $src $dst
}

# Conservar .env existente si ya habia instalacion
$envSrc = Join-Path $SourceRoot ".env"
$envDst = Join-Path $TargetRoot ".env"
if ((Test-Path $envSrc) -and -not (Test-Path $envDst)) {
    Copy-Item $envSrc $envDst
}

$setupHttps = Join-Path $TargetRoot "scripts\setup-https.ps1"
if (-not (Test-Path $setupHttps)) {
    throw "Falta scripts\setup-https.ps1 en el destino"
}

Write-Host "Preparando HTTPS (certificados + CA de Windows) ..."
& powershell -NoProfile -ExecutionPolicy Bypass -File $setupHttps -AppRoot $TargetRoot
if ($LASTEXITCODE -ne 0) {
    throw "Falló la preparación HTTPS"
}

# Accesos directos
$Wsh = New-Object -ComObject WScript.Shell
$exePath = Join-Path $TargetRoot "parqueadero.exe"
$prepPath = Join-Path $TargetRoot "Preparar-HTTPS.bat"

$desktop = [Environment]::GetFolderPath("Desktop")
$startMenu = Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs\ParkSystem"
New-Item -ItemType Directory -Force -Path $startMenu | Out-Null

$sc1 = $Wsh.CreateShortcut((Join-Path $desktop "ParkSystem.lnk"))
$sc1.TargetPath = $exePath
$sc1.WorkingDirectory = $TargetRoot
$sc1.Description = "ParkSystem - Parqueadero"
$sc1.Save()

$sc2 = $Wsh.CreateShortcut((Join-Path $startMenu "ParkSystem.lnk"))
$sc2.TargetPath = $exePath
$sc2.WorkingDirectory = $TargetRoot
$sc2.Save()

$sc3 = $Wsh.CreateShortcut((Join-Path $startMenu "Preparar HTTPS.lnk"))
$sc3.TargetPath = $prepPath
$sc3.WorkingDirectory = $TargetRoot
$sc3.Save()

Write-Host ""
Write-Host "Instalacion lista en: $TargetRoot" -ForegroundColor Green
Write-Host "1. Edita .env si hace falta (DB_PASSWORD, etc.)."
Write-Host "2. Ejecuta schema.sql en MariaDB/MySQL si la BD no existe."
Write-Host "3. Abre ParkSystem desde el escritorio."
Write-Host "4. En el movil: http://IP-DEL-PC:3080/  (Conectar celular)."
Write-Host ""
