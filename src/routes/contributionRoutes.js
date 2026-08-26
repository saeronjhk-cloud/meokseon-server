/**
 * contributionRoutes.js — 「내 제보 이력」 (세션64c 신설 · 세션64c 인증 전환)
 * /api/contributions
 * ============================================================================
 * 왜 이 파일이 있는가 — 제이 지시(2026-08-23):
 *   「제보에 대한 결과를 당장이든 검증 후든 소비자에게 제공해야 해.」
 *
 *   앱은 제보 직후 「등록되면 알려드릴게요」라고 **약속하는데 지키는 코드가 없었다.**
 *   서버에 제보 조회 경로는 관리자용 `GET /api/admin/contributions/:productId` **하나뿐**이고
 *   (`adminRoutes.js:182`), 그것은 «제품» 기준이라 「내가 뭘 올렸나」를 물을 수 없다.
 *   → 소비자가 **자기 제보를 자기 눈으로** 확인할 수 있는 유일한 경로를 연다.
 *
 * ★★ 왜 이제 `device_id` 가 아닌가 (제이 확정 2026-08-24)
 *   「지금까지 별개의 앱을 별개의 방식으로 인증받았다. 통합이 진행되므로
 *     통합앱의 인증 방법으로 변경해야 한다.」 + 「제보도 로그인 필수」
 *   초판(같은 세션 앞부분)은 앱=Supabase / 서버=Firebase 라 이을 방법이 없어
 *   `?device_id=<uuid>` 를 열쇠로 썼다. 그 판에는 **인증이 아예 없었고**,
 *   남의 device_id 를 넣으면 그 사람 제보가 보였다(그 파일이 스스로 한계로 적어 둔 것).
 *   → 이제 **Supabase 토큰이 유일한 열쇠**다. `?device_id=` 는 **폐기**한다.
 *     쿼리로 남기면 「인증을 우회하는 뒷문」이 그대로 남는다. 받지 않는다.
 *
 *   ⚠ `contributions.device_id` **컬럼 자체는 살아 있다.** 24시간 중복 게이트와
 *     자동 verified 승격(distinct 3기기)이 그 값을 쓴다. 지우는 것은 별개 작업이다.
 *
 * ⚠ 개인정보를 싣지 않는다.
 *   `contributions.data` 에는 OCR 원문(`ocr_raw_text`)·사용자 입력 메타(`user_input`)·
 *   `device_id` 가 들어 있다. **그 컬럼을 통째로 내보내지 않는다.**
 *   응답은 제품 정보(barcode·product_name·product_id)와 상태·시각뿐이다.
 *   ★ 이 규칙을 깨려면 아래 SELECT 를 고쳐야 한다 — `SELECT c.*` 로 바꾸지 말 것.
 */
'use strict';

const express = require('express');
const db = require('../config/database');
const { supabaseAuth } = require('../middleware/supabaseAuth');
const { findUserId, handleStoreNotReady } = require('../services/authUserService');

const router = express.Router();

/**
 * 한 번에 내보낼 수 있는 최대 개수. 무한 조회를 막는다.
 * ⚠ 상한을 «넘으면 에러»가 아니라 «상한으로 깎는다» — 페이징은 사용자가 고칠 수 있는 것이
 *   아니라 앱이 정하는 값이다. 여기서 400 을 내면 구버전 앱이 이력 화면을 통째로 못 연다.
 */
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

/**
 * 정수 쿼리 파라미터를 «안전하게» 읽는다.
 * `parseInt('20abc')` 는 20 이고 `Number(null)` 은 0 이다 — 둘 다 조용히 틀린 답을 준다.
 * @param {*} raw
 * @param {number} fallback
 * @returns {number|null} 형식이 정수가 아니면 null (호출부가 400 을 낼지 폴백할지 정한다)
 */
function readInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

