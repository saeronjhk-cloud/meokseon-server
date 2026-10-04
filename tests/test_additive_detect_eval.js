/**
 * ★ 세션75e — 첨가물 검출기 v2 eval (additive_detect_eval_v1) + 규칙 단위 회귀
 *   정본 IP/eval_additive_detect_v1/eval_additive_detect_v1.json · 사본 tests/fixtures/additive_detect_eval_v1.json
 *   20 라벨(제이 실물 제보 7 · 전사 13) · 정답 139. 기준선 v1(identifyAdditives): 재현율 48.6% · 정밀도 56.3%.
 *   v2 합격선: 재현율 100% · 정밀도 100% (eval 셋 기준 · 보류 검증은 IP/eval_additive_detect_v1/README.md).
 * 실행: cross-env NODE_ENV=test node tests/test_additive_detect_eval.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const { detectAdditives, norm } = require('../src/services/additiveDetect');
const E = require('./fixtures/additive_detect_eval_v1.json');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.log(`  ❌ ${name}\n     → ${e.message}`); } }
const names = (sec) => detectAdditives(sec).map((a) => (a.match_type === 'class_only' ? '@' : '') + a.name);

function hit(exp, pr) {
  if (exp.startsWith('@')) return pr.startsWith('@') && norm(pr.slice(1)) === norm(exp.slice(1));
  if (exp.endsWith('*')) return !pr.startsWith('@') && norm(pr).startsWith(norm(exp.slice(0, -1)));
  return !pr.startsWith('@') && norm(pr) === norm(exp);
}

console.log('\n══ 세션75e — 첨가물 검출기 v2 ══');
t('eval 20 라벨 — 재현율 100% · 정밀도 100%', () => {
  let TP = 0, FN = 0, FP = 0; const bad = [];
  for (const c of E.cases) {
    const pred = names(c.section); const used = new Set(); const miss = [];
    for (const e of c.expected) { const i = pred.findIndex((x, k) => !used.has(k) && hit(e, x)); if (i >= 0) { used.add(i); TP++; } else { FN++; miss.push(e); } }
    for (const o of c.optional) { const i = pred.findIndex((x, k) => !used.has(k) && hit(o, x)); if (i >= 0) used.add(i); }
    const extra = pred.filter((_, k) => !used.has(k)); FP += extra.length;
    if (miss.length || extra.length) bad.push(`${c.id} 놓침[${miss}] 군더더기[${extra}]`);
  }
  assert.strictEqual(E.cases.length, 20); assert.strictEqual(TP + FN, 139, '정답 수가 바뀌었다 — eval 정본을 고쳤다면 이 단정과 README 를 함께 갱신');
  assert.ok(FN === 0 && FP === 0, `재현 ${TP}/${TP + FN} · 군더더기 ${FP}\n     ${bad.join('\n     ')}`);
});
t('용도명 단독 → class_only (끝 번호·N종·제제 떼고)', () => {
  assert.deepStrictEqual(names('향미증진제1, 산도조절제 2종, 유화제 4종'), ['@향미증진제', '@산도조절제', '@유화제']);
});
t('머리가 물질이면 괄호 속 용도명은 버린다 · 용도명 머리 밑 물질이 있으면 머리는 버린다', () => {
  assert.deepStrictEqual(names('아질산나트륨(발색제), 아스파탐(감미료, 페닐알라닌함유), 산화방지제(터셔리부틸히드로퀴논)'), ['아질산나트륨', '아스파탐', '터셔리부틸히드로퀴논']);
});
t('같은 물질이 다시 나와도 머리 용도명이 군더더기로 남지 않는다', () => {
  assert.deepStrictEqual(names('글리세린지방산에스테르, 유화제(글리세린지방산에스테르)'), ['글리세린지방산에스테르']);
});
t('묶음(혼합제제)은 내용물로 센다 · 짧은 표기 · 줄바꿈 공백', () => {
  assert.deepStrictEqual(names('혼합제제(글리세린에스테르, 폴리소르 베이트60)'), ['글리세린지방산에스테르', '폴리소르베이트60']);
});
t('첨가물 아님(제이 결정 10-04): 식물성유지·주정 · 부분일치 없음(인산·젖산·글리세린 오검출 금지)', () => {
  assert.deepStrictEqual(names('식물성유지(경화유), 주정, 제이인산나트륨, 스테아릴젖산나트륨, 글리세린지방산에스테르'), ['제이인산나트륨', '스테아릴젖산나트륨', '글리세린지방산에스테르']);
});
t('OCR 꼬리 잡음·공백 목록·꼬리에 붙은 용도명·계열 이름', () => {
  assert.deepStrictEqual(names('L-글루탐산나트륨 미증진제), 면류첨가알칼리제(탄산칼륨 탄산나트륨), 아스파탐감미료, 카라멜색소, 비타민D'),
    ['L-글루탐산나트륨', '탄산칼륨(무수)', '탄산나트륨', '아스파탐', '카라멜색소', '비타민D']);
});
t('raw = 원재료 «한 항목» 원문(괄호 포함) — detected_name 계약(세션65 C1)', () => {
  const r = detectAdditives('설탕, 혼합제제(카라기난, 구아검)');
  assert.deepStrictEqual(r.map((x) => x.raw), ['혼합제제(카라기난, 구아검)', '혼합제제(카라기난, 구아검)']);
});
console.log(`\n 결과: 통과 ${pass} · 실패 ${fail}`);
process.exit(fail ? 1 : 0);
