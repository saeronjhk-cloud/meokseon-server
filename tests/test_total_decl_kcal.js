/** test_total_decl_kcal.js — ★ 세션83 총량 기준 «총 내용량 N단위 K kcal» 열량 우선 E 규칙. 정답 tests/fixtures/total_decl_kcal_v1 (= IP/eval_total_decl_kcal_v1)
 *  두 파서(ocrParser.parseNutrition · capture_label_parser.parseLabel)가 «같은 답»을 내야 한다(78-10 · E5). */
'use strict';
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const D = path.join(__dirname, 'fixtures', 'total_decl_kcal_v1'); const C = require(path.join(D, 'cases_v1.json'));
const P = require('../src/services/ocrParser'); const L = require('../scripts/lib/capture_label_parser');
let pass = 0, fail = 0;
for (const c of C.cases) {
  try {
    const t = fs.readFileSync(path.join(D, c.text), 'utf8');
    const a = P.parseNutrition(t); const b = L.parseLabel(t);
    assert.deepStrictEqual([a._basis || 'unknown', a._basis_amount ?? a.serving_size ?? null, a.calories ?? null], c.expect.runtime, 'runtime');
    assert.deepStrictEqual([b.basis || 'unknown', b.basis_amount ?? null, (b.nutrition && b.nutrition.calories) ?? null], c.expect.capture, 'capture');
    pass++; console.log(`  ✅ ${c.id} ${c.why.slice(0, 60)}`);
  } catch (e) { fail++; console.log(`  ❌ ${c.id} → ${e.message}`); }
}
console.log(`\n[total decl kcal E] ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
