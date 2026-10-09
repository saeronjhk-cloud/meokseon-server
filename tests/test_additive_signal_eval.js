/**
 * ★ 세션75g — 첨가물 신호등 v3 eval (gold_v1 · 30종 · 동결 2026-10-05)
 *   정본 IP/첨가물신호등_v3/gold_v1.json · 사본 tests/fixtures/additive_signal_gold_v1.json
 *   합격선: 색 30/30 일치 + 핵심 배지(불일치 · IARC 문구 · 조합 · 폴리올 · 불순물) 단정.
 * 실행: cross-env NODE_ENV=test node tests/test_additive_signal_eval.js
 */
'use strict';
const assert = require('assert');
const { classifyAdditive, attachSignals, IARC_NOTE, _indexEvidence } = require('../src/services/additiveSignal');
const G = require('./fixtures/additive_signal_gold_v1.json');
const GX = require('./fixtures/additive_signal_gold_v1.1_ext.json');
const GX2 = require('./fixtures/additive_signal_gold_v1.2_ext.json'); // 세션76 U75-3 · 61종

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.log(`  ❌ ${name}\n     → ${e.message}`); } }
const EMOJI2COLOR = { '🔴': 'red', '🟠': 'orange', '🟡': 'yellow', '🟢': 'green', '⚪': 'gray', '🔵': 'blue' };
const has = (s, code) => s.badges.some((b) => b.code === code);
const AS_OF = 2026;

