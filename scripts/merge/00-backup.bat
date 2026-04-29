@echo off
REM 먹선 DB 병합 전 백업 스크립트 (Windows)
REM 사용법: scripts\merge\00-backup.bat

echo ========================================
echo   먹선 DB 병합 전 백업
echo ========================================

for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /format:list') do set datetime=%%I
set TIMESTAMP=%datetime:~0,8%_%datetime:~8,6%
set BACKUP_FILE=meokseon_backup_pre_merge_%TIMESTAMP%.dump

pg_dump -U postgres -d meokseon -F c -f "%BACKUP_FILE%"

echo.
echo   백업 완료: %BACKUP_FILE%
echo ========================================
