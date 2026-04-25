@echo off
title Dev Launcher
cd /d "%~dp0"

echo.
if not exist "node_modules" (
  echo  Instalando dependencias primera vez...
  call npm install --silent 2>nul
) else (
  echo  Dependencias ya instaladas.
)

echo.
echo  Iniciando Dev Launcher...
echo  Abrira el navegador automaticamente en http://localhost:9000
echo.

echo  Verificando puerto 9000...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$listeners = Get-NetTCPConnection -LocalPort 9000 -State Listen -ErrorAction SilentlyContinue; if ($listeners) { $listeners | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; Write-Host '  Puerto 9000 liberado.' } else { Write-Host '  Puerto 9000 libre.' }"
echo.

node server.js

pause
