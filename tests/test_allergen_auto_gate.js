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
ok(agg.auto >= fx._baseline_session72.auto, `자동 반영 건수 ≥ 기준선 ${fx._baseline_session72.auto} (세션72 U72-8 · 실측 ${agg.auto})`);
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

// ── 세션72 U72-8 — residue v2 ──
const { declarationResidue, ALLERGEN_NAMES } = require('../src/services/ocrParser');
const c15 = fx.cases.find((c) => c.key === 'real:306268_c15');
ok(c15 && evaluateAllergenAutoGate({ text: c15.text }).pass === true, 'U72-8 실물 306268 — 원재료 꼬리 `라향` 은 오독이 아니다(자동 반영)');
ok(evaluateAllergenAutoGate({ text: '원재료명: 설탕, 정제소금, 토코페롤 일, 대두 함유' }).reason === 'RESIDUE',
  'U72-8 ③ 같은 줄 원재료+선언 — `일`(밀 오독)을 경계 검사로 잡는다(v1 은 통과시켰다 = 밀 누락 자동 반영)');
ok(evaluateAllergenAutoGate({ text: '알레르기 유발물질: 일, 대두 함유' }).reason === 'RESIDUE', 'U72-8 ① 표시어 있는 선언은 종전대로 엄격');
ok(evaluateAllergenAutoGate({ text: '원재료명: 설탕, 바닐\n라향, 스테비아, 토코페롤 우유, 대두 함유' }).pass === true, 'U72-8 ② 표시어 없는 선언의 원재료 꼬리 → 통과');
// 뮤턴트 회귀: 2음절 이하 이름의 자모 1개 오독을 «같은 줄 원재료+선언»에 넣었을 때 놓치는 수 ≤ 기준선(불용어 충돌만)
{
  const CHO = 19, JUNG = 21, JONG = 28;
  const names = new Set(Object.values(ALLERGEN_NAMES).flat());
  const muts = (n) => { const out = new Set(); const ch = [...n];
    ch.forEach((c0, i) => { const c = c0.charCodeAt(0) - 0xAC00; const a = Math.floor(c / 588), b = Math.floor((c % 588) / 28), z = c % 28;
      const put = (x, y, w) => out.add([...ch.slice(0, i), String.fromCharCode(0xAC00 + x * 588 + y * 28 + w), ...ch.slice(i + 1)].join(''));
      for (let x = 0; x < CHO; x++) if (x !== a) put(x, b, z);
      for (let y = 0; y < JUNG; y++) if (y !== b) put(a, y, z);
      for (let w = 0; w < JONG; w++) if (w !== z) put(a, b, w); });
    return [...out].filter((t) => !names.has(t)); };
  let tot = 0, missed = 0;
  for (const n of ['우유', '메밀', '땅콩', '대두', '밀', '게', '새우', '호두', '잣', '굴']) for (const t of muts(n)) {
    if (n === '대두' && t.startsWith('대')) continue;
    tot++;
    if (evaluateAllergenAutoGate({ text: `원재료명: 설탕, 정제소금, 토코페롤 ${t}, 대두 함유` }).pass) missed++;
  }
  ok(missed <= fx._baseline_session72.mut1_glued_max_missed, `U72-8 뮤턴트(같은 줄) 놓침 ${missed}/${tot} ≤ ${fx._baseline_session72.mut1_glued_max_missed} (v1: 974/975)`);
}

console.log(fails ? `\n❌ ${fails} 실패` : '\n✅ allergen auto gate 전부 통과');
process.exit(fails ? 1 : 0);
