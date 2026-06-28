-- ============================================================
-- 008: MFRAS v2.0 컬럼 추가 + ENUM 정합화 (Phase 4)
-- ============================================================
-- SOURCE: OneDrive/MeokSeon/IP/database/migration_008_mfras_v2_spec.md (v1.0)
-- 본 SQL은 위 스펙의 사본. 변경 시 스펙 먼저 수정 후 본 파일 동기화.
--
-- 목적:
--   먹선 본 앱에 MFRAS v2.0 (5차원 + 4색 분류) 적용.
--   665종 평가 데이터는 별도 Python 스크립트(scripts/import_mfras_v2.py)로 import.
--   기존 risk_grade·risk_color는 v1 호환성 위해 유지 (삭제 금지).
--
-- 변경 요약 (4 묶음):
--   묶음 1) ENUM 정합화 — mfras_grade에 'orange' 추가
--   묶음 2) additives 테이블에 v2.0 컬럼 28개 추가
--   묶음 3) 인덱스 3개
--   묶음 4) COMMENT 8개
--
-- Railway Query 콘솔 적용 패턴:
--   - 묶음 1을 먼저 실행하고 백엔드 재시작 (ENUM 캐시 갱신 — 004 패턴)
--   - 묶음 2를 별도 실행
--   - 묶음 3·4는 각각 동질 multi-statement로 가능
-- ============================================================


-- ============================================================
-- 묶음 1) ENUM 정합화 — 'orange' 추가
-- ============================================================
-- Production 실측: mfras_grade ENUM = ('green', 'blue', 'yellow', 'red')
-- 의도된 4색: ('green', 'yellow', 'orange', 'red')
-- PostgreSQL은 ENUM VALUE DROP을 지원 안 함 → 'blue'는 영구 무시.
-- 'orange'만 추가하여 정합화.
--
-- ★ 본 statement 적용 후 백엔드 재시작 필수 (enum 캐시 갱신 — 2026-05-12 004 적용 패턴)
ALTER TYPE mfras_grade ADD VALUE IF NOT EXISTS 'orange';


-- ============================================================
-- 묶음 2) additives 테이블 v2.0 컬럼 28개 추가
-- ============================================================
-- mfras_scored_665.json record 구조를 그대로 반영.
-- IF NOT EXISTS 멱등 — 재실행 안전.
ALTER TABLE additives
  -- 식별·분류 (5)
  ADD COLUMN IF NOT EXISTS name_en          VARCHAR(300),
  ADD COLUMN IF NOT EXISTS aliases          TEXT[],
  ADD COLUMN IF NOT EXISTS ins_no           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS section          VARCHAR(50),
  ADD COLUMN IF NOT EXISTS page             INTEGER,

  -- 사용 기준 (5)
  ADD COLUMN IF NOT EXISTS usage_standard_raw TEXT,
  ADD COLUMN IF NOT EXISTS purposes         TEXT[],
  ADD COLUMN IF NOT EXISTS max_limits       JSONB,
  ADD COLUMN IF NOT EXISTS has_quantity_limit BOOLEAN,
  ADD COLUMN IF NOT EXISTS usage_type       VARCHAR(50),

  -- 5차원 원천 데이터 (9)
  ADD COLUMN IF NOT EXISTS adi_type         VARCHAR(50),
  ADD COLUMN IF NOT EXISTS adi_value        VARCHAR(50),
  ADD COLUMN IF NOT EXISTS edi              VARCHAR(50),
  ADD COLUMN IF NOT EXISTS iarc_group       VARCHAR(20),
  ADD COLUMN IF NOT EXISTS genotox_status   VARCHAR(30),
  ADD COLUMN IF NOT EXISTS regulatory_status VARCHAR(50),
  ADD COLUMN IF NOT EXISTS klimisch_level   INTEGER,
  ADD COLUMN IF NOT EXISTS last_eval_year   INTEGER,
  ADD COLUMN IF NOT EXISTS data_sufficiency VARCHAR(30),

  -- 5차원 점수 (5) — A·B·C·D·E (위해성평가 프레임워크 v2.0 §3 정의)
  ADD COLUMN IF NOT EXISTS dim_a_toxicity   NUMERIC(4,2),
  ADD COLUMN IF NOT EXISTS dim_b_exposure   NUMERIC(4,2),
  ADD COLUMN IF NOT EXISTS dim_c_genotox    NUMERIC(4,2),
  ADD COLUMN IF NOT EXISTS dim_d_regulation NUMERIC(4,2),
  ADD COLUMN IF NOT EXISTS dim_e_data_quality NUMERIC(4,2),

  -- 종합 결과 (4)
  ADD COLUMN IF NOT EXISTS mfras_total      NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS mfras_grade      mfras_grade,
  ADD COLUMN IF NOT EXISTS mfras_override   VARCHAR(50),
  ADD COLUMN IF NOT EXISTS mfras_rationales JSONB,

  -- 메타 (1)
  ADD COLUMN IF NOT EXISTS evaluated_at     TIMESTAMPTZ DEFAULT NOW();


