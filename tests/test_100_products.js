/**
 * 먹선(吃選) 100개 제품 통합 테스트
 * 병합 파이프라인 + 영양 신호등 판정 End-to-End
 */

const { c005Data, nutritionData } = require('./sample_100_products');
const { mergeDatasets } = require('../scripts/data-pipeline/mergePublicData');
const { evaluateNutrition, detectFoodCategory, formatResult, sanityCheck } = require('../src/services/nutritionTrafficLight');

// ============================================================
// 1. 병합 파이프라인 실행
// ============================================================

console.log('══════════════════════════════════════════════════════');
console.log('  먹선 100개 제품 통합 테스트');
console.log('══════════════════════════════════════════════════════\n');

const mergeResult = mergeDatasets(c005Data, nutritionData, { minSimilarity: 0.4 });

// ============================================================
// 2. 병합 통계 검증
// ============================================================

console.log('\n\n── 병합 검증 ──────────────────────────');

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    passed++;
  } else {
    console.log(`  ❌ ${testName}`);
    failed++;
  }
}

assert(mergeResult.matched.length > 0, '매칭된 제품이 1건 이상');
assert(mergeResult.stats.total_c005 === 100, 'C005 입력 100건');
assert(mergeResult.stats.total_nutrition === 105, '영양DB 입력 105건');
assert(mergeResult.nutritionOnly.length > 0, '영양DB 전용 제품 존재');

const matchRate = mergeResult.matched.length / c005Data.length;
console.log(`  매칭률: ${(matchRate * 100).toFixed(1)}% (${mergeResult.matched.length}/100)`);
console.log(`  C005 전용: ${mergeResult.c005Only.length}건`);
console.log(`  영양DB 전용: ${mergeResult.nutritionOnly.length}건`);
console.log(`  평균 매칭 점수: ${mergeResult.stats.avg_match_score}`);

// 매칭 점수 분포
const scoreRanges = { high: 0, medium: 0, low: 0 };
for (const m of mergeResult.matched) {
  if (m.match_score >= 0.7) scoreRanges.high++;
  else if (m.match_score >= 0.5) scoreRanges.medium++;
  else scoreRanges.low++;
}
console.log(`  점수 분포: 높음(≥0.7) ${scoreRanges.high} / 중간(0.5~0.7) ${scoreRanges.medium} / 낮음(<0.5) ${scoreRanges.low}`);

// ============================================================
// 3. 전체 매칭 상세 출력
// ============================================================

console.log('\n── 매칭 상세 (C005 → 영양DB) ──────────');
for (const m of mergeResult.matched) {
  const flag = m.match_score >= 0.7 ? '🟢' : m.match_score >= 0.5 ? '🟡' : '🔴';
  console.log(`  ${flag} ${m.product_name} → ${m.match_nutrition_name} (${m.match_score})`);
}

if (mergeResult.c005Only.length > 0) {
  console.log('\n── 매칭 실패 (C005 전용) ──────────────');
  for (const c of mergeResult.c005Only) {
    console.log(`  ⚪ ${c.product_name} (${c.manufacturer})`);
  }
}

// ============================================================
// 4. 영양 신호등 판정 — 매칭된 전체 제품
// ============================================================

console.log('\n\n══════════════════════════════════════════════════════');
console.log('  영양 신호등 판정 결과');
console.log('══════════════════════════════════════════════════════\n');

const categoryCount = {};
const excludedProducts = [];
const colorStats = {
  sodium: { green: 0, yellow: 0, red: 0, gray: 0 },
  sugars: { green: 0, yellow: 0, red: 0, gray: 0 },
  sat_fat: { green: 0, yellow: 0, red: 0, gray: 0 },
  total_fat: { green: 0, yellow: 0, red: 0, gray: 0 },
  protein: { green: 0, yellow: 0, red: 0, gray: 0 },
  fiber: { green: 0, yellow: 0, red: 0, gray: 0 },
  trans_fat: { green: 0, yellow: 0, red: 0, gray: 0 },
};
const basisStats = { pct_dv: 0, per_100g: 0, per_100ml: 0, absolute: 0 };
const multiServingProducts = [];
const sanityWarnings = [];
let evaluatedCount = 0;
let driedExceptionCount = 0;
const contextMessageProducts = [];

