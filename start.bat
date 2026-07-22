@echo off
setlocal
:: ==========================================================
:: VetClinic - TEST / DEV server (HTTP, TEST database)
:: Uses a SEPARATE test database (data\vet-test.db) so you can
:: fill it with fake data without touching the live clinic data
:: (which lives in prod\data\vet.db - launch via prod\start.bat).
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

set PORT=8090
set ENV=development
set DB_PATH=data\vet-test.db
set FRONTEND_DIR=frontend

echo ==========================================================
echo   VetClinic - TEST (HTTP 8090)
echo   Database: data\vet-test.db  (safe to wipe / fill with fakes)
echo ==========================================================
echo   Open:  http://localhost:8090
echo   First run creates admin; password in data\ADMIN-PASSWORD.txt
echo   Stop:  Ctrl+C
echo ==========================================================
echo.
.\backend.exe

pause
