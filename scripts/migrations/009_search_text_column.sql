-- ============================================================
-- 먹선 Migration 009 — 통합 검색 컬럼 (search_text) 추가
-- 작성일: 2026-06-21
-- 트리거: 사용자 검색 미스매치 분석 (Notion 보고서 §8)
-- ============================================================
--
-- 목적:
--   * product_name 하나만 검색하던 한계 해소
--   * manufacturer·brand·food_type 도 검색 대상에 포함
--   * 띄어쓰기·특수문자·대소문자 변형 흡수 (정규화 컬럼)
--   * 단일 인덱스로 검색 성능 일관 유지
--
-- 효과 (예상):
--   * "농심" → 신라면·안성탕면 등 manufacturer 매칭 제품 노출
--   * "신 라면" → "신라면" 과 동일 결과 (띄어쓰기 흡수)
--   * "Coca-Cola" → 영문은 lower() 로 흡수, 동의어는 후속 작업
--
-- 롤백:
--   DROP INDEX IF EXISTS idx_products_search_text;
--   ALTER TABLE products DROP COLUMN IF EXISTS search_text;
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. search_text 컬럼 (STORED 생성 컬럼)
--    4개 검색 필드를 합쳐 정규화한 단일 텍스트
--    - 소문자 변환 (영문 케이스 통일)
--    - 공백·특수문자 제거 (띄어쓰기 변형 흡수)
--    - 한글·영문·숫자만 보존
-- ------------------------------------------------------------
ALTER TABLE products
ADD COLUMN IF NOT EXISTS search_text TEXT
GENERATED ALWAYS AS (
  lower(
    regexp_replace(
      COALESCE(product_name, '') || ' ' ||
      COALESCE(manufacturer, '') || ' ' ||
      COALESCE(brand,        '') || ' ' ||
      COALESCE(food_type,    ''),
      '[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ]',  -- 한글 + 영문 + 숫자 외 모두 제거
      '',
      'g'
    )
  )
) STORED;

COMMENT ON COLUMN products.search_text IS
  '통합 검색용 정규화 텍스트 (product_name + manufacturer + brand + food_type, 공백·특수문자 제거, 소문자). Migration 009.';

-- ------------------------------------------------------------
-- 2. GIN trigram 인덱스
--    similarity() 및 % 연산자 가속화
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_products_search_text
  ON products USING gin (search_text gin_trgm_ops);

-- ------------------------------------------------------------
-- 3. 기존 단일 컬럼 인덱스 정리 (선택 사항)
--    name_trgm 은 유지 (기존 ranking 호환)
--    brand_trgm 은 search_text 가 brand 도 포함하므로 사실상 중복
--    → 운영 모니터링 후 별도 마이그레이션으로 제거 권장 (지금은 건드리지 않음)
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 4. 검증 쿼리 (수동 실행용 — 마이그레이션 후 확인)
-- ------------------------------------------------------------
-- 컬럼 존재 확인:
--   \d products
--
-- 샘플 데이터로 정규화 결과 보기:
--   SELECT product_name, manufacturer, search_text
--   FROM products
--   WHERE product_name LIKE '%신라면%' LIMIT 5;
--
-- 인덱스 사용 확인:
--   EXPLAIN ANALYZE
--   SELECT product_id, product_name FROM products
--   WHERE search_text % '농심' LIMIT 10;

COMMIT;

-- ============================================================
-- 운영 적용 후 수동 단계:
--   1. 인덱스 통계 갱신:  ANALYZE products;
--   2. (선택) trigram 임계값 조정: SET pg_trgm.similarity_threshold = 0.2;
-- ============================================================
