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
    [userId, version, CONSENT_SCOPE, metadata.client_ip_hash || null, metadata.user_agent || null]
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
    [userId, version, CONSENT_SCOPE, metadata.client_ip_hash || null, metadata.user_agent || null]
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
  recordGrant,
  recordRevoke,
  getCurrentConsent,
  getConsentHistory,
};
