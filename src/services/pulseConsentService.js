// src/services/pulseConsentService.js
// SOURCE: IP/pulse/auth_routes_design_2026-05-20.md §6 + v1.1 §6-4 (동시 호출 정책)
//         IP/pulse/migration_007_spec.md (이벤트 소싱 패턴 근거)
//         IP/pulse/cursor_prompts/02_pulse_consent_service.md §3-1

/**
 * Pulse 동의/철회 audit log 처리 + users.pulse_consent_version 상태 갱신.
 *
 * 사용 패턴 — 호출자(라우트)가 트랜잭션을 시작·종료:
 *   const client = await db.pool.connect();
 *   await client.query('BEGIN');
 *   try {
 *     await pulseConsentService.recordGrant(client, userId, 'v2', metadata);
 *     await client.query('COMMIT');
 *   } catch (err) {
 *     await client.query('ROLLBACK');
 *     throw err;
 *   } finally {
 *     client.release();
 *   }
 *
 * 또는 `database.transaction(async (client) => { ... })` 헬퍼 사용.
 *
 * 동시 호출 보호:
 *   - SELECT user_id ... FOR UPDATE 로 동일 user 의 grant/revoke 순차 처리 강제
 *   - 클라이언트 측은 별도 토글 disable 처리 (Flutter 트랙)
 */

const CONSENT_SCOPE = 'b2b_aggregate_insights';
const CURRENT_VERSION = 'v2';

// ══════════════════════════════════════════════════════════════════════════
// 스키마에서 온 상수 (세션49 — PC1·PC2 방어)
// ══════════════════════════════════════════════════════════════════════════

/**
 * pulse_consents.user_agent 의 실제 타입은 **VARCHAR(500)** 이다.
 *   근거: scripts/migrations/007_pulse_hooks.sql:54  `user_agent VARCHAR(500)`
 *         scripts/migrations/000_baseline.sql:653    `user_agent  VARCHAR(500)`
 * 501자 이상을 그대로 넣으면 [22001] value too long 이 나고, 이 INSERT 는
 * 회원가입(POST /api/users/me)과 **같은 트랜잭션** 안이라 가입 전체가 HTTP 500 으로 죽는다.
 *
 * ★ 절단은 **이 파일에서만** 한다 (아래 truncateUserAgent). 호출부는 헤더를 가공하지 않는다.
 *   근거: `pulse_consents` 에 INSERT 하는 코드는 저장소 전체에서 recordGrant/recordRevoke 둘뿐이고,
 *         둘 다 이 파일에 있다. 즉 이 파일이 그 컬럼의 **유일한 관문**이다.
 *         반대로 라우트에서 자르면 호출 지점 3곳(userRoutes:120·234·272)으로 규칙이 흩어져
 *         「한 경로만 고쳐지고 다른 경로가 샌다」가 재발한다(세션48 §4-5).
 *   ⇒ 관문에서 한 번 자르면 호출부가 무엇을 넘기든 이 컬럼은 안전하다.
 */
const USER_AGENT_MAX = 500;

/**
 * pulse_consents.consent_version 은 **VARCHAR(20) NOT NULL** 이다.
 *   근거: scripts/migrations/007_pulse_hooks.sql:48 `consent_version VARCHAR(20) NOT NULL, -- 'v2', 'v3', ...`
 *
 * ★★★ 허용 동의 버전 화이트리스트 — **새 약관 버전을 낼 때 반드시 이 배열에 추가해야 한다.**
 *     (여기에 없는 버전은 라우트가 HTTP 400 으로 거절한다. 배포 순서: 이 상수 먼저 → 클라이언트 나중.)
 *
 * 2026-08-01 저장소 전수 실측(grep) 결과 실제로 쓰이는 값은 **'v2' 하나뿐**이다:
 *   · CURRENT_VERSION = 'v2'                                    (이 파일 30행)
 *   · 007_pulse_hooks.sql:43-44  "NULL = 미동의 / 'v2' = 약관 v2 동의"
 *   · users.pulse_consent_version COMMENT 도 "''v2'' 등 약관 식별자"
 *   · 테스트 픽스처 전건 'v2' (test_user_routes.js:329 · test_scan_routes.js:253,299 ·
 *     test_pulse_consent_service.js:43,69,97 · test_schema_constraints.js:515,534,594)
 *   · 운영 스키마 덤프(schema/production_schema_2026-07-31.txt) users 행 수 0 → 실데이터 근거 없음
 * 007 주석의 'v3' 은 **형식 예시**일 뿐 이를 쓰는 코드·데이터가 아직 없어 넣지 않았다.
 */
const ALLOWED_CONSENT_VERSIONS = Object.freeze(['v2']);

/** 화이트리스트 검사. 문자열이 아니거나 목록에 없으면 false. */
function isAllowedConsentVersion(version) {
  return typeof version === 'string' && ALLOWED_CONSENT_VERSIONS.indexOf(version) !== -1;
}

/**
 * user_agent 를 VARCHAR(500) 에 맞게 자른다 — **이 컬럼 길이 책임의 유일한 지점**.
 * 자른 사실은 **조용히 삼키지 않고** 경고로 남긴다.
 * (logger 는 지연 require — 순수 단위 테스트가 winston 파일 트랜스포트를 열지 않게 하기 위함)
 */