console.log('\n══ 세션75g — 첨가물 신호등 v3 ══');
t('gold_v1 30종 — 색 30/30', () => {
  assert.strictEqual(G.items.length, 30, '정답 수가 바뀌었다 — 동결 정답을 고쳤다면 사유 기록 후 이 단정 갱신');
  const bad = [];
  for (const g of G.items) {
    const s = classifyAdditive(g.additive, { asOfYear: AS_OF });
    if (s.color !== EMOJI2COLOR[g.final]) bad.push(`${g.additive} 정답 ${g.final} · 엔진 ${s.emoji}(${s.rule}: ${s.reason})`);
  }
  assert.ok(bad.length === 0, `${30 - bad.length}/30\n     ${bad.join('\n     ')}`);
});
t('규칙 경로 — 대표 물질이 설계 규칙으로 판정된다', () => {
  const rule = (n) => classifyAdditive(n, { asOfYear: AS_OF }).rule;
  assert.strictEqual(rule('향료'), 'R0');
  assert.strictEqual(rule('이산화티타늄'), 'R2');
  assert.strictEqual(rule('아스파탐'), 'R3b');
  assert.strictEqual(rule('부틸히드록시아니솔'), 'R3b');
  assert.strictEqual(rule('아질산나트륨'), 'R4');
  assert.strictEqual(rule('메타중아황산칼륨'), 'R4');
  assert.strictEqual(rule('식용색소적색제40호'), 'R4');
  assert.strictEqual(rule('L-글루탐산나트륨'), 'R5');
  assert.strictEqual(rule('구연산'), 'R6');
  assert.strictEqual(rule('없는물질이름'), 'R1');
});
t('기관 충돌 — 최신 평가 우선 + 불일치 배지', () => {
  const msg = classifyAdditive('L-글루탐산나트륨', { asOfYear: AS_OF });
  assert.ok(has(msg, 'agency_conflict'), JSON.stringify(msg.badges));
  assert.ok(has(classifyAdditive('카라기난', { asOfYear: AS_OF }), 'agency_conflict'));
  assert.ok(has(classifyAdditive('카라기난', { asOfYear: AS_OF }), 'temporary'));
  assert.ok(has(classifyAdditive('이산화티타늄', { asOfYear: AS_OF }), 'agency_conflict'), 'TiO2: EFSA 2021 vs JECFA 2023');
  assert.ok(has(classifyAdditive('안식향산나트륨', { asOfYear: AS_OF }), 'adi_differs'));
});
t('IARC — 식품 경로만 색 · 문구 고정 · 흡입/맥락은 배지', () => {
  assert.strictEqual(classifyAdditive('아스파탐', { asOfYear: AS_OF }).iarc_note, IARC_NOTE);
  const tio2 = classifyAdditive('이산화티타늄', { asOfYear: AS_OF });
  assert.ok(has(tio2, 'iarc_non_food'));
  const nit = classifyAdditive('아질산나트륨', { asOfYear: AS_OF });
  assert.ok(has(nit, 'iarc_context'), JSON.stringify(nit.badges));
  assert.ok(/물질 자체 등급은 아니/.test(nit.reason));
  assert.strictEqual(classifyAdditive('사카린나트륨', { asOfYear: AS_OF }).iarc_note, null, 'IARC 3 은 문구 불필요');
});
t('배지는 색을 바꾸지 않는다 — 조합 · 폴리올 · 불순물 · 고섭취 · PKU', () => {
  const ben = classifyAdditive('안식향산나트륨', { asOfYear: AS_OF });
  assert.ok(ben.color === 'yellow' && has(ben, 'combo_risk') && has(ben, 'high_consumer_concern'));
  const sor = classifyAdditive('D-소비톨', { asOfYear: AS_OF });
  assert.ok(sor.color === 'green' && has(sor, 'warning_label_polyol'));
  const car = classifyAdditive('카라멜색소', { asOfYear: AS_OF });
  assert.ok(car.color === 'yellow' && has(car, 'impurity_spec'));
  const asp = classifyAdditive('아스파탐', { asOfYear: AS_OF });
  assert.ok(has(asp, 'warning_label_pku'));
  assert.ok(has(classifyAdditive('구연산', { asOfYear: AS_OF }), 'old_evaluation'));
});
t('이름 변형 — 카라멜색소IV → 카라멜색소 근거 + 번호 배지 · class_only → R0', () => {
  const c4 = classifyAdditive('카라멜색소IV', { asOfYear: AS_OF });
  assert.strictEqual(c4.evidence_key, '카라멜색소');
  assert.strictEqual(c4.color, 'yellow');
  assert.strictEqual(classifyAdditive('산화방지제', { matchType: 'class_only' }).rule, 'R0');
});
t('국내 기준 병기 — 공전 사용기준 한 줄', () => {
  assert.ok(/일부 식품군 사용 금지/.test(classifyAdditive('이산화티타늄').domestic.text));
  assert.ok(/일반 사용기준/.test(classifyAdditive('구연산').domestic.text));
  assert.ok(/종류\(I·II·III·IV\)별/.test(classifyAdditive('카라멜색소').domestic.text));
  assert.strictEqual(classifyAdditive('없는물질이름').domestic.listed, false);
});
t('attachSignals — 입력 불변 · signal 부착', () => {
  const inp = [{ name: '아스파탐', match_type: 'exact' }, { name: '유화제', match_type: 'class_only' }];
  const snap = JSON.stringify(inp);
  const o = attachSignals(inp);
  assert.strictEqual(JSON.stringify(inp), snap);
  assert.deepStrictEqual(o.map((x) => x.signal.color), ['orange', 'gray']);
});
t('뮤테이션 — IARC 행을 route=inhalation 으로 바꾸면 아스파탐은 🟠→🟡 (route 게이트가 실제로 작동)', () => {
  const EV = require('../src/data/additive_evidence.json');
  const rows = EV.rows.map((r) => (r.additive === '아스파탐' && r.source === 'IARC' ? { ...r, route: 'inhalation' } : r))
    .filter((r) => !(r.additive === '아스파탐' && r.finding === 'warning_label_pku'));
  const s = classifyAdditive('아스파탐', { evidenceIndex: _indexEvidence({ rows }), asOfYear: AS_OF });
  assert.strictEqual(s.color, 'yellow');
});

