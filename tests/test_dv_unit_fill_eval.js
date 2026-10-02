/**
 * ★ 세션73 U71-1 — 단위만 빠진 영양값을 %열 검증으로 채우기 eval (dv_unit_fill_eval_v1)
 *   제이 결정(2026-10-02): 「엄격 조건으로 채움」. 숫자는 원문 그대로 · 단위만 영양소별 고정값.
 *   정본 IP/eval_dv_unit_fill_v1/cases.json · 사본 tests/fixtures/dv_unit_fill_eval_v1.json
 *   kind: baseline(기준선 동결 · 실물 전사 전부) · fill(채워야 함) · no(채우면 안 됨)
 */
const fs = require('fs');
const path = require('path');
const { parseNutrition } = require('../src/services/ocrParser');
const KEYS = ['calories', 'sodium', 'total_carbs', 'total_sugars', 'total_fat', 'saturated_fat', 'trans_fat', 'cholesterol', 'protein', 'dietary_fiber'];
const { cases } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'dv_unit_fill_eval_v1.json'), 'utf8'));
let pass = 0; let fail = 0;
const by = { baseline: [0, 0], fill: [0, 0], no: [0, 0] };
for (const c of cases) {
  const n = parseNutrition(c.text);
  const got = {}; for (const k of KEYS) got[k] = n[k] === undefined ? null : n[k];
  const diff = KEYS.filter((k) => got[k] !== c.expected[k]);
  by[c.kind][1]++;
  if (!diff.length) { pass++; by[c.kind][0]++; continue; }
  fail++;
  console.log(`  ❌ ${c.id} [${c.kind}] ${diff.map((k) => `${k}: 기대 ${c.expected[k]} · 실제 ${got[k]}`).join(' / ')}${c.why ? ` — ${c.why}` : ''}`);
}
console.log(`\n[dv unit fill eval v1] 통과 ${pass}/${cases.length} · 기준선 ${by.baseline.join('/')} · 채움 ${by.fill.join('/')} · 금지 ${by.no.join('/')}`);
process.exit(fail ? 1 : 0);
