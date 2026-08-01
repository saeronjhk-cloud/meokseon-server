-- ============================================================================
-- 000_baseline.sql — 운영 스키마 정본 baseline (세션47 신설)
-- ============================================================================
-- ★ 왜 이 파일이 생겼나
--   세션46 §5 가 실측으로 확인한 것: **001~020 마이그레이션만으로는 운영 스키마가
--   재현되지 않는다.** 빈 DB 에 001→020 을 순서대로 돌리면 7개가 실패하고,
--   성공한 것으로 만든 DB 에서도 크라우드 merge(ON CONFLICT)와 바코드 조회
--   (`products.image_url`·`additives.e_number`)가 전부 죽는다.
--   운영에는 손으로 넣고 마이그레이션에 남기지 않은 것이 수십 건이다.
--
-- ★ 이 파일의 정본 근거
--   `IP/production_schema_2026-07-31.txt`
--   (= `scripts/75-dump-production-schema.js` 가 Railway 운영 DB 를 읽기 전용으로 뜬 것)
--   덤프가 담고 있는 9개 테이블(products·nutrition_data·nutrition_traffic_light·
--   product_allergens·product_ingredients·product_additives·additives·contributions·users)은
--   **덤프를 글자 그대로** 옮겼다. 001 과 다르면 **덤프가 이긴다.**
--   덤프에 없는 부수 테이블(pulse·staging·openfoodfacts·import·entity …)은
--   해당 마이그레이션(007·010·011·014·015·016·017·018·019)의 최종 상태를 옮겼다.
--
-- ★ 001~020 과의 관계
--   - 001~020 은 **역사로 남긴다. 지우지 않는다.** 어떤 결정이 언제 왜 내려졌는지가 거기 있다.
--   - 다만 **빈 DB 를 세우는 경로에서는 더 이상 쓰지 않는다.** 이 파일 하나가 그 역할을 한다.
--     (근거: 001 의 `users.user_id` 는 UUID 인데 운영은 bigint 다. 001 을 돌리면
--      007 의 FK 가 깨지고, 011 이 `nutrition_data.serving_size` 를 참조해 011~019 가
--      연쇄 붕괴한다. 001 을 「고쳐서」 운영과 맞추면 그건 이미 001 이 아니다.)
--   - 운영 DB 는 이미 이 상태다. **운영에 이 파일을 돌릴 일은 없다.**
--     그래도 실수로 돌아가도 무해하도록 **전부 멱등**하게 썼다:
--       · CREATE TABLE IF NOT EXISTS
--       · 테이블마다 ADD COLUMN IF NOT EXISTS 로 「빠진 컬럼만」 메우는 절을 따로 둠
--         (여기서는 NOT NULL 을 걸지 않는다 — 기존 행이 있는 운영에서 실패하기 때문)
--       · CREATE UNIQUE INDEX IF NOT EXISTS / DO 블록 제약 존재 검사
--       · CREATE OR REPLACE VIEW
--
-- ★ pglite(테스트) 대응
--   pglite 는 `pg_trgm`·`uuid-ossp` 확장을 탑재하지 않는다(실측: extension is not available).
--   그래서 확장 생성은 예외를 삼키고, `gin_trgm_ops` 인덱스는 **확장이 있을 때만** 만든다.
--   → 이 파일 하나로 운영(Postgres)과 테스트(pglite) 양쪽이 선다. 별도 파일이 필요 없다.
--
-- ★ 덤프로 알 수 없어 추정이 섞인 곳 (다음 덤프 때 확인할 것 — 파일 하단 §9 에 목록)
--   information_schema.columns 의 data_type 은 길이·정밀도를 담지 않는다.
--   그래서 `character varying` 은 길이 없는 VARCHAR, `numeric` 은 정밀도 없는 NUMERIC 으로 썼다.
--   ENUM 라벨도 덤프에 없어 001/004/008 + 실제 INSERT 문에서 복원했다.
--
-- 실행:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/000_baseline.sql
-- ============================================================================


-- ============================================================================
-- §1. 확장 — 없으면 조용히 건너뛴다 (pglite 대응)
-- ============================================================================
DO $baseline$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '000_baseline: pg_trgm 확장을 만들 수 없습니다(%). trigram 인덱스는 건너뜁니다.', SQLERRM;
  END;
END
$baseline$;

-- ⚠ uuid-ossp 는 **일부러 만들지 않는다.**
--   001 은 `users.user_id UUID DEFAULT uuid_generate_v4()` 였지만
--   운영 실측은 `bigint + users_user_id_seq` 다(세션46 §5-5). 운영에서 uuid-ossp 는 쓰이지 않는다.


-- ============================================================================
-- §2. ENUM 타입
-- ============================================================================
-- ⚠ 덤프는 enum 라벨을 담지 않는다. 아래 라벨은
--   001(원본) + 004('disputed') + 008('orange') + 실제 INSERT 문에서 복원한 것이다.
DO $baseline$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE t.typname = 'data_source_type' AND n.nspname = 'public') THEN
    CREATE TYPE public.data_source_type AS ENUM (
      'public_c005', 'public_nutrition', 'ocr_crowdsource', 'open_food_facts', 'manual_seed'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE t.typname = 'verification_status' AND n.nspname = 'public') THEN
    CREATE TYPE public.verification_status AS ENUM (
      'unverified', 'partial', 'verified', 'admin_verified', 'disputed'   -- 'disputed' = 004
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE t.typname = 'food_category' AND n.nspname = 'public') THEN
    CREATE TYPE public.food_category AS ENUM (
      'general', 'beverage', 'dried', 'fermented', 'sauce', 'nuts',
      'dairy', 'juice', 'whole_grain', 'alcohol', 'supplement', 'raw_ingredient'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE t.typname = 'traffic_light_color' AND n.nspname = 'public') THEN
    CREATE TYPE public.traffic_light_color AS ENUM ('green', 'yellow', 'red', 'gray');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE t.typname = 'mfras_grade' AND n.nspname = 'public') THEN
    -- ★ 순서가 운영과 같다: 008 이 「production 실측 = (green, blue, yellow, red)」라고 적었고
    --   거기에 'orange' 를 덧붙였다. 'blue' 는 v1 잔재로 **사용 금지**지만 지울 수 없다.
    CREATE TYPE public.mfras_grade AS ENUM ('green', 'blue', 'yellow', 'red', 'orange');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE t.typname = 'user_profile_type' AND n.nspname = 'public') THEN
    CREATE TYPE public.user_profile_type AS ENUM (
      'adult', 'pregnant', 'infant', 'child', 'hypertension', 'diabetes', 'kidney'
    );
  END IF;
END
$baseline$;

-- 이미 타입이 있는 DB(=운영)에서 라벨만 빠져 있을 때를 메운다.
-- ALTER TYPE ... ADD VALUE 는 트랜잭션 블록 제약이 있어 DO 안에 넣지 않는다.
ALTER TYPE public.verification_status ADD VALUE IF NOT EXISTS 'disputed';        -- 004
ALTER TYPE public.mfras_grade         ADD VALUE IF NOT EXISTS 'orange';          -- 008
-- ⚠ 추정: scripts/51-enrich-miss-queue.js:124 가 products 에
--   `data_source='c005_miss_queue'` 로 직접 INSERT 한다. 그 스크립트가 운영에서 돌았으므로
--   운영 enum 에는 이 라벨이 있을 수밖에 없다. 덤프로는 확인되지 않아 여기에 명시해 둔다.
ALTER TYPE public.data_source_type    ADD VALUE IF NOT EXISTS 'c005_miss_queue';


-- ============================================================================
-- §3. 핵심 9테이블 — IP/production_schema_2026-07-31.txt 를 그대로 옮긴 것
-- ============================================================================

