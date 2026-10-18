/**
 * test_label_basis_anchor.js — ★ 세션81 열량에 붙은 1회분 기준 우선(두 칸 라벨 A · 묶음 라벨 B).
 *   정답 tests/fixtures/label_basis_anchor_v1/cases_v1.json (= IP/eval_label_basis_anchor_v1) · 원문 = 판매처 라벨 OCR 실물.
 *   두 파서(앱 ocrParser.parseNutrition · 정본 capture_label_parser.parseLabel)가 같은 답을 내야 한다.
 */
'use strict';
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const P = require('../src/services/ocrParser'); const C = require('../scripts/lib/capture_label_parser');
const D = path.join(__dirname, 'fixtures', 'label_basis_anchor_v1'); const fx = JSON.parse(fs.readFileSync(path.join(D, 'cases_v1.json'), 'utf8'));
const MAP = { per_serving: 'serving', per_100g: 'per100', per_100ml: 'per100', per_total: 'total' };
let pass = 0, fail = 0;
for (const c of fx.cases) {
  try {
    const t = fs.readFileSync(path.join(D, c.id + '.txt'), 'utf8');
    const a = P.parseNutrition(t); const k = C.parseLabel(t);
    assert.strictEqual(a._basis, c.want.basis, `app basis ${a._basis}`);
    assert.strictEqual(a._basis_amount ?? null, c.want.amount, `app amount ${a._basis_amount}`);
    assert.strictEqual(a.calories, c.want.calories, `app kcal ${a.calories}`);
    assert.strictEqual(k.basis, MAP[c.want.basis], `canon basis ${k.basis}`);
    if (c.want.amount != null && c.want.basis === 'per_serving') assert.strictEqual(k.basis_amount, c.want.amount, `canon amount ${k.basis_amount}`);
    pass++; console.log(`  ✅ ${c.id} ${c.cls} ${c.note}`);
  } catch (e) { fail++; console.log(`  ❌ ${c.id} ${c.cls} ${c.note}\n     → ${e.message}`); }
}
console.log(`\n${pass} 통과 · ${fail} 실패`); process.exit(fail ? 1 : 0);
