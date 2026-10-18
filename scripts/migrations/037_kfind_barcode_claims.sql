-- ============================================================
-- 먹선 Migration 037 — 사용자 바코드 연결 제보 (세션81 · 결정 80-9 · 81-1~81-4)
--   사용자가 «이 바코드 = 이 K-FIND 품목»이라고 알려 준 기록 1건 = 1행. 판정(src/services/userBarcodeGate)이
--   모든 사용자 연결(auto)·관리자 확인(needs_review)을 kfind.product_barcodes(036)에 batch_id 'ublink' 로 쓴다.
--   personal = 그 사용자 본인에게만 연결로 보여 줄지(GET /api/barcode-links/mine/:barcode).
--   정답 IP/eval_user_barcode_v1/cases_v1.json (UB · UR)
-- ⚠ public·web_label 무접촉 · 멱등 · 되돌리기 = DROP TABLE kfind.barcode_claims + DELETE FROM kfind.product_barcodes WHERE batch_id='ublink' AND decided_by IS NULL
-- ============================================================
CREATE TABLE IF NOT EXISTS kfind.barcode_claims (
  claim_id    BIGSERIAL PRIMARY KEY,
  barcode     TEXT NOT NULL,
  food_cd     TEXT NOT NULL REFERENCES kfind.products(food_cd) ON DELETE CASCADE,
  user_id     BIGINT REFERENCES users(user_id) ON DELETE CASCADE,
  source      TEXT NOT NULL CHECK (source IN ('user','photo','gs1')),
  evidence    JSONB,
  verdict     TEXT,
  reason      TEXT,
  personal    BOOLEAN NOT NULL DEFAULT false,
  prefix      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kf_claim_barcode ON kfind.barcode_claims (barcode);
CREATE INDEX IF NOT EXISTS idx_kf_claim_user    ON kfind.barcode_claims (user_id, created_at DESC);
