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
// ── ★ 세션73 — 승인 경로(contributionApply → additiveResolver.detectFromParsedIngredients)가
//   제보 직후 화면(경로 ① identifyAdditives)과 «같은» 첨가물을 낸다(호두정과: 승인 뒤 아스파탐 누락 사고).
//   ★ 세션75e — 화면 경로는 이제 analyzeText → additiveDetect(v2 · 구간 원문). 승인 경로도 v2(raw 이어 붙이기).
//     위 루프의 `identifyAdditives` 비교는 v1 «동결 기준선»(이 셋의 정답 additives 가 v1 출력이라)으로 남긴다 —
//     첨가물 «정확도»의 정답 셋은 IP/eval_additive_detect_v1 (tests/test_additive_detect_eval.js).
{
  const { detectFromParsedIngredients } = require('../src/services/additiveResolver');
  const bad = [];
  for (const c of cases) {
    const ings = P.parseIngredients(P.extractIngredientSection(c.text));
    // 저장 왕복(JSON)을 거친 모양으로 — contributions.data 는 jsonb 다
    const stored = JSON.parse(JSON.stringify(ings));
    const a = P.analyzeText(c.text).additives.map((x) => x.name);
    const b = (detectFromParsedIngredients(stored) || []).map((x) => x.name);
    if (JSON.stringify(a) !== JSON.stringify(b)) bad.push(`${c.id}: 화면 ${JSON.stringify(a)} · 승인 ${JSON.stringify(b)}`);
  }
  // 배선: contributionApply 의 첨가물 축이 이 함수를 «먼저» 쓴다(이름만 쓰는 경로로 되돌아가지 않게)
  const ca = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'contributionApply.js'), 'utf8');
  if (!/const detected = explicit \|\| detectFromParsedIngredients\(data && data\.parsed_ingredients\)/.test(ca)) bad.push('contributionApply 배선 없음');
  if (bad.length) { fail++; console.log(`  ❌ 승인 경로 ≠ 화면 경로 ${bad.length}건\n     ${bad.slice(0, 5).join('\n     ')}`); }
  else { pass++; console.log(`  ✅ 승인 경로 = 화면 경로 (첨가물 · ${cases.length}건 전부)`); }
}

console.log(`\n[ingredient section eval v1] 통과 ${pass}/${cases.length + 1} · 기준선 ${by.baseline.join('/')} · 정답 변경 ${by.fix.join('/')}`);
process.exit(fail ? 1 : 0);
