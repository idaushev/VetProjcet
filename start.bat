@echo off
setlocal enabledelayedexpansion
:: ==========================================================
:: VetClinic - TEST / DEV server (HTTPS, TEST database)
:: Uses a SEPARATE test database (data\vet-test.db) so you can
:: fill it with fake data without touching the live clinic data
:: (which lives in prod\data\vet.db - launch via prod\start.bat).
::
:: Runs on port 8444 so it can stay up ALONGSIDE production (8443).
:: Same TLS certificate as production: a certificate covers host
:: names and IPs, not ports, so one cert serves both servers and
:: the tablet trusts them both after installing rootCA.pem once.
:: ==========================================================
cd /d "%~dp0"

if not exist "backend.exe" (
    echo [SETUP] Building backend.exe...
    go build -o backend.exe .\backend\
    if errorlevel 1 (
        echo [ERROR] Build failed.
        pause
        exit /b 1
    )
)

if not exist "data" mkdir data

if not exist "data\cert.pem" (
    echo [ERROR] TLS certificate not found (data\cert.pem).
    echo Generate it: go run .\scripts\gen_cert\
    pause
    exit /b 1
)

set TLS_CERT=data\cert.pem
set TLS_KEY=data\key.pem
set PORT=8444
set ENV=development
set DB_PATH=data\vet-test.db
set FRONTEND_DIR=frontend

echo ==========================================================
echo   VetClinic - TEST (HTTPS 8444)
echo   Database: data\vet-test.db  (safe to wipe / fill with fakes)
echo   Production runs separately on 8443 - both can run at once.
echo ==========================================================
echo Open on tablets (Chrome):
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /i "IPv4"') do (
    set "IP=%%A"
    set "IP=!IP: =!"
    if not "!IP!"=="" echo    https://!IP!:8444
)
echo.
echo   Locally:  https://localhost:8444
echo   First run creates admin; password in data\ADMIN-PASSWORD.txt
echo   If the tablet shows a certificate warning, the server IP is
echo   missing from the cert: re-run  go run .\scripts\gen_cert\
echo   and copy data\cert.pem + data\key.pem into prod\data.
echo   Stop:  Ctrl+C
echo ==========================================================
echo.
.\backend.exe

pause
