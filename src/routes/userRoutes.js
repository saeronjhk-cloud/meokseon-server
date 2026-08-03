/**
 * 먹선 사용자 라우트 (/api/users/me)
 * 회원가입(첫 로그인) + 마이페이지 + Pulse 동의/철회 + 탈퇴.
 *
 * SOURCE: IP/pulse/auth_routes_design_2026-05-20.md §4 + v1.1 §4-3·§4-6
 *         IP/pulse/cursor_prompts/03_user_routes.md
 *
 * 인증: 모든 엔드포인트 firebaseAuth 필수.
 * 트랜잭션: POST /me, /pulse-consent/grant, /pulse-consent/revoke 는 BEGIN/COMMIT 안.
 *           SELECT FOR UPDATE 가 들어가는 함수는 client (트랜잭션) 전달 필수.
 */

const express = require('express');
const { firebaseAuth } = require('../middleware/firebaseAuth');
const { getAdmin } = require('../config/firebase');
const pulseConsentService = require('../services/pulseConsentService');
const db = require('../config/database');
const logger = require('../config/logger');

const router = express.Router();

// ============================================================
// 0. 요청 검증 상수 (세션49 — PC1·PC2 방어). ★ 새 값은 전부 여기에 모아 둔다.
// ============================================================
/**
 * PC1 — `pulse_consents.user_agent` 는 **VARCHAR(500)** 이다
 *       (scripts/migrations/007_pulse_hooks.sql:54 · 000_baseline.sql:653).
 *       501자 UA(구형 웹뷰·크롤러)를 자르지 않고 넣으면 [22001] 이 나고,
 *       그 INSERT 가 회원가입과 같은 트랜잭션이라 POST /api/users/me 가 통째로 HTTP 500 이 된다.
 *
 * ★ 절단은 **여기서 하지 않는다.** `pulseConsentService.truncateUserAgent` 한 곳에서만 한다.
 *   근거: `pulse_consents` 에 INSERT 하는 코드는 저장소 전체에서 pulseConsentService 뿐이다
 *         (recordGrant/recordRevoke 2개 함수). 즉 그 파일이 이 컬럼의 **유일한 관문**이다.
 *         반면 이 라우트는 호출 지점이 3곳(:120·:234·:272)이라, 여기서 자르면 같은 규칙이
 *         3+1 군데로 흩어지고 「한 경로만 고쳐지고 다른 경로가 샌다」가 재발한다
 *         (세션48 §4-5 「같은 의미를 여러 경로에서 재해석한다」 패턴).
 *   ⇒ 라우트는 헤더를 **가공하지 않고** 넘긴다. 길이 책임은 관문이 진다.
 */

/**
 * PC2 — `pulse_consents.consent_version` 은 **VARCHAR(20) NOT NULL**.
 *       req.body 의 pulse_consent_version 을 그대로 넣으면 21자 이상일 때 [22001] 로
 *       가입 트랜잭션이 죽어 클라이언트가 400 대신 500 을 받는다.
 *       길이만 자르면 **틀린 버전 문자열이 조용히 저장**되므로(데이터 오염) 자르지 않고
 *       화이트리스트로 검증해 **HTTP 400** 을 돌려준다.
 *
 * ★★★ 새 약관 버전(v3 …)을 낼 때는 `src/services/pulseConsentService.js` 의
 *     `ALLOWED_CONSENT_VERSIONS` 에 **반드시 추가**해야 한다. 안 그러면 새 버전을 보내는
 *     클라이언트가 전부 400 을 맞는다. 배포 순서: 서버(상수) 먼저 → 클라이언트 나중.
 *     실측 근거는 그 상수의 주석에 적어 두었다 (2026-08-01 기준 실제 사용값은 'v2' 뿐).
 */
const ALLOWED_CONSENT_VERSIONS = pulseConsentService.ALLOWED_CONSENT_VERSIONS;