for (const product of mergeResult.matched) {
  const nutritionInput = {
    calories: product.nutrition.calories,
    sodium: product.nutrition.sodium,
    sugars: product.nutrition.total_sugars,
    sat_fat: product.nutrition.saturated_fat,
    total_fat: product.nutrition.total_fat,
    cholesterol: product.nutrition.cholesterol,
    protein: product.nutrition.protein,
    fiber: product.nutrition.dietary_fiber,
    trans_fat: product.nutrition.trans_fat,
  };

  const productInput = {
    product_name: product.product_name,
    food_type: product.food_type,
    content_unit: product.content_unit,
    serving_size: product.serving_size,
    total_content: product.total_content,
  };

  const result = evaluateNutrition(productInput, nutritionInput);

  // 카테고리 집계
  categoryCount[result.food_category] = (categoryCount[result.food_category] || 0) + 1;

  // 제외 제품
  if (result.is_excluded) {
    excludedProducts.push({ name: product.product_name, reason: result.exclude_reason });
    continue;
  }

  evaluatedCount++;

  // 색상 집계
  for (const nutrient of Object.keys(colorStats)) {
    if (result.nutrients[nutrient] && result.nutrients[nutrient].data === 'present') {
      const color = result.nutrients[nutrient].color;
      if (colorStats[nutrient][color] !== undefined) {
        colorStats[nutrient][color]++;
      }
    }
  }

  // 판정 기준 집계 (나트륨 기준으로)
  if (result.nutrients.sodium && result.nutrients.sodium.basis) {
    basisStats[result.nutrients.sodium.basis] = (basisStats[result.nutrients.sodium.basis] || 0) + 1;
  }

  // 다회 제공량
  if (result.multi_serving) {
    multiServingProducts.push({
      name: product.product_name,
      servings: result.multi_serving.servings_per_container,
    });
  }

  // 건조식품 예외
  if (result.is_dried_exception) {
    driedExceptionCount++;
  }

  // 맥락 메시지
  if (result.context_messages && result.context_messages.length > 0) {
    contextMessageProducts.push({
      name: product.product_name,
      messages: result.context_messages,
    });
  }

  // OCR Sanity Check
  const warnings = sanityCheck(nutritionInput, product.serving_size);
  if (warnings.length > 0) {
    sanityWarnings.push({ name: product.product_name, warnings });
  }
}

// ============================================================
// 5. 종합 리포트
// ============================================================

