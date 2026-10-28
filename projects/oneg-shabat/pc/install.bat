@echo off
rem Installs Node.js (if missing) and the bot's packages.
setlocal
set "APP=%~dp0..\app"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Installing it with winget...
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  echo.
  echo Node.js was installed. Close this window and run the file again.
  if not "%~1"=="nopause" pause
  exit /b 1
)
for /f "tokens=1 delims=v." %%v in ('node -v') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 (
  echo Node.js 20 or newer is needed. Updating with winget...
  winget upgrade -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  echo Close this window and run the file again.
  if not "%~1"=="nopause" pause
  exit /b 1
)
if not exist "%APP%\package.json" (
  echo The bot is not downloaded yet. Run update.bat first.
  if not "%~1"=="nopause" pause
  exit /b 1
)
echo Installing packages...
pushd "%APP%"
call npm install --omit=dev --no-audit --no-fund
popd
if not "%~1"=="nopause" pause
