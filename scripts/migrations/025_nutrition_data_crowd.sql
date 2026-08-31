-- ============================================================
-- 025: `DS-7`·`DS-8` — 제보 영양의 «격리 홈» + 뷰 7-way 통합
-- ============================================================
-- 왜 (세션66 계약 C3 · 설계 §11-B):
--   제이 결정 2026-08-30 — **「물리 분리한다」** + **「공공데이터와 승인된 제보는 통합되도록
--   설계되어야 해」** + **「환산해서 무조건 통합」**.
--   이 셋은 모순이 아니다. **물리적으로 나누고, 논리적으로 뷰가 합친다.**
--   이 저장소의 기존 3계열 패턴 그대로다 — `openfoodfacts_nutrition_norm` ·
--   `import_nutrition` · `entity_nutrition_profiles` 셋 다 별도 테이블인데
--   `product_nutrition_resolved` 가 합쳐서 내보낸다. **제보만 그 체계 «밖»에 있었다.**
--   ⇒ 025 는 새 패턴이 아니라 「제보를 그 체계 안으로 들여놓는 것」이다.
--
-- 무엇을 (둘):
--   1) `nutrition_data_crowd` 신설 — 승인된 제보 영양의 격리 홈.
--      이후 `nutrition_data` 는 **공공 전용**이 된다(026 이 CHECK 로 못 박는다).
--   2) `product_nutrition_resolved` 뷰를 6-way → **7-way** 로 개정.
--      최상위 tier 를 「공공 ∪ 승인제보」 **한 덩어리**로 만든다.
--
-- ★★ `DS-8` 통합 규칙 = **필드 단위 COALESCE, 공공 우선**
--     값(영양소 X) = COALESCE(nd.X, ndc.X)
--   | 공공에 값이 있다              | 공공 값 (제보가 «덮지 못한다»)          |
--   | 공공 행은 있는데 그 칸이 비었다 | ★ 제보 값이 채운다 ← 이것이 「통합」이다 |
--   | 공공 행 자체가 없다            | 제보 값                                |
--   | 둘 다 없다                    | 하위 tier(OFF → 수입식품 → 엔티티)      |
--
--   ⇒ **`U65-6`(공공데이터 보호가 1회용)이 «구조적으로» 소멸한다.**
--     제보가 공공 테이블을 쓰지 않으므로 `data_source` 를 덮을 대상이 아예 없고,
--     `COALESCE(nd.X, ndc.X)` 는 공공이 있으면 **언제나** 공공을 낸다. 1회용이 아니라 영구다.
--
-- ★★ `DS-9` 환산은 **여기서 하지 않는다.** 승인 시점(`contributionApply`)에 하고
--   결과를 `basis_stored` 로 못 박는다. 뷰는 환산을 «모른다» — 단순 COALESCE 만 한다.
--   이유 셋: (1) 이미 62% 병목인 뷰에 산술을 얹지 않는다(`productModel.js` 주석의 그 지점)
--            (2) 환산 근거가 나중에 바뀌면 과거 값이 «조용히» 달라진다 — 저장 시점에 고정해야 재현된다
--            (3) 되돌리려면 「무엇을 무엇으로 나눴는지」가 행에 남아 있어야 한다
--
-- ⚠⚠ 대가를 기록한다 — **뷰 조인이 6-way → 7-way 가 된다.**
--   `productModel.js` 가 「진짜 병목은 뷰 조인」이라고 실측해 둔 바로 그 지점이다.
--   (그 주석의 「4-way」는 015 시절 값이고 018 적용 후 이미 6-way 였다 — 즉 62% 는 옛 낙관값이다.)
--   ⇒ `DS-7` 은 성능을 **확실히** 나쁘게 만든다. 제이가 대가를 알고 택한 것으로 남긴다.
--   완화: `uq_ndc_product` 로 행 증식이 없고, 이 테이블은 당분간 한 자릿수 행이다. **재측정 지점.**
--
-- ⚠⚠ 영양 컬럼 목록이 두 테이블에 «중복»된다(설계 §11-B-5 위험 2).
--   한쪽에만 컬럼을 추가하면 **그 영양소만 통합에서 조용히 빠진다.**
--   ⇒ 완화 장치: `tests/test_contribution_split_schema.js` 가
--     `information_schema.columns` 로 두 테이블의 영양 15컬럼 **이름·타입**을 대조한다.
--
-- 선행: 024(`contribution_review`) — `review_id` FK 가 그것을 참조한다.
-- 후행: 026 이 기존 제보 행을 여기로 옮기고 `nutrition_data` 에 CHECK 를 건다.
--
-- ⛔ `npm run migrate` 체인에 이어 붙였는지 확인할 것. `package.json` `_note:migrate2`.
-- ============================================================

