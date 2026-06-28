-- ============================================================
-- 007: Pulse 데이터 hooks (사업② 인프라 준비)
-- ============================================================
-- SOURCE: OneDrive/MeokSeon/IP/pulse/migration_007_spec.md (v1.1)
-- 본 SQL은 위 스펙의 사본. 변경 시 스펙 먼저 수정 후 본 파일 동기화.
--
-- 목적:
--   먹선 정식 출시 이전에 Pulse(B2B 데이터 사업)가 활용할 최소 hooks 박기.
--   출시 후 적용하면 약관 재동의 비용 + 데이터 누적 공백 발생.
--   본격 익명화(해시 salt, DP 노이즈)는 008/009 마이그레이션으로 단계 분리.
--
-- 변경 요약 (DDL 4건):
--   1) users.pulse_consent_version  컬럼 추가 (NULL=미동의)
--   2) pulse_consents 테이블 신설 (동의/철회 audit log, event sourcing)
--   3) scan_history.pulse_eligible 컬럼 추가 (스캔 시점 동의 스냅샷)
--   4) pulse_aggregations_v1 view 생성 (k≥10 강제, 옵트인 사용자만)
--
-- IF NOT EXISTS 로 멱등 — 운영 DB에서 이미 추가된 컬럼/테이블은 건너뜀.
-- 롤백 절차: 스펙 7장 참조.
-- ============================================================

-- ── 1) users 테이블에 Pulse 동의 버전 컬럼 ──────────────────
-- NULL  = 미동의 (집계 제외)
-- 'v2'  = 약관 v2 동의 (집계 포함)
-- 향후 'v3' 등 약관 업데이트 시 변경
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pulse_consent_version VARCHAR(20);

COMMENT ON COLUMN users.pulse_consent_version IS
  'Pulse(B2B 인사이트) 동의 약관 버전. NULL=미동의, ''v2'' 등 약관 식별자. SOURCE: IP/pulse/migration_007_spec.md §3-1';

-- 동의 사용자 빠른 카운트용
CREATE INDEX IF NOT EXISTS idx_users_pulse_consent
  ON users(pulse_consent_version)
  WHERE pulse_consent_version IS NOT NULL;


-- ── 2) pulse_consents 테이블 (audit log, event sourcing) ──
-- UPDATE 없음. grant/revoke 이벤트만 INSERT.
-- 현재 상태는 users.pulse_consent_version 이 보유.
-- 본 테이블은 감사·법무 대응용 변경 이력.
CREATE TABLE IF NOT EXISTS pulse_consents (
  consent_id        BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                                                    -- BIGINT: production 실측 타입 (001 마이그레이션의 UUID와 다름).
                                                    --        2026-05-15 information_schema 확인 결과 반영.
                                                    --        근본 정합은 Task #106 (Production 스키마 ↔ 코드 정합) 별도 트랙.
  consent_version   VARCHAR(20) NOT NULL,           -- 'v2', 'v3', ...
  consent_scope     VARCHAR(50) NOT NULL,           -- 'b2b_aggregate_insights' (출시 시점 유일값)
  event_type        VARCHAR(20) NOT NULL,           -- 'grant' | 'revoke'
  event_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  client_ip_hash    VARCHAR(64),                    -- SHA-256(client_ip || daily_salt). NULL 허용 (회원가입 시 미확보 가능)
  user_agent        VARCHAR(500)                    -- 동의 시점 디바이스 (감사용)
);

COMMENT ON TABLE pulse_consents IS
  'Pulse 동의/철회 audit log. event sourcing 패턴. SOURCE: IP/pulse/migration_007_spec.md §3-2';
COMMENT ON COLUMN pulse_consents.consent_scope IS
  '동의 범위. 출시 시점엔 ''b2b_aggregate_insights'' 하나. 향후 다른 B2B 활용 추가 시 확장.';
COMMENT ON COLUMN pulse_consents.event_type IS
  '''grant'' (동의) 또는 ''revoke'' (철회).';
COMMENT ON COLUMN pulse_consents.client_ip_hash IS
  'SHA-256(client_ip || daily_salt). IP 직접 저장 금지. daily_salt 는 1Password 보관.';

-- 사용자별 동의 이력 시계열 조회용
CREATE INDEX IF NOT EXISTS idx_pulse_consents_user
  ON pulse_consents(user_id, event_at DESC);

-- 약관 버전별 동의자 수 조회용 (분석·감사)
CREATE INDEX IF NOT EXISTS idx_pulse_consents_version
  ON pulse_consents(consent_version, event_type);


-- ── 3) scan_history 에 pulse_eligible 스냅샷 컬럼 ─────────
-- INSERT 시점에 users.pulse_consent_version IS NOT NULL 결과를 박는다.
-- 사용자가 동의 후 철회해도 과거 스캔은 그대로 집계 포함 (스냅샷 정책).
-- DEFAULT FALSE 라 출시 전 컬럼 추가해도 기존 row(0건) 안전.
ALTER TABLE scan_history
  ADD COLUMN IF NOT EXISTS pulse_eligible BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN scan_history.pulse_eligible IS
  '스캔 시점에 사용자가 Pulse 옵트인 상태였는지 스냅샷. INSERT 시 application 레이어에서 users.pulse_consent_version IS NOT NULL 값을 그대로 박는다. SOURCE: IP/pulse/migration_007_spec.md §3-3';

-- view 의 WHERE pulse_eligible=TRUE 쿼리 최적화 (partial index)
CREATE INDEX IF NOT EXISTS idx_scan_history_pulse_eligible
  ON scan_history(scanned_at DESC, product_id)
  WHERE pulse_eligible = TRUE;


-- ── 4) pulse_aggregations_v1 view (k≥10 강제) ────────────
-- 카테고리 × 프로필 × 주간 단위. k=10 미만은 자동 제외.
-- application 레이어에서 RAW 테이블 직접 조회 금지 — 본 view 만 사용.
CREATE OR REPLACE VIEW pulse_aggregations_v1 AS
SELECT
  p.food_category,
  u.profile_type,
  DATE_TRUNC('week', s.scanned_at)::DATE   AS week,
  COUNT(DISTINCT s.user_id)                AS unique_users,
  COUNT(*)                                 AS scan_count
FROM scan_history s
JOIN users    u ON s.user_id    = u.user_id
JOIN products p ON s.product_id = p.product_id
WHERE s.pulse_eligible = TRUE
GROUP BY p.food_category, u.profile_type, DATE_TRUNC('week', s.scanned_at)
HAVING COUNT(DISTINCT s.user_id) >= 10;

COMMENT ON VIEW pulse_aggregations_v1 IS
  'Pulse 집계 view v1. k-anonymity k=10 강제. 옵트인 사용자만 포함. SOURCE: IP/pulse/migration_007_spec.md §3-4';


-- ── 5) 마이그레이션 완료 로그 ────────────────────────────
-- (앱 시작 시 console 에 어떤 마이그레이션이 적용됐는지 확인할 수 있게,
--  실제 DDL 이외 메타 정보는 README 에 적시)
--
-- 적용 후 검증 쿼리 (수동 실행):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name='users' AND column_name='pulse_consent_version';
--   SELECT to_regclass('pulse_consents') AS table_exists;
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name='scan_history' AND column_name='pulse_eligible';
--   SELECT to_regclass('pulse_aggregations_v1') AS view_exists;
--
-- 모두 1 row 반환되면 적용 성공.
