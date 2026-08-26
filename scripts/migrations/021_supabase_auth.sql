-- ============================================================
-- 021: Supabase 인증 통합 — users.supabase_uid 추가
-- ============================================================
-- 왜 (제이 확정 2026-08-24):
--   통합앱(영양공식)이 Supabase Auth 를 쓴다. 먹선 서버는 Firebase Auth 였다.
--   둘이 연결돼 있지 않아 웹 제보의 `contributions.user_id` 가 **항상 null** 이었다.
--   → 먹선 서버를 Supabase 인증으로 전환한다.
--
--   ⚠ 노션 [통합 현재상태 브리프](2026-07-09) §7-2 는 「인증 분리 유지」였다.
--     이 마이그레이션이 그 결정을 **뒤집는다**. 노션이 낡았다.
--
-- 무엇을:
--   users 에 supabase_uid(VARCHAR) 추가. Supabase user id 는 UUID 문자열이다.
--   기존 user_id(BIGSERIAL) 와 외래키 구조는 **그대로 둔다** —
--   contributions.user_id 등이 전부 BIGINT 로 참조하고 있어 타입을 바꾸면 전부 깨진다.
--   supabase_uid 는 «인증 키»이고 user_id 는 여전히 «내부 PK» 다.
--
-- ⚠ firebase_uid 를 «지우지 않는다».
--   전환 기간에 두 값이 공존한다. Firebase 쪽을 걷어내는 것은 별도 마이그레이션에서.
--   지금 지우면 되돌릴 수 없고, health-pick 앱의 실제 사용 여부를 아직 확인하지 못했다.
--
-- 적용 순서 (반드시 지킬 것):
--   1) 이 SQL 을 Railway Query 콘솔에서 실행
--   2) Railway 환경변수에 **SUPABASE_URL** 추가 (= https://<project-ref>.supabase.co)
--      ⚠ 세션64c 후속(2026-08-26) 교정 — 종전에 여기 적혀 있던 SUPABASE_JWT_SECRET 은
--        더 이상 «필수»가 아니다. 실측 결과 사용자 access token 은 ES256(JWKS)으로
--        서명되고, legacy 대칭키는 전환기 «폴백»(선택)이 됐다.
--        자세한 근거·확인법: src/config/supabaseJwks.js 머리말
--   3) 그 «다음»에 서버 코드를 배포
--   ★ 순서를 바꾸면 컬럼이 없는 상태에서 코드가 그 컬럼을 읽어 운영이 죽는다.
-- ============================================================


-- ── 묶음 1) 컬럼 추가 ────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS supabase_uid VARCHAR;


-- ── 묶음 2) 유니크 인덱스 ────────────────────────────────────
-- PostgreSQL 은 UNIQUE 인덱스에서 NULL 을 중복으로 보지 않는다.
-- 따라서 아직 Supabase 로 옮기지 않은 기존 행(supabase_uid IS NULL)이
-- 여러 개 있어도 충돌하지 않는다.
CREATE UNIQUE INDEX IF NOT EXISTS users_supabase_uid_key
  ON users (supabase_uid);


-- ── 묶음 3) 주석 ─────────────────────────────────────────────
COMMENT ON COLUMN users.supabase_uid IS
  'Supabase Auth user id (UUID 문자열). 통합앱 인증 키. 021(2026-08-24). '
  'user_id(BIGSERIAL)는 내부 PK 로 유지 — contributions 등이 BIGINT 로 참조한다.';


-- ── 검증 (실행 후 이 SELECT 로 확인) ─────────────────────────
-- 기대: supabase_uid 행이 1개 나오고 data_type = character varying
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'users'
   AND column_name IN ('user_id', 'firebase_uid', 'supabase_uid')
 ORDER BY column_name;
