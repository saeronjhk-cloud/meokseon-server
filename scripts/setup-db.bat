@echo off
chcp 65001 >nul

set "PGPATH=C:\Program Files\PostgreSQL\18\bin"
set "PATH=%PGPATH%;%PATH%"
set PGPASSWORD=Minigood7*
set PGCLIENTENCODING=UTF8

echo ========================================
echo   MeokSeon DB Setup
echo ========================================
echo.

echo [1/4] Installing pg_trgm extension...
"%PGPATH%\psql" -U postgres -d meokseon -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
"%PGPATH%\psql" -U postgres -d meokseon -c "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";"
echo   OK

echo.
echo [2/4] Creating schema (16 tables)...
"%PGPATH%\psql" -U postgres -d meokseon -f scripts\migrations\001_init_schema.sql
if %errorlevel%==0 (
    echo   OK - Schema created
) else (
    echo   FAIL - Check error above
    pause
    exit /b 1
)

echo.
echo [3/4] Inserting config seed data...
"%PGPATH%\psql" -U postgres -d meokseon -f scripts\migrations\002_seed_config.sql
if %errorlevel%==0 (
    echo   OK - Config seed data inserted
) else (
    echo   FAIL - Check error above
    pause
    exit /b 1
)

echo.
echo [4/4] Loading 100 product data...
"%PGPATH%\psql" -U postgres -d meokseon -f scripts\migrations\003_seed_products.sql
if %errorlevel%==0 (
    echo   OK - Product data loaded
) else (
    echo   FAIL - Check error above
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Verifying...
echo ========================================
"%PGPATH%\psql" -U postgres -d meokseon -c "SELECT count(*) AS total_products FROM products;"
"%PGPATH%\psql" -U postgres -d meokseon -c "SELECT count(*) AS total_nutrition FROM nutrition_data;"
"%PGPATH%\psql" -U postgres -d meokseon -c "SELECT food_category, count(*) FROM products GROUP BY food_category ORDER BY count DESC;"

echo.
echo ========================================
echo   DB Setup Complete!
echo   Next: npm start
echo ========================================
pause
