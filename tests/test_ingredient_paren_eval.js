/**
 * 세션79 (U78-4 · 롯데자일리톨 제보) — 원재료 구역 괄호 불균형 복구 정답 셋.
 *   정본 IP/eval_ingredient_paren_v1/cases_v1.json · 사본 tests/fixtures/ingredient_paren_v1.json (13건 · 구현 전 고정)
 *   기대 = 사람이 괄호 오류«만» 고친 corrected 를 «고치기 전» parseIngredients 로 파싱한 이름(공백 제거 비교).
 *   기준선 4/13 → 13/13. 균형 잡힌 구역은 무변경(eval_ingredient_section_v1 69/69 가 가드).
 */
'use strict';
const fs = require('fs'); const path = require('path'); const assert = require('assert');
const P = require('../src/services/ocrParser');
const doc = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ingredient_paren_v1.json'), 'utf8'));
let pass = 0; let fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n     ' + e.message.split('\n').slice(0, 4).join('\n     ')); } };
const nm = (s) => P.parseIngredients(s).map((i) => i.name.replace(/\s+/g, ''));
for (const c of doc.cases) {
  t(`${c.id} [${c.kind}] ${c.why.slice(0, 40)}`, () => {
    assert.deepStrictEqual(nm(c.section), c.expected_names);
    if (c.expected_details) assert.deepStrictEqual(P.parseIngredients(c.section).map((i) => i.detail), c.expected_details);
  });
}
t('균형 잡힌 텍스트는 _balanceBrackets 가 한 글자도 바꾸지 않는다', () => {
  for (const s of ['밀가루(밀:미국산), 설탕', '혼합제제[정제수, 스모크향(향료)], 비타민C', '(…]', '']) assert.strictEqual(P._balanceBrackets(s), s);
});
t('잘린 구역(닫는 괄호로 끝나지 않음)은 닫지 않는다 — 종전 그대로', () => {
  const s = '밀가루, 혼합제제(정제수, 향료, 덱스트린'; assert.strictEqual(P._balanceBrackets(s), s);
});
t('analyzeText 원재료 항목에 detail 이 실린다(화면 「감미료(자일리톨)」)', () => {
  // 운영 제보 contribution 32(롯데자일리톨) Vision 원문 그대로(주소 한 글자 깨짐은 79a 수정 전 수집분이라 복원해 둠)
  const OCR32 = 'LOTT\nOPEN\n•원재료명:감미료(자일리톨), 껌베이스(감미료(효소처리스테비아), 감미료(이소말트, D-소비톨, D-말티톨)\n우유함유 당알코올(자일리톨37%, 이소말트19 %, D-소비톨5 %, D-말티톨5 %, 말티톨액1%)\n당알코올 함유 제품으로 과량 섭취 시 설사를 일으킬 수 있습니다. ·식품유형:추잉껌·소비기한:측면 표기일까지\n(연월.일)•제조판매원:롯데웰푸드㈜ 서울시 영등포구 양평로21길 25• 품목보고번호:19690086003590';
  const r = P.analyzeText(OCR32);
  const it = r.ingredients.map((i) => [i.name, i.detail]);
  assert.deepStrictEqual(it, [['감미료', '자일리톨'], ['껌베이스', '감미료(효소처리스테비아)'], ['감미료', '이소말트, D-소비톨, D-말티톨']]);
});
t('ReDoS 백스톱 — 괄호 1만 개 불균형 입력이 200ms 안', () => {
  const s = '가('.repeat(5000) + ')'.repeat(10) + '\n[나'.repeat(2000); const t0 = Date.now(); P._balanceBrackets(s); P.parseIngredients(s);
  assert.ok(Date.now() - t0 < 200, `${Date.now() - t0}ms`);
});
console.log(`\n[ingredient paren eval v1] ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
