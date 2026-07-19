@echo off
echo ================================================
echo  Загрузка 100 приёмов в базу данных VetClinic
echo ================================================
echo.
echo ВАЖНО: перед запуском остановите сервер (закройте start.bat)!
echo.
pause

cd /d "%~dp0"
data\sqlite3.exe data\vet.db < seed_visits.sql

echo.
echo Готово! Запустите сервер заново через start.bat
pause
