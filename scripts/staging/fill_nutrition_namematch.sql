-- ============================================================
-- #1 fuzzy 이름매칭으로 영양 채우기 (영양 없는 제품 → staging) — 2026-06-25
-- 대상: nutrition_data 행이 아예 없는 제품(~188k 중 매칭되는 것)
-- 매칭: 정규화 이름 exact + 제조사 exact + 유일·일관 키(영양 변동 없는 키만)
-- 안전: INSERT(ON CONFLICT DO NOTHING), provenance, 불변식 게이트.
-- 자문 GO 후 실행.
-- ============================================================
BEGIN;

-- staging 정규화 (정정 완료된 값)
DROP TABLE IF EXISTS s_norm2;
CREATE TEMP TABLE s_norm2 AS
  SELECT s.id, (s.db_class_nm='품목대표') AS is_rep, s.raw_data->>'UPDATE_DATE' AS upd,
    s.calories,s.total_fat,s.saturated_fat,s.trans_fat,s.cholesterol,
    s.sodium,s.total_carbs,s.total_sugars,s.dietary_fiber,s.protein,
    lower(regexp_replace(split_part(s.food_nm_kr,'_',-1),'[^a-z0-9가-힣ㄱ-ㅎㅏ-ㅣ]','','g')) AS nname,
    lower(regexp_replace(coalesce(s.maker_nm,''),'[^a-z0-9가-힣ㄱ-ㅎㅏ-ㅣ]','','g')) AS nmaker
  FROM staging_nutrition s
  WHERE s.db_class_nm='상용제품' AND coalesce(s.maker_nm,'')<>'' AND coalesce(s.calories,-1)>=0;
CREATE INDEX ON s_norm2(nname,nmaker);

-- 유일·일관 키만 (영양 프로파일 동일) — 유일성 게이트
DROP TABLE IF EXISTS s_uniq2;
CREATE TEMP TABLE s_uniq2 AS
  SELECT DISTINCT ON (nname,nmaker) nname,nmaker,
    calories,total_fat,saturated_fat,trans_fat,cholesterol,sodium,total_carbs,total_sugars,dietary_fiber,protein
  FROM s_norm2
  WHERE (nname,nmaker) IN (
    SELECT nname,nmaker FROM s_norm2 GROUP BY nname,nmaker
    HAVING count(DISTINCT (coalesce(round(calories),0)||'|'||coalesce(round(sodium),0)||'|'||coalesce(round(total_sugars),0)||'|'||coalesce(round(total_carbs),0)||'|'||coalesce(round(saturated_fat*10),0)))=1
  )
  ORDER BY nname,nmaker, is_rep DESC, upd DESC NULLS LAST, id;
CREATE INDEX ON s_uniq2(nname,nmaker);

-- 사전 카운트: 채워질 제품 수
SELECT count(*) AS will_insert
FROM products p JOIN s_uniq2 su ON su.nname=p.normalized_name AND su.nmaker=p.normalized_maker
WHERE p.is_active AND coalesce(p.normalized_name,'')<>''
  AND NOT EXISTS (SELECT 1 FROM nutrition_data n WHERE n.product_id=p.product_id);

-- INSERT (영양 없는 제품만, 제품당 1행)
INSERT INTO nutrition_data
  (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol,
   sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source, serving_size, created_at)
SELECT DISTINCT ON (p.product_id)
  p.product_id, su.calories, su.total_fat, su.saturated_fat, su.trans_fat, su.cholesterol,
  su.sodium, su.total_carbs, su.total_sugars, su.dietary_fiber, su.protein,
  'public_nutrition', '100g', now()
FROM products p JOIN s_uniq2 su ON su.nname=p.normalized_name AND su.nmaker=p.normalized_maker
WHERE p.is_active AND coalesce(p.normalized_name,'')<>''
  AND NOT EXISTS (SELECT 1 FROM nutrition_data n WHERE n.product_id=p.product_id)
ON CONFLICT (product_id) DO NOTHING;

-- 게이트: 불변식 + 결측 + 골든
SELECT count(*) total,
  count(*) FILTER (WHERE saturated_fat>total_fat+0.5)  sat_gt_fat,
  count(*) FILTER (WHERE total_sugars>total_carbs+0.5) sugar_gt_carb,
  count(*) FILTER (WHERE sodium>100000)                sodium_unit_err
FROM nutrition_data;
-- 게이트 통과 시 COMMIT; 아니면 ROLLBACK;
