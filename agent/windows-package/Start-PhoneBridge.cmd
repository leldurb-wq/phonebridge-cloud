@echo off
setlocal
set "PHONEBRIDGE_CLOUD_URL=https://phonebridge.msbundle.store"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or later is required. Install it from https://nodejs.org/
  start "" "https://nodejs.org/en/download"
  exit /b 1
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm is missing. Repair your Node.js installation and try again.
  pause
  exit /b 1
)
for /f "delims=" %%N in ('where node.exe') do if not defined NODE_EXE set "NODE_EXE=%%N"
set "RUNTIME_DIR=%LOCALAPPDATA%\PhoneBridge\Agent\runtime"
if not exist "%RUNTIME_DIR%\node_modules\ffmpeg-static\ffmpeg.exe" (
  echo Installing PhoneBridge FFmpeg screen-capture runtime. This may take a few minutes...
  call npm.cmd install --prefix "%RUNTIME_DIR%" ffmpeg-static@5.3.0 @roamhq/wrtc@0.10.0 --no-save --no-audit --no-fund --allow-scripts=ffmpeg-static
  if errorlevel 1 (
    echo Could not install FFmpeg. Check your internet connection, then run this file again.
    pause
    exit /b 1
  )
)
if not exist "%RUNTIME_DIR%\node_modules\@roamhq\wrtc\lib\index.js" (
  echo Installing PhoneBridge WebRTC screen-streaming runtime...
  call npm.cmd install --prefix "%RUNTIME_DIR%" ffmpeg-static@5.3.0 @roamhq/wrtc@0.10.0 --no-save --no-audit --no-fund --allow-scripts=ffmpeg-static
  if errorlevel 1 (
    echo Could not install WebRTC. Check your internet connection, then run this file again.
    pause
    exit /b 1
  )
)
if not exist "%RUNTIME_DIR%\audio\NAudio.dll" (
  echo Installing PhoneBridge Windows system-audio loopback support...
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-AudioRuntime.ps1" -RuntimeDir "%RUNTIME_DIR%"
  if errorlevel 1 echo Audio runtime unavailable. Screen sharing and pairing can still work without system audio.
)
set "NODE_PATH=%RUNTIME_DIR%\node_modules"
set "PHONEBRIDGE_NAUDIO_DLL=%RUNTIME_DIR%\audio\NAudio.dll"
set "PHONEBRIDGE_AUDIO_LOOPBACK_SCRIPT=%~dp0audio-loopback.ps1"
echo Starting PhoneBridge in the background...
wscript.exe //B //Nologo "%~dp0Start-PhoneBridge-Background.vbs" "%NODE_EXE%" "%~dp0cloud-worker.js"
if errorlevel 1 (
  echo PhoneBridge could not start. Check AppData\Local\PhoneBridge\Agent\connector.log
  pause
)