/**
 * 요청의 User-Agent 를 서비스에 넘길 형태로 정규화한다.
 * 하는 일은 **「헤더 없음/빈 문자열 → null」 하나뿐**이다. 빈 문자열과 미상(null)은 다르고,
 * 감사 로그에서 ''(보냈지만 비어 있음)와 NULL(모름)이 섞이면 안 된다.
 *
 * ★ 길이 절단은 여기서 하지 않는다 — 위 PC1 주석 참조(관문은 pulseConsentService).
 */
function clientUserAgent(req) {
  return req.headers['user-agent'] || null;
}

// ============================================================
// 1. POST /api/users/me — 첫 로그인 시 가입 (idempotent UPSERT) + 약관 동의
// ============================================================
// v1.1 §4-3: ON CONFLICT 패턴으로 race condition 안전.
router.post('/me', firebaseAuth, async (req, res, next) => {
  const { uid, email, name: firebaseName } = req.firebase;
  const { display_name, profile_type, pulse_consent_version } = req.body || {};

  // PC2 — 외부 입력 검증은 **트랜잭션을 열기 전에**. 여기서 400 을 주면 users 행 자체가 안 생긴다.
  if (pulse_consent_version && !pulseConsentService.isAllowedConsentVersion(pulse_consent_version)) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_CONSENT_VERSION',
        // ★ 응답 모양은 저장소 관례 그대로 { success, error:{ code, message } } 다.
        //   허용 목록은 scanRoutes 의 INVALID_SCAN_TYPE 과 같이 message 안에 적는다
        //   (error 에 임의 필드를 더하면 클라이언트 파서가 라우트마다 갈린다).
        message: `pulse_consent_version은 ${ALLOWED_CONSENT_VERSIONS.map((v) => `'${v}'`).join('|')} 중 하나여야 합니다.`,
      },
    });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 1) UPSERT — 신규면 RETURNING user_id, 충돌이면 빈 rows.
    const upsertResult = await client.query(
      `INSERT INTO users (firebase_uid, email, display_name, profile_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (firebase_uid) DO NOTHING
       RETURNING user_id`,
      [uid, email, display_name || firebaseName || null, profile_type || 'adult']
    );

    let userId;
    let created = false;
    if (upsertResult.rows.length > 0) {
      userId = upsertResult.rows[0].user_id;
      created = true;
    } else {
      // ON CONFLICT — 이미 존재하는 user. user_id 조회.
      const existing = await client.query(
        'SELECT user_id FROM users WHERE firebase_uid = $1',
        [uid]
      );
      userId = existing.rows[0].user_id;
    }

    // 2) Pulse 동의가 요청에 포함되면 audit log 기록 + users.pulse_consent_version SET.
    if (pulse_consent_version) {
      await pulseConsentService.recordGrant(
        client,
        userId,
        pulse_consent_version,
        { user_agent: clientUserAgent(req) }   // PC1 — 절단은 서비스가 한다 (관문 1곳)
      );
    }

    await client.query('COMMIT');

    // 3) 최종 상태 조회·응답 (트랜잭션 밖, pool 사용)
    const result = await db.query('SELECT * FROM users WHERE user_id = $1', [userId]);
    res.status(created ? 201 : 200).json({
      success: true,
      data: result.rows[0],
      meta: { created },
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* rollback failure ignored */ }
    next(err);
  } finally {
    client.release();
  }
});

// ============================================================
// 2. GET /api/users/me — 현재 사용자 조회
// ============================================================
router.get('/me', firebaseAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT * FROM users WHERE firebase_uid = $1',
      [req.firebase.uid]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: '사용자 정보가 없습니다. 먼저 POST /users/me를 호출하세요.',
        },
      });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// 3. PATCH /api/users/me — display_name·profile_type 수정
