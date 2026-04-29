/**
 * 관리자 API 라우터
 * /api/admin
 */

const express = require('express');
const db = require('../config/database');
const logger = require('../config/logger');
const { dictionaryCache } = require('../services/dictionaryCache');

const router = express.Router();

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

module.exports = router;
