-- ============================================================
-- 먹선 Migration 010 — Production staging 테이블 생성
-- 작성일: 2026-06-21
-- 트리거: C005 75% 미적재 발견 → Railway DB 에 직접 적재 plan (옵션 B)
-- ============================================================
--
-- 목적:
--   * 식약처 OpenAPI 데이터를 Railway PostgreSQL 에 직접 적재할 수 있도록
--     staging 테이블 (C005·nutrition·ingredients) 생성
--   * 적재 후 머지 파이프라인으로 products 에 INSERT/UPSERT
--   * 머지 완료 후 staging 테이블은 DROP 또는 archive 가능
--
-- 실행 위치: Railway PostgreSQL Console (psql 셸)
-- 실행 방법: 본 파일 전체 내용을 복사 → railway=# 프롬프트에 붙여넣기 → 엔터
--
-- 롤백:
--   DROP TABLE IF EXISTS staging_c005;
--   DROP TABLE IF EXISTS staging_nutrition;
--   DROP TABLE IF EXISTS staging_ingredients;
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. staging_c005 — 바코드연계제품정보 (식약처 C005 OpenAPI)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staging_c005 (
  id BIGSERIAL PRIMARY KEY,
  bar_cd VARCHAR(20),
  prdlst_nm VARCHAR(500),
  bssh_nm VARCHAR(200),
  prdlst_dcnm VARCHAR(100),
  prdlst_report_no VARCHAR(50),
  raw_data JSONB,
  loaded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staging_c005_barcode
  ON staging_c005(bar_cd);

CREATE INDEX IF NOT EXISTS idx_staging_c005_name
  ON staging_c005 USING gin(prdlst_nm gin_trgm_ops);

COMMENT ON TABLE staging_c005 IS
  '식약처 C005 OpenAPI raw 적재. 머지 파이프라인으로 products 에 INSERT 후 archive 가능. Migration 010.';

-- ------------------------------------------------------------
-- 2. staging_nutrition — 식품영양성분DB (공공데이터포털)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staging_nutrition (
  id BIGSERIAL PRIMARY KEY,
  food_cd VARCHAR(30),
  food_nm_kr VARCHAR(500),
  db_class_nm VARCHAR(100),
  food_or_nm VARCHAR(200),
  maker_nm VARCHAR(200),
  serving_size VARCHAR(50),
  calories DECIMAL(10,2),
  protein DECIMAL(10,2),
  total_fat DECIMAL(10,2),
  total_carbs DECIMAL(10,2),
  total_sugars DECIMAL(10,2),
  sodium DECIMAL(10,2),
  cholesterol DECIMAL(10,2),
  saturated_fat DECIMAL(10,2),
  trans_fat DECIMAL(10,2),
  dietary_fiber DECIMAL(10,2),
  raw_data JSONB,
  loaded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staging_nutrition_name
  ON staging_nutrition USING gin(food_nm_kr gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_staging_nutrition_foodcd
  ON staging_nutrition(food_cd);

COMMENT ON TABLE staging_nutrition IS
  '공공데이터포털 식품영양성분DB raw 적재. Migration 010.';

-- ------------------------------------------------------------
-- 3. staging_ingredients — 품목제조보고(원재료) (식약처 C002)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staging_ingredients (
  id BIGSERIAL PRIMARY KEY,
  prdlst_report_no VARCHAR(50),
  prdlst_nm VARCHAR(500),
  rawmtrl_nm TEXT,
  bssh_nm VARCHAR(200),
  prms_dt VARCHAR(20),
  raw_data JSONB,
  loaded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staging_ingredients_report
  ON staging_ingredients(prdlst_report_no);

CREATE INDEX IF NOT EXISTS idx_staging_ingredients_name
  ON staging_ingredients USING gin(prdlst_nm gin_trgm_ops);

COMMENT ON TABLE staging_ingredients IS
  '식약처 C002 품목제조보고(원재료) raw 적재. Migration 010.';

COMMIT;

-- ============================================================
-- 검증 쿼리 (수동 실행용)
-- ============================================================
-- 테이블 생성 확인:
--   \dt staging_*
--
-- 또는:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_name LIKE 'staging%';
--
-- 초기 row 수 확인 (모두 0이어야 정상):
--   SELECT 'staging_c005' AS t, count(*) FROM staging_c005
--   UNION ALL SELECT 'staging_nutrition', count(*) FROM staging_nutrition
--   UNION ALL SELECT 'staging_ingredients', count(*) FROM staging_ingredients;
-- ============================================================