BEGIN;

-- ── 묶음 1) nutrition_data_crowd — 승인된 제보 영양의 격리 홈 ──
-- ⚠⚠ 영양 컬럼 15개의 «이름과 타입»은 `nutrition_data` 와 **정확히 같아야 한다.**
--   뷰가 `COALESCE(nd.X, ndc.X)` 로 합치기 때문이다. 스키마 대조 테스트가 이것을 단정한다.
CREATE TABLE IF NOT EXISTS nutrition_data_crowd (
  crowd_nutrition_id BIGSERIAL PRIMARY KEY,
  product_id      BIGINT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  calories        NUMERIC,
  total_fat       NUMERIC,
  saturated_fat   NUMERIC,
  trans_fat       NUMERIC,
  cholesterol     NUMERIC,
  sodium          NUMERIC,
  total_carbs     NUMERIC,
  total_sugars    NUMERIC,
  added_sugars    NUMERIC,
  dietary_fiber   NUMERIC,
  protein         NUMERIC,
  calcium         NUMERIC,
  iron            NUMERIC,
  vitamin_d       NUMERIC,
  potassium       NUMERIC,
  serving_size    VARCHAR,
  ocr_confidence  INTEGER,
  verified_at     TIMESTAMPTZ,
  contribution_id BIGINT REFERENCES contributions(contribution_id) ON DELETE SET NULL,
  review_id       BIGINT REFERENCES contribution_review(review_id) ON DELETE SET NULL,
  basis_original  TEXT,
  basis_stored    TEXT NOT NULL,
  convert_factor  NUMERIC,
  convert_note    TEXT,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by      TEXT
);

-- ★ 제품당 승인된 제보 영양은 최대 1행 — `nutrition_data` 와 같다.
--   뷰가 1:1 로 조인할 수 있는 근거이자 행 증식 방어다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ndc_product ON nutrition_data_crowd (product_id);


-- ── 묶음 2) 주석 ─────────────────────────────────────────────
COMMENT ON TABLE nutrition_data_crowd IS
  '승인된 제보 영양의 격리 홈. 025(2026-08-30 세션66 C3 · DS-7). '
  'nutrition_data 는 이후 공공 전용이다(026 CHECK). 뷰가 COALESCE(nd.X, ndc.X) 로 통합한다.';

COMMENT ON COLUMN nutrition_data_crowd.basis_stored IS
  '★ 이 «행에 저장된 값»의 기준(per_100g / per_100ml / per_serving / as_stored …). NOT NULL. '
  '기준을 모르는 값을 저장하면 DS-9 통합이 거짓말을 한다 — **모르면 저장하지 않는다.**';

COMMENT ON COLUMN nutrition_data_crowd.basis_original IS
  '제보 원본의 기준. basis_stored 와 다르면 convert_factor 로 환산된 것이다.';

COMMENT ON COLUMN nutrition_data_crowd.convert_factor IS
  '환산 계수. 1.0 = 환산하지 않았다. 승인 시점에 고정한다 — 뷰는 환산을 모른다(DS-9).';

