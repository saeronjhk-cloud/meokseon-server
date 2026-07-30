/**
 * OCR API 라우터
 * /api/ocr
 * multer(multipart) + base64 JSON 양쪽 지원
 */

const express = require('express');
const multer = require('multer');
const { callVisionAPI, correctOcrText } = require('../services/ocrService');
const {
  analyzeText, detectNutritionBasis, reconcileAllergens, mergeAllergensV2,
} = require('../services/ocrParser');
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

// ============================================================
// ★★ 세션42: 신호등 판정 공통부
// ============================================================
/**
 * 왜 함수로 뽑았나 —
 *   세션39 는 /analyze(L153) 만 basis 를 배선했고 /multi-photo(L309) 를 못 봤다.
 *   **같은 라벨을 읽는 두 번째 경로가 아무 기준 없이 per_serving 으로 판정**되고 있었다.
 *   (세션40 §2-2 와 완전히 같은 유형의 누락이다.)
 *   두 곳에 같은 코드를 복사해 두면 다음 수정 때 또 한 곳만 고친다. 한 곳으로 합친다.
 *
 * per_total 은 이제 신호등이 직접 다룬다(세션42 §1-1 배선 완료).
 *   evaluateNutrition 이 servingResolver 로 1회분 환산하고,
 *   인분 수를 모르면 **판정 보류(is_withheld)** 로 떨어뜨린다.
 *   → 여기서 per_serving 으로 눙치면 안 된다. 그게 032 떡국떡 거짓 빨강의 원인이다.
 */
const BASIS_OK = {
  per_serving: 'per_serving',
  per_100g: 'per_100g',
  per_100ml: 'per_100ml',
  per_total: 'per_total',      // ★ 세션42 신규 — 신호등 배선이 끝나서 열었다
};

