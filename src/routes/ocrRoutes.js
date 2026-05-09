/**
 * OCR API 라우터
 * /api/ocr
 * multer(multipart) + base64 JSON 양쪽 지원
 */

const express = require('express');
const multer = require('multer');
const { callVisionAPI, correctOcrText } = require('../services/ocrService');
const { analyzeText } = require('../services/ocrParser');
const { evaluateNutrition, sanityCheck } = require('../services/nutritionTrafficLight');
const { ValidationError } = require('../middleware/errorHandler');
const { saveOcrContribution, reportError } = require('../services/crowdsourceService');

const router = express.Router();

// multer 설정: 메모리 스토리지, 10MB 제한
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new ValidationError('이미지 파일만 업로드 가능합니다.'));
    }
  },
});

// OCR 텍스트 최대 길이 (ReDoS 방어)
const MAX_OCR_TEXT_LENGTH = 10000;

/**
 * 요청에서 base64 이미지 추출 (multer 파일 또는 JSON body)
 */
function extractBase64Image(req) {
  // multer로 업로드된 파일
  if (req.file) {
    return req.file.buffer.toString('base64');
  }
  // JSON body의 base64 문자열
  if (req.body.image && typeof req.body.image === 'string') {
    return req.body.image.replace(/^data:image\/\w+;base64,/, '');
  }
  throw new ValidationError('이미지가 필요합니다. multipart/form-data의 image 필드 또는 JSON body의 image(base64) 중 하나를 전송하세요.');
}

// ============================================================
// POST /api/ocr/analyze
// multipart: image(file) + product_info(JSON string)
// JSON: { image: "base64...", product_info: {...} }
// ============================================================

