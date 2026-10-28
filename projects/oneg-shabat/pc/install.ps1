# Oneg Shabat bot - PC installer. Run in PowerShell, in the folder where you want it:
#   irm https://raw.githubusercontent.com/rb077858/run-on-phone/main/projects/oneg-shabat/pc/install.ps1 | iex
# Creates .\oneg-shabat\ with a launcher folder (update / start / install) and downloads the bot.
$ErrorActionPreference = "Stop"
$raw = "https://raw.githubusercontent.com/rb077858/run-on-phone/main/projects/oneg-shabat/pc"
$root = Join-Path (Get-Location) "oneg-shabat"
$launcher = Join-Path $root ([string]::new([char[]](0x05D4, 0x05E4, 0x05E2, 0x05DC, 0x05D4)))  # "הפעלה"
New-Item -ItemType Directory -Force -Path $launcher | Out-Null
foreach ($f in "update.bat", "start.bat", "install.bat") {
  $text = (Invoke-WebRequest -UseBasicParsing "$raw/$f").Content -replace "`r?`n", "`r`n"
  [IO.File]::WriteAllText((Join-Path $launcher $f), $text, [Text.Encoding]::ASCII)
}
Write-Host "Created $root" -ForegroundColor Green
& cmd /c (Join-Path $launcher "update.bat") nopause
Write-Host ""
Write-Host "Done. To run the bot: open $launcher and double-click start.bat" -ForegroundColor Green
explorer.exe $launcher
