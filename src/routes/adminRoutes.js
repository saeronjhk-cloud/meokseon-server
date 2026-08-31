/**
 * 관리자 API 라우터
 * /api/admin
 */

const express = require('express');
const db = require('../config/database');
const logger = require('../config/logger');
const { dictionaryCache } = require('../services/dictionaryCache');
const {
  mergeAndApply, mergeContributions, hasContributionReviewTable,
} = require('../services/mergeService');
// ★★★★★ 세션66 C5·C6 — 승인된 제보를 공식 데이터셋으로 옮기는 «유일한» 곳.
//   ⛔ 이 라우터가 공식 테이블에 직접 SQL 을 쓰지 않는다. 규칙은 그 파일 한 곳에 있다.
const {
  applyApprovedContribution, undoAppliedContribution,
} = require('../services/contributionApply');
const { collapseAction, matchAction, entityAction, profileAction, isBulkAllowed } = require('../services/reviewActions');
const { verifyEligibility } = require('../../scripts/staging/off/collapse_classify');

const router = express.Router();

// ============================================================
// Admin 인증 미들웨어 — Authorization: Bearer <ADMIN_TOKEN>
// ADMIN_TOKEN 환경변수 미설정 시 모든 요청 차단 (의도적 fail-safe).
// ============================================================
function requireAdmin(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    logger.warn('ADMIN_TOKEN 미설정 — admin 요청 차단', { ip: req.ip, path: req.path });
    return res.status(503).json({
      success: false,
      error: { code: 'ADMIN_NOT_CONFIGURED', message: 'ADMIN_TOKEN 환경변수가 설정되어 있지 않습니다.' },
    });
  }
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== adminToken) {
    logger.warn('admin 인증 실패', { ip: req.ip, path: req.path });
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: '관리자 인증이 필요합니다.' },
    });
  }
  next();
}

// 모든 admin 라우트에 인증 적용
router.use(requireAdmin);

// ============================================================
// GET /api/admin/pending — 미검증 데이터 목록
// ============================================================

router.get('/pending', async (req, res) => {
  const { type = 'all', limit = 50 } = req.query;

  let whereClause = "p.verification IN ('unverified', 'partial')";
  if (type === 'disputed') whereClause = "p.verification = 'disputed'";
  if (type === 'allergen') {
    whereClause = `p.verification IN ('unverified', 'partial')
      AND EXISTS (SELECT 1 FROM contributions c
        WHERE c.product_id = p.product_id
        AND c.data::text LIKE '%allergens%'
        AND c.data::text != '%"allergens":[]%')`;
  }

  const result = await db.query(
    `SELECT p.product_id, p.barcode, p.product_name, p.manufacturer,
            p.food_category, p.verification, p.verify_count, p.data_source,
            p.created_at, p.updated_at,
            n.calories, n.sodium, n.total_sugars, n.data_source AS nut_source,
            (SELECT count(*) FROM contributions c WHERE c.product_id = p.product_id) AS contribution_count
     FROM products p
     LEFT JOIN nutrition_data n ON p.product_id = n.product_id
     WHERE ${whereClause}
     ORDER BY
       CASE p.verification WHEN 'disputed' THEN 0 ELSE 1 END,
       p.created_at DESC
     LIMIT $1`,
    [parseInt(limit)]
  );

  res.json({ success: true, data: { count: result.rows.length, items: result.rows } });
});

// ============================================================
// GET /api/admin/products/:productId — 제품 상세 정보 (Admin UI 상세 페이지용)
// products + nutrition_data + product_ingredients + product_allergens 통합 조회
// ============================================================

router.get('/products/:productId', async (req, res) => {
  try {
    const productId = req.params.productId;

    // ── products + nutrition_data ──
    // production DB 의 실제 컬럼 (2026-05-12 information_schema 확인):
    //   nutrition_data: calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium,
    //                   total_carbs, total_sugars, added_sugars, dietary_fiber, protein,
    //                   calcium, iron, vitamin_d, potassium, data_source, verified_at, created_at, serving_size
    //   (per_serving, ocr_confidence, updated_at 없음)
    const productResult = await db.query(
      `SELECT p.product_id, p.barcode, p.product_name, p.brand, p.manufacturer,
              p.food_type, p.food_category, p.serving_size, p.serving_unit,
              p.total_content, p.content_unit, p.servings_per_container,
              p.data_source AS product_data_source,
              p.verification, p.verify_count, p.is_active,
              p.created_at, p.updated_at,
              p.c005_report_no, p.public_food_cd,
              p.merged_at, p.merge_sources_count,
              n.calories, n.total_fat, n.saturated_fat, n.trans_fat,
              n.cholesterol, n.sodium, n.total_carbs, n.total_sugars,
              n.added_sugars, n.dietary_fiber, n.protein,
              n.calcium, n.iron, n.vitamin_d, n.potassium,
              n.data_source AS nutrition_data_source,
              n.verified_at AS nutrition_verified_at
       FROM products p
       LEFT JOIN nutrition_data n ON p.product_id = n.product_id
       WHERE p.product_id = $1`,
      [productId]
    );
    if (productResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: '제품을 찾을 수 없습니다.' },
      });
    }
    const product = productResult.rows[0];

    // ── product_ingredients ──
    // production 컬럼: id, product_id, raw_text, parsed_ingredients(jsonb),
    //                  prdlst_report_no, source, created_at, updated_at
    // (스키마 파일은 data_source 인데 production 은 source. 응답 키는 호환을 위해 data_source 로 매핑)
    const ingredientsResult = await db.query(
      `SELECT raw_text, parsed_ingredients,
              source AS data_source, prdlst_report_no, created_at
       FROM product_ingredients
       WHERE product_id = $1
       ORDER BY created_at DESC LIMIT 5`,
      [productId]
    );

    // ── product_additives + additives 사전 ──
    // production product_additives 컬럼: product_id, additive_id, amount, unit
    //   (detected_name·confidence 없음 — 마이그레이션 파일과 다름)
    // production additives 컬럼: MFRAS v1.0 스키마 (risk_grade integer / risk_color varchar)
    //   (v2.0 의 mfras_grade·mfras_total·dim1~5 컬럼은 production 에 없음)
    const additivesResult = await db.query(
      `SELECT a.name_ko, a.name_en, a.e_number, a.cas_number, a.category,
              a.risk_grade, a.risk_color, a.max_daily_intake, a.description,
              pa.amount, pa.unit
       FROM product_additives pa
       LEFT JOIN additives a ON a.additive_id = pa.additive_id
       WHERE pa.product_id = $1`,
      [productId]
    );

    // ── product_allergens (Phase 1 005 마이그레이션) ──
    const allergenResult = await db.query(
      `SELECT allergen_name, source_count, status, detected_via
       FROM product_allergens
       WHERE product_id = $1
       ORDER BY source_count DESC`,
      [productId]
    );

    res.json({
      success: true,
      data: {
        product,
        ingredients: ingredientsResult.rows,
        additives: additivesResult.rows,
        allergens: allergenResult.rows,
      },
    });
  } catch (e) {
    logger.error('admin/products/:productId 실패', {
      error: e.message,
      productId: req.params.productId,
    });
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});

// ============================================================
// GET /api/admin/contributions/:productId — 제품별 기여 이력
// ============================================================

router.get('/contributions/:productId', async (req, res) => {
  const result = await db.query(
    `SELECT contribution_id, user_id, contribution_type, data, status, created_at
     FROM contributions
     WHERE product_id = $1
     ORDER BY created_at DESC`,
    [req.params.productId]
  );

  res.json({ success: true, data: result.rows });
});

