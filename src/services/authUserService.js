// src/services/authUserService.js
// ============================================================================
// Supabase 신원(UUID 문자열) → 먹선 내부 user_id(BIGINT) 매핑 — 세션64c 신설
//
// 왜 이 파일이 있는가
//   `req.auth.supabaseUid` 는 **UUID 문자열**이고,
//   `contributions.user_id` · `scan_history.user_id` 는 **BIGINT REFERENCES users(user_id)** 다.
//   ★★★ 이 둘을 직접 이으면 안 된다. UUID 를 BIGINT 컬럼에 넣으면 [22P02] 로 죽고,
//        운 나쁘게 숫자로 보이는 값이면 **남의 행에 붙는다.**
//   → `users.supabase_uid` 로 조회/생성해 얻은 **BIGINT** 만 FK 로 쓴다.
//
//   마이그레이션: `scripts/migrations/021_supabase_auth.sql`
//     users.supabase_uid VARCHAR + UNIQUE INDEX users_supabase_uid_key
//
// ★ 왜 «UPSERT» 인가
//   종전 흐름은 「앱이 POST /api/users/me 를 먼저 불러 가입한다」였다.
//   제보(`/api/ocr/confirm`)는 그 호출을 **보장할 수 없다** — 앱이 순서를 어기거나
//   가입 호출이 실패하면 제보가 통째로 500 이 되거나 user_id 없이 저장된다.
//   (`contributions.user_id` 가 지금까지 «항상 null» 이었던 것이 바로 그 증상이다.)
//   → 인증에 성공한 사람은 **그 자리에서** users 행을 갖는다. 멱등하다.
//
// ★ 왜 별도 파일인가
//   이 UPSERT 를 부르는 곳이 라우트 3+개(ocrRoutes·contributionRoutes·scanRoutes)다.
//   라우트마다 복사하면 「한 경로만 고쳐지고 다른 경로가 샌다」가 재발한다
//   (세션48 §4-5 · userRoutes PC1 주석과 같은 원칙: **관문은 한 곳**).
// ============================================================================
'use strict';

const db = require('../config/database');
const logger = require('../config/logger');

/**
 * 컬럼/인덱스가 아직 없는 운영 DB 에서 나는 Postgres 에러 코드.
 *   42703 undefined_column          — 021 마이그레이션 미적용
 *   42P10 invalid_column_reference  — ON CONFLICT 가 쓸 유니크 인덱스가 없음
 * 이 둘은 **사용자 잘못이 아니라 배포 순서 문제**다. 500 스택으로 묻지 않는다.
 */
const SCHEMA_NOT_READY = new Set(['42703', '42P10']);

/**
 * 스키마 미적용을 호출부가 «알아볼 수 있는» 형태로 감싼다.
 * 라우트는 `err.code === 'AUTH_STORE_NOT_READY'` 만 보고 503 을 낸다.
 */
class AuthStoreNotReadyError extends Error {
  constructor(cause) {
    super('users.supabase_uid 가 아직 없다 — 021_supabase_auth.sql 미적용');
    this.name = 'AuthStoreNotReadyError';
    this.code = 'AUTH_STORE_NOT_READY';
    this.cause = cause;
  }
}

/**
 * 던져진 에러가 「021 미적용」인지 판별해 감싼다. 아니면 그대로 다시 던진다.
 * @param {Error & { code?: string }} err
 */
function rethrow(err) {
  if (err && SCHEMA_NOT_READY.has(err.code)) {
    // ★ 이 로그가 「왜 갑자기 전부 503 인가」의 유일한 단서가 된다. 원인을 문장으로 남긴다.
    logger.error('021_supabase_auth.sql 이 아직 적용되지 않았다 (배포 순서: 마이그레이션 → 환경변수 → 코드)', {
      pgCode: err.code,
      detail: err.message,
    });
    throw new AuthStoreNotReadyError(err);
  }
  throw err;
}

/**
 * 조회 전용 — 없으면 생성하지 «않는다».
 *
 * ★ GET 요청(예: `GET /api/contributions/mine`)에서 쓴다. 읽기가 행을 만들면
 *   토큰만 있으면 누구나 users 를 부풀릴 수 있고, 「가입」의 의미도 흐려진다.
 *
 * @param {string} supabaseUid
 * @param {{ query: Function }} [conn] 트랜잭션 client (없으면 pool)
 * @returns {Promise<number|null>} 내부 user_id(BIGINT) 또는 null
 */
