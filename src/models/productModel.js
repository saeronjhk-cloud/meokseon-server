/**
 * 제품(Product) 데이터 모델
 * PostgreSQL 쿼리 레이어
 */

const db = require('../config/database');
const { normalizeSearchQuery, isSearchable } = require('../utils/searchNormalize');

/**
 * 바코드로 제품 + 영양정보 조회
 * @param {string} barcode
 * @returns {Promise<Object|null>}
 */
async function findByBarcode(barcode) {
  const result = await db.query(
    `SELECT
       p.product_id, p.barcode, p.product_name, p.brand, p.manufacturer,
       p.food_type, p.food_category, p.serving_size, p.total_content,
       p.content_unit, p.data_source, p.image_url,
       p.verification, p.verify_count,
       n.calories, n.total_fat, n.saturated_fat, n.trans_fat,
       n.cholesterol, n.sodium, n.total_carbs, n.total_sugars,
       n.dietary_fiber, n.protein, n.data_source AS nutrition_source,
       n.verified_at
     FROM products p
     LEFT JOIN nutrition_data n ON p.product_id = n.product_id
     WHERE p.barcode = $1
     LIMIT 1`,
    [barcode]
  );
  return result.rows[0] || null;
}

/**
 * 제품 통합 검색 (search_text 정규화 컬럼 기반)
 *
 * Migration 009 의 products.search_text 컬럼을 사용하여
 *   - product_name + manufacturer + brand + food_type 4개 필드 통합 검색
 *   - 띄어쓰기·특수문자·대소문자 변형 흡수
 *   - similarity + verification + verify_count 가중 정렬
 *
 * SOURCE: OneDrive/MeokSeon/IP/search_normalization_v1.md (예정)
 * 트리거: 사용자 검색 미스매치 분석 (Notion §8, 2026-06-21)
 *
 * @param {string} query - 사용자 원본 검색어
 * @param {number} limit - 최대 결과 수
 * @param {number} offset - 오프셋
 * @returns {Promise<Array>}
 */
async function searchByName(query, limit = 20, offset = 0) {
  // 1. 검색어 정규화 (search_text 컬럼과 동일 규칙)
  const qn = normalizeSearchQuery(query);

  // 2. 검색 의미 없는 입력은 빈 결과 (성능 보호)
  if (!isSearchable(qn)) {
    return [];
  }

  // 3. 통합 검색:
  //    - WHERE: trigram(%) + ILIKE 부분 매칭 OR 결합
  //    - ORDER:
  //      a) similarity 점수 DESC
  //      b) verification 수준 DESC (admin_verified > verified > partial > unverified)
  //      c) verify_count DESC (교차 검증 횟수)
  //      d) product_name 사전순 (안정 정렬)
  const result = await db.query(
    `SELECT
       p.product_id, p.barcode, p.product_name, p.brand, p.manufacturer,
       p.food_type, p.food_category, p.serving_size, p.content_unit,
       p.image_url, p.verification, p.verify_count,
       similarity(p.search_text, $1) AS score
     FROM products p
     WHERE p.is_active = TRUE
       AND (
         p.search_text % $1
         OR p.search_text ILIKE '%' || $1 || '%'
       )
     ORDER BY
       similarity(p.search_text, $1) DESC,
       CASE p.verification
         WHEN 'admin_verified' THEN 4
         WHEN 'verified'       THEN 3
         WHEN 'partial'        THEN 2
         ELSE 1
       END DESC,
       COALESCE(p.verify_count, 0) DESC,
       p.product_name
     LIMIT $2 OFFSET $3`,
    [qn, limit, offset]
  );
  return result.rows;
}

/**
 * 제품 ID로 영양정보 조회
 * @param {number} productId
 * @returns {Promise<Object|null>}
 */
async function getNutrition(productId) {
  const result = await db.query(
    `SELECT * FROM nutrition_data WHERE product_id = $1 LIMIT 1`,
    [productId]
  );
  return result.rows[0] || null;
}

/**
 * 제품 ID로 첨가물 목록 + 위해성 조회
 * @param {number} productId
 * @returns {Promise<Array>}
 */
async function getAdditives(productId) {
  const result = await db.query(
    `SELECT
       a.additive_id, a.name_ko, a.name_en, a.e_number,
       a.risk_grade, a.risk_color, a.category,
       a.description, a.max_daily_intake,
       pa.amount, pa.unit
     FROM product_additives pa
     JOIN additives a ON pa.additive_id = a.additive_id
     WHERE pa.product_id = $1
     ORDER BY a.risk_grade DESC, a.name_ko`,
    [productId]
  );
  return result.rows;
}

/**
 * 제품 ID로 신호등 캐시 조회
 * @param {number} productId
 * @returns {Promise<Object|null>}
 */
