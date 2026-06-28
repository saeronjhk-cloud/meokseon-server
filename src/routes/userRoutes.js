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
// 1. POST /api/users/me — 첫 로그인 시 가입 (idempotent UPSERT) + 약관 동의
// ============================================================
// v1.1 §4-3: ON CONFLICT 패턴으로 race condition 안전.
router.post('/me', firebaseAuth, async (req, res, next) => {
  const { uid, email, name: firebaseName } = req.firebase;
  const { display_name, profile_type, pulse_consent_version } = req.body || {};

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
        { user_agent: req.headers['user-agent'] || null }
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
      { user_agent: req.headers['user-agent'] || null }
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
      { user_agent: req.headers['user-agent'] || null }
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
