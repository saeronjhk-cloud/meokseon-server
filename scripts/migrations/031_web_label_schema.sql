-- ============================================================
-- 031: web_label 스키마 — 판매처 라벨(웹) 수집분 중 «우리 DB에 없는 품목»을 따로 담는다 (세션78)
-- ============================================================
-- 왜:
--   제이 결정(2026-10-13 20:29): 「DB에 없는 품목은 기존 데이터베이스와 같은 양식으로 하되, 별도로 만들어.」
--   역방향 파일럿(컬리 라벨 OCR → 품목보고번호) 60페이지 중 17이 우리 DB에 번호가 없었다(신제품·다른 공장 번호).
--   이 행들을 public.products 에 바로 넣지 않는다 — 출처가 공공 데이터가 아니고 아직 사람 검토 전이다.
--
-- 무엇을:
--   · 스키마 web_label 에 public 과 «같은 양식»의 4표: products · product_ingredients · nutrition_data · product_allergens
--     (LIKE … INCLUDING DEFAULTS INCLUDING INDEXES — 열·기본값·인덱스 동일, PK 시퀀스도 public 과 «공유»
--      → product_id 가 public 과 절대 겹치지 않는다. 나중에 승격할 때 id 를 바꿀 필요가 없다.)
--   · 차이 두 가지(의도): ① data_source 열이 ENUM 이 아니라 TEXT(기본 'web_label').
--       ENUM 값 추가는 되돌릴 수 없고 트랜잭션 제약이 있다(023 주석 · 000 §2 흉터) → public 타입을 건드리지 않는다.
--     ② 외래키는 web_label.products 를 가리킨다(public 과 섞이지 않는다).
--   · web_label.source_pages — 어느 판매처 페이지에서 왔는지(출처·수집일·품목보고번호·게이트 판정). 기존 DB 제품
--     빈 칸 채움은 이 스키마가 아니라 public 검토 대기열(contribution_review, origin 'web_label_ocr')로 간다.
-- 회귀 없음: public 의 테이블·뷰·타입·행 무접촉(시퀀스 nextval 공유만).
-- ⚠⚠ 멱등: `npm run migrate` 를 2회 돌린다 → IF NOT EXISTS / DO 가드.
-- 선행: 000.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS web_label;

CREATE TABLE IF NOT EXISTS web_label.products            (LIKE public.products            INCLUDING DEFAULTS INCLUDING INDEXES);
CREATE TABLE IF NOT EXISTS web_label.product_ingredients (LIKE public.product_ingredients INCLUDING DEFAULTS INCLUDING INDEXES);
CREATE TABLE IF NOT EXISTS web_label.nutrition_data      (LIKE public.nutrition_data      INCLUDING DEFAULTS INCLUDING INDEXES);
CREATE TABLE IF NOT EXISTS web_label.product_allergens   (LIKE public.product_allergens   INCLUDING DEFAULTS INCLUDING INDEXES);

ALTER TABLE web_label.products       ALTER COLUMN data_source DROP DEFAULT;
ALTER TABLE web_label.products       ALTER COLUMN data_source TYPE TEXT USING data_source::text;
ALTER TABLE web_label.products       ALTER COLUMN data_source SET DEFAULT 'web_label';
ALTER TABLE web_label.nutrition_data ALTER COLUMN data_source DROP DEFAULT;
ALTER TABLE web_label.nutrition_data ALTER COLUMN data_source TYPE TEXT USING data_source::text;
ALTER TABLE web_label.nutrition_data ALTER COLUMN data_source SET DEFAULT 'web_label';
ALTER TABLE web_label.product_ingredients ALTER COLUMN source SET DEFAULT 'web_label';
ALTER TABLE web_label.product_allergens   ALTER COLUMN detected_via SET DEFAULT 'web_label';

DO $wl$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wl_pi_product_fk') THEN
    ALTER TABLE web_label.product_ingredients ADD CONSTRAINT wl_pi_product_fk FOREIGN KEY (product_id) REFERENCES web_label.products(product_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wl_nd_product_fk') THEN
    ALTER TABLE web_label.nutrition_data ADD CONSTRAINT wl_nd_product_fk FOREIGN KEY (product_id) REFERENCES web_label.products(product_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wl_pa_product_fk') THEN
    ALTER TABLE web_label.product_allergens ADD CONSTRAINT wl_pa_product_fk FOREIGN KEY (product_id) REFERENCES web_label.products(product_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wl_pa_level_chk') THEN
    ALTER TABLE web_label.product_allergens ADD CONSTRAINT wl_pa_level_chk CHECK (evidence_level IN ('contains','inferred','may_contain'));
  END IF;
END
$wl$;

CREATE TABLE IF NOT EXISTS web_label.source_pages (
  page_id        BIGSERIAL PRIMARY KEY,
  site           TEXT NOT NULL,                 -- 'kurly' …
  site_item_no   TEXT,
  url            TEXT NOT NULL,
  site_name      TEXT,                          -- 판매처 상품명
  report_no      TEXT,                          -- 라벨에서 읽은 품목보고번호(하나일 때만)
  gate           TEXT NOT NULL,                 -- not_in_db | in_db | no_report_no | multi_report_no
  target_schema  TEXT,                          -- 'web_label' | 'public' | NULL
  product_id     BIGINT,                        -- target_schema 의 products.product_id
  ocr_chars      INTEGER,
  ocr_sha1       TEXT,
  fetched_at     TIMESTAMPTZ NOT NULL,
  batch_id       TEXT NOT NULL,                 -- 되돌리기 단위
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wl_sp_gate_chk CHECK (gate IN ('not_in_db','in_db','no_report_no','multi_report_no')),
  CONSTRAINT wl_sp_target_chk CHECK (target_schema IS NULL OR target_schema IN ('web_label','public'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wl_sp_url ON web_label.source_pages (url);
CREATE INDEX IF NOT EXISTS idx_wl_sp_report ON web_label.source_pages (report_no);
CREATE INDEX IF NOT EXISTS idx_wl_sp_batch  ON web_label.source_pages (batch_id);
