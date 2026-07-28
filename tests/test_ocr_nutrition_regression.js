/**
 * test_ocr_nutrition_regression.js — 세션39 거짓 초록 회귀 방지
 * ==============================================================
 * 2026-07-28, 쿠팡 캡처 실물(신라면·맥심·해표콩기름)로 발견한 결함이
 * 다시 들어오지 않도록 고정한다.
 *
 * 발견 경위: IP/manual_capture_pipeline_v1_2026-07-28.md §4-E
 * 원인 상세: src/services/ocrParser.js parseNum() 주석
 *
 * ★ 가장 중요한 케이스
 *   신라면 라벨의 "나트륨 1,790 mg" 을 기존 코드가 `.replace(',','.')` 로
 *   **1.79 mg** 으로 만들었다. sanityCheck 는 상한만 보므로 통과했고,
 *   신호등이 RED → GREEN 으로 뒤집혔다. = 거짓 초록.
 *
 * 실행: node tests/test_ocr_nutrition_regression.js
 */
'use strict';

const { parseNutrition, extractProductMeta } = require('../src/services/ocrParser');
const { evaluateNutrition } = require('../src/services/nutritionTrafficLight');

let pass = 0, fail = 0;
function assert(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
}

// ── 실물 라벨 (캡처 001·008·021) ──────────────────────────────────────────
const SHIN_RAMYUN = `제품명 신라면
식품유형 유탕면
품목보고번호 19760342001-155(안양), 19860360007-21(안성)
영양정보 총 내용량 600 g (120 g × 5봉지)
1봉지(120 g)당 500 kcal
나트륨 1,790 mg 90%  탄수화물 79 g 24%  당류 4 g 4%
지방 16 g 30%  트랜스지방 0 g  포화지방 8 g 53%
콜레스테롤 0 mg 0%  단백질 10 g 18%
1일 영양성분 기준치에 대한 비율(%)은 2,000 kcal 기준이므로 개인의 필요 열량에 따라 다를 수 있습니다.`;

const MAXIM = `식품유형 커피   중량 600 g (12 g × 50개)
영양정보 총 내용량 600 g (12 g × 50개)
1개(12 g)당 50 kcal
나트륨 6 mg 0%  탄수화물 9 g 3%  당류 6 g 6%
지방 1 g 2%  트랜스지방 0 g  포화지방 1.6 g 11%
1일 영양성분 기준치에 대한 비율(%)은 2,000 kcal 기준이므로 개인의 필요 열량에 따라 다를 수 있습니다.
중량: 600 g (50 kcal/1개 12 g, 총 2,500 kcal/50개)`;

const SOY_OIL = `제품명 콩기름   내용량 1.5L(25℃)
영양정보 총 내용량 1,500 mL / 100g당 900 kcal
나트륨 0 mg 0%  탄수화물 0 g 0%  당류 0 g
지방 100 g 185%  트랜스지방 0 g  포화지방 16 g 107%`;

console.log('\n══════════════════════════════════════════════════════');
console.log('  OCR 영양 파싱 회귀 (세션39 거짓 초록 방지)');
console.log('══════════════════════════════════════════════════════');

// ── 1. 천단위 콤마 (최우선) ─────────────────────────────────────────────
console.log('\n① 천단위 콤마 — 나트륨 1,790 mg');
const shin = parseNutrition(SHIN_RAMYUN);
assert(shin.sodium === 1790, `나트륨 1790 (실제 ${shin.sodium})`);
assert(shin.sodium !== 1.79, '나트륨이 1.79 로 깨지지 않음');
assert(shin.calories === 500, `열량 500 (실제 ${shin.calories})`);

// ── 2. 거짓 초록이 실제로 뒤집히는지 ────────────────────────────────────
console.log('\n② 신호등 — 거짓 초록 재현 방지');
const product = {
  product_name: '신라면', food_type: '유탕면', content_unit: 'g',
  serving_size: shin.serving_size || 100, total_content: shin.total_content,
};
const mkND = (sodium) => ({
  calories: shin.calories, sodium, sugars: shin.total_sugars,
  sat_fat: shin.saturated_fat, total_fat: shin.total_fat, protein: shin.protein,
  trans_fat: shin.trans_fat, fiber: null, cholesterol: shin.cholesterol,
  basis: shin._basis,
});
const after = evaluateNutrition(product, mkND(shin.sodium));
const buggy = evaluateNutrition(product, mkND(1.79));   // 옛 동작 시뮬레이션
assert(after.nutrients.sodium.color === 'red',
  `나트륨 RED (실제 ${after.nutrients.sodium.color}, ${after.nutrients.sodium.pct_dv}%)`);
