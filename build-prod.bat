@echo off
setlocal
:: ==========================================================
:: Compile backend and DEPLOY to the prod folder.
:: Copies the fresh binary AND a matching frontend snapshot,
:: so production always runs a consistent build.
:: The live database (prod\data) is NEVER touched.
::
:: Stop the running production server before deploying,
:: otherwise the locked backend.exe cannot be overwritten.
:: ==========================================================
cd /d "%~dp0"

echo [1/3] Building backend.exe...
go build -o backend.exe .\backend\
if errorlevel 1 (
    echo [ERROR] Build failed - production NOT updated.
    pause
    exit /b 1
)

if not exist "prod" mkdir prod
if not exist "prod\data" mkdir prod\data

echo [2/3] Copying backend.exe to prod...
copy /Y backend.exe prod\backend.exe >nul
if errorlevel 1 (
    echo [ERROR] Could not copy backend.exe. Is the production server still running?
    pause
    exit /b 1
)

echo [3/3] Syncing frontend to prod\frontend...
robocopy frontend prod\frontend /MIR /NFL /NDL /NJH /NJS /NP >nul

echo.
echo Done. Deployed to prod. Start production: prod\start.bat
pause
