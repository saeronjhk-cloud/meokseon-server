/**
 * test_per_total_wiring.js — 세션42 배선 회귀 (2026-07-29)
 * ============================================================================
 * 무엇을 고정하는가
 *   §1-1 servingResolver → nutritionTrafficLight 배선 (per_total 1회분 환산 / 판정 보류)
 *   §1-2 칼로리 배수표기 오집 차단 (019 신라면컵 1,800 vs 300)
 *   §1-3 ocrRoutes 2장 수신 경로 basis 배선
 *   §1-4 basis 4종 역이식 (용기 어휘 · bare · 총 내용량 단독) + per_total 저장 허용
 *
 * ★ 이 파일의 케이스는 전부 **실물 캡처 전사**에서 왔다. 가공 예제가 아니다.
 *   019 신라면컵 · 032 떡국떡 · 017 골든카레(S&B) · 027 쇠고기볶음고추장
 *
 * ★ 순서 의존성 고정 — 4번을 1번보다 먼저 하면 거짓 빨강이 된다.
 *   그래서 "per_total 이 열려 있다"(§10)와 "열렸는데 환산된다"(§2)를 **둘 다** 검사한다.
 *   한쪽만 있으면 다음 세션이 순서를 되돌려도 테스트가 안 잡는다.
 */
'use strict';

