/**
 * ★★★ 세션72 — 알레르기 자동 반영 게이트 eval (Eval-First 게이트)
 *
 * 무엇: `IP/eval_allergen_auto_v1` 의 라벨 32건(제이 사진 GT 29건)을 «운영 게이트 함수»
 *   `allergenAutoGate.evaluateAllergenAutoGate` 로 채점한다. 채점 규칙은 `rescore_v2.py` 와 같다.
 * 게이트(이 테스트가 빨개지는 조건):
 *   · 자동 반영된 건 중 치명(함유 누락 · 함유→혼입 · 혼입을 일부 읽었는데 빠짐) ≥ 1
 *   · 자동 반영된 건 중 경미(혼입→함유 · 근거 없는 이름 = 과잉경고) ≥ 1 — 「과잉경고도 오류다」(세션71)
 *   · 자동 반영 건수 < 세션71 기준선 23 (게이트가 조용히 닫혀 «전부 큐»가 되는 퇴행)
 * 혼입을 «하나도» 못 읽은 건(cap001 류)은 치명이 아니라 «미확인손실»로 따로 센다 —
 *   그 경우 화면이 「혼입 정보 미확인」을 말한다(대책3). 그 신호가 살아 있는지도 단정한다.
 */
const path = require('path');
const fx = require(path.join(__dirname, 'fixtures', 'allergen_auto_gate_eval_v1.json'));
const { evaluateAllergenAutoGate } = require('../src/services/allergenAutoGate');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  ✅', m); else { fails++; console.log('  ❌', m); } };

const agg = { auto: 0, queue: 0, crit: 0, minor: 0, exact: 0, excluded: 0, may_unconfirmed: 0 };
const detail = [];
for (const c of fx.cases) {
  if (!c.done) { agg.excluded++; continue; }
  const g = evaluateAllergenAutoGate({ text: c.text });
  const gc = new Set(c.gt_contains); const gm = new Set(c.gt_may);
  const pc = new Set(g.contains); const pm = new Set(g.may_contain);
  const pAll = new Set([...pc, ...pm]);
  const crit = [
    ...[...gc].filter((a) => !pAll.has(a)).map((a) => `함유누락:${a}`),
    ...[...gc].filter((a) => !pc.has(a) && pm.has(a)).map((a) => `함유→혼입:${a}`),
  ];
  const mayLoss = [...gm].filter((a) => !pAll.has(a)).map((a) => `혼입누락:${a}`);
  if (g.may_inspected) crit.push(...mayLoss);
  const minor = [
    ...[...pc].filter((a) => gm.has(a)).map((a) => `혼입→함유:${a}`),
    ...[...pAll].filter((a) => !gc.has(a) && !gm.has(a)).map((a) => `근거없음:${a}`),
  ];
  if (g.pass) {
    agg.auto++;
    if (crit.length) agg.crit++; else if (minor.length) agg.minor++; else agg.exact++;
    if (!g.may_inspected && mayLoss.length) agg.may_unconfirmed++;
  } else agg.queue++;
  if (g.pass && (crit.length || minor.length)) detail.push({ key: c.key, crit, minor });
}

console.log('\n[allergen auto gate eval v1]', JSON.stringify(agg));
for (const d of detail) console.log('   ', d.key, JSON.stringify(d));

ok(agg.crit === 0, `자동 반영 치명 0 (실측 ${agg.crit})`);
ok(agg.minor === 0, `자동 반영 경미(과잉경고 포함) 0 (실측 ${agg.minor})`);
ok(agg.auto >= fx._baseline_session71.auto, `자동 반영 건수 ≥ 기준선 ${fx._baseline_session71.auto} (실측 ${agg.auto})`);
ok(agg.auto + agg.queue + agg.excluded === fx.cases.length, '케이스 누락 없음');

// ── 서버 경로 조건 ④⑤ ──
const T = '알레르기 유발물질: 밀, 대두 함유\n이 제품은 우유를 사용한 제품과 같은 제조시설에서 제조';
ok(evaluateAllergenAutoGate({ text: T }).pass === true, '기본 문장 통과');
ok(evaluateAllergenAutoGate({ text: T, storedV2: { contains: ['밀', '대두'], mayContain: ['우유'], inferred: [] } }).pass === true,
  '⑤ 저장본 == 파서 → 통과');
ok(evaluateAllergenAutoGate({ text: T, storedV2: { contains: ['밀', '대두', '우유'], mayContain: [], inferred: [] } }).reason === 'STORED_MISMATCH',
  '⑤ 사용자 수정(혼입→함유) → 큐');
ok(evaluateAllergenAutoGate({ text: T, storedV2: { contains: ['밀', '대두'], mayContain: ['우유'], inferred: ['새우'] } }).reason === 'STORED_MISMATCH',
  '④ 저장본에 inferred → 큐');
ok(evaluateAllergenAutoGate({ text: '' }).reason === 'NO_TEXT', '빈 텍스트 → 큐');
ok(evaluateAllergenAutoGate({ text: '원재료명: 밀가루, 설탕' }).pass === false, '표시란 없음(원재료명만) → 큐 (DS-6′)');
const noMay = evaluateAllergenAutoGate({ text: '알레르기 유발물질: 밀, 대두 함유' });
ok(noMay.pass === true && noMay.may_inspected === false, '혼입 문장 없음 → 통과하되 may_inspected=false(「혼입 정보 미확인」)');

console.log(fails ? `\n❌ ${fails} 실패` : '\n✅ allergen auto gate 전부 통과');
process.exit(fails ? 1 : 0);
