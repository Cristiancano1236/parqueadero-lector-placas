@echo off
cd /d "%~dp0"
title ParkSystem - Preparar HTTPS
echo Ejecutando setup-https.ps1 (se recomienda Ejecutar como administrador)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-https.ps1" -AppRoot "%~dp0"
echo.
pause
