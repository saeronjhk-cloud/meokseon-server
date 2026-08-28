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
// ★ 세션50 D2 — 저장 게이트의 sanity 는 **엔진(evaluateNutrition)** 이 낸 것을 쓴다.
//   sanityCheck 를 아직 import 하는 이유는 「평가 대상 외」(주류·건기식·원료)일 때뿐이다.
//   그때도 건조 판정은 엔진 결과(is_dried_exception)를 넘긴다 — 여기서 새로 판정하지 않는다.
const { evaluateNutrition, sanityCheck, scaleNutrition } = require('./nutritionTrafficLight');
const { getRaccPolicy } = require('./raccPolicy');
// 세션42: per_total 라벨을 저장 게이트 **통과 전에** 1회분으로 환산하기 위해 사용
const { resolveServings, totalToServingDivisor } = require('./servingResolver');
const { mergeAndApply, AUTO_VERIFY_DISTINCT_DEVICES } = require('./mergeService');
// ★ 세션46 중대4 — 저장 경계도 응답과 **같은 함수**로 3분리를 만든다. 규칙을 두 번 적지 않는다.
const { reconcileAllergens, flattenAllergensV2 } = require('./ocrParser');
// ★ 세션65 C1(`U64-3`) — 첨가물 저장집합(합집합) 규칙은 **한 파일**에만 있다.
//   경로 ②(`mergeService`)가 같은 함수를 부른다. 한쪽만 고치면 경로 간 결과가 갈린다.
const { upsertProductAdditives, countDetected } = require('./additiveResolver');
// ★ 세션65 C2-a — 022(`products.additive_detected_count`) 배포순서 방어 판정에만 쓴다.
const productModel = require('../models/productModel');

// 최소 OCR 신뢰도 (Gemini 피드백: 0.5→0.7 상향)
const MIN_CONFIDENCE = 0.7;

// 자동 승격 신뢰도 (partial)
const AUTO_PROMOTE_CONFIDENCE = 0.9;

// ★ 세션42: DB 저장용 키 이름은 라벨 파서 키 이름과 다르다(total_sugars / saturated_fat / dietary_fiber).
//   nutritionTrafficLight.scaleNutrition 은 판정용 키(sugars / sat_fat / fiber)를 다루므로
//   저장 경로에는 그대로 쓸 수 없다. 키 목록을 분리해 둔다 — 합치면 조용히 안 나눠진다.
const STORED_NUTRIENT_KEYS = [
  'calories', 'total_fat', 'saturated_fat', 'trans_fat', 'cholesterol',
  'sodium', 'total_carbs', 'total_sugars', 'dietary_fiber', 'protein',
];

