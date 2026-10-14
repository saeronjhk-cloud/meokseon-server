/** 세션79 — web_label 노출 품질 게이트 정답 셋(IP/eval_web_label_gate_v1 · 구현 전 고정). */
'use strict';
const assert = require('assert'); const G = require('../scripts/lib/web_label_gate');
const d = require('./fixtures/web_label_gate_v1.json');
let pass = 0, fail = 0; const t = (n, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log('  ✗ ' + n + ' — ' + e.message.split('\n')[0]); } };
for (const c of d.food_type) t(c.id, () => assert.strictEqual(G.cleanFoodType(c.in), c.out));
for (const c of d.nutrition_ok) t(c.id, () => assert.strictEqual(G.nutritionOk(c.in), c.out));
for (const c of d.allergen_check) t(c.id, () => assert.strictEqual(G.allergenCheck(c.label, c.inferred), c.out));
for (const c of d.status) t(c.id, () => assert.strictEqual(G.productStatus(c.in), c.out));
console.log(`[web_label gate v1] ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
