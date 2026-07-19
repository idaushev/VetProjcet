@echo off
setlocal
:: VetClinic - очистка данных (кроме прайс-листа и персонала)
:: ==========================================================
:: Удаляет: владельцев, животных, приёмы, позиции приёмов,
::          вакцинации, вложения (и их файлы с диска),
::          состояние синхронизации и список устройств.
:: Оставляет: items (прайс-лист) и clinic_staff (персонал -
::          без него отчёт по врачам пуст; если персонал тоже
::          нужно чистить - раскомментируйте строку ниже).
::
:: ВАЖНО: перед запуском остановите сервер (Ctrl+C в окне start.bat),
:: иначе база может быть занята.
:: После очистки сервера на планшете нужно сбросить локальные данные
:: (Настройки -> Сбросить локальные данные), иначе планшет при
:: синхронизации зальёт старых пациентов обратно.
:: ==========================================================

cd /d "%~dp0"

if not exist "data\vet.db" (
    echo [ОШИБКА] База data\vet.db не найдена.
    pause
    exit /b 1
)

echo.
echo ==========================================================
echo   Очистка данных VetClinic
echo   Останутся только прайс-лист и персонал.
echo ==========================================================
echo.
set /p CONFIRM="Удалить всех пациентов и приёмы? (y/N): "
if /i not "%CONFIRM%"=="y" (
    echo Отменено.
    pause
    exit /b 0
)

:: Резервная копия на всякий случай
set BACKUP=data\vet-before-clear.db
copy /y data\vet.db "%BACKUP%" >nul
echo Резервная копия: %BACKUP%

:: Порядок удаления важен для внешних ключей:
:: сначала зависимые таблицы, потом родительские.
data\sqlite3.exe data\vet.db "PRAGMA foreign_keys=OFF; DELETE FROM attachments; DELETE FROM visit_items; DELETE FROM visits; DELETE FROM vaccinations; DELETE FROM pets; DELETE FROM owners; DELETE FROM sync_state; DELETE FROM devices; PRAGMA foreign_keys=ON; VACUUM;"
if errorlevel 1 (
    echo.
    echo [ОШИБКА] Очистка не удалась. Сервер остановлен?
    pause
    exit /b 1
)

:: DELETE FROM clinic_staff; -- раскомментируйте и перенесите в строку выше,
::                              если персонал тоже нужно чистить

:: Файлы вложений: записей о них больше нет - чистим и диск
if exist "data\attachments" rmdir /s /q "data\attachments"

echo.
echo Готово. Осталось в базе:
data\sqlite3.exe data\vet.db "SELECT 'прайс-лист: '||COUNT(*) FROM items; SELECT 'персонал: '||COUNT(*) FROM clinic_staff; SELECT 'владельцы: '||COUNT(*) FROM owners; SELECT 'приёмы: '||COUNT(*) FROM visits;"
echo.
echo Не забудьте сбросить локальные данные на планшете!
pause
