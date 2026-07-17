@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo  식약처 통합영양 DB ^<-^> C005 정확조인 겹침 실측 (READ ONLY)
echo  근거: 영양공식 세션31 발견 - 품목제조보고번호 94%% 존재
echo ============================================================
echo.
node --check scripts\staging\domestic\probe_nutrition_report_no_join.js || (echo SYNTAX ERROR ^& pause ^& exit /b 1)
node scripts\staging\domestic\probe_nutrition_report_no_join.js --selftest || (echo SELFTEST FAILED ^& pause ^& exit /b 1)
node scripts\staging\domestic\probe_nutrition_report_no_join.js %*
if errorlevel 1 (echo PROBE FAILED ^& pause ^& exit /b 1)
echo.
echo  DONE - [B][C][D] 를 Claude 에게 붙여넣으세요.
pause