// ============================================================
// POST /api/admin/verify/:productId — 관리자 검증 처리 (`DS-4`)
// ============================================================
//
// ★★★★★ 세션66 C6 — 이 핸들러가 이번 설계 변경의 «관리자 쪽 얼굴»이다.
//
// 종전에 무엇이 틀렸나 (넷 다 실제 결함이다)
//   ⛔ `reject` 가 `DELETE FROM nutrition_data ... data_source='ocr_crowdsource'` 였다.
//      제보가 한 번이라도 `nutrition_data.data_source` 를 덮은 뒤에는, 그 행이 원래
//      **식약처 값이었는지 제보였는지 구분이 안 된다.** 반려 한 번에 공공 데이터가 사라졌다(`U65-7`).
//      ⇒ 지웠다. 026 의 CHECK 제약 이후에는 이 DELETE 가 잡을 행이 애초에 0개다.
//      ⇒ 반려는 **상태 전이**다. 공식 테이블에 안 들어갔으므로 지울 것이 없다.
//   ⛔ `db.query` 3~4연발이라 **트랜잭션이 아니었다.** 두 번째 UPDATE 에서 죽으면
//      `products.verification` 만 바뀌고 `contributions.status` 는 안 바뀐 채로 남았다.
//      ⇒ `db.transaction` 으로 감쌌다.
//   ⛔ `action === 'correct'` 인데 `corrections` 가 없으면 **어떤 SQL 도 안 돌고
//      `success: true`** 가 나갔다. 관리자는 반영됐다고 믿는다.
//      ⇒ 400 `CORRECTIONS_REQUIRED`.
//   ⛔ 승인이 «무엇을 반영했는지»를 아무도 몰랐다.
//      ⇒ `contribution_review` 를 승인하고 `applyApprovedContribution` 을 부른다.
//
// ★★ 실패를 «삼키지 않는다».
//   `contributionApply` 는 `BASIS_UNKNOWN`·`CONVERT_BASIS_UNKNOWN` 등 `.code` 를 던진다.
//   그 코드를 그대로 관리자에게 돌려준다 — 사람이 **무엇을 채워야 하는지** 알아야
//   승인이 가능해진다(「무조건 통합」의 전제. 설계 §11-B-3).
//   ★ 반영에 실패해도 `status='approved'` 는 **남긴다.** `applied_at` 이 NULL 인 상태가
//     024 가 정의한 「승인됐지만 아직 안 옮겼다」= **보류**다. 거절이 아니다.
//     그래서 축별로 `SAVEPOINT` 를 쓴다 — 한 축의 실패가 다른 축의 반영을 롤백하지 않는다.
//
// ⚠ `products.verification` · `contributions.status` 전이는 **종전 그대로** 두었다.
//   「미검토 제보가 `products` 를 건드리는가」는 계약 §7-C 가 `U66-1` 로 «보류»했다.
// ============================================================

const VERIFY_ACTIONS = ['approve', 'reject', 'correct', 'undo', 'reopen'];

/** 축별 `SAVEPOINT` 이름. ★ 상수다 — 문자열 보간을 하지 않는다(`77 §C`). */
const APPLY_SAVEPOINT = 'sp_contrib_apply';

/**
 * `contributionApply` 호출을 SAVEPOINT 로 감싼다.
 * 실패해도 **다른 축의 반영과 `status='approved'` 는 살아남는다.**
 */
async function runAxisStep(client, label, fn) {
  await client.query(`SAVEPOINT ${APPLY_SAVEPOINT}`);
  try {
    const out = await fn();
    await client.query(`RELEASE SAVEPOINT ${APPLY_SAVEPOINT}`);
    return { ok: true, ...out };
  } catch (e) {
    await client.query(`ROLLBACK TO SAVEPOINT ${APPLY_SAVEPOINT}`);
    await client.query(`RELEASE SAVEPOINT ${APPLY_SAVEPOINT}`);
    // ★ `.code` 를 그대로 올린다. 삼키면 관리자가 무엇을 고쳐야 할지 알 수 없다.
    return { ok: false, step: label, code: e.code || 'APPLY_FAILED', message: e.message };
  }
}

