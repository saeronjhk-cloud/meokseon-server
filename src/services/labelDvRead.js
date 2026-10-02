/**
 * ★ 세션73 U71-3 — 상품 조회 응답의 `nutrition.label_dv`(라벨 인쇄 % ↔ 우리 계산 % 병기)를 읽는다.
 *   대상: 영양이 «제보(nutrition_data_crowd)만»으로 나가는 제품. 공공 행(nutrition_data)이 있으면 그 값이
 *   우선하므로(뷰 product_nutrition_resolved) 라벨 %와 짝이 맞지 않는다 → null.
 *   ⛔ throw 하지 않는다 — 실패하면 null(상품 조회 전체를 깨뜨리지 않는다).
 */
const logger = require('../config/logger');
const { buildLabelDv } = require('./labelDvCheck');

async function getLabelDv(db, productId) {
  try {
    const r = await db.query(
      `SELECT ndc.basis_original, ndc.convert_factor,
              ndc.sodium, ndc.total_carbs, ndc.total_sugars, ndc.total_fat, ndc.saturated_fat,
              ndc.cholesterol, ndc.protein,
              c.data -> 'parsed_nutrition' -> '_dv_check' AS dv
         FROM nutrition_data_crowd ndc
         LEFT JOIN contributions c ON c.contribution_id = ndc.contribution_id
        WHERE ndc.product_id = $1
          AND NOT EXISTS (SELECT 1 FROM nutrition_data nd WHERE nd.product_id = ndc.product_id)
        LIMIT 1`,
      [productId]);
    const row = r.rows && r.rows[0];
    if (!row) return null;
    const dv = typeof row.dv === 'string' ? JSON.parse(row.dv) : row.dv;
    return buildLabelDv(dv, row);
  } catch (e) {
    logger.warn('라벨 % 병기 조회 실패 — 생략', { productId, error: e.message });
    return null;
  }
}

module.exports = { getLabelDv };
