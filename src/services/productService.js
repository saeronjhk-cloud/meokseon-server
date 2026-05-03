/**
 * 제품 서비스 계층
 * 라우터에서 분리된 비즈니스 로직을 담당합니다.
 * Gemini 피드백: 컨트롤러(라우터)의 역할 비대화 해소
 *
 * 응답 스펙: D:\meokseon-app\docs\API_SPEC_MFRAS.md
 *  - 영양 신호등(traffic_light)
 *  - MFRAS 첨가물 안전성(mfras)
 *  - 식품 카테고리 맥락(context)
 *  - 판정 출처(sources)
 *  - 데이터 검증 상태(data_freshness)
 */

const productModel = require('../models/productModel');
const { evaluateNutrition } = require('./nutritionTrafficLight');
const { NotFoundError } = require('../middleware/errorHandler');
const { getContext } = require('../utils/foodCategory');

// 4색 우선순위 — 가장 위험한 색이 dominant_color
const COLOR_RANK = { red: 4, orange: 3, yellow: 2, green: 1, gray: 0 };

/**
 * 첨가물 row 배열 → MFRAS 응답 객체
 * 스펙: docs/API_SPEC_MFRAS.md §2.1
 *
 * @param {Array} additivesRows - productModel.getAdditives() 결과
 * @returns {Object|null} mfras — 첨가물이 0개면 null 반환 (Flutter graceful fallback)
 */
function buildMfras(additivesRows) {
  if (!additivesRows || additivesRows.length === 0) return null;

  // dominant_color 산출
  let dominant = 'green';
  for (const row of additivesRows) {
    if ((COLOR_RANK[row.risk_color] || 0) > (COLOR_RANK[dominant] || 0)) {
      dominant = row.risk_color || 'green';
    }
  }

  // 색상별 라벨 (Flutter 측 mfrasLabel 헬퍼와 일치)
  const SCORE_LABEL = { green: '안전', yellow: '허용', orange: '주의', red: '위해' };

  return {
    dominant_color: dominant,
    score: null,             // TODO: 5차원 점수 산출 도입 시 채움 (현재 risk_grade만 보유)
    score_label: SCORE_LABEL[dominant] || null,
    cocktail_hi: null,       // TODO: HI 산출 도입 시 채움
    cocktail_penalty: null,
    auxiliary_penalty: null,
    override_applied: null,
    override_reason: null,
    profile_applied: 'adult',
    additive_count: additivesRows.length,
    additives: additivesRows.map((a) => ({
      id: a.additive_id,
      name: a.name_ko,
      name_en: a.name_en,
      ins_no: a.e_number,           // INS = E number 동일 체계
      cas_number: null,             // additives 테이블에 cas_number 컬럼 없으면 null
      function: a.category,          // additives.category = '향미증진제' 등 기능 분류
      color: a.risk_color || 'gray',
      score: a.risk_grade,           // 1.0~10.0 (DB의 risk_grade 직접 노출)
      order_in_product: null,
      order_weight: null,
      summary: a.description,
      detail_url: null,
    })),
  };
}

/**
 * 신호등 판정 결과 + 영양 데이터 → sources[] (출처 배열)
 * 스펙: docs/API_SPEC_MFRAS.md §2.3
 *
 * \"왜 이 색상인가\" 드롭다운에서 보여주는 출처 정보.
 * 현재는 빨강 표시된 영양소만 sources 에 노출 (가장 사용자가 궁금해할 항목).
 */
function buildSources(trafficLight) {
  if (!trafficLight || !trafficLight.nutrients) return [];

  const sources = [];
  const nutrientLabels = {
    sodium: '나트륨', sugars: '당류', sat_fat: '포화지방', total_fat: '지방',
    cholesterol: '콜레스테롤', protein: '단백질', fiber: '식이섬유', trans_fat: '트랜스지방',
  };

  for (const [key, nr] of Object.entries(trafficLight.nutrients)) {
    if (!nr || nr.color === 'gray' || nr.color === 'green') continue;
    sources.push({
      system: 'nutrition',
      nutrient: key,
      basis: nr.basis || 'pct_dv',
      value: nr.pct_dv ?? nr.per_100 ?? null,
      unit: nr.basis === 'per_100' ? (key === 'sodium' || key === 'cholesterol' ? 'mg' : 'g') : '%',
      threshold: null,
      applied_color: nr.color,
      reference: '식약처 1일 영양성분 기준치 (별표5)',
      reference_url: null,
    });
  }
  return sources;
}

