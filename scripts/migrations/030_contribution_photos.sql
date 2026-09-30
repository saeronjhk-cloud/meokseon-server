-- ============================================================
-- 030: contribution_photos — 제보 라벨 사진 축소본 보관 (세션72f · U69-1 해소)
-- ============================================================
-- 왜:
--   세션69 U69-1 — 제보 사진이 서버에 남지 않아 관리자 검토 근거가 OCR 텍스트뿐이었다.
--   제이 결정(2026-09-30 「그러자구」): 라벨 사진 «축소본»을 비공개로 보관하고,
--   관리자 화면에서 사진을 보며 값을 고쳐 승인한다. 보관 기간 90일.
--
-- 무엇을:
--   · 사진 바이트는 이 테이블에만 있다(BYTEA). 외부 저장소·공개 URL 없음 → 관리자 API 로만 읽힌다.
--   · 앱이 보낸 «축소본»(긴 변 1600px · JPEG)만 받는다. 원본(OCR 용)은 지금처럼 메모리에서 버린다.
--   · 확정(저장)된 제보의 사진만 여기 들어온다. 확정 안 된 분석의 사진은 메모리 15분 뒤 사라진다.
--   · 파기: 받은 지 90일 지나고 그 제품에 검토 대기(candidate)가 없으면 삭제 · 365일은 무조건 삭제
--     (서버가 하루 한 번 돈다 — contributionPhotos.purgeExpired).
--
-- 개인정보 최소화: 제품 포장 사진이다. 누가 냈는지(user_id)는 «싣지 않는다» — 제품에만 묶는다.
--   (제보자 연결은 contributions 테이블 몫이다. 사진까지 사람에 묶을 이유가 없다.)
-- ⚠⚠ 멱등: real-postgres job 이 `npm run migrate` 를 2회 돌린다 → IF NOT EXISTS.
-- 선행: 000(products).
-- ============================================================

CREATE TABLE IF NOT EXISTS contribution_photos (
  photo_id        BIGSERIAL PRIMARY KEY,
  product_id      BIGINT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  mime            TEXT NOT NULL,
  byte_size       INTEGER NOT NULL,
  bytes           BYTEA NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cp_kind_chk CHECK (kind IN ('label', 'nutrition')),
  CONSTRAINT cp_mime_chk CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT cp_size_chk CHECK (byte_size > 0 AND byte_size <= 1572864)
);

CREATE INDEX IF NOT EXISTS idx_cp_product ON contribution_photos (product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cp_created ON contribution_photos (created_at);

COMMENT ON TABLE contribution_photos IS
  '제보 라벨 사진 축소본(030 · 세션72f). 관리자 검토 근거. 90일(대기 없으면)·365일(무조건) 파기.';

-- 검증
SELECT to_regclass('contribution_photos') AS table_ok;