router.post('/analyze', upload.single('image'), async (req, res) => {
  const base64Image = extractBase64Image(req);

  if (base64Image.length < 100) {
    throw new ValidationError('유효하지 않은 이미지 데이터입니다.');
  }

  // product_info 파싱 (multer에서는 JSON string으로 전달될 수 있음)
  let productInfo = req.body.product_info;
  if (typeof productInfo === 'string') {
    try { productInfo = JSON.parse(productInfo); } catch { productInfo = null; }
  }

  console.log(`[OCR] 분석 시작 (이미지 크기: ${(base64Image.length * 0.75 / 1024).toFixed(0)}KB)`);

  // Step 1: Google Vision OCR
  const ocrResult = await callVisionAPI(base64Image);

  if (!ocrResult.full_text || ocrResult.full_text.trim().length === 0) {
    return res.json({
      success: true,
      data: {
        ocr: { ...ocrResult, full_text: '' },
        analysis: null,
        traffic_light: null,
        message: '이미지에서 텍스트를 추출하지 못했습니다. 더 선명한 이미지를 사용해주세요.',
      },
    });
  }

  // Step 2: 텍스트 교정 (길이 제한)
  const truncatedText = ocrResult.full_text.substring(0, MAX_OCR_TEXT_LENGTH);
  const { corrected, corrections } = correctOcrText(truncatedText);

  // Step 3: 분석
  const analysis = analyzeText(corrected);

  // ── 사용자 입력값 우선 병합 ──
  // 사용자가 OCR 결과 화면에서 영양성분·원재료·알레르기를 직접 수정한 경우,
  // OCR 결과 대신 사용자 값을 신뢰한다. (Trust the user, not the OCR.)
  if (productInfo?.nutrition) {
    analysis.nutrition = { ...analysis.nutrition, ...productInfo.nutrition };
  }
  if (productInfo?.ingredients_text) {
    // 사용자가 텍스트 영역에서 수정한 원재료 — corrected 텍스트로 갈아끼우면
    // analyzeText 가 다시 파싱해 ingredients 배열을 새로 생성
    const reanalyzed = analyzeText(productInfo.ingredients_text);
    if (reanalyzed.ingredients?.length) {
      analysis.ingredients = reanalyzed.ingredients;
      analysis.ingredient_count = reanalyzed.ingredient_count;
      analysis.additives = reanalyzed.additives;
      analysis.additive_count = reanalyzed.additive_count;
    }
  }
  if (Array.isArray(productInfo?.allergens)) {
    analysis.allergens = productInfo.allergens;
  }

  // Step 4: 영양 신호등
  let trafficLight = null;
  let sanityWarnings = [];
  const nutrition = analysis.nutrition;

  if (nutrition.calories || nutrition.sodium || nutrition.total_sugars) {
    const productData = {
      product_name: productInfo?.product_name || '(OCR 분석)',
      food_type: productInfo?.food_type || '',
      content_unit: nutrition.serving_unit || productInfo?.content_unit || 'g',
      serving_size: nutrition.serving_size || productInfo?.serving_size || 100,
      total_content: productInfo?.total_content || null,
    };

    const nutritionData = {
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

    sanityWarnings = sanityCheck(nutritionData, productData.serving_size);
    trafficLight = evaluateNutrition(productData, nutritionData);
  }

  // Step 5: DB 저장 (save=true 시 크라우드소싱 파이프라인)
  let saveResult = null;
  const shouldSave = req.body.save === true || req.body.save === 'true';

  if (shouldSave) {
    saveResult = await saveOcrContribution({
      barcode: productInfo?.barcode || req.body.barcode || null,
      productInfo: productInfo || {},
      ocrResult: { corrected_text: corrected, corrections },
      analysis,
      avgConfidence: ocrResult.avg_confidence,
      userId: req.body.user_id || null,
      deviceId: req.body.device_id || null,
    });
  }

  res.json({
    success: true,
    data: {
      ocr: {
        block_count: ocrResult.block_count,
        avg_confidence: ocrResult.avg_confidence,
        elapsed_ms: ocrResult.elapsed_ms,
        corrections,
        full_text_length: ocrResult.full_text.length,
      },
      corrected_text: corrected,
      analysis: {
        ingredients: analysis.ingredients,
        ingredient_count: analysis.ingredient_count,
        additives: analysis.additives,
        additive_count: analysis.additive_count,
        nutrition: analysis.nutrition,
        allergens: analysis.allergens,
        product_meta: analysis.product_meta,
      },
      traffic_light: trafficLight,
      sanity_warnings: sanityWarnings,
      save_result: saveResult,
    },
  });
});

// ============================================================
// POST /api/ocr/multi-photo
// 두 장의 사진을 받아 통합 분석:
//   - label_image: 제품 라벨 (제품명·식품유형·판매원·원재료·알레르기)
//   - nutrition_image: 영양성분표 (11개 영양소)
// 두 장의 OCR 결과를 합쳐 사용자가 거의 수정 없이 등록할 수 있게 한다.
// ============================================================

router.post(
  '/multi-photo',
  upload.fields([
    { name: 'label_image', maxCount: 1 },
    { name: 'nutrition_image', maxCount: 1 },
  ]),
  async (req, res) => {
    const labelFile = req.files?.label_image?.[0];
    const nutritionFile = req.files?.nutrition_image?.[0];

    if (!labelFile && !nutritionFile) {
      throw new ValidationError('label_image 또는 nutrition_image 중 하나 이상은 필수입니다.');
    }

    let productInfo = req.body.product_info;
    if (typeof productInfo === 'string') {
      try { productInfo = JSON.parse(productInfo); } catch { productInfo = null; }
    }

    console.log('[OCR/multi] 두 사진 분석 시작', {
      label: labelFile ? `${(labelFile.size / 1024).toFixed(0)}KB` : '없음',
      nutrition: nutritionFile ? `${(nutritionFile.size / 1024).toFixed(0)}KB` : '없음',
    });

    // ─── 1. 라벨 사진 OCR (제품명·원재료·알레르기) ───
    let labelAnalysis = null;
    let labelOcr = null;
    if (labelFile) {
      const base64 = labelFile.buffer.toString('base64');
      labelOcr = await callVisionAPI(base64);
      const truncated = labelOcr.full_text.substring(0, MAX_OCR_TEXT_LENGTH);
      const { corrected: c1, corrections: cor1 } = correctOcrText(truncated);
      labelAnalysis = analyzeText(c1);
      labelAnalysis._corrected_text = c1;
      labelAnalysis._corrections = cor1;
      labelAnalysis._avg_confidence = labelOcr.avg_confidence;
    }

    // ─── 2. 영양성분 사진 OCR (영양소만) ───
    let nutritionAnalysis = null;
    let nutritionOcr = null;
    if (nutritionFile) {
      const base64 = nutritionFile.buffer.toString('base64');
      nutritionOcr = await callVisionAPI(base64);
      const truncated = nutritionOcr.full_text.substring(0, MAX_OCR_TEXT_LENGTH);
      const { corrected: c2, corrections: cor2 } = correctOcrText(truncated);
      nutritionAnalysis = analyzeText(c2);
      nutritionAnalysis._corrected_text = c2;
      nutritionAnalysis._corrections = cor2;
      nutritionAnalysis._avg_confidence = nutritionOcr.avg_confidence;
    }

    // ─── 3. 두 분석 결과 병합 ───
    // 라벨 사진 → 메타·원재료·첨가물·알레르기 우선
    // 영양표 사진 → 영양정보 우선
    const merged = {
      product_meta: labelAnalysis?.product_meta || nutritionAnalysis?.product_meta || {},
      ingredients: labelAnalysis?.ingredients || [],
      ingredient_count: labelAnalysis?.ingredient_count || 0,
      additives: labelAnalysis?.additives || [],
      additive_count: labelAnalysis?.additive_count || 0,
      allergens: labelAnalysis?.allergens || [],
      nutrition: nutritionAnalysis?.nutrition || labelAnalysis?.nutrition || {},
    };

    // 사용자 입력 우선 적용
    if (productInfo?.nutrition) {
      merged.nutrition = { ...merged.nutrition, ...productInfo.nutrition };
    }
    if (productInfo?.allergens && Array.isArray(productInfo.allergens)) {
      merged.allergens = productInfo.allergens;
    }

    // ─── 4. 영양 신호등 판정 ───
    const nutrition = merged.nutrition;
    let trafficLight = null;
    let sanityWarnings = [];

    if (nutrition.calories || nutrition.sodium || nutrition.total_sugars) {
      const productData = {
        product_name: productInfo?.product_name || merged.product_meta.product_name || '(OCR 분석)',
        food_type: productInfo?.food_type || merged.product_meta.food_type || '',
        content_unit: nutrition.serving_unit || productInfo?.content_unit || merged.product_meta.content_unit || 'g',
        serving_size: nutrition.serving_size || productInfo?.serving_size || 100,
        total_content: productInfo?.total_content || merged.product_meta.total_content || null,
      };
      const nutritionData = {
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
      sanityWarnings = sanityCheck(nutritionData, productData.serving_size);
      trafficLight = evaluateNutrition(productData, nutritionData);
    }

    // ─── 5. 등록 (선택) ───
    let saveResult = null;
    const shouldSave = req.body.save === true || req.body.save === 'true';

    if (shouldSave) {
      // 사용자 입력 + 메타 병합 → productInfo 로 saveOcrContribution 에 전달
      const mergedProductInfo = {
        ...merged.product_meta,
        ...productInfo,
        nutrition: merged.nutrition,
        allergens: merged.allergens,
      };
      saveResult = await saveOcrContribution({
        barcode: productInfo?.barcode || req.body.barcode || null,
        productInfo: mergedProductInfo,
        ocrResult: {
          corrected_text: [
            labelAnalysis?._corrected_text,
            nutritionAnalysis?._corrected_text,
          ].filter(Boolean).join('\n---LABEL/NUTRITION SPLIT---\n'),
          corrections: [
            ...(labelAnalysis?._corrections || []),
            ...(nutritionAnalysis?._corrections || []),
          ],
        },
        analysis: merged,
        avgConfidence: Math.max(
          labelAnalysis?._avg_confidence || 0,
          nutritionAnalysis?._avg_confidence || 0,
        ),
        userId: req.body.user_id || null,
        deviceId: req.body.device_id || null,
      });
    }

    // ─── 6. 응답 ───
    res.json({
      success: true,
      data: {
        label_ocr: labelOcr ? {
          block_count: labelOcr.block_count,
          avg_confidence: labelOcr.avg_confidence,
          elapsed_ms: labelOcr.elapsed_ms,
          full_text_length: labelOcr.full_text.length,
        } : null,
        nutrition_ocr: nutritionOcr ? {
          block_count: nutritionOcr.block_count,
          avg_confidence: nutritionOcr.avg_confidence,
          elapsed_ms: nutritionOcr.elapsed_ms,
          full_text_length: nutritionOcr.full_text.length,
        } : null,
        analysis: {
          product_meta: merged.product_meta,
          ingredients: merged.ingredients,
          ingredient_count: merged.ingredient_count,
          additives: merged.additives,
          additive_count: merged.additive_count,
          nutrition: merged.nutrition,
          allergens: merged.allergens,
        },
        traffic_light: trafficLight,
        sanity_warnings: sanityWarnings,
        save_result: saveResult,
        corrected_text: {
          label: labelAnalysis?._corrected_text || null,
          nutrition: nutritionAnalysis?._corrected_text || null,
        },
      },
    });
  }
);

// ============================================================
// POST /api/ocr/report — 제품 오류 신고
// ============================================================

router.post('/report', async (req, res) => {
  const { product_id, user_id, reason } = req.body;

  if (!product_id || !reason) {
    throw new ValidationError('product_id와 reason이 필요합니다.');
  }

  const result = await reportError(product_id, user_id, reason);
  res.json({ success: true, data: result });
});

// ============================================================
// POST /api/ocr/text-only
// ============================================================

router.post('/text-only', upload.single('image'), async (req, res) => {
  const base64Image = extractBase64Image(req);

  const ocrResult = await callVisionAPI(base64Image);
  const truncatedText = ocrResult.full_text.substring(0, MAX_OCR_TEXT_LENGTH);
  const { corrected, corrections } = correctOcrText(truncatedText);

  res.json({
    success: true,
    data: {
      full_text: ocrResult.full_text,
      corrected_text: corrected,
      corrections,
      block_count: ocrResult.block_count,
      avg_confidence: ocrResult.avg_confidence,
      elapsed_ms: ocrResult.elapsed_ms,
    },
  });
});

module.exports = router;