// ============================================================
// 이메일·firebase_uid 는 변경 불가 (IDOR 방지: req.firebase.uid 만 사용).
router.patch('/me', firebaseAuth, async (req, res, next) => {
  const { display_name, profile_type } = req.body || {};
  if (display_name === undefined && profile_type === undefined) {
    return res.status(400).json({
      success: false,
      error: { code: 'NO_FIELDS', message: '변경할 필드가 없습니다.' },
    });
  }

  try {
    const sets = [];
    const params = [];
    let i = 1;
    if (display_name !== undefined) {
      sets.push(`display_name = $${i++}`);
      params.push(display_name);
    }
    if (profile_type !== undefined) {
      sets.push(`profile_type = $${i++}`);
      params.push(profile_type);
    }
    params.push(req.firebase.uid);

    const result = await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE firebase_uid = $${i} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: '사용자 정보가 없습니다.' },
      });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// 4. POST /api/users/me/pulse-consent/grant — 마이페이지 동의 ON
// ============================================================
router.post('/me/pulse-consent/grant', firebaseAuth, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query(
      'SELECT user_id FROM users WHERE firebase_uid = $1',
      [req.firebase.uid]
    );
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: '사용자 정보가 없습니다.' },
      });
    }
    const userId = userResult.rows[0].user_id;

    await pulseConsentService.recordGrant(
      client,
      userId,
      pulseConsentService.CURRENT_VERSION,
      { user_agent: clientUserAgent(req) }   // PC1 — 절단은 서비스가 한다 (관문 1곳)
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    next(err);
  } finally {
    client.release();
  }
});

// ============================================================
// 5. POST /api/users/me/pulse-consent/revoke — 마이페이지 동의 OFF
// ============================================================
router.post('/me/pulse-consent/revoke', firebaseAuth, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query(
      'SELECT user_id FROM users WHERE firebase_uid = $1',
      [req.firebase.uid]
    );
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: '사용자 정보가 없습니다.' },
      });
    }
    const userId = userResult.rows[0].user_id;

    await pulseConsentService.recordRevoke(
      client,
      userId,
      pulseConsentService.CURRENT_VERSION,
      { user_agent: clientUserAgent(req) }   // PC1 — 절단은 서비스가 한다 (관문 1곳)
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    next(err);
  } finally {
    client.release();
  }
});

// ============================================================
// 6. DELETE /api/users/me — Firebase 먼저, DB CASCADE 다음 (v1.1 §4-6)
// ============================================================
// Firebase 실패 시 DB 변경 없이 사용자가 재시도 가능.
// DB 실패 시 orphan row 발생 가능 — 운영 cleanup 큐(별도 task)로 처리.
router.delete('/me', firebaseAuth, async (req, res, next) => {
  try {
    const userResult = await db.query(
      'SELECT user_id FROM users WHERE firebase_uid = $1',
      [req.firebase.uid]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: '사용자 정보가 없습니다.' },
      });
    }
    const userId = userResult.rows[0].user_id;

    // 1) Firebase 계정 먼저 — 실패 시 DB 변경 0.
    try {
      await getAdmin().auth().deleteUser(req.firebase.uid);
    } catch (err) {
      logger.error('Firebase deleteUser failed', {
        uid: req.firebase.uid,
        error: err.message,
      });
      return res.status(500).json({
        success: false,
        error: {
          code: 'FIREBASE_DELETE_FAILED',
          message: '계정 삭제 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
        },
      });
    }

    // 2) DB DELETE — ON DELETE CASCADE 로 관련 row 자동 삭제.
    try {
      await db.query('DELETE FROM users WHERE user_id = $1', [userId]);
    } catch (err) {
      // Firebase 가입은 이미 삭제됨 → 사용자는 재가입 가능. orphan DB row 는 운영 cleanup.
      logger.error('DB DELETE failed after Firebase deleteUser', {
        userId,
        uid: req.firebase.uid,
        error: err.message,
      });
      // 사용자에게는 성공 응답 (Firebase 입장에서 삭제 완료).
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
