/**
 * test_path_parity.js — 세션48 경로 동등성 회귀 (바코드 조회 ↔ OCR)
 * ==========================================================================
 * ★★★ 이 파일이 왜 있는가 — 4차 검증이 실측한 것
 *
 *   기존 검사는 **소스 문자열 정규식**이었다.
 *     /^\s*allergens_flat_complete:[\s\S]{0,200}mayContain/m   ← 이런 것
 *   그래서 아래 뮤테이션이 **전부 12개 파일 59/0 초록**을 통과했다:
 *     · allergens_flat_complete 를 항상 true 로
 *     · 피연산자 순서 교환 (실제 응답은 TypeError → 전건 500)
 *     · productService 의 getRaccPolicy 인자 통째로 제거
 *   그리고 `tests/` 전체에서 `getProductWithTrafficLight` 를 **호출하는 줄이 0개**,
 *   `judgeNutrition`(OCR 라우터)을 호출하는 테스트도 **0개**였다.
 *
 *   → 이 파일은 **소스 문자열을 한 글자도 읽지 않는다.**
 *     두 경로의 함수를 **실제로 호출해 나온 응답 객체**만 단정한다.
 *
 * ── 무엇을 고정하나 ────────────────────────────────────────────────────────
 *   ① 같은 canonical 제품이 **바코드 경로**와 **OCR 경로**에서 같은 판정을 받는다.
 *      비교 대상: 영양소별 color · basis · pct_dv · per_100,
 *                is_excluded · is_withheld · is_dried_exception · food_category,
 *                sanity_warnings(엔진 것 · 응답에 실리는 것 둘 다),
 *                알레르기 키 집합.
 *   ② 바코드 경로의 판정값 자체(GOLDEN_BAR). 두 경로가 **같은 방향으로 함께 망가지면**
 *      동등성만으로는 못 잡는다. 그래서 절대값도 함께 못 박는다.
 *      (뮤테이션 M3 = getRaccPolicy 인자 제거 는 이 골든이 잡는다.)
 *   ③ **알려진 불일치 목록**(KNOWN_DIFF). 이 목록은 「아직 안 고친 결함」의 대장이다.
 *      · 목록에 없는 새 불일치      → 실패 (회귀)
 *      · 목록에 있는데 이제 일치함  → 실패 (고쳐졌으니 목록에서 빼고 골든을 갱신하라)
 *      · 목록에 있고 값도 그대로    → 「미해결 결함」으로 보고 (기본 실행에서는 EXIT 0)
 *
 * ── 실행 ──────────────────────────────────────────────────────────────────
 *   NODE_ENV=test node tests/test_path_parity.js
 *      → 알려진 불일치는 ⚠ 로 보고하고 EXIT 0 (npm test 를 막지 않는다)
 *   NODE_ENV=test PARITY_STRICT=1 node tests/test_path_parity.js
 *      → 알려진 불일치도 실패로 센다. **결함을 고친 뒤 이 모드가 초록이어야 한다.**
 *   NODE_ENV=test PARITY_DUMP=1 node tests/test_path_parity.js
 *      → 두 경로의 전체 레코드를 JSON 으로 찍는다(골든 갱신·조사용).
 *
 * ⚠ 이 파일은 운영 DB 에 접속하지 않는다. pglite(진짜 Postgres/wasm) 인스턴스 **1개**를
 *   띄워 `scripts/migrations/000_baseline.sql` 정본을 그대로 적용한다.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ══════════════════════════════════════════════════════════════════════════
// 0. 출력 (기존 테스트 파일들과 같은 형식)
// ══════════════════════════════════════════════════════════════════════════
let pass = 0;
let fail = 0;
let expected = 0;                 // 알려진 불일치(미해결 결함)
const failures = [];
const expectedIssues = [];

async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, message: e.message });
    console.log(`  ❌ ${name}\n     → ${e.message}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

function known(fixtureId, field, detail) {
  expected += 1;
  expectedIssues.push({ fixtureId, field, detail });
}

// ══════════════════════════════════════════════════════════════════════════
// 1. 픽스처 — 같은 canonical 제품을 두 경로에 넣는다
// ══════════════════════════════════════════════════════════════════════════
/**
 * ★ serving_size 를 NULL 로 두는 것이 핵심이다.
 *   실제 DB 의 products.serving_size 는 대부분 NULL 이다(식약처 C005 에 1회 제공량이 없다).
 *   바코드 경로는 그 NULL 을 그대로 신호등에 넘겨 RACC 가 1회량을 정하게 두지만,
 *   OCR 라우터는 `nutrition.serving_size || productInfo?.serving_size || 100`(ocrRoutes.js:262·447)
 *   으로 **항상 100 을 채워 넣는다.** RACC 는 4~15 g 이라 `100 >= 0.5*racc` 가 언제나 참이 되어
 *   RACC 1회량이 **전부 덮인다.** 이것이 아래 불일치의 단일 원인이다.
 *
 * ★ basis 는 per_100g/per_100ml 이다. 식약처 C005·수입식품 데이터가 그 형식이고,
 *   `deriveBasis(nutrition_data.serving_size)` 가 '100g'/'100ml' 문자열로 그것을 판정한다.
 */
