/**
 * test_nutrition_basis_reconcile.js — ★ 세션78 2열 영양표(1회분 | 100g당) 기준 재판정
 *   정답: tests/fixtures/nutrition_basis_reconcile_v1.json (정본 IP/eval_nutrition_basis_v1/cases_v1.json · 구현 전 고정)
 *   기준선(수정 전) 앱 7/12 · 정본 7/12 → 수정 후 12/12 · 12/12.
 *   회귀: 68-eval(Vision 원문) 결과 JSON 수정 전후 동일 · 63-eval 153/153 유지(세션78 실측).
 *   §1 두 파서가 정답 전부 · §2 두 파서가 같은 공용 함수를 쓴다(사본 금지) · §3 근거 없으면 바꾸지 않는다
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const app = require('../src/services/ocrParser');
const canon = require('../scripts/lib/capture_label_parser');
const { reconcileServingVsPer100 } = require('../src/services/nutritionBasisReconcile');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.log(`  ❌ ${name}\n     → ${e.message}`); } }
const MAP = { per_serving: 'serving', per_100g: 'per100', per_100ml: 'per100', per_total: 'total', unknown: 'unknown' };
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'nutrition_basis_reconcile_v1.json'), 'utf8'));
const ok = (g, e) => g.basis === e.basis && (e.basis !== 'serving' || g.amount === e.amount) && g.cal === e.calories;

console.log('\n══ §1 정답(구현 전 고정) ══');
for (const c of fx.cases) {
  t(`${c.id} ${c.src}`, () => {
    const a = app.parseNutrition(c.text); const k = canon.parseLabel(c.text);
    const ga = { basis: MAP[a._basis], amount: a._basis_amount, cal: a.calories };
    const gk = { basis: k.basis, amount: k.basis_amount, cal: k.nutrition.calories };
    assert.ok(ok(ga, c.expect), `앱 ${JSON.stringify(ga)} ≠ ${JSON.stringify(c.expect)}`);
    assert.ok(ok(gk, c.expect), `정본 ${JSON.stringify(gk)} ≠ ${JSON.stringify(c.expect)}`);
  });
}
console.log('\n══ §2 공용 함수 한 곳 ══');
t('§2 두 파서 모두 nutritionBasisReconcile 을 require 한다(사본 없음)', () => {
  for (const f of ['../src/services/ocrParser.js', '../scripts/lib/capture_label_parser.js']) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.ok(/require\([^)]*nutritionBasisReconcile/.test(s), f);
    assert.ok(!/function reconcileServingVsPer100/.test(s), `${f} 에 사본이 있다`);
  }
});
console.log('\n══ §3 근거 없으면 null ══');
t('§3 per100 이 아니면 null · 1회분 선언 없으면 null · 열량 없으면 null', () => {
  assert.strictEqual(reconcileServingVsPer100({ text: '1봉지(20g)당 102 kcal', basis: 'serving', calories: 102 }), null);
  assert.strictEqual(reconcileServingVsPer100({ text: '100g당 400 kcal', basis: 'per100', calories: 400 }), null);
  assert.strictEqual(reconcileServingVsPer100({ text: '1봉지(20g)당 102 kcal 100g당', basis: 'per100', calories: null }), null);
});
t('§3 1회분 kcal 과 100g kcal 이 같으면 구분 불가 → null', () => {
  assert.strictEqual(reconcileServingVsPer100({ text: '1봉지(20g)당 100 kcal\n100g당 100 kcal', basis: 'per100', calories: 100 }), null);
});
t('§3 ReDoS 백스톱 — 공백·숫자 9,900자 입력 120ms 미만', () => {
  for (const s of [' '.repeat(9900), '1봉지('.padEnd(9900, '1'), '1,1,'.repeat(2475) + 'g(']) {
    const t0 = Date.now(); reconcileServingVsPer100({ text: s, basis: 'per100', calories: 1 }); assert.ok(Date.now() - t0 < 120, `${Date.now() - t0}ms`);
  }
});
console.log(`\n  결과: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
