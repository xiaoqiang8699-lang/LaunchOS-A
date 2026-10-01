@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-launchos.ps1"
if errorlevel 1 (
  echo.
  echo LaunchOS 启动失败。
)
pause
