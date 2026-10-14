/** test_barcode_link_gate.js — ★ 세션79 바코드 잇기 판정 E2(정답 tests/fixtures/barcode_link_v1.json · 구현 전 고정) */
'use strict';
const assert = require('assert'); const C = require('./fixtures/barcode_link_v1.json'); const { decide } = require('../scripts/lib/barcode_link_gate');
let pass = 0, fail = 0;
for (const c of C.cases) {
  try { const r = decide(c.in); assert.strictEqual(r.status, c.expect, `status ${r.status}(${r.reason})`); if (c.reason) assert.strictEqual(r.reason, c.reason, 'reason ' + r.reason); pass++; console.log(`  ✅ ${c.id} ${c.expect}${c.reason ? '(' + c.reason + ')' : ''}`); }
  catch (e) { fail++; console.log(`  ❌ ${c.id} → ${e.message}`); }
}
console.log(`\n[barcode link E2] ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
