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
const { evaluateNutrition, deriveBasis } = require('./nutritionTrafficLight');
const { getRaccPolicy } = require('./raccPolicy');
const { NotFoundError } = require('../middleware/errorHandler');
const { getContext } = require('../utils/foodCategory');
const logger = require('../config/logger');   // 세션45: 알레르기 조회 실패를 삼키지 않고 남긴다
const { flattenAllergensV2 } = require('./ocrParser');   // 세션45: flat 규칙 단일화(중대4)

// 4색 우선순위 — 가장 위험한 색이 dominant_color
const COLOR_RANK = { red: 4, orange: 3, yellow: 2, green: 1, gray: 0 };

// 첨가물 description 안의 영어 enum 토큰 → 한글 매핑
// DB의 additives.description 은 "분류: 유지 | 규제: approved_with_limits | 유전독성: negative | 데이터: extensive"
// 형태로 저장되어 있어 사용자에게 그대로 노출되지 않도록 enum 값만 한글로 치환한다.
const ENUM_TO_KOREAN = {
  // regulatory_status
  universally_approved: '전세계 승인',
  korea_approved: '국내 승인',
  approved_with_limits: '제한 승인',
  approved: '승인',
  banned: '금지',
  withdrawn: '철회',
  restricted: '제한',
  not_acceptable: '불가',
  // genotox_status
  negative: '음성',
  equivocal: '의심',
  positive_invitro: '양성(시험관)',
  positive_invivo: '양성(생체)',
  positive: '양성',
  // data_sufficiency
  extensive: '충분',
  adequate: '양호',
  moderate: '보통',
  limited: '제한적',
  insufficient: '부족',
  none: '없음',
  // adi_type
  not_specified: '미지정',
  numerical: '수치',
  numeric: '수치',
  not_established: '미설정',
  group: '그룹',
};

/**
 * description 텍스트 안의 영어 enum 토큰을 한글로 치환
 * 예: "규제: approved_with_limits | 유전독성: negative" → "규제: 제한 승인 | 유전독성: 음성"
 */
function humanizeAdditiveDescription(text) {
  if (!text || typeof text !== 'string') return text;
  // 단어 경계로 매칭 (한글·하이픈 등은 그대로 두고 snake_case enum만 치환)
  return text.replace(/\b([a-z][a-z_]+)\b/g, (m) => ENUM_TO_KOREAN[m] || m);
}

/**
 * 첨가물 row 배열 → MFRAS 응답 객체
 * 스펙: docs/API_SPEC_MFRAS.md §2.1
 *
 * @param {Array} additivesRows - productModel.getAdditives() 결과
 * @returns {Object|null} mfras — 첨가물이 0개면 null 반환 (Flutter graceful fallback)
 */