function truncateUserAgent(ua) {
  if (ua === null || ua === undefined) return null;
  const s = String(ua);
  if (s.length <= USER_AGENT_MAX) return s || null;
  try {
    // eslint-disable-next-line global-require
    require('../config/logger').warn('pulse_consents.user_agent truncated (VARCHAR(500))', {
      original_length: s.length,
      kept: USER_AGENT_MAX,
      where: 'pulseConsentService',
    });
  } catch (_) { /* 로깅 실패가 동의 기록을 막아서는 안 된다 */ }
  return s.slice(0, USER_AGENT_MAX);
}

/**
 * 동의 기록 — users.pulse_consent_version SET + pulse_consents INSERT(grant).
 * ★ 트랜잭션 안에서 호출 필수 (SELECT FOR UPDATE 사용).
 *
 * @param {Object} db - pg client (transaction 안)
 * @param {number} userId - users.user_id (BIGINT)
 * @param {string} [version='v2'] - 동의 버전. 기본값 CURRENT_VERSION
 * @param {Object} [metadata={}] - { user_agent?: string, client_ip_hash?: string }
 * @returns {Promise<void>}
 */
async function recordGrant(db, userId, version = CURRENT_VERSION, metadata = {}) {
  // row lock — 동시 grant/revoke 호출 시 순차 처리 강제 (v1.1 §6-4)
  await db.query('SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE', [userId]);

  await db.query(
    'UPDATE users SET pulse_consent_version = $2 WHERE user_id = $1',
    [userId, version]
  );

  // append-only audit log
  await db.query(
    `INSERT INTO pulse_consents (user_id, consent_version, consent_scope, event_type, client_ip_hash, user_agent)
     VALUES ($1, $2, $3, 'grant', $4, $5)`,
    // ★ user_agent 는 VARCHAR(500) — 방어적으로 자른다 (USER_AGENT_MAX 주석 참조)
    [userId, version, CONSENT_SCOPE, metadata.client_ip_hash || null,
      truncateUserAgent(metadata.user_agent)]
  );
}

/**
 * 철회 기록 — users.pulse_consent_version NULL + pulse_consents INSERT(revoke).
 * ★ 트랜잭션 안에서 호출 필수 (SELECT FOR UPDATE 사용).
 *
 * @param {Object} db - pg client (transaction 안)
 * @param {number} userId
 * @param {string} [version='v2'] - 철회 시점의 동의 버전 (감사 추적용)
 * @param {Object} [metadata={}] - { user_agent?: string, client_ip_hash?: string }
 * @returns {Promise<void>}
 */
async function recordRevoke(db, userId, version = CURRENT_VERSION, metadata = {}) {
  // row lock
  await db.query('SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE', [userId]);

  await db.query(
    'UPDATE users SET pulse_consent_version = NULL WHERE user_id = $1',
    [userId]
  );

  // append-only audit log
  await db.query(
    `INSERT INTO pulse_consents (user_id, consent_version, consent_scope, event_type, client_ip_hash, user_agent)
     VALUES ($1, $2, $3, 'revoke', $4, $5)`,
    // ★ user_agent 는 VARCHAR(500) — 방어적으로 자른다 (USER_AGENT_MAX 주석 참조)
    [userId, version, CONSENT_SCOPE, metadata.client_ip_hash || null,
      truncateUserAgent(metadata.user_agent)]
  );
}

/**
 * 현재 동의 상태 조회.
 * 트랜잭션 불필요 (단순 SELECT). db.pool 또는 client 모두 사용 가능.
 *
 * @param {Object} db - pg pool 또는 client (둘 다 .query 메서드 제공)
 * @param {number} userId
 * @returns {Promise<string|null>} - 현재 consent_version 또는 null (미동의/사용자 없음)
 */
async function getCurrentConsent(db, userId) {
  const result = await db.query(
    'SELECT pulse_consent_version FROM users WHERE user_id = $1',
    [userId]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].pulse_consent_version || null;
}

/**
 * 동의 이력 조회 (감사·법무 대응용).
 * 트랜잭션 불필요. append-only 테이블 조회.
 *
 * @param {Object} db - pg pool 또는 client
 * @param {number} userId
 * @returns {Promise<Array<{consent_version:string, consent_scope:string, event_type:string, event_at:string, user_agent:string|null}>>}
 *          event_at DESC 정렬된 이벤트 row 배열
 */
async function getConsentHistory(db, userId) {
  const result = await db.query(
    `SELECT consent_version, consent_scope, event_type, event_at, user_agent
     FROM pulse_consents
     WHERE user_id = $1
     ORDER BY event_at DESC`,
    [userId]
  );
  return result.rows;
}

module.exports = {
  CONSENT_SCOPE,
  CURRENT_VERSION,
  USER_AGENT_MAX,
  ALLOWED_CONSENT_VERSIONS,
  isAllowedConsentVersion,
  truncateUserAgent,
  recordGrant,
  recordRevoke,
  getCurrentConsent,
  getConsentHistory,
};
