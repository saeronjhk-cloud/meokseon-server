@echo off
REM  Post-deploy verification. READ-ONLY: only GET and POST /evaluate.
REM  It never writes to the production database.
REM  *** Do not put a bare > in any echo line here. cmd treats it as a
REM      REDIRECTION and will overwrite a file. See session51.
cd /d "%~dp0"
node scripts\78-verify-deploy.js %*
echo.
pause
