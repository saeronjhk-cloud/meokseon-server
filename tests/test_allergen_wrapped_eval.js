/**
 * 세션79 — 줄 감김 알레르기 선언(앞줄이 쉼표로 끝나는 19종 이름 목록 ⏎ 다음 줄 …함유).
 *   정본 IP/eval_allergen_wrapped_v1/cases_v1.json · 사본 tests/fixtures/allergen_wrapped_v1.json
 *   양성 26(판매처 라벨 실물) + 음성 5 · 구현 전 고정 · 정답 정정 2건 기록(W27 제외 · W16 3줄) · 알려진 한계 2건(W09 · W17).
 *   기준선 7/32 → 29/31(한계 2 제외 전부). 실제 분포 1,068 문서: 변화 22 · 전부 «추가» · 제거 0.
 */
'use strict';
const fs = require('fs'); const path = require('path'); const assert = require('assert');
const P = require('../src/services/ocrParser');
const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'allergen_wrapped_v1.json'), 'utf8'));
const LIMIT = new Set((d.known_limits || []).map((x) => x.id));
const pick = (v) => ({ contains: [...(v.contains || [])].sort(), mayContain: [...(v.mayContain || [])].sort(), declarationFound: !!v.declarationFound });
let pass = 0; let fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n     ' + e.message.split('\n').slice(0, 6).join('\n     ')); } };
for (const c of d.cases) {
  if (LIMIT.has(c.id)) {
    t(`${c.id} [알려진 한계] 종전보다 «줄지» 않는다`, () => {
      const g = pick(P.detectAllergensV2(c.text)); for (const a of c.baseline.contains) assert.ok(g.contains.includes(a), a + ' 소실');
    });
    continue;
  }
  t(`${c.id} [${c.kind}] ${c.why.slice(0, 50)}`, () => assert.deepStrictEqual(pick(P.detectAllergensV2(c.text)), c.expected));
}
t('「함유한 제품과 같은 시설」(혼입 고지)은 선언으로 잇지 않는다', () => {
  const v = P.detectAllergensV2('본 제품은 대두, 우유, 계란,\n토마토, 닭고기를 함유한 제품과 같은 제조시설에서 제조합니다.');
  assert.ok(!v.contains.includes('대두') && !v.contains.includes('우유'), JSON.stringify(v.contains));
});
t('사용자 사진 경로(analyzeText)도 같은 결과', () => {
  const r = P.analyzeText('원재료명: 소맥분, 정제수\n밀, 대두, 계란, 우유, 쇠고기,\n오징어, 새우 함유\n소비기한: 별도표기');
  const c = (r.allergens_v2 && r.allergens_v2.contains) || (r.allergens && r.allergens.contains) || [];
  for (const a of ['밀', '대두', '난류(가금류)', '우유', '쇠고기', '오징어', '새우']) assert.ok(c.includes(a), a + ' 없음: ' + JSON.stringify(c));
});
t('ReDoS 백스톱 — 쉼표 줄 5천 줄 200ms 안', () => {
  const s = '밀, 대두,\n'.repeat(5000) + '우유 함유'; const t0 = Date.now(); P.detectAllergensV2(s); assert.ok(Date.now() - t0 < 200, `${Date.now() - t0}ms`);
});
console.log(`\n[allergen wrapped eval v1] ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
