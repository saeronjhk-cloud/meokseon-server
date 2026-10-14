-- ============================================================
-- 먹선 Migration 034 — 판매처 라벨 «포장지 그대로» 영양 기준 (세션79 · 제이 2026-10-14 23:05)
-- ------------------------------------------------------------
-- 저장 정본은 100g/100ml(엔진 공통) 그대로. 라벨의 원래 기준·인쇄된 숫자를 곁에 둔다:
--   web_label.nutrition_data.label_basis = {basis: per_serving|per_total|per_100g|per_100ml, amount, unit: g|ml, values:{…라벨 숫자}, upper_bound?:[키]}
--   (public 보충은 web_label.public_supplements.data._label 에 같은 모양 — 컬럼 추가 없음)
-- ⚠ public 무접촉 · 멱등.
-- ============================================================
ALTER TABLE web_label.nutrition_data ADD COLUMN IF NOT EXISTS label_basis JSONB;
