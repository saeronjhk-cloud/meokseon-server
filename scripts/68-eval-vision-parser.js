/**
 * 68-eval-vision-parser.js — 런타임 파서(src/services/ocrParser.parseNutrition) 를
 *   «Vision 원문» 평가셋 v2 로 잰다 (세션68 U67-15 · 원칙4 Eval-First)
 * ============================================================================
 * ⚠ v1(63-eval-capture-parser.js) 과의 차이 두 가지:
 *   ① v1 은 scripts/lib/capture_label_parser.js(배치 파서)를 잰다. 이것은 **제보 경로가
 *      실제로 쓰는** src/services/ocrParser.js 를 잰다. 파서가 둘이다 — 혼동하지 말 것.
 *   ② v1 의 텍스트는 사람이 정제한 것이다. 이것은 Google Vision 이 «실제로 낸» 원문이다
 *      (셀이 흩어지고 g 가 9 로 읽힌 그대로). 세션67 큐의 제보 5건이 그 모양이었다.
 *
 * 채점
 *   · nutrition 의 각 키: truth 값과 «정확히» 같아야 1점. truth 가 null 이면 파서도 null/undefined 여야 1점
 *     («없음»을 0 으로 채우면 오답 — 세션64b 규칙).
 *   · empty:true 건: 숫자 영양소가 «하나도» 없어야 1점 (표가 없는 사진에서 값을 만들면 오답).
 *   · forbid: 그 값이 나오면 그 키는 0점 «이고» 별도로 센다 — 알려진 오독이 다시 나오는지 본다.
 *   · basis: truth 가 있을 때만 채점.
 *   · expect_calorie_mismatch: 라벨 자체 모순 건 — 엔진(sanityCheck)이 calorie_deviation 을 내야 1점.
 *
 * 합격선(실측 «전» 고정 · 원칙4): 이 파일은 기준선을 «찍는» 도구다. 파서를 고친 뒤 이 값이
 *   내려가면 그 수정은 되돌린다. 올라가도 v1(63) 과 test:ocr 가 같이 초록이어야 채택한다.
 *
 * 실행: node scripts/68-eval-vision-parser.js [--verbose] [--json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { parseNutrition } = require('../src/services/ocrParser');
const { sanityCheck } = require('../src/services/nutritionTrafficLight');

const VERBOSE = process.argv.includes('--verbose');
const AS_JSON = process.argv.includes('--json');

const EVAL_CANONICAL = path.join(__dirname, '..', '..', 'eval_set', 'vision_label_eval_v2.jsonl');
const EVAL_INREPO = path.join(__dirname, '..', 'eval_set', 'vision_label_eval_v2.jsonl');
const hasCanon = fs.existsSync(EVAL_CANONICAL);
const hasRepo = fs.existsSync(EVAL_INREPO);
if (!hasCanon && !hasRepo) { console.error('[중단] 평가셋 없음:', EVAL_CANONICAL, EVAL_INREPO); process.exit(1); }
if (hasCanon && hasRepo) {
  const a = fs.readFileSync(EVAL_CANONICAL, 'utf8').replace(/\r\n/g, '\n').trimEnd();
  const b = fs.readFileSync(EVAL_INREPO, 'utf8').replace(/\r\n/g, '\n').trimEnd();
  if (a !== b) { console.error('[중단] 평가셋 정본과 저장소 사본이 다르다. 정본을 사본 위치로 복사할 것.'); process.exit(1); }
}
const cases = fs.readFileSync(hasCanon ? EVAL_CANONICAL : EVAL_INREPO, 'utf8')
  .replace(/\r\n/g, '\n').trim().split('\n').map((l) => JSON.parse(l));
if (cases.length === 0) { console.error('[중단] 평가셋이 0건이다 — 「전건 통과」는 거짓 초록이다.'); process.exit(1); }

const KEYS = ['calories', 'sodium', 'total_carbs', 'total_sugars', 'total_fat', 'saturated_fat', 'trans_fat', 'cholesterol', 'protein'];
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const basisOf = (p) => p._basis || p.basis || null;

let total = 0, pass = 0, forbidHits = 0;
const byClass = {};
const rows = [];
for (const c of cases) {
  const p = parseNutrition(c.text) || {};
  const t = c.truth;
  let ct = 0, cp = 0; const miss = []; const hits = [];
  if (t.empty) {
    ct++; total++;
    const got = KEYS.filter((k) => isNum(p[k]));
    if (got.length === 0) { cp++; pass++; } else miss.push('빈 결과여야 하는데 ' + got.map((k) => k + '=' + p[k]).join(','));
  } else {
    for (const k of Object.keys(t.nutrition)) {
      ct++; total++;
      const want = t.nutrition[k]; const got = p[k];
      const forb = (t.forbid && t.forbid[k]) || [];
      if (forb.some((f) => got === f)) { forbidHits++; hits.push(k + '=' + got); }
      const ok = want === null ? !isNum(got) : got === want;
      if (ok) { cp++; pass++; } else miss.push(k + ':' + (got === undefined ? '∅' : got) + '≠' + (want === null ? 'null' : want));
    }
    if (t.basis) {
      ct++; total++;
      if (basisOf(p) === t.basis) { cp++; pass++; } else miss.push('basis:' + basisOf(p) + '≠' + t.basis);
    }
    if (t.expect_calorie_mismatch) {
      ct++; total++;
      const w = sanityCheck({ calories: p.calories, total_carbs: p.total_carbs, protein: p.protein, total_fat: p.total_fat }, null, false, 'per_serving');
      if (w.some((x) => x.type === 'calorie_deviation')) { cp++; pass++; } else miss.push('검산 경고가 안 떴다');
    }
  }
  const cls = c.class || '?';
  byClass[cls] = byClass[cls] || { total: 0, pass: 0, n: 0 };
  byClass[cls].total += ct; byClass[cls].pass += cp; byClass[cls].n++;
  rows.push({ id: c.id, class: cls, pass: cp, total: ct, miss, forbid_hits: hits });
  if (!AS_JSON) {
    console.log((miss.length ? '✗ ' : '✓ ') + c.id + '  [' + cls + ']  ' + cp + '/' + ct
      + (hits.length ? '  ⛔ 알려진 오독 재현: ' + hits.join(' ') : ''));
    if (miss.length && (VERBOSE || miss.length <= 6)) console.log('     ' + miss.join('  '));
    if (VERBOSE && c.note) console.log('     메모: ' + c.note);
  }
}

// ── DV% 교차검증(labelDvCheck) 채점 — 「의심이 맞았는가」와 「맞는 값을 의심했는가」 ──
//   hyp_ok      : 파서가 틀린 키에서 가설이 truth 와 정확히 같다   (↑ 좋다)
//   hyp_bad     : 가설이 있었는데 truth 와 다르다                 (⛔ 0 이어야 한다 — 틀린 가설은 없는 것보다 나쁘다)
//   suspect_only: 의심은 했지만 가설이 없다                       (사람이 본다 — 무해)
//   false_alarm : 파서 값이 truth 와 같은데 의심했다              (↓ 관리자 신뢰를 갉아먹는다)
//   missed      : 파서 값이 truth 와 다른데 ok 로 봤다            (↓ 검증력 부족)
const { dvCheck } = require('../src/services/labelDvCheck');
const dv = { hyp_ok: 0, hyp_bad: 0, suspect_only: 0, false_alarm: 0, missed: 0, confirmed: 0 };
for (const c of cases) {
  const t = c.truth.nutrition; if (!t) continue;
  const p = parseNutrition(c.text) || {};
  const r = dvCheck(p, c.text);
  for (const [k, ch] of Object.entries(r.checked)) {
    if (ch.status !== 'ok' || t[k] === undefined || t[k] === null || !isNum(p[k])) continue;
    if (p[k] === t[k]) dv.confirmed++; else dv.missed++;
  }
  for (const s of r.suspects) {
    const want = t[s.key];
    if (want === undefined || want === null) continue;   // 미채점
    if (s.parsed === want) dv.false_alarm++;
    else if (s.hypothesis === want) dv.hyp_ok++;
    else if (s.hypothesis === null) dv.suspect_only++;
    else dv.hyp_bad++;
  }
}

const summary = {
  cases: cases.length, pass, total, rate: Math.round(pass / total * 1000) / 10,
  forbid_hits: forbidHits,
  dv_check: dv,
  by_class: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, { n: v.n, rate: Math.round(v.pass / v.total * 1000) / 10 }])),
};
if (AS_JSON) { console.log(JSON.stringify({ summary, rows }, null, 1)); process.exit(0); }
console.log('\n========================================================');
console.log(`통과 ${pass} / ${total}  (${summary.rate}%)   알려진 오독 재현 ${forbidHits}건   케이스 ${cases.length}`);
for (const [k, v] of Object.entries(summary.by_class)) console.log(`  ${k.padEnd(14)} n=${v.n}  ${v.rate}%`);
console.log(`DV% 교차검증: 가설 정답 ${dv.hyp_ok} · 가설 오답 ${dv.hyp_bad} · 의심만 ${dv.suspect_only} · 거짓경보 ${dv.false_alarm} · 놓침 ${dv.missed} · 확인 ${dv.confirmed}`);
console.log('※ 이 숫자는 «기준선»이다. 파서를 고친 뒤 내려가면 그 수정을 되돌린다(원칙4).');

// ── CI 게이트: 기준선 «미만»이면 빨강. 기준선을 올릴 때만 이 숫자를 올린다(내리지 않는다).
//   --min-pass N   통과 단정 수 하한 (세션68 기준선 145)
//   --max-hyp-bad N · --max-false-alarm N   DV 검증 상한 (세션68 기준선 0 · 0)
const argN = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? Number(process.argv[i + 1]) : null; };
const minPass = argN('--min-pass'); const maxHypBad = argN('--max-hyp-bad'); const maxFalse = argN('--max-false-alarm');
const minHypOk = argN('--min-hyp-ok');
let gateFail = false;
if (minPass !== null && pass < minPass) { console.error(`❌ 통과 ${pass} < 기준선 ${minPass}`); gateFail = true; }
if (minHypOk !== null && dv.hyp_ok < minHypOk) { console.error(`❌ 가설 정답 ${dv.hyp_ok} < ${minHypOk} — 알려진 오독을 더는 못 잡는다`); gateFail = true; }
if (maxHypBad !== null && dv.hyp_bad > maxHypBad) { console.error(`❌ 가설 오답 ${dv.hyp_bad} > ${maxHypBad}`); gateFail = true; }
if (maxFalse !== null && dv.false_alarm > maxFalse) { console.error(`❌ 거짓경보 ${dv.false_alarm} > ${maxFalse}`); gateFail = true; }
if (gateFail) process.exit(1);
