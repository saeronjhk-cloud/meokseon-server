/** test_label_basis.js — ★ 세션79 «포장지 그대로» 기준(정답 tests/fixtures/label_basis_v1.json 의 build·consistency) */
'use strict';
const assert = require('assert'); const C = require('./fixtures/label_basis_v1.json');
const { labelFromParsed, consistent } = require('../scripts/lib/label_basis');
const P = require('../src/services/ocrParser');
let pass = 0, fail = 0; const t = (n, fn) => { try { fn(); pass++; console.log(`  ✅ ${n}`); } catch (e) { fail++; console.log(`  ❌ ${n}\n     → ${e.message}`); } };
for (const c of C.build) t(`${c.id} 라벨 기준 만들기`, () => {
  const L = labelFromParsed(P.parseNutrition(c.text), c.text);
  if (c.expect === null) return assert.strictEqual(L, null);
  assert.ok(L, 'null'); assert.strictEqual(L.basis, c.expect.basis); assert.strictEqual(L.amount, c.expect.amount); assert.strictEqual(L.unit, c.expect.unit);
  for (const [k, v] of Object.entries(c.expect.values || {})) assert.strictEqual(L.values[k], v, k);
  if (c.expect.upper_bound) { assert.deepStrictEqual(L.upper_bound, c.expect.upper_bound); assert.deepStrictEqual(L.bound, c.expect.bound); } else assert.ok(!L.upper_bound, '상한 오탐');
});
for (const c of C.consistency) t(`${c.id} 저장 per100 과의 정합`, () => assert.strictEqual(consistent(c.label, c.per100), c.expect));
console.log(`\n[label basis] ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
