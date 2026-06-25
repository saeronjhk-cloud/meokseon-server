-- ============================================================
-- 영양 fuzzy 머지 Tier-1 (이름 정규화 완전일치 + 제조사 ≥0.8) — 2026-06-24
-- 품목보고번호 정확매칭 안 된 상용제품 staging → 동일 제품 products 에 영양 부여.
-- 안전: 이름 exact + 제조사 sim≥0.8 (범용명 과매칭 방지: 제조사 다르면 제외).
-- 규칙: dedup(품목대표→최신), ON CONFLICT 기존보존, per-100g(serving_size='100g').
-- 예상 신규: ~1,448. nutrition_data 40,310 → ~41,758.
-- ============================================================
BEGIN;

WITH unmatched AS (
  SELECT s.id, s.db_class_nm,
         s.calories, s.total_fat, s.saturated_fat, s.trans_fat, s.cholesterol,
         s.sodium, s.total_carbs, s.total_sugars, s.dietary_fiber, s.protein,
         s.raw_data->>'UPDATE_DATE' AS upd,
         lower(regexp_replace(split_part(s.food_nm_kr,'_',-1),'[^a-z0-9가-힣ㄱ-ㅎㅏ-ㅣ]','','g')) AS nname,
         lower(regexp_replace(coalesce(s.maker_nm,''),'[^a-z0-9가-힣ㄱ-ㅎㅏ-ㅣ]','','g')) AS nmaker
  FROM staging_nutrition s
  WHERE s.db_class_nm='상용제품' AND coalesce(s.maker_nm,'')<>''
    AND NOT EXISTS (SELECT 1 FROM products p2
                    WHERE p2.c005_report_no = s.raw_data->>'ITEM_REPORT_NO'
                      AND coalesce(s.raw_data->>'ITEM_REPORT_NO','')<>'')
)
INSERT INTO nutrition_data (
  product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol,
  sodium, total_carbs, total_sugars, dietary_fiber, protein,
  data_source, serving_size, created_at)
SELECT DISTINCT ON (p.product_id)
  p.product_id, u.calories, u.total_fat, u.saturated_fat, u.trans_fat, u.cholesterol,
  u.sodium, u.total_carbs, u.total_sugars, u.dietary_fiber, u.protein,
  'public_nutrition', '100g', now()
FROM unmatched u
JOIN products p ON p.normalized_name = u.nname
WHERE p.is_active = TRUE
  AND similarity(p.normalized_maker, u.nmaker) >= 0.8
ORDER BY p.product_id, (u.db_class_nm='품목대표') DESC, u.upd DESC NULLS LAST, u.id
ON CONFLICT (product_id) DO NOTHING;

-- 검증 1: 전체/소스 카운트 (public_nutrition 가 직전 대비 +INSERT 수)
SELECT count(*) AS total_now,
       count(*) FILTER (WHERE data_source='public_nutrition') AS public_nutrition
FROM nutrition_data;

-- 검증 2: 방금 들어간 8건 스팟체크 (이름·제조사·영양값 육안 확인)
SELECT p.product_id, p.product_name, p.manufacturer, nd.calories, nd.sodium, nd.serving_size
FROM nutrition_data nd JOIN products p ON p.product_id = nd.product_id
WHERE nd.created_at > now() - interval '3 minutes'
ORDER BY nd.created_at DESC LIMIT 8;

-- 이상 없으면 COMMIT;  이상하면 ROLLBACK;