router.post('/verify/:productId', async (req, res) => {
  const body = req.body || {};
  const { action, corrections } = body;
  const productId = req.params.productId;

  if (!VERIFY_ACTIONS.includes(action)) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_ACTION',
        message: `action은 ${VERIFY_ACTIONS.join('/')} 중 하나여야 합니다.`,
      },
    });
  }

  // ★★ 종전 결함 — `action==='correct'` 인데 `corrections` 가 없으면 아무 SQL 도 안 돌고
  //   `success:true` 가 나갔다. 「아무 일도 안 일어났다」를 「성공」으로 보고하지 않는다.
  const hasCorrections = corrections && typeof corrections === 'object'
    && !Array.isArray(corrections) && Object.keys(corrections).length > 0;
  if (action === 'correct' && !hasCorrections) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'CORRECTIONS_REQUIRED',
        message: "action='correct' 에는 corrections 가 필요합니다. "
          + '값이 없으면 아무것도 수정되지 않습니다(종전에는 조용히 success:true 였습니다).',
      },
    });
  }

  // ⚠ `cr_approve_human_chk` 가 `reviewed_by IS NOT NULL` 을 요구한다(024).
  //   admin 인증은 공용 Bearer 토큰이라 개인 식별자가 없다 — 본문 값이 있으면 그것을 쓰고,
  //   없으면 `'admin'` 을 쓴다. **자동 승인이 아니라는 사실**을 DB 가 강제하는 것이 그 제약의 뜻이다.
  const reviewedBy = (typeof body.reviewed_by === 'string' && body.reviewed_by.trim())
    || 'admin';
  const rejectReason = (typeof body.reject_reason === 'string' && body.reject_reason.trim()) || null;
  const askedReviewIds = Array.isArray(body.review_ids)
    ? body.review_ids.map(Number).filter((n) => Number.isFinite(n))
    : null;

  // ★ 024 배포순서 방어. **트랜잭션 «밖»**에서 판정한다(세션47 중대3 — 커넥션 중첩 획득 금지).
  const canReview = await hasContributionReviewTable();

  try {
    const out = await db.transaction(async (client) => {
      const result = {
        productId,
        action,
        reviewsAvailable: canReview,
        reviews: [],
        failures: [],
      };

      /** 대상 검토 행을 잠그고 가져온다. `review_ids` 가 오면 그것만. */
      const pickReviews = async (statuses) => {
        if (!canReview) return [];
        if (askedReviewIds && askedReviewIds.length > 0) {
          const r = await client.query(
            `SELECT review_id, axis, status, applied_at
               FROM contribution_review
              WHERE review_id = ANY($1::bigint[]) AND product_id = $2
              ORDER BY review_id
                FOR UPDATE`,
            [askedReviewIds, productId],
          );
          return r.rows;
        }
        const r = await client.query(
          `SELECT review_id, axis, status, applied_at
             FROM contribution_review
            WHERE product_id = $1 AND status = ANY($2::text[])
            ORDER BY review_id
              FOR UPDATE`,
          [productId, statuses],
        );
        return r.rows;
      };

      /** 승인 + 반영. `approve` 와 `correct` 가 **같은 본문**을 쓴다. */
      const approveAndApply = async () => {
        const rows = await pickReviews(['candidate']);
        if (rows.length === 0) return;

        // 이미 승인된 축이 있으면 그 축은 건드리지 않는다 —
        // `uq_cr_approved_per_product_axis` 가 (제품, 축)당 approved 1건만 허용한다.
        // 되돌리려면 `undo` → `reopen` 이 정식 경로다. 조용히 덮지 않는다.
        const approvedAxes = new Set(
          (await client.query(
            `SELECT axis FROM contribution_review
              WHERE product_id = $1 AND status = 'approved'`,
            [productId],
          )).rows.map((x) => x.axis),
        );

        // 한 축에 candidate 가 여럿이면 **가장 최근 것**을 승인하고 나머지는 superseded.
        const newestByAxis = new Map();
        for (const row of rows) {
          const prev = newestByAxis.get(row.axis);
          if (!prev || Number(row.review_id) > Number(prev.review_id)) newestByAxis.set(row.axis, row);
        }

        for (const row of rows) {
          const reviewId = Number(row.review_id);
          if (approvedAxes.has(row.axis)) {
            result.failures.push({
              review_id: reviewId, axis: row.axis,
              code: 'AXIS_ALREADY_APPROVED',
              message: `이 제품의 '${row.axis}' 축에는 이미 승인된 제보가 있습니다. `
                + 'undo → reopen 을 거쳐 주세요(승인은 축당 1건입니다).',
            });
            continue;
          }
          if (newestByAxis.get(row.axis).review_id !== row.review_id) {
            await client.query(
              `UPDATE contribution_review SET status = 'superseded' WHERE review_id = $1`,
              [reviewId],
            );
            result.reviews.push({ review_id: reviewId, axis: row.axis, status: 'superseded' });
            continue;
          }

          await client.query(
            `UPDATE contribution_review
                SET status = 'approved', reviewed_by = $2, reviewed_at = now()
              WHERE review_id = $1`,
            [reviewId, reviewedBy],
          );
          // ★ SAVEPOINT 는 승인 «뒤»에 잡는다 — 반영이 실패해도 승인은 남는다(= 보류).
          const step = await runAxisStep(client, 'apply', async () => {
            const applied = await applyApprovedContribution(client, reviewId, {
              appliedBy: reviewedBy,
            });
            return { counts: applied.counts, convert: applied.convert };
          });
          if (step.ok) {
            result.reviews.push({
              review_id: reviewId, axis: row.axis, status: 'approved', applied: true,
              counts: step.counts, convert: step.convert,
            });
          } else {
            result.reviews.push({
              review_id: reviewId, axis: row.axis, status: 'approved', applied: false,
              code: step.code,
            });
            result.failures.push({
              review_id: reviewId, axis: row.axis, code: step.code, message: step.message,
            });
          }
        }
      };

      if (action === 'approve' || action === 'correct') {
        if (action === 'correct' && corrections.nutrition) {
          // ⚠ 이 UPDATE 는 **공공 영양 행**(`nutrition_data`)을 고친다. 제보 영양은 이제
          //   `nutrition_data_crowd` 에 있고 그쪽 문은 `contributionApply` 뿐이다.
          //   ★ 행이 없으면 0행이 갱신된다 — 그 사실을 응답에 싣는다(조용한 무동작 금지).
          const n = corrections.nutrition;
          const upd = await client.query(
            `UPDATE nutrition_data SET
               calories = COALESCE($2, calories),
               sodium = COALESCE($3, sodium),
               total_sugars = COALESCE($4, total_sugars),
               total_fat = COALESCE($5, total_fat),
               saturated_fat = COALESCE($6, saturated_fat),
               protein = COALESCE($7, protein),
               verified_at = NOW()
             WHERE product_id = $1`,
            [productId, n.calories, n.sodium, n.total_sugars, n.total_fat, n.saturated_fat, n.protein],
          );
          result.nutritionCorrectedRows = (upd && upd.rowCount) || 0;
          if (result.nutritionCorrectedRows === 0) {
            result.failures.push({
              code: 'NO_PUBLIC_NUTRITION_ROW',
              message: '이 제품에는 수정할 공공 영양 행(nutrition_data)이 없습니다. '
                + '제보 영양은 승인(approve)으로 nutrition_data_crowd 에 반영됩니다.',
            });
          }
        }
        await client.query(
          `UPDATE products SET verification = 'admin_verified', updated_at = NOW()
            WHERE product_id = $1`,
          [productId],
        );
        await client.query(
          `UPDATE contributions SET status = 'approved' WHERE product_id = $1 AND status = 'pending'`,
          [productId],
        );
        // 공공 영양 행의 「최근 확인」 시각. 종전 동작 그대로다(대시보드의 stale 판정이 읽는다).
        await client.query(
          `UPDATE nutrition_data SET verified_at = NOW() WHERE product_id = $1`,
          [productId],
        );
        await approveAndApply();
        logger.info(action === 'correct' ? '관리자 수정 후 승인' : '관리자 승인',
          { productId, reviewedBy, reviews: result.reviews.length, failures: result.failures.length });

      } else if (action === 'reject') {
        // ⛔⛔ `DELETE FROM nutrition_data ... 'ocr_crowdsource'` 를 **되살리지 말 것.**
        //   그 한 줄이 `U65-7`(반려가 공공 데이터를 지운다) 그 자체였다.
        const rows = await pickReviews(['candidate', 'approved']);
        for (const row of rows) {
          const reviewId = Number(row.review_id);
          if (row.applied_at) {
            // 이미 반영된 것을 반려한다 = 먼저 되돌린다. 안 되돌리면 「반려됨」인데 데이터는 살아 있다.
            const step = await runAxisStep(client, 'undo', async () => {
              const u = await undoAppliedContribution(client, reviewId, { undoneBy: reviewedBy });
              return { undone: u.undone, deleted: u.deleted };
            });
            if (!step.ok) {
              result.failures.push({
                review_id: reviewId, axis: row.axis, code: step.code, message: step.message,
              });
              continue;   // 되돌리지 못한 것을 「반려됨」으로 표시하지 않는다
            }
          }
          await client.query(
            `UPDATE contribution_review
                SET status = 'rejected', reject_reason = $2,
                    reviewed_by = $3, reviewed_at = now()
              WHERE review_id = $1`,
            [reviewId, rejectReason, reviewedBy],
          );
          result.reviews.push({ review_id: reviewId, axis: row.axis, status: 'rejected' });
        }
        await client.query(
          `UPDATE products SET verification = 'unverified', updated_at = NOW()
            WHERE product_id = $1`,
          [productId],
        );
        await client.query(
          `UPDATE contributions SET status = 'rejected' WHERE product_id = $1 AND status = 'pending'`,
          [productId],
        );
        logger.info('관리자 거부', { productId, reviewedBy, reviews: result.reviews.length });

      } else if (action === 'undo') {
        const rows = await pickReviews(['approved']);
        for (const row of rows) {
          const reviewId = Number(row.review_id);
          const step = await runAxisStep(client, 'undo', async () => {
            const u = await undoAppliedContribution(client, reviewId, { undoneBy: reviewedBy });
            return { undone: u.undone, deleted: u.deleted, restored: u.restored };
          });
          if (!step.ok) {
            result.failures.push({
              review_id: reviewId, axis: row.axis, code: step.code, message: step.message,
            });
            continue;
          }
          await client.query(
            `UPDATE contribution_review
                SET status = 'undone', reviewed_by = $2, reviewed_at = now()
              WHERE review_id = $1`,
            [reviewId, reviewedBy],
          );
          result.reviews.push({
            review_id: reviewId, axis: row.axis, status: 'undone',
            undone: step.undone, deleted: step.deleted,
          });
        }
        logger.info('관리자 승인 취소', { productId, reviewedBy, reviews: result.reviews.length });

      } else if (action === 'reopen') {
        const rows = await pickReviews(['approved', 'rejected', 'undone']);
        for (const row of rows) {
          const reviewId = Number(row.review_id);
          if (row.applied_at) {
            // ★ 반영된 채로 큐에 되돌리면 「검토 대기」인데 데이터는 나가 있는 상태가 된다.
            result.failures.push({
              review_id: reviewId, axis: row.axis,
              code: 'UNDO_REQUIRED_BEFORE_REOPEN',
              message: '이미 반영된 제보입니다. undo 로 먼저 되돌린 뒤 reopen 해 주세요.',
            });
            continue;
          }
          await client.query(
            // ⚠ `reviewed_by`·`reviewed_at` 은 **지우지 않는다.** 「누가 마지막에 판정했나」는
            //   되돌려도 남아야 하는 기록이다. 큐 상태만 되돌린다.
            `UPDATE contribution_review
                SET status = 'candidate', reject_reason = NULL
              WHERE review_id = $1`,
            [reviewId],
          );
          result.reviews.push({ review_id: reviewId, axis: row.axis, status: 'candidate' });
        }
        logger.info('관리자 재큐잉', { productId, reviewedBy, reviews: result.reviews.length });
      }

      return result;
    });

    // ★★ 부분 실패를 «성공»으로 보고하지 않는다. 관리자가 무엇을 채워야 하는지 알아야 한다.
    if (out.failures.length > 0) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'REVIEW_APPLY_INCOMPLETE',
          message: '일부 축이 반영되지 않았습니다. 아래 코드가 무엇이 부족한지 말합니다. '
            + '승인 자체는 유지되며(보류), 부족한 값을 채운 뒤 다시 승인하면 반영됩니다.',
          details: out.failures,
        },
        data: out,
      });
    }
    return res.json({ success: true, data: out });
  } catch (e) {
    logger.error('admin/verify 실패', { productId, action, error: e.message, code: e.code });
    return res.status(500).json({
      success: false,
      error: { code: e.code || 'ADMIN_VERIFY_FAILED', message: e.message },
    });
  }
});

