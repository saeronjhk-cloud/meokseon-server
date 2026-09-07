/**
 * 검토 큐의 영양 «신호»(flags) — 세션68 `U67-12`
 * ============================================================
 *
 * 무엇을 지키나
 *   세션67 실물 1회차에 「지방 32g ↔ 열량 80kcal」(비비고 순살 삼치구이) 제보가 큐에 떴고
 *   사람이 암산으로 잡아 반려했다. 인수인계는 「열량 정합성 검사가 없다」고 적었는데
 *   ★ 틀렸다 — `nutritionTrafficLight.sanityCheck` 가 저장 시점에 `calorie_deviation`(76%) 을
 *   이미 냈고 `contribution_review.evidence.sanity_warnings` 에 들어 있었다.
 *   없던 것은 **그것을 읽어 화면까지 나르는 층**이다.
 *
 * 그래서 이 테스트는 사슬을 «끝까지» 잇는다:
 *   엔진(sanityCheck) → evidence.sanity_warnings → buildNutritionFlags → flags → 화면(flagsHtml)
 *   ⛔ 어느 층도 4-9-4 공식을 «다시» 계산하지 않는다. 출처는 엔진 하나다.
 *
 * 단정하는 분기
 *   ① 삼치구이 값을 엔진에 넣으면 경고가 나오고, 그 경고를 넣으면 flags 가 mismatch/critical 이다
 *   ② 그릭요거트(정합) 는 ok 이고 critical:false
 *   ③ 육포처럼 지방·단백질이 «없으면» ok 가 아니라 incomplete 다 — 엔진이 검산을 «건너뛴» 것을 초록으로 읽지 않는다
 *   ④ sanity_warnings 가 null(검사 못 함)이면 unchecked — 「경고 없음」과 「검사 안 함」을 구분한다
 *   ⑤ 신호등 4자리(열량·나트륨·당류·포화지방) 결손이 저장용 키 이름으로 나온다
 *   ⑥ 화면: critical 일 때«만» flag-crit 가 뜨고 axisrow 에 crit 클래스가 붙는다
 * ============================================================
 */

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const { sanityCheck } = require('../src/services/nutritionTrafficLight');
const {
  buildNutritionFlags, CALORIE_CHECK_KEYS, TRAFFIC_LIGHT_KEYS,
} = require('../src/services/reviewQueueRead');

// 라이브 HTML 에서 cr-core 추출 (test_review_ui_render.js 와 같은 방식 — 복사본 금지)
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'contribution-review.html'), 'utf8');
const blocks = html.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || [];
const coreSrc = blocks[0].replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
const m = new Module('cr-core-live', null);
m._compile(coreSrc + '\n;module.exports = (typeof module!=="undefined" && module.exports && Object.keys(module.exports).length) ? module.exports : (typeof CR!=="undefined" ? CR : {});', 'cr-core-live.js');
const CR = m.exports;

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// 삼치구이(306257) — 세션67 실물 반려 건. 지방 32g 은 OCR 소수점 누락(3.2g).
// 저장 게이트는 판정용 키(sat_fat)로 검사하고, contributions.data 는 저장용 키(saturated_fat)다.
const SAMCHI_ENGINE = { calories: 80, total_fat: 32, sat_fat: 1.1, total_carbs: 1, protein: 12, sodium: 300 };
const SAMCHI_DATA = { parsed_nutrition: { calories: 80, total_fat: 32, saturated_fat: 1.1, total_carbs: 1, protein: 12, sodium: 300, total_sugars: 0 } };

t('① 엔진 → evidence → flags: 삼치구이는 mismatch · critical · 76%', () => {
  const warnings = sanityCheck(SAMCHI_ENGINE, 60, false, 'per_serving');
  assert.ok(warnings.some((w) => w.type === 'calorie_deviation'), '엔진이 경고를 안 냈다 — 전제가 틀렸다');
  const f = buildNutritionFlags({ sanity_warnings: warnings }, SAMCHI_DATA);
  assert.strictEqual(f.calorie_check.status, 'mismatch');
  assert.strictEqual(f.critical, true);
  assert.strictEqual(f.calorie_check.actual, 80);
  assert.strictEqual(f.calorie_check.estimated, 340);
  assert.strictEqual(f.calorie_check.deviation_pct, 76);
  assert.deepStrictEqual(f.traffic_light_missing, [], '삼치는 신호등 4자리가 다 있다');
});

t('② 정합(그릭요거트) — ok · critical:false', () => {
  const warnings = sanityCheck({ calories: 90, total_fat: 4.8, total_carbs: 5, protein: 7, sodium: 80, sugars: 5, sat_fat: 2.8 }, 100, false, 'per_100g');
  const f = buildNutritionFlags({ sanity_warnings: warnings },
    { parsed_nutrition: { calories: 90, total_fat: 4.8, total_carbs: 5, protein: 7, sodium: 80, total_sugars: 5, saturated_fat: 2.8 } });
  assert.strictEqual(f.calorie_check.status, 'ok');
  assert.strictEqual(f.critical, false);
  assert.deepStrictEqual(f.traffic_light_missing, []);
});