assert(buggy.nutrients.sodium.color === 'green',
  '버그 값(1.79)은 GREEN 이었음 = 이 테스트가 지키는 대상');
assert(after.nutrients.sodium.pct_dv > 85 && after.nutrients.sodium.pct_dv < 95,
  `%DV 89.5 부근 (실제 ${after.nutrients.sodium.pct_dv}) — 라벨 인쇄값 90%와 정합`);

// ── 3. "1회" 아닌 제공량 표기 ───────────────────────────────────────────
console.log('\n③ 제공량 표기 — "1봉지(120g)당" · "1개(12g)당"');
assert(shin.serving_size === 120, `신라면 serving 120 (실제 ${shin.serving_size})`);
assert(shin._basis === 'per_serving', `basis per_serving (실제 ${shin._basis})`);
const maxim = parseNutrition(MAXIM);
assert(maxim.serving_size === 12, `맥심 serving 12 (실제 ${maxim.serving_size})`);

// ── 4. kcal 후보 3개 중 정답 고르기 ─────────────────────────────────────
console.log('\n④ 칼로리 — 기준치 2,000 · 총량 2,500 을 집지 않는가');
assert(maxim.calories === 50, `맥심 열량 50 (실제 ${maxim.calories})`);
assert(maxim.calories !== 2000 && maxim.calories !== 2500, '기준치/총량 문구를 집지 않음');

// ── 5. 100g당 표기 ──────────────────────────────────────────────────────
console.log('\n⑤ 100g당 표기 — 1회분으로 오인하지 않는가');
const oil = parseNutrition(SOY_OIL);
assert(oil._basis === 'per_100g', `basis per_100g (실제 ${oil._basis})`);
assert(oil.total_fat === 100, `지방 100 (실제 ${oil.total_fat})`);
assert(oil.total_content === 1500 && oil.content_unit === 'ml',
  `총 내용량 1500 ml (실제 ${oil.total_content} ${oil.content_unit}) — "내용량 1.5L" 가 아니라 "총 내용량 1,500 mL"`);

// ── 6. ★ 세션40 추가 — extractProductMeta 에 남아 있던 같은 결함 ──────────
// 세션39는 parseNutrition(L564)만 고치고 extractProductMeta(L879)를 놓쳤다.
// 그쪽 total_content 는 사장되는 값이 아니다:
//   ocrRoutes L295 → productInfo.total_content → crowdsourceService
//   → products.total_content 및 servings_per_container(=총량÷1회분)
// 즉 **DB 영구 저장 경로**다. 1.5mL / 120g = 0.0125 인분 같은 값이 들어간다.
console.log('\n⑥ extractProductMeta — 세션39가 놓친 두 번째 경로 (세션40)');
const meta = extractProductMeta(SOY_OIL);
assert(meta.total_content === 1500,
  `meta 총 내용량 1500 (실제 ${meta.total_content}) — "1,500" 을 1.5 로 축소하지 않음`);
assert(meta.content_unit === 'ml',
  `meta 단위 ml (실제 ${meta.content_unit}) — 위쪽 "내용량 1.5L" 보다 "총 내용량" 우선`);
const metaShin = extractProductMeta(SHIN_RAMYUN);
assert(metaShin.total_content === 600,
  `신라면 meta 총 내용량 600 (실제 ${metaShin.total_content}) — 콤마 없는 값도 그대로`);

console.log('\n══════════════════════════════════════════════════════');
console.log(`📊 결과: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail}개)`);
console.log('══════════════════════════════════════════════════════');
if (fail > 0) {
  console.log('\n❌ 회귀 발생 — 이 수정은 되돌려야 합니다.');
  process.exit(1);
}
console.log('\n✅ 전체 통과');