async function findUserId(supabaseUid, conn = db) {
  if (typeof supabaseUid !== 'string' || !supabaseUid.trim()) return null;
  try {
    const r = await conn.query(
      'SELECT user_id FROM users WHERE supabase_uid = $1',
      [supabaseUid]
    );
    if (r.rows.length === 0) return null;
    // ⚠ bigint 는 pg 드라이버가 **문자열**로 준다. Number 로 못 박지 않으면
    //   `user_id === 3` 같은 비교가 조용히 false 가 된다.
    return Number(r.rows[0].user_id);
  } catch (err) {
    return rethrow(err);
  }
}

/**
 * 조회 후 없으면 생성 (멱등). 쓰기 경로(제보 저장 등)에서 쓴다.
 *
 * ★ `ON CONFLICT (supabase_uid) DO UPDATE` 를 쓰는 이유
 *   `DO NOTHING` 이면 충돌 시 RETURNING 이 **빈 rows** 라 한 번 더 SELECT 해야 한다
 *   (`userRoutes.js` 의 firebase 판이 그렇게 돼 있다 — 왕복 2회).
 *   `DO UPDATE` 는 충돌해도 행을 돌려주므로 **항상 1왕복**이고 경쟁 상태에도 안전하다.
 *
 * ★ email 은 `COALESCE(EXCLUDED.email, users.email)` 로 **덮어쓰되 지우지는 않는다.**
 *   토큰에 email 클레임이 없는 로그인(전화·익명)이 기존 이메일을 **NULL 로 날리는 것**을 막는다.
 *   (세션64b 가 mergeService 에서 만난 것과 같은 유형의 함정이다.)
 *
 * @param {{ supabaseUid: string, email?: string|null }} auth
 * @param {{ query: Function }} [conn]
 * @returns {Promise<number>} 내부 user_id(BIGINT)
 */
async function getOrCreateUserId(auth, conn = db) {
  const uid = auth && typeof auth.supabaseUid === 'string' ? auth.supabaseUid.trim() : '';
  if (!uid) throw new Error('getOrCreateUserId: supabaseUid 가 없다');
  const email = auth.email ?? null;

  try {
    const r = await conn.query(
      `INSERT INTO users (supabase_uid, email)
       VALUES ($1, $2)
       ON CONFLICT (supabase_uid)
       DO UPDATE SET email = COALESCE(EXCLUDED.email, users.email)
       RETURNING user_id`,
      [uid, email]
    );
    return Number(r.rows[0].user_id);
  } catch (err) {
    return rethrow(err);
  }
}

/**
 * 라우트가 그대로 쓸 수 있는 503 응답. 「명확한 오류」의 실체다.
 * ⚠ 401 로 내리지 않는다 — 사용자는 아무리 다시 로그인해도 못 고친다.
 */
function respondStoreNotReady(res) {
  return res.status(503).json({
    success: false,
    error: {
      code: 'AUTH_STORE_NOT_READY',
      message: '서버 점검 중이에요. 잠시 후 다시 시도해 주세요.',
    },
  });
}

/**
 * 에러가 「021 미적용」이면 503 을 내고 true 를 돌려준다. 아니면 false.
 * 라우트의 catch 에서 `if (handleStoreNotReady(err, res)) return;` 한 줄로 쓴다.
 *
 * ★ **두 모양을 모두 받는다.**
 *   ① 이 서비스를 거친 것 → `AuthStoreNotReadyError`
 *   ② 라우트가 `WHERE supabase_uid = $1` 을 **직접** 질의한 것 → 날것의 pg 에러(42703)
 *   ②를 빠뜨리면 scanRoutes·userRoutes 처럼 직접 질의하는 곳만 500 이 난다.
 */
function handleStoreNotReady(err, res) {
  if (!err) return false;
  const isWrapped = err.code === 'AUTH_STORE_NOT_READY';
  const isRawPg = SCHEMA_NOT_READY.has(err.code);
  if (!isWrapped && !isRawPg) return false;
  if (isRawPg) {
    logger.error('021_supabase_auth.sql 이 아직 적용되지 않았다 (배포 순서: 마이그레이션 → 환경변수 → 코드)', {
      pgCode: err.code,
      detail: err.message,
    });
  }
  respondStoreNotReady(res);
  return true;
}

module.exports = {
  findUserId,
  getOrCreateUserId,
  handleStoreNotReady,
  respondStoreNotReady,
  AuthStoreNotReadyError,
};
