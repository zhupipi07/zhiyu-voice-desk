@echo off
setlocal
pushd "%~dp0"
if not exist "node_modules\@roamhq\wrtc\package.json" call npm ci --include=optional --no-audit --no-fund
if errorlevel 1 goto failed
powershell -NoProfile -NonInteractive -File "%~dp0scripts\prepare-speech.ps1"
if errorlevel 1 echo Local voice cache unavailable. Using cloud speech.
node --env-file-if-exists=.env server.mjs --gateway
if errorlevel 1 pause
popd
exit /b
:failed
pause
popd
exit /b 1
