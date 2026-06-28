-- 013_resolved_view_perf.sql
-- product_nutrition_resolved 성능 개선: nd_one(DISTINCT ON CTE) → nutrition_data 직접 JOIN
-- SOURCE: 세션8 EXPLAIN — nd_one 이 매 조회마다 nutrition_data 전수 처리(33ms). 바코드 필터 미푸시.
-- 전제: production nutrition_data.product_id 가 UNIQUE(인덱스 nutrition_data_product_id_key 확인됨)
--       → 제품당 1행 보장이므로 DISTINCT ON(행 증식 방어) 불필요. 직접 JOIN 시 플래너가 product_id 푸시 → 인덱스 단건.
-- ⚠ 적용 전 확인(UNIQUE 없으면 적용 금지 — 011/012 의 nd_one 유지):
--   SELECT conname FROM pg_constraint WHERE conrelid='nutrition_data'::regclass AND contype='u';
--   또는: SELECT indexname,indexdef FROM pg_indexes WHERE tablename='nutrition_data' AND indexdef LIKE '%UNIQUE%';
-- 컬럼/순서/타입은 012 와 동일(CREATE OR REPLACE 호환) — FROM/JOIN 만 변경.

BEGIN;

CREATE OR REPLACE VIEW product_nutrition_resolved AS
SELECT
  p.product_id,
  p.barcode,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.calories      ELSE off.calories       END AS calories,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.protein       ELSE off.protein        END AS protein,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.total_fat     ELSE off.total_fat      END AS total_fat,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.saturated_fat ELSE off.saturated_fat  END AS saturated_fat,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.trans_fat     ELSE off.trans_fat      END AS trans_fat,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.total_carbs   ELSE off.total_carbs    END AS total_carbs,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.total_sugars  ELSE off.total_sugars   END AS total_sugars,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.dietary_fiber ELSE off.dietary_fiber  END AS dietary_fiber,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.sodium        ELSE off.sodium_mg      END AS sodium,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.cholesterol   ELSE off.cholesterol_mg END AS cholesterol,
  CASE
    WHEN nd.product_id IS NOT NULL THEN
      COALESCE(nd.serving_size,
               CASE WHEN p.serving_size IS NULL OR p.serving_size <= 0 THEN NULL
                    ELSE p.serving_size::text END)
    WHEN off.code IS NOT NULL AND off.basis_unit = 'mL' THEN '100ml'
    WHEN off.code IS NOT NULL AND off.basis_unit = 'g'  THEN '100g'
    WHEN off.code IS NOT NULL                           THEN '100unknown'
    ELSE NULL
  END AS serving_size,
  CASE
    WHEN nd.product_id IS NOT NULL THEN nd.data_source::text
    WHEN off.code IS NOT NULL THEN 'openfoodfacts'
    ELSE NULL
  END AS resolved_source,
  CASE WHEN nd.product_id IS NULL AND off.code IS NOT NULL THEN off.off_grade END        AS off_grade,
  CASE WHEN nd.product_id IS NULL AND off.code IS NOT NULL THEN off.basis_confident END  AS basis_confident,
  CASE WHEN nd.product_id IS NULL AND off.code IS NOT NULL THEN 'low'  END                AS confidence,
  CASE WHEN nd.product_id IS NULL AND off.code IS NOT NULL THEN 'ODbL-1.0' END            AS source_license,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.verified_at END                            AS verified_at
FROM products p
LEFT JOIN nutrition_data nd
       ON nd.product_id = p.product_id
LEFT JOIN openfoodfacts_product_match om
       ON om.product_id = p.product_id
      AND om.decision = 'load'
LEFT JOIN openfoodfacts_nutrition_norm off
       ON off.code = om.code
      AND off.off_grade IN ('A','B')
;

COMMIT;

-- 롤백: 012 의 view 정의(nd_one CTE 포함)로 CREATE OR REPLACE 재실행.
