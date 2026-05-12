/**
 * 관리자 API 라우터
 * /api/admin
 */

const express = require('express');
const db = require('../config/database');
const logger = require('../config/logger');
const { dictionaryCache } = require('../services/dictionaryCache');
const { mergeAndApply, mergeContributions } = require('../services/mergeService');

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
    // production DB 스키마와 마이그레이션 파일이 불일치 — 영양 핵심 11개만 안전하게 SELECT.
    // nutrition_data.data_source 가 production 에 없을 수 있어 제외.
    const productResult = await db.query(
      `SELECT p.*, n.calories, n.total_fat, n.saturated_fat, n.trans_fat,
              n.cholesterol, n.sodium, n.total_carbs, n.total_sugars,
              n.dietary_fiber, n.protein
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

    // 원재료 — data_source 컬럼 없을 수도 있어 안전하게 raw_text·parsed_ingredients 만
    const ingredientsResult = await db.query(
      `SELECT raw_text, parsed_ingredients, created_at
       FROM product_ingredients
       WHERE product_id = $1
       ORDER BY created_at DESC LIMIT 5`,
      [productId]
    );

    // 첨가물
    const additivesResult = await db.query(
      `SELECT pa.detected_name, pa.confidence, a.name_ko, a.category, a.mfras_grade, a.mfras_total
       FROM product_additives pa
       LEFT JOIN additives a ON a.additive_id = pa.additive_id
       WHERE pa.product_id = $1`,
      [productId]
    );

    // 알레르기 (Phase 1 에서 추가된 product_allergens 테이블)
    let allergens = [];
    try {
      const allergenResult = await db.query(
        `SELECT allergen_name, source_count, status, detected_via
         FROM product_allergens
         WHERE product_id = $1
         ORDER BY source_count DESC`,
        [productId]
      );
      allergens = allergenResult.rows;
    } catch (e) {
      // 테이블 미존재 시 빈 배열 (마이그레이션 005 적용 안 됐을 가능성)
      allergens = [];
    }

    res.json({
      success: true,
      data: {
        product,
        ingredients: ingredientsResult.rows,
        additives: additivesResult.rows,
        allergens,
      },
    });
  } catch (e) {
    logger.error('admin/products/:productId 실패', { error: e.message, productId: req.params.productId });
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
// POST /api/admin/verify/:productId — 관리자 검증 처리
// ============================================================

router.post('/verify/:productId', async (req, res) => {
  const { action, corrections } = req.body; // action: 'approve' | 'reject' | 'correct'
  const productId = req.params.productId;

  if (!['approve', 'reject', 'correct'].includes(action)) {
    return res.status(400).json({ success: false, error: { message: 'action은 approve/reject/correct 중 하나여야 합니다.' } });
  }

  if (action === 'approve') {
    await db.query(
      `UPDATE products SET verification = 'admin_verified', updated_at = NOW() WHERE product_id = $1`,
      [productId]
    );
    await db.query(
      `UPDATE contributions SET status = 'approved' WHERE product_id = $1 AND status = 'pending'`,
      [productId]
    );
    await db.query(
      `UPDATE nutrition_data SET verified_at = NOW() WHERE product_id = $1`,
      [productId]
    );
    logger.info('관리자 승인', { productId });

  } else if (action === 'reject') {
    await db.query(
      `UPDATE products SET verification = 'unverified', updated_at = NOW() WHERE product_id = $1`,
      [productId]
    );
    await db.query(
      `DELETE FROM nutrition_data WHERE product_id = $1 AND data_source = 'ocr_crowdsource'`,
      [productId]
    );
    await db.query(
      `UPDATE contributions SET status = 'rejected' WHERE product_id = $1 AND status = 'pending'`,
      [productId]
    );
    logger.info('관리자 거부', { productId });

  } else if (action === 'correct' && corrections) {
    // 수정 후 승인
    if (corrections.nutrition) {
      const n = corrections.nutrition;
      await db.query(
        `UPDATE nutrition_data SET
           calories = COALESCE($2, calories),
           sodium = COALESCE($3, sodium),
           total_sugars = COALESCE($4, total_sugars),
           total_fat = COALESCE($5, total_fat),
           saturated_fat = COALESCE($6, saturated_fat),
           protein = COALESCE($7, protein),
           verified_at = NOW()
         WHERE product_id = $1`,
        [productId, n.calories, n.sodium, n.total_sugars, n.total_fat, n.saturated_fat, n.protein]
      );
    }
    await db.query(
      `UPDATE products SET verification = 'admin_verified', updated_at = NOW() WHERE product_id = $1`,
      [productId]
    );
    await db.query(
      `UPDATE contributions SET status = 'approved' WHERE product_id = $1 AND status = 'pending'`,
      [productId]
    );
    logger.info('관리자 수정 후 승인', { productId, corrections });
  }

  res.json({ success: true, data: { productId, action } });
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

module.exports = router;