COMMENT ON COLUMN nutrition_data_crowd.convert_note IS
  '무엇으로 나눴는가(총량·1회제공량의 «출처»). 되돌리기와 사후 재현의 유일한 근거다.';

COMMENT ON COLUMN nutrition_data_crowd.serving_size IS
  'basis 마커 «문자열»(100g / 100ml / …) — nutrition_data.serving_size 와 같은 뜻이다. '
  '⛔ 숫자로 해석하지 말 것. 숫자로 바꾸면 전 제품 basis 가 무너진다.';


-- ── 묶음 3) product_nutrition_resolved — 6-way → 7-way 개정 ──
-- 베이스: `000_baseline.sql` §5-1 (= `018_product_entities.sql` 의 최종본).
-- 바꾼 것은 «다섯 가지»뿐이고, 그 외 컬럼의 이름·타입·순서는 **한 글자도 안 건드렸다.**
--   (1) FROM 절에 `nutrition_data_crowd ndc` 조인 1개 추가 (`nd` 바로 뒤)
--   (2) 영양 10컬럼의 최상위 tier 를 「공공 ∪ 제보」로 — `COALESCE(nd.X, ndc.X)`
--   (3) `serving_size` 도 같은 형태
--   (4) `resolved_source` 에 `'ocr_crowdsource'` 분기 · `verified_at` 을 COALESCE 로
--   (5) 하위 tier 판정의 `nd.product_id IS NULL` 을 전부 `... AND ndc.product_id IS NULL` 로
--       + **맨 끝에** `crowd_merged` 1컬럼 추가
--
-- ★★ `resolved_source` 에 `'public_plus_crowd'` 같은 «새 값»을 만들지 않았다.
--   앱과 서비스가 이 값으로 분기하는데, 모르는 값이 오면 **조용히 어느 분기에도 안 걸린다.**
--   「통합됐다」는 사실은 새 컬럼 `crowd_merged` 가 말한다.
--
-- ★ (5)를 안 하면 **제보만 있는 제품에 OFF 라이선스(ODbL-1.0)·신뢰도가 잘못 붙는다.**
--   ODbL 는 「이 값의 출처가 OpenFoodFacts 다」라는 «법적» 표시다. 제보 값에 붙으면 거짓 표시다.
--
-- ⚠ `CREATE OR REPLACE VIEW` 는 컬럼을 «끝에 추가»하는 것만 허용한다.
--   실패하면 `DROP VIEW ... CASCADE` 로 도망가지 말고 **원인을 진단할 것** —
--   CASCADE 는 의존 객체를 조용히 지운다.
--
-- ⛔⛔ 배선 시 반드시 함께 고칠 것 — **`000_baseline.sql` 이 2회차에서 죽는다.**
--   `migrate` 체인은 `000_baseline.sql` 로 시작하고, 그 안에도 같은 이름의
--   `CREATE OR REPLACE VIEW product_nutrition_resolved`(24컬럼)가 있다.
--   1회차: baseline 24컬럼 → 025 가 25컬럼으로 교체 (정상)
--   2회차: baseline 이 25컬럼 뷰를 24컬럼으로 되돌리려 한다
--          → **ERROR: cannot drop columns from view** → `ON_ERROR_STOP=1` 로 체인이 죽는다.
--   ⇒ `real-postgres` job 의 「마이그레이션 2회차 — 멱등한가」와
--      `npm run verify:fresh-schema`(§A 멱등성)가 **둘 다 빨강**이 된다.
--   ★ 고치는 법(실측으로 3회차까지 확인함): `000_baseline.sql` 의
--     `CREATE OR REPLACE VIEW product_nutrition_resolved AS` **바로 앞 줄**에
--        DROP VIEW IF EXISTS product_nutrition_resolved;
--     한 줄을 넣는다. 빈 DB 1회차에는 무동작이고, 2회차부터 baseline 이 자기 정의를
--     다시 세운 뒤 025 가 25컬럼으로 올린다.
--     ⚠ `CASCADE` 를 붙이지 말 것 — 의존 객체가 생기면 «조용히 지우지 말고» 죽어야 한다.
--   ⚠ 이 파일 안에서는 고칠 수 없다 — baseline 이 025 보다 «먼저» 돌기 때문이다.
--     `tests/test_contribution_split_schema.js` §13 이 이것을 단정한다(고치기 전까지 빨강).
--
-- ⚠ 하위 tier 컬럼명이 다른 둘: `sodium` → `off.sodium_mg` · `cholesterol` → `off.cholesterol_mg`.
-- ⚠ 뷰가 노출하는 영양 컬럼은 **10개**다. `added_sugars`·`calcium`·`iron`·`vitamin_d`·
--   `potassium` 은 018 뷰에 «없다» — 여기서도 **추가하지 않는다**(회귀 축을 늘리지 않는다).
CREATE OR REPLACE VIEW product_nutrition_resolved AS
SELECT
  p.product_id,
  p.barcode,
  CASE WHEN nd.product_id IS NOT NULL OR ndc.product_id IS NOT NULL THEN COALESCE(nd.calories, ndc.calories)           WHEN off.code IS NOT NULL THEN off.calories       WHEN imp.food_cd IS NOT NULL THEN imp.calories      ELSE ent.calories      END AS calories,
  CASE WHEN nd.product_id IS NOT NULL OR ndc.product_id IS NOT NULL THEN COALESCE(nd.protein, ndc.protein)             WHEN off.code IS NOT NULL THEN off.protein        WHEN imp.food_cd IS NOT NULL THEN imp.protein       ELSE ent.protein       END AS protein,
  CASE WHEN nd.product_id IS NOT NULL OR ndc.product_id IS NOT NULL THEN COALESCE(nd.total_fat, ndc.total_fat)         WHEN off.code IS NOT NULL THEN off.total_fat      WHEN imp.food_cd IS NOT NULL THEN imp.total_fat     ELSE ent.total_fat     END AS total_fat,
  CASE WHEN nd.product_id IS NOT NULL OR ndc.product_id IS NOT NULL THEN COALESCE(nd.saturated_fat, ndc.saturated_fat) WHEN off.code IS NOT NULL THEN off.saturated_fat  WHEN imp.food_cd IS NOT NULL THEN imp.saturated_fat ELSE ent.saturated_fat END AS saturated_fat,
  CASE WHEN nd.product_id IS NOT NULL OR ndc.product_id IS NOT NULL THEN COALESCE(nd.trans_fat, ndc.trans_fat)         WHEN off.code IS NOT NULL THEN off.trans_fat      WHEN imp.food_cd IS NOT NULL THEN imp.trans_fat     ELSE ent.trans_fat     END AS trans_fat,
  CASE WHEN nd.product_id IS NOT NULL OR ndc.product_id IS NOT NULL THEN COALESCE(nd.total_carbs, ndc.total_carbs)     WHEN off.code IS NOT NULL THEN off.total_carbs    WHEN imp.food_cd IS NOT NULL THEN imp.total_carbs   ELSE ent.total_carbs   END AS total_carbs,
  CASE WHEN nd.product_id IS NOT NULL OR ndc.product_id IS NOT NULL THEN COALESCE(nd.total_sugars, ndc.total_sugars)   WHEN off.code IS NOT NULL THEN off.total_sugars   WHEN imp.food_cd IS NOT NULL THEN imp.total_sugars  ELSE ent.total_sugars  END AS total_sugars,
  CASE WHEN nd.product_id IS NOT NULL OR ndc.product_id IS NOT NULL THEN COALESCE(nd.dietary_fiber, ndc.dietary_fiber) WHEN off.code IS NOT NULL THEN off.dietary_fiber  WHEN imp.food_cd IS NOT NULL THEN imp.dietary_fiber ELSE ent.dietary_fiber END AS dietary_fiber,
  CASE WHEN nd.product_id IS NOT NULL OR ndc.product_id IS NOT NULL THEN COALESCE(nd.sodium, ndc.sodium)               WHEN off.code IS NOT NULL THEN off.sodium_mg      WHEN imp.food_cd IS NOT NULL THEN imp.sodium        ELSE ent.sodium        END AS sodium,
  CASE WHEN nd.product_id IS NOT NULL OR ndc.product_id IS NOT NULL THEN COALESCE(nd.cholesterol, ndc.cholesterol)     WHEN off.code IS NOT NULL THEN off.cholesterol_mg WHEN imp.food_cd IS NOT NULL THEN imp.cholesterol   ELSE ent.cholesterol   END AS cholesterol,
  CASE
    WHEN nd.product_id IS NOT NULL OR ndc.product_id IS NOT NULL THEN
      COALESCE(nd.serving_size, ndc.serving_size,
               CASE WHEN p.serving_size IS NULL OR p.serving_size <= 0 THEN NULL
                    ELSE p.serving_size::text END)
    WHEN off.code IS NOT NULL AND off.basis_unit = 'mL' THEN '100ml'
    WHEN off.code IS NOT NULL AND off.basis_unit = 'g'  THEN '100g'
    WHEN off.code IS NOT NULL                           THEN '100unknown'
    WHEN imp.food_cd IS NOT NULL                        THEN imp.serving_size
    WHEN ent.entity_id IS NOT NULL THEN CASE ent.basis WHEN 'per_100ml' THEN '100ml' WHEN 'per_100g' THEN '100g' ELSE '100unknown' END
    ELSE NULL
  END AS serving_size,
  -- ★ 어휘를 «늘리지 않는다». 공공 행이 있으면 종전과 완전히 같은 값이 나간다.
  CASE
    WHEN nd.product_id IS NOT NULL  THEN nd.data_source::text
    WHEN ndc.product_id IS NOT NULL THEN 'ocr_crowdsource'
    WHEN off.code IS NOT NULL       THEN 'openfoodfacts'
    WHEN imp.food_cd IS NOT NULL    THEN 'import_nutrition'
    WHEN ent.entity_id IS NOT NULL  THEN 'entity_profile'
    ELSE NULL
  END AS resolved_source,
  CASE WHEN nd.product_id IS NULL AND ndc.product_id IS NULL AND off.code IS NOT NULL THEN off.off_grade END       AS off_grade,
  CASE WHEN nd.product_id IS NULL AND ndc.product_id IS NULL AND off.code IS NOT NULL THEN off.basis_confident END AS basis_confident,
  CASE
    WHEN nd.product_id IS NULL AND ndc.product_id IS NULL AND off.code IS NOT NULL THEN 'low'
    WHEN nd.product_id IS NULL AND ndc.product_id IS NULL AND off.code IS NULL AND imp.food_cd IS NOT NULL THEN 'low'
    WHEN nd.product_id IS NULL AND ndc.product_id IS NULL AND off.code IS NULL AND imp.food_cd IS NULL AND ent.entity_id IS NOT NULL THEN 'low'
  END AS confidence,
  CASE
    WHEN nd.product_id IS NULL AND ndc.product_id IS NULL AND off.code IS NOT NULL THEN 'ODbL-1.0'
    WHEN nd.product_id IS NULL AND ndc.product_id IS NULL AND off.code IS NULL AND imp.food_cd IS NOT NULL THEN 'KOGL-1'
    WHEN nd.product_id IS NULL AND ndc.product_id IS NULL AND off.code IS NULL AND imp.food_cd IS NULL AND ent.entity_id IS NOT NULL THEN 'KOGL-1'
  END AS source_license,
  CASE WHEN nd.product_id IS NOT NULL OR ndc.product_id IS NOT NULL THEN COALESCE(nd.verified_at, ndc.verified_at) END AS verified_at,
  CASE WHEN nd.product_id IS NULL AND ndc.product_id IS NULL AND off.code IS NULL AND imp.food_cd IS NOT NULL THEN im.match_quality  END AS import_match_quality,
  CASE WHEN nd.product_id IS NULL AND ndc.product_id IS NULL AND off.code IS NULL AND imp.food_cd IS NOT NULL THEN im.source_quality END AS import_source_quality,
  (nd.product_id IS NULL AND ndc.product_id IS NULL AND off.code IS NULL AND imp.food_cd IS NULL AND ent.entity_id IS NOT NULL) AS is_inherited,
  CASE WHEN nd.product_id IS NULL AND ndc.product_id IS NULL AND off.code IS NULL AND imp.food_cd IS NULL AND ent.entity_id IS NOT NULL THEN ent.entity_id END AS entity_id,
  CASE WHEN nd.product_id IS NULL AND ndc.product_id IS NULL AND off.code IS NULL AND imp.food_cd IS NULL AND ent.entity_id IS NOT NULL THEN ent.source_product_ids END AS entity_source_product_ids,
  -- ── 신규(끝 추가): 「공공과 제보가 실제로 합쳐졌다」는 사실 ──
  --   ⚠ resolved_source 에 새 어휘를 만드는 대신 이 컬럼이 그것을 말한다.
  (nd.product_id IS NOT NULL AND ndc.product_id IS NOT NULL) AS crowd_merged
