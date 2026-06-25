-- ============================================================
-- 영양 AMT_NUM 매핑·파싱 정정 v2 (하드닝) — 2026-06-25
-- 식약처 표준: 1에너지·3단백·4지방·6탄수·7당류·8섬유·13나트륨·22콜레스테롤·23포화·24트랜스
-- 두 AI 자문(Conditional GO) 반영: robust 파서 + 백업 + 불변식 게이트 + 결측=NULL(회색).
-- 자문 GO 후 실행. 게이트 통과 시에만 COMMIT.
-- ============================================================

-- [0] robust 숫자 파서: 콤마제거 / tr·미량→0 / '-'·N/A·공백·불검출→NULL / 단위문자 제거
CREATE OR REPLACE FUNCTION parse_amt(t text) RETURNS numeric AS $$
  SELECT CASE
    WHEN t IS NULL THEN NULL
    WHEN lower(btrim(t)) IN ('tr','trace','미량') THEN 0
    WHEN lower(btrim(t)) IN ('-','','n/a','na','null','nd','불검출','해당없음') THEN NULL
    WHEN nullif(regexp_replace(t,'[^0-9.]','','g'),'') IS NULL THEN NULL
    ELSE nullif(regexp_replace(t,'[^0-9.]','','g'),'')::numeric
  END;
$$ LANGUAGE sql IMMUTABLE;

BEGIN;

-- [1] 영향 행 백업 (롤백·감사용; batch 식별)
DROP TABLE IF EXISTS nutrition_data_backup_20260625;
CREATE TABLE nutrition_data_backup_20260625 AS
  SELECT *, now() AS backed_up_at, 'mfds_amt_fix_v2_20260625' AS batch_id
  FROM nutrition_data WHERE data_source='public_nutrition';

-- [2] staging wide 재추출 (올바른 AMT_NUM + robust 파싱)
UPDATE staging_nutrition SET
  calories      = parse_amt(raw_data->>'AMT_NUM1'),
  protein       = parse_amt(raw_data->>'AMT_NUM3'),
  total_fat     = parse_amt(raw_data->>'AMT_NUM4'),
  total_carbs   = parse_amt(raw_data->>'AMT_NUM6'),
  total_sugars  = parse_amt(raw_data->>'AMT_NUM7'),
  dietary_fiber = parse_amt(raw_data->>'AMT_NUM8'),
  sodium        = parse_amt(raw_data->>'AMT_NUM13'),
  cholesterol   = parse_amt(raw_data->>'AMT_NUM23'),
  saturated_fat = parse_amt(raw_data->>'AMT_NUM24'),
  trans_fat     = parse_amt(raw_data->>'AMT_NUM25');

-- [게이트 A] 불변식 + 단위 + 칼로리 (전부 0 또는 한자릿수%면 통과)
SELECT
  count(*) FILTER (WHERE total_sugars  > total_carbs + 0.5)  AS sugar_gt_carb,
  count(*) FILTER (WHERE saturated_fat > total_fat   + 0.5)  AS sat_gt_fat,
  count(*) FILTER (WHERE trans_fat     > total_fat   + 0.5)  AS trans_gt_fat,
  count(*) FILTER (WHERE sodium > 100000)                    AS sodium_unit_err,
  count(*) FILTER (WHERE calories IS NOT NULL AND total_carbs IS NOT NULL AND protein IS NOT NULL AND total_fat IS NOT NULL
                   AND abs(calories-(total_carbs*4+protein*4+total_fat*9)) > calories*0.20) AS cal_mismatch
FROM staging_nutrition WHERE db_class_nm='상용제품';

-- [3] nutrition_data 정정 (보고번호 조인, 품목대표→최신 dedup, public_nutrition만)
WITH corrected AS (
  SELECT DISTINCT ON (p.product_id) p.product_id,
    s.calories, s.total_fat, s.saturated_fat, s.trans_fat, s.cholesterol,
    s.sodium, s.total_carbs, s.total_sugars, s.dietary_fiber, s.protein
  FROM products p
  JOIN staging_nutrition s ON s.raw_data->>'ITEM_REPORT_NO' = p.c005_report_no
  WHERE coalesce(p.c005_report_no,'')<>'' AND coalesce(s.raw_data->>'ITEM_REPORT_NO','')<>''
  ORDER BY p.product_id, (s.db_class_nm='품목대표') DESC,
           (s.raw_data->>'UPDATE_DATE') DESC NULLS LAST, s.id
)
UPDATE nutrition_data nd SET
  calories=c.calories, total_fat=c.total_fat, saturated_fat=c.saturated_fat, trans_fat=c.trans_fat,
  cholesterol=c.cholesterol, sodium=c.sodium, total_carbs=c.total_carbs, total_sugars=c.total_sugars,
  dietary_fiber=c.dietary_fiber, protein=c.protein
FROM corrected c
WHERE nd.product_id=c.product_id AND nd.data_source='public_nutrition';

-- [게이트 B] 골든 제품 상식 검증
SELECT p.product_name, nd.sodium, nd.total_carbs, nd.cholesterol
FROM nutrition_data nd JOIN products p ON p.product_id=nd.product_id
WHERE p.product_name LIKE '%신라면%' OR p.product_name LIKE '%양조간장%' OR p.product_name LIKE '%고추장%'
LIMIT 12;

-- 게이트 A(불변식 0·칼로리 한자릿수) + B(신라면 1700+·간장 6000+·콜레스테롤 0) 통과 시:
--   COMMIT;
-- 하나라도 이상하면:
--   ROLLBACK;
-- 롤백 후 복구 필요시 백업: nutrition_data_backup_20260625
