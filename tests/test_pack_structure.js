/** test_pack_structure.js — ★ 세션82 묶음 라벨 기준 C 규칙. 정답 tests/fixtures/pack_structure_v1 (= IP/eval_pack_structure_v1 · PS01~08 · PN01~04)
 *  두 파서(ocrParser.parseNutrition · capture_label_parser.parseLabel)가 «같은 답»을 내야 한다(78-10 · C5). */
'use strict';
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const D = path.join(__dirname, 'fixtures', 'pack_structure_v1'); const C = require(path.join(D, 'cases_v1.json'));
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
console.log(`\n[pack structure C] ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
