/**
 * test_serving_resolver.js — 인분 수·식품유형 해상도 회귀 (2026-07-29 세션41)
 * 실행: node tests/test_serving_resolver.js
 *
 * 실물 라벨 기반. 캡처 전사(.tmp/captures/transcripts) 원문에서 발췌했다.
 * 지키는 계약
 *   ① 017 골든카레가 **거짓 빨강으로 나가지 않는다** (safe=false 로 판정 보류)
 *   ② 019 신라면컵의 6입 배수표기에서 인분 수를 읽는다
 *   ③ %기준치 200% 규칙이 **판정에만** 쓰이고 인분 수를 역산하지 않는다
 *   ④ 원재료 함량 %가 %기준치로 오염되지 않는다
 */
'use strict';

const R = require('../src/services/servingResolver');

let pass = 0, fail = 0; const fails = [];
function eq(name, got, exp) {
  const ok = Object.is(got, exp);
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name} — got ${JSON.stringify(got)} ≠ ${JSON.stringify(exp)}`); }
}
function ok(name, cond) { eq(name, !!cond, true); }

console.log('══════════════════════════════════════════════════════');
console.log('인분 수·식품유형 해상도 테스트');
console.log('══════════════════════════════════════════════════════\n');

// ── 1. %기준치 추출 ────────────────────────────────────────────────────────
console.log('── 1. %기준치 추출 — 값 뒤 % 만, 원재료 함량은 배제 ──');
eq('나트륨 458%', R.extractPctDV('나트륨 9150mg 458%')[0], 458);
eq('mg미만 표기', R.extractPctDV('콜레스테롤 5 mg미만 1%')[0], 1);
eq('kcal 뒤 %', R.extractPctDV('열량 300 kcal 15%')[0], 15);
eq('원재료 함량 % 배제', R.extractPctDV('설탕 15%, 정제소금 2%').length, 0);
eq('안내문구 배제', R.extractPctDV('비율(%)은 2,000 kcal 기준이므로').length, 0);
eq('빈 입력', R.extractPctDV('').length, 0);
eq('null 입력', R.extractPctDV(null).length, 0);
{
  const many = R.extractPctDV('나트륨 1,290 mg 65%\n탄수화물 47 g 15%\n포화지방 5 g 33%');
  eq('여러 개 추출', many.length, 3);
  eq('최대값 65', Math.max(...many), 65);
}

// ── 2. 라벨 인분 수 표기 ───────────────────────────────────────────────────
console.log('\n── 2. 라벨 인분 수 표기 (T0) ──');
eq('12인분', R.extractServingsFromLabel('220g 12인분 블록').servings, 12);
eq('019 배수표기 6입', R.extractServingsFromLabel('중량:390 g(65 g×6입)').servings, 6);
eq('001 5봉지', R.extractServingsFromLabel('총 내용량 600 g (120 g×5봉지)').servings, 5);
eq('008 50개', R.extractServingsFromLabel('중량: 600 g(12 g×50개)').servings, 50);
eq('023 소문자 x', R.extractServingsFromLabel('내용량: 260 g (26 g x 10개)').servings, 10);
eq('082 대문자 X', R.extractServingsFromLabel('총 내용량 600 g (300 g X 2 개)').servings, 2);
eq('1인분은 무시', R.extractServingsFromLabel('1인분'), null);
eq('배수 없음', R.extractServingsFromLabel('총 내용량 168 g'), null);

// ── 3. ★ 017 골든카레 — 거짓 빨강 방지가 핵심 ──────────────────────────────
console.log('\n── 3. ★ 017 골든카레 (라벨 458% · 실제 12인분) ──');
const goldenCurry = `제품명 골든카레 순한맛
식품유형 카레
총 내용량 220 g
총 내용량당
열량 1070 kcal
나트륨 9150 mg 458%
탄수화물 130 g 40%
지방 45 g 83%`;
const g = R.resolveServings({
  text: goldenCurry, basis: 'per_total', totalContent: 220, contentUnit: 'g', foodType: '카레',
});
eq('최대 %기준치 458', g.maxPctDV, 458);
ok('총량 ≠ 1회분 판정', g.totalIsNotSingleServing === true);
eq('인분 수는 추정하지 않음', g.servings, null);
ok('T3 검색 필요', g.needsLookup);
ok('식품유형 미매핑 이유 기록', g.lookupReasons.some((x) => x.includes('FOOD_TYPE_UNMAPPED')));
ok('인분 수 미상 이유 기록', g.lookupReasons.some((x) => x.includes('SERVINGS_UNKNOWN')));
{
  const d = R.totalToServingDivisor(g);
  eq('★ 판정 보류(safe=false)', d.safe, false);
  eq('보류 사유', d.reason, 'multi_serving_but_count_unknown');
}
// ★ %DV 역산 금지 계약: 458/100 = 4.6 이 절대 나오면 안 된다
ok('★ %DV 역산으로 4.6 을 만들지 않음', g.servings !== 4.6 && g.servings !== 5);

// ── 4. 019 신라면컵 — 라벨에 답이 있는 경우 ────────────────────────────────
console.log('\n── 4. 019 신라면컵 (6입 · 유탕면) ──');
const shinCup = `식품유형: 유탕면
중량:390 g(65 g×6입)
총 내용량 390 g(65 g×6공기)
1용기(65 g)당 300 kcal
나트륨 1,290 mg 65%`;
const s = R.resolveServings({
  text: shinCup, basis: 'per_serving', totalContent: 390, contentUnit: 'g', foodType: '유탕면',
});
eq('T0 로 해결', s.tier, 'T0');
eq('6인분', s.servings, 6);
eq('1회량 65g', s.servingSize, 65);
eq('최대 %기준치 65 (200 미만)', s.maxPctDV, 65);
eq('T3 불필요', s.needsLookup, false);

// ── 5. T2 RACC 환산 ────────────────────────────────────────────────────────
console.log('\n── 5. T2 총 내용량 ÷ RACC ──');
{
  // 032 떡국떡 500g / 떡류 RACC 100g = 5.0배 — 세션40 §5-3 B그룹
  const t = R.resolveServings({ text: '총 내용량 500 g\n나트륨 1530 mg 77%', basis: 'per_total',
    totalContent: 500, contentUnit: 'g', foodType: '떡류' });
  eq('떡국떡 T2', t.tier, 'T2');
  eq('떡국떡 5회분', t.servings, 5);
  eq('떡국떡 1회량 100g', t.servingSize, 100);
  ok('떡국떡 총량≠1회분', t.totalIsNotSingleServing === true);
  eq('떡국떡 T3 불필요', t.needsLookup, false);
  const d = R.totalToServingDivisor(t);
  eq('떡국떡 divisor 5', d.divisor, 5);
  eq('떡국떡 safe', d.safe, true);
}
{
  // 006 곱창김 캔 30g / 조미김 RACC 4g = 7.5배. 식품유형은 괄호 부가표기(L4 매칭)
  const t = R.resolveServings({ text: '총 내용량 30 g\n나트륨 430 mg 22%', basis: 'per_total',
    totalContent: 30, contentUnit: 'g', foodType: '가공김(조미김)' });
  eq('곱창김 T2', t.tier, 'T2');
  eq('곱창김 7.5회분', t.servings, 7.5);
  ok('곱창김 식품유형 L4 매칭 성공', !t.lookupReasons.some((x) => x.includes('FOOD_TYPE')));
}
{
  // 총량이 RACC 의 1.5배 미만 → 1회분 (세션40 §5-3 A그룹)
  const t = R.resolveServings({ text: '총 내용량 120 g', basis: 'per_total',
    totalContent: 120, contentUnit: 'g', foodType: '유탕면' });
  eq('유탕면 120g → 1회분', t.servings, 1);
  eq('총량=1회분 판정', t.totalIsNotSingleServing, false);
  eq('T3 불필요', t.needsLookup, false);
}

// ── 6. RACC 미매핑 → 제이 확정 정책: 총량 = 1회분 ──────────────────────────
console.log('\n── 6. RACC 미매핑 (제이 확정: 총량 = 1회분) ──');
{
  const t = R.resolveServings({ text: '총 내용량 62 g\n나트륨 300 mg 15%', basis: 'per_total',
    totalContent: 62, contentUnit: 'g', foodType: '알수없는유형' });
  eq('인분 수 미상', t.servings, null);
  ok('식품유형 미매핑 기록', t.lookupReasons.some((x) => x.includes('FOOD_TYPE_UNMAPPED')));
  const d = R.totalToServingDivisor(t);
  eq('divisor 1 (총량=1회분)', d.divisor, 1);
  eq('★ safe=true — 판정은 계속한다', d.safe, true);
  eq('사유 기록', d.reason, 'racc_unmapped_treat_total_as_serving');
}

// ── 7. [표3] 공란 12키 — 미매핑과 구분 ─────────────────────────────────────
console.log('\n── 7. [표3] 공란 (matched 이지만 racc 없음) ──');
{
  const t = R.resolveServings({ text: '총 내용량 100 g', basis: 'per_total',
    totalContent: 100, contentUnit: 'g', foodType: '젓갈' });
  ok('RACC_BLANK 경고', t.warnings.some((x) => x.includes('RACC_BLANK')));
  ok('미매핑으로 오분류하지 않음', !t.lookupReasons.some((x) => x.includes('FOOD_TYPE_UNMAPPED')));
}

// ── 8. 식품유형 누락 (세션40 §5-5 의 6건) ──────────────────────────────────
console.log('\n── 8. 식품유형 자체가 없는 경우 ──');
{
  const t = R.resolveServings({ text: '총 내용량 210 g', basis: 'per_total',
    totalContent: 210, contentUnit: 'g', foodType: null });
  ok('FOOD_TYPE_MISSING 기록', t.lookupReasons.some((x) => x.includes('FOOD_TYPE_MISSING')));
  ok('T3 필요', t.needsLookup);
}

// ── 9. 방어 ────────────────────────────────────────────────────────────────
console.log('\n── 9. 입력 방어 ──');
{
  const t = R.resolveServings({});
  ok('빈 입력에도 throw 안 함', t && typeof t === 'object');
  eq('servings null', t.servings, null);
  const d = R.totalToServingDivisor(null);
  eq('null divisor 1', d.divisor, 1);
  eq('null safe', d.safe, true);
}

// ── 결과 ───────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════');
console.log(`📊 결과: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail}개)`);
console.log('══════════════════════════════════════════════════════');
if (fail) { console.log('\n실패 목록:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('\n✅ 전체 통과');
