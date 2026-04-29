/**
 * 먹선 영양 신호등 판정 알고리즘 테스트
 * 실제 한국 식품 시나리오 기반
 */

const {
  evaluateNutrition,
  detectFoodCategory,
  formatResult,
  DEFAULT_CONFIG,
  sanityCheck,
} = require('../src/services/nutritionTrafficLight');

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ ${testName}`);
    passed++;
  } else {
    console.log(`  ❌ ${testName}`);
    failed++;
  }
}

// ============================================================
// 테스트 1: 일반 과자 (새우깡)
// ============================================================
console.log('\n📦 테스트 1: 새우깡 (일반 과자)');

const saewookkang = {
  product: {
    product_name: '새우깡',
    food_type: '과자',
    content_unit: 'g',
    serving_size: 30,
    total_content: 90,
  },
  nutrition: {
    calories: 140,
    sodium: 200,
    sugars: 2,
    sat_fat: 1.5,
    total_fat: 7,
    cholesterol: 5,
    protein: 2,
    fiber: 0.5,
    trans_fat: 0,
  },
};

const r1 = evaluateNutrition(saewookkang.product, saewookkang.nutrition);
assert(r1.is_excluded === false, '평가 대상');
assert(r1.food_category === 'general', '일반식품 분류');
// 이중 기준: 나트륨 %DV=10%→초록이지만 100g당=667mg→빨강 → 최종 빨강
assert(r1.nutrients.sodium.color === 'red', '나트륨 이중기준: %DV 초록이지만 100g 667mg→빨강');
// 이중 기준: 당류 %DV=2%→초록이지만 100g당=6.67g→노랑 → 최종 노랑
assert(r1.nutrients.sugars.color === 'yellow', '당류 이중기준: %DV 초록이지만 100g 6.67g→노랑');
assert(r1.nutrients.protein.color === 'gray', '단백질 3.6% < 5% → 회색 (적색피로감방지)');
assert(r1.nutrients.trans_fat.color === 'green', '트랜스지방 0g → 초록');
assert(r1.nutrients.trans_fat.tooltip !== null, '트랜스지방 0g 투명성 툴팁');
assert(r1.multi_serving !== null, '다회 제공량 감지 (90g/30g = 3회분)');
assert(r1.multi_serving.servings_per_container === 3, '3회분 정확');
console.log(formatResult(r1));

// ============================================================
// 테스트 2: 컵라면 (나트륨 높음)
// ============================================================
console.log('\n📦 테스트 2: 컵라면 (나트륨 주의)');

const cupRamen = {
  product: {
    product_name: '신라면 컵',
    food_type: '면류',
    content_unit: 'g',
    serving_size: 65,
    total_content: 65,
  },
  nutrition: {
    calories: 280,
    sodium: 1600,
    sugars: 4,
    sat_fat: 3.5,
    total_fat: 10,
    cholesterol: 0,
    protein: 6,
    fiber: 2,
    trans_fat: 0,
  },
};

const r2 = evaluateNutrition(cupRamen.product, cupRamen.nutrition);
assert(r2.nutrients.sodium.color === 'red', '나트륨 80% DV → 빨강');
assert(r2.nutrients.sodium.pct_dv === 80, '나트륨 %DV 정확');
// 이중 기준: 당류 %DV=4%→초록이지만 100g당=6.15g→노랑 → 최종 노랑
assert(r2.nutrients.sugars.color === 'yellow', '당류 이중기준: %DV 초록이지만 100g 6.15g→노랑');
assert(r2.nutrients.protein.color === 'yellow', '단백질 10.9% → 노랑 (5~15%)');
assert(r2.multi_serving === null, '1회분 제품 → 다회 표시 없음');
console.log(formatResult(r2));

// ============================================================
// 테스트 3: 육포 (건조식품 예외)
// ============================================================
console.log('\n📦 테스트 3: 육포 (건조식품 예외 적용)');

const jerky = {
  product: {
    product_name: '쇠고기 육포',
    food_type: '육포',
    content_unit: 'g',
    serving_size: 25,
    total_content: 50,
  },
  nutrition: {
    calories: 80,
    sodium: 350,
    sugars: 5,
    sat_fat: 0.5,
    total_fat: 1.5,
    cholesterol: 20,
    protein: 15,
    fiber: 0,
    trans_fat: 0,
  },
};

const r3 = evaluateNutrition(jerky.product, jerky.nutrition);
assert(r3.food_category === 'dried', '건조식품 분류');
assert(r3.is_dried_exception === true, '건조식품 예외 적용됨');
// 100g당 나트륨 = 1400mg (빨강 기준 600mg 초과)이지만 건조식품이므로 면제
// %DV = 350/2000 = 17.5% → 노랑
assert(r3.nutrients.sodium.color === 'yellow', '건조식품: %DV만 적용 → 나트륨 17.5% → 노랑 (100g 기준 면제)');
assert(r3.nutrients.sodium.basis === 'pct_dv', '판정 기준 = %DV만');
assert(r3.nutrients.protein.color === 'green', '단백질 27.3% → 초록 (풍부)');
assert(r3.context_messages.length > 0, '건조식품 맥락 안내 있음');
console.log(formatResult(r3));

// ============================================================
// 테스트 4: 콜라 제로 (음료, 100mL 기준)
// ============================================================
console.log('\n📦 테스트 4: 코카콜라 제로 (음료)');

const colaZero = {
  product: {
    product_name: '코카콜라 제로',
    food_type: '탄산음료',
    content_unit: 'ml',
    serving_size: 250,
    total_content: 500,
  },
  nutrition: {
    calories: 0,
    sodium: 25,
    sugars: 0,
    sat_fat: 0,
    total_fat: 0,
    cholesterol: 0,
    protein: 0,
    fiber: 0,
    trans_fat: 0,
  },
};

const r4 = evaluateNutrition(colaZero.product, colaZero.nutrition);
assert(r4.food_category === 'beverage', '음료 분류');
assert(r4.nutrients.sodium.color === 'green', '나트륨 1.3% → 초록');
assert(r4.nutrients.sugars.color === 'green', '당류 0% → 초록');
assert(r4.nutrients.protein.color === 'gray', '단백질 0% → 회색 (음료에서 기대 안 함)');
assert(r4.nutrients.fiber.color === 'gray', '식이섬유 0% → 회색');
console.log(formatResult(r4));

// ============================================================
// 테스트 5: 올리브유 (Nutri-Score D 문제 검증)
// ============================================================
console.log('\n📦 테스트 5: 올리브유 (Nutri-Score D → 먹선은?)');

const oliveOil = {
  product: {
    product_name: '엑스트라 버진 올리브유',
    food_type: '유지류',
    content_unit: 'ml',
    serving_size: 15,
    total_content: 500,
  },
  nutrition: {
    calories: 120,
    sodium: 0,
    sugars: 0,
    sat_fat: 2,
    total_fat: 14,
    cholesterol: 0,
    protein: 0,
    fiber: 0,
    trans_fat: 0,
  },
};

const r5 = evaluateNutrition(oliveOil.product, oliveOil.nutrition);
// 올리브유: food_type='유지류' → 비음료로 정확 분류
assert(r5.food_category !== 'beverage', '올리브유는 음료가 아님 (유지류)');
// 핵심: 올리브유는 지방 빨강이지만 나트륨/당류 초록 → 사용자가 맥락 판단 가능
assert(r5.nutrients.total_fat.color === 'red', '지방 26% DV → 빨강');
assert(r5.nutrients.sodium.color === 'green', '나트륨 0% → 초록');
assert(r5.nutrients.sugars.color === 'green', '당류 0% → 초록');
// Nutri-Score는 D등급을 주지만, 먹선은 각각 독립 → 사용자가 "지방은 높지만 건강한 지방" 판단 가능
console.log(formatResult(r5));

// ============================================================
// 테스트 6: 김치 (발효식품 맥락)
// ============================================================
console.log('\n📦 테스트 6: 김치 (발효식품)');

const kimchi = {
  product: {
    product_name: '종가 맛김치',
    food_type: '김치류',
    content_unit: 'g',
    serving_size: 40,
    total_content: 500,
  },
  nutrition: {
    calories: 15,
    sodium: 340,
    sugars: 1,
    sat_fat: 0,
    total_fat: 0.3,
    cholesterol: 0,
    protein: 1.2,
    fiber: 1.5,
    trans_fat: 0,
  },
};

const r6 = evaluateNutrition(kimchi.product, kimchi.nutrition);
assert(r6.food_category === 'fermented', '발효식품 분류 (김치류)');
// 이중 기준: 나트륨 %DV=17%→노랑, 100g당=850mg→빨강 → 최종 빨강
assert(r6.nutrients.sodium.color === 'red', '나트륨 이중기준: %DV 17%→노랑이지만 100g 850mg→빨강');
assert(r6.nutrients.fiber.color === 'yellow', '식이섬유 6% → 노랑');
assert(r6.context_messages.some(m => m.includes('발효식품')), '발효식품 맥락 안내');
console.log(formatResult(r6));

// ============================================================
// 테스트 7: 주류 (평가 제외)
// ============================================================
console.log('\n📦 테스트 7: 소주 (평가 제외)');

const soju = {
  product: {
    product_name: '참이슬',
    food_type: '소주',
    content_unit: 'ml',
    serving_size: 45,
    total_content: 360,
  },
  nutrition: { calories: 64, sodium: 0, sugars: 0 },
};

const r7 = evaluateNutrition(soju.product, soju.nutrition);
assert(r7.is_excluded === true, '주류 → 평가 제외');
assert(r7.exclude_reason === 'alcohol', '제외 사유: alcohol');
console.log(formatResult(r7));

// ============================================================
// 테스트 8: 이중 기준 — 제조사 꼼수 잡기
// ============================================================
console.log('\n📦 테스트 8: 제조사 꼼수 제품 (1회 제공량 15g)');

const trickSnack = {
  product: {
    product_name: '고나트륨 과자',
    food_type: '과자',
    content_unit: 'g',
    serving_size: 15,  // 비현실적으로 작은 1회 제공량
    total_content: 120,
  },
  nutrition: {
    calories: 60,
    sodium: 150,     // 15g당 150mg → %DV 7.5% = 초록
                     // 100g당 1000mg → 빨강!
    sugars: 3,
    sat_fat: 1,
    total_fat: 4,
    cholesterol: 0,
    protein: 0.5,
    fiber: 0,
    trans_fat: 0,
  },
};

const r8 = evaluateNutrition(trickSnack.product, trickSnack.nutrition);
assert(r8.nutrients.sodium.color === 'red', '이중 기준: %DV 초록이지만 100g 빨강 → 최종 빨강');
assert(r8.nutrients.sodium.basis === 'per_100g', '판정 기준 = 100g (더 나쁜 쪽)');
console.log(formatResult(r8));

// ============================================================
// 테스트 9: 데이터 누락 (일부 성분만 있음)
// ============================================================
console.log('\n📦 테스트 9: 데이터 누락 제품');

const partial = {
  product: {
    product_name: '소규모 제조 쿠키',
    food_type: '과자',
    content_unit: 'g',
    serving_size: 30,
    total_content: 30,
  },
  nutrition: {
    calories: 150,
    sodium: 80,
    sugars: 12,
    sat_fat: null,
    total_fat: null,
    cholesterol: null,
    protein: null,
    fiber: null,
    trans_fat: null,
  },
};

const r9 = evaluateNutrition(partial.product, partial.nutrition);
assert(r9.nutrients.sodium.data === 'present', '나트륨 데이터 있음');
assert(r9.nutrients.sat_fat.data === 'missing', '포화지방 데이터 없음');
assert(r9.nutrients.protein.data === 'missing', '단백질 데이터 없음');
// 이중 기준: 나트륨 %DV=4%→초록, 100g당=267mg→노랑 → 최종 노랑
assert(r9.nutrients.sodium.color === 'yellow', '있는 성분은 이중기준 정상 판정 (100g 267mg→노랑)');
console.log(formatResult(r9));

// ============================================================
// 테스트 10: OCR Sanity Check
// ============================================================
console.log('\n📦 테스트 10: OCR Sanity Check (비정상 수치)');

const badOCR = {
  calories: 50000,    // 비정상
  sodium: -100,       // 음수
  sugars: 10,
  sat_fat: 20,
  total_fat: 5,       // 포화지방 > 총지방
};

const warnings = sanityCheck(badOCR, 30);
assert(warnings.some(w => w.nutrient === 'calories' && w.type === 'per_serving_exceeded'), '열량 상한 초과 감지');
assert(warnings.some(w => w.nutrient === 'sodium' && w.type === 'negative_value'), '음수값 감지');
assert(warnings.some(w => w.nutrient === 'sat_fat' && w.type === 'exceeds_total_fat'), '포화지방 > 총지방 감지');
console.log(`  경고 목록: ${JSON.stringify(warnings, null, 2)}`);

// ============================================================
// 결과 요약
// ============================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`📊 테스트 결과: ${passed} 통과 / ${failed} 실패 (총 ${passed + failed}개)`);
console.log(`${'='.repeat(50)}`);

if (failed > 0) {
  process.exit(1);
}