function judgeNutrition({ productData, nutrition, labelText, explicitServingSize = null }) {
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

  // ★ 세션42: 기준 문구가 영양표 사진이 아니라 **라벨 사진 쪽**에 찍히는 경우가 흔하다.
  //   2장 분리 촬영(제이의 `_원재료` / `_영양` 규칙)에서 basis 가 unknown 으로 떨어지면
  //   합친 텍스트로 한 번 더 판정한다. 라벨에 답이 적혀 있는데 못 읽는 일을 막는다.
  let basisRaw = nutrition._basis || 'unknown';
  if (basisRaw === 'unknown' && labelText) {
    const re = detectNutritionBasis(labelText);
    if (re && re.basis && re.basis !== 'unknown') basisRaw = re.basis;
  }
  const basis = BASIS_OK[basisRaw] || 'per_serving';
  // unknown 은 여전히 per_serving 으로 두되 **불확실 플래그**를 남긴다(세션39 정책 유지).
  const basisUncertain = !BASIS_OK[basisRaw];
  nutritionData.basis = basis;

  if (basis === 'per_total') {
    // 라벨 원문을 함께 넘긴다. servingResolver 의 T0(“12인분”·“(65 g×6입)”)이 여기서만 작동한다.
    nutritionData._label_text = labelText || '';
    nutritionData._totalContent = productData.total_content ?? nutrition.total_content ?? null;

    // ★★ 세션42 검증에서 잡힌 치명 결함 —
    //   productData.serving_size 는 호출부에서 `|| 100` 으로 **기본값이 채워져 온다.**
    //   per_total 라벨은 1회 제공량이 라벨에 없어서 per_total 인 것이므로 이 100 은 **가짜 값**이다.
    //   그대로 두면 신호등의 "serving_size 가 비면 총 내용량을 쓴다" 가드가 영원히 안 돈다
    //   (`!100` 은 false). 30g 단품 과자가 100g 기준으로 환산돼 per-100 이 1/3 로 줄고
    //   **빨강이어야 할 제품이 노랑으로 나간다 = 거짓 초록.**
    //   → 진짜 근거가 있는 값만 남기고, 없으면 null 로 넘겨 신호등이 총 내용량으로 잡게 한다.
    productData = { ...productData, serving_size: explicitServingSize };
  }

  const trafficLight = evaluateNutrition(productData, nutritionData);

  // per_total 은 신호등이 환산 후 자체 sanityCheck 를 돌린다(총량 그대로 검사하면 전부 오탐).
  const sanityWarnings = (basis === 'per_total')
    ? (trafficLight?.sanity_warnings || [])
    : sanityCheck(nutritionData, productData.serving_size, false, basis);

  if (trafficLight) {
    trafficLight.basis_detected = basisRaw;
    if (basisUncertain) trafficLight.basis_uncertain = true;
  }

  return { trafficLight, sanityWarnings };
}

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
    // ★ 세션42: 여기가 **길이 제한이 적용되지 않던 유일한 경로**였다.
    //   사용자가 보낸 문자열이 그대로 정규식 엔진에 들어가 ReDoS 표면이 됐다(app.js 는 15MB 허용).
    //   OCR 텍스트와 같은 상한을 적용한다.
    const reanalyzed = analyzeText(String(productInfo.ingredients_text).substring(0, MAX_OCR_TEXT_LENGTH));
    if (reanalyzed.ingredients?.length) {
      analysis.ingredients = reanalyzed.ingredients;
      analysis.ingredient_count = reanalyzed.ingredient_count;
      analysis.additives = reanalyzed.additives;
      analysis.additive_count = reanalyzed.additive_count;
      // ★ 세션44: 사용자가 원재료 텍스트를 고쳤으면 알레르기 3분리도 그 텍스트로 다시 뽑는다.
      //   안 그러면 화면의 원재료와 혼입 경고가 서로 다른 텍스트에서 나온 값이 된다.
      // ★★★ 단, 사진 라벨에서 읽은 것을 **버리지 않는다**(서브에이전트 검증 치명3).
      //   사용자가 보낸 것은 보통 「원재료만」이라 함유 선언(`♥…함유♥`)이 들어 있지 않다.
      //   그대로 갈아끼우면 사진에서 읽은 직접 함유 선언이 사라지고,
      //   클라이언트는 v2 가 있으면 flat 을 안 쓰므로 **화면에서 통째로 없어진다.**
      //   → 두 결과를 합집합으로 병합한다. 경고는 잃지 않는다.
      // ★ 세션44 2차: 인라인 병합을 `mergeAllergensV2` 로 통합했다.
      //   `/multi-photo` 가 같은 병합을 필요로 하는데 로직이 두 벌이면 또 갈라진다(치명B가 그 사고였다).
      analysis.allergens_v2 = mergeAllergensV2(analysis.allergens_v2, reanalyzed.allergens_v2);
    }
  }
  // ★★ 세션44 2차 검증(경미M) — 초판은 `Array.isArray` 만 봐서 **빈 배열도 덮어쓰기**로 처리했다.
  //   `allergens: []` 를 보내면 flat 이 비고 3분리도 null 이 되어 **알레르기 카드가 통째로 사라진다.**
  //   빈 배열은 "사용자가 전부 지웠다" 와 "클라이언트가 기본값으로 보냈다" 를 구별하지 못한다.
  //   → 항목이 하나 이상일 때만 덮어쓰기로 본다. 지우는 것은 별도 플래그가 필요하다(미구현).
  if (Array.isArray(productInfo?.allergens) && productInfo.allergens.length > 0) {
    analysis.allergens = productInfo.allergens;
    // ★ 세션44: 사용자가 알레르기 목록을 직접 덮어썼다.
    //   그 목록에는 「직접함유 / 혼입가능」 구분 정보가 없다.
    //   서버가 라벨에서 뽑은 예전 3분리를 그대로 두면 화면에 **모순된 두 값**이 뜬다.
    //   → 근거가 사라졌으므로 3분리를 내리는 것이 맞다(추측해서 채우지 않는다).
    analysis.allergens_v2 = null;
  }

  // Step 4: 영양 신호등
  let trafficLight = null;
  let sanityWarnings = [];
  const nutrition = analysis.nutrition;

  if (nutrition.calories || nutrition.sodium || nutrition.total_sugars) {
    const productData = {
      product_name: productInfo?.product_name || analysis.product_meta?.product_name || '(OCR 분석)',
      // ★ 세션42: food_type 이 비면 RACC 매칭이 통째로 실패한다. 라벨에서 읽은 값을 폴백으로 쓴다.
      food_type: productInfo?.food_type || analysis.product_meta?.food_type || '',
      content_unit: nutrition.serving_unit || nutrition.content_unit || productInfo?.content_unit || 'g',
      serving_size: nutrition.serving_size || productInfo?.serving_size || 100,
      // ★ 세션42: 총 내용량이 null 이면 per_total 환산(총량 ÷ RACC)이 아예 못 돈다.
      //   `/multi-photo` 는 product_meta 폴백이 있었는데 여기만 없었다.
      total_content: productInfo?.total_content ?? nutrition.total_content
        ?? analysis.product_meta?.total_content ?? null,
    };

    // ★ 세션39: 표기 기준(basis)을 신호등에 전달한다. ★ 세션42: 공통부로 이관(judgeNutrition).
    //   실물 반례: 해표 콩기름은 "100g당 지방 100g" → 1회분으로 읽히면 판정이 무의미해진다.
    ({ trafficLight, sanityWarnings } = judgeNutrition({
      productData,
      nutrition,
      labelText: corrected,
      // 기본값 100 을 섞지 않은 **근거 있는 값만** — per_total 판정에 쓰인다
      explicitServingSize: nutrition.serving_size ?? productInfo?.serving_size ?? null,
    }));
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
        // ★ 세션44 — `allergens_v2`(직접함유/혼입가능/추정 3분리)는 알레르기 #114 부터
        //   analyzeText 안에서 **계산되고 있었지만 응답에 실리지 않았다**.
        //   세션43 의 `context_messages` 와 똑같은 형태의 결함이다(서버는 만들고 아무도 안 쓴다).
        //   flat `allergens` 만 내보내면 「혼입가능」을 「직접 함유」와 구별할 수 없다.
        // ★★★ reconcileAllergens — flat 에만 있는 항목을 3분리에 합쳐 넣는다(치명3 최종 방어).
        //   클라이언트는 v2 가 있으면 flat 을 안 보므로, 여기서 합치지 않으면 화면에서 사라진다.
        allergens_v2: reconcileAllergens(analysis.allergens, analysis.allergens_v2),
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
      // ★★★ 세션44 2차 검증 — 여기가 치명3 과 **완전히 같은 결함**이었다(2차 검증 치명B).
      //   초판은 `labelAnalysis?.allergens_v2 || nutritionAnalysis?.allergens_v2` 였는데
      //   `analyzeText` 는 `allergens_v2` 를 **항상 객체로** 반환한다(전부 빈 배열이라도 truthy).
      //   → 라벨 사진이 알레르기 표기를 못 잡으면 영양표 쪽은 **영원히 평가되지 않는다.**
      //   flat 의 `|| []` 도 같다(빈 배열도 truthy).
      //   실측: 표기가 영양표 사진에 찍힌 라면 라벨 → 단독 분석 8종이 **두 장 함께 보내면 1종**.
      //     소실: 게·난류·새우·쇠고기·우유(직접함유 5종) + 땅콩·메밀(혼입 2종).
      //     남은 밀도 「직접 함유」 → 「원재료 추정」 으로 강등됐다.
      //   ★ 법정 알레르기 표기는 영양성분표 옆에 인쇄되는 경우가 흔하다. 예외가 아니라 정상 케이스다.
      //   ★ 같은 파일 judgeNutrition 은 이미 두 사진 텍스트를 합쳐서 넘긴다 —
      //     영양은 합치고 알레르기는 안 합치고 있었다.
      //   → 두 사진 결과를 **합집합**으로 병합한다. 어느 쪽에서 읽혔든 경고는 잃지 않는다.
      allergens: [...new Set([
        ...(labelAnalysis?.allergens || []),
        ...(nutritionAnalysis?.allergens || []),
      ])].sort(),
      allergens_v2: mergeAllergensV2(labelAnalysis?.allergens_v2, nutritionAnalysis?.allergens_v2),
      nutrition: nutritionAnalysis?.nutrition || labelAnalysis?.nutrition || {},
    };

    // 사용자 입력 우선 적용
    if (productInfo?.nutrition) {
      merged.nutrition = { ...merged.nutrition, ...productInfo.nutrition };
    }
    // ★ 세션44 2차: /analyze 와 같은 이유 — 빈 배열은 덮어쓰기로 보지 않는다(경미M).
    if (Array.isArray(productInfo?.allergens) && productInfo.allergens.length > 0) {
      merged.allergens = productInfo.allergens;
      merged.allergens_v2 = null;   // ★ 세션44: /analyze 와 같은 이유 — 사용자 덮어쓰기 시 3분리 근거 소멸
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
      // ★★ 세션42 수정 — 여기가 basis 미배선 지점이었다(세션41 §5-4 발견).
      //   세션39 는 /analyze 만 고치고 이 두 번째 엔드포인트를 보지 못했다.
      //   이 경로로 들어온 **모든 라벨이 per_serving 으로 판정**되고 있었다.
      //   제이의 새 캡처 규칙(`_원재료` / `_영양` 2장 분리)이 정확히 이 경로를 쓴다.
      //   라벨 텍스트는 두 장을 합쳐 넘긴다 — 인분 수 표기는 영양표가 아니라
      //   제품 라벨 쪽에 적혀 있는 경우가 많다(019 "65 g×6입" 은 중량 줄에 있다).
      const labelText = [
        labelAnalysis?._corrected_text,
        nutritionAnalysis?._corrected_text,
      ].filter(Boolean).join('\n');

      ({ trafficLight, sanityWarnings } = judgeNutrition({
        productData,
        nutrition,
        labelText,
        explicitServingSize: nutrition.serving_size ?? productInfo?.serving_size ?? null,
      }));
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
          // ★ 세션44: /analyze 와 동일 계약 + flat 병합(치명3)
          allergens_v2: reconcileAllergens(merged.allergens, merged.allergens_v2),
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