const assert = require('assert');
const ocrParser = require('../src/services/ocrParser');
const { evaluateNutrition, scaleNutrition } = require('../src/services/nutritionTrafficLight');
const crowdsource = require('../src/services/crowdsourceService');

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, message: e.message });
    console.log(`  ❌ ${name}\n     → ${e.message}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

// ════════════════════════════════════════════════════════════════════════════
section('§1. 캡처 019 신라면컵 — 칼로리 배수표기 (거짓 빨강 차단)');

const T019 = `제품명 신라면컵
중량:390 g(65 g×6입)
열량:1,800 kcal(300 kcal×6입)
총 내용량 390 g(65 g×6공기)
1용기(65 g)당 300 kcal
나트륨 1,640 mg 82 %
탄수화물 49 g
당류 3 g
단백질 7 g
지방 12 g
포화지방 6 g
트랜스지방 0 g`;

t('019 열량 = 300 (1,800 이 아니다 — 6배 과대 = 거짓 빨강)', () => {
  const r = ocrParser.parseNutrition(T019);
  assert.strictEqual(r.calories, 300, `calories=${r.calories}`);
});

t('019 배수표기 줄이 노이즈로 제거된 근거가 남는다', () => {
  const r = ocrParser.parseNutrition(T019);
  assert.ok(Array.isArray(r._calorie_noise_removed) && r._calorie_noise_removed.length === 1,
    JSON.stringify(r._calorie_noise_removed));
  assert.strictEqual(r._calorie_per_unit_from_multiplier, 300);
});

t('019 basis = per_serving 65g (`1용기(65 g)당` — 어휘 `용기` 역이식)', () => {
  const r = ocrParser.parseNutrition(T019);
  assert.strictEqual(r._basis, 'per_serving', `basis=${r._basis}`);
  assert.strictEqual(r._basis_amount, 65);
});

t('019 나트륨 = 1640 (천단위 콤마 방어 유지 — 세션39 거짓 초록 회귀)', () => {
  const r = ocrParser.parseNutrition(T019);
  assert.strictEqual(r.sodium, 1640);
});

t('단일컬럼 라벨은 _total 을 만들지 않는다 (옆 영양소 값 오염 차단)', () => {
  const r = ocrParser.parseNutrition(T019);
  // 수정 전: _total.total_carbs = 3 (당류 값을 집어왔다)
  assert.strictEqual(r._total, undefined, `_total=${JSON.stringify(r._total)}`);
});

t('“당” 표기가 없으면 괄호 안 개당값을 최후 후보로 쓴다', () => {
  const r = ocrParser.parseNutrition('총 내용량 390 g\n열량:1,800 kcal(300 kcal×6입)\n나트륨 1,640 mg');
  assert.strictEqual(r.calories, 300, `calories=${r.calories}`);
});

t('진짜 dual-column 라벨은 그대로 1회분 | 총량으로 읽는다', () => {
  const r = ocrParser.parseNutrition(
    '1회 제공량 30g당 | 총 내용량 73g당\n'
    + '열량 160 kcal 390 kcal\n나트륨 170 mg 420 mg\n탄수화물 20 g 49 g\n당류 3 g 7 g'
  );
  assert.strictEqual(r.calories, 160);
  assert.strictEqual(r.sodium, 170);
  assert.ok(r._total, '_total 이 있어야 한다');
  assert.strictEqual(r._total.calories, 390);
  assert.strictEqual(r._total.sodium, 420);
});

// ════════════════════════════════════════════════════════════════════════════
section('§2. 캡처 032 떡국떡 — per_total → RACC 환산 (거짓 빨강 차단)');

const P032 = { product_name: '떡국떡', food_type: '떡류', content_unit: 'g', serving_size: null, total_content: 500 };
const N032 = {
  calories: 1155, sodium: 1530, sugars: 0, sat_fat: 0.5, total_fat: 2, protein: 20,
  basis: 'per_total',
  _label_text: '총 내용량 500 g\n나트륨 1,530 mg 77 %',
};

t('032 divisor = 5 (총 500g ÷ 떡류 RACC 100g)', () => {
  const r = evaluateNutrition(P032, N032);
  assert.ok(r.per_total, 'per_total 진단이 결과에 실려야 한다');
  assert.strictEqual(r.per_total.divisor, 5);
  assert.strictEqual(r.per_total.safe, true);
  assert.strictEqual(r.per_total.tier, 'T2');
});

t('032 나트륨이 빨강이 아니다 (1,530mg 그대로면 77%DV 거짓 빨강)', () => {
  const r = evaluateNutrition(P032, N032);
  assert.notStrictEqual(r.nutrients.sodium.color, 'red',
    `color=${r.nutrients.sodium.color} pct=${r.nutrients.sodium.pct_dv}`);
});

t('032 나트륨 %DV ≈ 15.3 (306mg / 2,000mg)', () => {
  const r = evaluateNutrition(P032, N032);
  assert.ok(Math.abs(r.nutrients.sodium.pct_dv - 15.3) < 0.5, `pct=${r.nutrients.sodium.pct_dv}`);
});

t('032 열량도 함께 환산된다 (1,155 → 231)', () => {
  const r = evaluateNutrition(P032, N032);
  assert.strictEqual(r.calories.amount, 231, `calories=${JSON.stringify(r.calories)}`);
});

// ════════════════════════════════════════════════════════════════════════════
section('§3. 캡처 017 골든카레 — 판정 보류 (추정 금지)');

const P017 = { product_name: '골든카레', food_type: '카레', content_unit: 'g', serving_size: null, total_content: 220 };
const N017 = {
  calories: 1070, sodium: 9150, sugars: 20, basis: 'per_total',
  _label_text: '총 내용량 220 g\n열량 1070 kcal\n나트륨 9150 mg 458 %',
};

t('017 은 판정을 보류한다 (safe=false)', () => {
  const r = evaluateNutrition(P017, N017);
  assert.strictEqual(r.is_withheld, true);
  assert.strictEqual(r.withhold_reason, 'multi_serving_but_count_unknown');
});

t('017 나트륨에 색을 칠하지 않는다 (458% 초강력 빨강 차단)', () => {
  const r = evaluateNutrition(P017, N017);
  assert.strictEqual(r.nutrients.sodium.color, null);
  assert.strictEqual(r.nutrients.sodium.data, 'withheld');
});

t('017 열량은 총량이라고 명시해서 보여준다 (사실은 사실이다)', () => {
  const r = evaluateNutrition(P017, N017);
  assert.strictEqual(r.calories.amount, 1070);
  assert.strictEqual(r.calories.pct_dv, null);
  assert.strictEqual(r.calories.basis, 'per_total');
});

t('017 은 4.6인분으로 역산되지 않는다 (%DV 역산 금지 — 실제 12인분)', () => {
  const r = evaluateNutrition(P017, N017);
  assert.strictEqual(r.per_total.servings, null, `servings=${r.per_total.servings}`);
});

t('017 라벨에 “12인분” 이 적혀 있으면 T0 로 해결된다', () => {
  const r = evaluateNutrition(P017, {
    ...N017,
    _label_text: '총 내용량 220 g\n12인분\n열량 1070 kcal\n나트륨 9150 mg 458 %',
  });
  assert.ok(!r.is_withheld, '보류가 풀려야 한다');
  assert.strictEqual(r.per_total.divisor, 12);
  assert.strictEqual(r.per_total.tier, 'T0');
  // 9150 / 12 = 762.5mg → 38%DV. S&B 공식 표기(762mg / 38%)와 일치한다.
  assert.ok(Math.abs(r.nutrients.sodium.pct_dv - 38.1) < 1, `pct=${r.nutrients.sodium.pct_dv}`);
});

// ════════════════════════════════════════════════════════════════════════════
section('§4. RACC 미매핑 + 단서 없음 → 총량 = 1회분 (제이 확정 §3-1)');

t('RACC 표에 없고 %DV 단서도 없으면 총량을 1회분으로 본다', () => {
  const r = evaluateNutrition(
    { product_name: '알수없는간식', food_type: '듣도보도못한유형', content_unit: 'g', serving_size: null, total_content: 62 },
    { calories: 315, sodium: 180, sugars: 8, basis: 'per_total', _label_text: '총 내용량 62 g' }
  );
  assert.strictEqual(r.per_total.divisor, 1);
  assert.strictEqual(r.per_total.safe, true);
  assert.strictEqual(r.per_total.reason, 'racc_unmapped_treat_total_as_serving');
  assert.strictEqual(r.nutrients.sodium.data, 'present');
});

// ════════════════════════════════════════════════════════════════════════════
section('§5. basis 4종 역이식 — 순서가 안전장치다');

t('“100 g 당” 은 per_100g (bare 규칙으로 새지 않는다)', () => {
  const r = ocrParser.detectNutritionBasis('영양정보 100 g 당\n열량 900 kcal\n지방 100 g');
  assert.strictEqual(r.basis, 'per_100g');
});

t('“100 mL 당” 은 per_100ml', () => {
  assert.strictEqual(ocrParser.detectNutritionBasis('100 mL 당 열량 45 kcal').basis, 'per_100ml');
});

t('027 “60 g 당 140 kcal” = per_serving 60 (bare 표기)', () => {
  const r = ocrParser.detectNutritionBasis('쇠고기볶음고추장\n60 g 당 140 kcal');
  assert.strictEqual(r.basis, 'per_serving');
  assert.strictEqual(r.amount, 60);
  assert.strictEqual(r.bare, true);
});

t('“총 내용량 당” 은 per_total', () => {
  assert.strictEqual(ocrParser.detectNutritionBasis('총 내용량 당 열량 315 kcal').basis, 'per_total');
});

t('“총 내용량 62 g” 만 있어도 per_total (캡처 68건 중 28건 = 최대 집단)', () => {
  const r = ocrParser.detectNutritionBasis('총 내용량 62 g\n315 kcal\n나트륨 180 mg');
  assert.strictEqual(r.basis, 'per_total');
  assert.strictEqual(r.from_total_only, true);
});

t('아무 기준도 없으면 unknown 이다 (모르는 걸 안다고 하지 않는다)', () => {
  assert.strictEqual(ocrParser.detectNutritionBasis('맛있는 과자입니다').basis, 'unknown');
});

t('1회 제공량 표기가 총 내용량보다 우선한다', () => {
  const r = ocrParser.detectNutritionBasis('총 내용량 390 g\n1용기(65 g)당 300 kcal');
  assert.strictEqual(r.basis, 'per_serving');
  assert.strictEqual(r.amount, 65);
});

// ════════════════════════════════════════════════════════════════════════════
section('§6. scaleNutrition — 판정용 키');

t('판정용 키(sugars/sat_fat/fiber)를 나눈다', () => {
  const o = scaleNutrition({ calories: 1000, sodium: 1500, sugars: 20, sat_fat: 6, fiber: 4, basis: 'per_total' }, 5);
  assert.strictEqual(o.calories, 200);
  assert.strictEqual(o.sodium, 300);
  assert.strictEqual(o.sugars, 4);
  assert.strictEqual(o.basis, 'per_total', '숫자 아닌 필드는 보존');
});

t('divisor <= 1 이면 원본 객체를 그대로 돌려준다', () => {
  const src = { calories: 100 };
  assert.strictEqual(scaleNutrition(src, 1), src);
});

t('null 값은 건드리지 않는다', () => {
  const o = scaleNutrition({ calories: 100, sodium: null }, 2);
  assert.strictEqual(o.sodium, null);
});

// ════════════════════════════════════════════════════════════════════════════
section('§7. scaleStoredNutrition — 저장용 키 (이름이 다르다)');

t('저장용 키(total_sugars/saturated_fat/dietary_fiber)를 나눈다', () => {
  const o = crowdsource.scaleStoredNutrition(
    { calories: 1155, sodium: 1530, total_sugars: 10, saturated_fat: 0.5, dietary_fiber: 5, total_carbs: 250 }, 5
  );
  assert.strictEqual(o.calories, 231);
  assert.strictEqual(o.sodium, 306);
  assert.strictEqual(o.total_sugars, 2);
  assert.strictEqual(o.saturated_fat, 0.1);
  assert.strictEqual(o.dietary_fiber, 1);
  assert.strictEqual(o.total_carbs, 50);
});

t('★ 판정용 키 목록과 저장용 키 목록은 달라야 한다 (합치면 조용히 안 나눠진다)', () => {
  assert.ok(crowdsource.STORED_NUTRIENT_KEYS.includes('total_sugars'));
  assert.ok(crowdsource.STORED_NUTRIENT_KEYS.includes('saturated_fat'));
  assert.ok(crowdsource.STORED_NUTRIENT_KEYS.includes('dietary_fiber'));
  assert.ok(!crowdsource.STORED_NUTRIENT_KEYS.includes('sugars'));
});

// ════════════════════════════════════════════════════════════════════════════
section('§8. 기존 basis 동작 회귀 (건드리지 않았음을 고정)');

t('per_100g 라벨은 여전히 100g 기준으로 판정한다 (해표 콩기름형)', () => {
  const r = evaluateNutrition(
    { product_name: '콩기름', food_type: '식용유지류', content_unit: 'ml', serving_size: 5, total_content: 1500 },
    { calories: 900, sodium: 0, sugars: 0, sat_fat: 15, total_fat: 100, basis: 'per_100g' }
  );
  assert.ok(!r.is_withheld);
  assert.ok(r.per_total === undefined, 'per_100g 에 per_total 진단이 붙으면 안 된다');
});

t('per_serving 라벨은 환산 없이 그대로 판정한다', () => {
  const r = evaluateNutrition(
    { product_name: '신라면컵', food_type: '유탕면', content_unit: 'g', serving_size: 65, total_content: 390 },
    { calories: 300, sodium: 1640, sugars: 3, sat_fat: 6, total_fat: 12, basis: 'per_serving' }
  );
  assert.ok(r.per_total === undefined);
  assert.strictEqual(r.nutrients.sodium.data, 'present');
});

// ════════════════════════════════════════════════════════════════════════════
section('§9. ★ 검증 에이전트가 잡은 결함 — 재발 방지');

// ── 치명1: BASIS_SERVING_BARE 가 "탄수화물 250g / 당류" 를 1회 제공량으로 오독 ──
const T_STANDARD_TABLE = `영양정보
총 내용량 500g
열량 1155kcal
나트륨 1530mg
탄수화물 250g
당류 0g
단백질 20g`;

t('★치명1 표준 세로형 영양성분표가 per_total 로 판정된다 (당류 오독 금지)', () => {
  const r = ocrParser.parseNutrition(T_STANDARD_TABLE);
  assert.strictEqual(r._basis, 'per_total', `basis=${r._basis} amount=${r._basis_amount}`);
});

t('★치명1 serving_size 에 탄수화물 그램수(250)가 들어가지 않는다', () => {
  const r = ocrParser.parseNutrition(T_STANDARD_TABLE);
  assert.notStrictEqual(r.serving_size, 250, `serving_size=${r.serving_size}`);
});

t('★치명1 end-to-end: 파서 → 신호등에서 032 가 빨강이 아니다', () => {
  const r = ocrParser.parseNutrition(T_STANDARD_TABLE);
  const e = evaluateNutrition(
    { product_name: '떡국떡', food_type: '떡류', content_unit: 'g', serving_size: null, total_content: r.total_content },
    {
      calories: r.calories, sodium: r.sodium, sugars: r.total_sugars, protein: r.protein,
      basis: r._basis, _label_text: T_STANDARD_TABLE,
    }
  );
  assert.strictEqual(e.per_total.divisor, 5, JSON.stringify(e.per_total));
  assert.notStrictEqual(e.nutrients.sodium.color, 'red', `color=${e.nutrients.sodium.color}`);
});

t('★치명1 "당류"·"당알코올"·"당분" 이 모두 bare 규칙을 발동시키지 않는다', () => {
  for (const w of ['당류', '당알코올', '당분']) {
    const r = ocrParser.detectNutritionBasis(`탄수화물 250 g\n${w} 0 g`);
    assert.strictEqual(r.basis, 'unknown', `${w} → ${r.basis}`);
  }
});

t('bare 규칙 자체는 살아 있다 (027 "60 g 당 140 kcal")', () => {
  const r = ocrParser.detectNutritionBasis('쇠고기볶음고추장\n60 g 당 140 kcal');
  assert.strictEqual(r.basis, 'per_serving');
  assert.strictEqual(r.amount, 60);
});

t('"총 내용량 500 g당" 은 per_total (bare 로 500g 1회분이 되면 안 된다)', () => {
  assert.strictEqual(ocrParser.detectNutritionBasis('총 내용량 500 g당 열량 1155 kcal').basis, 'per_total');
});

// ── 치명2: ReDoS ──
t('★치명2 공백이 긴 입력이 100ms 안에 끝난다 (ReDoS 방어)', () => {
  const payload = `열량${' '.repeat(3000)}:${' '.repeat(3000)}1 kcal`;
  const t0 = Date.now();
  ocrParser.parseNutrition(payload);
  const ms = Date.now() - t0;
  assert.ok(ms < 100, `${ms}ms 걸렸다 — 백트래킹 폭발`);
});

// ── 치명3: 200% 규칙이 RACC 매칭에 무력화 ──
t('★치명3 RACC 가 1회분이라 해도 %기준치 458% 면 판정을 보류한다', () => {
  const e = evaluateNutrition(
    { product_name: 'X', food_type: '즉석조리식품', content_unit: 'g', serving_size: null, total_content: 220 },
    { calories: 1070, sodium: 9150, sugars: 20, basis: 'per_total', _label_text: '총 내용량 220 g\n나트륨 9150 mg 458 %' }
  );
  assert.strictEqual(e.is_withheld, true, `sodium=${JSON.stringify(e.nutrients.sodium)}`);
});

t('★치명3 %기준치가 정상이면 RACC 1회분 판정은 그대로 통과한다', () => {
  const e = evaluateNutrition(
    { product_name: 'Y', food_type: '즉석조리식품', content_unit: 'g', serving_size: null, total_content: 220 },
    { calories: 300, sodium: 600, sugars: 5, basis: 'per_total', _label_text: '총 내용량 220 g\n나트륨 600 mg 30 %' }
  );
  assert.ok(!e.is_withheld);
  assert.strictEqual(e.per_total.divisor, 1);
  assert.strictEqual(e.nutrients.sodium.data, 'present');
});

// ── 치명4: serving_size 기본값 100 ──
t('★치명4 per_total 에서 serving_size 가 null 이면 총 내용량을 1회분으로 잡는다', () => {
  const e = evaluateNutrition(
    { product_name: '과자', food_type: '과자', content_unit: 'g', serving_size: null, total_content: 30 },
    { calories: 150, sodium: 100, sugars: 12, basis: 'per_total', _label_text: '총 내용량 30 g' }
  );
  assert.strictEqual(e.per_total.divisor, 1);
  // 30g 기준 → 당류 per_100 = 40. serving 100 으로 잘못 잡으면 12 가 되어 노랑으로 새어나간다.
  assert.ok(e.nutrients.sugars.per_100 > 35, `per_100=${e.nutrients.sugars.per_100}`);
});

// ── 중대5: 1회 제공량이 따로 적힌 라벨을 per_total 로 오판 ──
t('★중대5 "총 내용량 500g  1회 제공량 100g" 은 per_total 이 아니다', () => {
  const r = ocrParser.detectNutritionBasis('영양정보\n총 내용량 500g  1회 제공량 100g\n열량 231kcal');
  assert.notStrictEqual(r.basis, 'per_total', `basis=${r.basis}`);
});

// ── 경미9·10 ──
t('경미9 "나트륨 350mg / 칼륨 400mg" 이 _total 을 오염시키지 않는다', () => {
  const r = ocrParser.parseNutrition('1회 제공량 30g당\n나트륨 350 mg\n칼륨 400 mg');
  assert.ok(!r._total || r._total.sodium === undefined, `_total=${JSON.stringify(r._total)}`);
  assert.strictEqual(r.sodium, 350);
});

t('경미10 정답이 괄호 앞에 오는 역순 라벨은 지우지 않는다', () => {
  const r = ocrParser.parseNutrition('1용기당 300 kcal (1,800 kcal×6입)\n나트륨 1,640 mg');
  assert.strictEqual(r.calories, 300, `calories=${r.calories}`);
});

t('경미12 formatResult 가 판정 보류를 "데이터 없음" 과 구분해 출력한다', () => {
  const { formatResult } = require('../src/services/nutritionTrafficLight');
  const out = formatResult(evaluateNutrition(P017, N017));
  assert.ok(out.includes('판정 보류'), out);
});

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(62)}`);
console.log(`📊 세션42 배선 회귀: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})`);
if (fail > 0) {
  console.log('\n실패 목록:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log('✅ 전체 통과');