// ============================================================
// GET /api/contributions/mine?limit=20&offset=0   (Authorization 필수)
// ============================================================
router.get('/mine', supabaseAuth, async (req, res, next) => {
  // ── ① 페이징 ────────────────────────────────────────────────────────────
  const limitRaw = readInt(req.query?.limit, DEFAULT_LIMIT);
  const offsetRaw = readInt(req.query?.offset, 0);
  if (limitRaw === null || offsetRaw === null) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'PAGINATION_INVALID',
        // ⚠ 앱이 사용자에게 그대로 보여줄 수 있는 문장이다. 기술 용어를 넣지 말 것.
        message: '목록 범위 값이 올바르지 않아요.',
      },
    });
  }
  // 0 은 「아무것도 안 준다」가 되어 빈 목록과 구분이 안 된다 → 최소 1.
  const limit = Math.min(Math.max(limitRaw, 1), MAX_LIMIT);
  const offset = offsetRaw;

  try {
    // ── ② 내부 user_id ────────────────────────────────────────────────────
    // ★ 조회 전용이다. **행을 만들지 않는다** — GET 이 users 를 부풀리면 안 된다.
    //   행이 아직 없으면(가입 전) 제보도 있을 수 없다 → 200 + 빈 목록.
    //   ⚠ 404 로 내리지 않는다. 앱의 이력 화면이 「아직 제보가 없어요」를 그리면 되는
    //     상황을 에러 화면으로 만들 이유가 없다.
    const userId = await findUserId(req.auth.supabaseUid);
    if (userId === null) {
      return res.json({ success: true, data: { items: [], total: 0, limit, offset } });
    }

    // ── ③ 조회 ────────────────────────────────────────────────────────────
    // ★ `WHERE c.user_id = $1` — **BIGINT** 다. `supabase_uid`(UUID 문자열)를 여기 넣으면
    //   [22P02] 로 죽는다. 그 변환은 authUserService 한 곳에서만 한다.
    //
    // ★ `LEFT JOIN products` — 제품이 **아직 없을 수 있다.**
    //   `contributions.product_id` 는 NULL 을 허용하고(스키마), 바코드 없는 제보나
    //   저장 도중 제품 생성이 안 된 경우가 있다. INNER JOIN 이면 그 제보가 이력에서 «사라진다».
    //
    // ★ `ORDER BY created_at DESC, contribution_id DESC` — 같은 초에 두 건이 들어와도
    //   페이징이 흔들리지 않게 tie-breaker 를 둔다(없으면 2페이지에 1페이지 항목이 또 나온다).
    const itemsQ = await db.query(
      `SELECT
         c.contribution_id,
         c.created_at,
         c.status,
         c.product_id,
         c.data->>'nutrition_status' AS nutrition_status,
         p.barcode,
         p.product_name
       FROM contributions c
       LEFT JOIN products p ON p.product_id = c.product_id
       WHERE c.user_id = $1
       ORDER BY c.created_at DESC, c.contribution_id DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    // ★ total 은 **페이지가 아니라 전체**다. 앱이 「더 보기」를 띄울지 판단하는 유일한 값이다.
    const totalQ = await db.query(
      'SELECT COUNT(*)::int AS total FROM contributions WHERE user_id = $1',
      [userId]
    );

    // ── ④ 응답 조립 ───────────────────────────────────────────────────────
    // ⚠ **여기서 키를 하나씩 명시적으로 적는다.** `...row` 로 펼치지 말 것 —
    //   나중에 SELECT 에 컬럼이 하나 추가되는 순간 개인정보가 조용히 새어 나간다.
    //   ★ 정직하게: 진짜 방어선은 **위 SELECT** 다. 뮤테이션 실측(세션64c) — 여기를 `...r` 로
    //     바꾸기만 한 것은 회귀가 «안 잡힌다»(SELECT 가 안전한 7개만 주므로 동작이 같다).
    //     SELECT 에 `c.data`·`c.device_id` 를 더한 뮤테이션은 잡힌다(테스트 §3, 2건 빨강).
    //     → 이 명시적 나열은 「그것만으로 충분한 방어」가 아니라 **SELECT 를 고칠 때
    //       여기도 보게 만드는 표식**이다. SELECT 를 넓히지 않는 것이 규칙이다.
    const items = itemsQ.rows.map((r) => ({
      contribution_id: Number(r.contribution_id),
      created_at: r.created_at,
      // 제품이 아직 없으면 둘 다 null 이다. 앱은 이 경우 「이 제품 보기」를 숨긴다.
      product_id: r.product_id === null || r.product_id === undefined ? null : Number(r.product_id),
      barcode: r.barcode ?? null,
      product_name: r.product_name ?? null,
      // ★ `contributions.status` 원본 그대로다. 서버가 «해석»해서 「검토 중」·「반영됨」 같은
      //   말로 바꾸지 않는다 — 그 문구는 앱이 만든다(photoReport.ts 의 코드별 문구와 같은 원칙).
      //   ⚠⚠ 실측: 이 값은 관리자가 `POST /api/admin/verify/:productId` 를 부르기 전까지
      //     **영원히 'pending' 이다.** 자동으로 바뀌는 코드가 서버 어디에도 없다.
      //     앱이 'pending' 을 「검토 중」이라고 말하는 것은 사실이지만,
      //     「곧 바뀝니다」라고 말하면 그건 거짓이다. 세션64c 보고서에 명시했다.
      status: r.status ?? null,
      // 저장 «당시» 값이다. 없으면 null — 나중에 만들어 채우지 않는다
      //   (세션64b 이전 제보와 `error_report` 에는 이 키가 아예 없다).
      nutrition_status: r.nutrition_status ?? null,
    }));

    return res.json({
      success: true,
      data: {
        items,
        // ⚠ `COUNT(*)` 는 드라이버에 따라 **문자열**로 온다(bigint). `::int` 를 걸어도
        //   pg 는 int4 를 숫자로 주지만 확실히 못 박는다 — 앱이 `total > items.length` 로
        //   「더 보기」를 판단하는데 `"3" > 3` 은 false 라 버튼이 조용히 사라진다.
        total: Number(totalQ.rows[0]?.total ?? 0),
        limit,
        offset,
      },
    });
  } catch (err) {
    // ★ 021 미적용(users.supabase_uid 없음)이면 500 스택이 아니라 503 + 원인 코드.
    if (handleStoreNotReady(err, res)) return;
    return next(err);
  }
});

module.exports = router;