const FIXTURES = [
  {
    id: 'sesame_oil',
    label: '참기름 (RACC oil 5g · 지방 가드)',
    barcode: 'PARITY0001',
    product_name: '오뚜기 참기름',
    food_type: '참기름',
    content_unit: 'ml',
    total_content: 320,
    serving_size: null,
    nd_serving: '100g',
    nutrition: {
      calories: 900, sodium: 0, total_sugars: 0, saturated_fat: 15, total_fat: 100,
      cholesterol: 0, protein: 0, dietary_fiber: 0, trans_fat: 0,
    },
  },
  {
    id: 'soy_sauce',
    label: '간장 (RACC sodium 5ml)',
    barcode: 'PARITY0002',
    product_name: '샘표 진간장',
    food_type: '간장',
    content_unit: 'ml',
    total_content: 500,
    serving_size: null,
    nd_serving: '100ml',
    nutrition: {
      calories: 60, sodium: 5900, total_sugars: 4, saturated_fat: 0, total_fat: 0,
      cholesterol: 0, protein: 8, dietary_fiber: 0, trans_fat: 0,
    },
  },
  {
    id: 'seasoned_laver',
    label: '조미김 (RACC sodium 4g + 건조식품)',
    barcode: 'PARITY0003',
    product_name: '광천 조미김',
    food_type: '조미김',
    content_unit: 'g',
    total_content: 20,
    serving_size: null,
    nd_serving: '100g',
    nutrition: {
      calories: 550, sodium: 1200, total_sugars: 1, saturated_fat: 4, total_fat: 40,
      cholesterol: 0, protein: 30, dietary_fiber: 30, trans_fat: 0,
    },
  },
  {
    id: 'laver_jaban_outlier',
    label: '김자반 (건조 + 100g당 1,100 kcal 이상치)',
    barcode: 'PARITY0004',
    product_name: '바다 김자반',
    food_type: '김자반',
    content_unit: 'g',
    total_content: 60,
    serving_size: null,
    nd_serving: '100g',
    // ★ 1,100 kcal/100g 은 실물 김자반 값이 아니다. **일부러** sanity 상한(900)을 넘긴다.
    //   sanityCheck 는 바로 이런 이상치를 잡으라고 있는 장치이고,
    //   `isDried` 를 하드코딩 false 로 넘기는 라우터에서만 경고가 뜨는 것을 재현한다.
    nutrition: {
      calories: 1100, sodium: 2500, total_sugars: 10, saturated_fat: 6, total_fat: 60,
      cholesterol: 0, protein: 25, dietary_fiber: 20, trans_fat: 0,
    },
  },
  {
    id: 'beef_jerky_control',
    label: '육포 (건조식품 · RACC 무관) — 대조군 A',
    barcode: 'PARITY0005',
    product_name: '오래장 육포',
    food_type: '육포',
    content_unit: 'g',
    total_content: 40,
    serving_size: null,
    nd_serving: '100g',
    // ★ 대조군 — RACC 가 없으면 바코드 경로도 `serving_size || 100` 로 100 을 쓴다.
    //   즉 두 경로가 **같은 1회량**을 쓰게 되고 전 항목이 일치해야 한다.
    //   여기서 불일치가 나면 원인은 serving_size 가 아니라 **다른 데** 있다는 뜻이다.
    nutrition: {
      calories: 410, sodium: 1600, total_sugars: 20, saturated_fat: 3, total_fat: 8,
      cholesterol: 60, protein: 50, dietary_fiber: 1, trans_fat: 0,
    },
  },
  {
    id: 'snack_control',
    label: '일반 과자 (RACC 무관 · per_100g) — 대조군 B',
    barcode: 'PARITY0006',
    product_name: '오리온 초코파이',
    food_type: '과자',
    content_unit: 'g',
    total_content: 420,
    serving_size: null,
    nd_serving: '100g',
    nutrition: {
      calories: 430, sodium: 250, total_sugars: 33, saturated_fat: 7, total_fat: 13,
      cholesterol: 5, protein: 4, dietary_fiber: 2, trans_fat: 0,
    },
  },
  {
    id: 'per_serving_control',
    label: '일반 과자 (1회 제공량 라벨 · per_serving) — 대조군 C',
    barcode: 'PARITY0007',
    product_name: '크래커 30g',
    food_type: '과자',
    content_unit: 'g',
    total_content: 300,
    serving_size: 30,          // ★ products.serving_size 가 있는 경우
    nd_serving: '30',          // deriveBasis → per_serving
    nutrition: {
      calories: 150, sodium: 180, total_sugars: 5, saturated_fat: 2, total_fat: 6,
      cholesterol: 0, protein: 3, dietary_fiber: 1, trans_fat: 0,
    },
  },
];

// ══════════════════════════════════════════════════════════════════════════
// 2. ★★★ 알려진 불일치 대장 (KNOWN_DIFF)
// ══════════════════════════════════════════════════════════════════════════
/**
 * 키: `<fixtureId>::<필드경로>`
 * 값: { bar, ocr, defect, why }
 *
 * ★ 규칙 (이 세 줄이 이 파일의 전부다)
 *   · 목록에 **없는** 불일치가 나오면 → 실패. 새 회귀다.
 *   · 목록에 **있는데 값이 다르면** → 실패. 결함의 크기가 바뀌었다(부분 수정·부작용).
 *   · 목록에 **있는데 이제 일치하면** → 실패. **고쳐진 것이니 이 줄을 지우고 골든을 갱신하라.**
 *
 * ── 결함 대장 ─────────────────────────────────────────────────────────────
 *   D1  ocrRoutes.js:262·447 `serving_size: nutrition.serving_size || productInfo?.serving_size || 100`
 *       RACC 1회량(4~15 g)을 항상 100 이 덮는다. `100 >= 0.5*racc` 가 언제나 참이기 때문이다.
 *       → 소량식품(기름·장류·조미김)의 색이 OCR 경로에서만 빨강으로 뒤집힌다.
 *       고칠 때: 근거 없는 100 을 넣지 말고 **null 을 넘겨** 신호등이 RACC 로 정하게 둘 것.
 *
 *   D2  ocrRoutes.js:138 `sanityCheck(nutritionData, productData.serving_size, false, basis)`
 *       3번째 인자 `isDried` 가 **하드코딩 false** 다. 엔진은
 *       `detectFoodCategory(product) === 'dried'` 를 넘긴다(nutritionTrafficLight.js:580).
 *       → 같은 김자반이 바코드에선 경고 0건, OCR 응답(data.sanity_warnings)에선 1건.
 *       ★ 더 나쁜 것: OCR 응답은 `traffic_light.sanity_warnings`(엔진)와
 *         `data.sanity_warnings`(라우터)를 **동시에** 실어 자기모순 상태로 나간다.
 *       고칠 때: 라우터가 따로 sanityCheck 를 돌리지 말고 엔진 결과를 그대로 쓸 것.
 *
 *   D3  productService.getProductWithTrafficLight 가 pg NUMERIC 을 **문자열 그대로** 엔진에 넘긴다.
 *       node-postgres 는 NUMERIC 을 정밀도 보존을 위해 string 으로 준다(pglite 도 동일).
 *       그래서 sanityCheck 의 `nutritionData.sat_fat > nutritionData.total_fat` 가
 *       **사전식 비교**가 된다: '7' > '13' → true, '15' > '100' → true.
 *       → 정상 제품에 「포화지방이 총지방을 초과」 경고가 **거짓으로** 붙는다(바코드 경로만).
 *       같은 이유로 mass_balance 검사는 `carbs+protein+fat` 이 **문자열 접합**이 되어
 *       `'60' + '4' + '13' = '60413'` → 숫자 비교가 NaN → **영구히 발동하지 않는다**(조용한 무동작).
 *       ★ 이 결함은 세션48 이 이 테스트를 쓰다가 발견했다. 기존 대장에 없다.
 *       고칠 때: findByBarcode 결과를 신호등에 넘기기 전에 Number() 로 좁힐 것
 *               (또는 pg types.setTypeParser(1700, parseFloat)).
 *
 *   D4  응답 키 집합이 다르다. 바코드 경로는 알레르기 4키를 내는데
 *       OCR 경로는 `allergens` · `allergens_v2` 2키뿐이다
 *       (`allergens_available` · `allergens_flat_complete` 없음).
 *       → 같은 「혼입만 있는 제품」이 OCR 화면에서는 「알레르기 없음」으로 읽힌다(과소경고).
 *       상세 계약은 tests/test_allergen_contract.js 가 본다. 여기서는 **키 집합**만 본다.
 */
