-- ============================================================
-- 먹선 Migration 035 — kfind 스키마 (세션80 · 결정 80-1)
-- ------------------------------------------------------------
-- 식약처 K-FIND 식품영양성분 DB «가공식품» 편을 public 과 섞지 않고 따로 둔다(79-1 web_label 과 같은 원칙).
--   · 바코드·원재료 없음 — 이름 검색으로만 닿는다. 배지 «식약처 영양성분 DB · 바코드·원재료 정보 없음».
--   · 숨김은 읽기 시점 규칙(같은 품목보고번호의 public 활성 · web_label 노출 품목이 있으면 숨김) — 여기엔 없다.
--   · 정답 IP/eval_kfind_expose_v1/cases_v1.json · 적재 scripts/111-kfind-load.js(배치 · --undo)
-- ⚠ public 무접촉 · 멱등.
-- ============================================================
CREATE SCHEMA IF NOT EXISTS kfind;

CREATE TABLE IF NOT EXISTS kfind.releases (
  release_id   TEXT PRIMARY KEY,                 -- 파일 기준일 'YYYYMMDD' (예 20260929)
  file_name    TEXT,
  row_count    INT,
  source_url   TEXT,
  loaded_at    TIMESTAMPTZ DEFAULT now(),
  batch_id     TEXT
);

CREATE TABLE IF NOT EXISTS kfind.products (
  food_cd         TEXT PRIMARY KEY,              -- K-FIND 식품코드 (P1xx-…)
  release_id      TEXT NOT NULL REFERENCES kfind.releases(release_id),
  food_name       TEXT NOT NULL,
  report_no       TEXT,                          -- 품목제조보고번호(국내) · 수입식품 관리번호(수입) — 수입형은 public.c005_report_no 와 조인 불가(015:27)
  maker           TEXT,
  importer        TEXT,
  distributor     TEXT,
  is_imported     BOOLEAN NOT NULL DEFAULT false,
  origin_country  TEXT,
  category_l      TEXT,                          -- 식품대분류명
  food_type       TEXT,                          -- 식품소분류명(= 식품유형 · '해당없음'은 NULL) — 신호등 RACC 정책·맥락 판정용
  rep_food        TEXT,                          -- 대표식품명
  basis           TEXT NOT NULL CHECK (basis IN ('per_100g','per_100ml')),
  food_weight     TEXT,                          -- 식품중량(원문 · 예 '500g')
  serving_ref     TEXT,                          -- 1회 섭취참고량(원문)
  calories NUMERIC, total_fat NUMERIC, saturated_fat NUMERIC, trans_fat NUMERIC, cholesterol NUMERIC,
  sodium NUMERIC, total_carbs NUMERIC, total_sugars NUMERIC, dietary_fiber NUMERIC, protein NUMERIC,
  nutrition_ok    BOOLEAN,                       -- 4·4·9 교차확인(web_label_gate.nutritionOk 와 같은 함수) · false 면 신호등 끔
  gen_method      TEXT,                          -- 수집 | 분석
  gen_date        DATE,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  batch_id        TEXT,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='kfind' AND table_name='products' AND column_name='search_text') THEN
    -- public(009)·web_label(033)과 같은 정규화 식
    ALTER TABLE kfind.products ADD COLUMN search_text TEXT
      GENERATED ALWAYS AS (
        lower(regexp_replace(
          COALESCE(food_name, '') || ' ' || COALESCE(maker, '') || ' ' ||
          COALESCE(importer, '') || ' ' || COALESCE(rep_food, ''),
          '[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ]', '', 'g'))
      ) STORED;
  END IF;
END $$;

ALTER TABLE kfind.products ADD COLUMN IF NOT EXISTS food_type TEXT;   -- 멱등(초판 적용 DB 보정)

CREATE INDEX IF NOT EXISTS idx_kf_p_report_no ON kfind.products (report_no);
CREATE INDEX IF NOT EXISTS idx_kf_p_status    ON kfind.products (status);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_kf_p_search_text ON kfind.products USING gin (search_text gin_trgm_ops)';
  END IF;
END $$;
