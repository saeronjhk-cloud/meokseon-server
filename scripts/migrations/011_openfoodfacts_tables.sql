-- 011_openfoodfacts_tables.sql
-- OpenFoodFacts(#2) 통합 — 격리 테이블 + 정체성 브릿지 + source-atomic resolved view
-- SOURCE: D:\먹선\IP\off_integration_v1.md §2,§3 (v1.1) + 자문 reconcile 2026-06-27
-- 원칙: nutrition_data에 OFF 직접 INSERT 금지. 조회 시 resolved view로만 결합(ODbL 격리).
-- 적용 전 검증: eval_set/eval_set_off_v1.md 게이트 통과 + 백업/롤백 준비 + nutrition_data 중복 0 확인.

BEGIN;

-- ── 2.1 원본(ODbL 격리 영역). 덤프 row 투영본 ──────────────────────────────
CREATE TABLE IF NOT EXISTS openfoodfacts_raw (
  code              TEXT PRIMARY KEY,           -- 바코드(EAN)
  raw               JSONB NOT NULL,             -- 게이트 재현 가능한 투영본(이미지 제외)
  last_modified     TIMESTAMPTZ,                -- OFF last_modified_t
  off_snapshot_date DATE NOT NULL,              -- 덤프 스냅샷일
  dump_file_name    TEXT,
  dump_sha256       TEXT,                       -- 덤프 파일 해시
  raw_hash          TEXT,                       -- 이 row 투영본 해시(변경탐지)
  imported_at       TIMESTAMPTZ DEFAULT now()
);

-- ── 2.2 정규화·단위변환본 + 품질등급 ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS openfoodfacts_nutrition_norm (
  code            TEXT PRIMARY KEY REFERENCES openfoodfacts_raw(code) ON DELETE CASCADE,
  calories        NUMERIC,
  protein         NUMERIC,
  total_fat       NUMERIC,
  saturated_fat   NUMERIC,
  trans_fat       NUMERIC,
  total_carbs     NUMERIC,
  total_sugars    NUMERIC,
  dietary_fiber   NUMERIC,
  sodium_mg       NUMERIC,
  cholesterol_mg  NUMERIC,
  basis_amount    INT  NOT NULL DEFAULT 100,    -- 100
  basis_unit      TEXT NOT NULL DEFAULT 'g',    -- 'g' | 'mL' | 'unknown'
  basis_confident BOOLEAN DEFAULT TRUE,         -- basis_unit 확신 여부
  off_grade       TEXT NOT NULL,                -- 'A' | 'B' | 'C' (Reject는 미저장)
  energy_source   TEXT,                         -- 'kcal' | 'kJ_converted'
  parser_version       TEXT,
  normalizer_version   TEXT,
  quality_gate_version TEXT,
  last_modified   TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT off_grade_chk CHECK (off_grade IN ('A','B','C')),
  CONSTRAINT off_basis_unit_chk CHECK (basis_unit IN ('g','mL','unknown'))
);
CREATE INDEX IF NOT EXISTS idx_off_norm_grade ON openfoodfacts_nutrition_norm(off_grade);

-- ── 2.3 정체성 브릿지 (자문 reconcile: view 가 정체성 게이트 결과로만 결합) ──
-- view 가 off.code = p.barcode 만으로 결합하면 신규/변경 제품이 identity 재검증 없이
-- 기존 OFF norm 과 결합되는 사각(B-2)이 생김. → 적재 시점 판정을 이 테이블에 고정,
-- view 는 decision='load' 행으로만 결합. product_fingerprint 로 추후 변경 무효화 탐지.
CREATE TABLE IF NOT EXISTS openfoodfacts_product_match (
  product_id          BIGINT PRIMARY KEY,
  code                TEXT NOT NULL,
  decision            TEXT NOT NULL,            -- load | conflict | skip_identity | skip_reject
  identity            TEXT NOT NULL,            -- accept | review | reject
  off_grade           TEXT,                     -- A|B|C|Reject (감사용, 제약 없음)
  product_fingerprint TEXT NOT NULL,            -- 매칭 시점 제품정체성 해시(변경 탐지)
  off_raw_hash        TEXT,
  snapshot_id         TEXT,
  matched_at          TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT off_match_decision_chk CHECK (decision IN ('load','conflict','skip_identity','skip_reject')),
  CONSTRAINT off_match_identity_chk CHECK (identity IN ('accept','review','reject'))
);
CREATE INDEX IF NOT EXISTS idx_off_match_code ON openfoodfacts_product_match(code);
CREATE INDEX IF NOT EXISTS idx_off_match_decision ON openfoodfacts_product_match(decision);

-- ── 2.4 식약처 vs OFF 충돌 모니터(리뉴얼/오류 탐지 센서) ────────────────────
CREATE TABLE IF NOT EXISTS nutrition_conflict_queue (
  id          SERIAL PRIMARY KEY,
  product_id  INT,
  barcode     TEXT,
  off_code    TEXT,
  field       TEXT,
  kfda_value  NUMERIC,
  off_value   NUMERIC,
  diff_pct    NUMERIC,
  status      TEXT DEFAULT 'pending',          -- pending | reviewed | dismissed
  detected_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conflict_status ON nutrition_conflict_queue(status);

-- products 포인터(선택) — OFF 코드 참조용. 이미 있으면 무시.
ALTER TABLE products ADD COLUMN IF NOT EXISTS off_code TEXT;

-- ── 3. 조회 결합 view (런타임 결합 = Collective DB, ODbL 격리) ──────────────
-- 자문 reconcile 반영:
--   (A-3) source-atomic: nd 있으면 nd 만 사용(필드 혼합 금지). OFF 는 영양 전무 제품에만.
--   (A-2) nd_one: nutrition_data 제품당 1행 보장(DISTINCT ON). UNIQUE 부재 방어.
--   (B-2) OFF 결합은 openfoodfacts_product_match.decision='load' 를 경유(barcode 직결 금지).
--   (A-1) serving_size<=0/NULL 은 NULL 로(엔진 0나눗셈/오해석 차단).
CREATE OR REPLACE VIEW product_nutrition_resolved AS
WITH nd_one AS (
  SELECT DISTINCT ON (product_id) *
  FROM nutrition_data
  ORDER BY
    product_id,
    -- 출처 우선순위(인수인계 §8): 식약처 영양DB > 검증 OCR > C005 > 수동. ::text 캐스트로 enum 값 변경에도 안전.
    CASE data_source::text
      WHEN 'public_nutrition' THEN 1
      WHEN 'ocr_crowdsource'  THEN 2
      WHEN 'public_c005'      THEN 3
      WHEN 'manual_seed'      THEN 4
      ELSE 9
    END,
    created_at DESC NULLS LAST,   -- production nutrition_data 엔 updated_at 없음(006: 001 이상스키마와 상이)
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
  -- 신호등 basis 마커:
  --   nd 있으면 nd.serving_size(식약처/OCR 서빙 문자열, production 에 실존) 우선,
  --     없으면 products.serving_size(>0) 폴백 → 앱의 nutrition.serving_size || product.serving_size 동일.
  --   nd 없고 OFF 면 basis_unit -> '100g'/'100ml'(unknown 은 NULL → 신호등 절대량 미적용).
  --   ※ nd 서빙 문자열의 deriveBasis/calcPer100 의미는 nutritionTrafficLight 무회귀(다음 단계)에서 검증.
  CASE
    WHEN nd.product_id IS NOT NULL THEN
      COALESCE(nd.serving_size,
               CASE WHEN p.serving_size IS NULL OR p.serving_size <= 0 THEN NULL
                    ELSE p.serving_size::text END)
    WHEN off.code IS NOT NULL AND off.basis_unit = 'mL' THEN '100ml'
    WHEN off.code IS NOT NULL AND off.basis_unit = 'g'  THEN '100g'
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
  CASE WHEN nd.product_id IS NULL AND off.code IS NOT NULL THEN 'ODbL-1.0' END            AS source_license
FROM products p
LEFT JOIN nd_one nd
       ON nd.product_id = p.product_id
LEFT JOIN openfoodfacts_product_match om
       ON om.product_id = p.product_id
      AND om.decision = 'load'
LEFT JOIN openfoodfacts_nutrition_norm off
       ON off.code = om.code
      AND off.off_grade IN ('A','B')   -- C는 결합 제외(내부 저장만)
;

COMMIT;

-- 적재 전 필수 점검(중복 0 이어야 함; 아니면 적재 금지):
--   SELECT product_id, COUNT(*) FROM nutrition_data GROUP BY product_id HAVING COUNT(*)>1;

-- 롤백:
--   DROP VIEW IF EXISTS product_nutrition_resolved;
--   DROP TABLE IF EXISTS nutrition_conflict_queue;
--   DROP TABLE IF EXISTS openfoodfacts_product_match;
--   DROP TABLE IF EXISTS openfoodfacts_nutrition_norm;
--   DROP TABLE IF EXISTS openfoodfacts_raw;
--   ALTER TABLE products DROP COLUMN IF EXISTS off_code;
