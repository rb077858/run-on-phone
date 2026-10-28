@echo off
rem Starts the bot. Admin panel: http://localhost:3000/admin  (summary: http://localhost:3000/)
setlocal
set "APP=%~dp0..\app"
set "DATA_DIR=%~dp0..\data"
if "%PORT%"=="" set "PORT=3000"
if not exist "%APP%\package.json" call "%~dp0update.bat" nopause
if not exist "%APP%\node_modules" call "%~dp0install.bat" nopause
title Oneg Shabat bot
echo Starting the bot... (close this window to stop it)
echo Admin panel: http://localhost:%PORT%/admin
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 4; Start-Process 'http://localhost:%PORT%/admin'"
cd /d "%APP%"
node index.js
echo.
echo The bot stopped.
pause
