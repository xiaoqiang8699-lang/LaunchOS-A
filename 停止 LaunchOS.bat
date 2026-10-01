@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-launchos.ps1"
if errorlevel 1 (
  echo.
  echo LaunchOS 停止失败。
)
pause
