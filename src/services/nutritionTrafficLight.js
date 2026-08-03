/**
 * 먹선(吃選) 영양 신호등 판정 서비스 v1.3
 *
 * ⚠️ IP SOURCE: OneDrive/MeokSeon/IP/nutrition_traffic_light_v1.3.md
 * 임계값·KDRI 기준 수정 시 OneDrive 원본 먼저 수정 후 nutrition_config 테이블 UPDATE.
 * DEFAULT_CONFIG 은 DB 미접속 fallback 용이므로 OneDrive 와 동기화 유지.
 *
 * 핵심 원칙:
 * - 7개 영양소 각각 독립적 3색 판정 (종합 점수 없음)
 * - 이중 기준: %DV + 100g/100mL 절대량 중 더 나쁜 쪽 적용
 * - 건조식품 예외: 100g 기준 면제, %DV만 적용
 * - 권장 영양성분 적색 피로감 방지: 5% DV 미만 → gray
 * - Config DB에서 기준값 로드 (하드코딩 금지)
 */

// ★ 세션42: per_total(총 내용량 기준) 라벨을 1회분으로 환산하기 위해 사용한다.
//   servingResolver → raccTable → src/data/food_type_racc_v1.json (파일 없으면 degrade, throw 안 함)
//   순환참조 없음: servingResolver 는 이 파일을 require 하지 않는다.
const servingResolver = require('./servingResolver');

// ★★ 세션49 — 신호등 판정 규칙의 버전. 응답에 실어 보낸다.
//   v1.4 = 세션49 치명A·B 수정. RACC 정책이 실제로 발동하기 시작한 버전이다
//   (그 전까지는 배선만 있고 매칭률 0 이라 사실상 RACC 없는 v1.3 과 같은 답을 냈다).
//   ⚠ 판정 규칙(임계값·가드·1회량 선택)을 바꾸면 **반드시 여기를 올릴 것.**
//     클라이언트·평가셋이 "왜 색이 달라졌는가" 를 물을 수 있는 유일한 단서다.
const TRAFFIC_LIGHT_POLICY_VERSION = 'v1.4-s49';

// ============================================================
// 1. Config 로더 (DB 또는 인메모리)
// ============================================================

/**
 * nutrition_config 테이블에서 기준값을 로드한다.
 * 실제 운영에서는 DB 쿼리, 여기서는 인메모리 캐시로 대체 가능.
 *
 * @param {Object} db - 데이터베이스 클라이언트
 * @param {string} profile - 'adult', 'child', 'pregnant' 등
 * @returns {Object} configMap - { nutrient: { basis: { threshold: value } } }
 */
async function loadConfig(db, profile = 'adult') {
  const query = `
    SELECT nutrient, threshold, basis, value, unit
    FROM nutrition_config
    WHERE profile = $1
      AND effective_from <= CURRENT_DATE
      AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
    ORDER BY nutrient, basis, threshold
  `;
  const rows = await db.query(query, [profile]);

  const configMap = {};
  for (const row of rows.rows) {
    if (!configMap[row.nutrient]) configMap[row.nutrient] = {};
    if (!configMap[row.nutrient][row.basis]) configMap[row.nutrient][row.basis] = {};
    configMap[row.nutrient][row.basis][row.threshold] = parseFloat(row.value);
  }

  return configMap;
}

// ============================================================
// 2. 인메모리 기본 Config (DB 없이 독립 실행용)
// ============================================================

const DEFAULT_CONFIG = {
  // DV 기준치
  dv: {
    calories: 2000,
    total_fat: 54,
    sat_fat: 15,
    cholesterol: 300,
    sodium: 2000,
    sugars: 100,
    fiber: 25,
    protein: 55,
  },

  // 제한 영양성분 %DV 컷오프
  negative_pct_dv: {
    sodium:      { green_max: 10, yellow_max: 25 },
    sugars:      { green_max: 10, yellow_max: 25 },
    sat_fat:     { green_max: 10, yellow_max: 25 },
    total_fat:   { green_max: 10, yellow_max: 25 },
    cholesterol: { green_max: 10, yellow_max: 25 },
  },

  // 100g당 절대량 컷오프 (일반식품)
  per_100g: {
    sodium:    { green_max: 120, yellow_max: 600 },
    sugars:    { green_max: 5,   yellow_max: 15 },
    sat_fat:   { green_max: 1.5, yellow_max: 5 },
    total_fat: { green_max: 3,   yellow_max: 17.5 },
  },

  // 100mL당 절대량 컷오프 (음료)
  per_100ml: {
    sodium:    { green_max: 50,   yellow_max: 250 },
    sugars:    { green_max: 2.5,  yellow_max: 6.3 },
    sat_fat:   { green_max: 0.75, yellow_max: 2.5 },
    total_fat: { green_max: 1.5,  yellow_max: 8.75 },
  },

  // 권장 영양성분 %DV 컷오프 (역방향)
  positive_pct_dv: {
    protein: { gray_max: 5, green_min: 15 },
    fiber:   { gray_max: 5, green_min: 15 },
  },

  // 트랜스지방 (별도 규칙)
  trans_fat: {
    green_max: 0,
    yellow_max: 0.5,
  },
};

// ============================================================
// 3. 식품 유형 판별
// ============================================================

/**
 * 음료 여부를 판별한다 (영양 신호등 v1.3 §4.2).
 *
 * 우선순위:
 * 1. C005 API 식품유형 코드
 * 2. 내용량 단위 (mL, L → 음료)
 * 3. 제품명 키워드 ('음료', '주스', '워터', '차', '우유')
 * 4. Silent Fallback → 일반식품
 */
