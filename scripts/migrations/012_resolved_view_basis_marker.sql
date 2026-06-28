-- 012_resolved_view_basis_marker.sql
-- product_nutrition_resolved view 보정 (앱 소비 준비)
-- SOURCE: #2 reconcile §7 + nutritionTrafficLight 무회귀(2026-06-28)
-- 변경:
--   (1) OFF basis_unit='unknown' → serving_size 마커 '100unknown' (이전 NULL).
--       엔진 deriveBasis 가 'per_100_unknown' 으로 인식 → per-100 값 정확 사용 + 절대량 컷오프 스킵(%DV만).
--       (이전 NULL 은 per_serving 으로 오해석되어 per-100 값을 이중변환하는 버그였음.)
--   (2) verified_at 노출(nd 전용) — 앱 신선도(is_stale/is_expired) 판정에 필요(findByBarcode 연결 대비).
-- 격리테이블/브릿지는 011 그대로. 본 마이그레이션은 view 재정의만.

BEGIN;

CREATE OR REPLACE VIEW product_nutrition_resolved AS
WITH nd_one AS (
  SELECT DISTINCT ON (product_id) *
  FROM nutrition_data
  ORDER BY
    product_id,
    CASE data_source::text
      WHEN 'public_nutrition' THEN 1
      WHEN 'ocr_crowdsource'  THEN 2
      WHEN 'public_c005'      THEN 3
      WHEN 'manual_seed'      THEN 4
      ELSE 9
    END,
    created_at DESC NULLS LAST,
    nutrition_id DESC
)
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
  -- 신호등 basis 마커
  CASE
    WHEN nd.product_id IS NOT NULL THEN
      COALESCE(nd.serving_size,
               CASE WHEN p.serving_size IS NULL OR p.serving_size <= 0 THEN NULL
                    ELSE p.serving_size::text END)
    WHEN off.code IS NOT NULL AND off.basis_unit = 'mL' THEN '100ml'
    WHEN off.code IS NOT NULL AND off.basis_unit = 'g'  THEN '100g'
    WHEN off.code IS NOT NULL                           THEN '100unknown'  -- per-100 이나 단위 불명 → 절대량 스킵
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
  -- verified_at 는 맨 끝에 추가(CREATE OR REPLACE VIEW 는 기존 컬럼 재배치/이름변경 불가, 끝 추가만 허용)
  CASE WHEN nd.product_id IS NOT NULL THEN nd.verified_at END                            AS verified_at
FROM products p
LEFT JOIN nd_one nd
       ON nd.product_id = p.product_id
LEFT JOIN openfoodfacts_product_match om
       ON om.product_id = p.product_id
      AND om.decision = 'load'
LEFT JOIN openfoodfacts_nutrition_norm off
       ON off.code = om.code
      AND off.off_grade IN ('A','B')
;

COMMIT;

-- 롤백: 011 의 view 정의로 CREATE OR REPLACE 재실행(verified_at·'100unknown' 제거).
