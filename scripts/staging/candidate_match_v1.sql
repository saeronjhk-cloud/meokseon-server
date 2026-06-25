-- ============================================================
-- 미매칭 영양데이터 → 제품 fuzzy 후보 매칭 (v1) — 2026-06-24
-- 품목보고번호 정확매칭(공공머지) 안 된 staging_nutrition 상용제품을
-- products.search_text(앱 정규화 동일) trigram 유사도로 후보 제시 → 사람 O/X.
-- 정규화 규칙: lower + [^a-z0-9가-힣ㄱ-ㅎㅏ-ㅣ] 제거 (search_normalization_v1).
-- READ-ONLY.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- [COUNT] 후보(유사도 ≥ 0.45)가 잡히는 미매칭 staging 행 수 (규모 파악, 수십초 소요 가능)
WITH unmatched AS (
  SELECT sn.food_cd,
         lower(regexp_replace(
           trim(split_part(sn.food_nm_kr,'_',-1)) || coalesce(sn.maker_nm,''),
           '[^a-z0-9가-힣ㄱ-ㅎㅏ-ㅣ]','','g')) AS sq
  FROM staging_nutrition sn
  WHERE sn.db_class_nm='상용제품'
    AND coalesce(sn.maker_nm,'')<>''
    AND NOT EXISTS (SELECT 1 FROM products p
                    WHERE p.c005_report_no = sn.raw_data->>'ITEM_REPORT_NO'
                      AND coalesce(sn.raw_data->>'ITEM_REPORT_NO','')<>'')
)
SELECT count(DISTINCT u.food_cd) AS staging_with_candidate
FROM unmatched u
JOIN products p ON p.search_text % u.sq
WHERE p.is_active = TRUE
  AND similarity(p.search_text, u.sq) >= 0.45;

-- [LIST] 검토 리스트 (staging 행당 최상위 1건, 유사도 내림차순 상위 200)
WITH unmatched AS (
  SELECT sn.food_cd, sn.food_nm_kr, sn.maker_nm,
         lower(regexp_replace(
           trim(split_part(sn.food_nm_kr,'_',-1)) || coalesce(sn.maker_nm,''),
           '[^a-z0-9가-힣ㄱ-ㅎㅏ-ㅣ]','','g')) AS sq
  FROM staging_nutrition sn
  WHERE sn.db_class_nm='상용제품'
    AND coalesce(sn.maker_nm,'')<>''
    AND NOT EXISTS (SELECT 1 FROM products p
                    WHERE p.c005_report_no = sn.raw_data->>'ITEM_REPORT_NO'
                      AND coalesce(sn.raw_data->>'ITEM_REPORT_NO','')<>'')
)
SELECT DISTINCT ON (u.food_cd)
       u.food_cd, u.food_nm_kr AS staging_name, u.maker_nm AS staging_maker,
       p.product_id, p.product_name, p.manufacturer,
       round(similarity(p.search_text, u.sq)::numeric,3) AS sim
FROM unmatched u
JOIN products p ON p.search_text % u.sq
WHERE p.is_active = TRUE
  AND p.product_id NOT IN (SELECT product_id FROM nutrition_data)
  AND similarity(p.search_text, u.sq) >= 0.45
ORDER BY u.food_cd, similarity(p.search_text, u.sq) DESC
LIMIT 200;