function detectFoodCategory(product) {
  // 1. 식품유형 코드 기반
  const beverageTypes = ['음료류', '탄산음료', '과·채주스', '두유류', '커피', '차류', '혼합음료', '과채음료'];
  const driedTypes = ['육포', '건포류', '건과류', '김류', '장류'];
  const alcoholTypes = ['주류', '맥주', '소주', '와인', '위스키', '탁주'];
  const supplementTypes = ['건강기능식품', '영양보충용식품'];

  // 비음료 식품유형 (content_unit이 mL이어도 음료가 아닌 경우)
  const nonBeverageTypes = ['유지류', '식용유지', '올리브유', '참기름', '들기름', '식초', '소스류', '드레싱', '액상차'];
  // 발효식품 식품유형 (건조 키워드보다 우선)
  const fermentedTypes = ['김치류', '장류', '발효유류', '발효식품'];

  if (product.food_type) {
    if (alcoholTypes.some(t => product.food_type.includes(t))) return 'alcohol';
    if (supplementTypes.some(t => product.food_type.includes(t))) return 'supplement';
    if (fermentedTypes.some(t => product.food_type.includes(t))) return 'fermented';
    if (beverageTypes.some(t => product.food_type.includes(t))) return 'beverage';
    if (driedTypes.some(t => product.food_type.includes(t))) return 'dried';
  }

  // 2. 내용량 단위 기반 (비음료 식품유형 제외)
  if (product.content_unit) {
    const unit = product.content_unit.toLowerCase();
    if (unit === 'ml' || unit === 'l') {
      // 식용유 등 비음료 제외
      const isNonBeverage = product.food_type && nonBeverageTypes.some(t => product.food_type.includes(t));
      if (!isNonBeverage) return 'beverage';
    }
  }

  // 3. 제품명 키워드 기반 (발효 > 건조 > 음료 순서로 체크)
  if (product.product_name) {
    const name = product.product_name;
    const fermentedKeywords = ['김치', '된장', '간장', '젓갈', '청국장', '고추장'];
    const beverageKeywords = ['음료', '주스', '워터', '우유', '두유', '커피', '콜라', '사이다', '에이드'];
    // '김'은 '김치'와 구분하기 위해 정규식으로 체크 (김치/김밥 등 제외)
    const driedKeywords = ['육포', '말린', '건조', '분말', '가루', '건과', '누룽지', '미역', '다시마'];

    // 발효식품 우선 체크
    if (fermentedKeywords.some(k => name.includes(k))) return 'fermented';
    if (beverageKeywords.some(k => name.includes(k))) return 'beverage';
    if (driedKeywords.some(k => name.includes(k))) return 'dried';
    // '김'은 단독 또는 조미김/구운김 등일 때만 건조식품 (김치, 김밥 제외)
    if (/김(?!치|밥)/.test(name) && name.includes('김')) return 'dried';
  }

  // 4. Silent Fallback → 일반식품
  return 'general';
}

// ============================================================
// 4. 핵심 판정 로직
// ============================================================

/**
 * %DV를 계산한다.
 */
function calcPctDV(amount, dvValue) {
  if (!dvValue || dvValue === 0) return null;
  return (amount / dvValue) * 100;
}

/**
 * 100g/100mL당 환산값을 계산한다.
 */
function calcPer100(amountPerServing, servingSize) {
  if (!servingSize || servingSize === 0) return null;
  return (amountPerServing / servingSize) * 100;
}

function deriveBasis(servingSizeRaw) {
  if (typeof servingSizeRaw === 'string') {
    const s = servingSizeRaw.replace(/\s/g, '').toLowerCase();
    if (/^100ml/.test(s)) return 'per_100ml';
    if (/^100g/.test(s)) return 'per_100g';
    if (/^100unknown/.test(s)) return 'per_100_unknown';  // OFF: per-100 이나 단위(g/mL) 불명(#2 reconcile §7)
  }
  return 'per_serving';
}

/**
 * 제한 영양성분(negative)의 색상을 판정한다.
 *
 * @param {number} pctDV - %DV 값
 * @param {Object} dvCutoffs - { green_max, yellow_max }
 * @returns {string} 'green' | 'yellow' | 'red'
 */
function judgeNegativeByPctDV(pctDV, cutoffs) {
  if (pctDV === null || pctDV === undefined) return null;
  if (pctDV <= cutoffs.green_max) return 'green';
  if (pctDV <= cutoffs.yellow_max) return 'yellow';
  return 'red';
}

/**
 * 100g/100mL 절대량 기준으로 색상을 판정한다.
 */
function judgeByAbsolute(per100Value, cutoffs) {
  if (per100Value === null || per100Value === undefined) return null;
  if (per100Value <= cutoffs.green_max) return 'green';
  if (per100Value <= cutoffs.yellow_max) return 'yellow';
  return 'red';
}

/**
 * 권장 영양성분(positive)의 색상을 판정한다.
 * 적색 피로감 방지: 5% DV 미만 → gray
 */
function judgePositive(pctDV, cutoffs) {
  if (pctDV === null || pctDV === undefined) return null;
  if (pctDV < cutoffs.gray_max) return 'gray';
  if (pctDV >= cutoffs.green_min) return 'green';
  return 'yellow';
}

/**
 * 트랜스지방 특별 규칙.
 */
function judgeTransFat(amount, cutoffs) {
  if (amount === null || amount === undefined) return null;
  if (amount <= cutoffs.green_max) return 'green';
  if (amount <= cutoffs.yellow_max) return 'yellow';
  return 'red';
}

/**
 * 두 색상 중 더 나쁜(높은) 쪽을 반환한다.
 * 순서: green < yellow < red
 */
function worseColor(colorA, colorB) {
  const order = { green: 0, yellow: 1, red: 2 };
  if (colorA === null) return colorB;
  if (colorB === null) return colorA;
  return order[colorA] >= order[colorB] ? colorA : colorB;
}