function buildMfras(additivesRows) {
  if (!additivesRows || additivesRows.length === 0) return null;

  // dominant_color 산출 — v2 mfras_grade 우선, v1 risk_color fallback
  let dominant = 'green';
  for (const row of additivesRows) {
    const rowColor = row.mfras_grade || row.risk_color || 'green';
    if ((COLOR_RANK[rowColor] || 0) > (COLOR_RANK[dominant] || 0)) {
      dominant = rowColor;
    }
  }

  // 종합 점수 — v2 mfras_total 가중 평균 (max 사용 — dominant 첨가물 기준)
  // 향후 가중 평균·HI 산출 로직 도입 가능. 현 시점은 max 가 가장 직관적.
  let aggregateScore = null;
  const scoresV2 = additivesRows.map(a => a.mfras_total).filter(s => s !== null && s !== undefined);
  if (scoresV2.length > 0) {
    aggregateScore = Math.max(...scoresV2.map(s => parseFloat(s)));
    aggregateScore = Math.round(aggregateScore * 100) / 100;
  }

  // 색상별 라벨 (Flutter 측 mfrasLabel 헬퍼와 일치)
  const SCORE_LABEL = { green: '안전', yellow: '허용', orange: '주의', red: '위해' };

  return {
    dominant_color: dominant,
    score: aggregateScore,              // v2: 0~10 (max of mfras_total)
    score_label: SCORE_LABEL[dominant] || null,
    cocktail_hi: null,                  // TODO: HI 산출 도입 시 채움
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
      ins_no: a.ins_no || a.e_number,    // v2 ins_no 우선, e_number fallback
      e_number: a.e_number,
      cas_number: null,
      function: a.category,
      // v2 색상·점수 우선
      color: a.mfras_grade || a.risk_color || 'gray',
      score: a.mfras_total !== null && a.mfras_total !== undefined
        ? parseFloat(a.mfras_total)
        : a.risk_grade,
      // v2 5차원 점수 (null 인 경우 객체 자체를 null 로)
      dimensions: a.dim_a_toxicity !== null && a.dim_a_toxicity !== undefined ? {
        a_toxicity: parseFloat(a.dim_a_toxicity),
        b_exposure: parseFloat(a.dim_b_exposure),
        c_genotox: parseFloat(a.dim_c_genotox),
        d_regulation: parseFloat(a.dim_d_regulation),
        e_data_quality: parseFloat(a.dim_e_data_quality),
      } : null,
      // v2 근거·메타
      iarc_group: a.iarc_group || null,
      adi_value: a.adi_value || null,
      adi_type: a.adi_type || null,
      edi: a.edi || null,
      genotox_status: a.genotox_status || null,
      regulatory_status: a.regulatory_status || null,
      last_eval_year: a.last_eval_year || null,
      purposes: a.purposes || null,
      usage_type: a.usage_type || null,
      rationales: a.mfras_rationales || null,
      // v1 호환
      v1_risk_grade: a.risk_grade,
      v1_risk_color: a.risk_color,
      order_in_product: null,
      order_weight: null,
      summary: humanizeAdditiveDescription(a.description),
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
        basis: deriveBasis(product.nutrition_serving_size),
      },
      undefined,
      getRaccPolicy(product.food_type)
    );
  }

  // 첨가물 조회 → MFRAS (병렬 처리하지 않고 순차 — DB pool 압박 회피)
  const additivesRows = await productModel.getAdditives(product.product_id);
  const mfras = buildMfras(additivesRows);

  // ★★ 세션45: 알레르기 조회 (같은 이유로 순차)
  //   이 응답에는 알레르기가 **아예 없었다** — 세션44 §6-2 가 「구분이 없다」고 본 것보다 심하다.
  //
  // ★★★ 1차 검증 치명1 — 두 겹으로 막는다.
  //   productModel 이 컬럼 부재를 견디지만(1겹), 그 밖의 이유(테이블 자체 부재·권한·풀 고갈)로도
  //   실패할 수 있다. 그때 예외가 그대로 올라가면 **영양·신호등까지 통째로 500** 이 된다.
  //   알레르기를 못 읽은 것과 제품 정보를 못 주는 것은 심각도가 다르다.
  //   ★ 실패 시 `null` 이다. 빈 배열이 아니다 — 아래 buildAllergens 주석의 이유와 같다.
  //
  // ★★★ 세션54 A2 — 「정규화가 버린 행 수」를 함께 받는다.
  //   `getAllergens` 는 19종에 못 붙는 이름을 응답 직전에 버린다(세션47). 버린 사실을 모르면
  //   아래 `allergens_flat_complete` 가 「flat 이 전부다」를 그대로 단정한다.
  //   ⚠ `buildAllergens` 의 반환 형태 `{flat, v2, collected}` 는 **바꾸지 않았다.**
  //     회귀가 그 키 집합을 정확히 고정하고 있고(tests/test_allergen_name_normalize.js §6),
  //     소실 수는 `buildAllergens` 가 받는 행에는 이미 남아 있지 않아서
  //     그 함수 안에서는 셀 수 없다(정규화는 model 단계에서 끝난다).
  let allergens = null;
  const allergenStats = { dropped: 0 };
  try {
    allergens = buildAllergens(await productModel.getAllergens(product.product_id, allergenStats));
  } catch (e) {
    logger.error('알레르기 조회 실패 — 응답에서 알레르기를 생략한다(500 대신)', {
      barcode, productId: product.product_id, error: e.message,
    });
    allergens = null;
  }

  // 카테고리 맥락
  // ★★ 세션50 D2 — 신호등 결과를 **함께 넘긴다.** getContext 가 건조·제외 여부를 두 번째로
  //   판정하던 것을 끊었다. 종전에는 같은 응답이 traffic_light.is_dried_exception=true 와
  //   context.is_dried_exception=false 를 동시에 실어 나갔다(조미김·김자반 실측).
  //   trafficLight 가 null(영양정보 없음)이면 그 3키는 false 가 아니라 **null**(=판정 없음)이다.
  const context = getContext(product.food_type, trafficLight);

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
      // OFF(#2) 출처배지(§11)용 메타데이터. 식약처/OCR 이면 NULL.
      //   source='openfoodfacts'(+confidence='low', source_license='ODbL-1.0') → '오픈DB 참고 ⓘ' + 하단 ODbL attribution.
      //   off_grade A/B, basis_confident=false 면 '기준 불확실'(절대량 신호등 제한) 표기에 사용.
      off_grade: product.off_grade || null,
      confidence: product.confidence || null,
      source_license: product.source_license || null,
      basis_confident: (product.basis_confident === undefined ? null : product.basis_confident),
    } : null,
    traffic_light: trafficLight,
    mfras,
    // ★ 세션45 — OCR 경로(`analysis.allergens_v2`)와 **같은 키 이름·같은 3분리 형태**로 낸다.
    //   이름을 다르게 하면 클라이언트가 경로별 분기를 두게 되고, 그 분기 중 한쪽이
    //   다음 수정에서 빠진다(세션39 /multi-photo · 세션44 치명B 가 정확히 그 사고였다).
    // ★★ 1차 검증 중대5 — 「알레르기 정보 없음」과 「알레르기 없음」을 구분한다.
    //   같은 응답의 영양은 이미 `product.calories !== null ? {...} : null` 로 그 구분을 한다.
    //   알레르기만 빈 배열이면, 행이 하나도 없는 제품(현 DB 의 대다수)이
    //   **「알레르기 없음」으로 단정**돼 나간다 — `null = 판정 없음 ≠ 안전` 위배다.
    //   그리고 세션45 이전엔 이 키가 아예 없었으므로, `'allergens' in data` 로 판단하던
    //   클라이언트는 배포 순간 전 제품이 「없음」으로 뒤집힌다.
    //
    // ★★★ 세션46 배포 검증에서 잡힌 것 — **주석은 맞았는데 구현이 그 말을 안 지켰다.**
    //   세션45 판은 `allergens_available: !!allergens` 였다. 이것은 「쿼리가 성공했는가」일 뿐
    //   「이 제품의 알레르기 정보를 갖고 있는가」가 아니다.
    //   실측(배포 직후 8801043032155 짜왕 = 유탕면):
    //     allergens: []  allergens_v2: {전부 빈 배열}  allergens_available: **true**
    //   밀이 든 라면이 「알레르기 정보 있음 + 없음」으로 나갔다. **과소경고**다.
    //   현 DB 는 product_allergens 5,470행 / products 229,028건 — 대다수가 이 상태다.
    //   → 미수집(`collected === false`)도 조회 실패와 **똑같이 null** 로 낸다.
    //     세 키가 한 방향을 가리켜야 클라이언트가 헷갈리지 않는다: `null = 판정 없음 ≠ 안전`.
    //   ★ 구버전 앱 호환 — 세션45 이전에는 이 키가 아예 없었다(`undefined`).
    //     `null` 은 `undefined` 와 똑같이 falsy 라 `data.allergens || []` 패턴이 그대로 동작한다.
    //     반면 `[]` 는 "확인했고 없다" 로 읽힌다. 그래서 빈 배열이 아니라 null 이다.
    allergens: allergens && allergens.collected ? allergens.flat : null,
    allergens_v2: allergens && allergens.collected ? allergens.v2 : null,
    // 화면이 "정보 없음" 과 "없음" 을 분기할 수 있는 명시 신호. 배열 길이로 추론하게 두지 않는다.
    allergens_available: !!(allergens && allergens.collected),
    // ★★★ 세션47 3차 검증 중대1 — §3-7 이 고친 것은 **절반**이었다.
    //   0행(미수집)은 null 로 냈지만, **행은 있는데 전부 `may_contain`** 인 제품은
    //   flat 규칙상 혼입이 빠지므로 `allergens: []` + `allergens_available: true` 가 된다.
    //   = 짜왕 사고와 **문자 그대로 같은 응답**이 다른 입력 클래스에서 재현된다(과소경고).
    //   실측: 전사 68건 중 **8건(12%)** 이 「혼입만 있는 제품」이다.
    //   ★ flat 에 혼입을 넣는 것은 세션44·45 가 옳게 거부했다(구버전이 붉게 표시한다).
    //     그러므로 넣지 않고 **「flat 이 전부인가」를 명시 신호로 낸다.**
    //   앱 계약: `allergens_available === true && allergens.length === 0` 이라도
    //     `allergens_flat_complete === false` 면 **「알레르기 없음」이라고 말하면 안 된다.**
    //     그 경우 allergens_v2.mayContain 을 읽어 「혼입 가능」으로 표시할 것.
    //
    // ★★★ 세션54 A1 — 미수집일 때 `true` 가 아니라 **null** 을 낸다.
    //   고치기 전 식은 `!(collected) || mayContain.length === 0` 이었다.
    //   `collected === false`(0행·이름 전멸·정규화 전멸·조회 실패)일 때 왼쪽 항이 참이라
    //   **「flat 이 전부다」를 무조건 true 로 단정**했다. 읽은 것이 하나도 없는데
    //   「flat 밖에 남은 경고가 없다」고 주장하는 것이라 근거가 아예 없다.
    //   클라이언트가 이 값을 믿고 「알레르기 없음」을 쓰면 과소경고다.
    //   → 바로 위 `allergens` · `allergens_v2` 가 미수집일 때 null 을 내는 것과
    //     **같은 방향**으로 맞춘다. 세 키가 한 방향을 가리켜야 클라이언트가 헷갈리지 않는다.
    //   ★ 구버전 앱 호환 — `null` 은 `undefined` 와 똑같이 falsy 다.
    //     세션45 이전 이 키가 없던 시절의 `if (data.allergens_flat_complete)` 패턴이
    //     그대로 동작한다(둘 다 else 로 간다). `false` 로 내도 falsy 이긴 하지만,
    //     `false` 는 「수집했고 flat 밖에 경고가 있다」는 **다른 사실**을 뜻하므로 쓰지 않는다.
    //
    // ★★★ 세션54 A2 — 수집된 경우의 판정에 **정규화 소실(dropped)** 을 함께 본다.
    //   고치기 전은 `mayContain.length === 0` 만 봤다. 그런데 `productModel.getAllergens` 가
    //   19종에 못 붙는 이름을 응답 직전에 **조용히 버린다**(세션47). 예: '밀' + '카카오매스' 가
    //   저장된 제품은 '밀' 하나만 남고, 그 상태로 `flat_complete: true` 를 냈다.
    //   = 「우리가 읽지 못하고 버린 게 있는데 flat 밖에는 아무것도 없다」는 단정이다.
    //   근거 규모: HACCP 적재 5,649행 중 705행(12.5%)이 19종 정본이 아니다(2026-07-31 실측).
    //   → 버린 것이 하나라도 있으면 `false`(= 「단정하지 말라」)를 낸다.
    //   ★ `false` 는 「알레르겐 없음」이 아니라 「flat 이 전부인지 모른다」는 뜻이다.
    //     클라이언트는 이 값이 false 면 「알레르기 없음」이라고 쓰면 안 된다.
    allergens_flat_complete: !(allergens && allergens.collected)
      ? null
      : (allergens.v2.mayContain.length === 0 && allergenStats.dropped === 0),
    context,
    sources: buildSources(trafficLight),
    data_freshness: buildFreshness(product),
  };
}