-- ── 3-1. products ───────────────────────────────────────────────────────────
-- 001 대비 운영이 +13컬럼이다(image_url·normalized_*·pog_daycnt·prms_dt_i1250·
-- hieng_lntrt_dvs_nm·dispos·frmlc_mtrqlt·merged_at·merge_sources_count·search_text·off_code …).
-- ★ image_url 은 `productModel.findByBarcode`·`getRecent`·`searchByName` 이 SELECT 하는데
--   마이그레이션 전체 grep 0건이었다(세션47 3차 검증). 운영에만 있던 대표적 컬럼.
CREATE TABLE IF NOT EXISTS products (
  product_id             BIGSERIAL PRIMARY KEY,
  barcode                VARCHAR,
  product_name           VARCHAR NOT NULL,
  brand                  VARCHAR,
  manufacturer           VARCHAR,
  food_type              VARCHAR,
  food_category          food_category DEFAULT 'general',
  serving_size           NUMERIC,
  serving_unit           VARCHAR DEFAULT 'g',
  total_content          NUMERIC,
  content_unit           VARCHAR DEFAULT 'g',
  servings_per_container NUMERIC,
  image_url              TEXT,
  image_front_url        TEXT,
  image_label_url        TEXT,
  data_source            data_source_type NOT NULL,
  verification           verification_status DEFAULT 'unverified',
  verify_count           INTEGER DEFAULT 0,
  is_active              BOOLEAN DEFAULT TRUE,
  created_at             TIMESTAMPTZ DEFAULT now(),
  updated_at             TIMESTAMPTZ DEFAULT now(),
  c005_report_no         VARCHAR,
  public_food_cd         VARCHAR,
  normalized_name        TEXT,
  normalized_maker       TEXT,
  pog_daycnt             VARCHAR DEFAULT NULL,
  prms_dt_i1250          VARCHAR DEFAULT NULL,
  hieng_lntrt_dvs_nm     VARCHAR DEFAULT NULL,
  dispos                 TEXT    DEFAULT NULL,
  frmlc_mtrqlt           TEXT    DEFAULT NULL,
  merged_at              TIMESTAMPTZ,
  merge_sources_count    INTEGER DEFAULT 0,
  off_code               TEXT
);

-- search_text 는 **생성 컬럼**이다(009). 아무 코드도 여기에 값을 쓰지 않는다
-- (grep: `SET search_text` 0건 · 읽기만 productModel.searchByName). 그래서 STORED 로 복원한다.
-- ⚠ 덤프의 information_schema 는 생성 컬럼 여부를 출력하지 않았다 — 근거는 009 와 코드다.
ALTER TABLE products ADD COLUMN IF NOT EXISTS search_text TEXT
  GENERATED ALWAYS AS (
    lower(
      regexp_replace(
        COALESCE(product_name, '') || ' ' ||
        COALESCE(manufacturer, '') || ' ' ||
        COALESCE(brand,        '') || ' ' ||
        COALESCE(food_type,    ''),
        '[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ]', '', 'g'
      )
    )
  ) STORED;

-- 「빠진 컬럼만 메우는」 절 — 이미 products 가 있는 DB(운영·구 테스트 DB)를 위한 것.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS barcode                VARCHAR,
  ADD COLUMN IF NOT EXISTS brand                  VARCHAR,
  ADD COLUMN IF NOT EXISTS manufacturer           VARCHAR,
  ADD COLUMN IF NOT EXISTS food_type              VARCHAR,
  ADD COLUMN IF NOT EXISTS food_category          food_category DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS serving_size           NUMERIC,
  ADD COLUMN IF NOT EXISTS serving_unit           VARCHAR DEFAULT 'g',
  ADD COLUMN IF NOT EXISTS total_content          NUMERIC,
  ADD COLUMN IF NOT EXISTS content_unit           VARCHAR DEFAULT 'g',
  ADD COLUMN IF NOT EXISTS servings_per_container NUMERIC,
  ADD COLUMN IF NOT EXISTS image_url              TEXT,
  ADD COLUMN IF NOT EXISTS image_front_url        TEXT,
  ADD COLUMN IF NOT EXISTS image_label_url        TEXT,
  ADD COLUMN IF NOT EXISTS verification           verification_status DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS verify_count           INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_active              BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS created_at             TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at             TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS c005_report_no         VARCHAR,
  ADD COLUMN IF NOT EXISTS public_food_cd         VARCHAR,
  ADD COLUMN IF NOT EXISTS normalized_name        TEXT,
  ADD COLUMN IF NOT EXISTS normalized_maker       TEXT,
  ADD COLUMN IF NOT EXISTS pog_daycnt             VARCHAR,
  ADD COLUMN IF NOT EXISTS prms_dt_i1250          VARCHAR,
  ADD COLUMN IF NOT EXISTS hieng_lntrt_dvs_nm     VARCHAR,
  ADD COLUMN IF NOT EXISTS dispos                 TEXT,
  ADD COLUMN IF NOT EXISTS frmlc_mtrqlt           TEXT,
  ADD COLUMN IF NOT EXISTS merged_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS merge_sources_count    INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS off_code               TEXT;