// ============================================================
// GET /api/admin/dashboard — 데이터 현황 대시보드
// ============================================================

router.get('/dashboard', async (req, res) => {
  const [products, nutrition, verification, contributions, stale] = await Promise.all([
    db.query('SELECT count(*) FROM products'),
    db.query('SELECT count(*) FROM nutrition_data'),
    db.query(`SELECT verification, count(*) FROM products GROUP BY verification ORDER BY count DESC`),
    db.query(`SELECT contribution_type, status, count(*) FROM contributions GROUP BY contribution_type, status`),
    db.query(`SELECT count(*) FROM nutrition_data WHERE verified_at < NOW() - INTERVAL '2 years'`),
  ]);

  const totalProducts = parseInt(products.rows[0].count);
  const totalNutrition = parseInt(nutrition.rows[0].count);

  res.json({
    success: true,
    data: {
      total_products: totalProducts,
      total_nutrition: totalNutrition,
      nutrition_coverage: totalProducts > 0 ? `${((totalNutrition / totalProducts) * 100).toFixed(1)}%` : '0%',
      verification_distribution: verification.rows,
      contribution_stats: contributions.rows,
      stale_data_count: parseInt(stale.rows[0].count),
    },
  });
});

// ============================================================
// POST /api/admin/cache/reload — 사전 캐시 리로드
// ============================================================

router.post('/cache/reload', async (req, res) => {
  const { loadFromDB, getCacheStatus } = require('../services/dictionaryCache');
  await loadFromDB();
  res.json({ success: true, data: getCacheStatus() });
});

// ============================================================
// GET /api/admin/preview-merge/:productId
// ── 같은 product 의 모든 contributions 를 가져와 merge 결과를 미리보기 (DB 변경 없음)
// ── 관리자가 "이대로 적용할지" 확인용 dry-run
// ============================================================
router.get('/preview-merge/:productId', async (req, res) => {
  try {
    const productId = req.params.productId;
    const result = await db.query(
      `SELECT contribution_id, data, device_id, created_at
       FROM contributions
       WHERE product_id = $1
         AND contribution_type IN ('ocr_nutrition', 'new_product', 'verify')
       ORDER BY created_at ASC`,
      [productId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { message: '병합할 contribution 이 없습니다.' },
      });
    }
    const merged = mergeContributions(result.rows);
    res.json({
      success: true,
      data: {
        productId: parseInt(productId),
        contributionCount: result.rows.length,
        merged,
      },
    });
  } catch (e) {
    logger.error('preview-merge 실패', { error: e.message, productId: req.params.productId });
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});

