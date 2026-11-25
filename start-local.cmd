@echo off
setlocal
pushd "%~dp0"
if not exist "node_modules\@roamhq\wrtc\package.json" call npm ci --include=optional --no-audit --no-fund
if errorlevel 1 goto failed
powershell -NoProfile -NonInteractive -File "%~dp0scripts\prepare-speech.ps1"
if errorlevel 1 goto failed
node --env-file-if-exists=.env server.mjs --local
if errorlevel 1 goto failed
popd
exit /b 0
:failed
pause
popd
exit /b 1
