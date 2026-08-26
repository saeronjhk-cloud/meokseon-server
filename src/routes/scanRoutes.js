/**
 * 먹선 스캔 라우트 (/api/scans)
 * 스캔 기록 INSERT + 본인 이력 조회.
 *
 * SOURCE: IP/pulse/auth_routes_design_2026-05-20.md §5
 *         IP/pulse/cursor_prompts/04_scan_routes.md
 *         IP/pulse/migration_007_spec.md (pulse_eligible 스냅샷 정책)
 *
 * ★ 핵심 책임 — pulse_eligible 스냅샷:
 *   스캔 시점의 users.pulse_consent_version 을 BOOLEAN 으로 박아 scan_history.pulse_eligible 에 INSERT.
 *   이후 동의 상태가 바뀌어도 과거 row 의 pulse_eligible 은 불변 (이벤트 소싱 = 스냅샷 정책).
 *
 * 인증: 모든 엔드포인트 supabaseAuth 필수 (게스트 접근 불가). ★ 세션64c 전환
 * 트랜잭션: 단순 SELECT + INSERT 만 (FOR UPDATE 없음) 라 트랜잭션 불필요.
 */

const express = require('express');
// ★★ 세션64c — Firebase → Supabase 인증 전환(제이 확정 2026-08-24).
//   ⚠ `firebaseAuth.js` 는 «지우지 않았다» — 전환 기간에 공존한다. 여기서는 참조만 바꾼다.
const { supabaseAuth } = require('../middleware/supabaseAuth');
const { handleStoreNotReady } = require('../services/authUserService');
const db = require('../config/database');

const router = express.Router();

const ALLOWED_SCAN_TYPES = ['barcode', 'ocr', 'search'];
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

// ============================================================
// POST /api/scans — 스캔 기록 (★ pulse_eligible 스냅샷 박는 지점)
// ============================================================
router.post('/', supabaseAuth, async (req, res, next) => {
  const { product_id, scan_type } = req.body || {};

  // 입력 검증
  if (!product_id || !scan_type) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'MISSING_FIELDS',
        message: 'product_id와 scan_type은 필수입니다.',
      },
    });
  }
  if (!ALLOWED_SCAN_TYPES.includes(scan_type)) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_SCAN_TYPE',
        message: "scan_type은 'barcode'|'ocr'|'search' 중 하나여야 합니다.",
      },
    });
  }

  try {
    // 1) user_id + 동의 상태 한 번에 조회 (round-trip 절약).
    const userResult = await db.query(
      'SELECT user_id, pulse_consent_version FROM users WHERE supabase_uid = $1',
      [req.auth.supabaseUid]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: '사용자 정보가 없습니다. 먼저 POST /users/me를 호출하세요.',
        },
      });
    }
    const { user_id, pulse_consent_version } = userResult.rows[0];

    // 2) ★ pulse_eligible 스냅샷 결정 — 동적 JOIN 절대 사용 안 함.
    const pulseEligible = pulse_consent_version !== null;

    // 3) scan_history INSERT (product_id NULL 허용은 본 라우트 책임 아님 — FK 가 처리).
    const result = await db.query(
      `INSERT INTO scan_history (user_id, product_id, scan_type, pulse_eligible)
       VALUES ($1, $2, $3, $4)
       RETURNING scan_id, scanned_at, pulse_eligible`,
      [user_id, product_id, scan_type, pulseEligible]
    );

    res.status(201).json({
      success: true,
      data: result.rows[0],
    });
  } catch (err) {
    // ★ 021 미적용(users.supabase_uid 없음)이면 500 스택이 아니라 503 + 원인 코드.
    if (handleStoreNotReady(err, res)) return;
    next(err);
  }
});

// ============================================================
// GET /api/scans — 본인 스캔 이력 (DESC 정렬 + pagination)
// ============================================================
// IDOR 방지: req.auth.supabaseUid 만 사용. body·query 의 user_id 무시.
router.get('/', supabaseAuth, async (req, res, next) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const userResult = await db.query(
      'SELECT user_id FROM users WHERE supabase_uid = $1',
      [req.auth.supabaseUid]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: '사용자 정보가 없습니다.' },
      });
    }
    const userId = userResult.rows[0].user_id;

    const result = await db.query(
      `SELECT scan_id, product_id, scan_type, scanned_at, pulse_eligible
       FROM scan_history
       WHERE user_id = $1
       ORDER BY scanned_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    res.json({
      success: true,
      data: result.rows,
      meta: { limit, offset, count: result.rows.length },
    });
  } catch (err) {
    // ★ 021 미적용(users.supabase_uid 없음)이면 500 스택이 아니라 503 + 원인 코드.
    if (handleStoreNotReady(err, res)) return;
    next(err);
  }
});

module.exports = router;
