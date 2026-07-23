@echo off
setlocal enabledelayedexpansion
:: ==========================================================
:: Compile backend and DEPLOY to the prod folder.
:: Copies the fresh binary AND a matching frontend snapshot,
:: so production always runs a consistent build.
:: The live database (prod\data) is NEVER touched.
::
:: The TEST server (start.bat) does NOT block a deploy: go build can
:: rename the busy backend.exe out of the way and produce a fresh one.
::
:: The PRODUCTION server locks prod\backend.exe - it cannot be replaced
:: while running. But the frontend is plain files, not locked by the
:: server: updates are served straight from disk and the PWA picks up
:: the new version on its own, so a prod restart is NOT needed for a
:: frontend-only change. Therefore:
::   - binary busy    -> warn, but still deploy the frontend;
::   - binary updated -> remind to restart the production server.
:: ==========================================================
cd /d "%~dp0"

set BACKEND_UPDATED=0
set BACKEND_LOCKED=0

echo [1/3] Building backend.exe...
go build -o backend.exe .\backend\
if errorlevel 1 (
    echo [ERROR] Build failed - production NOT updated.
    pause
    exit /b 1
)

if not exist "prod" mkdir prod
if not exist "prod\data" mkdir prod\data

echo [2/3] Deploying backend.exe to prod...
:: Stage next to the target first, then swap it in. If the production
:: server holds prod\backend.exe, the swap fails - but the frontend
:: below still gets deployed.
copy /Y backend.exe prod\backend.exe.new >nul 2>&1
if errorlevel 1 (
    echo    [WARN] Could not stage the binary - skipping backend update.
    set BACKEND_LOCKED=1
) else (
    move /Y prod\backend.exe.new prod\backend.exe >nul 2>&1
    if errorlevel 1 (
        echo    [WARN] prod\backend.exe is in use - production server is running.
        echo           Binary NOT updated; frontend will still be deployed.
        echo           To update the server too: stop prod\start.bat and run
        echo           this script again.
        del /Q prod\backend.exe.new >nul 2>&1
        set BACKEND_LOCKED=1
    ) else (
        set BACKEND_UPDATED=1
    )
)

echo [3/3] Syncing frontend to prod\frontend...
robocopy frontend prod\frontend /MIR /NFL /NDL /NJH /NJS /NP >nul
:: robocopy: exit codes 0-7 are success, 8+ is a real failure.
if errorlevel 8 (
    echo [ERROR] Frontend sync failed.
    pause
    exit /b 1
)

echo.
echo ==========================================================
if "!BACKEND_UPDATED!"=="1" (
    echo Done. Updated backend.exe AND frontend.
    echo Restart the production server so it runs the new binary:
    echo    prod\start.bat
) else (
    if "!BACKEND_LOCKED!"=="1" (
        echo Done. Deployed FRONTEND only ^(production server was running^).
        echo It is served immediately - on the tablet just reload the page
        echo ^(the PWA fetches the new version by itself^). No restart needed.
        echo If the backend also changed: stop prod\start.bat and run this
        echo script again.
    ) else (
        echo Done. Frontend synced; backend.exe was unchanged.
    )
)
echo ==========================================================
pause