-- ============================================================
-- 묶음 3) 인덱스 3개 (동질 multi-statement OK)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_additives_mfras_grade
  ON additives(mfras_grade);

CREATE INDEX IF NOT EXISTS idx_additives_ins_no
  ON additives(ins_no) WHERE ins_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_additives_section
  ON additives(section);


-- ============================================================
-- 묶음 4) COMMENT 8개 (동질 multi-statement OK)
-- ============================================================
COMMENT ON COLUMN additives.dim_a_toxicity IS
  '차원 A — 독성학적 프로파일 (ADI 기반), 1~10, 가중치 25%. SOURCE: 먹선_위해성평가_프레임워크_v2.0.md §3.2';

COMMENT ON COLUMN additives.dim_b_exposure IS
  '차원 B — 노출 비율 (EDI/ADI Ratio), 1~10, 가중치 25%. EDI 산출 불가 시 기본값 5.';

COMMENT ON COLUMN additives.dim_c_genotox IS
  '차원 C — 유전독성·발암성 (IARC Group 기반), 1~10, 가중치 20%.';

COMMENT ON COLUMN additives.dim_d_regulation IS
  '차원 D — 국제 규제 합의 (JECFA·EFSA·FDA·식약처), 1~10, 가중치 15%.';

COMMENT ON COLUMN additives.dim_e_data_quality IS
  '차원 E — 연구 데이터 품질·충분성 (Klimisch 등급 + 2005년 이전 보정), 1~10, 가중치 15%.';

COMMENT ON COLUMN additives.mfras_total IS
  '5차원 가중 평균: A×0.25 + B×0.25 + C×0.20 + D×0.15 + E×0.15';

COMMENT ON COLUMN additives.mfras_grade IS
  '4색 분류: green(≤2.5) / yellow(≤4.5) / orange(≤6.5) / red(>6.5). Override 규칙 우선. ''blue'' 값은 production ENUM에 잔존하나 사용 금지.';

COMMENT ON COLUMN additives.mfras_override IS
  'NULL=정상 스코어링, ''auto_green''=ADI 미설정+무독성+전승인, ''auto_red''=IARC 1/2A 또는 ADI 철회';


-- ============================================================
-- 적용 후 검증 (수동 실행 — 별도 묶음)
-- ============================================================
-- 1) ENUM 'orange' 추가 확인
--    SELECT enumlabel FROM pg_enum
--    WHERE enumtypid = 'mfras_grade'::regtype
--    ORDER BY enumsortorder;
--    기대: green, blue, yellow, red, orange
--
-- 2) 컬럼 28개 추가 확인
--    SELECT column_name FROM information_schema.columns
--    WHERE table_name='additives'
--      AND column_name IN ('mfras_grade','mfras_total','dim_a_toxicity',
--                          'dim_b_exposure','dim_c_genotox','dim_d_regulation',
--                          'dim_e_data_quality','mfras_override','section');
--    기대: 9 rows
--
-- 3) 인덱스 3개 확인
--    SELECT indexname FROM pg_indexes
--    WHERE indexname IN ('idx_additives_mfras_grade',
--                        'idx_additives_ins_no',
--                        'idx_additives_section');
--    기대: 3 rows
--
-- 4) COMMENT 적용 확인
--    SELECT col_description('additives'::regclass, attnum) AS comment
--    FROM pg_attribute
--    WHERE attrelid='additives'::regclass AND attname='mfras_grade';
--    기대: '4색 분류: ...' 텍스트
--
-- 데이터 import 는 다음 단계:
--    PowerShell> python scripts/import_mfras_v2.py week1_pipeline/mfras_scored_665.json
