-- ============================================================
-- 020: product_allergens 에 알레르기 근거 등급(evidence_level) 추가
-- ============================================================
-- 세션45 · 제이 결정 2026-07-30 · 직전 근거: 인수인계_2026-07-30_세션44.md §6-2
--
-- ★ 세션44 인수인계 §6-2 의 전제는 사실과 달랐다.
--   「products.allergens 컬럼이 flat 이다」 → **그런 컬럼은 존재하지 않는다.**
--   001_init_schema.sql 의 products 정의에도, 이후 어떤 ALTER 에도 없다.
--   알레르기 마스터는 005 가 만든 정규화 테이블 `product_allergens` 다(이름별 1행).
--   → 그래서 products 에 JSONB 를 신설하지 않는다. **같은 사실을 두 곳에 두면
--     진상원이 2개가 되고, 이 프로젝트가 세션42~44 에 네 번 겪은
--     "한쪽만 고치기" 사고가 알레르기 경로에서 재현된다.**
--
-- 무엇을 푸는가 —
--   세션44 가 flat `allergens` 에서 **혼입 가능** 항목을 정확히 제거했다(직접 함유가 아니므로 옳다).
--   그런데 저장 경로에는 등급이 없어서, 제거된 혼입 정보가 **DB 에 남지 않는다.**
--   실측: 캡처 032 `대두·우유`, 060 `난류·대두·메밀` 이 저장에서 소실.
--   같은 바코드를 조회한 대두 알레르기 사용자는 아무 경고도 받지 못한다 = 경고 총량 순감.
--
-- 값 3종 (ocrParser.detectAllergensV2 의 3분리와 1:1) —
--   'contains'    직접 함유. 라벨이 명시 선언한 것.        (기존 행의 기본값)
--   'inferred'    원재료 형태에서 추정.  (예: 밀가루 → 밀)
--   'may_contain' 혼입 가능. 「같은 제조시설」 류 문구.     ★ 사용자 행동이 다르다
--
-- ★ 왜 UNIQUE(product_id, allergen_name) 를 유지하는가 —
--   한 제품의 한 알레르기는 등급이 **하나**여야 한다. 같은 이름이 contains 와 may_contain
--   두 행으로 공존하면 조회 측이 어느 쪽을 믿을지 정할 수 없고, 화면에서
--   「직접 함유」와 「혼입 가능」에 같은 항목이 동시에 뜬다.
--   병합 시에는 **강한 등급으로 올리기만 한다**(mergeService.ALLERGEN_LEVEL_RANK).
--   등급을 낮추는 병합은 경고를 지우는 방향이므로 금지다(세션44 mergeAllergensV2 와 같은 규칙).
--
-- ★ 기본값을 'contains' 로 두는 이유 —
--   005 이후 쌓인 기존 행은 전부 「직접 함유」 의미로 저장된 것이다(등급 개념이 없었으므로).
--   여기에 'may_contain' 을 기본값으로 주면 **이미 확인된 경고가 일괄 강등**된다.
--   모르는 것을 약하게 만드는 방향의 기본값은 이 도메인에서 안전하지 않다.
--
-- IF NOT EXISTS / DO 블록으로 멱등 — 운영 DB 재실행 안전.
-- ============================================================

ALTER TABLE product_allergens
  ADD COLUMN IF NOT EXISTS evidence_level VARCHAR(20) NOT NULL DEFAULT 'contains';

-- 값 오염 방지. 오타 한 번이 조회 측 분기를 조용히 통째로 빗나가게 한다
-- (세션44 치명B 와 같은 유형 — 잘못된 값이 예외를 내지 않고 그냥 "해당 없음" 이 된다).
-- ★ 1차 검증 경미7 — `conrelid` 를 지정하지 않으면 **다른 테이블**에 같은 이름의 제약이
--   있을 때 오류 없이 건너뛴다. 그러면 CHECK 가 없는 채로 마이그레이션이 "성공" 한다.
--   이 주석이 스스로 경고한 "잘못된 값이 예외를 내지 않고 그냥 해당 없음이 된다" 가 바로 성립한다.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_allergens_evidence_level_chk'
      AND conrelid = 'product_allergens'::regclass
  ) THEN
    ALTER TABLE product_allergens
      ADD CONSTRAINT product_allergens_evidence_level_chk
      CHECK (evidence_level IN ('contains', 'inferred', 'may_contain'));
  END IF;
END $$;

-- 조회 경로는 「직접 함유만」 / 「전부」 두 가지로 갈린다. product_id 선행 복합 인덱스.
CREATE INDEX IF NOT EXISTS idx_product_allergens_level
  ON product_allergens(product_id, evidence_level);

COMMENT ON COLUMN product_allergens.evidence_level IS
  'contains=직접 함유(라벨 명시) | inferred=원재료 추정 | may_contain=혼입 가능(같은 제조시설). '
  '세션45 신설. 병합 시 강한 등급으로만 올린다. 기본값 contains — 005 이후 기존 행의 의미가 그것이다.';
