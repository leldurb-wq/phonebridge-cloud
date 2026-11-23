@echo off
setlocal
set "PHONEBRIDGE_CLOUD_URL=https://phonebridge-cloud.onrender.com"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or later is required.
  echo Install Node.js from https://nodejs.org/ and then run this file again.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
node -e "if (Number(process.versions.node.split('.')[0]) < 20) process.exit(1)"
if errorlevel 1 (
  echo Please install Node.js 20 or later, then run this file again.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
echo PhoneBridge Cloud Agent
node "%~dp0cloud-worker.js"
echo.
echo Keep this window open while you want this computer connected.
pause