const KNOWN_DIFF = {
  // ── D1: RACC × serving_size ────────────────────────────────────────────
  'sesame_oil::nutrients.sat_fat.color': { bar: 'yellow', ocr: 'red', defect: 'D1' },
  'sesame_oil::nutrients.sat_fat.pct_dv': { bar: 5, ocr: 100, defect: 'D1' },
  'sesame_oil::nutrients.total_fat.color': { bar: 'yellow', ocr: 'red', defect: 'D1' },
  'sesame_oil::nutrients.total_fat.pct_dv': { bar: 9.3, ocr: 185.2, defect: 'D1' },
  'soy_sauce::nutrients.sodium.color': { bar: 'yellow', ocr: 'red', defect: 'D1' },
  'soy_sauce::nutrients.sodium.pct_dv': { bar: 14.8, ocr: 295, defect: 'D1' },
  'soy_sauce::nutrients.sugars.pct_dv': { bar: 0.2, ocr: 4, defect: 'D1' },
  'soy_sauce::nutrients.protein.color': { bar: 'gray', ocr: 'yellow', defect: 'D1' },
  'soy_sauce::nutrients.protein.pct_dv': { bar: 0.7, ocr: 14.5, defect: 'D1' },
  'seasoned_laver::nutrients.sodium.color': { bar: 'yellow', ocr: 'red', defect: 'D1' },
  'seasoned_laver::nutrients.sodium.pct_dv': { bar: 2.4, ocr: 60, defect: 'D1' },
  'seasoned_laver::nutrients.sugars.pct_dv': { bar: 0, ocr: 1, defect: 'D1' },
  'seasoned_laver::nutrients.sat_fat.color': { bar: 'green', ocr: 'red', defect: 'D1' },
  'seasoned_laver::nutrients.sat_fat.pct_dv': { bar: 1.1, ocr: 26.7, defect: 'D1' },
  'seasoned_laver::nutrients.total_fat.color': { bar: 'green', ocr: 'red', defect: 'D1' },
  'seasoned_laver::nutrients.total_fat.pct_dv': { bar: 3, ocr: 74.1, defect: 'D1' },
  'seasoned_laver::nutrients.protein.color': { bar: 'gray', ocr: 'green', defect: 'D1' },
  'seasoned_laver::nutrients.protein.pct_dv': { bar: 2.2, ocr: 54.5, defect: 'D1' },
  'seasoned_laver::nutrients.fiber.color': { bar: 'gray', ocr: 'green', defect: 'D1' },
  'seasoned_laver::nutrients.fiber.pct_dv': { bar: 4.8, ocr: 120, defect: 'D1' },
  'laver_jaban_outlier::nutrients.sodium.color': { bar: 'yellow', ocr: 'red', defect: 'D1' },
  'laver_jaban_outlier::nutrients.sodium.pct_dv': { bar: 6.3, ocr: 125, defect: 'D1' },
  'laver_jaban_outlier::nutrients.sugars.pct_dv': { bar: 0.5, ocr: 10, defect: 'D1' },
  'laver_jaban_outlier::nutrients.sat_fat.color': { bar: 'green', ocr: 'red', defect: 'D1' },
  'laver_jaban_outlier::nutrients.sat_fat.pct_dv': { bar: 2, ocr: 40, defect: 'D1' },
  'laver_jaban_outlier::nutrients.total_fat.color': { bar: 'green', ocr: 'red', defect: 'D1' },
  'laver_jaban_outlier::nutrients.total_fat.pct_dv': { bar: 5.6, ocr: 111.1, defect: 'D1' },
  'laver_jaban_outlier::nutrients.protein.color': { bar: 'gray', ocr: 'green', defect: 'D1' },
  'laver_jaban_outlier::nutrients.protein.pct_dv': { bar: 2.3, ocr: 45.5, defect: 'D1' },
  'laver_jaban_outlier::nutrients.fiber.color': { bar: 'gray', ocr: 'green', defect: 'D1' },
  'laver_jaban_outlier::nutrients.fiber.pct_dv': { bar: 4, ocr: 80, defect: 'D1' },
  // ── D2: isDried 하드코딩 false ─────────────────────────────────────────
  'laver_jaban_outlier::exposed_sanity': { bar: '', ocr: 'calories:per_100g_exceeded', defect: 'D2' },
  // ── D3: NUMERIC 문자열 (바코드 경로에만 거짓 경고) ──────────────────────
  'sesame_oil::engine_sanity': { bar: 'sat_fat:exceeds_total_fat', ocr: '', defect: 'D3' },
  'sesame_oil::exposed_sanity': { bar: 'sat_fat:exceeds_total_fat', ocr: '', defect: 'D3' },
  'snack_control::engine_sanity': { bar: 'sat_fat:exceeds_total_fat', ocr: '', defect: 'D3' },
  'snack_control::exposed_sanity': { bar: 'sat_fat:exceeds_total_fat', ocr: '', defect: 'D3' },
};

// ══════════════════════════════════════════════════════════════════════════
// 3. 골든 — 바코드 경로의 절대값
// ══════════════════════════════════════════════════════════════════════════
/**
 * ★ 왜 절대값도 못 박는가 —
 *   두 경로가 **같은 방향으로 함께** 망가지면 동등성 비교는 전부 초록이다.
 *   4차 검증의 뮤테이션 M3(`getRaccPolicy` 인자 제거)이 정확히 그런 형태였다.
 *   아래 골든은 「참기름 포화지방 = 노랑 5%(RACC 5g 기준)」처럼 **정책이 뜻하는 값**이다.
 *   RACC 배선이 끊기면 basis 가 `racc_oil_guard` → `pct_dv` 로 바뀌어 여기서 잡힌다.
 *
 * ⚠ 골든을 고칠 때는 반드시 **정책 문서(IP/racc_policy_v1.md)와 대조**하고 이유를 적을 것.
 *   테스트를 통과시키려고 값을 옮겨 적으면 이 파일은 그 순간 무의미해진다.
 */