/**
 * products / nutrition_data 행 → data_freshness 객체
 * 스펙: docs/API_SPEC_MFRAS.md §2.4
 */
function buildFreshness(product) {
  const verifiedAt = product.verified_at;
  let isStale = false;
  let isExpired = false;
  if (verifiedAt) {
    const ageDays = (Date.now() - new Date(verifiedAt).getTime()) / (1000 * 60 * 60 * 24);
    isStale = ageDays > 730;   // 2년 경과
    isExpired = ageDays > 1095; // 3년 경과
  }

  return {
    verification_status: product.verification || 'unverified',
    verified_at: verifiedAt || null,
    verified_count: product.verify_count || 0,
    data_source: product.data_source || product.nutrition_source || null,
    is_stale: isStale,
    is_expired: isExpired,
    disputed_count: 0,
    sources_used: [product.data_source, product.nutrition_source].filter(Boolean),
  };
}

/**
 * 바코드로 제품 조회 + 영양 신호등 + MFRAS + 맥락 + 출처 + 검증 상태
 * @param {string} barcode
 * @returns {Promise<Object>}
 */
async function getProductWithTrafficLight(barcode) {
  const product = await productModel.findByBarcode(barcode);

  if (!product) {
    throw new NotFoundError('제품');
  }

  // 영양정보가 있으면 신호등 판정
  let trafficLight = null;
  if (product.sodium !== null || product.calories !== null) {
    trafficLight = evaluateNutrition(
      {
        product_name: product.product_name,
        food_type: product.food_type,
        content_unit: product.content_unit,
        serving_size: product.serving_size,
        total_content: product.total_content,
      },
      {
        calories: product.calories,
        sodium: product.sodium,
        sugars: product.total_sugars,
        sat_fat: product.saturated_fat,
        total_fat: product.total_fat,
        cholesterol: product.cholesterol,
        protein: product.protein,
        fiber: product.dietary_fiber,
        trans_fat: product.trans_fat,
      }
    );
  }

  // 첨가물 조회 → MFRAS (병렬 처리하지 않고 순차 — DB pool 압박 회피)
  const additivesRows = await productModel.getAdditives(product.product_id);
  const mfras = buildMfras(additivesRows);

  // 카테고리 맥락
  const context = getContext(product.food_type);

  return {
    product: {
      product_id: product.product_id,
      barcode: product.barcode,
      product_name: product.product_name,
      brand: product.brand,
      manufacturer: product.manufacturer,
      food_type: product.food_type,
      food_category: product.food_category,
      serving_size: product.serving_size,
      total_content: product.total_content,
      content_unit: product.content_unit,
      image_url: product.image_url,
      data_source: product.data_source,
    },
    nutrition: product.calories !== null ? {
      calories: product.calories,
      total_fat: product.total_fat,
      saturated_fat: product.saturated_fat,
      trans_fat: product.trans_fat,
      cholesterol: product.cholesterol,
      sodium: product.sodium,
      total_carbs: product.total_carbs,
      total_sugars: product.total_sugars,
      dietary_fiber: product.dietary_fiber,
      protein: product.protein,
      source: product.nutrition_source,
      verified_at: product.verified_at,
    } : null,
    traffic_light: trafficLight,
    mfras,
    context,
    sources: buildSources(trafficLight),
    data_freshness: buildFreshness(product),
  };
}

/**
 * 제품 첨가물 목록 + 위해성 요약 (별도 엔드포인트 /:barcode/additives 용)
 * @param {string} barcode
 * @returns {Promise<Object>}
 */
async function getProductAdditives(barcode) {
  const product = await productModel.findByBarcode(barcode);

  if (!product) {
    throw new NotFoundError('제품');
  }

  const additives = await productModel.getAdditives(product.product_id);

  return {
    product_id: product.product_id,
    product_name: product.product_name,
    additives,
    risk_summary: {
      total: additives.length,
      by_color: {
        green: additives.filter(a => a.risk_color === 'green').length,
        yellow: additives.filter(a => a.risk_color === 'yellow').length,
        orange: additives.filter(a => a.risk_color === 'orange').length,
        red: additives.filter(a => a.risk_color === 'red').length,
      },
    },
  };
}

module.exports = {
  getProductWithTrafficLight,
  getProductAdditives,
  // 테스트·재사용용 export
  buildMfras,
  buildSources,
  buildFreshness,
};
