/**
 * ★ 세션73 U71-2 — 원재료 구간·분해·첨가물 eval (ingredient_section_eval_v1)
 *   정본 IP/eval_ingredient_section_v1/cases.json · 사본 tests/fixtures/ingredient_section_eval_v1.json
 *   비교: extractIngredientSection → parseIngredients 의 이름 목록 · identifyAdditives 이름 목록(순서 포함).
 *   kind: baseline(실물 전사 동결) · fix(정답 변경).
 */
const fs = require('fs');
const path = require('path');
const P = require('../src/services/ocrParser');
const { cases } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ingredient_section_eval_v1.json'), 'utf8'));
let pass = 0; let fail = 0; const by = { baseline: [0, 0], fix: [0, 0] };
for (const c of cases) {
  const ings = P.parseIngredients(P.extractIngredientSection(c.text));
  const got = { names: ings.map((i) => i.name), additives: P.identifyAdditives(ings).map((a) => a.name) };
  by[c.kind][1]++;
  const ok = JSON.stringify(got.names) === JSON.stringify(c.expected.names)
    && JSON.stringify(got.additives) === JSON.stringify(c.expected.additives);
  if (ok) { pass++; by[c.kind][0]++; continue; }
  fail++;
  console.log(`  ❌ ${c.id} [${c.kind}]\n     기대 ${JSON.stringify(c.expected)}\n     실제 ${JSON.stringify(got)}${c.why ? `\n     근거 ${c.why}` : ''}`);
}
console.log(`\n[ingredient section eval v1] 통과 ${pass}/${cases.length} · 기준선 ${by.baseline.join('/')} · 정답 변경 ${by.fix.join('/')}`);
process.exit(fail ? 1 : 0);
