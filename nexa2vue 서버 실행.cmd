@echo off
rem nexa2vue web server launcher: double-click to start the server and open the browser.
rem Keep this file ASCII: cmd breaks on UTF-8 text. Messages come from bin\nexa2vue-launch.js.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [nexa2vue] Node.js is required. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node bin\nexa2vue-launch.js
pause