// ============================================================
// POST /api/admin/merge/:productId
// ── 관리자가 수동으로 merge 트리거 (3건 미만이어도 강제 적용 가능)
// ============================================================
router.post('/merge/:productId', async (req, res) => {
  try {
    const productId = req.params.productId;
    const result = await mergeAndApply(productId);
    if (!result.applied) {
      return res.status(400).json({
        success: false,
        error: { message: result.reason || 'merge 적용 불가' },
      });
    }
    logger.info('관리자 수동 merge 적용', {
      productId,
      verification: result.verification,
      sourceCount: result.sourceCount,
    });
    res.json({ success: true, data: result });
  } catch (e) {
    logger.error('admin merge 실패', { error: e.message, productId: req.params.productId });
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});

// ============================================================
// 검토 큐 (수입 브릿지) — #3 match review + #7 collapse 충돌 큐 통합
// ── 로직 단일 소스: src/services/reviewActions.js (Eval-First: run_import_bridge_eval.js §1.2d)
// ── 액션은 리듀서가 목표 상태를 판정 → 파라미터라이즈드 UPDATE. resolved view·신호등 무접촉.
// ============================================================

// 리듀서 set(고정 화이트리스트 컬럼)으로 안전한 UPDATE 생성. 컬럼명은 사용자 입력이 아님.
function buildUpdate(table, set, touchReviewedAt, idCol, idVal) {
  const cols = Object.keys(set);
  const assigns = cols.map((c, i) => `${c} = $${i + 1}`);
  const params = cols.map((c) => set[c]);
  if (touchReviewedAt) assigns.push('reviewed_at = NOW()');
  params.push(idVal);
  return {
    sql: `UPDATE ${table} SET ${assigns.join(', ')} WHERE ${idCol} = $${params.length} RETURNING *`,
    params,
  };
}

// 리듀서 error → HTTP status 매핑.
function reducerHttpStatus(error) {
  if (error === 'MISSING_ACTOR' || error === 'INVALID_ACTION') return 400;
  if (error === 'INVALID_TRANSITION') return 409;
  return 400;
}

// ── GET /api/admin/review/summary — 두 큐 현황(헤더 카운트) ──────────────────
router.get('/review/summary', async (req, res) => {
  try {
    const iccReg = (await db.query(`SELECT to_regclass('public.import_collapse_conflict') t`)).rows[0].t;
    const matchReg = (await db.query(`SELECT to_regclass('public.import_nutrition_product_match') t`)).rows[0].t;

    const collapseByStatus = iccReg
      ? (await db.query(`SELECT status, count(*)::int n FROM import_collapse_conflict GROUP BY status ORDER BY n DESC`)).rows
      : [];
    const collapsePendingDims = iccReg
      ? (await db.query(
          `SELECT COALESCE(array_to_string(conflict_dims, '+'), '(none)') dims, count(*)::int n
             FROM import_collapse_conflict WHERE status = 'pending' GROUP BY dims ORDER BY n DESC`
        )).rows
      : [];
    const matchByDecision = matchReg
      ? (await db.query(`SELECT decision, count(*)::int n FROM import_nutrition_product_match GROUP BY decision ORDER BY n DESC`)).rows
      : [];

    // route 분포(017 적용 시). suppressed(auto-suppress) 카운트 포함.
    const hasRoute = iccReg
      ? (await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name='import_collapse_conflict' AND column_name='route'`)).rowCount
      : 0;
    const collapseByRoute = hasRoute
      ? (await db.query(
          `SELECT COALESCE(route,'(unrouted)') route, count(*)::int n,
                  count(*) FILTER (WHERE suppressed)::int suppressed
             FROM import_collapse_conflict GROUP BY route ORDER BY n DESC`
        )).rows
      : [];

    // status(사람 워크플로) ↔ auto-suppress(시스템 분류) 구분 표기(§7.5 ⓒ).
    //   auto_suppressed = suppressed=true(시스템이 큐에서 숨김, reopen 가능) / human_dismissed = status='dismissed'(사람이 기각).
    //   unrouted = route IS NULL(아직 분류 전 — 기본 뷰 숨김. 재빌드 직후여야 정상, 평시 0).
    const collapseAutoSuppressed = hasRoute
      ? (await db.query(`SELECT count(*)::int n FROM import_collapse_conflict WHERE suppressed = true`)).rows[0].n
      : 0;
    const collapseUnrouted = hasRoute
      ? (await db.query(`SELECT count(*)::int n FROM import_collapse_conflict WHERE route IS NULL`)).rows[0].n
      : 0;
    const collapseHumanDismissed = (collapseByStatus.find((r) => r.status === 'dismissed') || {}).n || 0;
    // 헤더 탭 카운트(기본 뷰에 실제 노출되는 actionable 건수). GET /review/collapse 기본 필터와 동일 조건
    //   (status='pending' AND suppressed=false AND route IS NOT NULL) — reviewed/dismissed 처리 시 즉시 감소.
    const collapseActive = hasRoute
      ? (await db.query(`SELECT count(*)::int n FROM import_collapse_conflict WHERE status = 'pending' AND suppressed = false AND route IS NOT NULL`)).rows[0].n
      : ((collapseByStatus.find((r) => r.status === 'pending') || {}).n || 0);

    res.json({
      success: true,
      data: {
        collapse_queue_ready: !!iccReg,
        match_queue_ready: !!matchReg,
        collapse_by_status: collapseByStatus,
        collapse_pending_dims: collapsePendingDims,
        collapse_by_route: collapseByRoute,
        collapse_auto_suppressed: collapseAutoSuppressed,
        collapse_human_dismissed: collapseHumanDismissed,
        collapse_unrouted: collapseUnrouted,
        collapse_active: collapseActive,
        match_by_decision: matchByDecision,
      },
    });
  } catch (e) {
    logger.error('review/summary 실패', { error: e.message });
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});

// ── GET /api/admin/review/collapse — collapse 충돌 큐 목록 ────────────────────
router.get('/review/collapse', async (req, res) => {
  try {
    const status = ['pending', 'reviewed', 'dismissed'].includes(req.query.status) ? req.query.status : 'pending';
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const filterParams = [status];
    let where = 'c.status = $1';
    if (req.query.dims) { filterParams.push(req.query.dims); where += ` AND array_to_string(c.conflict_dims, '+') = $${filterParams.length}`; }
    if (req.query.product_id && /^\d+$/.test(String(req.query.product_id))) {
      filterParams.push(parseInt(req.query.product_id, 10));
      where += ` AND c.product_id = $${filterParams.length}`;
    }
    if (req.query.name && String(req.query.name).trim()) {
      filterParams.push('%' + String(req.query.name).trim() + '%');
      where += ` AND p.product_name ILIKE $${filterParams.length}`;
    }
    // route 필터 + 기본 suppress 숨김(auto-suppress 97.5% 는 기본 미노출). route 지정 or include_suppressed=true 면 노출.
    const ROUTES = ['needs_review', 'consistent_collapse_review', 'zero_missing_hold', 'conflict_unresolvable', 'basis_unknown_hold'];
    if (ROUTES.includes(req.query.route)) {
      filterParams.push(req.query.route);
      where += ` AND c.route = $${filterParams.length}`;
    } else if (req.query.include_suppressed !== 'true') {
      // 기본 뷰: auto-suppress 숨김 + 미분류(route IS NULL) 숨김.
      //   재빌드가 새 충돌 행을 suppressed=false(DEFAULT)·route=NULL 로 삽입해도 annotator 재실행 전까지 큐로 새지 않게 함(§7.5 ⓐ leak 차단).
      //   미분류 건수는 /review/summary(collapse_unrouted)·route='all' 로 확인 가능.
      where += ' AND c.suppressed = false AND c.route IS NOT NULL';
    }

    const total = (await db.query(`SELECT count(*)::int n FROM import_collapse_conflict c LEFT JOIN products p ON p.product_id = c.product_id WHERE ${where}`, filterParams)).rows[0].n;

    const listParams = [...filterParams, limit, offset];
    const items = (await db.query(
      `SELECT c.conflict_id, c.product_id, c.group_key, c.match_method, c.candidate_count,
              c.conflict_dims, c.kcal_min, c.kcal_max, c.kcal_spread_pct,
              c.sodium_min, c.sodium_max, c.sodium_ratio, c.samples, c.status,
              c.reviewed_by, c.reviewed_at, c.review_note, c.detected_at,
              c.route, c.suppressed, c.route_dims,
              p.product_name, p.barcode, p.manufacturer
         FROM import_collapse_conflict c
         LEFT JOIN products p ON p.product_id = c.product_id
        WHERE ${where}
        ORDER BY c.kcal_spread_pct DESC NULLS LAST, c.conflict_id
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    )).rows;

    res.json({ success: true, data: { total, count: items.length, limit, offset, items } });
  } catch (e) {
    logger.error('review/collapse 실패', { error: e.message });
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});

// ── GET /api/admin/review/matches — match review 큐 목록 ──────────────────────
router.get('/review/matches', async (req, res) => {
  try {
    const decision = ['review', 'accept', 'reject'].includes(req.query.decision) ? req.query.decision : 'review';
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const filterParams = [decision];
    let where = 'm.decision = $1';
    if (req.query.product_id && /^\d+$/.test(String(req.query.product_id))) {
      filterParams.push(parseInt(req.query.product_id, 10));
      where += ` AND m.product_id = $${filterParams.length}`;
    }
    if (req.query.name && String(req.query.name).trim()) {
      filterParams.push('%' + String(req.query.name).trim() + '%');
      where += ` AND p.product_name ILIKE $${filterParams.length}`;
    }

    const total = (await db.query(
      `SELECT count(*)::int n FROM import_nutrition_product_match m LEFT JOIN products p ON p.product_id = m.product_id WHERE ${where}`, filterParams
    )).rows[0].n;

    const listParams = [...filterParams, limit, offset];
    const items = (await db.query(
      `SELECT m.match_id, m.product_id, m.import_key, m.match_method, m.match_quality,
              m.decision, m.resolution_status, m.reason, m.candidate_count, m.evidence,
              m.reviewed_by, m.reviewed_at, m.matched_at,
              p.product_name, p.barcode, p.manufacturer,
              i.food_nm_kr AS import_name, i.nation, i.importer,
              i.calories AS import_kcal, i.sodium AS import_sodium,
              i.traffic_light_allowed
         FROM import_nutrition_product_match m
         LEFT JOIN products p ON p.product_id = m.product_id
         LEFT JOIN import_nutrition i ON i.food_cd = m.import_key
        WHERE ${where}
        ORDER BY m.product_id, m.match_id
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    )).rows;

    res.json({ success: true, data: { total, count: items.length, limit, offset, items } });
  } catch (e) {
    logger.error('review/matches 실패', { error: e.message });
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});

// ── POST /api/admin/review/collapse/:conflictId — collapse 큐 액션 ────────────
// body: { action: 'dismiss'|'reviewed'|'reopen', note?, actor? }
router.post('/review/collapse/:conflictId', async (req, res) => {
  try {
    const { action, note } = req.body || {};
    const actor = (req.body && String(req.body.actor || '').trim()) || 'admin';
    const cur = (await db.query(
      `SELECT conflict_id, status FROM import_collapse_conflict WHERE conflict_id = $1`,
      [req.params.conflictId]
    )).rows[0];
    if (!cur) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '충돌 큐 항목을 찾을 수 없습니다.' } });

    const decision = collapseAction(cur, action, actor, note);
    if (!decision.ok) {
      return res.status(reducerHttpStatus(decision.error)).json({ success: false, error: { code: decision.error } });
    }
    if (!decision.changed) {
      return res.json({ success: true, data: { conflict_id: cur.conflict_id, action, changed: false, status: decision.status } });
    }
    const { sql, params } = buildUpdate('import_collapse_conflict', decision.set, decision.touchReviewedAt, 'conflict_id', cur.conflict_id);
    const row = (await db.query(sql, params)).rows[0];
    logger.info('collapse 큐 액션', { conflict_id: cur.conflict_id, action, actor, status: row.status });
    res.json({ success: true, data: { conflict_id: row.conflict_id, action, changed: true, status: row.status, reviewed_by: row.reviewed_by } });
  } catch (e) {
    logger.error('review/collapse 액션 실패', { error: e.message, conflictId: req.params.conflictId });
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});

// ── POST /api/admin/review/matches/:matchId — match review 액션 ───────────────
// body: { action: 'human_verified'|'reject'|'reopen', actor? }
// human_verified → decision=accept(정책A). 제품당 accept ≤ 1(015 uq) 위반 시 409.
router.post('/review/matches/:matchId', async (req, res) => {
  try {
    const { action } = req.body || {};
    const actor = (req.body && String(req.body.actor || '').trim()) || 'admin';
    const cur = (await db.query(
      `SELECT m.match_id, m.product_id, m.decision, m.resolution_status, m.candidate_count, p.product_name
         FROM import_nutrition_product_match m
         LEFT JOIN products p ON p.product_id = m.product_id
        WHERE m.match_id = $1`,
      [req.params.matchId]
    )).rows[0];
    if (!cur) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '매칭 항목을 찾을 수 없습니다.' } });

    // 승격 가드(§4.7 ③ 단일후보 함정): 이름매칭만으로는 승격 불가 — 보강근거(바코드/수입원/원산지/내용량) ≥1 필수.
    if (action === 'human_verified') {
      const corroboration = Array.isArray(req.body && req.body.corroboration) ? req.body.corroboration : [];
      const elig = verifyEligibility({ name: cur.product_name, is_generic: true, candidate_count: cur.candidate_count, match: 'name', corroboration });
      if (!elig.eligible) {
        return res.status(409).json({
          success: false,
          error: { code: 'PROMOTE_BLOCKED', reason: elig.reason, message: '순수 이름매칭만으로는 승격 불가 — 바코드·수입원·원산지·내용량 중 최소 1개 보강근거를 확인·체크한 뒤 승격하세요.' },
        });
      }
    }

    const decision = matchAction(cur, action, actor);
    if (!decision.ok) {
      return res.status(reducerHttpStatus(decision.error)).json({ success: false, error: { code: decision.error } });
    }
    if (!decision.changed) {
      return res.json({ success: true, data: { match_id: cur.match_id, action, changed: false, decision: decision.decision, resolution_status: decision.resolution_status } });
    }
    const { sql, params } = buildUpdate('import_nutrition_product_match', decision.set, decision.touchReviewedAt, 'match_id', cur.match_id);
    let row;
    try {
      row = (await db.query(sql, params)).rows[0];
    } catch (dbErr) {
      // 23505: uq_imp_match_accept_per_product — 이미 이 제품에 accept 된 수입이 존재.
      if (dbErr.code === '23505') {
        return res.status(409).json({
          success: false,
          error: { code: 'ACCEPT_CONFLICT', message: '이 제품에는 이미 승격(accept)된 수입 영양이 있습니다. 먼저 기존 승격을 reopen 하세요.' },
        });
      }
      throw dbErr;
    }
    logger.info('match review 액션', { match_id: cur.match_id, product_id: cur.product_id, action, actor, decision: row.decision, resolution_status: row.resolution_status });
    res.json({ success: true, data: { match_id: row.match_id, action, changed: true, decision: row.decision, resolution_status: row.resolution_status, reviewed_by: row.reviewed_by } });
  } catch (e) {
    logger.error('review/matches 액션 실패', { error: e.message, matchId: req.params.matchId });
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});

// ============================================================
// 대량(bulk) 검토 액션 — #3 운영: 페이지 단위 다건 처리
// ── 안전 가드: isBulkAllowed(queue, action) 화이트리스트(단일 소스, reviewActions.js).
//    match=reject|reopen, collapse=dismiss|reopen. 승격(human_verified)·reviewed 는 bulk 금지.
// ── 각 id 독립 처리(부분 성공 리포트). 리듀서로 목표상태 판정 → 파라미터라이즈드 UPDATE.
//    resolved view·신호등 무접촉(단일건 액션과 동일 경로).
// ============================================================
const BULK_MAX = 500;

function parseBulkIds(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const ids = [];
  for (const x of raw) {
    const s = String(x);
    if (!/^\d+$/.test(s)) return null;
    ids.push(parseInt(s, 10));
  }
  return ids;
}

async function runBulk({ table, idCol, ids, action, actor, note, reducer, curSql }) {
  const out = { requested: ids.length, changed: 0, noop: 0, failed: [] };
  for (const id of ids) {
    try {
      const cur = (await db.query(curSql, [id])).rows[0];
      if (!cur) { out.failed.push({ id, error: 'NOT_FOUND' }); continue; }
      const decision = reducer(cur, action, actor, note);
      if (!decision.ok) { out.failed.push({ id, error: decision.error }); continue; }
      if (!decision.changed) { out.noop += 1; continue; }
      const { sql, params } = buildUpdate(table, decision.set, decision.touchReviewedAt, idCol, id);
      await db.query(sql, params);
      out.changed += 1;
    } catch (e) {
      out.failed.push({ id, error: e && e.code === '23505' ? 'ACCEPT_CONFLICT' : (e && e.message) || 'DB_ERROR' });
    }
  }
  return out;
}

// ── POST /api/admin/review/collapse/bulk — body: { ids:[], action:'dismiss'|'reopen', note?, actor? }
router.post('/review/collapse/bulk', async (req, res) => {
  try {
    const { action, note } = req.body || {};
    const actor = (req.body && String(req.body.actor || '').trim()) || 'admin';
    const ids = parseBulkIds(req.body && req.body.ids);
    if (!ids) return res.status(400).json({ success: false, error: { code: 'INVALID_IDS', message: 'ids 는 1개 이상의 정수 배열이어야 합니다.' } });
    if (ids.length > BULK_MAX) return res.status(400).json({ success: false, error: { code: 'TOO_MANY', message: `한 번에 최대 ${BULK_MAX}건까지 처리합니다.` } });
    if (!isBulkAllowed('collapse', action)) {
      return res.status(400).json({ success: false, error: { code: 'BULK_ACTION_FORBIDDEN', message: 'collapse 대량 처리는 dismiss·reopen 만 허용됩니다(reviewed 는 개별 판정).' } });
    }
    const out = await runBulk({
      table: 'import_collapse_conflict', idCol: 'conflict_id', ids, action, actor, note,
      reducer: collapseAction, curSql: 'SELECT conflict_id, status FROM import_collapse_conflict WHERE conflict_id = $1',
    });
    logger.info('collapse 큐 대량 액션', { action, actor, requested: out.requested, changed: out.changed, noop: out.noop, failed: out.failed.length });
    res.json({ success: true, data: out });
  } catch (e) {
    logger.error('review/collapse/bulk 실패', { error: e.message });
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});

// ── POST /api/admin/review/matches/bulk — body: { ids:[], action:'reject'|'reopen', actor? }
router.post('/review/matches/bulk', async (req, res) => {
  try {
    const { action } = req.body || {};
    const actor = (req.body && String(req.body.actor || '').trim()) || 'admin';
    const ids = parseBulkIds(req.body && req.body.ids);
    if (!ids) return res.status(400).json({ success: false, error: { code: 'INVALID_IDS', message: 'ids 는 1개 이상의 정수 배열이어야 합니다.' } });
    if (ids.length > BULK_MAX) return res.status(400).json({ success: false, error: { code: 'TOO_MANY', message: `한 번에 최대 ${BULK_MAX}건까지 처리합니다.` } });
    if (!isBulkAllowed('match', action)) {
      return res.status(400).json({ success: false, error: { code: 'BULK_ACTION_FORBIDDEN', message: 'match 대량 처리는 reject·reopen 만 허용됩니다(승격은 건별 보강근거 확인 필수).' } });
    }
    const out = await runBulk({
      table: 'import_nutrition_product_match', idCol: 'match_id', ids, action, actor,
      reducer: matchAction, curSql: 'SELECT match_id, product_id, decision, resolution_status FROM import_nutrition_product_match WHERE match_id = $1',
    });
    logger.info('match 큐 대량 액션', { action, actor, requested: out.requested, changed: out.changed, noop: out.noop, failed: out.failed.length });
    res.json({ success: true, data: out });
  } catch (e) {
    logger.error('review/matches/bulk 실패', { error: e.message });
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});

// ============================================================
// 국내 제품 중복 — 엔티티 검토 큐(018 product_entity_members). reviewActions.entityAction 단일소스.
//   비파괴: 멤버 status(candidate|approved|rejected|split|undone) 전이만. products·nutrition 무접촉.
//   정책(i): approve = 사람 1클릭(대량). own nutrition 은 approve 로 안 바뀜(영양 상속은 프로필 승인 별도).
//   큐 정렬: member_count DESC(n다순) — scan_history 공백이라 그룹 크기 우선(c005 충돌은 route/NAME_ONLY 로 분리 노출).
// ============================================================
const ENTITY_ROUTES = ['AUTO_APPROVE_ENTITY', 'BULK_REVIEW_READY', 'NAME_ONLY_WEAK', 'HOLD_SPLIT'];

// ── GET /review/entities/summary — 엔티티 큐 헤더 카운트(candidate 멤버 보유 그룹) ──
router.get('/review/entities/summary', async (req, res) => {
  try {
    const reg = (await db.query(`SELECT to_regclass('public.product_entity_members') t`)).rows[0].t;
    if (!reg) return res.json({ success: true, data: { entity_queue_ready: false, entity_by_route: [], entity_active: 0 } });
    const byRoute = (await db.query(
      `SELECT e.route, count(*)::int n
         FROM product_entities e
        WHERE EXISTS (SELECT 1 FROM product_entity_members m WHERE m.entity_id = e.entity_id AND m.status = 'candidate')
        GROUP BY e.route ORDER BY n DESC`)).rows;
    // 헤더 actionable = 강조건(AUTO/BULK) candidate 그룹(1클릭 승인 대상).
    const active = byRoute.filter((r) => r.route === 'AUTO_APPROVE_ENTITY' || r.route === 'BULK_REVIEW_READY').reduce((a, x) => a + x.n, 0);
    const candMembers = (await db.query(`SELECT count(*)::int n FROM product_entity_members WHERE status='candidate'`)).rows[0].n;
    res.json({ success: true, data: { entity_queue_ready: true, entity_by_route: byRoute, entity_active: active, candidate_members: candMembers } });
  } catch (e) {
    logger.error('review/entities/summary 실패', { error: e.message });
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});

// ── GET /review/entities — 엔티티 그룹 목록(멤버 포함). route·member_status·name 필터 ──
router.get('/review/entities', async (req, res) => {
  try {
    const route = ENTITY_ROUTES.includes(req.query.route) ? req.query.route : 'AUTO_APPROVE_ENTITY';
    const mstatus = ['candidate', 'approved', 'rejected', 'split', 'undone'].includes(req.query.member_status) ? req.query.member_status : 'candidate';
    const limit = Math.min(parseInt(req.query.limit) || 25, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const params = [route, mstatus];
    let where = 'e.route = $1 AND EXISTS (SELECT 1 FROM product_entity_members m WHERE m.entity_id = e.entity_id AND m.status = $2)';
    if (req.query.name && String(req.query.name).trim()) {
      params.push('%' + String(req.query.name).trim() + '%');
      where += ` AND e.canonical_name ILIKE $${params.length}`;
    }
    if (req.query.has_profile === 'true') {
      where += ` AND EXISTS (SELECT 1 FROM entity_nutrition_profiles pr WHERE pr.entity_id = e.entity_id AND pr.status = 'candidate')`;
    }
    const total = (await db.query(`SELECT count(*)::int n FROM product_entities e WHERE ${where}`, params)).rows[0].n;

    const listParams = [...params, limit, offset];
    const items = (await db.query(
      `SELECT e.entity_id, e.entity_key, e.canonical_name, e.canonical_product_id, e.member_count, e.route, e.relation_type,
              ( SELECT json_agg(json_build_object(
                        'member_id', m.member_id, 'product_id', m.product_id, 'status', m.status,
                        'product_name', p.product_name, 'barcode', p.barcode, 'c005', p.c005_report_no,
                        'has_nd', EXISTS (SELECT 1 FROM nutrition_data nd WHERE nd.product_id = m.product_id)
                      ) ORDER BY m.product_id)
                  FROM product_entity_members m LEFT JOIN products p ON p.product_id = m.product_id
                 WHERE m.entity_id = e.entity_id ) AS members,
              ( SELECT json_build_object('profile_id', pr.profile_id, 'status', pr.status, 'basis', pr.basis,
                        'calories', pr.calories, 'sodium', pr.sodium, 'total_sugars', pr.total_sugars,
                        'saturated_fat', pr.saturated_fat, 'conflict_status', pr.conflict_status,
                        'source_product_ids', pr.source_product_ids, 'method', pr.method)
                  FROM entity_nutrition_profiles pr WHERE pr.entity_id = e.entity_id
                 ORDER BY (pr.status='approved') DESC, pr.profile_id DESC LIMIT 1 ) AS profile
         FROM product_entities e
        WHERE ${where}
        ORDER BY e.member_count DESC, e.entity_id
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams)).rows;
    res.json({ success: true, data: { total, count: items.length, limit, offset, route, member_status: mstatus, items } });
  } catch (e) {
    logger.error('review/entities 실패', { error: e.message });
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});

// ── POST /review/entities/member/:memberId — 멤버 단건 액션 ──
// body: { action:'approve'|'reject'|'split'|'reopen', actor? }
router.post('/review/entities/member/:memberId', async (req, res) => {
  try {
    const { action } = req.body || {};
    const actor = (req.body && String(req.body.actor || '').trim()) || 'admin';
    const cur = (await db.query(`SELECT member_id, product_id, status FROM product_entity_members WHERE member_id = $1`, [req.params.memberId])).rows[0];
    if (!cur) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '엔티티 멤버를 찾을 수 없습니다.' } });

    const decision = entityAction(cur, action, actor);
    if (!decision.ok) return res.status(reducerHttpStatus(decision.error)).json({ success: false, error: { code: decision.error } });
    if (!decision.changed) return res.json({ success: true, data: { member_id: cur.member_id, action, changed: false, status: decision.status } });

    const { sql, params } = buildUpdate('product_entity_members', decision.set, decision.touchReviewedAt, 'member_id', cur.member_id);
    let row;
    try { row = (await db.query(sql, params)).rows[0]; }
    catch (dbErr) {
      // 23505: uq_pem_approved_per_product — 이 제품이 이미 다른 엔티티에 approved.
      if (dbErr.code === '23505') return res.status(409).json({ success: false, error: { code: 'APPROVE_CONFLICT', message: '이 제품은 이미 다른 엔티티에 승인돼 있습니다. 먼저 기존 승인을 reopen 하세요.' } });
      throw dbErr;
    }
    logger.info('엔티티 멤버 액션', { member_id: cur.member_id, product_id: cur.product_id, action, actor, status: row.status });
    res.json({ success: true, data: { member_id: row.member_id, action, changed: true, status: row.status, reviewed_by: row.reviewed_by } });
  } catch (e) {
    logger.error('review/entities/member 액션 실패', { error: e.message, memberId: req.params.memberId });
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});

