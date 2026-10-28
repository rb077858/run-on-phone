@echo off
rem Downloads the latest version of the bot into ..\app (your data in ..\data is kept),
rem then installs its packages.
setlocal
pushd "%~dp0.."
echo Downloading the latest version...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$tmp = Join-Path $env:TEMP ('oneg-shabat-' + [guid]::NewGuid());" ^
  "New-Item -ItemType Directory -Path $tmp | Out-Null;" ^
  "$zip = Join-Path $tmp 'repo.zip';" ^
  "Invoke-WebRequest -UseBasicParsing 'https://codeload.github.com/rb077858/run-on-phone/zip/refs/heads/main' -OutFile $zip;" ^
  "Expand-Archive $zip -DestinationPath $tmp;" ^
  "$src = Join-Path $tmp 'run-on-phone-main\projects\oneg-shabat';" ^
  "$app = Join-Path (Get-Location).Path 'app';" ^
  "if (Test-Path $app) { Get-ChildItem $app -Force | Where-Object { $_.Name -notin 'node_modules','data','firebase-writer.json' } | Remove-Item -Recurse -Force };" ^
  "New-Item -ItemType Directory -Force -Path $app | Out-Null;" ^
  "Copy-Item -Path (Join-Path $src '*') -Destination $app -Recurse -Force;" ^
  "Remove-Item $tmp -Recurse -Force"
set "ERR=%errorlevel%"
popd
if not "%ERR%"=="0" (
  echo.
  echo Update failed. Check the internet connection and try again.
  if not "%~1"=="nopause" pause
  exit /b 1
)
call "%~dp0install.bat" nopause
echo.
echo Updated. Run start.bat to start the bot.
if not "%~1"=="nopause" pause
