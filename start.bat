@echo off
setlocal enabledelayedexpansion
:: VetClinic - запуск сервера (HTTPS)
:: ==========================================================
:: ВНИМАНИЕ: файл сохранён в кодировке CP866 (кириллица OEM).
:: Иначе консоль Windows показывает русский текст кракозябрами.
:: Не пересохраняйте его в UTF-8 и не добавляйте chcp -
:: смена кодировки на лету ломает разбор остатка файла.
::
:: Порт 8443: и http:// и https:// ведут в приложение,
:: http:// автоматически редиректится на https://
::
:: Сертификаты выпускаются при первом запуске.
:: Если IP сервера сменился - удалите data\cert.pem и
:: запустите этот файл снова (планшет трогать не нужно).
:: ==========================================================

cd /d "%~dp0"

if not exist "data" mkdir data

:: -- Сертификаты -------------------------------------------
if not exist "data\cert.pem" (
    echo [SETUP] Сертификат не найден. Выпускаем...
    echo.
    go run .\scripts\gen_cert\
    if errorlevel 1 (
        echo.
        echo [ОШИБКА] Не удалось выпустить сертификат.
        pause
        exit /b 1
    )
    echo.
)

:: -- Сборка, если exe отсутствует --------------------------
if not exist "backend.exe" (
    echo [SETUP] Собираем backend.exe...
    go build -o backend.exe .\backend\
    if errorlevel 1 (
        echo.
        echo [ОШИБКА] Сборка не удалась.
        pause
        exit /b 1
    )
)

:: -- Параметры сервера -------------------------------------
set TLS_CERT=data\cert.pem
set TLS_KEY=data\key.pem
set PORT=8443
set ENV=production
set DB_PATH=data\vet.db
set FRONTEND_DIR=frontend

echo.
echo ==========================================================
echo   VetClinic - HTTPS
echo ==========================================================
echo.
echo Адреса для планшета (откройте в Chrome):
echo.
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /i "IPv4"') do (
    set "IP=%%A"
    set "IP=!IP: =!"
    if not "!IP!"=="" echo    https://!IP!:8443
)
echo.
echo Предупреждения о сертификате быть не должно.
echo Если оно появилось - на планшете не установлен rootCA.pem
echo либо IP сервера сменился после выпуска сертификата.
echo.
echo Остановить сервер: Ctrl+C
echo ==========================================================
echo.

.\backend.exe

pause