t('③ ★ 육포처럼 매크로가 비면 ok 가 아니라 incomplete — 엔진의 «건너뜀»을 초록으로 읽지 않는다', () => {
  const warnings = sanityCheck({ calories: 300, total_carbs: 10 }, 40, true, 'per_serving');
  assert.ok(!warnings.some((w) => w.type === 'calorie_deviation'), '엔진은 자리가 비면 검산을 안 한다');
  const f = buildNutritionFlags({ sanity_warnings: warnings },
    { parsed_nutrition: { calories: 300, total_carbs: 10, total_sugars: 8 } });
  assert.strictEqual(f.calorie_check.status, 'incomplete');
  assert.deepStrictEqual(f.calorie_check.missing, ['protein', 'total_fat']);
  assert.strictEqual(f.critical, false);
  assert.deepStrictEqual(f.traffic_light_missing, ['sodium', 'saturated_fat']);
});

t('④ sanity_warnings 가 null(검사 못 함)이면 unchecked — 「경고 없음」≠「검사 안 함」', () => {
  const f = buildNutritionFlags({ sanity_warnings: null }, SAMCHI_DATA);
  assert.strictEqual(f.sanity_warnings, null);
  assert.strictEqual(f.calorie_check.status, 'unchecked');
  const g = buildNutritionFlags({}, SAMCHI_DATA);
  assert.strictEqual(g.calorie_check.status, 'unchecked', 'evidence 에 키가 없어도 unchecked');
  const h = buildNutritionFlags(null, null);
  assert.strictEqual(h.calorie_check.status, 'unchecked');
  assert.deepStrictEqual(h.traffic_light_missing, TRAFFIC_LIGHT_KEYS);
});

t('⑤ 키 이름은 저장용이다(saturated_fat·total_sugars) — 판정용 sat_fat·sugars 가 아니다', () => {
  assert.deepStrictEqual(TRAFFIC_LIGHT_KEYS, ['calories', 'sodium', 'total_sugars', 'saturated_fat']);
  assert.deepStrictEqual(CALORIE_CHECK_KEYS, ['calories', 'total_carbs', 'protein', 'total_fat']);
  // 판정용 키로 넣으면 «결손»으로 읽혀야 한다(화이트리스트 밖이라 무시된다)
  const f = buildNutritionFlags({ sanity_warnings: [] }, { parsed_nutrition: { calories: 1, sodium: 1, sugars: 1, sat_fat: 1 } });
  assert.deepStrictEqual(f.traffic_light_missing, ['total_sugars', 'saturated_fat']);
});

t('⑤-b 0 은 결손이 아니다(열량 0kcal 은 정보다 — 세션64b 규칙)', () => {
  const f = buildNutritionFlags({ sanity_warnings: [] },
    { parsed_nutrition: { calories: 0, sodium: 0, total_sugars: 0, saturated_fat: 0, total_carbs: 0, protein: 0, total_fat: 0 } });
  assert.deepStrictEqual(f.traffic_light_missing, []);
  assert.strictEqual(f.calorie_check.status, 'ok');
});

// ── 화면 ──
const AX = (flags, extra) => Object.assign({ review_id: 7, axis: 'nutrition', status: 'candidate', held: false, basis: 'per_serving', flags }, extra || {});
const ITEM = { product_id: 306257 };

t('⑥ 화면: mismatch 일 때«만» flag-crit 와 axisrow.crit 가 뜬다', () => {
  const bad = CR.axisRowHtml(ITEM, AX({ calorie_check: { status: 'mismatch', actual: 80, estimated: 340, deviation_pct: 76 }, traffic_light_missing: [], sanity_warnings: [], critical: true }));
  assert.ok(bad.includes('flag-crit'), '불일치 경고가 안 떴다');
  assert.ok(bad.includes('76%'), '편차 %가 안 보인다');
  assert.ok(/class="axisrow[^"]*\bcrit\b/.test(bad), 'axisrow 에 crit 클래스가 없다');
  assert.ok(bad.includes('승인(approve)'), '경고는 반려가 아니다 — 승인 버튼은 남아야 한다');

  const ok = CR.axisRowHtml(ITEM, AX({ calorie_check: { status: 'ok' }, traffic_light_missing: [], sanity_warnings: [], critical: false }));
  assert.ok(!ok.includes('flag-crit'), 'ok 인데 붉은 경고가 떴다');
  assert.ok(!/class="axisrow[^"]*\bcrit\b/.test(ok));
  assert.ok(!ok.includes('flag-warn'), 'ok · 결손 0 인데 경고가 떴다');
});

