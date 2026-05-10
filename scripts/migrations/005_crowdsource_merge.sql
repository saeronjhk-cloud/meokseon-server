-- ============================================================
-- 005: 크라우드소싱 merge 파이프라인 스키마
-- ============================================================
-- 다른 사용자가 등록한 OCR 정보를 필드별로 병합해서 마스터 products 에 반영하는
-- merge 서비스를 위한 스키마 보강.
--
-- 변경 요약:
--   1) contributions: data(JSONB) / status / device_id 컬럼 보강 (코드는 이미 사용 중)
--   2) product_allergens: 알레르기 마스터 테이블 신규 (지금까진 contributions.data 에만 존재)
--   3) products: merged_at / merge_sources_count 컬럼 (merge 이력 추적용)
--
-- IF NOT EXISTS 로 멱등 — 운영 DB에서 이미 추가된 컬럼은 건너뜀.
-- ============================================================

-- ── 1) contributions 테이블 보강 ─────────────────────────────
ALTER TABLE contributions
  ADD COLUMN IF NOT EXISTS data       JSONB,
  ADD COLUMN IF NOT EXISTS status     VARCHAR(20) DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS device_id  VARCHAR(100);

-- 같은 제품에 대한 contribution 빠르게 조회 (merge 트리거에서 자주 호출)
CREATE INDEX IF NOT EXISTS idx_contributions_product ON contributions(product_id, created_at DESC);

-- 같은 device 가 같은 제품을 24h 내 중복 제출했는지 빠르게 체크
CREATE INDEX IF NOT EXISTS idx_contributions_device ON contributions(device_id, product_id);

-- 같은 product 의 distinct device 카운트할 때 사용
CREATE INDEX IF NOT EXISTS idx_contributions_status ON contributions(status);

-- ── 2) 알레르기 마스터 테이블 ───────────────────────────────
-- 식약처 의무 표시 19종을 product 단위로 마스터 저장.
-- merge 결과 (3건 이상에서 등장하면 confirmed, 1~2건이면 candidate) 반영.
CREATE TABLE IF NOT EXISTS product_allergens (
  id              BIGSERIAL PRIMARY KEY,
  product_id      BIGINT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  allergen_name   VARCHAR(50) NOT NULL,                -- 우유·메밀·땅콩·... (식약처 19종)
  source_count    INT DEFAULT 1,                       -- 몇 명의 사용자가 이 알레르기를 등록했는지
  status          VARCHAR(20) DEFAULT 'candidate',     -- candidate | confirmed | admin_verified
  detected_via    VARCHAR(30),                         -- 'explicit_marker' | 'keyword_inference' | 'user_input' | 'admin_verified'
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_allergens_product ON product_allergens(product_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_allergens_unique
  ON product_allergens(product_id, allergen_name);

-- ── 3) products 테이블에 merge 이력 컬럼 ──────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS merged_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS merge_sources_count  INT DEFAULT 0;

-- ── 4) verification_status 에 merged 값 추가 (선택) ──────────
-- 자동 merge 로 verified 된 것과 admin_verified 를 구분하지 않으므로 추가하지 않음.
-- verify_count + merge_sources_count 로 충분.

-- ── 5) 마이그레이션 완료 로그 ────────────────────────────
-- (앱 시작 시 console 에 어떤 마이그레이션이 적용됐는지 확인할 수 있게,
--  실제 DDL 이외 메타 정보는 별도 테이블로 관리하지 않고 README 에 적시)
