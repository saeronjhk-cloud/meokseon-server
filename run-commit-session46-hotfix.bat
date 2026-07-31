@echo off
REM ===========================================================================
REM  Session46 HOTFIX - "not collected" was being reported as "no allergens".
REM
REM  Found in the live response right after deploying 907d6ed:
REM    GET /api/products/8801043032155  (jjawang = fried noodle, contains wheat)
REM      allergens: []   allergens_v2: {all empty}   allergens_available: TRUE
REM
REM  Only 2 source files change. Regression gate runs first, same as before.
REM
REM  *** THIS FILE MUST STAY PURE ASCII. DO NOT PUT KOREAN TEXT IN IT. ***
REM  Korean detail: IP\commit_msg_session46-hotfix.txt
REM                 IP\handover 2026-07-31 session46, section 3-7
REM
REM  *** Never run `git add .` here. ***
REM ===========================================================================
setlocal

cd /d "%~dp0"
if errorlevel 1 (
  echo *** STOP: cannot cd to the script directory.
  pause
  exit /b 1
)
echo Working directory: %CD%

echo.
echo [0/5] Checking for a stale .git\index.lock
if exist ".git\index.lock" (
  echo   *** STOP: .git\index.lock exists.
  echo.
  echo   Running git processes:
  tasklist ^| findstr /I "git.exe"
  echo.
  echo   If no git process is listed, it is a stale lock. Remove it:
  echo       del ".git\index.lock"
  pause
  exit /b 1
)
echo   OK - no lock.

echo.
echo [1/5] Confirm the previous commit is in place
git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 (
  echo *** STOP: not a git repository.
  pause
  exit /b 1
)
git log --oneline -1
echo   ^(the line above should be 907d6ed or later^)

echo.
echo [2/5] Regression gate - 3 suites must be green
echo   ^(full output goes to %TEMP%\mk_hotfix.log^)
echo   - npm run test:allergen
call npm run test:allergen > "%TEMP%\mk_hotfix.log" 2>&1
if errorlevel 1 (
  echo *** STOP: test:allergen FAILED. Not committing.
  echo *** Last 40 lines:
  powershell -NoProfile -Command "Get-Content -Tail 40 '%TEMP%\mk_hotfix.log'"
  echo *** Full log: %TEMP%\mk_hotfix.log
  pause
  exit /b 1
)
echo     PASS
echo   - npm run test:parity
call npm run test:parity >> "%TEMP%\mk_hotfix.log" 2>&1
if errorlevel 1 (
  echo *** STOP: test:parity FAILED. Not committing.
  powershell -NoProfile -Command "Get-Content -Tail 40 '%TEMP%\mk_hotfix.log'"
  pause
  exit /b 1
)
echo     PASS
echo   - node scripts/63-eval-capture-parser.js
call node scripts\63-eval-capture-parser.js >> "%TEMP%\mk_hotfix.log" 2>&1
if errorlevel 1 (
  echo *** STOP: 63-eval FAILED ^(expected 153/153^). Not committing.
  powershell -NoProfile -Command "Get-Content -Tail 40 '%TEMP%\mk_hotfix.log'"
  pause
  exit /b 1
)
echo     PASS
echo   Regression green.

echo.
echo [3/5] Staging ^(explicit paths only - 3 files^)
git add ^
 src/services/productService.js ^
 tests/test_allergen_evidence_level.js ^
 run-commit-session46-hotfix.bat
if errorlevel 1 (
  echo *** STOP: git add FAILED.
  echo     Check: .git\index.lock, file path typos, file permissions.
  pause
  exit /b 1
)
echo   git add OK.

echo.
echo [4/5] Staged result - forbidden files must NOT be present
git diff --cached --stat
if errorlevel 1 (
  echo *** STOP: git diff --cached failed.
  pause
  exit /b 1
)
echo.
git diff --cached --name-only > "%TEMP%\mk_staged2.txt"
findstr /C:"adminRoutes" /C:"reviewActions" /C:"collapse_classify" "%TEMP%\mk_staged2.txt" >nul
if not errorlevel 1 (
  echo *** STOP: a forbidden file got staged. Shown above.
  echo     Run:  git restore --staged ^<file^>   then re-run this script.
  pause
  exit /b 1
)
echo   OK - no forbidden files.

echo.
echo [5/5] Commit - review the file list above, then press a key
pause

git commit -F "..\IP\commit_msg_session46-hotfix.txt"
if errorlevel 1 (
  echo *** STOP: git commit FAILED.
  pause
  exit /b 1
)

echo.
echo === COMMIT OK ===
git log --oneline -1
echo.
echo === NEXT ===
echo   git push
echo   ^(no migration needed this time - code only^)
echo.
echo === Then re-check item 7 ===
echo   https://meokseon-server-production.up.railway.app/api/products/8801043032155
echo   Expected AFTER this fix:
echo     allergens: null
echo     allergens_v2: null
echo     allergens_available: false
echo   Meaning: "we have no allergen data for this product",
echo            NOT "this product has no allergens".
echo.
echo   And find a product that DOES have rows to confirm the other side:
echo     allergens_available: true  with a non-empty allergens_v2
pause
