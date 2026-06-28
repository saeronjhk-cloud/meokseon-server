/**
 * OFF basis 무회귀/안전 측정 테스트 (#2 적재 후)
 * 목적: resolved view 가 엔진에 넘길 basis 케이스를 그대로 재현해 실제 동작을 측정.
 *   - OFF per_100g / per_100ml(confident): per_100 절대량이 입력값 그대로여야(이중변환 X)
 *   - OFF basis unknown: view serving NULL → deriveBasis→per_serving → per-100 값을 per_serving 으로 오해석?
 *   - nd per_serving: 종전과 동일(무회귀)
 *   - NULL serving + 각종 basis: 크래시/NaN/Infinity 없어야
 * 실행: node tests/test_traffic_light_off.js
 */
const { evaluateNutrition, deriveBasis } = require('../src/services/nutritionTrafficLight');

let P = 0, F = 0;
function ok(name, cond, detail) {
  console.log(`  [${cond ? 'OK' : 'XX'}] ${name}${detail ? ' — ' + detail : ''}`);
  cond ? P++ : F++;
}
// NaN/Infinity 숫자만 '나쁨'으로 판정(null/undefined/문자열은 정상 — 영양소별 객체 shape 상이).
const bad = (x) => typeof x === 'number' && !Number.isFinite(x);
const noBad = (nutrients) => !Object.values(nutrients).some(n => bad(n.per_100) || bad(n.pct_dv));
const finite = () => true; // (호환용 미사용)

// 신라면류 per-100g 값 (실제 적재 골든셋 근사)
const OFF100 = { calories: 421, sodium: 1608, sugars: 2.5, sat_fat: 5, total_fat: 13, cholesterol: 0, protein: 8, fiber: 2, trans_fat: 0 };
const prodG = { product_name: '신라면', food_type: '유탕면', content_unit: 'g', serving_size: 120 };

console.log('\n== A. OFF per_100g (confident, view serving_size="100g") ==');
let r = evaluateNutrition(prodG, { ...OFF100, basis: deriveBasis('100g') });
ok('basis 인식 per_100g', r.nutrients.sodium.basis === null || r.nutrients.sodium.per_100 !== null);
ok('sodium per_100 == 입력(이중변환 없음)', r.nutrients.sodium.per_100 === 1608,
   `per_100=${r.nutrients.sodium.per_100} (기대 1608)`);
ok('sugars per_100 == 입력', r.nutrients.sugars.per_100 === 2.5, `per_100=${r.nutrients.sugars.per_100}`);
ok('모든 수치 유한(크래시/NaN 없음)', noBad(r.nutrients));

console.log('\n== B. OFF per_100ml (beverage, view serving_size="100ml") ==');
const prodMl = { product_name: '콜라', food_type: '탄산음료', content_unit: 'mL', serving_size: 250 };
const OFFml = { calories: 42, sodium: 5, sugars: 10.6, sat_fat: 0, total_fat: 0, cholesterol: 0, protein: 0, fiber: 0, trans_fat: 0 };
r = evaluateNutrition(prodMl, { ...OFFml, basis: deriveBasis('100ml') });
ok('sugars per_100 == 입력(이중변환 없음)', r.nutrients.sugars.per_100 === 10.6, `per_100=${r.nutrients.sugars.per_100}`);
ok('수치 유한', noBad(r.nutrients));

console.log('\n== C. OFF basis unknown → 마커 "100unknown" → per_100_unknown (수정 후) ==');
ok('deriveBasis("100unknown") = per_100_unknown', deriveBasis('100unknown') === 'per_100_unknown',
   `got=${deriveBasis('100unknown')}`);
r = evaluateNutrition(prodG, { ...OFF100, basis: 'per_100_unknown' });
console.log(`     sodium: per_100=${r.nutrients.sodium.per_100} pct_dv=${r.nutrients.sodium.pct_dv} color=${r.nutrients.sodium.color}`);
ok('절대량 컷오프 스킵: sodium.per_100 == null', r.nutrients.sodium.per_100 === null,
   `per_100=${r.nutrients.sodium.per_100}`);
ok('%DV 정확(per-100을 per_serving으로 이중변환 안 함 → pct_dv 높음)', r.nutrients.sodium.pct_dv > 90,
   `pct_dv=${r.nutrients.sodium.pct_dv}`);
ok('color 는 %DV 로 산출(빨강)', r.nutrients.sodium.color === 'red');
ok('크래시/NaN/Infinity 없음', noBad(r.nutrients));

console.log('\n== D. nd per_serving 무회귀 (식약처/OCR) ==');
const ndProd = { product_name: '새우깡', food_type: '과자', content_unit: 'g', serving_size: 30 };
const ndNut = { calories: 140, sodium: 200, sugars: 2, sat_fat: 1.5, total_fat: 7, cholesterol: 5, protein: 2, fiber: 0.5, trans_fat: 0, basis: 'per_serving' };
r = evaluateNutrition(ndProd, ndNut);
ok('per_serving per_100 = 200/30*100≈667(종전 동일)', Math.round(r.nutrients.sodium.per_100) === 667,
   `per_100=${r.nutrients.sodium.per_100}`);
ok('수치 유한', noBad(r.nutrients));

console.log('\n== E. serving NULL/0 안전(크래시 가드) ==');
[null, 0, undefined].forEach((ss) => {
  const rr = evaluateNutrition({ product_name: 't', food_type: '과자', serving_size: ss },
                               { ...OFF100, basis: deriveBasis(null) });
  ok(`serving=${ss}: 유한·무크래시`, noBad(rr.nutrients));
});

console.log(`\n=== 결과: ${P} passed, ${F} failed ===`);
console.log(F === 0 ? 'ALL GREEN ✅' : '일부 측정 실패 ✗');
process.exit(F ? 1 : 0);