// ============================================================
// 5. OCR Sanity Check
// ============================================================

const SANITY_LIMITS = {
  calories:    { per_serving: 2000, per_100g: 900 },
  sodium:      { per_serving: 5000, per_100g: 40000 },
  sugars:      { per_serving: 200,  per_100g: 100 },
  total_fat:   { per_serving: 200,  per_100g: 100 },
  sat_fat:     { per_serving: 100,  per_100g: 100 },
  protein:     { per_serving: 200,  per_100g: 100 },
  cholesterol: { per_serving: 2000, per_100g: null },
  trans_fat:   { per_serving: 50,   per_100g: 100 },
  fiber:       { per_serving: 100,  per_100g: 100 },
};

/**
 * OCR 데이터 Sanity Check.
 *
 * ★★★ 세션50 D2 — **이 함수는 엔진 전용이다.** 라우터·서비스에서 직접 부르지 말 것.
 *   `evaluateNutrition` 이 `detectFoodCategory` 로 정한 건조 여부를 넘겨 호출하고,
 *   결과는 `result.sanity_warnings` **한 배열**로만 흐른다. 소비자(ocrRoutes·productRoutes·
 *   crowdsourceService)는 그 배열을 **그대로 받아 쓴다**(같은 참조).
 *   ⚠ 여기를 다시 부르기 시작하면 「같은 규칙을 두 곳에서 재해석」이 재발하고,
 *     같은 응답에 서로 반대되는 sanity 가 두 번 실리는 D2 가 그대로 돌아온다.
 *   ※ 여전히 export 하는 이유는 tests/test_traffic_light.js·test_100_products.js 가
 *     이 함수를 단위 검사하기 때문이다(그 두 파일은 이번 세션 소관이 아니다).
 *
 * @param {Object} nutritionData - 영양정보 객체
 * @param {number} servingSize - 1회 제공량(g 또는 mL)
 * @param {boolean|null} isDried - 건조식품 여부.
 *   · `true`  = 건조식품 → per_100g 상한 **면제**(김·육포·미역·다시마 등 작은 serving 제품의
 *               100g 환산 자연 초과 보호. 2026-05-27 추가)
 *   · `false` = 비건조 → per_100g 상한 검사
 *   · `null`  = **판정 없음.** 상한 검사를 하지 않고 그 사실을 `dried_unknown` 경고로 남긴다.
 *               「모른다」를 조용히 「건조 아님」으로 굳히면 없는 근거로 경고를 만든다
 *               (`Number(null)===0` 함정과 같은 구조다).
 *   ⚠ 기본값 `= false` 는 **세션50 에 제거했다.** 인자를 빠뜨린 호출이 조용히
 *     「건조 아님」이 되던 것이 D2 의 형태였다(ocrRoutes·productRoutes·crowdsourceService 3곳).
 *   ※ `undefined`(인자 2개만 넘기는 레거시 호출 — tests/test_traffic_light.js:343·369)는
 *     종전대로 `false` 와 같이 다룬다. **새 호출부는 반드시 명시할 것.**
 * @returns {Array} 경고 목록 [{ nutrient, value, limit, type }]
 */
function sanityCheck(nutritionData, servingSize, isDried, basis = 'per_serving') {
  const warnings = [];
  // null 만 「모른다」다. undefined 는 위 주석대로 레거시 호환으로 false 취급한다.
  const _driedKnown = isDried !== null;
  const _isDried = isDried === true;
  const _isPer100 = basis === 'per_100g' || basis === 'per_100ml';
  const _toServing = (amt) => _isPer100 ? (servingSize > 0 ? (amt * servingSize) / 100 : amt) : amt;
  const _toPer100 = (amt) => _isPer100 ? amt : (servingSize > 0 ? calcPer100(amt, servingSize) : null);

  for (const [nutrient, limits] of Object.entries(SANITY_LIMITS)) {
    const value = nutritionData[nutrient];
    if (value === null || value === undefined) continue;

    // 음수 차단
    if (value < 0) {
      warnings.push({ nutrient, value, limit: 0, type: 'negative_value' });
      continue;
    }

    const perServingVal = _toServing(value);
    if (limits.per_serving !== null && perServingVal > limits.per_serving) {
      warnings.push({ nutrient, value: perServingVal, limit: limits.per_serving, type: 'per_serving_exceeded' });
    }

    // 100g당 상한 — 건조식품은 면제 (신호등 평가와 동일 정책. evaluateNutrition의 is_dried_exception과 일관)
    // ★ isDried === null(판정 없음)이면 검사 자체를 하지 않는다. 아래에서 그 사실을 경고로 남긴다.
    if (_driedKnown && !_isDried && limits.per_100g !== null) {
      const per100 = _toPer100(value);
      if (per100 !== null && per100 > limits.per_100g) {
        warnings.push({ nutrient, value: per100, limit: limits.per_100g, type: 'per_100g_exceeded' });
      }
    }
  }

  // ★ 세션50 D2 — 「건조 여부를 모른다」를 침묵으로 처리하지 않는다.
  //   경고가 없는 것과 검사를 못 한 것은 다르다(`null = 판정 없음 ≠ 안전`).
  if (!_driedKnown) {
    warnings.push({
      nutrient: 'is_dried', value: null, limit: null, type: 'dried_unknown',
      message: '건조식품 여부를 판정하지 못해 100g당 상한 검사를 하지 않았습니다.',
    });
  }

  // 포화지방 > 총지방 체크
  if (nutritionData.sat_fat != null && nutritionData.total_fat != null) {
    if (nutritionData.sat_fat > nutritionData.total_fat) {
      warnings.push({ nutrient: 'sat_fat', value: nutritionData.sat_fat, limit: nutritionData.total_fat, type: 'exceeds_total_fat' });
    }
  }

  // 1회 제공량 > 총내용량 체크
  if (servingSize && nutritionData._totalContent && servingSize > nutritionData._totalContent) {
    warnings.push({ nutrient: 'serving_size', value: servingSize, limit: nutritionData._totalContent, type: 'serving_exceeds_total' });
  }

  // ── Mass Balance 검증 (Gemini 피드백) ──
  // 탄수화물 + 단백질 + 지방 ≤ 기준량 × 1.1
  const carbs = nutritionData.total_carbs ?? nutritionData.carbs ?? null;
  const protein = nutritionData.protein ?? null;
  const fat = nutritionData.total_fat ?? null;

  if (carbs !== null && protein !== null && fat !== null && servingSize > 0) {
    const macroSum = carbs + protein + fat;
    const massBase = _isPer100 ? 100 : servingSize;
    const maxAllowed = massBase * 1.1;

    if (macroSum > maxAllowed) {
      warnings.push({
        nutrient: 'mass_balance',
        value: macroSum,
        limit: maxAllowed,
        type: 'mass_balance_exceeded',
        message: `매크로 영양소 합(${macroSum.toFixed(1)}g)이 1회 제공량(${servingSize}g)의 110%를 초과합니다.`,
      });
    }
  }

  // ── 열량 교차 검증 (Gemini 피드백) ──
  // 추정 열량 = (탄수화물 × 4) + (단백질 × 4) + (지방 × 9)
  // 실제 열량과 ±30% 이상 차이 시 경고
  const calories = nutritionData.calories ?? null;
  if (calories !== null && carbs !== null && protein !== null && fat !== null) {
    const estimatedCalories = (carbs * 4) + (protein * 4) + (fat * 9);
    if (estimatedCalories > 0) {
      const deviation = Math.abs(calories - estimatedCalories) / estimatedCalories;
      if (deviation > 0.3) {
        warnings.push({
          nutrient: 'calories_cross_check',
          value: calories,
          limit: estimatedCalories,
          type: 'calorie_deviation',
          message: `실제 열량(${calories}kcal)과 추정 열량(${estimatedCalories.toFixed(0)}kcal)의 차이가 ${(deviation * 100).toFixed(0)}%입니다.`,
        });
      }
    }
  }

  return warnings;
}

