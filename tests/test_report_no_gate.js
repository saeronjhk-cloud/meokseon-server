/** test_report_no_gate.js — ★ 세션78 품목보고번호 동일품목 게이트. 정답 tests/fixtures/report_no_gate_v1.json(구현 전 고정) */
'use strict';
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const { reportNoGate } = require('../scripts/lib/report_no_gate');
let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log(`  ✅ ${n}`); } catch (e) { fail++; console.log(`  ❌ ${n}\n     → ${e.message}`); } }
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'report_no_gate_v1.json'), 'utf8'));
for (const c of fx.cases) t(`${c.id} ${c.src} → ${c.expect}`, () => { const r = reportNoGate(c.text, c.db); assert.strictEqual(r.status, c.expect, JSON.stringify(r)); });
t('ReDoS 백스톱 — 9,900자 입력 120ms 미만', () => { for (const s of ['품목보고번호'.repeat(1600), '품목보고번호 ' + '1 '.repeat(4900)]) { const t0 = Date.now(); reportNoGate(s, '1976048700519'); assert.ok(Date.now() - t0 < 120); } });
console.log(`\n  결과: ${pass} 통과 · ${fail} 실패`); process.exit(fail ? 1 : 0);
