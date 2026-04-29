/**
 * 제품 서비스 계층
 * 라우터에서 분리된 비즈니스 로직을 담당합니다.
 * Gemini 피드백: 컨트롤러(라우터)의 역할 비대화 해소
 */

const productModel = require('../models/productModel');
const { evaluateNutrition } = require('./nutritionTrafficLight');
const { NotFoundError } = require('../middleware/errorHandler');

/**
 * 바코드로 제품 조회 + 영양 신호등 판정
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
  };
}

/**
 * 제품 첨가물 목록 + 위해성 요약
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
};