// ============================================================
// 5b. per_total 환산 보조 (세션42)
// ============================================================

/** per_total 값을 1회분으로 나눈 새 객체를 만든다. 원본은 건드리지 않는다. */
const SCALABLE_NUTRIENTS = [
  'calories', 'sodium', 'sugars', 'sat_fat', 'total_fat', 'cholesterol',
  'protein', 'fiber', 'trans_fat', 'total_carbs', 'carbs',
];

function scaleNutrition(nutrition, divisor) {
  if (!divisor || divisor <= 1) return nutrition;
  const out = { ...nutrition };
  for (const k of SCALABLE_NUTRIENTS) {
    const v = out[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = Math.round((v / divisor) * 1000) / 1000;
    }
  }
  return out;
}

/**
 * 판정 보류 결과. 여러 회분인 게 확실한데 인분 수를 모르는 경우다.
 * 색을 칠하지 않는다 — 여기서 총량을 1회분으로 칠하면 거짓 빨강이 된다(017 골든카레 458%).
 * 열량은 **총량이라고 명시해서** 그대로 보여준다. 정보 자체는 사실이기 때문.
 */
const WITHHELD_KEYS = ['sodium', 'sugars', 'sat_fat', 'total_fat', 'cholesterol', 'protein', 'fiber', 'trans_fat'];

// 판정 보류 사유별 사용자 문구. `totalToServingDivisor` 의 safe:false 사유는 2종이다.
// ★ 세션43: 이전에는 두 사유가 전부 'multi_serving_but_count_unknown' 으로 하드코딩돼 나갔다.
//   racc_says_single_but_pct_dv_says_multi(RACC 는 1회분이라는데 라벨 %기준치는 여러 회분)와
//   구분되지 않으면, 클라이언트가 원인별 안내를 할 수 없고 72 배치의 큐 분류도 뭉개진다.
const WITHHOLD_MESSAGES = {
  multi_serving_but_count_unknown:
    '이 제품은 총 내용량 기준으로 표시된 라벨이며, 여러 회분이 확실하지만 1회 섭취량을 확인하지 못했습니다. '
    + '잘못된 경고를 드리지 않기 위해 판정을 보류합니다.',
  racc_says_single_but_pct_dv_says_multi:
    '이 제품은 총 내용량 기준으로 표시된 라벨입니다. 식품유형 기준 1회 섭취참고량으로는 1회분이지만, '
    + '라벨의 1일 영양성분 기준치가 그와 맞지 않습니다. 어느 쪽이 맞는지 확정하지 못해 판정을 보류합니다.',
  // ★★ 세션45 (제이 결정 2026-07-30, 안①): basis 를 읽지 못한 라벨은 판정하지 않는다.
  //   이전에는 `nutrition.basis || 'per_serving'` 이 unknown 을 **1회분으로 취급**했다.
  //   캡처 018 실물: 나트륨 690 mg / 열량·1회 제공량·총 내용량 전부 없음.
  //   1회분으로 읽으면 과자 RACC 30 g 기준 빨강이 나가지만, 총량 기준일 가능성이 크다 = 거짓 빨강.
  //   `null = 판정 없음 ≠ 안전` 도크트린. 실측 비용은 68건 중 2건(2.9%)뿐이다.
  //   근거: IP/basis_unknown_decision_2026-07-30.md
  basis_unknown:
    '이 라벨에서 영양성분이 무엇을 기준으로 적힌 것인지(총 내용량 당 / 100 g 당 / 1회 제공량 당) 확인하지 못했습니다. '
    + '기준을 모르는 상태로 계산하면 실제와 크게 달라질 수 있어 판정을 보류합니다.',
};

