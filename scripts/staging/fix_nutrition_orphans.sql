-- ============================================================
-- orphan 영양행 정정 (옛 버그 lineage, report_no 미매칭 9,741건) — 2026-06-25
-- 두 AI 조건부 GO 반영: 유일성 게이트 + 매칭실패=오염필드 NULL(회색) + lineage 대상 + 백업.
-- 자문 GO 후 실행. 게이트 통과 시에만 COMMIT.
-- ============================================================
BEGIN;

-- 0. orphan_ids: public_nutrition 인데 report_no로 staging 매칭 안 되는 product (옛 lineage)
DROP TABLE IF EXISTS orphan_ids;
CREATE TEMP TABLE orphan_ids AS
WITH sr AS (SELECT DISTINCT raw_data->>'ITEM_REPORT_NO' AS rno FROM staging_nutrition WHERE coalesce(raw_data->>'ITEM_REPORT_NO','')<>'')
SELECT nd.product_id, p.normalized_name AS nname, p.normalized_maker AS nmaker
FROM nutrition_data nd JOIN products p ON p.product_id=nd.product_id
WHERE nd.data_source='public_nutrition'
  AND (p.c005_report_no IS NULL OR p.c005_report_no NOT IN (SELECT rno FROM sr));
CREATE INDEX ON orphan_ids(product_id);
CREATE INDEX ON orphan_ids(nname,nmaker);

-- 1. 백업
DROP TABLE IF EXISTS nutrition_data_orphan_backup_20260625;
CREATE TABLE nutrition_data_orphan_backup_20260625 AS
  SELECT nd.*, now() AS backed_up_at FROM nutrition_data nd
  WHERE nd.product_id IN (SELECT product_id FROM orphan_ids);

-- 2. staging 정규화
DROP TABLE IF EXISTS s_norm;
CREATE TEMP TABLE s_norm AS
  SELECT s.id, (s.db_class_nm='품목대표') AS is_rep, s.raw_data->>'UPDATE_DATE' AS upd,
    s.calories,s.total_fat,s.saturated_fat,s.trans_fat,s.cholesterol,
    s.sodium,s.total_carbs,s.total_sugars,s.dietary_fiber,s.protein,
    lower(regexp_replace(split_part(s.food_nm_kr,'_',-1),'[^a-z0-9가-힣ㄱ-ㅎㅏ-ㅣ]','','g')) AS nname,
    lower(regexp_replace(coalesce(s.maker_nm,''),'[^a-z0-9가-힣ㄱ-ㅎㅏ-ㅣ]','','g')) AS nmaker
  FROM staging_nutrition s
  WHERE s.db_class_nm='상용제품' AND coalesce(s.maker_nm,'')<>'' AND coalesce(s.calories,-1)>=0;
CREATE INDEX ON s_norm(nname,nmaker);

-- 3. 유일·일관 키만 (후보 영양 프로파일이 사실상 동일한 키) — 유일성 게이트
DROP TABLE IF EXISTS s_unique;
CREATE TEMP TABLE s_unique AS
  SELECT DISTINCT ON (nname,nmaker) nname,nmaker,
    calories,total_fat,saturated_fat,trans_fat,cholesterol,sodium,total_carbs,total_sugars,dietary_fiber,protein
  FROM s_norm
  WHERE (nname,nmaker) IN (
    SELECT nname,nmaker FROM s_norm GROUP BY nname,nmaker
    HAVING count(DISTINCT (coalesce(round(calories),0)||'|'||coalesce(round(sodium),0)||'|'||coalesce(round(total_sugars),0)||'|'||coalesce(round(total_carbs),0))) = 1
  )
  ORDER BY nname,nmaker, is_rep DESC, upd DESC NULLS LAST, id;
CREATE INDEX ON s_unique(nname,nmaker);

-- 4a. 유일매칭 orphan → 재유도 (정확값)
UPDATE nutrition_data nd SET
  calories=su.calories, total_fat=su.total_fat, saturated_fat=su.saturated_fat, trans_fat=su.trans_fat,
  cholesterol=su.cholesterol, sodium=su.sodium, total_carbs=su.total_carbs, total_sugars=su.total_sugars,
  dietary_fiber=su.dietary_fiber, protein=su.protein
FROM orphan_ids o JOIN s_unique su ON su.nname=o.nname AND su.nmaker=o.nmaker
WHERE nd.product_id=o.product_id;

-- 4b. 매칭 실패 orphan → 오염필드 NULL (회색). calories/protein/fat 보존(옛 매핑도 정확)
UPDATE nutrition_data nd SET
  total_carbs=NULL, total_sugars=NULL, dietary_fiber=NULL,
  cholesterol=NULL, saturated_fat=NULL, trans_fat=NULL, sodium=NULL
FROM orphan_ids o
WHERE nd.product_id=o.product_id
  AND NOT EXISTS (SELECT 1 FROM s_unique su WHERE su.nname=o.nname AND su.nmaker=o.nmaker);

-- ===== 게이트 =====
-- G1. orphan 처리 내역
SELECT
  (SELECT count(*) FROM orphan_ids) AS orphans_total,
  (SELECT count(*) FROM orphan_ids o JOIN s_unique su ON su.nname=o.nname AND su.nmaker=o.nmaker) AS matched_fixed,
  (SELECT count(*) FROM orphan_ids o WHERE NOT EXISTS (SELECT 1 FROM s_unique su WHERE su.nname=o.nname AND su.nmaker=o.nmaker)) AS unmatched_nulled;

-- G2. 불변식·결측률 (위반 0, 결측률 개선)
SELECT count(*) total,
  round(100.0*count(*) FILTER (WHERE total_sugars IS NULL)/count(*),1) sugar_null,
  round(100.0*count(*) FILTER (WHERE cholesterol  IS NULL)/count(*),1) chol_null,
  count(*) FILTER (WHERE saturated_fat>total_fat+0.5)  sat_gt_fat,
  count(*) FILTER (WHERE total_sugars>total_carbs+0.5) sugar_gt_carb,
  count(*) FILTER (WHERE cholesterol>3000)             chol_unit_err,
  count(*) FILTER (WHERE sodium>100000)                sodium_unit_err
FROM nutrition_data;

-- G3. 엣지 골든 (마요 콜레스테롤>0, 주스 당류>0, 제로콜라 당류=0)
SELECT p.product_name, nd.total_sugars, nd.cholesterol, nd.trans_fat
FROM nutrition_data nd JOIN products p ON p.product_id=nd.product_id
WHERE p.product_name LIKE '%마요네%' OR p.product_name LIKE '%주스%'
   OR p.product_name LIKE '%제로%' OR p.product_name LIKE '%맛동산%'
LIMIT 15;

-- 게이트(불변식 0 + 결측률 개선 + 엣지 상식) 통과 시 COMMIT; 아니면 ROLLBACK;
