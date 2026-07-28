# Empaqueta una distribución portable lista para ejecutar con Node.js
# Uso: npm run build
#
# Salida: dist/parqueadero/
#   - src/, public/, models/, schema.sql, package.json, package-lock.json
#   - node_modules/ (solo producción, incluye sharp + onnxruntime-node)
#   - .env.example, iniciar.bat, LEEME.txt

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$DistRoot = Join-Path $Root "dist"
$Out = Join-Path $DistRoot "parqueadero"

Write-Host "=== Build portable ParkSystem ===" -ForegroundColor Cyan
Write-Host "Origen: $Root"
Write-Host "Destino: $Out"

# 1) Limpiar
if (Test-Path $DistRoot) {
    Write-Host "Limpiando dist/ ..."
    Remove-Item -Recurse -Force $DistRoot
}
New-Item -ItemType Directory -Force -Path $Out | Out-Null

# 2) Validar modelos OCR
$Models = Join-Path $Root "models\paddleocr\ppocr_v5_mobile"
$Required = @(
    "PP-OCRv5_mobile_det_infer.onnx",
    "PP-OCRv5_mobile_rec_infer.onnx",
    "ppocrv5_dict.txt"
)
foreach ($f in $Required) {
    $p = Join-Path $Models $f
    if (-not (Test-Path $p)) {
        Write-Host "ERROR: falta modelo OCR: $p" -ForegroundColor Red
        Write-Host "Descarga los modelos PP-OCRv5_mobile antes de compilar."
        exit 1
    }
}

# 3) Copiar código y assets
Write-Host "Copiando fuentes y assets ..."
Copy-Item -Recurse (Join-Path $Root "src") (Join-Path $Out "src")
Copy-Item -Recurse (Join-Path $Root "public") (Join-Path $Out "public")
Copy-Item -Recurse (Join-Path $Root "models") (Join-Path $Out "models")
Copy-Item (Join-Path $Root "schema.sql") (Join-Path $Out "schema.sql")
Copy-Item (Join-Path $Root "package.json") (Join-Path $Out "package.json")

if (Test-Path (Join-Path $Root "package-lock.json")) {
    Copy-Item (Join-Path $Root "package-lock.json") (Join-Path $Out "package-lock.json")
}

if (Test-Path (Join-Path $Root ".env.example")) {
    Copy-Item (Join-Path $Root ".env.example") (Join-Path $Out ".env.example")
}

# .env de desarrollo (opcional): se copia como plantilla local si no hay una en destino
if (Test-Path (Join-Path $Root ".env")) {
    Copy-Item (Join-Path $Root ".env") (Join-Path $Out ".env.example.from-dev") -ErrorAction SilentlyContinue
}

# Scripts útiles
$ScriptsOut = Join-Path $Out "scripts"
New-Item -ItemType Directory -Force -Path $ScriptsOut | Out-Null
if (Test-Path (Join-Path $Root "scripts\generar-certs.ps1")) {
    Copy-Item (Join-Path $Root "scripts\generar-certs.ps1") (Join-Path $ScriptsOut "generar-certs.ps1")
}
if (Test-Path (Join-Path $Root "scripts\crear-empresa-local.js")) {
    Copy-Item (Join-Path $Root "scripts\crear-empresa-local.js") (Join-Path $ScriptsOut "crear-empresa-local.js")
}

# 4) Instalar dependencias de producción en dist
Write-Host "Instalando dependencias de producción en dist (puede tardar) ..."
Push-Location $Out
try {
    npm install --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install falló con código $LASTEXITCODE" }
} finally {
    Pop-Location
}

# 5) iniciar.bat
$Bat = @"
@echo off
cd /d "%~dp0"
title ParkSystem - Parqueadero

if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" >nul
    echo Se creo .env desde .env.example - editalo con tu DB_PASSWORD y JWT_SECRET.
  ) else (
    echo ERROR: falta .env
    pause
    exit /b 1
  )
)

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js no esta instalado o no esta en el PATH.
  echo Instala Node.js 18+ desde https://nodejs.org
  pause
  exit /b 1
)

echo Iniciando ParkSystem...
node src\server.js
echo.
pause
"@
Set-Content -Path (Join-Path $Out "iniciar.bat") -Value $Bat -Encoding ASCII

# 6) LEEME.txt
$Leeme = @"
ParkSystem - Distribucion portable
=================================

Requisitos en el PC destino:
- Node.js 18 o superior (en PATH)
- MariaDB / MySQL con la base creada (ejecuta schema.sql)
- (Opcional) mkcert si quieres HTTPS local para la camara del celular

Primer arranque:
1. Copia esta carpeta completa al PC destino.
2. Edita .env (o parte de .env.example) con DB_* y JWT_SECRET.
3. Ejecuta schema.sql en MariaDB/MySQL si la BD no existe.
4. Doble clic en iniciar.bat  (o: node src\server.js)

HTTPS local (camara / movil):
1. En el PC: winget install FiloSottile.mkcert
2. En esta carpeta: powershell -ExecutionPolicy Bypass -File scripts\generar-certs.ps1
3. En .env pon HTTPS=true
4. Reinicia con iniciar.bat
5. En el movil instala la CA de mkcert (mkcert -CAROOT) y abre https://IP:3000

Lector de placas:
- Usa PaddleOCR en el servidor (modelos en models/paddleocr/).
- El celular solo envia el frame; el OCR no corre en el telefono.
- Menu: Lector de placas (tras iniciar sesion).

No borres:
- models/paddleocr/   (OCR)
- node_modules/       (incluye binarios nativos de sharp y onnxruntime)
- public/             (interfaz)
"@
Set-Content -Path (Join-Path $Out "LEEME.txt") -Value $Leeme -Encoding UTF8

# 7) Resumen
$Size = (Get-ChildItem $Out -Recurse -File | Measure-Object -Property Length -Sum).Sum
$SizeMb = [math]::Round($Size / 1MB, 1)
Write-Host ""
Write-Host "Build OK -> $Out" -ForegroundColor Green
Write-Host ("Tamano aproximado: {0} MB" -f $SizeMb)
Write-Host "Arranque: dist\parqueadero\iniciar.bat"