t('⑥-b 화면: incomplete 는 노란 경고에 빈 자리 이름(한글 라벨)이 붙는다', () => {
  const h = CR.flagsHtml(AX({ calorie_check: { status: 'incomplete', missing: ['protein', 'total_fat'] }, traffic_light_missing: ['sodium'], sanity_warnings: [], critical: false }));
  assert.ok(h.includes('flag-warn'));
  assert.ok(h.includes('단백질(g)') && h.includes('지방(g)'), '결손 라벨이 없다');
  assert.ok(h.includes('나트륨(mg)'), '신호등 결손이 없다');
  assert.ok(!h.includes('flag-crit'));
});

t('⑥-c 화면: flags 가 없거나 다른 축이면 아무것도 안 낸다', () => {
  assert.strictEqual(CR.flagsHtml(AX(null)), '');
  assert.strictEqual(CR.flagsHtml({ axis: 'ingredients', flags: { critical: true } }), '');
  assert.strictEqual(CR.flagsHtml(null), '');
});

t('⑥-d 화면: 상세(detailHtml)에도 같은 경고가 뜬다', () => {
  const d = { product: { product_id: 306257, product_name: '삼치' }, current: {},
    axes: [AX({ calorie_check: { status: 'mismatch', actual: 80, estimated: 340, deviation_pct: 76 }, traffic_light_missing: [], sanity_warnings: [], critical: true },
      { proposed: { nutrition: { calories: 80 }, nutrient_count: 1 }, basis: { value: 'per_serving' } })] };
  assert.ok(CR.detailHtml(d).includes('flag-crit'));
});

t('⑦ ★ 정정 «뒤»에는 정정값으로 재판정한다 — 32→3.2 면 mismatch 가 사라지고 after_override:true', () => {
  const ev = { sanity_warnings: [{ type: 'calorie_deviation', value: 80, limit: 340 }],
    admin_override: { values: { total_fat: 3.2 }, by: '제이', note: 'n' } };
  const f = buildNutritionFlags(ev, SAMCHI_DATA);
  assert.strictEqual(f.after_override, true);
  assert.strictEqual(f.calorie_check.status, 'ok', '정정했는데 저장 시점 경고가 그대로다');
  assert.strictEqual(f.critical, false);
  // 정정이 «틀린» 값이면 다시 mismatch 다 — 엔진을 실제로 다시 불렀다는 증거
  const g = buildNutritionFlags({ ...ev, admin_override: { values: { total_fat: 50 } } }, SAMCHI_DATA);
  assert.strictEqual(g.calorie_check.status, 'mismatch');
  assert.strictEqual(g.after_override, true);
  // null 로 비우면 incomplete
  const h = buildNutritionFlags({ ...ev, admin_override: { values: { total_fat: null } } }, SAMCHI_DATA);
  assert.strictEqual(h.calorie_check.status, 'incomplete');
  assert.deepStrictEqual(h.calorie_check.missing, ['total_fat']);
  // 정정 없으면 저장 시점 경고 그대로(회귀)
  assert.strictEqual(buildNutritionFlags({ sanity_warnings: ev.sanity_warnings }, SAMCHI_DATA).after_override, false);
});
t('⑦-b 정정된 키의 %열 의심은 해소되고, 다른 키의 의심은 남는다', () => {
  const data = { parsed_nutrition: { ...SAMCHI_DATA.parsed_nutrition, _dv_check: { checked: {}, suspects: [
    { key: 'total_fat', parsed: 32, token: '32', pct: 6, hypothesis: 3.2, reason: 'decimal_lost' },
    { key: 'sodium', parsed: 300, token: '300', pct: 30, hypothesis: null, reason: null } ] } } };
  const f = buildNutritionFlags({ sanity_warnings: [], admin_override: { values: { total_fat: 3.2 } } }, data);
  assert.deepStrictEqual(f.dv_suspects.map((s) => s.key), ['sodium']);
  assert.strictEqual(f.critical, true, '남은 의심(sodium)이 있으니 여전히 critical');
  const g = buildNutritionFlags({ sanity_warnings: [] }, data);
  assert.deepStrictEqual(g.dv_suspects.map((s) => s.key), ['total_fat', 'sodium']);
});
t('⑦-c 화면: after_override 면 「정정 후 재판정」 칩이 뜬다', () => {
  const h = CR.flagsHtml(AX({ calorie_check: { status: 'ok' }, traffic_light_missing: [], sanity_warnings: [], critical: false, after_override: true }));
  assert.ok(h.includes('정정 후 재판정'));
  assert.ok(!CR.flagsHtml(AX({ calorie_check: { status: 'ok' }, traffic_light_missing: [], sanity_warnings: [], critical: false })).includes('정정 후'));
});

console.log('\n✔ ' + n + ' 개 단정 전부 통과');
