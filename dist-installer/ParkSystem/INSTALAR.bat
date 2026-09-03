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
