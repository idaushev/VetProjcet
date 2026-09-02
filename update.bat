@echo off
setlocal enabledelayedexpansion
:: ==========================================================
:: VetClinic - safe update
::
:: The clinic has no IT staff, so an update must be one click
:: and must be reversible. Sequence:
::   1. verify the new build exists (backend.new.exe)
::   2. stop the running server
::   3. back up the database (VACUUM-free file copy is safe here
::      because the server is already stopped)
::   4. keep the current build as backend.prev.exe
::   5. install the new build and start it
::   6. check /health - if the server does not answer, ROLL BACK
::
:: Put the new build next to this file as backend.new.exe and run.
:: ==========================================================
cd /d "%~dp0"

set PORT=8443
set HEALTH_URL=https://127.0.0.1:%PORT%/health

echo.
echo === VetClinic update ===
echo.

if not exist "backend.new.exe" (
    echo [ERROR] backend.new.exe not found.
    echo Put the new build next to this script and run it again.
    pause
    exit /b 1
)

:: --- 1. stop the server ---------------------------------------------------
echo [1/5] Stopping the server...
taskkill /F /IM backend.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

:: --- 2. back up the database ---------------------------------------------
:: The scheduled backup runs daily, but an update is exactly the moment
:: when a fresh copy matters most.
echo [2/5] Backing up the database...
if not exist "data\backups" mkdir "data\backups"
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul') do set DT=%%I
set STAMP=!DT:~0,8!-!DT:~8,4!
if exist "data\vet.db" (
    copy /y "data\vet.db" "data\backups\vet-before-update-!STAMP!.db" >nul
    if errorlevel 1 (
        echo [ERROR] Could not back up the database. Update aborted.
        pause
        exit /b 1
    )
    echo       saved: data\backups\vet-before-update-!STAMP!.db
) else (
    echo       no database yet - nothing to back up
)

:: --- 3. keep the current build -------------------------------------------
echo [3/5] Keeping the current build as backend.prev.exe...
if exist "backend.exe" (
    if exist "backend.prev.exe" del /q "backend.prev.exe"
    ren "backend.exe" "backend.prev.exe"
)

:: --- 4. install the new build --------------------------------------------
echo [4/5] Installing the new build...
ren "backend.new.exe" "backend.exe"
if errorlevel 1 (
    echo [ERROR] Could not install the new build. Rolling back...
    if exist "backend.prev.exe" ren "backend.prev.exe" "backend.exe"
    pause
    exit /b 1
)

:: --- 5. start and verify --------------------------------------------------
echo [5/5] Starting and checking...
start "" /b cmd /c start.bat
timeout /t 6 /nobreak >nul

powershell -NoProfile -Command ^
  "try { [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true };" ^
  " $r = Invoke-WebRequest -Uri '%HEALTH_URL%' -TimeoutSec 8 -UseBasicParsing;" ^
  " if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"

if errorlevel 1 (
    echo.
    echo [FAIL] The new build did not answer on /health. Rolling back...
    taskkill /F /IM backend.exe /T >nul 2>&1
    timeout /t 2 /nobreak >nul
    if exist "backend.exe" ren "backend.exe" "backend.new.exe"
    if exist "backend.prev.exe" ren "backend.prev.exe" "backend.exe"
    start "" /b cmd /c start.bat
    echo       Previous version restored and started.
    echo       The failed build is kept as backend.new.exe.
    pause
    exit /b 1
)

echo.
echo [OK] Update finished. The server answers on /health.
echo      Previous version kept as backend.prev.exe - delete it once
echo      you are sure the new one works.
echo.
pause