t('75g-4 — 같은 기관 안 용도별 결론 차이는 불일치 아님(바닐린) · IARC 3 맥락 행은 배지 없음(이산화규소)', () => {
  assert.ok(!has(classifyAdditive('바닐린', { asOfYear: AS_OF }), 'agency_conflict'));
  assert.ok(!has(classifyAdditive('이산화규소', { asOfYear: AS_OF }), 'iarc_context'));
  assert.ok(has(classifyAdditive('d-토코페롤(혼합형)', { asOfYear: AS_OF }), 'agency_conflict'), '기관 사이 불일치는 유지');
});
t('75g-4 — 화면 문구는 한글: 근거 DB 전 물질의 이유·배지에 영어 문장 없음', () => {
  const EV = require('../src/data/additive_evidence.json');
  // 75j: «not specified/limited» 영어 노출이 실화면에서 발견 → 허용 목록에서 뺐다
  const ALLOWED = /\b(IARC|EFSA|JECFA|SCF|FDA|IOM|EU_REG|ADI|MCPD|MEI|mg|kg|bw|day)\b/g;
  const bad = [];
  for (const n of new Set(EV.rows.map((r) => r.additive))) {
    const s = classifyAdditive(n, { asOfYear: AS_OF });
    for (const txt of [s.reason, ...s.badges.map((b) => b.text)]) {
      if (/[A-Za-z]{4,}/.test(txt.replace(ALLOWED, ''))) bad.push(`${n}: ${txt}`);
    }
  }
  assert.ok(bad.length === 0, bad.join('\n     '));
});
t('75g-4 — 부분 철회는 R2 아님(CMC 영유아 특수의료식품 한정) · ADI 미배정은 ⚪ 이유 구분', () => {
  assert.strictEqual(classifyAdditive('카복시메틸셀룰로스나트륨', { asOfYear: AS_OF }).color, 'green');
  assert.ok(/ADI를 정하지 않았/.test(classifyAdditive('홍화황색소', { asOfYear: AS_OF }).reason));
  assert.ok(/평가 기록을 찾지 못/.test(classifyAdditive('치자황색소', { asOfYear: AS_OF }).reason));
});

t('뮤테이션 보강 — 같은 기관·같은 해 결론이 둘이면 보호적인 쪽이 그 기관 대표(행 순서 무관)', () => {
  const mk = (rows) => _indexEvidence({ rows: rows.map((r) => ({ additive: 'X', unit: 'mg/kg bw/day', value: null, route: null, ...r })) });
  const rows = [
    { source: 'JECFA', finding: 'adi_not_specified', year: 2001 },
    { source: 'JECFA', finding: 'adi_numeric', value: 10, year: 2001 },
    { source: 'EFSA', finding: 'adi_numeric', value: 10, year: 1999 },
  ];
  for (const order of [rows, rows.slice().reverse()]) {
    const s = classifyAdditive('X', { evidenceIndex: mk(order), asOfYear: AS_OF });
    assert.strictEqual(s.color, 'yellow');
    assert.ok(!has(s, 'agency_conflict'), JSON.stringify(s.badges));
  }
});
t('gold_v1.1_ext 10종 — 영양강화 🔵(제이 결정 10-05) · 첨가물 평가 우선 · 색+규칙 일치', () => {
  assert.strictEqual(GX.items.length, 10);
  const bad = [];
  for (const g of GX.items) {
    const s = classifyAdditive(g.additive, { asOfYear: AS_OF });
    if (s.color !== EMOJI2COLOR[g.final] || s.rule !== g.rule) bad.push(`${g.additive} 정답 ${g.final}/${g.rule} · 엔진 ${s.emoji}/${s.rule}(${s.reason})`);
  }
  assert.ok(bad.length === 0, bad.join('\n     '));
  assert.ok(/성인 상한섭취량 100 µg\/일\(EFSA 2023\)/.test(classifyAdditive('비타민D3').reason), classifyAdditive('비타민D3').reason);
  assert.ok(/상한섭취량 미설정/.test(classifyAdditive('비타민B1염산염').reason));
});

t('75j — ⚪ 이름 구분(R0 성분 특정 불가 / 그 밖 자료 부족) · 용도명은 국내 기준 줄 없음', () => {
  assert.strictEqual(classifyAdditive('향료').color_label, '성분 특정 불가');
  assert.strictEqual(classifyAdditive('없는물질이름').color_label, '자료 부족');
  assert.strictEqual(classifyAdditive('산도조절제', { matchType: 'class_only' }).domestic, null);
  assert.ok(/ADI 제한 불필요/.test(classifyAdditive('구연산').reason));
});

