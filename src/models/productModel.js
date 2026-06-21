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

  // 3. 통합 검색 (v3 — 다중 필드 가중치 + 중복 제거):
  //    - WHERE: search_text 트리그램(%) + ILIKE 부분 매칭 OR 결합
  //    - DEDUP: 같은 (product_name, manufacturer) 의 여러 바코드 → 1건만 노출
  //             (예: "농심감자면" x 8개 바코드 → 1개로 압축)
  //             그룹 내 verification 높은 것 → verify_count 많은 것 → 첫 바코드 선택
  //    - SCORE: 어느 필드에 매칭됐는지 + similarity 합산
  //        product_name  매칭 → +1.0
  //        manufacturer  매칭 → +1.0 (대표 제조사 검색 시 균형)
  //        brand         매칭 → +0.5
  //        food_type     매칭 → +0.3
  //        similarity   * 0.5 (search_text 정규화 텍스트 기반)
  //    - 두 단계 쿼리: 안쪽에서 DISTINCT ON, 바깥쪽에서 score 정렬
  //
  //    NOTE (2026-06-21): "농심" 같이 generic 한 키워드로 검색 시,
  //    product_name 에 키워드가 포함된 제품(농심떡국면 등)이 자연스럽게 상위에 옴.
  //    신라면 등 manufacturer-only 매칭 제품은 결과에는 포함되지만 페이지 아래쪽.
  //    이는 의도된 동작 — 사용자가 "신라면" 같이 구체적으로 검색하면 직접 매칭됨.
  const result = await db.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (lower(p.product_name), lower(COALESCE(p.manufacturer, '')))
         p.product_id, p.barcode, p.product_name, p.brand, p.manufacturer,
         p.food_type, p.food_category, p.serving_size, p.content_unit,
         p.image_url, p.verification, p.verify_count,
         (
           CASE WHEN COALESCE(p.product_name,  '') ILIKE '%' || $1 || '%' THEN 1.0 ELSE 0 END
         + CASE WHEN COALESCE(p.manufacturer,  '') ILIKE '%' || $1 || '%' THEN 1.0 ELSE 0 END
         + CASE WHEN COALESCE(p.brand,         '') ILIKE '%' || $1 || '%' THEN 0.5 ELSE 0 END
         + CASE WHEN COALESCE(p.food_type,     '') ILIKE '%' || $1 || '%' THEN 0.3 ELSE 0 END
         + similarity(p.search_text, $1) * 0.5
         ) AS score
       FROM products p
       WHERE p.is_active = TRUE
         AND (
           p.search_text % $1
           OR p.search_text ILIKE '%' || $1 || '%'
         )
       ORDER BY
         lower(p.product_name),
         lower(COALESCE(p.manufacturer, '')),
         CASE p.verification
           WHEN 'admin_verified' THEN 4
           WHEN 'verified'       THEN 3
           WHEN 'partial'        THEN 2
           ELSE 1
         END DESC,
         COALESCE(p.verify_count, 0) DESC,
         p.product_id
     ) sub
     ORDER BY score DESC, product_name
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