-- ★ 부분 UNIQUE. `scripts/51-enrich-miss-queue.js` 의
--   `ON CONFLICT (barcode) WHERE barcode IS NOT NULL` 이 이것을 요구한다.
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode_unique
  ON products (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_category  ON products (food_category);
CREATE INDEX IF NOT EXISTS idx_products_report_no ON products (c005_report_no);
CREATE INDEX IF NOT EXISTS idx_products_normalized_maker ON products (normalized_maker);


-- ── 3-2. nutrition_data ─────────────────────────────────────────────────────
-- ★★ 001 과 다른 점 (전부 운영 기준으로 맞춘다)
--   · `serving_size` 가 **있다**. VARCHAR 다(신호등 basis 마커 문자열 — '100g' 등).
--     011~018 의 `product_nutrition_resolved` 뷰가 이 컬럼을 참조한다.
--     어느 마이그레이션도 만들지 않아 011 이 실패했고 012·013·015·018 이 연쇄 붕괴했다.
--     실제 출처: `scripts/merge/01b-hotfix.js:47` 이 운영에 직접 ALTER 했다.
--   · `verified_at` 이 있다(012 이후 뷰가 SELECT).
--   · `updated_at` 은 **없다**(mergeService:435 주석이 맞았다).
--   · `per_serving` 은 **없다**(006 §3 이 예고한 대로 코드에서 제거됨).
--   · `data_source` 는 NULL 허용 + DEFAULT 'public_nutrition' (001 은 NOT NULL 이었다).
--   · `ocr_confidence` 는 INTEGER (001 은 DECIMAL(5,2)).
CREATE TABLE IF NOT EXISTS nutrition_data (
  nutrition_id   BIGSERIAL PRIMARY KEY,
  product_id     BIGINT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  calories       NUMERIC,
  total_fat      NUMERIC,
  saturated_fat  NUMERIC,
  trans_fat      NUMERIC,
  cholesterol    NUMERIC,
  sodium         NUMERIC,
  total_carbs    NUMERIC,
  total_sugars   NUMERIC,
  added_sugars   NUMERIC,
  dietary_fiber  NUMERIC,
  protein        NUMERIC,
  calcium        NUMERIC,
  iron           NUMERIC,
  vitamin_d      NUMERIC,
  potassium      NUMERIC,
  data_source    data_source_type DEFAULT 'public_nutrition',
  verified_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT now(),
  serving_size   VARCHAR DEFAULT NULL,
  ocr_confidence INTEGER
);

ALTER TABLE nutrition_data
  ADD COLUMN IF NOT EXISTS added_sugars   NUMERIC,
  ADD COLUMN IF NOT EXISTS calcium        NUMERIC,
  ADD COLUMN IF NOT EXISTS iron           NUMERIC,
  ADD COLUMN IF NOT EXISTS vitamin_d      NUMERIC,
  ADD COLUMN IF NOT EXISTS potassium      NUMERIC,
  ADD COLUMN IF NOT EXISTS verified_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at     TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS serving_size   VARCHAR,      -- ★ 세션46 §5-3
  ADD COLUMN IF NOT EXISTS ocr_confidence INTEGER;      -- 006

-- ★★★ 세션46 §5-2 (A) 의 1번 — `mergeService.js:442` · `crowdsourceService.js:308` 의
--   `ON CONFLICT (product_id)` 가 이것 없이는 통째로 실패한다.
--   운영에는 `nutrition_data_product_id_key` 로 이미 있다(013 이 주석에 적어둔 그것).
CREATE UNIQUE INDEX IF NOT EXISTS nutrition_data_product_id_key ON nutrition_data (product_id);
CREATE INDEX IF NOT EXISTS idx_nutrition_product ON nutrition_data (product_id);


-- ── 3-3. nutrition_traffic_light ────────────────────────────────────────────
-- ★★ 001 과 거의 다른 테이블이다. 운영 기준:
--   · PK 는 `tl_id` (001 은 result_id)
--   · `food_category`(001 은 food_category_used) · `multi_serving_count` · `evaluated_at` 이 있다
--     — 셋 다 `productModel.upsertTrafficLight` 가 INSERT 하는데 마이그레이션에 없었다(§5-3)
--   · `context_messages` 는 JSONB (001 은 TEXT[])
--   · `profile_type` · `*_per_100` · `calories_pct_dv` · `trans_fat_amount` 는 **없다**
CREATE TABLE IF NOT EXISTS nutrition_traffic_light (
  tl_id               BIGSERIAL PRIMARY KEY,
  product_id          BIGINT REFERENCES products(product_id) ON DELETE CASCADE,
  food_category       food_category,
  sodium_color        traffic_light_color,
  sodium_pct_dv       NUMERIC,
  sodium_basis        VARCHAR,
  sugars_color        traffic_light_color,
  sugars_pct_dv       NUMERIC,
  sugars_basis        VARCHAR,
  sat_fat_color       traffic_light_color,
  sat_fat_pct_dv      NUMERIC,
  sat_fat_basis       VARCHAR,
  total_fat_color     traffic_light_color,
  total_fat_pct_dv    NUMERIC,
  total_fat_basis     VARCHAR,
  cholesterol_color   traffic_light_color,
  cholesterol_pct_dv  NUMERIC,
  protein_color       traffic_light_color,
  protein_pct_dv      NUMERIC,
  fiber_color         traffic_light_color,
  fiber_pct_dv        NUMERIC,
  trans_fat_color     traffic_light_color,
  is_dried_exception  BOOLEAN DEFAULT FALSE,
  context_messages    JSONB DEFAULT '[]'::jsonb,
  multi_serving_count NUMERIC,
  evaluated_at        TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE nutrition_traffic_light
  ADD COLUMN IF NOT EXISTS food_category       food_category,
  ADD COLUMN IF NOT EXISTS multi_serving_count NUMERIC,
  ADD COLUMN IF NOT EXISTS evaluated_at        TIMESTAMPTZ DEFAULT now();

-- ★★★ §5-2 (A) 의 2번 — `productModel.js:340` 의 `ON CONFLICT (product_id)`.
CREATE UNIQUE INDEX IF NOT EXISTS nutrition_traffic_light_product_id_key
  ON nutrition_traffic_light (product_id);


-- ── 3-4. product_allergens (005 + 020) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_allergens (
  id             BIGSERIAL PRIMARY KEY,
  product_id     BIGINT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  allergen_name  VARCHAR NOT NULL,
  source_count   INTEGER DEFAULT 1,
  status         VARCHAR DEFAULT 'candidate',
  detected_via   VARCHAR,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now(),
  evidence_level VARCHAR NOT NULL DEFAULT 'contains'    -- 020
);

ALTER TABLE product_allergens
  ADD COLUMN IF NOT EXISTS evidence_level VARCHAR NOT NULL DEFAULT 'contains';

DO $baseline$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'product_allergens_evidence_level_chk'
                    AND conrelid = 'product_allergens'::regclass) THEN
    ALTER TABLE product_allergens
      ADD CONSTRAINT product_allergens_evidence_level_chk
      CHECK (evidence_level IN ('contains', 'inferred', 'may_contain'));
  END IF;
END
$baseline$;

CREATE INDEX IF NOT EXISTS idx_product_allergens_product ON product_allergens (product_id);
CREATE INDEX IF NOT EXISTS idx_product_allergens_level   ON product_allergens (product_id, evidence_level);
-- `mergeService.js:550,570` 의 ON CONFLICT (product_id, allergen_name)
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_allergens_unique
  ON product_allergens (product_id, allergen_name);

COMMENT ON COLUMN product_allergens.evidence_level IS
  'contains=직접 함유(라벨 명시) | inferred=원재료 추정 | may_contain=혼입 가능(같은 제조시설). '
  '병합 시 강한 등급으로만 올린다. 기본값 contains — 005 이후 기존 행의 의미가 그것이다.';


-- ── 3-5. product_ingredients ────────────────────────────────────────────────
-- ★★ 001 과 다르다. 운영 기준:
--   · PK 는 `id` (001 은 ingredient_id)
--   · `product_id` 는 **integer** (001·다른 테이블은 bigint) — 운영 실측 그대로 둔다
--   · `parsed_ingredients` 는 **jsonb** (001 은 TEXT[])
--   · `source` 가 있다. `data_source` 는 **없다**.
--     ★ 006 이 "production 에 이미 있음" 이라고 주석만 달고 반영하지 않은 그 컬럼이다(§5-3).
--       `mergeService.js:468` · `crowdsourceService.js:331` 이 여기에 INSERT 한다.
--   · `prdlst_report_no` 가 있다(C002 조인 키).
CREATE TABLE IF NOT EXISTS product_ingredients (
  id                 BIGSERIAL PRIMARY KEY,
  product_id         INTEGER REFERENCES products(product_id) ON DELETE CASCADE,
  raw_text           TEXT NOT NULL,
  parsed_ingredients JSONB,
  prdlst_report_no   VARCHAR,
  source             VARCHAR DEFAULT 'c002',
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE product_ingredients
  ADD COLUMN IF NOT EXISTS prdlst_report_no VARCHAR,
  ADD COLUMN IF NOT EXISTS source           VARCHAR DEFAULT 'c002',
  ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_product_ingredients_pid    ON product_ingredients (product_id);
CREATE INDEX IF NOT EXISTS idx_product_ingredients_report ON product_ingredients (prdlst_report_no);


-- ── 3-6. additives ──────────────────────────────────────────────────────────
-- ★★ 001 과 이름부터 다르다. 운영 기준:
--   · `e_number` · `description` · `max_daily_intake` · `risk_grade` · `risk_color` 가 있다
--     ★ `productModel.getAdditives` 가 `a.e_number` · `a.description` · `a.max_daily_intake` 를
--       SELECT 하는데 마이그레이션 grep 0건이었다(세션47 3차 검증).
--       001 은 `ins_number` · `description_ko` 라는 **다른 이름**을 만들었다 → 조회 전건 500.
--   · 001 의 dim1_adi~dim5_exposure · codex_status · source_docs · risk_summary · is_active 는 **없다**.
--   · 008 이 붙인 v2.0 컬럼 28개가 그대로 있다.
CREATE TABLE IF NOT EXISTS additives (
  additive_id        BIGSERIAL PRIMARY KEY,
  name_ko            VARCHAR NOT NULL,
  name_en            VARCHAR,
  e_number           VARCHAR,
  cas_number         VARCHAR,
  risk_grade         INTEGER DEFAULT 0,
  risk_color         VARCHAR DEFAULT 'gray',
  category           VARCHAR,
  description        TEXT,
  max_daily_intake   VARCHAR,
  created_at         TIMESTAMPTZ DEFAULT now(),
  aliases            TEXT[],
  ins_no             VARCHAR,
  section            VARCHAR,
  page               INTEGER,
  usage_standard_raw TEXT,
  purposes           TEXT[],
  max_limits         JSONB,
  has_quantity_limit BOOLEAN,
  usage_type         VARCHAR,
  adi_type           VARCHAR,
  adi_value          VARCHAR,
  edi                VARCHAR,
  iarc_group         VARCHAR,
  genotox_status     VARCHAR,
  regulatory_status  VARCHAR,
  klimisch_level     INTEGER,
  last_eval_year     INTEGER,
  data_sufficiency   VARCHAR,
  dim_a_toxicity     NUMERIC,
  dim_b_exposure     NUMERIC,
  dim_c_genotox      NUMERIC,
  dim_d_regulation   NUMERIC,
  dim_e_data_quality NUMERIC,
  mfras_total        NUMERIC,
  mfras_grade        mfras_grade,
  mfras_override     VARCHAR,
  mfras_rationales   JSONB,
  evaluated_at       TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE additives
  ADD COLUMN IF NOT EXISTS e_number           VARCHAR,
  ADD COLUMN IF NOT EXISTS description        TEXT,
  ADD COLUMN IF NOT EXISTS max_daily_intake   VARCHAR,
  ADD COLUMN IF NOT EXISTS risk_grade         INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS risk_color         VARCHAR DEFAULT 'gray',
  ADD COLUMN IF NOT EXISTS name_en            VARCHAR,
  ADD COLUMN IF NOT EXISTS aliases            TEXT[],
  ADD COLUMN IF NOT EXISTS ins_no             VARCHAR,
  ADD COLUMN IF NOT EXISTS section            VARCHAR,
  ADD COLUMN IF NOT EXISTS page               INTEGER,
  ADD COLUMN IF NOT EXISTS usage_standard_raw TEXT,
  ADD COLUMN IF NOT EXISTS purposes           TEXT[],
  ADD COLUMN IF NOT EXISTS max_limits         JSONB,
  ADD COLUMN IF NOT EXISTS has_quantity_limit BOOLEAN,
  ADD COLUMN IF NOT EXISTS usage_type         VARCHAR,
  ADD COLUMN IF NOT EXISTS adi_type           VARCHAR,
  ADD COLUMN IF NOT EXISTS adi_value          VARCHAR,
  ADD COLUMN IF NOT EXISTS edi                VARCHAR,
  ADD COLUMN IF NOT EXISTS iarc_group         VARCHAR,
  ADD COLUMN IF NOT EXISTS genotox_status     VARCHAR,
  ADD COLUMN IF NOT EXISTS regulatory_status  VARCHAR,
  ADD COLUMN IF NOT EXISTS klimisch_level     INTEGER,
  ADD COLUMN IF NOT EXISTS last_eval_year     INTEGER,
  ADD COLUMN IF NOT EXISTS data_sufficiency   VARCHAR,
  ADD COLUMN IF NOT EXISTS dim_a_toxicity     NUMERIC,
  ADD COLUMN IF NOT EXISTS dim_b_exposure     NUMERIC,
  ADD COLUMN IF NOT EXISTS dim_c_genotox      NUMERIC,
  ADD COLUMN IF NOT EXISTS dim_d_regulation   NUMERIC,
  ADD COLUMN IF NOT EXISTS dim_e_data_quality NUMERIC,
  ADD COLUMN IF NOT EXISTS mfras_total        NUMERIC,
  ADD COLUMN IF NOT EXISTS mfras_grade        mfras_grade,
  ADD COLUMN IF NOT EXISTS mfras_override     VARCHAR,
  ADD COLUMN IF NOT EXISTS mfras_rationales   JSONB,
  ADD COLUMN IF NOT EXISTS evaluated_at       TIMESTAMPTZ DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS additives_name_ko_unique ON additives (name_ko);
CREATE INDEX IF NOT EXISTS idx_additives_ins_no      ON additives (ins_no) WHERE ins_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_additives_mfras_grade ON additives (mfras_grade);
CREATE INDEX IF NOT EXISTS idx_additives_section     ON additives (section);


-- ── 3-7. product_additives ──────────────────────────────────────────────────
-- ★ 운영은 (product_id, additive_id) 복합 PK 다. 001 의 `id BIGSERIAL` · `created_at` 은 **없다**.
--   `amount` · `unit` 이 있다.
CREATE TABLE IF NOT EXISTS product_additives (
  product_id    BIGINT NOT NULL REFERENCES products(product_id)  ON DELETE CASCADE,
  additive_id   BIGINT NOT NULL REFERENCES additives(additive_id) ON DELETE CASCADE,
  amount        NUMERIC,
  unit          VARCHAR,
  detected_name VARCHAR,
  confidence    INTEGER,
  PRIMARY KEY (product_id, additive_id)
);

ALTER TABLE product_additives
  ADD COLUMN IF NOT EXISTS amount        NUMERIC,
  ADD COLUMN IF NOT EXISTS unit          VARCHAR,
  ADD COLUMN IF NOT EXISTS detected_name VARCHAR,   -- 006
  ADD COLUMN IF NOT EXISTS confidence    INTEGER;   -- 006

-- 운영에는 PK 와 별개로 같은 열쌍의 UNIQUE 인덱스가 하나 더 있다(006 이 만든 것).
-- `mergeService.js:490` · `crowdsourceService.js:358` 의 ON CONFLICT 대상.
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_additives_unique
  ON product_additives (product_id, additive_id);


-- ── 3-8. users ──────────────────────────────────────────────────────────────
-- ★★★ 001 과 **타입 자체가 다르다.** 001: `UUID PRIMARY KEY DEFAULT uuid_generate_v4()`.
--   운영: `bigint + users_user_id_seq`. 001 을 쓰면 007 의 FK(`pulse_consents.user_id BIGINT`)가
--   깨진다 — 빈 DB 체인에서 007 이 실패한 진짜 이유가 이것이다(pglite 오탐이 아니었다).
-- ★ 운영 컬럼은 8개뿐이다. 001 의 nickname·allergies·dietary_prefs·health_goals·
--   disclaimer_*·is_premium·premium_expires_at·daily_scan_* · fi_bank_id · updated_at 은 **없다.**
CREATE TABLE IF NOT EXISTS users (
  user_id               BIGSERIAL PRIMARY KEY,
  firebase_uid          VARCHAR,
  email                 VARCHAR,
  display_name          VARCHAR,
  profile_type          user_profile_type DEFAULT 'adult',
  created_at            TIMESTAMPTZ DEFAULT now(),
  last_login            TIMESTAMPTZ,
  pulse_consent_version VARCHAR
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS firebase_uid          VARCHAR,   -- ★ 세션46 §5-3
  ADD COLUMN IF NOT EXISTS display_name          VARCHAR,   -- ★ 세션46 §5-3
  ADD COLUMN IF NOT EXISTS last_login            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pulse_consent_version VARCHAR;   -- 007

-- ★★★ §5-2 (A) 의 3번 — `userRoutes.js:38` 의 `ON CONFLICT (firebase_uid)`.
CREATE UNIQUE INDEX IF NOT EXISTS users_firebase_uid_key ON users (firebase_uid);
CREATE INDEX IF NOT EXISTS idx_users_pulse_consent
  ON users (pulse_consent_version) WHERE pulse_consent_version IS NOT NULL;


-- ── 3-9. contributions ──────────────────────────────────────────────────────
-- ★ 운영: user_id·product_id·contribution_type 전부 **NULL 허용**. `points_earned` 는 없다.
--   001 은 셋 다 NOT NULL 이었다.
CREATE TABLE IF NOT EXISTS contributions (
  contribution_id   BIGSERIAL PRIMARY KEY,
  user_id           BIGINT REFERENCES users(user_id),
  product_id        BIGINT REFERENCES products(product_id),
  contribution_type VARCHAR,
  data              JSONB,                              -- 005
  status            VARCHAR DEFAULT 'pending',          -- 005
  created_at        TIMESTAMPTZ DEFAULT now(),
  device_id         VARCHAR                             -- 005
);

ALTER TABLE contributions
  ADD COLUMN IF NOT EXISTS data      JSONB,
  ADD COLUMN IF NOT EXISTS status    VARCHAR DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS device_id VARCHAR;

CREATE INDEX IF NOT EXISTS idx_contributions_product ON contributions (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contributions_device  ON contributions (device_id, product_id);
CREATE INDEX IF NOT EXISTS idx_contributions_status  ON contributions (status);


-- ============================================================================
-- §4. 덤프에 없는 부수 테이블 — 마이그레이션 최종 상태를 옮긴 것
--     (75-dump 스크립트의 TABLES 배열이 9개뿐이라 덤프에 안 나왔을 뿐,
--      운영에는 있다. run-33b/33d/38/44/48 .bat 이 015~019 를 운영에 적용했다.)
-- ============================================================================

-- ── 4-1. 신호등 config (001 + 002 씨드) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS nutrition_config (
  config_id      SERIAL PRIMARY KEY,
  nutrient       VARCHAR(30) NOT NULL,
  threshold      VARCHAR(20) NOT NULL,
  basis          VARCHAR(20) NOT NULL,
  value          NUMERIC(10,2) NOT NULL,
  unit           VARCHAR(10),
  profile        VARCHAR(30) DEFAULT 'adult',
  effective_from DATE NOT NULL,
  effective_to   DATE,
  source         TEXT,
  notes          TEXT,
  updated_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_config_nutrient ON nutrition_config (nutrient, basis, profile);
CREATE UNIQUE INDEX IF NOT EXISTS idx_config_unique
  ON nutrition_config (nutrient, threshold, basis, profile, effective_from);

CREATE TABLE IF NOT EXISTS context_messages (
  message_id    SERIAL PRIMARY KEY,
  food_category food_category NOT NULL,
  nutrient      VARCHAR(30),
  message_ko    TEXT NOT NULL,
  display_type  VARCHAR(20) DEFAULT 'tooltip',
  is_active     BOOLEAN DEFAULT TRUE,
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ocr_sanity_limits (
  limit_id        SERIAL PRIMARY KEY,
  nutrient        VARCHAR(30) NOT NULL,
  per_serving_max NUMERIC(10,2),
  per_100g_max    NUMERIC(10,2),
  unit            VARCHAR(10),
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS dried_food_keywords (
  keyword_id     SERIAL PRIMARY KEY,
  keyword        VARCHAR(50) NOT NULL,
  category_match food_category DEFAULT 'dried',
  priority       INTEGER DEFAULT 1
);


-- ── 4-2. scan_history · favorites (001, 단 user_id 는 BIGINT) + 007 ─────────
CREATE TABLE IF NOT EXISTS scan_history (
  scan_id        BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(user_id),
  product_id     BIGINT NOT NULL REFERENCES products(product_id),
  scan_type      VARCHAR(20) NOT NULL,
  scanned_at     TIMESTAMPTZ DEFAULT now(),
  pulse_eligible BOOLEAN NOT NULL DEFAULT FALSE     -- 007
);
ALTER TABLE scan_history
  ADD COLUMN IF NOT EXISTS pulse_eligible BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_scan_history_user    ON scan_history (user_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_history_product ON scan_history (product_id);
CREATE INDEX IF NOT EXISTS idx_scan_history_pulse_eligible
  ON scan_history (scanned_at DESC, product_id) WHERE pulse_eligible = TRUE;

CREATE TABLE IF NOT EXISTS favorites (
  favorite_id BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(user_id),
  product_id  BIGINT NOT NULL REFERENCES products(product_id),
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, product_id)
);


-- ── 4-3. pulse_consents (007) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pulse_consents (
  consent_id      BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  consent_version VARCHAR(20) NOT NULL,
  consent_scope   VARCHAR(50) NOT NULL,
  event_type      VARCHAR(20) NOT NULL,
  event_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  client_ip_hash  VARCHAR(64),
  user_agent      VARCHAR(500)
);
CREATE INDEX IF NOT EXISTS idx_pulse_consents_user    ON pulse_consents (user_id, event_at DESC);
CREATE INDEX IF NOT EXISTS idx_pulse_consents_version ON pulse_consents (consent_version, event_type);


-- ── 4-4. staging (010 + merge/01-migration.js 가 운영에 추가한 정규화 컬럼) ──
CREATE TABLE IF NOT EXISTS staging_c005 (
  id               BIGSERIAL PRIMARY KEY,
  bar_cd           VARCHAR(20),
  prdlst_nm        VARCHAR(500),
  bssh_nm          VARCHAR(200),
  prdlst_dcnm      VARCHAR(100),
  prdlst_report_no VARCHAR(50),
  raw_data         JSONB,
  loaded_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staging_c005_barcode ON staging_c005 (bar_cd);

CREATE TABLE IF NOT EXISTS staging_nutrition (
  id              BIGSERIAL PRIMARY KEY,
  food_cd         VARCHAR(30),
  food_nm_kr      VARCHAR(500),
  db_class_nm     VARCHAR(100),
  food_or_nm      VARCHAR(200),
  maker_nm        VARCHAR(200),
  serving_size    VARCHAR(50),
  calories        NUMERIC(10,2),
  protein         NUMERIC(10,2),
  total_fat       NUMERIC(10,2),
  total_carbs     NUMERIC(10,2),
  total_sugars    NUMERIC(10,2),
  sodium          NUMERIC(10,2),
  cholesterol     NUMERIC(10,2),
  saturated_fat   NUMERIC(10,2),
  trans_fat       NUMERIC(10,2),
  dietary_fiber   NUMERIC(10,2),
  raw_data        JSONB,
  loaded_at       TIMESTAMPTZ DEFAULT now(),
  normalized_name TEXT,
  normalized_maker TEXT
);
ALTER TABLE staging_nutrition
  ADD COLUMN IF NOT EXISTS normalized_name  TEXT,
  ADD COLUMN IF NOT EXISTS normalized_maker TEXT;
CREATE INDEX IF NOT EXISTS idx_staging_nutrition_foodcd ON staging_nutrition (food_cd);
CREATE INDEX IF NOT EXISTS idx_staging_nutrition_maker  ON staging_nutrition (normalized_maker);

CREATE TABLE IF NOT EXISTS staging_ingredients (
  id               BIGSERIAL PRIMARY KEY,
  prdlst_report_no VARCHAR(50),
  prdlst_nm        VARCHAR(500),
  rawmtrl_nm       TEXT,
  bssh_nm          VARCHAR(200),
  prms_dt          VARCHAR(20),
  raw_data         JSONB,
  loaded_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staging_ingredients_report ON staging_ingredients (prdlst_report_no);


-- ── 4-5. Open Food Facts (011) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS openfoodfacts_raw (
  code              TEXT PRIMARY KEY,
  raw               JSONB NOT NULL,
  last_modified     TIMESTAMPTZ,
  off_snapshot_date DATE NOT NULL,
  dump_file_name    TEXT,
  dump_sha256       TEXT,
  raw_hash          TEXT,
  imported_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS openfoodfacts_nutrition_norm (
  code                 TEXT PRIMARY KEY REFERENCES openfoodfacts_raw(code) ON DELETE CASCADE,
  calories             NUMERIC,
  protein              NUMERIC,
  total_fat            NUMERIC,
  saturated_fat        NUMERIC,
  trans_fat            NUMERIC,
  total_carbs          NUMERIC,
  total_sugars         NUMERIC,
  dietary_fiber        NUMERIC,
  sodium_mg            NUMERIC,
  cholesterol_mg       NUMERIC,
  basis_amount         INTEGER NOT NULL DEFAULT 100,
  basis_unit           TEXT NOT NULL DEFAULT 'g',
  basis_confident      BOOLEAN DEFAULT TRUE,
  off_grade            TEXT NOT NULL,
  energy_source        TEXT,
  parser_version       TEXT,
  normalizer_version   TEXT,
  quality_gate_version TEXT,
  last_modified        TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT off_grade_chk      CHECK (off_grade IN ('A','B','C')),
  CONSTRAINT off_basis_unit_chk CHECK (basis_unit IN ('g','mL','unknown'))
);
CREATE INDEX IF NOT EXISTS idx_off_norm_grade ON openfoodfacts_nutrition_norm (off_grade);

CREATE TABLE IF NOT EXISTS openfoodfacts_product_match (
  product_id          BIGINT PRIMARY KEY,
  code                TEXT NOT NULL,
  decision            TEXT NOT NULL,
  identity            TEXT NOT NULL,
  off_grade           TEXT,
  product_fingerprint TEXT NOT NULL,
  off_raw_hash        TEXT,
  snapshot_id         TEXT,
  matched_at          TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT off_match_decision_chk CHECK (decision IN ('load','conflict','skip_identity','skip_reject')),
  CONSTRAINT off_match_identity_chk CHECK (identity IN ('accept','review','reject'))
);
CREATE INDEX IF NOT EXISTS idx_off_match_code     ON openfoodfacts_product_match (code);
CREATE INDEX IF NOT EXISTS idx_off_match_decision ON openfoodfacts_product_match (decision);

CREATE TABLE IF NOT EXISTS nutrition_conflict_queue (
  id          SERIAL PRIMARY KEY,
  product_id  INTEGER,
  barcode     TEXT,
  off_code    TEXT,
  field       TEXT,
  kfda_value  NUMERIC,
  off_value   NUMERIC,
  diff_pct    NUMERIC,
  status      TEXT DEFAULT 'pending',
  detected_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conflict_status ON nutrition_conflict_queue (status);


-- ── 4-6. 건강기능식품 부가정보 (014) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_hff_info (
  product_id       BIGINT PRIMARY KEY REFERENCES products(product_id) ON DELETE CASCADE,
  prdlst_report_no VARCHAR(50),
  primary_fnclty   TEXT,
  intake_method    TEXT,
  intake_caution   TEXT,
  shape_name       VARCHAR(100),
  shelf_life       VARCHAR(100),
  source           VARCHAR(20) NOT NULL DEFAULT 'c003',
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_hff_report ON product_hff_info (prdlst_report_no);


-- ── 4-7. 수입식품 영양 브리지 (015) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS import_nutrition (
  food_cd               TEXT PRIMARY KEY,
  food_nm_kr            TEXT,
  nation                TEXT,
  importer              TEXT,
  item_report_no        TEXT,
  calories              NUMERIC,
  protein               NUMERIC,
  total_fat             NUMERIC,
  saturated_fat         NUMERIC,
  trans_fat             NUMERIC,
  total_carbs           NUMERIC,
  total_sugars          NUMERIC,
  dietary_fiber         NUMERIC,
  sodium                NUMERIC,
  cholesterol           NUMERIC,
  serving_size          TEXT,
  basis                 TEXT,
  energy_source         TEXT,
  sodium_source         TEXT,
  traffic_light_allowed BOOLEAN,
  nutrient_holds        TEXT[],
  source_quality        TEXT NOT NULL DEFAULT 'kfda_import_official',
  normalizer_version    TEXT,
  imported_at           TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS import_nutrition_product_match (
  match_id          BIGSERIAL PRIMARY KEY,
  product_id        BIGINT NOT NULL,
  import_key        TEXT   NOT NULL,
  match_method      TEXT   NOT NULL,
  match_quality     TEXT,
  source_quality    TEXT   NOT NULL DEFAULT 'kfda_import_official',
  decision          TEXT   NOT NULL,
  resolution_status TEXT   NOT NULL,
  reason            TEXT,
  candidate_count   INTEGER,
  evidence          JSONB,
  resolver_version  TEXT,
  matched_at        TIMESTAMPTZ DEFAULT now(),
  reviewed_by       TEXT,
  reviewed_at       TIMESTAMPTZ,
  CONSTRAINT imp_match_decision_chk     CHECK (decision IN ('accept','review','reject')),
  CONSTRAINT imp_match_resolution_chk   CHECK (resolution_status IN ('auto_accepted','needs_review','human_verified','rejected')),
  CONSTRAINT imp_match_quality_chk      CHECK (match_quality IS NULL OR match_quality IN ('barcode_exact','name_exact','norm_exact','fuzzy')),
  CONSTRAINT imp_match_accept_human_chk CHECK (decision <> 'accept' OR resolution_status = 'human_verified'),
  CONSTRAINT imp_match_uq UNIQUE (product_id, import_key)
);
CREATE INDEX IF NOT EXISTS idx_imp_match_key      ON import_nutrition_product_match (import_key);
CREATE INDEX IF NOT EXISTS idx_imp_match_decision ON import_nutrition_product_match (decision);
CREATE INDEX IF NOT EXISTS idx_imp_match_product  ON import_nutrition_product_match (product_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_imp_match_accept_per_product
  ON import_nutrition_product_match (product_id) WHERE decision = 'accept';


-- ── 4-8. 일반명사 collapse 충돌 큐 (016 + 017) ──────────────────────────────
CREATE TABLE IF NOT EXISTS import_collapse_conflict (
  conflict_id      BIGSERIAL PRIMARY KEY,
  product_id       BIGINT NOT NULL,
  group_key        TEXT   NOT NULL,
  match_method     TEXT   NOT NULL,
  candidate_count  INTEGER NOT NULL,
  conflict_dims    TEXT[] NOT NULL,
  kcal_min         NUMERIC,
  kcal_max         NUMERIC,
  kcal_spread_pct  NUMERIC,
  sodium_min       NUMERIC,
  sodium_max       NUMERIC,
  sodium_ratio     NUMERIC,
  samples          JSONB,
  reason           TEXT NOT NULL DEFAULT 'generic_collapse_conflict',
  status           TEXT NOT NULL DEFAULT 'pending',
  detector_version TEXT,
  detected_at      TIMESTAMPTZ DEFAULT now(),
  reviewed_by      TEXT,
  reviewed_at      TIMESTAMPTZ,
  review_note      TEXT,
  -- 017
  route              TEXT,
  route_dims         TEXT[],
  suppressed         BOOLEAN NOT NULL DEFAULT FALSE,
  classifier_version TEXT,
  routed_at          TIMESTAMPTZ,
  reopen_on          TEXT[],
  CONSTRAINT icc_status_chk CHECK (status IN ('pending','reviewed','dismissed')),
  CONSTRAINT icc_method_chk CHECK (match_method IN ('name_raw','name_norm')),
  CONSTRAINT icc_uq UNIQUE (product_id)
);
ALTER TABLE import_collapse_conflict
  ADD COLUMN IF NOT EXISTS route              TEXT,
  ADD COLUMN IF NOT EXISTS route_dims         TEXT[],
  ADD COLUMN IF NOT EXISTS suppressed         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS classifier_version TEXT,
  ADD COLUMN IF NOT EXISTS routed_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reopen_on          TEXT[];
DO $baseline$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'icc_route_chk'
                    AND conrelid = 'import_collapse_conflict'::regclass) THEN
    ALTER TABLE import_collapse_conflict ADD CONSTRAINT icc_route_chk CHECK (
      route IS NULL OR route IN
      ('needs_review','consistent_collapse_review','zero_missing_hold','conflict_unresolvable','basis_unknown_hold')
    );
  END IF;
END
$baseline$;
CREATE INDEX IF NOT EXISTS idx_icc_status     ON import_collapse_conflict (status);
CREATE INDEX IF NOT EXISTS idx_icc_product    ON import_collapse_conflict (product_id);
CREATE INDEX IF NOT EXISTS idx_icc_route      ON import_collapse_conflict (route);
CREATE INDEX IF NOT EXISTS idx_icc_suppressed ON import_collapse_conflict (suppressed);


-- ── 4-9. 제품 엔티티 (018 + 019) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_entities (
  entity_id            BIGSERIAL PRIMARY KEY,
  entity_key           TEXT NOT NULL,
  canonical_name       TEXT,
  canonical_product_id BIGINT,
  member_count         INTEGER NOT NULL DEFAULT 0,
  route                TEXT,
  relation_type        TEXT,
  status               TEXT NOT NULL DEFAULT 'active',
  classifier_version   TEXT,
  eval_version         TEXT,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT pe_status_chk   CHECK (status IN ('active','merged','split')),
  CONSTRAINT pe_route_chk    CHECK (route IS NULL OR route IN
    ('AUTO_APPROVE_ENTITY','BULK_REVIEW_READY','NAME_ONLY_WEAK','HOLD_SPLIT')),
  CONSTRAINT pe_relation_chk CHECK (relation_type IS NULL OR relation_type IN
    ('same_sku','same_formula_diff_pack','same_name_only','split_required','basis_conflict_hold'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_entities_key ON product_entities (entity_key);
CREATE INDEX IF NOT EXISTS idx_product_entities_status ON product_entities (status);
CREATE INDEX IF NOT EXISTS idx_product_entities_route  ON product_entities (route);

CREATE TABLE IF NOT EXISTS product_entity_members (
  member_id          BIGSERIAL PRIMARY KEY,
  entity_id          BIGINT NOT NULL REFERENCES product_entities(entity_id) ON DELETE CASCADE,
  product_id         BIGINT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'candidate',
  evidence_json      JSONB,
  batch_id           TEXT,
  classifier_version TEXT,
  added_at           TIMESTAMPTZ DEFAULT now(),
  reviewed_by        TEXT,
  reviewed_at        TIMESTAMPTZ,
  CONSTRAINT pem_status_chk CHECK (status IN ('candidate','approved','rejected','split','undone')),
  CONSTRAINT pem_uq UNIQUE (entity_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_pem_product ON product_entity_members (product_id);
CREATE INDEX IF NOT EXISTS idx_pem_entity  ON product_entity_members (entity_id);
CREATE INDEX IF NOT EXISTS idx_pem_status  ON product_entity_members (status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pem_approved_per_product
  ON product_entity_members (product_id) WHERE status = 'approved';

CREATE TABLE IF NOT EXISTS entity_nutrition_profiles (
  profile_id                  BIGSERIAL PRIMARY KEY,
  entity_id                   BIGINT NOT NULL REFERENCES product_entities(entity_id) ON DELETE CASCADE,
  basis                       TEXT NOT NULL,
  calories NUMERIC, protein NUMERIC, total_fat NUMERIC, saturated_fat NUMERIC, trans_fat NUMERIC,
  total_carbs NUMERIC, total_sugars NUMERIC, dietary_fiber NUMERIC, sodium NUMERIC, cholesterol NUMERIC,
  source_product_ids          BIGINT[],
  method                      TEXT,
  conflict_status             TEXT NOT NULL DEFAULT 'none',
  serving_inheritance_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  status                      TEXT NOT NULL DEFAULT 'candidate',
  profiler_version            TEXT,
  created_at                  TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT enp_basis_chk  CHECK (basis IN ('per_100g','per_100ml')),
  CONSTRAINT enp_status_chk CHECK (status IN ('candidate','approved','rejected')),
  CONSTRAINT enp_no_serving_inherit_chk CHECK (serving_inheritance_allowed = FALSE),
  -- ★ 019 가 확장한 최종 형태로 바로 만든다 (016/018 의 좁은 버전 → 019 DROP/ADD 를 합친 것)
  CONSTRAINT enp_method_chk   CHECK (method IS NULL OR method IN
    ('aligned_consistent','single_source','identical','variant_review')),
  CONSTRAINT enp_conflict_chk CHECK (conflict_status IN ('none','conflict','review'))
);
CREATE INDEX IF NOT EXISTS idx_enp_entity ON entity_nutrition_profiles (entity_id);
CREATE INDEX IF NOT EXISTS idx_enp_status ON entity_nutrition_profiles (status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_enp_approved_per_entity
  ON entity_nutrition_profiles (entity_id) WHERE status = 'approved';

-- 018 로 만든 뒤 019 를 아직 안 돌린 DB(=구 테스트 DB)도 여기서 최종 상태로 맞춘다.
ALTER TABLE entity_nutrition_profiles DROP CONSTRAINT IF EXISTS enp_method_chk;
ALTER TABLE entity_nutrition_profiles
  ADD CONSTRAINT enp_method_chk CHECK (method IS NULL OR method IN
    ('aligned_consistent','single_source','identical','variant_review'));
ALTER TABLE entity_nutrition_profiles DROP CONSTRAINT IF EXISTS enp_conflict_chk;
ALTER TABLE entity_nutrition_profiles
  ADD CONSTRAINT enp_conflict_chk CHECK (conflict_status IN ('none','conflict','review'));

CREATE TABLE IF NOT EXISTS product_entity_audit (
  audit_id           BIGSERIAL PRIMARY KEY,
  entity_id          BIGINT,
  product_id         BIGINT,
  action             TEXT NOT NULL,
  before_json        JSONB,
  after_json         JSONB,
  classifier_version TEXT,
  eval_version       TEXT,
  actor              TEXT,
  created_at         TIMESTAMPTZ DEFAULT now(),
  undone_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pea_entity  ON product_entity_audit (entity_id);
CREATE INDEX IF NOT EXISTS idx_pea_product ON product_entity_audit (product_id);


-- ============================================================================
-- §5. 뷰
-- ============================================================================

-- ── 5-1. product_nutrition_resolved — 018 의 최종본 (011→012→013→015→018 누적) ──
-- 우선순위: nutrition_data > OpenFoodFacts > 수입식품 > 엔티티 상속
CREATE OR REPLACE VIEW product_nutrition_resolved AS
SELECT
  p.product_id,
  p.barcode,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.calories      WHEN off.code IS NOT NULL THEN off.calories       WHEN imp.food_cd IS NOT NULL THEN imp.calories      ELSE ent.calories      END AS calories,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.protein       WHEN off.code IS NOT NULL THEN off.protein        WHEN imp.food_cd IS NOT NULL THEN imp.protein       ELSE ent.protein       END AS protein,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.total_fat     WHEN off.code IS NOT NULL THEN off.total_fat      WHEN imp.food_cd IS NOT NULL THEN imp.total_fat     ELSE ent.total_fat     END AS total_fat,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.saturated_fat WHEN off.code IS NOT NULL THEN off.saturated_fat  WHEN imp.food_cd IS NOT NULL THEN imp.saturated_fat ELSE ent.saturated_fat END AS saturated_fat,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.trans_fat     WHEN off.code IS NOT NULL THEN off.trans_fat      WHEN imp.food_cd IS NOT NULL THEN imp.trans_fat     ELSE ent.trans_fat     END AS trans_fat,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.total_carbs   WHEN off.code IS NOT NULL THEN off.total_carbs    WHEN imp.food_cd IS NOT NULL THEN imp.total_carbs   ELSE ent.total_carbs   END AS total_carbs,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.total_sugars  WHEN off.code IS NOT NULL THEN off.total_sugars   WHEN imp.food_cd IS NOT NULL THEN imp.total_sugars  ELSE ent.total_sugars  END AS total_sugars,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.dietary_fiber WHEN off.code IS NOT NULL THEN off.dietary_fiber  WHEN imp.food_cd IS NOT NULL THEN imp.dietary_fiber ELSE ent.dietary_fiber END AS dietary_fiber,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.sodium        WHEN off.code IS NOT NULL THEN off.sodium_mg      WHEN imp.food_cd IS NOT NULL THEN imp.sodium        ELSE ent.sodium        END AS sodium,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.cholesterol   WHEN off.code IS NOT NULL THEN off.cholesterol_mg WHEN imp.food_cd IS NOT NULL THEN imp.cholesterol   ELSE ent.cholesterol   END AS cholesterol,
  CASE
    WHEN nd.product_id IS NOT NULL THEN
      COALESCE(nd.serving_size,
               CASE WHEN p.serving_size IS NULL OR p.serving_size <= 0 THEN NULL
                    ELSE p.serving_size::text END)
    WHEN off.code IS NOT NULL AND off.basis_unit = 'mL' THEN '100ml'
    WHEN off.code IS NOT NULL AND off.basis_unit = 'g'  THEN '100g'
    WHEN off.code IS NOT NULL                           THEN '100unknown'
    WHEN imp.food_cd IS NOT NULL                        THEN imp.serving_size
    WHEN ent.entity_id IS NOT NULL THEN CASE ent.basis WHEN 'per_100ml' THEN '100ml' WHEN 'per_100g' THEN '100g' ELSE '100unknown' END
    ELSE NULL
  END AS serving_size,
  CASE
    WHEN nd.product_id IS NOT NULL THEN nd.data_source::text
    WHEN off.code IS NOT NULL      THEN 'openfoodfacts'
    WHEN imp.food_cd IS NOT NULL   THEN 'import_nutrition'
    WHEN ent.entity_id IS NOT NULL THEN 'entity_profile'
    ELSE NULL
  END AS resolved_source,
  CASE WHEN nd.product_id IS NULL AND off.code IS NOT NULL THEN off.off_grade END       AS off_grade,
  CASE WHEN nd.product_id IS NULL AND off.code IS NOT NULL THEN off.basis_confident END AS basis_confident,
  CASE
    WHEN nd.product_id IS NULL AND off.code IS NOT NULL THEN 'low'
    WHEN nd.product_id IS NULL AND off.code IS NULL AND imp.food_cd IS NOT NULL THEN 'low'
    WHEN nd.product_id IS NULL AND off.code IS NULL AND imp.food_cd IS NULL AND ent.entity_id IS NOT NULL THEN 'low'
  END AS confidence,
  CASE
    WHEN nd.product_id IS NULL AND off.code IS NOT NULL THEN 'ODbL-1.0'
    WHEN nd.product_id IS NULL AND off.code IS NULL AND imp.food_cd IS NOT NULL THEN 'KOGL-1'
    WHEN nd.product_id IS NULL AND off.code IS NULL AND imp.food_cd IS NULL AND ent.entity_id IS NOT NULL THEN 'KOGL-1'
  END AS source_license,
  CASE WHEN nd.product_id IS NOT NULL THEN nd.verified_at END AS verified_at,
  CASE WHEN nd.product_id IS NULL AND off.code IS NULL AND imp.food_cd IS NOT NULL THEN im.match_quality  END AS import_match_quality,
  CASE WHEN nd.product_id IS NULL AND off.code IS NULL AND imp.food_cd IS NOT NULL THEN im.source_quality END AS import_source_quality,
  (nd.product_id IS NULL AND off.code IS NULL AND imp.food_cd IS NULL AND ent.entity_id IS NOT NULL) AS is_inherited,
  CASE WHEN nd.product_id IS NULL AND off.code IS NULL AND imp.food_cd IS NULL AND ent.entity_id IS NOT NULL THEN ent.entity_id END AS entity_id,
  CASE WHEN nd.product_id IS NULL AND off.code IS NULL AND imp.food_cd IS NULL AND ent.entity_id IS NOT NULL THEN ent.source_product_ids END AS entity_source_product_ids
FROM products p
LEFT JOIN nutrition_data nd
       ON nd.product_id = p.product_id
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


-- ── 5-2. pulse_aggregations_v1 (007) — k≥10 강제 ────────────────────────────
CREATE OR REPLACE VIEW pulse_aggregations_v1 AS
SELECT
  p.food_category,
  u.profile_type,
  DATE_TRUNC('week', s.scanned_at)::DATE AS week,
  COUNT(DISTINCT s.user_id)              AS unique_users,
  COUNT(*)                               AS scan_count
FROM scan_history s
JOIN users    u ON s.user_id    = u.user_id
JOIN products p ON s.product_id = p.product_id
WHERE s.pulse_eligible = TRUE
GROUP BY p.food_category, u.profile_type, DATE_TRUNC('week', s.scanned_at)
HAVING COUNT(DISTINCT s.user_id) >= 10;


-- ============================================================================
-- §6. trigram 인덱스 — pg_trgm 이 있을 때만 (pglite 에서는 건너뛴다)
-- ============================================================================
DO $baseline$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_products_name_trgm        ON products USING gin (product_name gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_products_normalized_name  ON products USING gin (normalized_name gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_products_search_text      ON products USING gin (search_text gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_staging_c005_name         ON staging_c005 USING gin (prdlst_nm gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_staging_nutrition_name    ON staging_nutrition USING gin (food_nm_kr gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_staging_nutrition_normalized ON staging_nutrition USING gin (normalized_name gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_staging_ingredients_name  ON staging_ingredients USING gin (prdlst_nm gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_import_nutrition_name     ON import_nutrition USING gin (food_nm_kr gin_trgm_ops)';
  ELSE
    RAISE NOTICE '000_baseline: pg_trgm 없음 → trigram 인덱스 8개를 건너뜁니다. '
                 '검색(similarity/%%)은 이 DB 에서 느리거나 동작하지 않습니다(테스트 전용 환경).';
  END IF;
END
$baseline$;


-- ============================================================================
-- §7. 트리거 — **일부러 만들지 않는다**
-- ============================================================================
-- 001 은 `update_timestamp()` 트리거를 products·nutrition_data·additives·users·
-- nutrition_config 에 걸었다. 그러나 운영에는 그 트리거가 걸릴 `updated_at` 컬럼이
-- nutrition_data·additives·users 에 **없다**(덤프 확인). 즉 001 의 트리거는 운영에 없다.
-- 덤프가 트리거 목록을 담지 않아 products 쪽도 확인되지 않았다.
-- → 없는 것을 만드는 쪽이 아니라, **확인되지 않은 것은 만들지 않는** 쪽을 택했다.
--   코드는 이미 `updated_at = NOW()` 를 명시적으로 쓴다(mergeService·UPSERT 절).
-- ⚠ 다음 운영 덤프 때 `pg_trigger` 를 함께 뜰 것. §9 참조.


-- ============================================================================
-- §8. 적용 확인 (수동)
-- ============================================================================
--   SELECT count(*) FROM information_schema.tables WHERE table_schema='public';
--   SELECT indexname FROM pg_indexes WHERE indexname IN (
--     'nutrition_data_product_id_key','nutrition_traffic_light_product_id_key',
--     'users_firebase_uid_key','idx_product_allergens_unique','idx_product_additives_unique');
--   → 5행이면 ON CONFLICT 4종이 전부 성립한다.
--
--   자동 검증:  npm run verify:fresh-schema   (scripts/77-verify-fresh-schema.js)


-- ============================================================================
-- §9. 이 파일이 「추정」으로 채운 곳 — 다음 운영 덤프 때 확인할 것
-- ============================================================================
--  (1) VARCHAR 길이 · NUMERIC 정밀도
--      information_schema.columns.data_type 에는 typmod 가 없다. 전부 길이/정밀도 없이 썼다.
--      → 다음 덤프는 `format_type(atttypid, atttypmod)` 를 쓸 것.
--  (2) ENUM 라벨
--      덤프에 없다. 001/004/008 + INSERT 문에서 복원했다. 특히 `data_source_type` 의
--      'c005_miss_queue' 와 `mfras_grade` 의 'blue' 는 코드·주석 근거뿐이다.
--      → 다음 덤프는 `pg_enum` 을 함께 뜰 것.
--  (3) 트리거 · 시퀀스 소유관계 · 함수
--      덤프에 없다. §7 참조.
--  (4) 덤프에 없던 부수 테이블(pulse·staging·off·import·entity)의 **운영 실제 컬럼**
--      마이그레이션 최종 상태로 썼다. 운영이 그 뒤 손으로 바뀌었을 가능성은 남는다.
--      → 다음 덤프의 TABLES 배열을 `information_schema.tables` 전수로 바꿀 것.
-- ============================================================================
