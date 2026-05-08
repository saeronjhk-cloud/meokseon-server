/**
 * 크라우드소싱 서비스
 * OCR 데이터를 검증하고 DB에 저장하는 파이프라인
 *
 * 게이트 5개:
 * 1. OCR 신뢰도 ≥ 0.7
 * 2. Sanity Check 통과
 * 3. Mass Balance 통과
 * 4. 열량 교차 검증 (경고만, 저장은 허용)
 * 5. 공공데이터 보호 (기존 영양정보 있으면 OCR 무시)
 */

const db = require('../config/database');
const logger = require('../config/logger');
const { sanityCheck } = require('./nutritionTrafficLight');

// 최소 OCR 신뢰도 (Gemini 피드백: 0.5→0.7 상향)
const MIN_CONFIDENCE = 0.7;

// 자동 승격 신뢰도 (partial)
const AUTO_PROMOTE_CONFIDENCE = 0.9;

/**
 * OCR 분석 결과를 DB에 저장합니다.
 *
 * @param {Object} params
 * @param {string} params.barcode - 바코드 (없으면 null)
 * @param {Object} [params.productInfo] - 사용자가 화면에서 입력한 메타정보
 *   { product_name, manufacturer, brand, food_type, serving_size, total_content,
 *     content_unit, servings_per_container, ingredients_text, allergens }
 * @param {Object} params.ocrResult - OCR 분석 결과
 * @param {Object} params.analysis - 파싱된 분석 결과 (영양정보, 원재료, 알레르기)
 * @param {number} params.avgConfidence - OCR 평균 신뢰도
 * @param {string} [params.userId] - 사용자 ID
 * @param {string} [params.deviceId] - 기기 식별자 (어뷰징 방지)
 * @returns {Object} { saved, productId, verification, warnings, rejectReason }
 */
