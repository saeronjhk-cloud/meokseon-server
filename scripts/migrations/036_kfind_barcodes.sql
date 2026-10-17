-- ============================================================
-- 먹선 Migration 036 — kfind 바코드 잇기 (세션80 · 제이 10:57 «252건 진행»)
--   kfind 품목 ↔ 바코드(HACCP 공공 «품목보고번호→바코드»). web_label.product_barcodes(032)와 같은 모양.
--   정답 IP/eval_kfind_barcode_v1/cases_v1.json · 적재 scripts/113-kfind-barcode-link.js(--undo)
-- ⚠ public·web_label 무접촉 · 멱등.
-- ============================================================
CREATE TABLE IF NOT EXISTS kfind.product_barcodes (
  barcode     TEXT NOT NULL,
  food_cd     TEXT NOT NULL REFERENCES kfind.products(food_cd) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('auto','needs_review','approved','rejected','unlinked')),
  reason      TEXT,
  evidence    JSONB,
  batch_id    TEXT,
  decided_by  TEXT,
  decided_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (barcode, food_cd)
);
CREATE INDEX IF NOT EXISTS idx_kf_bc_barcode ON kfind.product_barcodes (barcode);
CREATE INDEX IF NOT EXISTS idx_kf_bc_food    ON kfind.product_barcodes (food_cd);
