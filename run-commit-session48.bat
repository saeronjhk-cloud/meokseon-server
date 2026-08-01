@echo off
REM ===========================================================================
REM  Commit session47 + session48 changes.
REM
REM  *** THIS FILE MUST STAY PURE ASCII. DO NOT PUT KOREAN TEXT IN IT. ***
REM  Session46 proved why: a UTF-8 .bat is read as CP949 by Korean cmd,
REM  every Korean line becomes garbage, cmd tries to EXECUTE the garbage,
REM  the `cd` path breaks apart, and every ERRORLEVEL check becomes
REM  meaningless (it reports false failures AND false successes).
REM  This file is also saved with CRLF line endings - the `^` line
REM  continuation in the `git add` block is unreliable with bare LF.
REM  Verify after any edit:
REM      LC_ALL=C grep -cP "[^\x00-\x7F]" run-commit-session48.bat   -> 0
REM      file -b run-commit-session48.bat   -> must say "CRLF line terminators"
REM
REM  Korean explanation of every step:
REM      IP\4th-verification session48 document
REM      IP\external-review consolidation session48 document
REM
REM  *** Never run `git add .` here. The working tree has unrelated
REM      modifications (adminRoutes.js, +550 lines) and ~150 untracked files.
REM
REM  *** DO NOT run run-commit-session45-46.bat or run-commit-session47.bat.
REM      The first one has been converted to LF and is unreliable.
REM      The second one lists an older, smaller file set.
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
echo ===========================================================================
echo  STEP 1 / 4   Syntax check
echo ===========================================================================
for %%F in (
  "src\models\productModel.js"
  "src\routes\ocrRoutes.js"
  "src\routes\productRoutes.js"
  "src\services\mergeService.js"
  "src\services\productService.js"
  "src\services\allergenName.js"
  "scripts\lib\allergenUpsert.js"
  "scripts\19-apply-haccp.js"
  "scripts\26-apply-haccp-dump.js"
  "scripts\76-normalize-allergen-names.js"
  "scripts\77-verify-fresh-schema.js"
  "tests\test_allergen_name_normalize.js"
  "tests\test_allergen_declared.js"
  "tests\test_allergen_evidence_level.js"
  "tests\test_path_parity.js"
  "tests\test_allergen_contract.js"
  "tests\test_schema_constraints.js"
) do (
  node --check %%F
  if errorlevel 1 (
    echo *** STOP: syntax error in %%F
    pause
    exit /b 1
  )
)
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"
if errorlevel 1 (
  echo *** STOP: package.json is not valid JSON.
  pause
  exit /b 1
)
node -e "require('./src/app')"
if errorlevel 1 (
  echo *** STOP: the app does not boot.
  pause
  exit /b 1
)
echo Syntax check OK.

echo.
echo ===========================================================================
echo  STEP 2 / 4   Regression gate
echo ===========================================================================
REM  Each suite is run separately on purpose. A single long chain hides which
REM  one failed, and the sandbox that wrote these tests times out at 45s.
call npm run test:allergen
if errorlevel 1 goto :testfail
call npm run test:contracts
if errorlevel 1 goto :testfail
call npm run verify:fresh-schema
if errorlevel 1 goto :testfail
call npm run test:merge
if errorlevel 1 goto :testfail
call npm run test:ocr
if errorlevel 1 goto :testfail
call npm run test:serving
if errorlevel 1 goto :testfail
call npm run test:parity
if errorlevel 1 goto :testfail
call npm run test:unit
if errorlevel 1 goto :testfail
node scripts\63-eval-capture-parser.js
if errorlevel 1 goto :testfail
echo Regression gate OK.
goto :staged

:testfail
echo.
echo *** STOP: a regression suite failed. Nothing has been staged.
echo *** Read the output above. Do not commit around a red test.
pause
exit /b 1

:staged
echo.
echo ===========================================================================
echo  STEP 3 / 4   Stage the file list  (explicit - never `git add .`)
echo ===========================================================================
git add ^
  src/models/productModel.js ^
  src/routes/ocrRoutes.js ^
  src/routes/productRoutes.js ^
  src/services/mergeService.js ^
  src/services/productService.js ^
  src/services/allergenName.js ^
  scripts/lib/allergenUpsert.js ^
  scripts/19-apply-haccp.js ^
  scripts/26-apply-haccp-dump.js ^
  scripts/76-normalize-allergen-names.js ^
  scripts/77-verify-fresh-schema.js ^
  scripts/migrations/000_baseline.sql ^
  scripts/migrations/000b_seed_config.sql ^
  package.json ^
  tests/test_allergen_name_normalize.js ^
  tests/test_allergen_declared.js ^
  tests/test_allergen_evidence_level.js ^
  tests/test_path_parity.js ^
  tests/test_allergen_contract.js ^
  tests/test_schema_constraints.js ^
  run-76-normalize-dryrun.bat ^
  run-76-normalize-apply.bat ^
  run-77-verify-fresh-schema.bat ^
  run-commit-session48.bat
if errorlevel 1 (
  echo *** STOP: git add failed.
  pause
  exit /b 1
)

echo.
echo Staged files:
git diff --cached --name-only
echo.
echo ---------------------------------------------------------------------------
echo  Check the list above. These three files MUST NOT appear:
echo      src/routes/adminRoutes.js       (unrelated, +550 lines)
echo      scripts/.../reviewActions.js
echo      scripts/.../collapse_classify.js
echo  If any of them is listed, press Ctrl+C now and run:
echo      git restore --staged src/routes/adminRoutes.js
echo ---------------------------------------------------------------------------
pause

echo.
echo ===========================================================================
echo  STEP 4 / 4   Commit
echo ===========================================================================
git commit -F "..\IP\commit_msg_session48.txt"
if errorlevel 1 (
  echo *** STOP: git commit failed. The files are still staged.
  pause
  exit /b 1
)

echo.
git --no-pager log --oneline -3
echo.
echo ===========================================================================
echo  DONE. Not pushed yet.
echo.
echo  Before `git push`, read this:
echo    - Railway deploys automatically on push. There is no staging.
echo      Session48 external review flagged this as the top risk.
echo    - RACC policy wiring is a NO-OP (0 of 68 label samples match).
echo      It is committed as-is and recorded in the known-defect ledgers.
echo    - Do NOT run the 76 backfill yet unless you have read
echo      the session48 handover section about it.
echo.
echo  Push with:   git push
echo ===========================================================================
pause
endlocal
