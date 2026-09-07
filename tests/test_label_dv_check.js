/**
 * 라벨 %열 교차검증(src/services/labelDvCheck.js) — 세션68 U67-15
 * ============================================================
 * 무엇을 지키나
 *   ① 알려진 오독 4종이 «의심»되고 가설이 실물 truth 와 같다 (Vision 원문 실측 5건에서 가져옴)
 *   ② 맞는 값은 의심하지 않는다 — 정수 표기 반올림(092 "단백질 4g 8%")을 거짓경보로 만들지 않는다
 *   ③ %열 덤프(077 "단백질 10g ⏎ 47% ⏎ 3%")는 weak — 검증에 쓰지 않는다
 *   ④ 값을 «고치지 않는다» — dvCheck 는 입력 객체를 건드리지 않고, parseNutrition 의 값도 그대로다
 *   ⑤ 삼중항이 없으면 parseNutrition 이 `_dv_check` 를 «붙이지 않는다»(검사 안 함 ≠ 이상 없음)
 *   ⑥ 검토 큐 flags 가 suspects 를 나르고 critical 이 되며, 화면이 붉게 낸다
 * ============================================================
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { dvCheck, extractTriples, consistent, hypotheses, DV } = require('../src/services/labelDvCheck');
const { parseNutrition } = require('../src/services/ocrParser');
const { buildNutritionFlags } = require('../src/services/reviewQueueRead');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'contribution-review.html'), 'utf8');
const coreSrc = (html.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || [])[0].replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
const m = new Module('cr-core-live', null);
m._compile(coreSrc + '\n;module.exports = (typeof module!=="undefined" && module.exports && Object.keys(module.exports).length) ? module.exports : (typeof CR!=="undefined" ? CR : {});', 'cr-core-live.js');
const CR = m.exports;

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

t('기준치 표는 법정 상수다 — 바뀌면 모든 판정이 흔들린다', () => {
  assert.deepStrictEqual(DV, { sodium: 2000, total_carbs: 324, total_sugars: 100, total_fat: 54, saturated_fat: 15, cholesterol: 300, protein: 55 });
});

t('① g→9 오독: "포화지방 449 29%" → 가설 4.4 (048 실물)', () => {
  const r = dvCheck({}, '포화지방\n449 29%\n');
  assert.strictEqual(r.suspects.length, 1);
  assert.strictEqual(r.suspects[0].key, 'saturated_fat');
  assert.strictEqual(r.suspects[0].hypothesis, 4.4);
  assert.strictEqual(r.suspects[0].reason, 'g_read_as_9+decimal_lost');
});
t('① g→9 오독: "당류 249 24%" → 24 (036 실물)', () => {
  const r = dvCheck({}, '당류\n249\n24%');
  assert.strictEqual(r.suspects[0].hypothesis, 24);
  assert.strictEqual(r.suspects[0].reason, 'g_read_as_9');
});
t('① 소수점 손실: "지방 42g 8%" → 4.2 (036 · 세션67 삼치구이 32g 과 같은 종류)', () => {
  const r = dvCheck({ total_fat: 42 }, '지방\n42g\n8%');
  assert.strictEqual(r.suspects[0].parsed, 42);
  assert.strictEqual(r.suspects[0].hypothesis, 4.2);
  assert.strictEqual(r.suspects[0].reason, 'decimal_lost');
});
t('① "지방 20g 4%" → 2 (092) · "포화지방 48g 32%" → 4.8 (030)', () => {
  assert.strictEqual(dvCheck({ total_fat: 20 }, '지방 20g 4%').suspects[0].hypothesis, 2);
  assert.strictEqual(dvCheck({ saturated_fat: 48 }, '포화지방 48g 32%').suspects[0].hypothesis, 4.8);
});

t('② 맞는 값은 의심하지 않는다 — 신라면 실물 한 줄 전부 ok', () => {
  const r = dvCheck({ sodium: 1790, total_carbs: 79, total_sugars: 4, total_fat: 16, saturated_fat: 8, cholesterol: 0, protein: 10 },
    '나트륨 1,790 mg 90% 탄수화물 79 g 24% 당류 4g4%\n지방 16g 30% 트랜스지방 0g 포화지방 8g53%\n콜레스테롤 0 mg 0% 단백질 10g 18%');
  assert.deepStrictEqual(r.suspects, []);
  assert.strictEqual(r.checked.sodium.status, 'ok');
  assert.strictEqual(r.checked.saturated_fat.status, 'ok');
  assert.strictEqual(r.checked.cholesterol.status, 'weak', '0% 는 검증력이 없다');
});
t('② 정수 표기 반올림을 거짓경보로 만들지 않는다 — "단백질 4g 8%"(092 · 8%×55=4.4)', () => {
  assert.deepStrictEqual(dvCheck({ protein: 4 }, '단백질 4g 8%').suspects, []);
  assert.strictEqual(consistent('protein', 4, 8, 0), true);
  assert.strictEqual(consistent('protein', 4.0, 8, 1), false, '소수 표기면 엄격하다');
});
t('②-b 천단위 콤마 "1,530 mg 77%" 는 1530 이다', () => {
  const r = dvCheck({}, '나트륨 1,530 mg\n77%');
  assert.strictEqual(r.checked.sodium.status, 'ok');
  assert.strictEqual(r.checked.sodium.value, 1530);
});

t('③ %열 덤프는 weak — "단백질 10g ⏎ 47% ⏎ 3%"(077) 를 의심하지 않는다', () => {
  const r = dvCheck({ protein: 10 }, '단백질 10g\n47%\n3%\n18%');
  assert.strictEqual(r.checked.protein.status, 'weak');
  assert.deepStrictEqual(r.suspects, []);
  // 같은 모양이라도 다음 줄이 %가 아니면 정상 검증한다 (060: "나트륨 1,530 mg ⏎ 77% ⏎ 탄수화물 69 g")
  const r2 = dvCheck({ sodium: 1530 }, '나트륨 1,530 mg\n77%\n탄수화물 69 g');
  assert.strictEqual(r2.checked.sodium.status, 'ok');
});

t('④ 값을 고치지 않는다 — 입력 객체 무변경 · parseNutrition 값 그대로', () => {
  const inp = { total_fat: 42 };
  const before = JSON.stringify(inp);
  dvCheck(inp, '지방 42g 8%');
  assert.strictEqual(JSON.stringify(inp), before);
  const p = parseNutrition('영양정보 100g당 394kcal\n지방 42g 8%\n포화지방 1.9g 13%\n탄수화물 82g 25%\n단백질 7g 13%\n나트륨 450mg 23%');
  assert.strictEqual(p.total_fat, 42, '파서 값이 바뀌었다 — 가설이 값이 됐다(P1 위반)');
  assert.ok(p._dv_check, '_dv_check 가 안 붙었다');
  assert.strictEqual(p._dv_check.suspects.length, 1);
  assert.strictEqual(p._dv_check.suspects[0].key, 'total_fat');
  assert.strictEqual(p._dv_check.suspects[0].hypothesis, 4.2);
});
t('⑤ 삼중항이 없으면 _dv_check 를 붙이지 않는다(검사 안 함 ≠ 이상 없음)', () => {
  const p = parseNutrition('영양정보\n열량 315 kcal\n나트륨 1200 mg\n지방 15 g');
  assert.strictEqual(p._dv_check, undefined);
  assert.strictEqual(p.sodium, 1200);
});
t('⑤-b 가설 후보 순서 — 소수점 손실이 g→9 보다 먼저다', () => {
  assert.deepStrictEqual(hypotheses('449').map((h) => h.reason), ['decimal_lost', 'decimal_lost', 'g_read_as_9', 'g_read_as_9+decimal_lost']);
  assert.deepStrictEqual(hypotheses('42').map((h) => h.value), [4.2, 0.42]);
  assert.strictEqual(extractTriples('트랜스지방 0g 0%').length, 0, '트랜스지방은 %가 없다 — 「지방」으로 잡히면 안 된다');
});

t('⑥ 검토 큐 flags: dv_suspects 를 나르고 critical 이 된다', () => {
  const f = buildNutritionFlags({ sanity_warnings: [] },
    { parsed_nutrition: { calories: 394, total_fat: 42, total_carbs: 82, protein: 7, sodium: 450, total_sugars: 24, saturated_fat: 1.9,
      _dv_check: { checked: { total_fat: { value: 42, pct: 8, status: 'mismatch' } }, suspects: [{ key: 'total_fat', parsed: 42, token: '42', pct: 8, hypothesis: 4.2, reason: 'decimal_lost' }] } } });
  assert.strictEqual(f.dv_suspects.length, 1);
  assert.strictEqual(f.dv_suspects[0].hypothesis, 4.2);
  assert.strictEqual(f.dv_checked, 1);
  assert.strictEqual(f.critical, true, '%열 불일치는 critical 이어야 한다');
  const g = buildNutritionFlags({ sanity_warnings: [] }, { parsed_nutrition: { calories: 1, total_fat: 1, total_carbs: 1, protein: 1 } });
  assert.deepStrictEqual(g.dv_suspects, []);
  assert.strictEqual(g.dv_checked, 0);
});
t('⑥-b 화면: %열 불일치가 붉게 뜨고 가설이 «표시»된다 — 승인 버튼은 남는다', () => {
  const ax = { review_id: 1, axis: 'nutrition', status: 'candidate', held: false, basis: 'per_100g',
    flags: { calorie_check: { status: 'ok' }, traffic_light_missing: [], sanity_warnings: [], critical: true,
      dv_suspects: [{ key: 'total_fat', parsed: 42, token: '42', pct: 8, hypothesis: 4.2, reason: 'decimal_lost' }] } };
  const h = CR.axisRowHtml({ product_id: 1 }, ax);
  assert.ok(h.includes('flag-crit') && h.includes('%열 불일치') && h.includes('4.2') && h.includes('지방(g)'));
  assert.ok(h.includes('승인(approve)'));
  const h2 = CR.flagsHtml({ axis: 'nutrition', flags: { calorie_check: { status: 'ok' }, dv_suspects: [{ key: 'protein', parsed: 10, pct: 47, hypothesis: null }] } });
  assert.ok(h2.includes('가설 없음'));
});

console.log('\n✔ ' + n + ' 개 단정 전부 통과');