console.log('── 카테고리 분류 ──────────────────────');
for (const [cat, count] of Object.entries(categoryCount).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat}: ${count}건`);
}

console.log('\n── 제외 제품 ──────────────────────────');
if (excludedProducts.length > 0) {
  for (const e of excludedProducts) {
    console.log(`  🚫 ${e.name} (사유: ${e.reason})`);
  }
} else {
  console.log('  (없음)');
}

console.log(`\n── 영양성분별 신호등 분포 (평가 대상 ${evaluatedCount}건) ──`);
const colorEmoji = { green: '🟢', yellow: '🟡', red: '🔴', gray: '⚪' };
for (const [nutrient, counts] of Object.entries(colorStats)) {
  const total = counts.green + counts.yellow + counts.red + counts.gray;
  if (total === 0) continue;
  const bar = Object.entries(counts)
    .filter(([_, v]) => v > 0)
    .map(([c, v]) => `${colorEmoji[c]}${v}`)
    .join(' ');
  console.log(`  ${nutrient.padEnd(10)} ${bar}`);
}

console.log('\n── 나트륨 판정 기준 분포 ──────────────');
for (const [basis, count] of Object.entries(basisStats)) {
  if (count > 0) console.log(`  ${basis}: ${count}건`);
}

console.log(`\n── 건조식품 예외 적용: ${driedExceptionCount}건 ──`);

console.log(`\n── 다회 제공량 감지: ${multiServingProducts.length}건 ──`);
for (const ms of multiServingProducts) {
  console.log(`  📦 ${ms.name}: ${ms.servings}회분`);
}

console.log(`\n── 맥락 메시지 제공: ${contextMessageProducts.length}건 ──`);
for (const cm of contextMessageProducts) {
  console.log(`  💬 ${cm.name}: ${cm.messages[0].substring(0, 40)}...`);
}

if (sanityWarnings.length > 0) {
  console.log(`\n── OCR Sanity Check 경고: ${sanityWarnings.length}건 ──`);
  for (const sw of sanityWarnings) {
    console.log(`  ⚠️  ${sw.name}: ${sw.warnings.map(w => w.type).join(', ')}`);
  }
} else {
  console.log('\n── OCR Sanity Check 경고: 0건 (정상) ──');
}

// ============================================================
// 6. 핵심 검증
// ============================================================

console.log('\n\n── 핵심 검증 ──────────────────────────');

// 매칭률 50% 이상
assert(matchRate >= 0.5, `매칭률 50% 이상 (실제: ${(matchRate * 100).toFixed(1)}%)`);

// 주류가 제외 되었는지
const alcoholExcluded = excludedProducts.filter(e => e.reason === 'alcohol');
assert(alcoholExcluded.length >= 1, `주류 제외 처리 (${alcoholExcluded.length}건)`);

// 건강기능식품 제외 여부
const supplementExcluded = excludedProducts.filter(e => e.reason === 'supplement');
assert(supplementExcluded.length >= 1, `건강기능식품 제외 처리 (${supplementExcluded.length}건)`);

// 음료 카테고리 감지
assert((categoryCount['beverage'] || 0) >= 5, `음료 카테고리 5건 이상 감지 (실제: ${categoryCount['beverage'] || 0}건)`);

// 발효식품 카테고리 감지
assert((categoryCount['fermented'] || 0) >= 1, `발효식품 카테고리 감지 (실제: ${categoryCount['fermented'] || 0}건)`);

// 건조식품 예외 적용
assert(driedExceptionCount >= 1, `건조식품 예외 적용 (${driedExceptionCount}건)`);

// 다회 제공량 감지
assert(multiServingProducts.length >= 5, `다회 제공량 감지 5건 이상 (실제: ${multiServingProducts.length}건)`);

// 모든 색상(초록/노랑/빨강)이 나트륨에서 골고루 나왔는지
assert(colorStats.sodium.green > 0 && colorStats.sodium.yellow > 0 && colorStats.sodium.red > 0,
  `나트륨 3색 분포 (초${colorStats.sodium.green}/노${colorStats.sodium.yellow}/빨${colorStats.sodium.red})`);

// 단백질 회색(gray) 존재 확인
assert(colorStats.protein.gray > 0, `단백질 회색(적색피로감방지) 존재 (${colorStats.protein.gray}건)`);

// 맥락 메시지 제공
assert(contextMessageProducts.length >= 1, `맥락 메시지 제공 (${contextMessageProducts.length}건)`);

// Sanity check가 정상 데이터에서 경고를 내지 않는지
assert(sanityWarnings.length === 0, `정상 데이터 Sanity Check 통과 (경고 ${sanityWarnings.length}건)`);

// ============================================================
// 7. 최종 결과
// ============================================================

console.log(`\n${'═'.repeat(54)}`);
console.log(`📊 최종 결과: ${passed} 통과 / ${failed} 실패 (총 ${passed + failed}개 검증)`);
console.log(`${'═'.repeat(54)}`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('\n✅ 100개 제품 통합 테스트 전체 통과!');
}
