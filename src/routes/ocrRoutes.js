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
      },
      traffic_light: trafficLight,
      sanity_warnings: sanityWarnings,
      save_result: saveResult,
    },
  });
});

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
