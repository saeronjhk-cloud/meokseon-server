@echo off
chcp 65001 >nul
cd /d "%~dp0"
node --check scripts\76-normalize-allergen-names.js || (echo SYNTAX ERROR & pause & exit /b 1)
echo *** THIS WRITES TO THE DATABASE (UPDATE / DELETE / INSERT) ***
echo Press Ctrl+C to abort, or
pause
node scripts\76-normalize-allergen-names.js --apply --backup > scripts\output\76_normalize_apply.log 2>&1
type scripts\output\76_normalize_apply.log
echo.
echo DONE. Log: scripts\output\76_normalize_apply.log
pause