const GOLDEN_BAR = {
  // ★ 값의 형식: [color, pct_dv, basis, per_100]
  //   `per_100` 은 **절대량 컷오프를 실제로 계산한 경우에만** 채워진다.
  //   건조식품(면제)·양성 영양소(단백질/식이섬유)·콜레스테롤은 null 이 정상이다.
  sesame_oil: {
    // RACC 5 g 기준. 포화지방 0.75 g = 5%DV → 노랑(oil 가드가 초록을 금지한다).
    food_category: 'general', is_excluded: false, exclude_reason: null,
    is_dried_exception: false, is_withheld: false, withhold_reason: null,
    'nutrients.sodium': ['green', 0, 'pct_dv_racc', 0],
    'nutrients.sugars': ['green', 0, 'pct_dv_racc', 0],
    'nutrients.sat_fat': ['yellow', 5, 'racc_oil_guard', 15],
    'nutrients.total_fat': ['yellow', 9.3, 'racc_oil_guard', 100],
    'nutrients.cholesterol': ['green', 0, 'pct_dv_racc', null],
    'nutrients.protein': ['gray', 0, 'pct_dv', null],
    'nutrients.fiber': ['gray', 0, 'pct_dv', null],
    'nutrients.trans_fat': ['green', null, 'absolute', null],
    // ← D3 (거짓 경고: '15' > '100' 사전식 비교). 고치면 '' 가 된다.
    engine_sanity: 'sat_fat:exceeds_total_fat',
    exposed_sanity: 'sat_fat:exceeds_total_fat',
  },
  soy_sauce: {
    // RACC 5 ml 기준. 나트륨 295 mg = 14.8%DV → 노랑(sodium 가드가 초록을 금지한다).
    // ⚠ food_category 가 'beverage' 인 것은 content_unit='ml' 때문이다(detectFoodCategory 2단계).
    //   간장을 음료로 보는 것은 별개의 논점이지만 **두 경로가 똑같이** 그렇게 보므로 동등성은 성립한다.
    food_category: 'beverage', is_excluded: false, exclude_reason: null,
    is_dried_exception: false, is_withheld: false, withhold_reason: null,
    'nutrients.sodium': ['yellow', 14.8, 'racc_sodium_guard', 5900],
    'nutrients.sugars': ['green', 0.2, 'pct_dv_racc', 4],
    'nutrients.sat_fat': ['green', 0, 'pct_dv_racc', 0],
    'nutrients.total_fat': ['green', 0, 'pct_dv_racc', 0],
    'nutrients.cholesterol': ['green', 0, 'pct_dv_racc', null],
    'nutrients.protein': ['gray', 0.7, 'pct_dv', null],
    'nutrients.fiber': ['gray', 0, 'pct_dv', null],
    'nutrients.trans_fat': ['green', null, 'absolute', null],
    // 100 ml 당 5,900 mg 은 1회 상한(5,000 mg)을 넘는다 — 이 경고는 옳다(두 경로 모두 낸다).
    engine_sanity: 'sodium:per_serving_exceeded',
    exposed_sanity: 'sodium:per_serving_exceeded',
  },
  seasoned_laver: {
    food_category: 'dried', is_excluded: false, exclude_reason: null,
    is_dried_exception: true, is_withheld: false, withhold_reason: null,
    'nutrients.sodium': ['yellow', 2.4, 'racc_sodium_guard', null],
    'nutrients.sugars': ['green', 0, 'pct_dv_racc', null],
    'nutrients.sat_fat': ['green', 1.1, 'pct_dv_racc', null],
    'nutrients.total_fat': ['green', 3, 'pct_dv_racc', null],
    'nutrients.cholesterol': ['green', 0, 'pct_dv_racc', null],
    'nutrients.protein': ['gray', 2.2, 'pct_dv', null],
    'nutrients.fiber': ['gray', 4.8, 'pct_dv', null],
    'nutrients.trans_fat': ['green', null, 'absolute', null],
    engine_sanity: '',
    exposed_sanity: '',
  },
  laver_jaban_outlier: {
    food_category: 'dried', is_excluded: false, exclude_reason: null,
    is_dried_exception: true, is_withheld: false, withhold_reason: null,
    'nutrients.sodium': ['yellow', 6.3, 'racc_sodium_guard', null],
    'nutrients.sugars': ['green', 0.5, 'pct_dv_racc', null],
    'nutrients.sat_fat': ['green', 2, 'pct_dv_racc', null],
    'nutrients.total_fat': ['green', 5.6, 'pct_dv_racc', null],
    'nutrients.cholesterol': ['green', 0, 'pct_dv_racc', null],
    'nutrients.protein': ['gray', 2.3, 'pct_dv', null],
    'nutrients.fiber': ['gray', 4, 'pct_dv', null],
    'nutrients.trans_fat': ['green', null, 'absolute', null],
    // ★ 건조식품이므로 100g당 상한(900 kcal) 검사를 **면제**한다 = 경고 0건이 맞다.
    //   OCR 라우터는 isDried 를 하드코딩 false 로 넘겨 여기서만 경고 1건을 낸다(D2).
    engine_sanity: '',
    exposed_sanity: '',
  },
  beef_jerky_control: {
    food_category: 'dried', is_excluded: false, exclude_reason: null,
    is_dried_exception: true, is_withheld: false, withhold_reason: null,
    'nutrients.sodium': ['red', 80, 'pct_dv', null],
    'nutrients.sugars': ['yellow', 20, 'pct_dv', null],
    'nutrients.sat_fat': ['yellow', 20, 'pct_dv', null],
    'nutrients.total_fat': ['yellow', 14.8, 'pct_dv', null],
    'nutrients.cholesterol': ['yellow', 20, 'pct_dv', null],
    'nutrients.protein': ['green', 90.9, 'pct_dv', null],
    'nutrients.fiber': ['gray', 4, 'pct_dv', null],
    'nutrients.trans_fat': ['green', null, 'absolute', null],
    engine_sanity: '',
    exposed_sanity: '',
  },
  snack_control: {
    food_category: 'general', is_excluded: false, exclude_reason: null,
    is_dried_exception: false, is_withheld: false, withhold_reason: null,
    'nutrients.sodium': ['yellow', 12.5, 'pct_dv', 250],
    'nutrients.sugars': ['red', 33, 'pct_dv', 33],
    'nutrients.sat_fat': ['red', 46.7, 'pct_dv', 7],
    'nutrients.total_fat': ['yellow', 24.1, 'pct_dv', 13],
    'nutrients.cholesterol': ['green', 1.7, 'pct_dv', null],
    'nutrients.protein': ['yellow', 7.3, 'pct_dv', null],
    'nutrients.fiber': ['yellow', 8, 'pct_dv', null],
    'nutrients.trans_fat': ['green', null, 'absolute', null],
    // ← D3 (거짓 경고: '7' > '13' 사전식 비교). 포화지방 7 g < 총지방 13 g 인데 경고가 붙는다.
    engine_sanity: 'sat_fat:exceeds_total_fat',
    exposed_sanity: 'sat_fat:exceeds_total_fat',
  },
  per_serving_control: {
    // ★ 여기서 basis 가 'per_100g' 인 것은 **입력 표기 기준**이 아니라
    //   worse-of 이중기준에서 「100g당 절대량」 쪽이 이겼다는 뜻이다(입력은 per_serving).
    food_category: 'general', is_excluded: false, exclude_reason: null,
    is_dried_exception: false, is_withheld: false, withhold_reason: null,
    'nutrients.sodium': ['yellow', 9, 'per_100g', 600],
    'nutrients.sugars': ['red', 5, 'per_100g', 16.7],
    'nutrients.sat_fat': ['red', 13.3, 'per_100g', 6.7],
    'nutrients.total_fat': ['red', 11.1, 'per_100g', 20],
    'nutrients.cholesterol': ['green', 0, 'pct_dv', null],
    'nutrients.protein': ['yellow', 5.5, 'pct_dv', null],
    'nutrients.fiber': ['gray', 4, 'pct_dv', null],
    'nutrients.trans_fat': ['green', null, 'absolute', null],
    engine_sanity: '',
    exposed_sanity: '',
  },
};