// 보류 시 영양소·열량에 붙는 basis 표기. 사유별로 다르다.
// ★ basis_unknown 에 'per_total' 을 붙이면 **모르는 것을 총량이라고 단정**하는 것이 된다.
//   formatResult 가 「총 내용량 기준」이라고 인쇄하고, 그것은 거짓 정보다.
const WITHHOLD_BASIS_LABEL = {
  multi_serving_but_count_unknown: 'per_total',
  racc_says_single_but_pct_dv_says_multi: 'per_total',
  basis_unknown: 'unknown',
};

function buildWithheldResult(result, product, nutrition, resolved, reason) {
  const _reason = reason || 'multi_serving_but_count_unknown';
  const basisLabel = WITHHOLD_BASIS_LABEL[_reason] || 'per_total';
  result.nutrients = {};
  for (const k of WITHHELD_KEYS) {
    result.nutrients[k] = { color: null, pct_dv: null, per_100: null, basis: basisLabel, data: 'withheld' };
  }
  result.calories = (nutrition.calories !== null && nutrition.calories !== undefined)
    ? { amount: nutrition.calories, pct_dv: null, unit: 'kcal', basis: basisLabel }
    : null;

  result.is_withheld = true;
  result.withhold_reason = reason || 'multi_serving_but_count_unknown';
  result.sanity_warnings = [];
  result.context_messages.push(
    WITHHOLD_MESSAGES[result.withhold_reason] || WITHHOLD_MESSAGES.multi_serving_but_count_unknown
  );
  if (resolved && resolved.maxPctDV != null) {
    result.context_messages.push(`라벨의 1일 영양성분 기준치 최대값이 ${resolved.maxPctDV}% 입니다.`);
  }
  return result;
}

// ============================================================
// 6. 메인 판정 함수
// ============================================================

/**
 * 영양 신호등 전체 판정을 수행한다.
 *
 * @param {Object} product - 제품 정보 { product_name, food_type, content_unit, serving_size, total_content, ... }
 * @param {Object} nutrition - 영양성분 { calories, sodium, sugars, sat_fat, total_fat, cholesterol, protein, fiber, trans_fat }
 * @param {Object} [config] - 기준값 (없으면 DEFAULT_CONFIG 사용)
 * @returns {Object} 판정 결과
 */
