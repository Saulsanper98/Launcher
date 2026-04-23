@echo off
title Dev Launcher
cd /d "%~dp0"

echo.
echo  Instalando dependencias (primera vez)...
call npm install --silent 2>nul

echo.
echo  Iniciando Dev Launcher...
echo  Abrira el navegador automaticamente en http://localhost:9000
echo.

node server.js

pause
