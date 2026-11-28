@echo off
setlocal
set "PHONEBRIDGE_CLOUD_URL=https://phonebridge.msbundle.store"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or later is required. Install it from https://nodejs.org/
  start "" "https://nodejs.org/en/download"
  exit /b 1
)
for /f "delims=" %%N in ('where node.exe') do if not defined NODE_EXE set "NODE_EXE=%%N"
set "RUNTIME_DIR=%LOCALAPPDATA%\PhoneBridge\Agent\runtime"
if not exist "%RUNTIME_DIR%\node_modules\ffmpeg-static\ffmpeg.exe" (
  echo Installing the PhoneBridge screen-capture runtime on first launch...
  call npm.cmd install --prefix "%RUNTIME_DIR%" ffmpeg-static@5.3.0 @roamhq/wrtc@0.10.0 --no-save --no-audit --no-fund --allow-scripts=ffmpeg-static
  if errorlevel 1 (
    echo Could not install the screen-capture runtime. Check your internet connection and try again.
    exit /b 1
  )
)
if not exist "%RUNTIME_DIR%\node_modules\@roamhq\wrtc\lib\index.js" (
  echo Installing PhoneBridge real-time screen streaming...
  call npm.cmd install --prefix "%RUNTIME_DIR%" ffmpeg-static@5.3.0 @roamhq/wrtc@0.10.0 --no-save --no-audit --no-fund --allow-scripts=ffmpeg-static
  if errorlevel 1 (echo Could not install WebRTC runtime. Check your internet connection and try again. & exit /b 1)
)
if not exist "%RUNTIME_DIR%\audio\NAudio.dll" (
  echo Installing PhoneBridge Windows system-audio loopback support...
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-AudioRuntime.ps1" -RuntimeDir "%RUNTIME_DIR%"
  if errorlevel 1 (echo Could not install Windows system-audio support. Screen sharing can still work without audio. & exit /b 1)
)
set "NODE_PATH=%RUNTIME_DIR%\node_modules"
set "PHONEBRIDGE_NAUDIO_DLL=%RUNTIME_DIR%\audio\NAudio.dll"
set "PHONEBRIDGE_AUDIO_LOOPBACK_SCRIPT=%~dp0audio-loopback.ps1"
wscript.exe //B //Nologo "%~dp0Start-PhoneBridge-Background.vbs" "%NODE_EXE%" "%~dp0cloud-worker.js"

