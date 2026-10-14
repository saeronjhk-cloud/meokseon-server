-- ============================================================
-- 032: web_label 노출 — 품목 상태 · 기존 제품 보충 · 바코드 연결 (세션79)
-- ============================================================
-- 왜:
--   제이 결정(2026-10-14 13:54 · 14:04): 판매처 라벨에서 온 값은 «전부» web_label(동일 물리 DB 의 분리 스키마)에서 관리한다.
--     · DB 에 없던 신규 품목(031 products)뿐 아니라, 기존 public 제품의 빈 칸을 채우는 값도 여기 «보충 표»에 둔다
--       (오전에 public 에 반영했던 330건은 되돌렸다 — undo_log.jsonl).
--     · 앱 노출 허용(내부 이용 목적 · 변호사 질의 불필요 — 제이 14:04).
--   외부 자문 라운드 1(IP/U78-3_web_label_노출/자문_라운드1_종합.md) 반영:
--     상태 active/needs_review/stale/superseded/withdrawn · 영양 교차확인 실패 시 신호등만 끔(nutrition_ok)
--     · 바코드 연결은 증거·상태를 남김(자동 연결 4조건은 서버 코드 — 2단계).
-- 무엇을:
--   ① web_label.products 에 status · nutrition_ok · quality(jsonb · 게이트 판정 근거) · collected_at
--   ② web_label.public_supplements — public 제품(product_id)의 축별 보충 값(알레르기·영양) + 출처 페이지 · 상태
--   ③ web_label.product_barcodes — 바코드 ↔ web_label 품목 연결(증거·상태)
-- 회귀 없음: public 테이블·타입·행 무접촉(②의 FK 는 public.products 를 «참조»만 한다 · ON DELETE CASCADE).
-- ⚠ 멱등(IF NOT EXISTS / DO 가드). 선행: 031.
-- ============================================================

ALTER TABLE web_label.products ADD COLUMN IF NOT EXISTS status       TEXT NOT NULL DEFAULT 'needs_review';
ALTER TABLE web_label.products ADD COLUMN IF NOT EXISTS nutrition_ok BOOLEAN;
ALTER TABLE web_label.products ADD COLUMN IF NOT EXISTS quality      JSONB;
ALTER TABLE web_label.products ADD COLUMN IF NOT EXISTS collected_at TIMESTAMPTZ;

DO $wl32$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wl_p_status_chk') THEN
    ALTER TABLE web_label.products ADD CONSTRAINT wl_p_status_chk
      CHECK (status IN ('active','needs_review','stale','superseded','withdrawn'));
  END IF;
END
$wl32$;
CREATE INDEX IF NOT EXISTS idx_wl_p_status ON web_label.products (status);

CREATE TABLE IF NOT EXISTS web_label.public_supplements (
  supplement_id  BIGSERIAL PRIMARY KEY,
  product_id     BIGINT NOT NULL REFERENCES public.products(product_id) ON DELETE CASCADE,
  axis           TEXT NOT NULL,                  -- allergens | nutrition
  data           JSONB NOT NULL,                 -- allergens: {contains:[],may_contain:[]} · nutrition: {calories,…, _basis:'per_100g'|'per_100ml'}
  source_page_id BIGINT REFERENCES web_label.source_pages(page_id) ON DELETE SET NULL,
  source_url     TEXT,
  report_no      TEXT,
  batch_id       TEXT,
  status         TEXT NOT NULL DEFAULT 'needs_review',
  quality        JSONB,                          -- 게이트 판정 근거
  reviewed_by    TEXT,
  reviewed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wl_ps_axis_chk   CHECK (axis IN ('allergens','nutrition')),
  CONSTRAINT wl_ps_status_chk CHECK (status IN ('active','needs_review','rejected','stale','superseded','withdrawn'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wl_ps_prod_axis_src ON web_label.public_supplements (product_id, axis, source_url);
CREATE INDEX IF NOT EXISTS idx_wl_ps_prod   ON web_label.public_supplements (product_id);
CREATE INDEX IF NOT EXISTS idx_wl_ps_status ON web_label.public_supplements (status);
CREATE INDEX IF NOT EXISTS idx_wl_ps_batch  ON web_label.public_supplements (batch_id);

CREATE TABLE IF NOT EXISTS web_label.product_barcodes (
  barcode         TEXT NOT NULL,
  product_id      BIGINT NOT NULL REFERENCES web_label.products(product_id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'needs_review',
  evidence        JSONB,                         -- {report_no_gate, name_match, maker_match, content_match, contribution_id, …}
  contribution_id BIGINT,
  decided_by      TEXT,
  decided_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (barcode, product_id),
  CONSTRAINT wl_pb_status_chk CHECK (status IN ('auto','needs_review','approved','rejected','unlinked'))
);
CREATE INDEX IF NOT EXISTS idx_wl_pb_barcode ON web_label.product_barcodes (barcode);
