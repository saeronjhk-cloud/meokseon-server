-- ============================================================
-- 먹선(吃選) MVP Database Schema v1.0
-- PostgreSQL 15+
-- 작성일: 2026-04-21
-- ============================================================

-- 확장 모듈
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- 퍼지 매칭용

-- ============================================================
-- 1. ENUM 타입 정의
-- ============================================================

CREATE TYPE data_source_type AS ENUM (
  'public_c005',        -- 공공데이터 C005 바코드연계제품정보
  'public_nutrition',   -- 식약처 영양성분 DB
  'ocr_crowdsource',    -- 사용자 OCR 크라우드소싱
  'open_food_facts',    -- Open Food Facts
  'manual_seed'         -- 수동 씨드 데이터
);

CREATE TYPE verification_status AS ENUM (
  'unverified',         -- 미검증 (1명 등록)
  'partial',            -- 부분 검증 (2명)
  'verified',           -- 검증 완료 (3명+)
  'admin_verified'      -- 관리자 확인
);

CREATE TYPE food_category AS ENUM (
  'general',            -- 일반 가공식품
  'beverage',           -- 음료류
  'dried',              -- 건조/농축 식품
  'fermented',          -- 발효식품
  'sauce',              -- 소스/양념류
  'nuts',               -- 견과류
  'dairy',              -- 유제품
  'juice',              -- 과일주스
  'whole_grain',        -- 통곡물
  'alcohol',            -- 주류 (평가 제외)
  'supplement',         -- 건강기능식품 (평가 제외)
  'raw_ingredient'      -- 원료 식품 (평가 제외)
);

CREATE TYPE traffic_light_color AS ENUM (
  'green',    -- 🟢 낮음/풍부
  'yellow',   -- 🟡 보통
  'red',      -- 🔴 높음/부족
  'gray'      -- ⚪ 해당없음/낮음 (권장 영양성분용)
);

CREATE TYPE mfras_grade AS ENUM (
  'green',    -- 🟢 안전 (Grade 1-2)
  'yellow',   -- 🟡 주의 (Grade 3)
  'orange',   -- 🟠 경고 (Grade 4)
  'red'       -- 🔴 위험 (Grade 5)
);

CREATE TYPE user_profile_type AS ENUM (
  'adult',          -- 성인 (기본)
  'pregnant',       -- 임산부
  'infant',         -- 영유아 (1~2세)
  'child',          -- 어린이 (3~11세)
  'hypertension',   -- 고혈압
  'diabetes',       -- 당뇨
  'kidney'          -- 신장질환
);

-- ============================================================
-- 2. 제품 테이블 (Products)
-- ============================================================

CREATE TABLE products (
  product_id      BIGSERIAL PRIMARY KEY,
  barcode         VARCHAR(20),                    -- EAN-13/UPC 바코드 (NULL 가능: OCR 전용 등록)
  product_name    VARCHAR(500) NOT NULL,           -- 제품명
  brand           VARCHAR(200),                    -- 브랜드/제조사
  manufacturer    VARCHAR(200),                    -- 제조원
  food_type       VARCHAR(100),                    -- 식품유형 (C005 기준)
  food_category   food_category DEFAULT 'general', -- 먹선 내부 카테고리
  serving_size    DECIMAL(10,2),                   -- 1회 제공량 (g 또는 mL)
  serving_unit    VARCHAR(10) DEFAULT 'g',         -- 제공량 단위 (g, mL)
  total_content   DECIMAL(10,2),                   -- 총 내용량
  content_unit    VARCHAR(10) DEFAULT 'g',         -- 내용량 단위 (g, mL, kg, L)
  servings_per_container DECIMAL(5,1),             -- 총 제공 횟수 (총내용량 ÷ 1회제공량)
  image_front_url TEXT,                            -- 제품 앞면 이미지 URL
  image_label_url TEXT,                            -- 성분표 이미지 URL
  data_source     data_source_type NOT NULL,       -- 데이터 출처
  verification    verification_status DEFAULT 'unverified',
  verify_count    INT DEFAULT 0,                   -- 교차 검증 횟수
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),

  -- 공공데이터 연결 키
  c005_report_no  VARCHAR(50),                     -- 품목보고번호 (C005)
  public_food_cd  VARCHAR(20)                      -- 식약처 영양성분 DB 식품코드
);

