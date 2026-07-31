@echo off
REM ===========================================================================
REM  Commit session45 + session46 changes.
REM
REM  *** THIS FILE MUST STAY PURE ASCII. DO NOT PUT KOREAN TEXT IN IT. ***
REM  Reason (session46): the first version was saved as UTF-8. Korean cmd
REM  reads .bat files in CP949, so every Korean line turned into garbage and
REM  cmd tried to EXECUTE the garbage. The `cd /d "D:\...\meokseon-server"`
REM  line broke apart, and the ERRORLEVEL checks became meaningless -
REM  it reported "test:allergen failed" when the tests actually pass.
REM  ASCII-only removes the codepage dependency completely.
REM
REM  Korean explanation of every step:
REM    IP\ (see session46 checklist / handover documents)
REM
REM  *** Also: never run `git add .` here. The working tree contains 13
REM      unrelated modifications (including adminRoutes.js, +550 lines) and
REM      ~150 untracked files. Only the explicit list below is staged.
REM ===========================================================================
setlocal

REM  %~dp0 = this script's own folder. We do NOT hardcode the absolute path,
REM  because it contains Korean characters and that is exactly what broke
REM  the first version. This works no matter where the repo is moved.
cd /d "%~dp0"
if errorlevel 1 (
  echo *** STOP: cannot cd to the script directory.
  pause
  exit /b 1
)
echo Working directory: %CD%

echo.
echo [0/5] Checking for a stale .git\index.lock
REM  This single 0-byte file is what blocked commits for 3 sessions.
REM  git add fails with "fatal: Unable to create index.lock: File exists",
REM  and the OLD script did not check for it - it printed "done" anyway.
if exist ".git\index.lock" (
  echo   *** STOP: .git\index.lock exists.
  echo.
  echo   Running git processes:
  tasklist ^| findstr /I "git.exe"
  echo.
  echo   If no git process is listed, it is a stale lock. Remove it:
  echo       del ".git\index.lock"
  echo.
  echo   NOTE: a Claude sandbox session can leave this lock behind,
  echo         because the sandbox cannot unlink files on the mount.
  pause
  exit /b 1
)
echo   OK - no lock.

echo.
echo [1/5] Pre-commit status
git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 (
  echo *** STOP: not a git repository.
  pause
  exit /b 1
)
git status --porcelain > "%TEMP%\mk_status.txt"
if errorlevel 1 (
  echo *** STOP: git status failed.
  pause
  exit /b 1
)
findstr /C:"adminRoutes" "%TEMP%\mk_status.txt" >nul
if not errorlevel 1 (
  echo   NOTE: adminRoutes.js is modified in the working tree.
  echo         It is NOT in the staging list below, so it stays uncommitted.
  echo         This is expected.
)

echo.
echo [2/5] Regression gate - 3 suites must be green
echo   ^(full output goes to %TEMP%\mk_test.log^)
echo   - npm run test:allergen
call npm run test:allergen > "%TEMP%\mk_test.log" 2>&1
if errorlevel 1 (
  echo *** STOP: test:allergen FAILED. Not committing.
  echo *** Last 40 lines:
  powershell -NoProfile -Command "Get-Content -Tail 40 '%TEMP%\mk_test.log'"
  echo *** Full log: %TEMP%\mk_test.log
  pause
  exit /b 1
)
echo     PASS
echo   - npm run test:parity
call npm run test:parity >> "%TEMP%\mk_test.log" 2>&1
if errorlevel 1 (
  echo *** STOP: test:parity FAILED. Not committing.
  powershell -NoProfile -Command "Get-Content -Tail 40 '%TEMP%\mk_test.log'"
  pause
  exit /b 1
)
echo     PASS
echo   - node scripts/63-eval-capture-parser.js
call node scripts\63-eval-capture-parser.js >> "%TEMP%\mk_test.log" 2>&1
if errorlevel 1 (
  echo *** STOP: 63-eval FAILED ^(expected 153/153^). Not committing.
  powershell -NoProfile -Command "Get-Content -Tail 40 '%TEMP%\mk_test.log'"
  pause
  exit /b 1
)
echo     PASS
echo   Regression green.

echo.
echo [3/5] Staging ^(explicit paths only^)
git add ^
 src/models/productModel.js ^
 src/routes/ocrRoutes.js ^
 src/services/crowdsourceService.js ^
 src/services/mergeService.js ^
 src/services/nutritionTrafficLight.js ^
 src/services/ocrParser.js ^
 src/services/productService.js ^
 public/ocr-test.html ^
 package.json ^
 scripts/migrations/020_allergen_evidence_level.sql ^
 scripts/74-probe-basis-unknown.js ^
 scripts/75-dump-production-schema.js ^
 tests/test_allergen_evidence_level.js ^
 tests/test_allergen_declared.js ^
 tests/test_paren_total_calories.js ^
 tests/test_parser_parity.js ^
 tests/test_withheld_client_render.js ^
 run-commit-session45-46.bat
if errorlevel 1 (
  echo *** STOP: git add FAILED.
  echo     Sessions 42-44 failed right here, but had no check and kept going.
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
git diff --cached --name-only > "%TEMP%\mk_staged.txt"
findstr /C:"adminRoutes" /C:"reviewActions" /C:"collapse_classify" "%TEMP%\mk_staged.txt" >nul
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

git commit -F "..\IP\commit_msg_session45-46.txt"
if errorlevel 1 (
  echo *** STOP: git commit FAILED.
  pause
  exit /b 1
)

echo.
echo === COMMIT OK ===
git log --oneline -1
echo.
echo === NEXT - keep this order. Schema goes before code. ===
echo   1^) node scripts\75-dump-production-schema.js      ^(read-only, saves to IP\^)
echo   2^) node scripts\apply-migration.js scripts\migrations\020_allergen_evidence_level.sql
echo   3^) node scripts\75-dump-production-schema.js      ^(confirm 020 applied^)
echo   4^) git push
echo   5^) Railway deploy -^> /api/health returns 200
echo.
echo === Post-deploy checks ^(7 items^) - see the session46 checklist in IP\ ===
echo   1^) /api/health 200
echo   2^) capture 019 shinramyun cup   -^> calories 300  ^(not 1800^)
echo   3^) capture 017 golden curry     -^> gray dotted + retake banner
echo   4^) capture 006 daecheon gim     -^> calories 155
echo   5^) capture 033 ramyun /multi-photo 2 photos -^> contains 6 + mayContain 2
echo   6^) capture 018 jamon cracker    -^> withheld + reason basis_unknown
echo   7^) GET /api/products/^<barcode^> -^> has allergens_v2 and allergens_available
echo.
echo === WARNING ===
echo   eval_set\capture_label_eval_v1.jsonl lives outside this repo ^(..\eval_set^)
echo   and has no backup.
pause
