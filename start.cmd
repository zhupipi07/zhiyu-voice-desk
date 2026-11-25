@echo off
setlocal
pushd "%~dp0"
if not exist "node_modules\@roamhq\wrtc\package.json" call npm install --include=optional --no-audit --no-fund
if errorlevel 1 goto failed
node --env-file-if-exists=.env server.mjs --gateway
if errorlevel 1 pause
popd
exit /b
:failed
pause
popd
exit /b 1