// ══ 세션76 U75-3 — 근거 확장 v1.2(빈도 61~124위 61종) ══
t('gold_v1.2_ext 61종 — 색+규칙 61/61 (prior 51 확인 · 근거/규칙 해소 10)', () => {
  assert.strictEqual(GX2.items.length, 61, '정답 수가 바뀌었다 — 사유 기록 후 갱신');
  const bad = [];
  for (const g of GX2.items) {
    const s = classifyAdditive(g.additive, { asOfYear: AS_OF });
    if (s.color !== EMOJI2COLOR[g.final] || s.rule !== g.rule) bad.push(`${g.additive} 정답 ${g.final}/${g.rule} · 엔진 ${s.emoji}/${s.rule}(${s.reason})`);
  }
  assert.ok(bad.length === 0, `${61 - bad.length}/61\n     ${bad.join('\n     ')}`);
});
t('R7a — 최신 결론이 «ADI 설정 불가»면 ⚪ · R6n 보다 우선(β-카로틴) · 더 새 ADI 가 오면 🟡(뮤테이션)', () => {
  const b = classifyAdditive('β-카로틴', { asOfYear: AS_OF });
  assert.strictEqual(b.rule, 'R7'); assert.ok(/2019/.test(b.reason), b.reason); assert.ok(has(b, 'adi_withdrawn'));
  const EV = require('../src/data/additive_evidence.json');
  const rows = EV.rows.concat([{ additive: 'β-카로틴', source: 'EFSA', finding: 'adi_numeric', value: 1, unit: 'mg/kg bw/day', year: 2027, route: null }]);
  assert.strictEqual(classifyAdditive('β-카로틴', { evidenceIndex: _indexEvidence({ rows }), asOfYear: 2027 }).color, 'yellow');
  assert.strictEqual(classifyAdditive('안나토색소', { asOfYear: AS_OF }).color, 'yellow', '옛 no_adi(2006 오일추출 한정)는 더 새 ADI 를 이기지 못함');
});
t('proxy 원칙 — 다른 물질·다른 용도 평가(adi_cited)는 색을 만들지 않는다', () => {
  assert.strictEqual(classifyAdditive('적양배추색소', { asOfYear: AS_OF }).color, 'gray', '포도과피추출물 ADI 로 🟡 되면 안 됨');
  assert.strictEqual(classifyAdditive('dl-α-토코페릴아세테이트', { asOfYear: AS_OF }).rule, 'R6n');
  assert.ok(/자료 부족으로 상한섭취량 미설정\(IOM 2005\)/.test(classifyAdditive('L-로이신').reason));
  const EV = require('../src/data/additive_evidence.json');
  const rows = EV.rows.map((r) => (r.additive === '적양배추색소' && r.finding === 'adi_cited' ? { ...r, finding: 'adi_numeric', year: 2020 } : r)); // 2013 EFSA «설정 불가»보다 새로워야 R7a 를 넘는다
  assert.strictEqual(classifyAdditive('적양배추색소', { evidenceIndex: _indexEvidence({ rows }), asOfYear: AS_OF }).color, 'yellow', '뮤테이션: 게이트가 finding 으로 작동');
});
t('다른 용도 우려·대체된 결론은 🔴 아님 · 훈연향은 🔴 R2(사유 한글 덮어쓰기)', () => {
  const h = classifyAdditive('홍국색소', { asOfYear: AS_OF });
  assert.strictEqual(h.color, 'gray'); assert.ok(has(h, 'other_use_concern'));
  assert.strictEqual(classifyAdditive('트랜스글루타미나아제', { asOfYear: AS_OF }).color, 'green');
  const sm = classifyAdditive('스모크향', { asOfYear: AS_OF });
  assert.strictEqual(sm.rule, 'R2'); assert.ok(/훈연향/.test(sm.reason) && !/식품첨가물 승인/.test(sm.reason), sm.reason);
  assert.ok(!has(sm, 'agency_conflict'), 'JECFA 1987 잠정 수용은 adi_cited — 불일치 배지 없음');
  const EV = require('../src/data/additive_evidence.json');
  const rows = EV.rows.map((r) => (r.additive === '홍국색소' && r.finding === 'other_use_concern' ? { ...r, finding: 'not_safe_conclusion' } : r));
  assert.strictEqual(classifyAdditive('홍국색소', { evidenceIndex: _indexEvidence({ rows }), asOfYear: AS_OF }).color, 'red', '뮤테이션');
});
t('여러 물질 포괄(시클로덱스트린) — 가장 엄격한 β 기준 🟡 + 배지 · 불일치 배지 없음 · 같은 문구 반복 없음(우유응고효소)', () => {
  const c = classifyAdditive('시클로덱스트린', { asOfYear: AS_OF });
  assert.strictEqual(c.color, 'yellow'); assert.ok(has(c, 'multi_substance')); assert.ok(!has(c, 'agency_conflict'));
  const r = classifyAdditive('우유응고효소', { asOfYear: AS_OF }).reason;
  assert.strictEqual(r.split(' · ').length, new Set(r.split(' · ')).size, r);
});

console.log(`\n  결과: ${pass} 통과 · ${fail} 실패`);
if (fail) process.exit(1);
