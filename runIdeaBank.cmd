@echo off
setlocal
title Idea Bank
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not available in PATH.
  echo Install Node.js, then run this file again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm is not available. Please reinstall Node.js.
  pause
  exit /b 1
)

if not exist "node_modules\next\package.json" (
  call :install
  if errorlevel 1 exit /b 1
)
if not exist "node_modules\better-sqlite3\package.json" (
  call :install
  if errorlevel 1 exit /b 1
)

node scripts\start-dev.mjs %*
if errorlevel 1 (
  echo Could not start Idea Bank. Check the messages above.
  pause
  exit /b 1
)
exit /b 0

:install
echo Installing project dependencies...
call npm ci
if errorlevel 1 (
  echo Installation failed. Check the messages above.
  pause
  exit /b 1
)
exit /b 0