/**
 * product_allergens 행 → OCR 경로와 동일한 3분리 형태.
 *
 * ★ flat 을 함께 내는 이유 — 구버전 앱(APK)이 `allergens` 를 문자열 배열로 읽는다.
 *   flat 을 없애면 배포 순간 구버전에서 알레르기 표시가 사라진다.
 *   ★ 단, flat 에는 **혼입 가능을 넣지 않는다.** 구버전은 등급을 모르므로
 *     혼입을 flat 에 넣으면 「직접 함유」로 붉게 표시된다 = 거짓 경고.
 *     세션44 가 flat 에서 혼입을 제거한 것과 같은 규칙이다.
 *   ★ 원재료 추정(inferred)은 flat 에 포함한다 — 실제로 그 원재료가 들어 있다는 뜻이므로
 *     구버전에서 표시되는 것이 맞다.
 */
function buildAllergens(rows) {
  // ★ 1차 검증 중대5 — rows 가 배열이 아니면(조회 실패) **null 을 돌려준다.**
  //   빈 3분리를 돌려주면 호출부가 "조회했더니 없더라" 와 구별할 수 없다.
  if (!Array.isArray(rows)) return null;

  const v2 = { contains: [], inferred: [], mayContain: [] };

  for (const r of rows) {
    const name = r && typeof r.allergen_name === 'string' ? r.allergen_name.trim() : '';
    if (!name) continue;
    // ★ 알 수 없는 등급은 contains 로 본다(안전 방향).
    //   ⚠ 1차 검증 경미9 정정 — 020 은 `NOT NULL DEFAULT 'contains'` 이므로 **NULL 은 남지 않는다.**
    //     이 방어가 실제로 필요한 경우는 020 미적용 DB 에서 productModel 이 리터럴로 채워 줄 때와,
    //     CHECK 를 우회해 들어온 오타값이다. 둘 다 약하게 만들면 안 되므로 contains 로 본다.
    const level = r.evidence_level || 'contains';
    if (level === 'may_contain') v2.mayContain.push(name);
    else if (level === 'inferred') v2.inferred.push(name);
    else v2.contains.push(name);
  }

  // ★★ 세션45 중대4 — flat 규칙을 **여기서 따로 쓰지 않는다.** ocrParser 의 것을 그대로 부른다.
  //   같은 규칙을 두 곳에 적으면 다음 수정 때 한쪽만 고친다(이 프로젝트가 4세션 연속 겪은 사고).
  //
  // ★★★ 세션46 배포 검증에서 잡힌 것 — `collected` 를 함께 낸다.
  //   `rows.length === 0` 은 「알레르겐이 없다」가 **아니라** 「아직 수집하지 않았다」다.
  //   근거: `product_allergens` 에 INSERT 하는 지점이 저장소에 5곳인데(mergeService 2 ·
  //   19-apply-haccp 3 · 26-apply-haccp-dump 3) **전부 발견된 알레르겐만 넣는다.**
  //   「확인했으나 없음」을 기록하는 행·컬럼·코드가 **존재하지 않는다.**
  //   → 0행은 예외 없이 「미수집」이다. 이것을 「없음」으로 내보내면 과소경고다.
  //
  // ★ 세션47 3차 검증 경미2 — `rows.length` 가 아니라 **유효 이름 개수**다.
  //   위 루프는 빈 이름을 건너뛴다. `rows.length` 를 쓰면 공백 이름 1행짜리 제품이
  //   `collected: true` + 빈 배열 = 「확인했고 알레르겐 없음」으로 나간다(과소경고).
  //   필터로 전부 떨어졌다면 그것은 「없음」이 아니라 「읽지 못했다」다.
  const kept = v2.contains.length + v2.inferred.length + v2.mayContain.length;
  return { flat: flattenAllergensV2(v2, []), v2, collected: kept > 0 };
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

  // 색상 우선순위: v2 mfras_grade > v1 risk_color
  const colorOf = (a) => a.mfras_grade || a.risk_color;

  return {
    product_id: product.product_id,
    product_name: product.product_name,
    additives,
    risk_summary: {
      total: additives.length,
      by_color: {
        green: additives.filter(a => colorOf(a) === 'green').length,
        yellow: additives.filter(a => colorOf(a) === 'yellow').length,
        orange: additives.filter(a => colorOf(a) === 'orange').length,
        red: additives.filter(a => colorOf(a) === 'red').length,
      },
      with_v2_data: additives.filter(a => a.mfras_total !== null && a.mfras_total !== undefined).length,
    },
  };
}

module.exports = {
  getProductWithTrafficLight,
  getProductAdditives,
  // 테스트·재사용용 export
  buildMfras,
  buildAllergens,        // 세션45

  buildSources,
  buildFreshness,
};
