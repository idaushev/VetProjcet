@echo off
setlocal enabledelayedexpansion
:: ==========================================================
:: VetClinic - PRODUCTION server (HTTPS, LIVE database)
:: Live DB:  prod\data\vet.db   (real clinic data)
:: Frontend: prod\frontend      (deployed snapshot)
:: Update the binary + frontend via build-prod.bat in the
:: project root, then run this file.
:: ==========================================================
cd /d "%~dp0"

if not exist "backend.exe" (
    echo [ERROR] backend.exe not found in prod folder.
    echo Run build-prod.bat in the project root to compile and deploy it here.
    pause
    exit /b 1
)
if not exist "data\cert.pem" (
    echo [ERROR] TLS certificate not found: prod\data\cert.pem
    echo Copy cert.pem and key.pem into prod\data.
    pause
    exit /b 1
)

set TLS_CERT=data\cert.pem
set TLS_KEY=data\key.pem
set PORT=8443
set ENV=production
set DB_PATH=data\vet.db
set FRONTEND_DIR=frontend

echo ==========================================================
echo   VetClinic - PRODUCTION (HTTPS 8443)
echo   Database: prod\data\vet.db  (LIVE)
echo ==========================================================
echo Open on tablets (Chrome):
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /i "IPv4"') do (
    set "IP=%%A"
    set "IP=!IP: =!"
    if not "!IP!"=="" echo    https://!IP!:8443
)
echo.
echo Stop server: Ctrl+C
echo ==========================================================
echo.
.\backend.exe

pause
