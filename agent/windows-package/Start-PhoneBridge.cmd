@echo off
setlocal
set "PHONEBRIDGE_CLOUD_URL=https://phonebridge-cloud.onrender.com"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or later is required. Install it from https://nodejs.org/
  start "" "https://nodejs.org/en/download"
  exit /b 1
)
for /f "delims=" %%N in ('where node.exe') do if not defined NODE_EXE set "NODE_EXE=%%N"
wscript.exe //B //Nologo "%~dp0Start-PhoneBridge-Background.vbs" "%NODE_EXE%" "%~dp0cloud-worker.js"
