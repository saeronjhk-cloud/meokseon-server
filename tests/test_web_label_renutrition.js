/** test_web_label_renutrition.js — ★ 세션81 115 순수 판정 recompute. 정답 label_basis_anchor_v1(A·B 는 바뀜 · R·X 는 그대로). */
'use strict';
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const { recompute } = require('../scripts/115-web-label-renutrition');
const D = path.join(__dirname, 'fixtures', 'label_basis_anchor_v1'); const fx = JSON.parse(fs.readFileSync(path.join(D, 'cases_v1.json'), 'utf8'));
let pass = 0, fail = 0; const t = (n, fn) => { try { fn(); pass++; console.log(`  ✅ ${n}`); } catch (e) { fail++; console.log(`  ❌ ${n}\n     → ${e.message}`); } };
for (const c of fx.cases) {
  t(`${c.id} ${c.cls} ${c.name}`, () => {
    const text = fs.readFileSync(path.join(D, c.id + '.txt'), 'utf8');
    // 옛 저장값 재현: A = 열량 그대로(100g 로 오인) · B = 총량으로 나눈 값 · R/X = 지금 값
    const old = c.cls === 'A' ? c.want.calories : c.cls === 'B' ? c.want.calories / ({ 306387: 480, 306408: 480, 307192: 780, 307913: 580, 307914: 812, 307645: 300 }[c.id]) * 100 : null;
    const curR = c.cls === 'R' || c.cls === 'X' ? (c.want.kcal_per100 ?? c.want.calories) : old;
    const r = recompute({ calories: curR }, text);
    if (c.cls === 'A' || c.cls === 'B') { assert.ok(r, '바뀌어야 한다'); assert.ok(Math.abs(r.to - c.want.kcal_per100) < 0.6, `to ${r.to} want ${c.want.kcal_per100}`); }
    else if (c.cls === 'R' && c.want.basis !== 'per_total') assert.strictEqual(r, null, `바뀌면 안 된다 ${r && r.to}`);
  });
}
t('원문 없음·현재 열량 없음 → null', () => { assert.strictEqual(recompute({ calories: 100 }, ''), null); assert.strictEqual(recompute({ calories: null }, '100g당 300 kcal'), null); });
console.log(`\n${pass} 통과 · ${fail} 실패`); process.exit(fail ? 1 : 0);