-- 인덱스
CREATE INDEX idx_products_barcode ON products(barcode);
CREATE INDEX idx_products_name_trgm ON products USING gin(product_name gin_trgm_ops);
CREATE INDEX idx_products_brand_trgm ON products USING gin(brand gin_trgm_ops);
CREATE INDEX idx_products_category ON products(food_category);
CREATE INDEX idx_products_source ON products(data_source);
CREATE UNIQUE INDEX idx_products_barcode_unique ON products(barcode) WHERE barcode IS NOT NULL;

-- ============================================================
-- 3. 영양성분 테이블 (Nutrition Data)
-- ============================================================

CREATE TABLE nutrition_data (
  nutrition_id    BIGSERIAL PRIMARY KEY,
  product_id      BIGINT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,

  -- 1회 제공량 기준 영양성분
  calories        DECIMAL(8,2),     -- 열량 (kcal)
  total_fat       DECIMAL(7,2),     -- 지방 (g)
  saturated_fat   DECIMAL(7,2),     -- 포화지방 (g)
  trans_fat       DECIMAL(7,2),     -- 트랜스지방 (g)
  cholesterol     DECIMAL(7,2),     -- 콜레스테롤 (mg)
  sodium          DECIMAL(8,2),     -- 나트륨 (mg)
  total_carbs     DECIMAL(7,2),     -- 탄수화물 (g)
  total_sugars    DECIMAL(7,2),     -- 총 당류 (g)
  added_sugars    DECIMAL(7,2),     -- 첨가당 (g), NULL 허용 — v1.1 사전 분리
  dietary_fiber   DECIMAL(7,2),     -- 식이섬유 (g)
  protein         DECIMAL(7,2),     -- 단백질 (g)

  -- 추가 영양성분 (선택적)
  calcium         DECIMAL(7,2),     -- 칼슘 (mg)
  iron            DECIMAL(7,2),     -- 철분 (mg)
  potassium       DECIMAL(8,2),     -- 칼륨 (mg)
  vitamin_d       DECIMAL(7,2),     -- 비타민D (μg)

  -- 메타데이터
  per_serving     BOOLEAN DEFAULT TRUE,   -- TRUE: 1회 제공량 기준, FALSE: 100g 기준
  data_source     data_source_type NOT NULL,
  ocr_confidence  DECIMAL(5,2),           -- OCR 인식 신뢰도 (0~100%)
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_nutrition_product ON nutrition_data(product_id);

-- ============================================================
-- 4. 원재료 / 첨가물 테이블 (Ingredients)
-- ============================================================

CREATE TABLE product_ingredients (
  ingredient_id   BIGSERIAL PRIMARY KEY,
  product_id      BIGINT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  raw_text        TEXT,                        -- OCR 원본 원재료명 텍스트
  parsed_ingredients TEXT[],                   -- 파싱된 성분 배열
  data_source     data_source_type NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ingredients_product ON product_ingredients(product_id);

-- ============================================================
-- 5. 첨가물 사전 (MFRAS Additive DB)
-- ============================================================

CREATE TABLE additives (
  additive_id     SERIAL PRIMARY KEY,
  name_ko         VARCHAR(200) NOT NULL,       -- 한글명
  name_en         VARCHAR(200),                -- 영문명
  ins_number      VARCHAR(20),                 -- INS 번호 (E번호)
  cas_number      VARCHAR(30),                 -- CAS 번호
  category        VARCHAR(100),                -- 분류 (착색료, 보존료, 감미료 등)

  -- MFRAS v2.0 5차원 평가
  dim1_adi        DECIMAL(5,2),    -- D1: JECFA ADI 기반 (0~10)
  dim2_iarc       DECIMAL(5,2),    -- D2: IARC 발암성 (0~10)
  dim3_human      DECIMAL(5,2),    -- D3: 인체 연구 (0~10)
  dim4_regulation DECIMAL(5,2),    -- D4: 규제 현황 (0~10)
  dim5_exposure   DECIMAL(5,2),    -- D5: 노출 빈도 (0~10)
  mfras_total     DECIMAL(5,2),    -- 종합 점수
  mfras_grade     mfras_grade,     -- 4색 등급

  -- 근거 및 출처
  adi_value       VARCHAR(50),     -- ADI 수치 (mg/kg bw/day)
  iarc_group      VARCHAR(10),     -- IARC 분류 (1, 2A, 2B, 3 등)
  codex_status    VARCHAR(50),     -- Codex 채택 여부
  source_docs     TEXT[],          -- 참조 문서 목록

  -- 설명
  description_ko  TEXT,            -- 한글 설명
  risk_summary    TEXT,            -- 위해성 요약

  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_additives_name_ko ON additives USING gin(name_ko gin_trgm_ops);
CREATE INDEX idx_additives_name_en ON additives USING gin(name_en gin_trgm_ops);
CREATE INDEX idx_additives_grade ON additives(mfras_grade);

-- ============================================================
-- 6. 제품-첨가물 매핑 (Product ↔ Additive)
-- ============================================================

CREATE TABLE product_additives (
  id              BIGSERIAL PRIMARY KEY,
  product_id      BIGINT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  additive_id     INT NOT NULL REFERENCES additives(additive_id),
  detected_name   VARCHAR(200),     -- OCR/파싱에서 감지된 원본 이름
  confidence      DECIMAL(5,2),     -- 매칭 신뢰도
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_product_additives_product ON product_additives(product_id);
CREATE INDEX idx_product_additives_additive ON product_additives(additive_id);
CREATE UNIQUE INDEX idx_product_additives_unique ON product_additives(product_id, additive_id);

-- ============================================================
-- 7. 영양 신호등 판정 결과 (Traffic Light Results)
-- ============================================================

CREATE TABLE nutrition_traffic_light (
  result_id       BIGSERIAL PRIMARY KEY,
  product_id      BIGINT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  profile_type    user_profile_type DEFAULT 'adult',

  -- 7개 영양소 개별 판정
  sodium_color        traffic_light_color,
  sodium_pct_dv       DECIMAL(5,1),     -- %DV
  sodium_per_100      DECIMAL(8,2),     -- 100g/mL당
  sodium_basis        VARCHAR(10),      -- 최종 판정 기준 ('pct_dv' 또는 'per_100')

  sugars_color        traffic_light_color,
  sugars_pct_dv       DECIMAL(5,1),
  sugars_per_100      DECIMAL(7,2),
  sugars_basis        VARCHAR(10),

  sat_fat_color       traffic_light_color,
  sat_fat_pct_dv      DECIMAL(5,1),
  sat_fat_per_100     DECIMAL(7,2),
  sat_fat_basis       VARCHAR(10),

  total_fat_color     traffic_light_color,
  total_fat_pct_dv    DECIMAL(5,1),
  total_fat_per_100   DECIMAL(7,2),
  total_fat_basis     VARCHAR(10),

  cholesterol_color   traffic_light_color,
  cholesterol_pct_dv  DECIMAL(5,1),
  cholesterol_basis   VARCHAR(10) DEFAULT 'pct_dv',  -- 항상 %DV만

  protein_color       traffic_light_color,
  protein_pct_dv      DECIMAL(5,1),

  fiber_color         traffic_light_color,
  fiber_pct_dv        DECIMAL(5,1),

  -- 열량 (색상 판정 없음)
  calories_pct_dv     DECIMAL(5,1),

  -- 트랜스지방 (별도 규칙)
  trans_fat_color     traffic_light_color,
  trans_fat_amount    DECIMAL(7,2),

  -- 메타데이터
  food_category_used  food_category,         -- 판정 시 적용된 식품 카테고리
  is_dried_exception  BOOLEAN DEFAULT FALSE, -- 건조식품 예외 적용 여부
  context_messages    TEXT[],                -- 맥락 안내 문구 배열

  calculated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_traffic_light_product ON nutrition_traffic_light(product_id);
CREATE INDEX idx_traffic_light_profile ON nutrition_traffic_light(profile_type);

-- ============================================================
-- 8. 영양 판정 기준값 Config 테이블
-- ============================================================

CREATE TABLE nutrition_config (
  config_id       SERIAL PRIMARY KEY,
  nutrient        VARCHAR(30) NOT NULL,       -- 'sodium', 'sugars', 'sat_fat', 'total_fat', 'cholesterol', 'protein', 'fiber', 'trans_fat'
  threshold       VARCHAR(20) NOT NULL,       -- 'green_max', 'yellow_max', 'red_min', 'dv'
  basis           VARCHAR(20) NOT NULL,       -- 'pct_dv', 'per_100g', 'per_100ml', 'absolute'
  value           DECIMAL(10,2) NOT NULL,     -- 기준값
  unit            VARCHAR(10),                -- 'mg', 'g', '%', 'kcal'
  profile         VARCHAR(30) DEFAULT 'adult',-- 'adult', 'child', 'pregnant' 등
  effective_from  DATE NOT NULL,              -- 시행일
  effective_to    DATE,                       -- 종료일 (NULL = 현행)
  source          TEXT,                       -- '식약처 별표5', 'UK FSA', 'WHO' 등
  notes           TEXT,                       -- 비고
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_config_nutrient ON nutrition_config(nutrient, basis, profile);
CREATE UNIQUE INDEX idx_config_unique ON nutrition_config(nutrient, threshold, basis, profile, effective_from);

-- ============================================================
-- 9. 식품 카테고리별 맥락 안내 Config
-- ============================================================

CREATE TABLE context_messages (
  message_id      SERIAL PRIMARY KEY,
  food_category   food_category NOT NULL,
  nutrient        VARCHAR(30),                -- NULL이면 카테고리 전체 안내
  message_ko      TEXT NOT NULL,              -- 한국어 안내 문구
  display_type    VARCHAR(20) DEFAULT 'tooltip', -- 'tooltip', 'banner', 'popup'
  is_active       BOOLEAN DEFAULT TRUE,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 10. 사용자 테이블
-- ============================================================

CREATE TABLE users (
  user_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           VARCHAR(255) UNIQUE,
  nickname        VARCHAR(50),
  fi_bank_id      VARCHAR(50),                -- FI Bank 계정 연동 ID
  profile_type    user_profile_type DEFAULT 'adult',
  allergies       TEXT[],                     -- 알레르기 목록
  dietary_prefs   TEXT[],                     -- 식이 선호/제한
  health_goals    TEXT[],                     -- 건강 목표
  disclaimer_agreed BOOLEAN DEFAULT FALSE,    -- 면책 고지 동의
  disclaimer_agreed_at TIMESTAMPTZ,
  is_premium      BOOLEAN DEFAULT FALSE,
  premium_expires_at TIMESTAMPTZ,
  daily_scan_count INT DEFAULT 0,             -- 일일 스캔 횟수 (무료 티어 제한)
  daily_scan_reset_at DATE,                   -- 스캔 횟수 리셋 날짜
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 11. 스캔 히스토리
-- ============================================================

CREATE TABLE scan_history (
  scan_id         BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(user_id),
  product_id      BIGINT NOT NULL REFERENCES products(product_id),
  scan_type       VARCHAR(20) NOT NULL,       -- 'barcode', 'ocr', 'search'
  scanned_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_scan_history_user ON scan_history(user_id, scanned_at DESC);
CREATE INDEX idx_scan_history_product ON scan_history(product_id);

-- ============================================================
-- 12. 즐겨찾기
-- ============================================================

CREATE TABLE favorites (
  favorite_id     BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(user_id),
  product_id      BIGINT NOT NULL REFERENCES products(product_id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, product_id)
);

-- ============================================================
-- 13. 크라우드소싱 기여 추적
-- ============================================================

CREATE TABLE contributions (
  contribution_id BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(user_id),
  product_id      BIGINT NOT NULL REFERENCES products(product_id),
  contribution_type VARCHAR(20) NOT NULL,     -- 'new_product', 'verify', 'correction'
  points_earned   INT DEFAULT 0,              -- FI Bank 포인트
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_contributions_user ON contributions(user_id, created_at DESC);

-- ============================================================
-- 14. OCR Sanity Check 상한값 Config
-- ============================================================

CREATE TABLE ocr_sanity_limits (
  limit_id        SERIAL PRIMARY KEY,
  nutrient        VARCHAR(30) NOT NULL,
  per_serving_max DECIMAL(10,2),              -- 1회 제공량 상한
  per_100g_max    DECIMAL(10,2),              -- 100g당 상한
  unit            VARCHAR(10),
  notes           TEXT
);

-- ============================================================
-- 15. 건조식품 키워드 사전 (Fallback 3단계용)
-- ============================================================

CREATE TABLE dried_food_keywords (
  keyword_id      SERIAL PRIMARY KEY,
  keyword         VARCHAR(50) NOT NULL,       -- '육포', '말린', '건조', '분말', '김', '가루' 등
  category_match  food_category DEFAULT 'dried',
  priority        INT DEFAULT 1               -- 매칭 우선순위
);

-- ============================================================
-- 16. 업데이트 트리거 (updated_at 자동 갱신)
-- ============================================================

CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_products_updated BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER trg_nutrition_updated BEFORE UPDATE ON nutrition_data
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER trg_additives_updated BEFORE UPDATE ON additives
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER trg_config_updated BEFORE UPDATE ON nutrition_config
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();