FROM products p
LEFT JOIN nutrition_data nd
       ON nd.product_id = p.product_id
LEFT JOIN nutrition_data_crowd ndc
       ON ndc.product_id = p.product_id
LEFT JOIN openfoodfacts_product_match om
       ON om.product_id = p.product_id
      AND om.decision = 'load'
LEFT JOIN openfoodfacts_nutrition_norm off
       ON off.code = om.code
      AND off.off_grade IN ('A','B')
LEFT JOIN import_nutrition_product_match im
       ON im.product_id = p.product_id
      AND im.decision = 'accept'
LEFT JOIN import_nutrition imp
       ON imp.food_cd = im.import_key
LEFT JOIN product_entity_members pem
       ON pem.product_id = p.product_id
      AND pem.status = 'approved'
LEFT JOIN entity_nutrition_profiles ent
       ON ent.entity_id = pem.entity_id
      AND ent.status = 'approved'
      AND ent.conflict_status = 'none';

COMMIT;


-- ── 검증 (실행 후 이 SELECT 들로 확인) ───────────────────────
-- 기대 1: 25행. 앞 24행의 이름·순서가 018 과 «같고» 25번째가 crowd_merged 다.
SELECT ordinal_position, column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'product_nutrition_resolved'
 ORDER BY ordinal_position;

-- 기대 2: 0행 — 두 테이블의 영양 15컬럼이 이름·타입 모두 같다.
--   여기서 행이 나오면 뷰의 COALESCE 가 그 영양소를 «조용히» 빠뜨리고 있다는 뜻이다.
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'nutrition_data'
   AND column_name IN ('calories','total_fat','saturated_fat','trans_fat','cholesterol',
                       'sodium','total_carbs','total_sugars','added_sugars','dietary_fiber',
                       'protein','calcium','iron','vitamin_d','potassium')
EXCEPT
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'nutrition_data_crowd';


-- ── 롤백 ─────────────────────────────────────────────────────
--  ⚠ 026 을 «먼저» 되돌린 뒤에만 가능하다(CHECK 제약 + 이관된 행).
--  1) `000_baseline.sql` §5-1 의 CREATE OR REPLACE VIEW 를 재실행한다(= 24컬럼 복원).
--     ⛔ DROP VIEW ... CASCADE 를 쓰지 말 것 — 의존 객체를 조용히 지운다.
--  2) DROP TABLE IF EXISTS nutrition_data_crowd;
--  (products · nutrition_data 의 행은 이 마이그레이션이 건드리지 않는다)