async function getTrafficLight(productId) {
  const result = await db.query(
    `SELECT * FROM nutrition_traffic_light WHERE product_id = $1 LIMIT 1`,
    [productId]
  );
  return result.rows[0] || null;
}

/**
 * 신호등 판정 결과 저장/갱신
 * @param {number} productId
 * @param {Object} evaluation - 판정 결과 객체
 * @returns {Promise<Object>}
 */
async function upsertTrafficLight(productId, evaluation) {
  const result = await db.query(
    `INSERT INTO nutrition_traffic_light (
       product_id, food_category,
       sodium_color, sodium_pct_dv, sodium_basis,
       sugars_color, sugars_pct_dv, sugars_basis,
       sat_fat_color, sat_fat_pct_dv, sat_fat_basis,
       total_fat_color, total_fat_pct_dv, total_fat_basis,
       cholesterol_color, cholesterol_pct_dv,
       protein_color, protein_pct_dv,
       fiber_color, fiber_pct_dv,
       trans_fat_color,
       is_dried_exception,
       context_messages,
       multi_serving_count,
       evaluated_at
     ) VALUES (
       $1, $2,
       $3, $4, $5,
       $6, $7, $8,
       $9, $10, $11,
       $12, $13, $14,
       $15, $16,
       $17, $18,
       $19, $20,
       $21,
       $22,
       $23,
       $24,
       NOW()
     )
     ON CONFLICT (product_id) DO UPDATE SET
       food_category = EXCLUDED.food_category,
       sodium_color = EXCLUDED.sodium_color,
       sodium_pct_dv = EXCLUDED.sodium_pct_dv,
       sodium_basis = EXCLUDED.sodium_basis,
       sugars_color = EXCLUDED.sugars_color,
       sugars_pct_dv = EXCLUDED.sugars_pct_dv,
       sugars_basis = EXCLUDED.sugars_basis,
       sat_fat_color = EXCLUDED.sat_fat_color,
       sat_fat_pct_dv = EXCLUDED.sat_fat_pct_dv,
       sat_fat_basis = EXCLUDED.sat_fat_basis,
       total_fat_color = EXCLUDED.total_fat_color,
       total_fat_pct_dv = EXCLUDED.total_fat_pct_dv,
       total_fat_basis = EXCLUDED.total_fat_basis,
       cholesterol_color = EXCLUDED.cholesterol_color,
       cholesterol_pct_dv = EXCLUDED.cholesterol_pct_dv,
       protein_color = EXCLUDED.protein_color,
       protein_pct_dv = EXCLUDED.protein_pct_dv,
       fiber_color = EXCLUDED.fiber_color,
       fiber_pct_dv = EXCLUDED.fiber_pct_dv,
       trans_fat_color = EXCLUDED.trans_fat_color,
       is_dried_exception = EXCLUDED.is_dried_exception,
       context_messages = EXCLUDED.context_messages,
       multi_serving_count = EXCLUDED.multi_serving_count,
       evaluated_at = NOW()
     RETURNING *`,
    [
      productId,
      evaluation.food_category,
      evaluation.nutrients.sodium?.color,
      evaluation.nutrients.sodium?.pct_dv,
      evaluation.nutrients.sodium?.basis,
      evaluation.nutrients.sugars?.color,
      evaluation.nutrients.sugars?.pct_dv,
      evaluation.nutrients.sugars?.basis,
      evaluation.nutrients.sat_fat?.color,
      evaluation.nutrients.sat_fat?.pct_dv,
      evaluation.nutrients.sat_fat?.basis,
      evaluation.nutrients.total_fat?.color,
      evaluation.nutrients.total_fat?.pct_dv,
      evaluation.nutrients.total_fat?.basis,
      evaluation.nutrients.cholesterol?.color,
      evaluation.nutrients.cholesterol?.pct_dv,
      evaluation.nutrients.protein?.color,
      evaluation.nutrients.protein?.pct_dv,
      evaluation.nutrients.fiber?.color,
      evaluation.nutrients.fiber?.pct_dv,
      evaluation.nutrients.trans_fat?.color,
      evaluation.is_dried_exception || false,
      JSON.stringify(evaluation.context_messages || []),
      evaluation.multi_serving?.servings_per_container || null,
    ]
  );
  return result.rows[0];
}

/**
 * 최근 등록된 제품 목록
 * @param {number} limit
 * @returns {Promise<Array>}
 */
async function getRecent(limit = 20) {
  const result = await db.query(
    `SELECT product_id, barcode, product_name, manufacturer, food_type, food_category, image_url, created_at
     FROM products
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

module.exports = {
  findByBarcode,
  searchByName,
  getNutrition,
  getAdditives,
  getTrafficLight,
  upsertTrafficLight,
  getRecent,
};