function scaleStoredNutrition(nutrition, divisor) {
  if (!divisor || divisor <= 1) return nutrition;
  const out = { ...nutrition };
  for (const k of STORED_NUTRIENT_KEYS) {
    const v = out[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = Math.round((v / divisor) * 1000) / 1000;
    }
  }
  return out;
}

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

  // ── 게이트 0: 제품명 (세션64 · 제이 결정 2026-08-21) ────────────────────────
  // ★★★ 종전 코드는 이 관문이 **없었고**, 대신 트랜잭션 안에서 이렇게 채웠다:
  //       const productName = (productInfo.product_name || '').trim()
  //         || analysis.ingredients?.[0]?.name        // ← 첫 원재료명을 제품명으로!
  //         || '(OCR 분석 제품)';
  //   실물 라벨 67건 실측에서 **21건**이 이 폴백을 탔고, `products.product_name` 에
  //   실제로 저장될 값은 이랬다:
  //     "정제수"(6건) · "주정" · "옥수수" · "원유" · "륨" · "국산 원유"
  //     · "(고형분 95% 이상, 베트남산) 0.5264%"
  //   `products` 는 **바코드 단위 공용 마스터**다. 한 사람의 제보가 그 바코드를 조회하는
  //   전원에게 간다 — 이것은 결측이 아니라 **데이터 오염**이고, DB 오염은 되돌리기가 가장 어렵다.
  //
  // ★ 왜 throw 가 아니라 반려(return)인가 —
  //   이 함수의 다른 게이트 5개가 전부 `{ saved:false, rejectReason }` 을 돌려준다.
  //   여기만 throw 하면 기존 `save=true` 경로(`/analyze`·`/multi-photo`)가 **HTTP 500** 이 된다.
  //   배포된 구버전 앱은 `save_result.saved` 를 보고 판정하므로 계약이 깨진다.
  //   → 게이트 관용구를 그대로 쓴다. HTTP 400 은 `/api/ocr/confirm` 라우터가 낸다.
  //
  // ★ 왜 맨 앞인가 — 다른 게이트보다 싸고(문자열 하나), 사용자가 고칠 수 있는 유일한 사유다.
  //   신뢰도·이상치로 먼저 반려하면 앱은 「재촬영」을 안내하고 = Vision 을 또 부른다.
  //
  // ⚠ `products.product_name` 은 NOT NULL 이다(`scripts/migrations/000_baseline.sql:138`).
  //   NULL 허용으로 스키마를 바꾸는 방향은 **택하지 않았다** — 이름 없는 제품 행은
  //   검색·병합·중복판정을 전부 헛돌게 한다. 막는 쪽이 맞다.
  const productName = (productInfo.product_name || '').trim();
  if (!productName) {
    return {
      saved: false,
      rejectReason: '제품명을 입력해 주세요. 제품명 없이는 등록할 수 없어요.',
      reason_code: 'PRODUCT_NAME_REQUIRED',
    };
  }

  // ── 게이트 1: OCR 신뢰도 ──
  if (avgConfidence < MIN_CONFIDENCE) {
    return {
      saved: false,
      rejectReason: `OCR 신뢰도(${(avgConfidence * 100).toFixed(0)}%)가 기준(${MIN_CONFIDENCE * 100}%) 미만입니다. 더 선명한 이미지로 다시 촬영해주세요.`,
    };
  }

  const nutrition = analysis.nutrition || {};
  const servingSize = nutrition.serving_size || 100;

  // ══════════════════════════════════════════════════════════════════════════
  // ★★★ 세션64b — 「영양 실패」와 「제보 실패」를 가른다 (외부 검토 2명 결론)
  // ══════════════════════════════════════════════════════════════════════════
  // 종전: 영양 쪽 사유 5개(기준 판별 실패 · per_total 미해결 · 이상치 · mass balance ·
  //   공공데이터 보호)가 전부 `return { saved:false }` 였다. 그 순간 **같은 요청에 실려 온
  //   원재료·알레르기 원증거까지 통째로 버려졌다.** 알레르기는 안전에 직결되는 축이다 —
  //   영양표를 못 읽었다는 이유로 「밀 함유」 증거를 버리는 것은 손해가 훨씬 크다.
  //
  // 새 규칙: **저장 ≠ 표시 ≠ 검증** (Ingest Permissive, Render Conservative)
  //   · 저장  — 영양이 실패해도 원재료·알레르기·기여 이력은 남긴다.
  //   · 표시  — 영양이 실패하면 `nutrition_data` 에 **행을 만들지 않는다.**
  //             행이 없으면 `productService.getProductWithTrafficLight` 가
  //             `product.sodium/calories === null` 을 보고 `traffic_light: null` 을 낸다.
  //             = 빈 값이 `0` 처럼 보일 여지가 구조적으로 없다.
  //   · 검증  — 영양을 하나도 확보 못 했으면 `partial`(부분 확인됨)로 올리지 않는다.
  //             검토자 지적 그대로: **「확인한 것이 없다면 부분 확인도 아니다.」**
  //
  // ★ 여전히 **전부 반려**인 것 (영양 축이 아니다 — 헷갈리지 말 것)
  //   · 게이트 0 제품명 — 없으면 `products` 마스터가 오염된다(세션64).
  //   · 게이트 1 신뢰도 — 읽기 품질 자체가 낮다. 원재료 텍스트도 같이 못 믿는다.
  //   · 24시간 중복 제출 — 어뷰징 방지. 같은 기기의 증거는 이미 저장돼 있다.
  //
  // ⚠ 이 값으로 **저장을 거부하지 않는다.** `nutrientCount` 는 관측 지표다(3단계).
  //   실측(세션64 라벨 67건): 0개 4건 vs 5~12개 63건, **1~4개 구간이 비어 있다.**
  //   표본이 작아 하한을 정할 근거가 없다. 운영에서 1~4개가 실제로 나오는지부터 본다.
  let nutritionStatus = 'ok';        // 'ok' | 'incomplete'
  let nutritionRejectCode = null;
  let nutritionRejectReason = null;
  let nutritionRejectDetail = null;  // basis_detected · lookup_reasons 등 부가 정보

  /**
   * 영양만 떨어뜨린다. 제보 자체는 계속 간다.
   * ★ **첫 사유만** 기록한다. 뒤 게이트가 앞 사유를 덮으면
   *   「왜 영양이 없나」의 답이 실행 순서에 따라 바뀐다 = 관측이 무의미해진다.
   */
  function dropNutrition(code, reason, detail = null) {
    if (nutritionStatus === 'incomplete') return;
    nutritionStatus = 'incomplete';
    nutritionRejectCode = code;
    nutritionRejectReason = reason;
    nutritionRejectDetail = detail;
  }

  // ── 3단계: 영양소 개수 «관측» ────────────────────────────────────────────
  // ★ `!= null` 로 센다. 종전 `hasNutrition = nutrition.calories || nutrition.sodium || ...`
  //   는 **truthy 검사**라 `0` 을 「없음」으로 봤다. 열량 0 kcal·나트륨 0 mg 은
  //   제로칼로리 음료의 **실제 라벨값**이다 — 그것을 「없음」으로 세면
  //   진짜 결측과 구별할 수 없고, 실측 「0개 4건」의 분모부터 틀어진다.
  const nutrientCount = STORED_NUTRIENT_KEYS.reduce((n, k) => {
    const v = nutrition[k];
    return n + ((v !== null && v !== undefined && Number.isFinite(Number(v))) ? 1 : 0);
  }, 0);

  if (nutrientCount === 0) {
    // 「영양소 0개」는 저장 거부가 아니라 **미확보 표시**다.
    // 이 사유를 기준 판별(basis)보다 **먼저** 잡는 이유: 0개면 basis 도 당연히 unknown 이라
    // 뒤 게이트가 먼저 걸리면 「기준을 못 읽었다」로 기록돼 진짜 원인이 가려진다.
    dropNutrition('NO_NUTRIENTS', '영양성분을 하나도 읽지 못했습니다. 영양정보 표가 잘 보이도록 다시 촬영해주세요.');
  }

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

  // ★ 세션39: 표기 기준(basis)을 게이트에 반영한다.
  //   여기는 화면 표시가 아니라 **DB 영구 저장** 관문이다. 기준을 모르는 값을 넣으면
  //   되돌리기 어렵다. per_100g 라벨을 per_serving 으로 검사하면 게이트 자체가 헛돈다
  //   (해표 콩기름 실물: 100g당 지방 100g).
  // ★★ 세션42: per_total 을 열었다. **순서가 안전장치였다.**
  //   먼저 신호등(evaluateNutrition)에 RACC 환산을 배선한 뒤에 여는 것이다.
  //   그냥 열면 sanityCheck 가 총량을 1회분으로 검사해 032 떡국떡(500 g / 1,530 mg)이
  //   `per_serving_exceeded` 로 **거짓 거부**되거나, 통과해도 신호등이 거짓 빨강을 낸다.
  //   → 여기서도 검사 **전에** 1회분으로 환산한다. 환산 못 하면 저장하지 않는다.
  const BASIS_OK = {
    per_serving: 'per_serving', per_100g: 'per_100g', per_100ml: 'per_100ml',
    per_total: 'per_total',
  };
  const basisRaw = nutrition._basis || 'unknown';
  const basis = BASIS_OK[basisRaw];
  if (!basis) {
    // ★★★ 세션64b — 종전엔 여기서 `return { saved:false }` 였다.
    //   판정 불가인 **영양값**을 저장하지 않는 것은 그대로다(`null = 판정 없음 ≠ 안전`).
    //   달라진 것은 **제보 전체를 버리지 않는다**는 것뿐이다.
    //   기준 문구를 못 읽은 것과 원재료·알레르기를 못 읽은 것은 다른 사건이다.
    dropNutrition(
      'BASIS_UNKNOWN',
      '영양성분의 표기 기준(1회 제공량당 / 100g당 / 총 내용량당)을 판별하지 못했습니다. '
        + '영양정보 표 상단의 기준 문구가 함께 보이도록 다시 촬영해주세요.',
      { basis_detected: basisRaw },
    );
  }

  // ── per_total → 1회분 환산 (세션42) ──
  let checkBasis = basis;
  let checkServing = servingSize;
  let checkNutrition = nutritionForCheck;
  let perTotalResolved = null;
  let perTotalDivisor = 1;
  let perTotalServingSize = null;   // per_total 라벨에서 계산한 진짜 1회분(없으면 null 로 남긴다)

  if (basis === 'per_total') {
    const totalContent = productInfo.total_content ?? nutrition.total_content ?? null;
    perTotalResolved = resolveServings({
      text: ocrResult?.corrected_text || '',
      basis,
      totalContent,
      contentUnit: productInfo.content_unit ?? nutrition.content_unit ?? null,
      servingSize: productInfo.serving_size ?? null,
      foodType: productInfo.food_type ?? analysis?.product_meta?.food_type ?? null,
    });
    const div = totalToServingDivisor(perTotalResolved);

    if (!div.safe) {
      // 여러 회분인 게 확실한데 몇 인분인지 모른다(017 골든카레형).
      // 총량을 1회분으로 저장하면 **모든 후속 판정이 거짓 빨강**이 된다. 영양은 저장하지 않는다.
      // ★ 세션64b — 여기도 `return` 이 아니라 영양만 떨어뜨린다. 같은 사진에 찍힌
      //   원재료·알레르기는 「몇 인분인지 모른다」와 아무 상관이 없다.
      dropNutrition(
        'PER_TOTAL_UNRESOLVED',
        '총 내용량 기준으로 표시된 라벨입니다. 여러 회분이 확실하지만 1회 섭취량을 확인하지 못했습니다. '
          + '"○인분" 또는 "1회 제공량" 표기가 함께 보이도록 다시 촬영해주세요.',
        { basis_detected: basisRaw, needs_lookup: true, lookup_reasons: perTotalResolved.lookupReasons },
      );
    } else {
      // ⚠⚠ 세션64b — 이 블록은 **`div.safe` 일 때만** 돌아야 한다.
      //   종전에는 바로 위에서 `return` 했으므로 여기 도달 자체가 불가능했다. 이제 도달하므로
      //   `else` 로 명시적으로 감싼다. 안 감싸면 `div.divisor` 가 null/undefined 인 채로
      //   `totalContent / div.divisor` = **Infinity·NaN** 이 되고, 그 값이
      //   `products.serving_size` 로 **영구 저장**된다(DB 오염은 되돌리기가 가장 어렵다).
      perTotalDivisor = div.divisor;
      if (totalContent) {
        // ★ 세션42 검증 — divisor === 1 이어도 1회분은 **총 내용량**이지 기본값 100 이 아니다.
        //   여기서 100 이 남으면 per-100 환산이 어긋나고(거짓 초록), 그 100 이 products.serving_size 로
        //   **영구 저장**된다. DB 오염은 되돌리기가 가장 어렵다.
        perTotalServingSize = Math.round((totalContent / div.divisor) * 100) / 100;
        checkServing = perTotalServingSize;
      }
      if (div.divisor > 1) {
        checkNutrition = scaleNutrition(nutritionForCheck, div.divisor);
      }
      checkBasis = 'per_serving';   // 환산 완료
    }
  }

  // ★★★ 세션50 D2 — **저장 게이트도 엔진 판정을 받아 쓴다.**
  //   종전: `sanityCheck(checkNutrition, checkServing, false, checkBasis)` — 3번째 인자가
  //     하드코딩 false 라 **건조식품(김·김자반·육포·미역)의 사용자 제보가 부당하게 반려**됐다.
  //     100g 당 열량·지방이 자연히 높은 것이 건조식품의 정의인데, 화면(신호등)은 면제하고
  //     저장만 거부하는 「화면은 통과 · 등록은 반려」 상태였다.
  //   ⚠ 여기는 화면이 아니라 **DB 영구 저장 관문**이다. 방향이 「거부 → 허용」으로 바뀌는
  //     유일한 축은 **건조식품의 per_100g 상한**뿐이다. per_serving 상한·음수·mass balance 는
  //     건조식품에도 그대로 살아 있다(tests/test_path_parity.js §8 이 두 방향을 다 고정한다).
  //   ⚠ 평가 대상 외(주류·건강기능식품·원료식품)는 엔진이 판정 전에 반환해 `sanity_warnings` 가
  //     빈 배열이다. 그것을 그대로 게이트에 쓰면 **이상치가 통과해 영구 저장**된다.
  //     그래서 그 경우에만 엔진의 건조 판정(`is_dried_exception`)을 받아 같은 함수를 직접 부른다 —
  //     판정을 여기서 새로 하는 것이 아니라 **엔진이 낸 답을 넘기는 것**이다.
  // ★ 세션64b — 이미 영양을 떨어뜨린 상태(기준 판별 실패·0개·per_total 미해결)면
  //   sanity 를 **돌리지 않는다.** 기준을 모르는 값을 검사하면 답이 무의미하고,
  //   `sanity_warnings: []`(= 「검사했고 이상 없음」)이 기록돼 관측이 거짓말을 한다.
  //   `null = 검사 못 함` 은 이 저장소의 기존 관례다(ocrRoutes 의 `sanity_warnings` 주석과 동일).
  let sanityWarnings = null;
  let criticalWarnings = [];
  let massBalanceWarning = null;

  if (nutritionStatus === 'ok') {
    const gateProduct = {
      product_name: productInfo.product_name || analysis?.product_meta?.product_name || '',
      food_type: productInfo.food_type || analysis?.product_meta?.food_type || '',
      content_unit: productInfo.content_unit || nutrition.content_unit || null,
      // ★ checkServing 은 위에서 정한 값 그대로다. 여기서 `Number(...)`·`|| 100` 을 새로 넣지 말 것
      //   (`Number(null)===0`, `Number('')===0` — 「데이터 없음」이 「0」이 되면 게이트가 헛돈다).
      serving_size: checkServing,
      total_content: productInfo.total_content ?? nutrition.total_content ?? null,
    };
    const gateEval = evaluateNutrition(
      gateProduct,
      { ...checkNutrition, basis: checkBasis },
      undefined,
      getRaccPolicy(gateProduct.food_type),
    );
    sanityWarnings = (gateEval.is_excluded || gateEval.is_withheld)
      ? sanityCheck(checkNutrition, checkServing, gateEval.is_dried_exception, checkBasis)
      : gateEval.sanity_warnings;
    criticalWarnings = sanityWarnings.filter(w =>
      w.type === 'per_serving_exceeded' || w.type === 'per_100g_exceeded' || w.type === 'negative_value'
    );

    if (criticalWarnings.length > 0) {
      // ★★★ 세션64b — 종전엔 `return { saved:false }` 였다.
      //   **영양값은 여전히 버린다** — 물리적으로 불가능한 수치를 마스터에 넣으면
      //   그 바코드를 조회하는 전원이 거짓 판정을 받는다(게이트의 방향은 그대로다).
      //   달라진 것: 같은 사진의 **원재료·알레르기까지 버리지는 않는다.**
      //   숫자를 잘못 읽은 것과 원재료명을 잘못 읽은 것은 다른 사건이다.
      dropNutrition(
        'SANITY_OUTLIER',
        `영양정보 이상치가 감지되었습니다: ${criticalWarnings.map(w => `${w.nutrient}(${w.value})`).join(', ')}`,
      );
    }

    // ── 게이트 3: Mass Balance ──
    massBalanceWarning = sanityWarnings.find(w => w.type === 'mass_balance_exceeded') || null;
    if (massBalanceWarning) {
      dropNutrition('MASS_BALANCE', massBalanceWarning.message);
    }

    // 열량 교차 검증은 경고만 (저장은 허용)
    const calorieWarning = sanityWarnings.find(w => w.type === 'calorie_deviation');
    if (calorieWarning) {
      warnings.push(calorieWarning);
    }
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
      // ★★★ 세션64b — 종전엔 `return { saved:false }` 였다. 그래서 **이미 등록된 바코드에
      //   대한 제보는 원재료·알레르기까지 통째로 버려졌다.** 식약처 데이터는 영양만 준다 —
      //   원재료·알레르기·첨가물은 대부분 비어 있고, 그것을 채우는 유일한 경로가 사진 제보다.
      //   「영양이 이미 있다」를 이유로 알레르기 증거를 버리는 것은 순손실이다.
      //   ⚠ 공공데이터 영양값을 OCR 로 **덮지 않는다**는 원래 규칙은 그대로다
      //     (아래 `storeNutrition` 이 false 가 되고, `nutrition_data` INSERT 자체를 안 한다).
      if (nutSource && nutSource.startsWith('public_')) {
        dropNutrition(
          'PUBLIC_DATA_PROTECTED',
          '이 제품은 이미 공공데이터 기반 영양정보가 등록되어 있습니다. 영양정보는 그대로 두고 원재료·알레르기 정보만 반영했습니다.',
        );
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

  // ★★ 세션65 C2-a — 022 미적용 DB 방어. **반드시 트랜잭션 «밖»**에서 판정한다.
  //   `hasAdditiveDetectedCountColumn()` 은 내부에서 `db.query`(= `pool.query`)를 쓴다.
  //   트랜잭션 client 를 쥔 채 부르면 저장 1건이 순간적으로 **커넥션 2개**를 점유하고,
  //   풀이 얕으면 전원이 두 번째 커넥션을 기다리다 동시에 실패한다(세션47 중대3 과 동일).
  const canWriteDetectedCount = await productModel.hasAdditiveDetectedCountColumn();

  // ★★★ 세션65 C2-a — 「검출 총 개수」는 **마스터 조인 «전»** 의 수다.
  //   `analysis.additives` = `identifyAdditives` 결과 = 제보 직후 «화면에 보인» 첨가물.
  //   배열이 아니면(구버전 호출부) `null` = 「모른다」. 0 으로 대체하지 않는다.
  const additiveDetectedTotal = countDetected(analysis.additives);

  // ── DB 저장 (트랜잭션) ──
  return await db.transaction(async (client) => {
    // 사용자 입력 → DB 컬럼 정리
    // ★ 세션64 — `productName` 은 **게이트 0** 에서 이미 확정됐다(공백 아님이 보증된다).
    //   여기 있던 `analysis.ingredients?.[0]?.name || '(OCR 분석 제품)'` 폴백은 폐기했다.
    //   폴백을 되살리려면 게이트 0 부터 지워야 한다 — 이 주석이 그 신호다.
    const manufacturer = (productInfo.manufacturer || '').trim() || null;
    const brand = (productInfo.brand || '').trim() || null;
    const foodType = (productInfo.food_type || '').trim() || null;
    // ★★ 세션42 — per_total 라벨은 **환산본을 저장한다.**
    //   총량 값을 그대로 넣으면 nutrition_data 는 1회분 테이블처럼 읽히므로
    //   이후 모든 조회가 거짓 빨강이 된다. DB 오염은 되돌리기가 가장 어렵다.
    //   serving_size 도 환산과 짝을 맞춰야 한다(총량 ÷ 인분 수).
    // ★ 사용자 입력 > per_total 환산값 > 라벨 1회 제공량 > null.
    //   **기본값 100 을 절대 저장하지 않는다** — 근거 없는 값이 DB 에 박히면 되돌릴 신호가 남지 않는다.
    const servingSize = productInfo.serving_size ?? perTotalServingSize ?? nutrition.serving_size ?? null;
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
      // ★ 세션64 검토 — `product_name = COALESCE(NULLIF(product_name,''), $2, product_name)` 는
      //   그대로 둔다. $2(`productName`)는 게이트 0 을 통과한 **공백 아닌 trim 된 값**이므로
      //   빈 이름이 흘러들 수 없다. 기존 이름이 있으면 NULLIF 가 그것을 지켜 덮어쓰지 않는다.
      //   (종전에는 $2 가 "정제수"·"(OCR 분석 제품)" 일 수 있었고, 이름이 빈 기존 행에
      //    그 쓰레기가 **영구히** 박혔다. 게이트 0 이 그 입구를 닫았다.)
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
    // production 스키마 정렬: per_serving 제거 (TRUE 만 INSERT 라 무의미), ocr_confidence 는 006 마이그레이션으로 추가됨
    //
    // ★★★ 세션64b — 종전 `const hasNutrition = nutrition.calories || nutrition.sodium || nutrition.total_sugars;`
    //   는 두 가지가 틀렸다.
    //   ① **truthy 검사**라 `0` 을 「없음」으로 봤다. 제로칼로리 음료(열량 0 / 당류 0)는
    //      나머지 7개 값이 다 있어도 `nutrition_data` 행이 안 만들어졌다.
    //   ② 검사 대상이 3개뿐이라, 단백질·지방만 읽힌 라벨도 「없음」이 됐다.
    //   → `nutrientCount`(10개 키를 `!= null` 로 센 것) 하나로 통일한다.
    //
    // ⚠ `storeNutrition === false` 면 **행 자체를 만들지 않는다.** 이것이 「영양정보 미확보」의
    //   실제 표현이다 — 별도 컬럼이 필요 없다. 행이 없으면
    //   `productService.getProductWithTrafficLight` 가 `product.calories/sodium === null` 을 보고
    //   `traffic_light: null` · `nutrition: null` 을 낸다. **빈 값이 `0` 으로 보일 경로가 없다.**
    //   (0 을 채워 넣는 순간 소비자는 「나트륨 0 mg = 안전」으로 읽는다 — 그것이 이 도크트린의 반대다.)
    const storeNutrition = nutritionStatus === 'ok' && nutrientCount > 0;
    // per_total 환산본 (divisor <= 1 이면 원본 그대로 — 새 객체도 만들지 않는다)
    const nutritionToStore = scaleStoredNutrition(nutrition, perTotalDivisor);
    if (storeNutrition) {
      await client.query(
        `INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat,
          cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein,
          ocr_confidence, data_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ocr_crowdsource')
         ON CONFLICT (product_id) DO NOTHING`,
        [
          productId,
          nutritionToStore.calories ?? null,
          nutritionToStore.total_fat ?? null,
          nutritionToStore.saturated_fat ?? null,
          nutritionToStore.trans_fat ?? null,
          nutritionToStore.cholesterol ?? null,
          nutritionToStore.sodium ?? null,
          nutritionToStore.total_carbs ?? null,
          nutritionToStore.total_sugars ?? null,
          nutritionToStore.dietary_fiber ?? null,
          nutritionToStore.protein ?? null,
          Math.round(avgConfidence * 100),
        ]
      );
    }

    // ── 원재료 저장 (product_ingredients) ──
    const ingredientNames = (analysis.ingredients || [])
      .map((i) => (typeof i === 'string' ? i : i?.name))
      .filter((s) => s && s.trim().length > 0);
    if (ingredientNames.length > 0 || productInfo.ingredients_text) {
      // production 스키마: 컬럼명이 source (data_source 아님). enum 아닌 varchar 라 'ocr_crowdsource' 그대로 OK.
      await client.query(
        `INSERT INTO product_ingredients (product_id, raw_text, parsed_ingredients, source)
         VALUES ($1, $2, $3, 'ocr_crowdsource')`,
        [
          productId,
          productInfo.ingredients_text || ocrResult?.corrected_text || null,
          JSON.stringify(ingredientNames),  // production 은 jsonb 라 JSON 문자열로
        ]
      );
    }

    // ── 첨가물 자동 매칭 (additives 마스터와 비교) ──
    //
    // ★★★ 세션65 C1 (`U64-3`) — 종전 코드는 여기서 `ingredientNames` **하나만**
    //   `= ANY()` 완전일치로 조인했다. 실측 소실률 **66.1%**(189 중 125).
    //     · `identifyAdditives`(= `analysis.additives`)는 부분매칭 + `detail` 스캔까지 해서
    //       「산도조절제(인산나트륨)」에서 `인산나트륨` 을 뽑는데,
    //       저장은 그 결과를 **한 번도 쓰지 않고** `산도조절제` 를 완전일치로 찾았다.
    //     · 사라진 이름 47종 중 **37종(78.7%)이 마스터에 이미 있었다.**
    //       별칭 사전을 아무리 보강해도 안 풀리는 구조 결함이었다.
    //   → 저장집합을 **두 축의 합집합**으로 넓힌다(계약 C1). 규칙 본문은
    //     `additiveResolver.js` 한 곳에 있고 `mergeService` 가 같은 함수를 부른다.
    //
    // ★ 위 `if (ingredientNames.length > 0 || productInfo.ingredients_text)` **밖**으로 뺐다.
    //   종전에는 원재료 INSERT 가 일어날 때만 첨가물 매칭이 돌았다. 합집합에서는
    //   `analysis.additives` 만 있고 `ingredients` 가 비는 입력도 저장 대상이다.
    //   (`ingredientNames` 가 있으면 위 조건도 참이므로 기존 경로는 그대로다.)
    //
    // ⚠ `detected_name` 에는 **마스터 이름이 아니라 라벨 원문**이 들어간다(계약 C1).
    // ⚠ `ON CONFLICT (product_id, additive_id) DO NOTHING` 은 유지한다(계약 C1).
    await upsertProductAdditives(client, productId, {
      detectedAdditives: analysis.additives,
      ingredientNames,
      confidence: Math.round(avgConfidence * 100),
    });

    // ── 검출 총 개수 기록 (`U65-2` · 계약 C2-a) ──
    //   ★ `GREATEST` 로 **내려가지 않게** 한다. 같은 바코드에 두 번째 제보가 흐린 사진이라
    //     검출이 3종밖에 안 됐다고 해서, 첫 제보가 남긴 11종을 3으로 덮으면
    //     `unlisted` 가 줄어든다 = **경고를 지우는 방향**이다.
    //     (Postgres 의 GREATEST 는 NULL 을 무시하지만, COALESCE 로 명시해 둔다.)
    //   ★ 컬럼이 없으면(022 미적용) 아무것도 하지 않는다 — 위에서 판정했다.
    if (canWriteDetectedCount && additiveDetectedTotal !== null) {
      await client.query(
        `UPDATE products
            SET additive_detected_count = GREATEST(COALESCE(additive_detected_count, 0), $2)
          WHERE product_id = $1`,
        [productId, additiveDetectedTotal]
      );
    }

    // 검증 상태 결정
    // ★★★ 세션64b 외부 검토 지적 — **「확인한 것이 없다면 부분 확인도 아니다.」**
    //   종전 조건은 `avgConfidence >= 0.9 && 이상치 없음 && mass balance 없음` 뿐이었다.
    //   영양소를 **하나도 못 읽은** 제보도 신뢰도만 높으면 `partial`(부분 확인됨)로 올라갔고,
    //   그 상태에서 두 번째 제보가 오면 아래 SQL 의 `partial AND verify_count>=1 → verified` 로
    //   **「검증됨」**까지 갔다. 확인된 영양값이 0개인 제품이 「검증됨」 배지를 다는 것이다.
    //   → 영양을 실제로 저장했을 때만 승격한다.
    //
    // ⚠ 영양이 미확보여도 원재료·알레르기는 저장된다(위 참조). 그것들은 `verification` 이 아니라
    //   `product_ingredients` · `contributions` 에 증거로 남는다. 「저장 ≠ 검증」이다.
    let verification = 'unverified';
    if (storeNutrition && avgConfidence >= AUTO_PROMOTE_CONFIDENCE
        && criticalWarnings.length === 0 && !massBalanceWarning) {
      verification = 'partial';
    }

    // verify_count 증가 + 크라우드소싱 검증
    //
    // ★★★ 세션65 C3 (`U64-4`) — **경로 ①은 `partial` 까지만 올린다.**
    //   지웠던 줄(원문):
    //     WHEN verification = 'partial' AND verify_count >= 1 THEN 'verified'::verification_status
    //
    //   왜 지웠나 — 이 줄에는 **기기 구분이 없다.**
    //     · 24시간 중복 게이트는 `if (deviceId && productId)` 인데, **신규 제품의 첫 저장은
    //       `productId` 가 null** 이라 애초에 걸리지 않는다.
    //     · 앱은 `device_id` 를 아예 보내지 않는다(`U64-5`) — 웹 경로에서는 그 게이트가
    //       **절대** 발동하지 않는다.
    //   ⇒ 한 사람이 한 기기로 25시간 간격 사진 2장을 올리면
    //     `unverified → partial → verified` 다. 「다른 사용자가 확인했다」는 배지가
    //     **혼자서** 달린다. 「검증됨」은 소비자가 가장 강하게 믿는 신호다.
    //
    //   ⇒ `verified` 로의 전이는 **`mergeService.mergeAndApply` 한 곳**만 한다.
    //     그쪽은 `distinctDeviceCount >= AUTO_VERIFY_DISTINCT_DEVICES(3)` 로
    //     **서로 다른 기기 수**를 실제로 센다.
    //
    //   ⚠ 되살리려는 사람에게 — 되살리기 전에 ① 앱이 `device_id` 를 보내는지,
    //     ② 24시간 게이트가 신규 제품 첫 저장에도 걸리는지 **둘 다** 실측할 것.
    //     둘 중 하나라도 아니면 이 줄은 자작 승격 통로다.
    await client.query(
      `UPDATE products SET
         verification = CASE
           WHEN verification = 'unverified' THEN $2::verification_status
           ELSE verification
         END,
         verify_count = verify_count + 1,
         updated_at = NOW()
       WHERE product_id = $1`,
      [productId, verification]
    );

    // contributions 이력 기록 — 사용자가 입력·수정한 메타정보까지 보존
    await client.query(
      `INSERT INTO contributions (user_id, product_id, contribution_type, data, status, device_id)
       VALUES ($1, $2, $3, $4, 'pending', $5)`,
      [
        userId ? parseInt(userId) : null,
        productId,
        'ocr_nutrition',
        JSON.stringify({
          ocr_raw_text: ocrResult?.corrected_text || '',
          avg_confidence: avgConfidence,
          corrections: ocrResult?.corrections || [],
          // ★★★ 세션64b — 영양이 쓸 수 없는 값이면 `parsed_nutrition` 에 **넣지 않는다.**
          //   `mergeService.extractCandidatesFromContribution` 이 이 키를 읽어 median 을 낸다
          //   (`mergeService.js:280`). 이상치·기준불명 값을 여기에 남기면, 지금은 저장을 막아도
          //   **나중 병합이 그 값을 마스터에 올린다.** 「저장은 관대, 표시는 보수」의
          //   「표시」에는 병합 결과도 포함된다.
          //   → 원본은 아래 `rejected_nutrition` 에 **관측용으로만** 남긴다(merge 는 안 읽는다).
          parsed_nutrition: storeNutrition ? nutrition : null,
          rejected_nutrition: storeNutrition ? null : (nutrientCount > 0 ? nutrition : null),
          // ── 「영양정보 미확보」 상태 (2단계) ──────────────────────────────
          //   'ok' | 'incomplete'. 스키마 변경 없이 JSONB 에 남긴다 —
          //   `products` 에 컬럼을 새로 파면 **컬럼이 없는 운영 DB 에서 코드가 즉사**하고,
          //   같은 사실이 두 곳(행 유무 · 컬럼)에 생겨 진상원이 2개가 된다(020 주석과 같은 이유).
          //   소비자에게 보이는 「영양 미확보」는 `nutrition_data` 행이 없다는 사실 그 자체다.
          nutrition_status: nutritionStatus,
          nutrition_reject_code: nutritionRejectCode,
          nutrition_reject_detail: nutritionRejectDetail,
          // ── 개수 «관측» (3단계) ──────────────────────────────────────────
          //   ⚠ 이 값으로 저장을 거부하지 않는다. 관측 전용이다.
          //   보는 법: SELECT data->>'nutrient_count' AS n, count(*) FROM contributions
          //            WHERE contribution_type='ocr_nutrition' GROUP BY 1 ORDER BY 1;
          //   실측(라벨 67건)에서 1~4개 구간이 비어 있었다. 운영에서 실제로 나오는지 본다.
          nutrient_count: nutrientCount,
          parsed_ingredients: analysis.ingredients || [],
          // ★★★ 세션46 2차 검증 중대4 — 여기가 **응답과 어긋나는 진짜 지점**이었다.
          //   세션45 는 응답 4곳을 `flattenAllergensV2(reconcileAllergens(...))` 로 통일했는데
          //   저장 경로는 **reconcile 을 거치지 않은 raw** 를 그대로 넣고 있었다.
          //   결과(전사 68건 실측 3건 — 006·046·076):
          //     같은 라벨인데 OCR 응답은 「원재료 추정(inferred)」, DB 는 「직접 함유(contains)」.
          //   `mergeService.unionAllergens` 가 **flat 에만 있고 v2 에 없는 이름을
          //   `ALLERGEN_LEVEL_DEFAULT='contains'` 로 확정**하기 때문이다.
          //   006 실측: 새우·조개류가 바코드 조회에서 붉은 「직접 함유」로 나갔다 — 라벨은 선언한 적이 없다.
          //   → 응답과 **같은 함수**를 태워 flat-only 이름이 `inferred` 로 저장되게 한다.
          allergens: flattenAllergensV2(
            reconcileAllergens(analysis.allergens, analysis.allergens_v2),
            analysis.allergens,
          ),
          // ★★★ 세션44 2차 검증(중대F) — `allergens_v2` 가 **저장 경로에 전혀 없었다.**
          //   flat `allergens` 만 저장되는데, 세션44가 flat 에서 혼입 항목을 정확히 제거했기 때문에
          //   **혼입 정보가 화면에만 있고 DB 에는 남지 않는다.**
          //   실측: 캡처 032 는 `대두·우유`, 060 은 `난류·대두·메밀` 이 저장 경로에서 사라진다.
          //   나중에 같은 바코드를 조회한 대두 알레르기 사용자는 아무 경고를 받지 못한다.
          //   flat 에서 빼는 것 자체는 옳지만(직접 함유가 아니므로), **경고 총량이 순감**하면 안 된다.
          //   → 3분리를 그대로 함께 저장한다. 등급 정보가 있으므로 조회 시 구분해 표시할 수 있다.
          //   ⚠ `products.allergens` 컬럼은 여전히 flat 이다. 상품 레코드에 3분리를 반영하는 것은
          //     스키마 변경이 필요하므로 별건이다(인수인계 이월).
          //   ★ 세션46 — 여기도 reconcile 을 거친다. flat 과 v2 가 **같은 출처의 짝**이어야
          //     `unionAllergens` 가 인덱스로 맞출 때 이름과 등급이 어긋나지 않는다.
          allergens_v2: reconcileAllergens(analysis.allergens, analysis.allergens_v2),
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
        deviceId || null,
      ]
    );

    // ★ 세션64b 3단계 — 개수·상태를 **로그에도** 남긴다.
    //   DB 는 나중에 파는 것이고, 로그는 배포 직후 바로 볼 수 있다. 둘 다 있어야
    //   「1~4개 구간이 실제로 나오는가」를 운영 첫날부터 관찰할 수 있다.
    logger.info('OCR 크라우드소싱 저장 완료', {
      productId, barcode, verification, isNewProduct, avgConfidence,
      nutrient_count: nutrientCount,
      nutrition_status: nutritionStatus,
      nutrition_reject_code: nutritionRejectCode,
    });

    // ── 자동 merge 트리거 ──
    // 같은 product 에 distinct device_id 가 AUTO_VERIFY_DISTINCT_DEVICES (=3) 모이면
    // mergeAndApply 호출하여 마스터 갱신. 트랜잭션 밖에서 별도 실행 (실패해도 contribution 저장은 보존).
    let mergeResult = null;
    try {
      const distinctCountResult = await client.query(
        `SELECT COUNT(DISTINCT device_id)::int AS cnt
         FROM contributions
         WHERE product_id = $1
           AND device_id IS NOT NULL
           AND contribution_type IN ('ocr_nutrition', 'new_product', 'verify')`,
        [productId]
      );
      const distinctCount = distinctCountResult.rows[0]?.cnt || 0;

      if (distinctCount >= AUTO_VERIFY_DISTINCT_DEVICES) {
        // 트랜잭션 닫기 전에는 별도 호출 안 함 — 트랜잭션 종료 후 호출하도록 표시만 남김
        mergeResult = { trigger: true, distinctCount };
      } else {
        mergeResult = { trigger: false, distinctCount };
      }
    } catch (e) {
      logger.warn('merge trigger 카운트 조회 실패', { productId, error: e.message });
    }

    return {
      saved: true,
      productId,
      product_id: productId, // Flutter 측 호환 (snake_case)
      isNewProduct,
      verification,
      mergeResult,    // 트랜잭션 외부에서 mergeAndApply 호출용
      // ── 세션64b 신설 키 (앱은 몰라도 되지만, 알면 「영양은 못 읽었어요」를 정확히 말할 수 있다) ──
      //   ⚠ 기존 키(`saved`·`productId`·`verification`·`message`·`warnings`)는 **한 글자도
      //     바꾸지 않았다.** 배포된 구버전 앱이 `save_result.saved` 로 판정한다.
      nutrition_status: nutritionStatus,          // 'ok' | 'incomplete'
      nutrition_reject_code: nutritionRejectCode, // NO_NUTRIENTS | BASIS_UNKNOWN | PER_TOTAL_UNRESOLVED | SANITY_OUTLIER | MASS_BALANCE | PUBLIC_DATA_PROTECTED
      nutrition_reject_reason: nutritionRejectReason,
      nutrient_count: nutrientCount,              // 관측 전용. 저장 판정에 쓰지 않는다.
      // ★ 세션64b — 영양이 미확보면 **그 사실을 사용자에게 말한다.**
      //   「등록되었습니다」만 보여주면, 영양표를 못 읽은 것을 모른 채 「등록됐으니 다 들어갔겠지」로
      //   읽는다. 「모름」을 침묵으로 감추는 것은 「모름」을 「없음」으로 바꾸는 것과 같은 실수다.
      //   ⚠ 키 이름·타입은 그대로다(문자열). 구버전 앱은 이 문장을 그대로 띄우기만 한다.
      message: (isNewProduct
        ? '새 제품으로 등록되었습니다. 다른 사용자가 동일한 정보를 등록하면 검증됨으로 승격됩니다.'
        : '기존 제품에 정보가 추가되었습니다.')
        + (nutritionStatus === 'incomplete' ? ' (영양정보는 확인하지 못해 저장되지 않았습니다.)' : ''),
      // ★ 세션64b — `sanityWarnings` 는 이제 **null 일 수 있다**(= 검사 못 함).
      //   `null.filter` 는 TypeError 다. 기존 계약(배열)을 지키기 위해 빈 배열로 낸다.
      warnings: Array.isArray(sanityWarnings)
        ? sanityWarnings.filter(w => w.type === 'calorie_deviation')
        : [],
      allergenWarning: analysis.allergens?.length > 0
        ? '⚠️ 알레르기 정보는 관리자 검증 전까지 미확정 상태입니다. 반드시 실제 제품 패키지를 확인하세요.'
        : null,
    };
  }).then(async (txResult) => {
    // 트랜잭션 종료 후 자동 merge 호출 (트랜잭션 안에서 호출하면 nested 발생).
    // merge 자체는 자체 트랜잭션을 사용함.
    if (txResult.saved && txResult.mergeResult?.trigger) {
      try {
        const merged = await mergeAndApply(txResult.productId);
        logger.info('자동 merge 적용 완료', {
          productId: txResult.productId,
          distinctDevices: merged.distinctDeviceCount,
          verification: merged.verification,
          outliers: merged.outliers?.length || 0,
        });
        txResult.autoMerged = {
          applied: true,
          verification: merged.verification,
          distinctDeviceCount: merged.distinctDeviceCount,
          outlierCount: merged.outliers?.length || 0,
        };
        // 응답 메시지에 반영
        if (merged.verification === 'verified') {
          txResult.message = `✓ ${merged.distinctDeviceCount}명의 사용자가 검증한 제품으로 승격되었습니다!`;
        } else if (merged.verification === 'disputed') {
          txResult.message = `⚠ 다수 등록되었으나 입력값에 큰 차이가 있어 관리자 검토 대기 상태입니다.`;
        }
      } catch (e) {
        logger.error('자동 merge 실패 — contribution 은 저장됨', {
          productId: txResult.productId,
          error: e.message,
        });
      }
    }
    return txResult;
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
  scaleStoredNutrition,          // 세션42: 저장 경로 per_total 환산 (테스트용 노출)
  STORED_NUTRIENT_KEYS,
};
