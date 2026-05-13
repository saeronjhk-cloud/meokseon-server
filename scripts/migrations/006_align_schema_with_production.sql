-- ============================================================
-- 006: Production 스키마와 코드 정합성 정렬
-- ============================================================
-- 2026-05-13 B 단계 진단으로 발견된 production ↔ 코드 불일치 해결.
--
-- 진단 배경:
--   001_init_schema.sql 은 "이상적 초기 설계" 였고 production 에 적용된 적 없음.
--   Production 은 공공데이터 import 스크립트 (scripts/staging/*) 가 만든 스키마.
--   코드는 마이그레이션 파일을 보고 작성되어 production 과 일부 어긋남.
--
-- 이번 마이그레이션은 "운영 메타데이터" 만 추가하고, 무의미한 차이는 코드에서 정렬.
--
-- IF NOT EXISTS 로 멱등 — 운영 DB에서 이미 추가된 컬럼은 건너뜀.
-- ============================================================

-- ── 1) nutrition_data ──
-- OCR 신뢰도 추적 컬럼 추가 (사용자 OCR 등록 시 라벨별 인식 정확도 모니터링용)
ALTER TABLE nutrition_data
  ADD COLUMN IF NOT EXISTS ocr_confidence INT;

COMMENT ON COLUMN nutrition_data.ocr_confidence IS
  '0~100, OCR 인식 평균 신뢰도. saveOcrContribution 에서 INSERT.';

-- ── 2) product_additives ──
-- OCR 감지 원본 이름 + 매칭 신뢰도 추가 (오인식 사후 추적용)
ALTER TABLE product_additives
  ADD COLUMN IF NOT EXISTS detected_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS confidence INT;

COMMENT ON COLUMN product_additives.detected_name IS
  'OCR 텍스트에서 매칭된 원본 단어 (예: "비타민B2"). additives.name_ko 와 다를 수 있음.';
COMMENT ON COLUMN product_additives.confidence IS
  '0~100, 매칭 신뢰도. OCR 평균 신뢰도 또는 자동 매칭 confidence.';

-- product_additives 의 ON CONFLICT (product_id, additive_id) 가 동작하려면
-- UNIQUE 제약이 있어야 함. 없으면 추가.
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_additives_unique
  ON product_additives(product_id, additive_id);

-- ── 3) 기타 ──
-- product_ingredients.source 는 production 에 이미 있음. data_source 라는 별칭으로
-- 사용하지 않고 코드를 source 로 정렬할 예정 (마이그레이션 변경 없음).
--
-- additives.is_active 는 production 에 없고 MFRAS v1.0 에서는 비활성화 개념 부재.
-- 코드에서 WHERE is_active = TRUE 조건 제거 예정 (마이그레이션 변경 없음).
--
-- nutrition_data.per_serving 은 모든 행에 TRUE 만 INSERT 되어 무의미.
-- 코드에서 컬럼 자체 제거 예정 (마이그레이션 변경 없음).
--
-- data_source enum 의 'ocr_crowdsource_merged' 값은 enum 에 없음.
-- 코드에서 'ocr_crowdsource' 로 통일하고 merge 적용 여부는
-- products.merged_at IS NOT NULL 또는 merge_sources_count > 0 으로 판정 예정.
