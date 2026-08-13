# Empaqueta ParkSystem como .exe (pkg) + mkcert + INSTALAR.bat (sin Inno Setup).
# Uso: npm run build

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$DistRoot = Join-Path $Root "dist"
$DistInstaller = Join-Path $Root "dist-installer"
$ExePath = Join-Path $DistRoot "parqueadero.exe"
$MkcertUrl = "https://dl.filippo.io/mkcert/latest?for=windows/amd64"

Write-Host "=== Build .exe ParkSystem (pkg) ===" -ForegroundColor Cyan
Write-Host "Origen: $Root"
Write-Host "Destino: $DistRoot"

# 1) Limpiar
if (Test-Path $DistRoot) {
    Write-Host "Limpiando dist/ ..."
    Remove-Item -Recurse -Force $DistRoot
}
New-Item -ItemType Directory -Force -Path $DistRoot | Out-Null

# 2) Empaquetar con pkg
Write-Host "Ejecutando pkg (puede tardar la primera vez) ..."
Push-Location $Root
try {
    npx --yes pkg . --public --target node18-win-x64 --output $ExePath
    if ($LASTEXITCODE -ne 0) { throw "pkg falló con código $LASTEXITCODE" }
} finally {
    Pop-Location
}

if (-not (Test-Path $ExePath)) {
    throw "No se generó $ExePath"
}

# 3) Archivos junto al .exe
Write-Host "Copiando public/, schema.sql y .env.example ..."
Copy-Item -Recurse (Join-Path $Root "public") (Join-Path $DistRoot "public")
Copy-Item (Join-Path $Root "schema.sql") (Join-Path $DistRoot "schema.sql")
if (Test-Path (Join-Path $Root ".env.example")) {
    Copy-Item (Join-Path $Root ".env.example") (Join-Path $DistRoot ".env.example")
}

$ScriptsOut = Join-Path $DistRoot "scripts"
New-Item -ItemType Directory -Force -Path $ScriptsOut | Out-Null
Copy-Item (Join-Path $Root "scripts\setup-https.ps1") (Join-Path $ScriptsOut "setup-https.ps1")
Copy-Item (Join-Path $Root "scripts\generar-certs.ps1") (Join-Path $ScriptsOut "generar-certs.ps1")
Copy-Item (Join-Path $Root "scripts\install-windows.ps1") (Join-Path $ScriptsOut "install-windows.ps1")

# 4) mkcert portable
$ToolsOut = Join-Path $DistRoot "tools"
New-Item -ItemType Directory -Force -Path $ToolsOut | Out-Null
$MkcertOut = Join-Path $ToolsOut "mkcert.exe"
Write-Host "Descargando mkcert (Windows amd64) ..."
try {
    Invoke-WebRequest -Uri $MkcertUrl -OutFile $MkcertOut -UseBasicParsing
} catch {
    throw "No se pudo descargar mkcert desde $MkcertUrl : $($_.Exception.Message)"
}
if (-not (Test-Path $MkcertOut) -or (Get-Item $MkcertOut).Length -lt 100000) {
    throw "mkcert.exe descargado parece inválido"
}
Write-Host ("mkcert OK ({0:N1} MB)" -f ((Get-Item $MkcertOut).Length / 1MB))

# 5) Preparar-HTTPS.bat
$PrepBat = @"
@echo off
cd /d "%~dp0"
title ParkSystem - Preparar HTTPS
echo Ejecutando setup-https.ps1 (se recomienda Ejecutar como administrador)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-https.ps1" -AppRoot "%~dp0"
echo.
pause
"@
Set-Content -Path (Join-Path $DistRoot "Preparar-HTTPS.bat") -Value $PrepBat -Encoding ASCII

# 6) INSTALAR.bat (pide admin, copia a Program Files, HTTPS, accesos directos)
$InstallBat = @"
@echo off
cd /d "%~dp0"
title ParkSystem - Instalar
:: Re-lanzar como administrador si hace falta
net session >nul 2>&1
if %errorLevel% neq 0 (
  echo Solicitando permisos de administrador...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo Instalando ParkSystem...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1" -SourceRoot "%~dp0"
if errorlevel 1 (
  echo.
  echo La instalacion fallo.
  pause
  exit /b 1
)
echo.
echo Listo. Puedes iniciar ParkSystem desde el escritorio.
pause
"@
Set-Content -Path (Join-Path $DistRoot "INSTALAR.bat") -Value $InstallBat -Encoding ASCII

# 7) LEEME.txt
$Leeme = @"
ParkSystem - Distribucion Windows
=================================

Requisitos:
- Windows 64 bits
- MariaDB / MySQL (ejecuta schema.sql)
- Internet (Gemini AI para el lector de placas)
- NO hace falta instalar Node.js ni programas extras

Instalacion (recomendado):
1. Copia esta carpeta al PC destino (o descomprime el ZIP).
2. Clic derecho en INSTALAR.bat -> Ejecutar como administrador.
3. Edita .env en Program Files\ParkSystem si hace falta (DB_PASSWORD).
4. Abre ParkSystem desde el escritorio.
5. En el movil: http://IP-DEL-PC:3080/ (Conectar celular) e instala la CA.
6. Configura la API Key de Gemini en Configuracion.

Uso portable (sin instalar):
1. Ejecuta Preparar-HTTPS.bat como administrador.
2. Doble clic en parqueadero.exe

Si cambia la IP WiFi del PC:
- Ejecuta Preparar-HTTPS.bat
- No hace falta reinstalar la CA en el movil

No borres: parqueadero.exe, public/, tools/, scripts/, INSTALAR.bat
"@
Set-Content -Path (Join-Path $DistRoot "LEEME.txt") -Value $Leeme -Encoding UTF8

# 8) ZIP para repartir (solo PowerShell integrado en Windows)
Write-Host "Generando ZIP de distribucion ..."
if (Test-Path $DistInstaller) {
    Remove-Item -Recurse -Force $DistInstaller
}
New-Item -ItemType Directory -Force -Path $DistInstaller | Out-Null
$ZipPath = Join-Path $DistInstaller "ParkSystem.zip"
if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
Compress-Archive -Path (Join-Path $DistRoot "*") -DestinationPath $ZipPath -CompressionLevel Optimal
Write-Host "ZIP OK -> dist-installer\ParkSystem.zip" -ForegroundColor Green

# 9) Resumen
$ExeSizeMb = [math]::Round((Get-Item $ExePath).Length / 1MB, 1)
$ZipSizeMb = [math]::Round((Get-Item $ZipPath).Length / 1MB, 1)
Write-Host ""
Write-Host "Build OK -> $ExePath" -ForegroundColor Green
Write-Host ("Tamano del .exe: {0} MB  |  ZIP: {1} MB" -f $ExeSizeMb, $ZipSizeMb)
Write-Host "Para el cliente: dist-installer\ParkSystem.zip  ->  INSTALAR.bat (como admin)"
Write-Host "Arranque directo: dist\parqueadero.exe  |  HTTPS: dist\Preparar-HTTPS.bat"
