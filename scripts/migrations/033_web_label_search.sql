-- ============================================================
-- 먹선 Migration 033 — web_label 이름 검색 준비 (세션79 · U78-3 노출)
-- ------------------------------------------------------------
-- 1. web_label.products.search_text 를 public(009)과 «같은 식»의 STORED 생성 컬럼으로 바꾼다.
--    031 이 public 구조를 복사할 때 생성식이 빠져 평범한 TEXT(전부 NULL)로 남았다 → 검색 0건의 원인.
-- 2. collected_at 백필 = 그 품목 원문 페이지(source_pages)의 가장 이른 fetched_at.
-- ⚠ public 무접촉 · 멱등(재적용해도 같은 결과).
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='web_label' AND table_name='products' AND column_name='search_text'
                AND is_generated <> 'ALWAYS') THEN
    ALTER TABLE web_label.products DROP COLUMN search_text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='web_label' AND table_name='products' AND column_name='search_text') THEN
    ALTER TABLE web_label.products ADD COLUMN search_text TEXT
      GENERATED ALWAYS AS (
        lower(regexp_replace(
          COALESCE(product_name, '') || ' ' || COALESCE(manufacturer, '') || ' ' ||
          COALESCE(brand, '') || ' ' || COALESCE(food_type, ''),
          '[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ]', '', 'g'))
      ) STORED;
  END IF;
END $$;

-- trigram 인덱스 — pg_trgm 이 있을 때만(pglite 는 건너뛴다 · 000 §6 과 같은 방식). 컬럼 재생성으로 031 의 인덱스는 함께 사라졌다.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_wl_p_search_text ON web_label.products USING gin (search_text gin_trgm_ops)';
  END IF;
END $$;

UPDATE web_label.products p
   SET collected_at = s.first_at
  FROM (SELECT product_id, min(fetched_at) first_at FROM web_label.source_pages
         WHERE target_schema = 'web_label' AND product_id IS NOT NULL GROUP BY product_id) s
 WHERE s.product_id = p.product_id AND p.collected_at IS NULL;