async function saveOcrContribution(params) {
  const {
    barcode, productInfo = {}, ocrResult, analysis, avgConfidence, userId, deviceId,
  } = params;
  const warnings = [];

  // ── 게이트 1: OCR 신뢰도 ──
  if (avgConfidence < MIN_CONFIDENCE) {
    return {
      saved: false,
      rejectReason: `OCR 신뢰도(${(avgConfidence * 100).toFixed(0)}%)가 기준(${MIN_CONFIDENCE * 100}%) 미만입니다. 더 선명한 이미지로 다시 촬영해주세요.`,
    };
  }

  const nutrition = analysis.nutrition || {};
  const servingSize = nutrition.serving_size || 100;

  // ── 게이트 2: Sanity Check ──
  const nutritionForCheck = {
    calories: nutrition.calories ?? null,
    sodium: nutrition.sodium ?? null,
    sugars: nutrition.total_sugars ?? null,
    sat_fat: nutrition.saturated_fat ?? null,
    total_fat: nutrition.total_fat ?? null,
    cholesterol: nutrition.cholesterol ?? null,
    protein: nutrition.protein ?? null,
    fiber: nutrition.dietary_fiber ?? null,
    trans_fat: nutrition.trans_fat ?? null,
  };

  const sanityWarnings = sanityCheck(nutritionForCheck, servingSize);
  const criticalWarnings = sanityWarnings.filter(w =>
    w.type === 'per_serving_exceeded' || w.type === 'per_100g_exceeded' || w.type === 'negative_value'
  );

  if (criticalWarnings.length > 0) {
    return {
      saved: false,
      rejectReason: `영양정보 이상치가 감지되었습니다: ${criticalWarnings.map(w => `${w.nutrient}(${w.value})`).join(', ')}`,
      warnings: sanityWarnings,
    };
  }

  // ── 게이트 3: Mass Balance ──
  const massBalanceWarning = sanityWarnings.find(w => w.type === 'mass_balance_exceeded');
  if (massBalanceWarning) {
    return {
      saved: false,
      rejectReason: massBalanceWarning.message,
      warnings: sanityWarnings,
    };
  }

  // 열량 교차 검증은 경고만 (저장은 허용)
  const calorieWarning = sanityWarnings.find(w => w.type === 'calorie_deviation');
  if (calorieWarning) {
    warnings.push(calorieWarning);
  }

  // ── 게이트 5: 공공데이터 보호 ──
  let productId = null;
  let isNewProduct = false;

  if (barcode) {
    const existing = await db.query(
      `SELECT p.product_id, n.nutrition_id, n.data_source AS nut_source
       FROM products p
       LEFT JOIN nutrition_data n ON p.product_id = n.product_id
       WHERE p.barcode = $1`,
      [barcode]
    );

    if (existing.rows.length > 0) {
      productId = existing.rows[0].product_id;
      const nutSource = existing.rows[0].nut_source;

      // 이미 공공데이터 영양정보가 있으면 OCR 무시
      if (nutSource && nutSource.startsWith('public_')) {
        return {
          saved: false,
          productId,
          rejectReason: '이 제품은 이미 공공데이터 기반 영양정보가 등록되어 있습니다.',
        };
      }
    }
  }

  // ── 어뷰징 방지: 같은 기기에서 같은 제품 중복 제출 체크 ──
  if (deviceId && productId) {
    const duplicate = await db.query(
      `SELECT contribution_id FROM contributions
       WHERE product_id = $1 AND data::text LIKE $2
       AND created_at > NOW() - INTERVAL '24 hours'`,
      [productId, `%"device_id":"${deviceId}"%`]
    );
    if (duplicate.rows.length > 0) {
      return {
        saved: false,
        productId,
        rejectReason: '같은 기기에서 24시간 내에 이미 이 제품의 데이터를 제출하셨습니다.',
      };
    }
  }

  // ── DB 저장 (트랜잭션) ──
  return await db.transaction(async (client) => {
    // 사용자 입력 → DB 컬럼 정리
    const productName = (productInfo.product_name || '').trim()
      || analysis.ingredients?.[0]?.name
      || '(OCR 분석 제품)';
    const manufacturer = (productInfo.manufacturer || '').trim() || null;
    const brand = (productInfo.brand || '').trim() || null;
    const foodType = (productInfo.food_type || '').trim() || null;
    const servingSize = productInfo.serving_size ?? nutrition.serving_size ?? null;
    const servingUnit = productInfo.serving_unit || nutrition.serving_unit || 'g';
    const totalContent = productInfo.total_content ?? null;
    const contentUnit = productInfo.content_unit || servingUnit || 'g';
    const servingsPerContainer = (totalContent && servingSize)
      ? Number((totalContent / servingSize).toFixed(1))
      : (productInfo.servings_per_container ?? null);

    // 제품이 없으면 신규 생성 / 있으면 비어있는 메타만 채워주기 (UPSERT-like)
    if (!productId) {
      const insertResult = await client.query(
        `INSERT INTO products (
           barcode, product_name, manufacturer, brand, food_type,
           serving_size, serving_unit, total_content, content_unit, servings_per_container,
           data_source, verification, verify_count
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ocr_crowdsource', 'unverified', 0)
         RETURNING product_id`,
        [barcode || null, productName, manufacturer, brand, foodType,
         servingSize, servingUnit, totalContent, contentUnit, servingsPerContainer]
      );
      productId = insertResult.rows[0].product_id;
      isNewProduct = true;
    } else {
      // 기존 제품 — 메타 컬럼이 비어있을 때만 사용자 입력으로 채워줌 (덮어쓰기 방지)
      await client.query(
        `UPDATE products SET
           product_name = COALESCE(NULLIF(product_name, ''), $2, product_name),
           manufacturer = COALESCE(manufacturer, $3),
           brand        = COALESCE(brand, $4),
           food_type    = COALESCE(food_type, $5),
           serving_size = COALESCE(serving_size, $6),
           serving_unit = COALESCE(NULLIF(serving_unit, ''), $7, serving_unit),
           total_content = COALESCE(total_content, $8),
           content_unit  = COALESCE(NULLIF(content_unit, ''), $9, content_unit),
           servings_per_container = COALESCE(servings_per_container, $10),
           updated_at = NOW()
         WHERE product_id = $1`,
        [productId, productName, manufacturer, brand, foodType,
         servingSize, servingUnit, totalContent, contentUnit, servingsPerContainer]
      );
    }

    // 영양정보 저장 (기존에 없는 경우만 — ON CONFLICT DO NOTHING)
    const hasNutrition = nutrition.calories || nutrition.sodium || nutrition.total_sugars;
    if (hasNutrition) {
      await client.query(
        `INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat,
          cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein,
          per_serving, ocr_confidence, data_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, $12, 'ocr_crowdsource')
         ON CONFLICT (product_id) DO NOTHING`,
        [
          productId,
          nutrition.calories ?? null,
          nutrition.total_fat ?? null,
          nutrition.saturated_fat ?? null,
          nutrition.trans_fat ?? null,
          nutrition.cholesterol ?? null,
          nutrition.sodium ?? null,
          nutrition.total_carbs ?? null,
          nutrition.total_sugars ?? null,
          nutrition.dietary_fiber ?? null,
          nutrition.protein ?? null,
          Math.round(avgConfidence * 100),
        ]
      );
    }

    // ── 원재료 저장 (product_ingredients) ──
    const ingredientNames = (analysis.ingredients || [])
      .map((i) => (typeof i === 'string' ? i : i?.name))
      .filter((s) => s && s.trim().length > 0);
    if (ingredientNames.length > 0 || productInfo.ingredients_text) {
      await client.query(
        `INSERT INTO product_ingredients (product_id, raw_text, parsed_ingredients, data_source)
         VALUES ($1, $2, $3, 'ocr_crowdsource')`,
        [
          productId,
          productInfo.ingredients_text || ocrResult?.corrected_text || null,
          ingredientNames,
        ]
      );

      // ── 첨가물 자동 매칭 (additives 사전과 비교) ──
      // 원재료 이름이 additives 사전의 name_ko 와 정확히 일치하거나 포함되면 매칭
      if (ingredientNames.length > 0) {
        const matchResult = await client.query(
          `SELECT additive_id, name_ko
           FROM additives
           WHERE is_active = TRUE
             AND name_ko = ANY($1::text[])`,
          [ingredientNames]
        );

        for (const row of matchResult.rows) {
          await client.query(
            `INSERT INTO product_additives (product_id, additive_id, detected_name, confidence)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (product_id, additive_id) DO NOTHING`,
            [productId, row.additive_id, row.name_ko, Math.round(avgConfidence * 100)]
          );
        }
      }
    }

    // 검증 상태 결정
    let verification = 'unverified';
    if (avgConfidence >= AUTO_PROMOTE_CONFIDENCE && criticalWarnings.length === 0 && !massBalanceWarning) {
      verification = 'partial';
    }

    // verify_count 증가 + 크라우드소싱 검증
    await client.query(
      `UPDATE products SET
         verification = CASE
           WHEN verification = 'unverified' THEN $2::verification_status
           WHEN verification = 'partial' AND verify_count >= 1 THEN 'verified'::verification_status
           ELSE verification
         END,
         verify_count = verify_count + 1,
         updated_at = NOW()
       WHERE product_id = $1`,
      [productId, verification]
    );

    // contributions 이력 기록 — 사용자가 입력·수정한 메타정보까지 보존
    await client.query(
      `INSERT INTO contributions (user_id, product_id, contribution_type, data, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [
        userId ? parseInt(userId) : null,
        productId,
        'ocr_nutrition',
        JSON.stringify({
          ocr_raw_text: ocrResult?.corrected_text || '',
          avg_confidence: avgConfidence,
          corrections: ocrResult?.corrections || [],
          parsed_nutrition: nutrition,
          parsed_ingredients: analysis.ingredients || [],
          allergens: analysis.allergens || [],
          user_input: {
            product_name: productInfo?.product_name || null,
            manufacturer: productInfo?.manufacturer || null,
            brand: productInfo?.brand || null,
            food_type: productInfo?.food_type || null,
            serving_size: productInfo?.serving_size || null,
            total_content: productInfo?.total_content || null,
            content_unit: productInfo?.content_unit || null,
            ingredients_text: productInfo?.ingredients_text || null,
            allergens: productInfo?.allergens || null,
            package_type: productInfo?.package_type || null,
            bundle_count: productInfo?.bundle_count || null,
          },
          device_id: deviceId || null,
          sanity_warnings: sanityWarnings,
        }),
      ]
    );

    logger.info('OCR 크라우드소싱 저장 완료', {
      productId, barcode, verification, isNewProduct, avgConfidence,
    });

    return {
      saved: true,
      productId,
      product_id: productId, // Flutter 측 호환 (snake_case)
      isNewProduct,
      verification,
      message: isNewProduct
        ? '새 제품으로 등록되었습니다. 다른 사용자가 동일한 정보를 등록하면 검증됨으로 승격됩니다.'
        : '기존 제품에 정보가 추가되었습니다.',
      warnings: sanityWarnings.filter(w => w.type === 'calorie_deviation'),
      allergenWarning: analysis.allergens?.length > 0
        ? '⚠️ 알레르기 정보는 관리자 검증 전까지 미확정 상태입니다. 반드시 실제 제품 패키지를 확인하세요.'
        : null,
    };
  });
}

/**
 * 제품 오류 신고 (disputed 상태 전환)
 */
async function reportError(productId, userId, reason) {
  // 신고 기록
  await db.query(
    `INSERT INTO contributions (user_id, product_id, contribution_type, data, status)
     VALUES ($1, $2, 'error_report', $3, 'pending')`,
    [userId ? parseInt(userId) : null, productId, JSON.stringify({ reason })]
  );

  // 신고 건수 확인
  const reportCount = await db.query(
    `SELECT count(*) FROM contributions
     WHERE product_id = $1 AND contribution_type = 'error_report'
     AND created_at > NOW() - INTERVAL '30 days'`,
    [productId]
  );

  // 3건 이상 → disputed 상태 전환
  if (parseInt(reportCount.rows[0].count) >= 3) {
    await db.query(
      `UPDATE products SET verification = 'disputed', updated_at = NOW()
       WHERE product_id = $1 AND verification != 'admin_verified'`,
      [productId]
    );
    logger.warn('제품 disputed 상태 전환', { productId, reportCount: reportCount.rows[0].count });
  }

  return { reported: true, reportCount: parseInt(reportCount.rows[0].count) };
}

module.exports = {
  saveOcrContribution,
  reportError,
  MIN_CONFIDENCE,
  AUTO_PROMOTE_CONFIDENCE,
};
