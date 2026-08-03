@echo off
REM ===========================================================================
REM  Commit session49 changes.
REM
REM  *** THIS FILE MUST STAY PURE ASCII. DO NOT PUT KOREAN TEXT IN IT. ***
REM  Session46 proved why: a UTF-8 .bat is read as CP949 by Korean cmd,
REM  every Korean line becomes garbage, cmd tries to EXECUTE the garbage,
REM  the `cd` path breaks apart, and every ERRORLEVEL check becomes
REM  meaningless (it reports false failures AND false successes).
REM  This file is also saved with CRLF line endings - the `^` line
REM  continuation in the `git add` block is unreliable with bare LF.
REM  Verify after any edit:
REM      LC_ALL=C grep -cP "[^\x00-\x7F]" run-commit-session49.bat   -> 0
REM      file -b run-commit-session49.bat   -> must say "CRLF line terminators"
REM
REM  What session49 fixed (details in IP\ handover for 2026-08-01 session49):
REM      CRITICAL-A  getRaccPolicy matched 0 of 68 capture samples (exact-match
REM                  only). Normalization now shared with raccTable via the new
REM                  src/services/foodTypeMatch.js.
REM      CRITICAL-B  ocrRoutes fabricated `|| 100` for serving_size, which
REM                  always beat the RACC serving (4-15 g). Now passes null and
REM                  the engine decides, recording provenance in serving_basis.
REM      D3          pg NUMERIC came back as strings -> lexicographic compares.
REM                  Fixed at the read boundary in productModel.js.
REM      PC1 / PC2   501-char User-Agent made signup fail with HTTP 500.
REM
REM  Ledger movement: parity 38 -> 3 (D1 31 + D3 4 resolved) and
REM                   schema-constraints 3 -> 0 (PC1 + PC2 resolved).
REM
REM  *** Never run `git add .` here. The working tree has unrelated
REM      modifications (adminRoutes.js, +550 lines) and many untracked files.
REM
REM  *** DO NOT run older run-commit-session*.bat files. They list stale
REM      file sets and session45-46 has been converted to LF.
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
  "src\routes\userRoutes.js"
  "src\services\foodTypeMatch.js"
  "src\services\nutritionTrafficLight.js"
  "src\services\pulseConsentService.js"
  "src\services\raccPolicy.js"
  "src\services\raccTable.js"
  "tests\test_allergen_name_normalize.js"
  "tests\test_path_parity.js"
  "tests\test_schema_constraints.js"
) do (
  node --check %%F
  if errorlevel 1 (
    echo *** STOP: syntax error in %%F
    pause
    exit /b 1
  )
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
REM  Each suite runs separately on purpose. A single long chain hides which
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
call npm run test:racc-table
if errorlevel 1 goto :testfail
call npm run test:user-routes
if errorlevel 1 goto :testfail
call npm run test:pulse-consent
if errorlevel 1 goto :testfail
node scripts\63-eval-capture-parser.js
if errorlevel 1 goto :testfail
echo Regression gate OK.

echo.
echo ===========================================================================
echo  STEP 2b / 4   Strict gate for the defects fixed this session
echo ===========================================================================
REM  PC1 and PC2 were removed from the schema-constraints ledger, so the
REM  strict mode of that file MUST now be green. If it is red, the fix
REM  regressed or a ledger line was left behind.
call npm run test:schema-constraints:strict
if errorlevel 1 (
  echo *** STOP: SCHEMA_STRICT is red. PC1/PC2 were declared fixed - they are not.
  pause
  exit /b 1
)
echo Strict schema gate OK.
REM  NOTE: PARITY_STRICT and ALLERGEN_STRICT are still expected to be RED.
REM        D2, D4 and A1 are not fixed yet and remain in their ledgers.
REM        Do not add them here until those ledgers are empty.
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
  src/routes/userRoutes.js ^
  src/services/foodTypeMatch.js ^
  src/services/nutritionTrafficLight.js ^
  src/services/pulseConsentService.js ^
  src/services/raccPolicy.js ^
  src/services/raccTable.js ^
  tests/test_allergen_name_normalize.js ^
  tests/test_path_parity.js ^
  tests/test_schema_constraints.js ^
  run-commit-session49.bat
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
echo  Check the list above. It must contain exactly 12 files.
echo  These three MUST NOT appear:
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
git commit -F "..\IP\commit_msg_session49.txt"
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
echo    - The `gate` GitHub Actions workflow will run on this push.
echo      Watch the Actions tab. If it is green, THEN turn on
echo      Railway service settings -^> Wait for CI.
echo    - Railway still auto-deploys today. This push changes traffic-light
echo      output for small-serving foods (sesame oil, soy sauce, seasoned
echo      laver). That is the intended fix, but verify with the barcodes
echo      listed in the session49 handover right after deploy.
echo    - Do NOT run the 76 backfill before the allergen canonical rename.
echo      See the session49 handover for the required order.
echo.
echo  Push with:   git push
echo ===========================================================================
pause
endlocal
