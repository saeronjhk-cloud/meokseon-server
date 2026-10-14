/** test_public_barcode_supplement.js — ★ 세션79 E8(정답 tests/fixtures/public_barcode_supplement_v1.json · 구현 전 고정) */
'use strict';
const assert = require('assert'); const C = require('./fixtures/public_barcode_supplement_v1.json'); const { planOne } = require('../scripts/110-public-barcode-supplement');
let pass = 0, fail = 0;
for (const c of C.cases) { try { assert.deepStrictEqual(planOne(c.in.web, c.in.pub), c.expect); pass++; console.log(`  ✅ ${c.id}`); } catch (e) { fail++; console.log(`  ❌ ${c.id} → ${JSON.stringify(planOne(c.in.web, c.in.pub))}`); } }
console.log(`\n[public barcode supplement E8] ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
