@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%" || goto :fail

if /I not "%OS%"=="Windows_NT" (
  echo [run-bot.bat] ERROR: This launcher is for Windows.
  echo [run-bot.bat] Use: run-bot.command ^(macOS^) or run-bot.desktop ^(Linux^) or run-bot.sh ^(Linux/macOS from terminal^)
  goto :fail_pause
)

where node >nul 2>&1
if errorlevel 1 (
  echo [run-bot] ERROR: Node.js is not installed or not on PATH ^(requires Node ^>= 20^).
  goto :fail_pause
)

for /f %%i in ('node -p "parseInt(process.versions.node.split('.')[0], 10)"') do set "NODE_MAJOR=%%i"
if not defined NODE_MAJOR (
  echo [run-bot] ERROR: Could not determine Node.js version.
  goto :fail_pause
)
if %NODE_MAJOR% LSS 20 (
  for /f %%v in ('node -v') do set "NODE_VER=%%v"
  echo [run-bot] ERROR: Node.js ^>= 20 is required ^(found !NODE_VER!^).
  goto :fail_pause
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [run-bot] ERROR: npm is not installed or not on PATH.
  goto :fail_pause
)

call node .\scripts\run-bot.mjs

echo.
echo [run-bot] Bot stopped.
pause >nul
exit /b 0

:fail
exit /b 1

:fail_pause
echo.
echo [run-bot] Launch options:
echo   - Windows: run-bot.bat
echo   - macOS:   run-bot.command
echo   - Linux:   run-bot.desktop
echo   - Terminal: run-bot.sh
pause
exit /b 1