// ── POST /review/entities/bulk — body: { ids:[member_id...], action:'approve'|'reject'|'reopen', actor? }
router.post('/review/entities/bulk', async (req, res) => {
  try {
    const { action } = req.body || {};
    const actor = (req.body && String(req.body.actor || '').trim()) || 'admin';
    const ids = parseBulkIds(req.body && req.body.ids);
    if (!ids) return res.status(400).json({ success: false, error: { code: 'INVALID_IDS', message: 'ids 는 1개 이상의 정수 배열이어야 합니다.' } });
    if (ids.length > BULK_MAX) return res.status(400).json({ success: false, error: { code: 'TOO_MANY', message: `한 번에 최대 ${BULK_MAX}건까지 처리합니다.` } });
    if (!isBulkAllowed('entity', action)) {
      return res.status(400).json({ success: false, error: { code: 'BULK_ACTION_FORBIDDEN', message: '엔티티 대량 처리는 approve·reject·reopen 만 허용됩니다(split 은 건별 판정).' } });
    }
    const out = await runBulk({
      table: 'product_entity_members', idCol: 'member_id', ids, action, actor,
      reducer: entityAction, curSql: 'SELECT member_id, product_id, status FROM product_entity_members WHERE member_id = $1',
    });
    logger.info('엔티티 큐 대량 액션', { action, actor, requested: out.requested, changed: out.changed, noop: out.noop, failed: out.failed.length });
    res.json({ success: true, data: out });
  } catch (e) {
    logger.error('review/entities/bulk 실패', { error: e.message });
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});


// ── POST /review/entities/profile/:profileId — 엔티티 영양 프로필 승인/반려/재큐잉 ──
// body: { action:'approve'|'reject'|'reopen', actor? }. approve → resolved view 상속(멤버도 approved 여야).
router.post('/review/entities/profile/:profileId', async (req, res) => {
  try {
    const { action } = req.body || {};
    const actor = (req.body && String(req.body.actor || '').trim()) || 'admin';
    const cur = (await db.query(`SELECT profile_id, entity_id, status FROM entity_nutrition_profiles WHERE profile_id = $1`, [req.params.profileId])).rows[0];
    if (!cur) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '영양 프로필을 찾을 수 없습니다.' } });

    const decision = profileAction(cur, action, actor);
    if (!decision.ok) return res.status(reducerHttpStatus(decision.error)).json({ success: false, error: { code: decision.error } });
    if (!decision.changed) return res.json({ success: true, data: { profile_id: cur.profile_id, action, changed: false, status: decision.status } });

    const { sql, params } = buildUpdate('entity_nutrition_profiles', decision.set, decision.touchReviewedAt, 'profile_id', cur.profile_id);
    let row;
    try { row = (await db.query(sql, params)).rows[0]; }
    catch (dbErr) {
      if (dbErr.code === '23505') return res.status(409).json({ success: false, error: { code: 'PROFILE_APPROVE_CONFLICT', message: '이 엔티티에는 이미 승인된 영양 프로필이 있습니다. 먼저 기존 승인을 reopen 하세요.' } });
      throw dbErr;
    }
    logger.info('엔티티 프로필 액션', { profile_id: cur.profile_id, entity_id: cur.entity_id, action, actor, status: row.status });
    res.json({ success: true, data: { profile_id: row.profile_id, action, changed: true, status: row.status } });
  } catch (e) {
    logger.error('review/entities/profile 액션 실패', { error: e.message, profileId: req.params.profileId });
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});