function evaluateNutrition(product, nutrition, config = DEFAULT_CONFIG, raccPolicy = null) {
  const result = {
    product_name: product.product_name,
    food_category: null,
    is_excluded: false,
    exclude_reason: null,
    is_dried_exception: false,
    nutrients: {},
    calories: null,
    context_messages: [],
    sanity_warnings: [],
    multi_serving: null,
    // ★★ 세션49 — 「어떤 1회량으로 판정했고 그 근거가 무엇인가」를 응답에 싣는다.
    //   세션48 치명B 가 정확히 이것이 없어서 몇 세션을 살아남았다: 라우트가 근거 없이
    //   `|| 100` 을 채워 넣었고, 100 은 언제나 `0.5×RACC` 보다 커서 RACC 1회량이
    //   **한 번도 쓰이지 않았다.** 값만 흐르고 출처가 안 흐르면 그 사실이 보이지 않는다.
    serving_basis: null,
    // 정책 버전 — 신호등 규칙이 바뀌었는데 클라이언트·평가셋이 눈치채지 못하는 것을 막는다.
    traffic_light_policy_version: TRAFFIC_LIGHT_POLICY_VERSION,
  };

  // ----------------------------------------------------------
  // Step 0: 스코프 필터 — 평가 대상 여부 확인
  // ----------------------------------------------------------
  const category = detectFoodCategory(product);
  result.food_category = category;

  const excludedCategories = ['alcohol', 'supplement', 'raw_ingredient'];
  if (excludedCategories.includes(category)) {
    result.is_excluded = true;
    result.exclude_reason = category;
    return result;
  }

  // ----------------------------------------------------------
  // Step 1: 식품 유형 분류 + 기준 선택
  // ----------------------------------------------------------
  const isBeverage = category === 'beverage';
  const isDried = category === 'dried';
  const absoluteBasis = isBeverage ? config.per_100ml : config.per_100g;

  result.is_dried_exception = isDried;

  // ----------------------------------------------------------
  // ★★ 세션42: per_total(총 내용량 기준) 라벨 → 1회분 환산
  // ----------------------------------------------------------
  // 제이 확정 정책(2026-07-29 §3-1): RACC 로 환산. RACC 미매핑이면 총량 = 1회분.
  //
  // ★ 왜 여기서 처리해야 하나 — 이 블록이 없으면 아래 toPerServing 이
  //   per_100* 가 아닌 basis 를 **전부 그대로 1회분으로 통과**시킨다.
  //   캡처 032 떡국떡 실물: 총 500 g / 나트륨 1,530 mg.
  //   그대로 판정 → 77%DV **거짓 빨강**. 실제 1회분(RACC 100 g) 306 mg = 초록.
  //   거짓 초록(세션39)과 방향만 반대일 뿐 같은 등급의 결함이다.
  //
  // ★ 환산 후 basis 를 'per_serving' 으로 바꿔 흘려보낸다.
  //   아래 판정 로직은 1회분 기준으로 이미 정확하다. 분기를 늘리지 않는 것이 안전하다.
  //
  // ★ safe=false = **판정 보류**. 017 골든카레(220 g / 나트륨 458%)가 여기 걸린다.
  //   인분 수를 모르는데 1로 나누면 458% 초강력 빨강이 나간다. 12인분이므로 실제는 38%.
  //   "모르면 회색" 이 정답이다 — `null = 판정 없음 ≠ 안전` 도크트린.
  const rawBasis = nutrition.basis || 'per_serving';

  // ★★ 세션45 안① — basis 를 명시적으로 읽지 못한 라벨(`unknown`)은 판정 보류.
  //   ★ `'unknown'` 만 걸러야 한다. `'per_100_unknown'` 은 **값이 per-100 인 것은 확실하고
  //     단위(g/mL)만 모르는** 상태이며 아래에서 %DV 만으로 정상 판정한다. 함께 막으면 퇴행이다.
  //   ★ basis 가 아예 없는 경우(null/undefined)는 종전대로 per_serving 이다.
  //     DB 상품 레코드는 basis 컬럼이 없고 1회분 의미로 저장돼 있다. 여기를 건드리면 전수 보류가 된다.
  if (rawBasis === 'unknown') {
    return buildWithheldResult(result, product, nutrition, null, 'basis_unknown');
  }

  if (rawBasis === 'per_total') {
    const resolved = nutrition._resolved || servingResolver.resolveServings({
      text: nutrition._label_text || '',
      basis: rawBasis,
      totalContent: product.total_content ?? nutrition._totalContent ?? null,
      contentUnit: product.content_unit ?? null,
      servingSize: product.serving_size ?? null,
      foodType: product.food_type ?? null,
    });
    const div = servingResolver.totalToServingDivisor(resolved);

    result.per_total = {
      divisor: div.divisor,
      reason: div.reason,
      safe: div.safe,
      servings: resolved.servings ?? null,
      tier: resolved.tier ?? null,
      source: resolved.source ?? null,
      needs_lookup: !!resolved.needsLookup,
      lookup_reasons: resolved.lookupReasons || [],
    };

    if (!div.safe) {
      return buildWithheldResult(result, product, nutrition, resolved, div.reason);
    }

    const totalAmt = product.total_content ?? nutrition._totalContent ?? null;
    if (div.divisor > 1) {
      nutrition = scaleNutrition(nutrition, div.divisor);
      product = {
        ...product,
        serving_size: totalAmt ? Math.round((totalAmt / div.divisor) * 100) / 100
                               : (resolved.servingSize ?? product.serving_size),
      };
    } else if (!product.serving_size && totalAmt) {
      // 총량 = 1회분으로 확정된 경우. serving_size 가 비면 아래에서 100 으로 잘못 잡힌다.
      product = { ...product, serving_size: totalAmt };
    }
    nutrition = { ...nutrition, basis: 'per_serving' };
  }

  // ----------------------------------------------------------
  // Sanity Check (건조식품은 per_100g 면제 — 신호등과 일관)
  // ----------------------------------------------------------
  const basis = nutrition.basis || 'per_serving';
  // per_100_unknown: 값은 per-100(이중변환 방지 위해 isPer100 취급), 단 단위불명이라 절대량 컷오프는 스킵.
  const isPer100 = basis === 'per_100g' || basis === 'per_100ml' || basis === 'per_100_unknown';
  // ★★★ 세션49 — 치명B 의 착지점. 값과 **출처**를 함께 정한다.
  //   규칙 자체는 종전과 같다(라벨값이 0.5×RACC 이상이면 라벨 우선 — raccPolicy.resolveServing 과 같은 규칙).
  //   달라진 것은 ① 호출부가 더 이상 `|| 100` 으로 가짜 값을 채워 보내지 않는다는 것과
  //   ② 여기서 고른 근거가 응답에 남는다는 것이다.
  //   ⚠ 마지막 100 은 「1회 제공량 표기가 없을 때 100g 기준으로 본다」는 **명시된 관례**이고,
  //     그래서 source 를 'default_100' 으로 이름 붙여 라벨값('label')과 구분한다.
  //     이것을 다른 상수로 바꾸지 말 것 — 근거 없는 값을 넣는 순간 치명B 가 재발한다.
  const _labelServing = (typeof product.serving_size === 'number' && product.serving_size > 0)
    ? product.serving_size : null;
  let _serving;
  let _servingSource;
  if (raccPolicy && raccPolicy.racc > 0) {
    if (_labelServing !== null && _labelServing >= 0.5 * raccPolicy.racc) {
      _serving = _labelServing; _servingSource = 'label';
    } else {
      _serving = raccPolicy.racc; _servingSource = 'racc';
    }
  } else if (_labelServing !== null) {
    _serving = _labelServing; _servingSource = 'label';
  } else {
    _serving = 100; _servingSource = 'default_100';
  }
  result.serving_basis = {
    serving: _serving,
    source: _servingSource,                       // 'label' | 'racc' | 'default_100'
    label_serving: _labelServing,                 // 라벨에서 읽은 값(없으면 null — 0 이나 100 이 아니다)
    racc: raccPolicy ? (raccPolicy.racc ?? null) : null,
    racc_unit: raccPolicy ? (raccPolicy.unit ?? null) : null,
    racc_matched_key: raccPolicy ? (raccPolicy.matchedKey ?? null) : null,
    racc_match_level: raccPolicy ? (raccPolicy.matchLevel ?? null) : null,
    racc_ambiguous_with: raccPolicy ? (raccPolicy.ambiguousWith ?? null) : null,
  };
  const toPerServing = (amt) => (amt === null || amt === undefined) ? amt : (isPer100 ? (amt * _serving) / 100 : amt);
  const toPer100 = (amt) => (amt === null || amt === undefined) ? null : (isPer100 ? amt : calcPer100(amt, _serving));

  result.sanity_warnings = sanityCheck(nutrition, product.serving_size, isDried, basis);

  // ----------------------------------------------------------
  // Step 2-4: 각 영양성분별 판정
  // ----------------------------------------------------------
  const servingSize = _serving;
  const dv = config.dv;

  // --- 제한 영양성분 (Negative) ---
  const negativeNutrients = ['sodium', 'sugars', 'sat_fat', 'total_fat', 'cholesterol'];

  for (const nutrient of negativeNutrients) {
    const amount = nutrition[nutrient];

    if (amount === null || amount === undefined) {
      result.nutrients[nutrient] = { color: null, pct_dv: null, per_100: null, basis: null, data: 'missing' };
      continue;
    }

    // basis-aware %DV
    const pctDV = calcPctDV(toPerServing(amount), dv[nutrient]);
    const colorA = judgeNegativeByPctDV(pctDV, config.negative_pct_dv[nutrient]);

    // 기준 B: 100g/100mL 절대량 (콜레스테롤은 제외)
    let per100 = null;
    let colorB = null;
    let finalBasis = 'pct_dv';

    const hasAbsoluteThreshold = nutrient !== 'cholesterol' && absoluteBasis[nutrient];

    // per_100_unknown: 단위(g/mL) 불명 → 절대량 컷오프 스킵, %DV 만으로 판정(#2 reconcile §7)
    if (hasAbsoluteThreshold && !isDried && basis !== 'per_100_unknown') {
      per100 = toPer100(amount);
      colorB = judgeByAbsolute(per100, absoluteBasis[nutrient]);
    }

    // Step 3: RACC 정책(소량섭취 면제 + 농축가드) 우선, 아니면 이중기준 worse-of
    const _guards = (raccPolicy && raccPolicy.guards) ? raccPolicy.guards : [];
    const _exempt = !!(raccPolicy && raccPolicy.exempt);
    let finalColor;
    if (_exempt && nutrient === 'sodium' && _guards.indexOf('sodium') !== -1) {
      finalColor = (pctDV !== null && pctDV >= 20) ? 'red' : 'yellow';   // 나트륨 농축가드: floor Y, >=20% R
      finalBasis = 'racc_sodium_guard';
    } else if (_exempt && nutrient === 'sugars' && _guards.indexOf('sugar') !== -1) {
      finalColor = (pctDV !== null && pctDV >= 20) ? 'red' : 'yellow';   // 당류 농축가드: floor Y, >=20% R
      finalBasis = 'racc_sugar_guard';
    } else if (_exempt && (nutrient === 'total_fat' || nutrient === 'sat_fat') && _guards.indexOf('oil') !== -1) {
      finalColor = worseColor(colorA, 'yellow');                          // 유지 가드: 지방 Green 금지(floor Y)
      finalBasis = 'racc_oil_guard';
    } else if (_exempt) {
      finalColor = colorA;                                                // 소량섭취 면제: per-100g 끄고 %DV(RACC)만
      finalBasis = 'pct_dv_racc';
    } else if (colorB !== null) {
      finalColor = worseColor(colorA, colorB);
      const orderMap = { green: 0, yellow: 1, red: 2 };
      finalBasis = (orderMap[colorB] || 0) > (orderMap[colorA] || 0) ? (isBeverage ? 'per_100ml' : 'per_100g') : 'pct_dv';
    } else {
      finalColor = colorA;
      finalBasis = 'pct_dv';
    }

    result.nutrients[nutrient] = {
      color: finalColor,
      pct_dv: pctDV !== null ? Math.round(pctDV * 10) / 10 : null,
      per_100: per100 !== null ? Math.round(per100 * 100) / 100 : null,
      basis: finalBasis,
      data: 'present',
    };
  }

  // --- 권장 영양성분 (Positive) ---
  const positiveNutrients = ['protein', 'fiber'];

  for (const nutrient of positiveNutrients) {
    const amount = nutrition[nutrient];

    if (amount === null || amount === undefined) {
      result.nutrients[nutrient] = { color: null, pct_dv: null, basis: null, data: 'missing' };
      continue;
    }

    const pctDV = calcPctDV(toPerServing(amount), dv[nutrient]);
    const color = judgePositive(pctDV, config.positive_pct_dv[nutrient]);

    result.nutrients[nutrient] = {
      color,
      pct_dv: pctDV !== null ? Math.round(pctDV * 10) / 10 : null,
      basis: 'pct_dv',
      data: 'present',
    };
  }

  // --- 트랜스지방 (별도 규칙) ---
  const transFatAmount = nutrition.trans_fat;
  if (transFatAmount !== null && transFatAmount !== undefined) {
    const tfColor = judgeTransFat(toPerServing(transFatAmount), config.trans_fat);
    result.nutrients.trans_fat = {
      color: tfColor,
      amount: transFatAmount,
      basis: 'absolute',
      data: 'present',
      // 0g 투명성 툴팁
      tooltip: transFatAmount === 0
        ? '식약처 규정에 따라 0.2g 미만은 0g으로 표시될 수 있습니다.'
        : null,
    };
  } else {
    result.nutrients.trans_fat = { color: null, amount: null, basis: null, data: 'missing' };
  }

  // --- 열량 (색상 판정 없음) ---
  if (nutrition.calories !== null && nutrition.calories !== undefined) {
    const calPctDV = calcPctDV(toPerServing(nutrition.calories), dv.calories);
    result.calories = {
      amount: nutrition.calories,
      pct_dv: calPctDV !== null ? Math.round(calPctDV * 10) / 10 : null,
      unit: 'kcal',
    };
  }

  // ----------------------------------------------------------
  // 다회 제공량 처리
  // ----------------------------------------------------------
  if (product.serving_size && product.total_content && product.total_content > product.serving_size) {
    const servingsCount = Math.round((product.total_content / product.serving_size) * 10) / 10;
    if (servingsCount > 1) {
      result.multi_serving = {
        servings_per_container: servingsCount,
        message: `이 제품은 ${servingsCount}회분입니다. 전량 섭취 시 수치가 ${servingsCount}배가 됩니다.`,
      };
    }
  }

  // ----------------------------------------------------------
  // 맥락 안내 메시지
  // ----------------------------------------------------------
  if (isDried) {
    result.context_messages.push('건조식품으로 100g당 수치가 높게 표시됩니다. 1회 제공량 기준으로 판정하였습니다.');
  }
  if (category === 'fermented') {
    result.context_messages.push('발효식품은 나트륨이 높으나, 유산균·식이섬유 등 건강 유익 성분이 함께 포함되어 있습니다.');
  }
  if (category === 'nuts') {
    result.context_messages.push('지방 함량이 높지만, 불포화지방산이 풍부한 건강한 지방입니다.');
  }

  return result;
}

