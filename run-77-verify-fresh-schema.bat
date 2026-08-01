@echo off
chcp 65001 >nul
cd /d "%~dp0"
node --check scripts\77-verify-fresh-schema.js || (echo SYNTAX ERROR & pause & exit /b 1)
node scripts\77-verify-fresh-schema.js
if errorlevel 1 (
  echo.
  echo FAILED - fresh DB does not match production schema.
  echo Fix scripts\migrations\000_baseline.sql and run again.
) else (
  echo.
  echo OK - empty DB + migrate chain reproduces the production schema.
)
pause
