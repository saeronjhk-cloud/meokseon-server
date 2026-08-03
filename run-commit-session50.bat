@echo off
REM ===========================================================================
REM  Commit session49 + session50 changes.  (SINGLE COMBINED COMMIT)
REM
REM  *** THIS FILE MUST STAY PURE ASCII. DO NOT PUT KOREAN TEXT IN IT. ***
REM  Session46 proved why: a UTF-8 .bat is read as CP949 by Korean cmd,
REM  every Korean line becomes garbage, cmd tries to EXECUTE the garbage,
REM  the `cd` path breaks apart, and every ERRORLEVEL check becomes
REM  meaningless (it reports false failures AND false successes).
REM  This file is also saved with CRLF line endings - the `^` line
REM  continuation in the `git add` block is unreliable with bare LF.
REM  Verify after any edit:
REM      LC_ALL=C grep -cP "[^\x00-\x7F]" run-commit-session50.bat   -> 0
REM      file -b run-commit-session50.bat   -> must say "CRLF line terminators"
REM
REM  ------------------------------------------------------------------------
REM  WHY ONE COMMIT AND NOT TWO
REM  ------------------------------------------------------------------------
REM  The plan was to commit session49 first, then session50 on top, so that
REM  a revert would have a clean unit. That is no longer possible at file
REM  granularity: four files carry BOTH sessions' edits.
REM
REM      src/routes/ocrRoutes.js               s49 CRITICAL-B  + s50 D2
REM      src/services/nutritionTrafficLight.js s49 CRITICAL-B  + s50 D2
REM      tests/test_path_parity.js             s49 fixtures    + s50 F1-F6
REM      tests/test_allergen_name_normalize.js s49 backfill    + s50 crab/parse
REM
REM  Splitting them would mean staging partial hunks, which produces a commit
REM  whose tests do not pass. A red intermediate commit is worse than a large
REM  green one, so this stages everything at once. The commit message keeps
REM  the two sessions separated so `git log` still tells you which change
REM  belongs to which session.
REM
REM  ------------------------------------------------------------------------
REM  WHAT SESSION49 FIXED  (see IP\ handover 2026-08-01 session49)
REM  ------------------------------------------------------------------------
REM      CRITICAL-A  getRaccPolicy matched 0 of 68 capture samples (exact-match
REM                  only). Normalization now shared with raccTable via the new
REM                  src/services/foodTypeMatch.js.
REM      CRITICAL-B  ocrRoutes fabricated `|| 100` for serving_size, which
REM                  always beat the RACC serving (4-15 g). Now passes null and
REM                  the engine decides, recording provenance in serving_basis.
REM      D3          pg NUMERIC came back as strings -> lexicographic compares.
REM      PC1 / PC2   501-char User-Agent made signup fail with HTTP 500.
REM
REM  ------------------------------------------------------------------------
REM  WHAT SESSION50 FIXED  (see IP\ handover 2026-08-03 session50)
REM  ------------------------------------------------------------------------
REM      CRAB GUARD  allergenName.js flagged "pungbuhage" (an adverb ending in
REM                  -ge) as the allergen crab, and silently DROPPED crab from
REM                  "yangnyeom-gejang". The comment claimed the guard reads
REM                  the preceding character; it does not. Replaced the suffix
REM                  whitelist with token anchoring.
REM                  Real-data stress set (319 crab tokens): FN 8->7, FP 76->1.
REM                  NOTE: on the HACCP ingest path the verdict is unchanged
REM                  (all four candidates scored 0/0 on 6,195 rows). The gain
REM                  is on the user free-text path (sanitizeUserAllergens).
REM      PARSE-1     parseAllergy killed the WHOLE input when the string
REM                  contained "eopseum" anywhere. One standard label line
REM                  ("GMO: not applicable") erased 8 declared + 7 may-contain
REM                  allergens from the same document.
REM      PARSE-2     No sentence splitting + a 15-char filter threw away the
REM                  last allergen together with the trailing notice. This was
REM                  84-90 percent of all misses. Pine nut detection was 52%.
REM      PARSE-3     parseAllergy emitted fragment names ("gyeran", "jogaeryu(gul")
REM                  that matched none of the 19 canonical names.
REM                  Transcript set (586 pairs): L1 99->0, L2 89-103->0, L4 2->2.
REM      D2          sanity_warnings was computed twice per OCR response - once
REM                  in the engine, once again in the router - and the two
REM                  disagreed. The web client read the wrong one. Also isDried
REM                  existed as two independent classifiers that disagreed on
REM                  seasoned laver. Now decided once in the engine.
REM
REM  Ledger movement this session:
REM      path_parity        3 -> 2   (D2 x2 resolved, D5 x1 newly registered)
REM      parse_allergy      new file, 13 defects registered then resolved
REM
REM  ------------------------------------------------------------------------
REM  SESSION51 PATCH (2026-08-03) - this script itself was broken
REM  ------------------------------------------------------------------------
REM      STEP 0 was an inline `node -e "..."` whose JS contained [\"'] .
REM      cmd.exe does not honour \" as an escape, so that quote closed the
REM      argument and the next && split the command. node got a truncated
REM      script and the run aborted with "gate.yml would not load" while
REM      gate.yml was in fact valid. The check now lives in
REM          scripts\check-gate-yaml.js
REM      which cmd never has to quote. It is verified against the real
REM      Python yaml parser on 6 cases (1 valid + 5 mutants) and produces
REM      no false positive on `run: |` blocks that contain colons.
REM      File count in STEP 4 therefore went 23 -> 24.
REM
REM  ------------------------------------------------------------------------
REM  *** Never run `git add .` here. The working tree has unrelated
REM      modifications (adminRoutes.js, +550 lines) and many untracked files,
REM      including the whole .tmp/ verification tree which is NOT gitignored.
REM
REM  *** DO NOT run older run-commit-session*.bat files. They list stale
REM      file sets. run-commit-session49.bat in particular is now superseded
REM      by THIS file - it would commit only half of the working tree.
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
echo  STEP 0 / 5   gate.yml must be valid YAML
echo ===========================================================================
REM  Session49 shipped a gate.yml that was NOT valid YAML: nine step names
REM  looked like `- name: test: allergen`, and a bare `: ` inside an unquoted
REM  scalar makes YAML read it as a nested mapping. GitHub Actions refuses to
REM  load such a workflow - it never runs, so the Actions tab shows nothing
REM  and the gate silently does not exist. Railway's `Wait for CI` cannot see
REM  it either. That is the exact "false green" this repo keeps fighting.
REM  This check is here so it cannot happen twice.
REM
REM  *** DO NOT inline this check as `node -e "..."` again. ***
REM  Session50 did exactly that and session51 hit the consequence: the one
REM  liner contained the character class [\"'] , and cmd.exe does NOT treat
REM  \" as an escape. The backslash means nothing to cmd, so that " CLOSED
REM  the quoted argument, and the following && stopped being a JS operator
REM  and became cmd's COMMAND SEPARATOR. node received a truncated script:
REM      SyntaxError: missing ) after argument list
REM      *** STOP: gate.yml would not load on GitHub Actions.
REM  gate.yml was fine. The checker killed the commit. That is the same
REM  class of false signal this STEP was written to prevent, pointed the
REM  other way. Anything containing " & | ^ or %% belongs in a .js file.
node scripts\check-gate-yaml.js
if errorlevel 1 (
  echo *** STOP: gate.yml would not load on GitHub Actions.
  pause
  exit /b 1
)

echo.
echo ===========================================================================
echo  STEP 1 / 5   Syntax check
echo ===========================================================================
for %%F in (
  "src\models\productModel.js"
  "src\routes\ocrRoutes.js"
  "src\routes\productRoutes.js"
  "src\routes\userRoutes.js"
  "src\services\allergenName.js"
  "src\services\crowdsourceService.js"
  "src\services\foodTypeMatch.js"
  "src\services\nutritionTrafficLight.js"
  "src\services\productService.js"
  "src\services\pulseConsentService.js"
  "src\services\raccPolicy.js"
  "src\services\raccTable.js"
  "src\utils\foodCategory.js"
  "scripts\19-apply-haccp.js"
  "scripts\26-apply-haccp-dump.js"
  "scripts\check-gate-yaml.js"
  "scripts\lib\allergenUpsert.js"
  "tests\test_allergen_name_normalize.js"
  "tests\test_parse_allergy.js"
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
echo  STEP 2 / 5   Regression gate
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
call npm run test:api
if errorlevel 1 goto :testfail
call npm run test:scan-routes
if errorlevel 1 goto :testfail
call npm run test:user-routes
if errorlevel 1 goto :testfail
call npm run test:pulse-consent
if errorlevel 1 goto :testfail
call npm run test:integration
if errorlevel 1 goto :testfail
node scripts\63-eval-capture-parser.js
if errorlevel 1 goto :testfail
echo Regression gate OK.

echo.
echo ===========================================================================
echo  STEP 3 / 5   Strict gates for the defects declared fixed
echo ===========================================================================
REM  A ledger line that is deleted without the strict mode turning green is
REM  how a defect quietly comes back. These two MUST be green.
call npm run test:schema-constraints:strict
if errorlevel 1 (
  echo *** STOP: SCHEMA_STRICT is red. PC1/PC2 were declared fixed - they are not.
  pause
  exit /b 1
)
call npm run test:parse-allergy:strict
if errorlevel 1 (
  echo *** STOP: PARSE_ALLERGY_STRICT is red. The three parseAllergy defects
  echo *** were declared fixed - at least one of them is not.
  pause
  exit /b 1
)
echo Strict gates OK.
REM  NOTE: PARITY_STRICT and ALLERGEN_STRICT are still expected to be RED.
REM        PARITY_STRICT   -> D4 (crab guard redesign) + D5 (category vocab)
REM        ALLERGEN_STRICT -> A1 x4 (flat_complete three-state, pending D1)
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
echo  STEP 4 / 5   Stage the file list  (explicit - never `git add .`)
echo ===========================================================================
git add ^
  src/models/productModel.js ^
  src/routes/ocrRoutes.js ^
  src/routes/productRoutes.js ^
  src/routes/userRoutes.js ^
  src/services/allergenName.js ^
  src/services/crowdsourceService.js ^
  src/services/foodTypeMatch.js ^
  src/services/nutritionTrafficLight.js ^
  src/services/productService.js ^
  src/services/pulseConsentService.js ^
  src/services/raccPolicy.js ^
  src/services/raccTable.js ^
  src/utils/foodCategory.js ^
  scripts/19-apply-haccp.js ^
  scripts/26-apply-haccp-dump.js ^
  scripts/check-gate-yaml.js ^
  scripts/lib/allergenUpsert.js ^
  tests/test_allergen_name_normalize.js ^
  tests/test_parse_allergy.js ^
  tests/test_path_parity.js ^
  tests/test_schema_constraints.js ^
  package.json ^
  .github/workflows/gate.yml ^
  run-commit-session49.bat ^
  run-commit-session50.bat
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
echo  Check the list above. It must contain AT MOST 25 files.
echo  (Fewer is fine - a file with no actual change is simply not staged.)
echo.
echo  These MUST NOT appear:
echo      src/routes/adminRoutes.js       (unrelated, +550 lines)
echo      src/services/reviewActions.js
echo      scripts/staging/off/collapse_classify.js
echo      anything under .tmp/          (verification artifacts, not gitignored)
echo.
echo  If any of them is listed, press Ctrl+C now and run:
echo      git restore --staged src/routes/adminRoutes.js
echo ---------------------------------------------------------------------------
pause

echo.
echo ===========================================================================
echo  STEP 5 / 5   Commit
echo ===========================================================================
git commit -F "..\IP\commit_msg_session50.txt"
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
echo    - The `gate` GitHub Actions workflow runs on this push. Watch the
echo      Actions tab. If it is green, THEN turn on Railway service
echo      settings -^> Wait for CI. Do not turn it on before that.
echo    - Railway still auto-deploys today. Two user-visible changes ship:
echo        (1) small-serving foods (sesame oil, soy sauce, seasoned laver)
echo            change traffic-light colour. Intended - session49 CRITICAL-B.
echo        (2) crowdsource submissions for dried foods that used to be
echo            REJECTED on the per-100g ceiling are now ACCEPTED.
echo            Confirm this direction is what you want.
echo    - The parseAllergy fix changes CODE ONLY. The database still holds
echo      705 non-canonical rows and is missing 3 allergens. Re-ingest with
REM  *** The two lines below MUST keep the ^ before each > ***
REM  Session51: they were written with a bare `->` and cmd read that > as a
REM  REDIRECTION operator. Running this script did not print the guidance -
REM  it OVERWROTE run-26-apply-commit.bat and run-19-apply-commit.bat with
REM  the echo text (30 bytes each). Those two files are NOT tracked by git,
REM  so `git restore` could not bring them back; they had to be rebuilt from
REM  their dry-run siblings. Line 308 above already had it right (`-^>`).
echo          run-26-apply.bat  -^>  run-26-apply-commit.bat
echo          run-19-apply.bat  -^>  run-19-apply-commit.bat
echo          node scripts\76-normalize-allergen-names.js  (dry, then --apply)
echo      in THAT order. Running 76 first forces a second backfill pass.
echo ===========================================================================
pause
endlocal