// ══════════════════════════════════════════════════════════════════════════
// 4. 두 경로를 부르는 하네스
// ══════════════════════════════════════════════════════════════════════════
const SRV = path.join(__dirname, '..');
const BASELINE = path.join(SRV, 'scripts', 'migrations', '000_baseline.sql');

const NUTRIENTS = ['sodium', 'sugars', 'sat_fat', 'total_fat', 'cholesterol', 'protein', 'fiber', 'trans_fat'];

function round1(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/** sanity 경고 목록 → 정렬된 문자열(비교·출력용). 값은 부동소수라 넣지 않는다. */
function sanityKeys(list) {
  if (!Array.isArray(list)) return '';
  return list.map((w) => `${w.nutrient}:${w.type}`).sort().join(',');
}

/** 신호등 결과 + 응답에 실제로 실린 sanity → 비교 레코드(평평한 객체) */
function toRecord(tl, exposedSanity) {
  const rec = {
    food_category: tl ? tl.food_category : null,
    is_excluded: !!(tl && tl.is_excluded),
    exclude_reason: (tl && tl.exclude_reason) || null,
    is_dried_exception: !!(tl && tl.is_dried_exception),
    is_withheld: !!(tl && tl.is_withheld),
    withhold_reason: (tl && tl.withhold_reason) || null,
    engine_sanity: sanityKeys(tl && tl.sanity_warnings),
    exposed_sanity: sanityKeys(exposedSanity),
  };
  for (const k of NUTRIENTS) {
    const x = (tl && tl.nutrients && tl.nutrients[k]) || {};
    rec[`nutrients.${k}.color`] = x.color === undefined ? null : x.color;
    rec[`nutrients.${k}.pct_dv`] = round1(x.pct_dv);
    rec[`nutrients.${k}.basis`] = x.basis === undefined ? null : x.basis;
    rec[`nutrients.${k}.per_100`] = round1(x.per_100);
  }
  return rec;
}

/** GOLDEN_BAR 항목 → toRecord 와 같은 평평한 형태 */
function goldenToRecord(g) {
  const rec = {
    food_category: g.food_category,
    is_excluded: g.is_excluded,
    exclude_reason: g.exclude_reason,
    is_dried_exception: g.is_dried_exception,
    is_withheld: g.is_withheld,
    withhold_reason: g.withhold_reason,
    engine_sanity: g.engine_sanity,
    exposed_sanity: g.exposed_sanity,
  };
  for (const k of NUTRIENTS) {
    const [color, pct, basis, per100] = g[`nutrients.${k}`];
    rec[`nutrients.${k}.color`] = color;
    rec[`nutrients.${k}.pct_dv`] = pct;
    rec[`nutrients.${k}.basis`] = basis;
    rec[`nutrients.${k}.per_100`] = per100;
  }
  return rec;
}

async function main() {
  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (_) {
    console.log('⏭  pglite 미설치 — 경로 동등성 검증을 수행할 수 없다 (npm i -D @electric-sql/pglite)');
    console.log('   ★ 이 테스트의 목적상 「건너뜀」은 「통과」가 아니다. EXIT=1 로 남긴다.');
    process.exit(1);
  }

  // ── pglite 인스턴스 1개. 부팅이 이 파일 전체 시간의 대부분이므로 절대 재생성하지 않는다.
  const db = new PGlite();
  try {
    await db.exec(fs.readFileSync(BASELINE, 'utf8'));
  } catch (e) {
    console.error(`000_baseline.sql 적용 실패 — 픽스처가 아니라 정본 SQL 문제다: ${e.message}`);
    process.exit(1);
  }

  // ── src/config/database 를 pglite 로 갈아끼운다(정본 함수를 그대로 호출하기 위함).
  const shim = {
    pool: null,
    query: (text, params) => db.query(text, params || []),
    transaction: async (cb) => {
      await db.exec('BEGIN');
      try {
        const r = await cb({ query: (tx, p) => db.query(tx, p || []) });
        await db.exec('COMMIT');
        return r;
      } catch (e) { await db.exec('ROLLBACK'); throw e; }
    },
    healthCheck: async () => ({ status: 'healthy' }),
  };
  const dbPath = require.resolve('../src/config/database');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };

  // ── Google Vision 을 부르지 않도록 ocrService 를 스텁으로 갈아끼운다.
  //   ★ 파서를 스텁하지 않는다. 라우터가 실제로 하는 일(파싱·병합·판정 배선)을 그대로 통과시킨다.
  let LABEL_TEXT = '';
  const ocrSvcPath = require.resolve('../src/services/ocrService');
  require.cache[ocrSvcPath] = {
    id: ocrSvcPath, filename: ocrSvcPath, loaded: true,
    exports: {
      callVisionAPI: async () => ({
        full_text: LABEL_TEXT, avg_confidence: 0.95, block_count: 3, elapsed_ms: 1,
      }),
      correctOcrText: (txt) => ({ corrected: txt, corrections: [] }),
    },
  };

  const productService = require('../src/services/productService');
  const ocrRoutes = require('../src/routes/ocrRoutes');
  const { getRaccPolicy } = require('../src/services/raccPolicy');

  // ── OCR 경로 호출기 —
  //   ★ `judgeNutrition` 만 부르면 **결함이 있는 줄을 통과하지 않는다.**
  //     `serving_size ... || 100`(D1)과 `sanityCheck(..., false, ...)`(D2)는
  //     judgeNutrition 의 **바깥**(라우터 핸들러 본문)에 있다.
  //     그래서 `/analyze` 핸들러 자체를 부른다. multer 는 multipart 가 아니면 next() 로 지나간다.
  const analyzeLayer = ocrRoutes.stack.find((l) => l.route && l.route.path === '/analyze');

  async function callAnalyze(body) {
    const req = { body, headers: {}, method: 'POST', url: '/analyze' };
    let out = null;
    const res = { json: (o) => { out = o; return res; }, status: () => res, set: () => res };
    for (const s of analyzeLayer.route.stack) {
      await new Promise((resolve, reject) => {
        let done = false;
        const next = (e) => { if (done) return; done = true; e ? reject(e) : resolve(); };
        try {
          const r = s.handle(req, res, next);
          if (r && typeof r.then === 'function') r.then(() => { if (!done) { done = true; resolve(); } }, next);
        } catch (e) { next(e); }
      });
      if (out) break;
    }
    if (!out) throw new Error('/analyze 핸들러가 응답을 만들지 않았다');
    return out;
  }

  // ── 픽스처 적재
  for (const f of FIXTURES) {
    const r = await db.query(
      `INSERT INTO products (barcode, product_name, food_type, content_unit, total_content, serving_size, data_source)
       VALUES ($1,$2,$3,$4,$5,$6,'manual_seed') RETURNING product_id`,
      [f.barcode, f.product_name, f.food_type, f.content_unit, f.total_content, f.serving_size],
    );
    const pid = r.rows[0].product_id;
    const n = f.nutrition;
    await db.query(
      `INSERT INTO nutrition_data (product_id, calories, sodium, total_sugars, saturated_fat, total_fat,
         cholesterol, protein, dietary_fiber, trans_fat, serving_size, data_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'public_nutrition')`,
      [pid, n.calories, n.sodium, n.total_sugars, n.saturated_fat, n.total_fat,
        n.cholesterol, n.protein, n.dietary_fiber, n.trans_fat, f.nd_serving],
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§0. 도달 가능성 — 두 경로를 실제로 부를 수 있는가');

  await t('★ ocrRoutes 가 judgeNutrition 을 export 한다 (없으면 복사본 검사로 퇴화한다)', () => {
    assert.strictEqual(typeof ocrRoutes.judgeNutrition, 'function',
      'judgeNutrition 이 export 되지 않았다 — 소스를 고쳐 export 하지 말고 이 사실을 보고할 것');
  });

  await t('★ /analyze 라우트 핸들러에 도달할 수 있다 (D1·D2 는 이 핸들러 본문에 있다)', () => {
    assert.ok(analyzeLayer, 'POST /analyze 레이어를 찾지 못했다');
    assert.ok(analyzeLayer.route.stack.length >= 1);
  });

  await t('★ getProductWithTrafficLight 가 pglite 로 실제 동작한다', async () => {
    const r = await productService.getProductWithTrafficLight('PARITY0001');
    assert.ok(r && r.traffic_light, '신호등이 만들어지지 않았다 — 픽스처 적재가 실패했다');
    assert.strictEqual(r.product.product_name, '오뚜기 참기름');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§1. 픽스처별 경로 동등성');

  const dump = {};

  for (const f of FIXTURES) {
    // ── 경로 A: 바코드 조회
    const bcRes = await productService.getProductWithTrafficLight(f.barcode);
    // 바코드 응답에는 별도 sanity 키가 없다. 화면에 실리는 것 = traffic_light.sanity_warnings.
    const barRec = toRecord(bcRes.traffic_light, bcRes.traffic_light && bcRes.traffic_light.sanity_warnings);

    // ── 경로 B: OCR (`/analyze` 핸들러 본문 전체)
    //   ★ 라벨 텍스트는 파서가 영양값을 **덮어쓰지 않도록** 최소로 둔다.
    //     영양값은 product_info.nutrition 으로 canonical fixture 를 그대로 주입한다
    //     (라우터가 `analysis.nutrition = {...analysis.nutrition, ...productInfo.nutrition}` 로 병합한다).
    //     이렇게 해야 「두 경로에 **같은 값**을 넣었을 때 다른 답이 나오는가」만 남는다.
    LABEL_TEXT = `${f.product_name}\n식품유형 ${f.food_type}\n영양성분`;
    const basis = f.nd_serving === '100ml' ? 'per_100ml'
      : f.nd_serving === '100g' ? 'per_100g' : 'per_serving';
    const ocrRes = await callAnalyze({
      image: 'x'.repeat(400),
      product_info: {
        product_name: f.product_name,
        food_type: f.food_type,
        content_unit: f.content_unit,
        total_content: f.total_content,
        serving_size: f.serving_size,          // ★ null 인 픽스처는 라우터가 100 으로 채운다(D1)
        nutrition: { ...f.nutrition, _basis: basis },
      },
    });
    const ocrTl = ocrRes.data.traffic_light;
    const ocrRec = toRecord(ocrTl, ocrRes.data.sanity_warnings);

    dump[f.id] = { bar: barRec, ocr: ocrRec };

    // ── ① 바코드 경로 골든 (절대값)
    await t(`[${f.id}] 바코드 경로가 골든과 같다 — ${f.label}`, () => {
      const g = goldenToRecord(GOLDEN_BAR[f.id]);
      const bad = [];
      for (const k of Object.keys(g)) {
        if (JSON.stringify(barRec[k]) !== JSON.stringify(g[k])) {
          bad.push(`    ${k}: 골든=${JSON.stringify(g[k])}  실제=${JSON.stringify(barRec[k])}`);
        }
      }
      assert.strictEqual(bad.length, 0,
        `바코드 경로 판정이 골든과 다르다 (RACC 배선이 끊겼거나 판정 규칙이 바뀌었다):\n${bad.join('\n')}`);
    });

    // ── ② 두 경로 차이 → KNOWN_DIFF 대장과 대조
    await t(`[${f.id}] OCR 경로와의 차이가 대장(KNOWN_DIFF)과 정확히 일치한다`, () => {
      const problems = [];
      const seen = new Set();

      for (const k of Object.keys(barRec)) {
        const key = `${f.id}::${k}`;
        const same = JSON.stringify(barRec[k]) === JSON.stringify(ocrRec[k]);
        const entry = KNOWN_DIFF[key];

        if (!same && !entry) {
          problems.push(
            `    [새 불일치] ${k}\n`
            + `      바코드=${JSON.stringify(barRec[k])}  OCR=${JSON.stringify(ocrRec[k])}\n`
            + '      → 같은 제품이 조회 경로에 따라 다른 답을 낸다. 대장에 없는 회귀다.');
        } else if (!same && entry) {
          seen.add(key);
          const okBar = JSON.stringify(barRec[k]) === JSON.stringify(entry.bar);
          const okOcr = JSON.stringify(ocrRec[k]) === JSON.stringify(entry.ocr);
          if (!okBar || !okOcr) {
            problems.push(
              `    [대장과 값이 다름] ${k} (${entry.defect})\n`
              + `      대장: 바코드=${JSON.stringify(entry.bar)} OCR=${JSON.stringify(entry.ocr)}\n`
              + `      실제: 바코드=${JSON.stringify(barRec[k])} OCR=${JSON.stringify(ocrRec[k])}\n`
              + '      → 결함의 크기가 바뀌었다(부분 수정이거나 다른 결함이 겹쳤다). 원인을 밝히고 대장을 갱신할 것.');
          } else {
            known(f.id, k, `${entry.defect} · 바코드=${JSON.stringify(entry.bar)} OCR=${JSON.stringify(entry.ocr)}`);
          }
        } else if (same && entry) {
          problems.push(
            `    [고쳐졌다] ${k} (${entry.defect})\n`
            + `      두 경로가 이제 ${JSON.stringify(barRec[k])} 로 일치한다.\n`
            + '      → KNOWN_DIFF 에서 이 줄을 지우고 GOLDEN_BAR 를 갱신할 것. 남겨 두면 다음 회귀를 못 잡는다.');
        }
      }

      // 대장에 있는데 이번 실행에서 아예 등장하지 않은 키(필드명 오타·리팩터링)
      for (const key of Object.keys(KNOWN_DIFF)) {
        if (!key.startsWith(`${f.id}::`)) continue;
        const field = key.slice(f.id.length + 2);
        if (!(field in barRec)) {
          problems.push(`    [대장의 필드가 사라짐] ${field} — 레코드에 그런 필드가 없다. 대장을 정리할 것.`);
        }
      }

      assert.strictEqual(problems.length, 0, `\n${problems.join('\n')}`);
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§2. RACC 배선 — 두 경로 모두 실제로 정책을 쓴다');

  // ★ 뮤테이션 M3(productService 의 getRaccPolicy 인자 제거)·같은 형태의 ocrRoutes 뮤테이션을
  //   잡기 위한 **독립** 검사다. §1 의 골든과 겹치지만, 겹치는 것이 목적이다 —
  //   골든 한 줄을 누가 "테스트가 빨개서" 옮겨 적으면 이쪽이 남아서 잡는다.
  await t('★★ RACC 정책이 실제로 판정을 바꾸는 픽스처가 있다 (전제 확인)', () => {
    for (const id of ['sesame_oil', 'soy_sauce', 'seasoned_laver', 'laver_jaban_outlier']) {
      const f = FIXTURES.find((x) => x.id === id);
      const p = getRaccPolicy(f.food_type);
      assert.ok(p && p.racc > 0, `${id}: getRaccPolicy('${f.food_type}') 가 null 이다 — RACC_MAP 이 바뀌었다`);
      assert.ok(p.racc < 50, `${id}: RACC 가 ${p.racc} 로 커져 100 과의 차이가 사라졌다 — 이 픽스처는 더 이상 유효하지 않다`);
    }
  });

  await t('★★★ 바코드 경로: RACC 소량식품의 basis 가 racc_* 다 (인자를 안 넘기면 pct_dv 로 떨어진다)', () => {
    const bad = [];
    const wantRaccBasis = {
      sesame_oil: ['sat_fat', 'total_fat'],       // oil 가드
      soy_sauce: ['sodium'],                      // sodium 가드
      seasoned_laver: ['sodium'],
      laver_jaban_outlier: ['sodium'],
    };
    for (const [id, keys] of Object.entries(wantRaccBasis)) {
      for (const k of keys) {
        const got = dump[id].bar[`nutrients.${k}.basis`];
        if (!/^racc_/.test(String(got))) {
          bad.push(`${id}.${k}: basis=${got} (racc_* 가 아니다 → getRaccPolicy 배선이 끊겼다)`);
        }
      }
    }
    assert.strictEqual(bad.length, 0, `\n    ${bad.join('\n    ')}`);
  });

  await t('★★★ OCR 경로: RACC 소량식품의 basis 도 racc_* 다 (세션47 이 배선한 것이 살아 있는가)', () => {
    const bad = [];
    const wantRaccBasis = {
      sesame_oil: ['sat_fat', 'total_fat'],
      soy_sauce: ['sodium'],
      seasoned_laver: ['sodium'],
      laver_jaban_outlier: ['sodium'],
    };
    for (const [id, keys] of Object.entries(wantRaccBasis)) {
      for (const k of keys) {
        const got = dump[id].ocr[`nutrients.${k}.basis`];
        if (!/^racc_/.test(String(got))) {
          bad.push(`${id}.${k}: basis=${got} — ocrRoutes 의 getRaccPolicy(productData.food_type) 인자가 사라졌다`);
        }
      }
    }
    assert.strictEqual(bad.length, 0, `\n    ${bad.join('\n    ')}`);
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§3. 1회 제공량 해상 — RACC 를 100 이 덮지 않는가 (D1 의 본체)');

  await t('★★★ RACC 제품의 1회량이 100 이 아니다 (바코드 경로)', () => {
    // %DV = (per100 × serving / 100) / DV × 100 이므로 serving 을 역산할 수 있다.
    //   serving = pct_dv × DV / per_100
    // 참기름 포화지방: DV=15g, per_100=15g, pct_dv=5 → serving = 5×15/15/... → 5 g
    const bar = dump.sesame_oil.bar;
    const serving = (bar['nutrients.sat_fat.pct_dv'] / 100) * 15 / (bar['nutrients.sat_fat.per_100'] / 100);
    assert.ok(Math.abs(serving - 5) < 0.2,
      `참기름의 1회량이 ${serving.toFixed(2)} g 로 해상됐다 — RACC 5 g 이어야 한다`);
  });

  await t('★ 대조군: RACC 가 없는 제품은 두 경로가 같은 1회량(100)을 쓴다', () => {
    // RACC 가 없으면 바코드 경로도 `serving_size || 100` 이므로 두 경로가 만나야 한다.
    // 이 대조군이 깨지면 원인은 serving_size 가 아니라 **다른 곳**이다.
    for (const id of ['beef_jerky_control', 'snack_control']) {
      for (const k of NUTRIENTS) {
        assert.strictEqual(
          dump[id].bar[`nutrients.${k}.pct_dv`], dump[id].ocr[`nutrients.${k}.pct_dv`],
          `${id}.${k}: RACC 무관 제품인데 %DV 가 갈렸다 (bar=${dump[id].bar[`nutrients.${k}.pct_dv`]} ocr=${dump[id].ocr[`nutrients.${k}.pct_dv`]})`);
      }
    }
  });

  await t('★ 대조군: products.serving_size 가 있으면 두 경로가 완전히 일치한다', () => {
    const b = dump.per_serving_control.bar;
    const o = dump.per_serving_control.ocr;
    const bad = Object.keys(b).filter((k) => JSON.stringify(b[k]) !== JSON.stringify(o[k]));
    assert.strictEqual(bad.length, 0,
      `1회 제공량이 라벨에 있는 제품마저 갈렸다: ${bad.map((k) => `${k}(bar=${JSON.stringify(b[k])} ocr=${JSON.stringify(o[k])})`).join(', ')}`);
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§4. sanity_warnings — 자기모순 응답 (D2)');

  await t('★★ OCR 응답이 엔진 sanity 와 라우터 sanity 를 동시에 싣고 서로 다르다 (자기모순)', () => {
    // ★ 이것은 「두 경로 비교」가 아니라 **한 응답 안의 모순**이다.
    //   같은 요청의 응답에 `traffic_light.sanity_warnings` 와 `data.sanity_warnings` 가
    //   둘 다 실리는데 값이 다르면, 어느 쪽을 읽느냐에 따라 화면이 달라진다.
    const id = 'laver_jaban_outlier';
    const engine = dump[id].ocr.engine_sanity;
    const exposedOcr = dump[id].ocr.exposed_sanity;
    if (engine === exposedOcr) {
      throw new Error(
        `[고쳐졌다] ${id}: OCR 응답의 엔진 sanity 와 노출 sanity 가 이제 같다("${engine}").\n`
        + '      → 이 테스트와 KNOWN_DIFF 의 D2 항목을 함께 지울 것.');
    }
    known(id, 'ocr 응답 내부 모순',
      `D2 · traffic_light.sanity_warnings="${engine}" ≠ data.sanity_warnings="${exposedOcr}"`);
  });

  await t('★ 건조식품 판정 자체는 두 경로가 일치한다 (엔진은 양쪽 다 옳게 본다)', () => {
    for (const id of ['seasoned_laver', 'laver_jaban_outlier', 'beef_jerky_control']) {
      assert.strictEqual(dump[id].bar.is_dried_exception, true, `${id}: 바코드 경로가 건조식품으로 안 본다`);
      assert.strictEqual(dump[id].ocr.is_dried_exception, true, `${id}: OCR 경로가 건조식품으로 안 본다`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§5. 알레르기 — 응답 키 집합만 (상세 계약은 test_allergen_contract.js)');

  await t('★★ 두 경로의 알레르기 키 집합이 다르다 (D4 · 알려진 결함)', async () => {
    const bc = await productService.getProductWithTrafficLight('PARITY0001');
    LABEL_TEXT = '오뚜기 참기름\n원재료명: 참깨(수입산)\n영양성분';
    const ocr = await callAnalyze({ image: 'x'.repeat(400), product_info: { product_name: '오뚜기 참기름' } });

    const barKeys = ['allergens', 'allergens_v2', 'allergens_available', 'allergens_flat_complete']
      .filter((k) => k in bc);
    const ocrKeys = ['allergens', 'allergens_v2', 'allergens_available', 'allergens_flat_complete']
      .filter((k) => k in ocr.data.analysis);

    assert.deepStrictEqual(barKeys,
      ['allergens', 'allergens_v2', 'allergens_available', 'allergens_flat_complete'],
      '바코드 경로의 알레르기 4키가 줄었다 — 「정보 없음」과 「없음」의 구분이 사라진다');

    if (ocrKeys.length === 4) {
      throw new Error(
        '[고쳐졌다] OCR 경로도 알레르기 4키를 낸다. 이 테스트와 D4 를 지우고 계약 테스트로 옮길 것.');
    }
    known('ocr', '알레르기 키 집합',
      `D4 · 바코드=[${barKeys.join(', ')}] OCR=[${ocrKeys.join(', ')}] `
      + '→ OCR 화면은 「혼입만 있는 제품」을 「알레르기 없음」과 구분할 수 없다');
  });

  await t('★ OCR 경로 flat 에 혼입이 섞이지 않는다 (구버전 앱이 붉게 표시한다)', async () => {
    LABEL_TEXT = '초코과자\n원재료명: 밀가루, 설탕\n'
      + '이 제품은 대두를 사용한 제품과 같은 제조시설에서 제조하고 있습니다.';
    const ocr = await callAnalyze({ image: 'x'.repeat(400), product_info: { product_name: '초코과자' } });
    const a = ocr.data.analysis;
    assert.ok(a.allergens_v2, 'allergens_v2 가 응답에 없다');
    for (const n of a.allergens_v2.mayContain || []) {
      assert.ok(!a.allergens.includes(n),
        `혼입 「${n}」 이 flat 에 있다 — 구버전 앱이 「직접 함유」로 붉게 표시한다`);
    }
    for (const n of [...(a.allergens_v2.contains || []), ...(a.allergens_v2.inferred || [])]) {
      assert.ok(a.allergens.includes(n), `직접함유/추정 「${n}」 이 flat 에서 빠졌다 — 경고 소실`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  if (process.env.PARITY_DUMP) {
    console.log('\n── PARITY_DUMP ────────────────────────────────────────────');
    console.log(JSON.stringify(dump, null, 2));
  }

  await db.close();

  // ── 결과 보고 ────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`📊 세션48 경로 동등성: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})`);

  if (expectedIssues.length > 0) {
    console.log(`\n⚠  미해결 결함(알려진 불일치) ${expectedIssues.length}건 — 대장과 값이 일치한다:`);
    const byDefect = {};
    for (const e of expectedIssues) {
      const m = /^(D\d)/.exec(e.detail);
      const d = m ? m[1] : 'D?';
      (byDefect[d] = byDefect[d] || []).push(`${e.fixtureId}.${e.field}`);
    }
    for (const [d, list] of Object.entries(byDefect)) {
      console.log(`   ${d}: ${list.length}건 — ${list.slice(0, 4).join(', ')}${list.length > 4 ? ` 외 ${list.length - 4}건` : ''}`);
    }
    console.log('   ★ 이것들은 아직 고쳐지지 않았다. 고친 뒤 PARITY_STRICT=1 이 초록이어야 한다.');
  }

  if (fail > 0) {
    console.log('\n실패 상세:');
    for (const f of failures) console.log(`  - ${f.name}\n    ${f.message}`);
    process.exit(1);
  }

  if (process.env.PARITY_STRICT === '1' && expectedIssues.length > 0) {
    console.log(`\n❌ PARITY_STRICT=1 — 미해결 결함 ${expectedIssues.length}건을 실패로 센다.`);
    process.exit(1);
  }

  console.log('✅ 새 불일치 없음 (알려진 결함은 위에 나열)');
}

main().catch((e) => { console.error('예상 못 한 예외:', e); process.exit(1); });
