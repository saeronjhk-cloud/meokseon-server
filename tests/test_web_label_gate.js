/** 세션79 — web_label 노출 품질 게이트 정답 셋(IP/eval_web_label_gate_v1 · 구현 전 고정). */
'use strict';
const assert = require('assert'); const G = require('../scripts/lib/web_label_gate');
const d = require('./fixtures/web_label_gate_v1.json');
let pass = 0, fail = 0; const t = (n, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log('  ✗ ' + n + ' — ' + e.message.split('\n')[0]); } };
for (const c of d.food_type) t(c.id, () => assert.strictEqual(G.cleanFoodType(c.in), c.out));
for (const c of d.nutrition_ok) t(c.id, () => assert.strictEqual(G.nutritionOk(c.in), c.out));
for (const c of d.allergen_check) t(c.id, () => assert.strictEqual(G.allergenCheck(c.label, c.inferred), c.out));
for (const c of d.status) t(c.id, () => assert.strictEqual(G.productStatus(c.in), c.out));
// ★ 세션80 v1.1 — K-FIND 교차확인 G01~G10 (IP/eval_kfind_expose_v1 = fixtures/kfind_expose_v1.json · 구현 전 고정)
const KF = require('./fixtures/kfind_expose_v1.json');
for (const c of KF.G_cases) t(c.id, () => { const r = G.kfindCheck(c.wl, c.cands); assert.deepStrictEqual(r ? { result: r.result, diff: r.diff } : null, c.expect); });
console.log(`[web_label gate v1.1] ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
