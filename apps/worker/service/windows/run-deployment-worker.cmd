@echo off
REM LaunchOS Deployment Worker supervisor (no secrets).
REM Keeps WORKER_PROFILE=deployment and restarts after crash with a delay.
set WORKER_PROFILE=deployment
set NODE_ENV=production
cd /d D:\launchos-zidonghua\apps\worker

:loop
echo [%DATE% %TIME%] starting deployment worker
"D:\Program Files (x86)\node\node.exe" dist\main.js
set EXITCODE=%ERRORLEVEL%
echo [%DATE% %TIME%] worker exited code=%EXITCODE% — restarting in 10s
timeout /t 10 /nobreak >nul
goto loop