// ── POST /review/entities/profile/bulk — body: { ids:[profile_id...], action:'approve'|'reject'|'reopen', actor? }
//   상이(conflict_status='review') 프로필은 클라이언트가 제외(건별 검토). 엔티티당 approved 프로필 ≤1은 DB 방어.
router.post('/review/entities/profile/bulk', async (req, res) => {
  try {
    const { action } = req.body || {};
    const actor = (req.body && String(req.body.actor || '').trim()) || 'admin';
    const ids = parseBulkIds(req.body && req.body.ids);
    if (!ids) return res.status(400).json({ success: false, error: { code: 'INVALID_IDS', message: 'ids 는 1개 이상의 정수 배열이어야 합니다.' } });
    if (ids.length > BULK_MAX) return res.status(400).json({ success: false, error: { code: 'TOO_MANY', message: `한 번에 최대 ${BULK_MAX}건까지 처리합니다.` } });
    if (!isBulkAllowed('profile', action)) {
      return res.status(400).json({ success: false, error: { code: 'BULK_ACTION_FORBIDDEN', message: '프로필 대량 처리는 approve·reject·reopen 만 허용됩니다.' } });
    }
    const out = await runBulk({
      table: 'entity_nutrition_profiles', idCol: 'profile_id', ids, action, actor,
      reducer: profileAction, curSql: 'SELECT profile_id, status FROM entity_nutrition_profiles WHERE profile_id = $1',
    });
    logger.info('영양 프로필 대량 액션', { action, actor, requested: out.requested, changed: out.changed, noop: out.noop, failed: out.failed.length });
    res.json({ success: true, data: out });
  } catch (e) {
    logger.error('review/entities/profile/bulk 실패', { error: e.message });
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});

module.exports = router;
