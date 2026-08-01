@echo off
chcp 65001 >nul
cd /d "%~dp0"
node --check scripts\76-normalize-allergen-names.js || (echo SYNTAX ERROR & pause & exit /b 1)
node scripts\76-normalize-allergen-names.js > scripts\output\76_normalize_dryrun.log 2>&1
type scripts\output\76_normalize_dryrun.log
echo.
echo DONE (DRY-RUN, no writes). Log: scripts\output\76_normalize_dryrun.log
echo Review the plan, then run run-76-normalize-apply.bat
pause