// ============================================================
// 7. 결과 포맷터 (CLI 출력용)
// ============================================================

function formatResult(result) {
  if (result.is_excluded) {
    const reasons = {
      alcohol: '주류는 영양 신호등 평가 대상이 아닙니다.',
      supplement: '건강기능식품은 별도 기준이 적용됩니다.',
      raw_ingredient: '원료 식품은 영양성분표가 부착되지 않는 미가공 제품입니다.',
    };
    return `⛔ ${result.product_name}: ${reasons[result.exclude_reason] || '평가 대상 외'}`;
  }

  const colorEmoji = { green: '🟢', yellow: '🟡', red: '🔴', gray: '⚪' };
  const lines = [];

  lines.push(`┌─── ${result.product_name} ───`);
  lines.push(`│  카테고리: ${result.food_category}${result.is_dried_exception ? ' (건조식품 예외 적용)' : ''}`);
  lines.push('│');

  // 열량
  // ★ 세션43: 판정 보류일 때 pct_dv 가 null 이라 `null%` 이 출력되고 있었다.
  //   그리고 그 값은 **총량**인데 1회분처럼 보였다 — 숫자 자체가 오해를 만든다.
  if (result.calories) {
    const c = result.calories;
    const dvPart = (c.pct_dv !== null && c.pct_dv !== undefined) ? `   ${c.pct_dv}%` : '';
    const basisPart = c.basis === 'per_total' ? '  [총 내용량 기준]' : '';
    lines.push(`│  열량      ${c.amount}kcal${dvPart}${basisPart}`);
  }

  // 영양소 신호등
  const nutrientNames = {
    sodium: '나트륨', sugars: '당류', sat_fat: '포화지방', total_fat: '지방',
    cholesterol: '콜레스테롤', protein: '단백질', fiber: '식이섬유', trans_fat: '트랜스지방',
  };

  for (const [key, name] of Object.entries(nutrientNames)) {
    const n = result.nutrients[key];
    if (!n || n.data === 'missing') {
      lines.push(`│  ${name.padEnd(6, '　')}  데이터 없음`);
      continue;
    }
    // ★ 세션42: 판정 보류는 "데이터 없음" 과 다르다. 값은 있는데 **기준을 몰라서** 안 칠한 것이다.
    //   이 구분이 화면에 드러나야 사용자가 재촬영이라는 행동을 할 수 있다.
    if (n.data === 'withheld') {
      // ★ 세션45: 사유를 하드코딩하면 안 된다. basis_unknown 은 1회 섭취량이 아니라
      //   **기준 표기 자체**를 못 읽은 것이다. 잘못된 사유를 인쇄하면 사용자가 잘못된 행동(재촬영 각도)을 한다.
      const why = result.withhold_reason === 'basis_unknown' ? '기준 표기 미확인' : '1회 섭취량 미확인';
      lines.push(`│  ${name.padEnd(6, '　')}  ⚪ 판정 보류 (${why})`);
      continue;
    }
    const emoji = colorEmoji[n.color] || '❓';
    const dvStr = n.pct_dv !== null && n.pct_dv !== undefined ? `${n.pct_dv}%` : '';
    const per100Str = n.per_100 !== null && n.per_100 !== undefined ? ` (100g: ${n.per_100})` : '';
    lines.push(`│  ${name.padEnd(6, '　')}  ${emoji} ${dvStr}${per100Str}  [${n.basis}]`);

    if (n.tooltip) {
      lines.push(`│    ⓘ ${n.tooltip}`);
    }
  }

  // 다회 제공량
  if (result.multi_serving) {
    lines.push('│');
    lines.push(`│  ⚠️ ${result.multi_serving.message}`);
  }

  // 맥락 메시지
  if (result.context_messages.length > 0) {
    lines.push('│');
    for (const msg of result.context_messages) {
      lines.push(`│  💬 ${msg}`);
    }
  }

  // Sanity 경고
  if (result.sanity_warnings.length > 0) {
    lines.push('│');
    for (const w of result.sanity_warnings) {
      lines.push(`│  ⚠️ Sanity: ${w.nutrient} ${w.type} (값: ${w.value}, 상한: ${w.limit})`);
    }
  }

  lines.push('└───────────────────────');
  return lines.join('\n');
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  DEFAULT_CONFIG,
  loadConfig,
  detectFoodCategory,
  calcPctDV,
  calcPer100,
  deriveBasis,
  evaluateNutrition,
  // ⚠ 세션50 D2 — sanityCheck 는 **엔진 전용**이다. 단위 테스트만 부른다.
  //   라우터·서비스는 `evaluateNutrition(...).sanity_warnings` 를 받아 쓸 것(같은 배열 참조).
  //   여기를 다시 부르면 한 응답에 sanity 가 두 번 실려 값이 갈리는 D2 가 재발한다.
  sanityCheck,
  formatResult,
  scaleNutrition,   // 세션42: per_total → 1회분 환산 (crowdsourceService 공용)
  // 세션43: 클라이언트가 같은 사유 집합을 다루는지 테스트로 고정하기 위해 노출한다.
  // 서버에만 사유가 추가되고 클라이언트가 모르면 배너가 기본 문구로 조용히 퇴화한다.
  WITHHOLD_MESSAGES,
};
