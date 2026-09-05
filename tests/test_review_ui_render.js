/**
 * 관리자 제보 검토 «화면»의 렌더 회귀 — 세션67 `U66-3`
 * ============================================================
 *
 * 왜 이 파일이 저장소 «안»에 있나
 *   에이전트 C 는 이 30개 단정을 `/tmp` 에서 돌리고 초록을 봤다. 두 가지가 틀렸다:
 *     ① `/tmp` 는 세션이 끝나면 사라진다 — 다음 세션은 이 보장을 «잃는다».
 *     ② 그 하니스는 `/tmp` 에 «복사해 둔» cr-core 를 읽었다. HTML 을 고쳐도
 *        복사본은 안 바뀌므로 **영원히 초록인 거짓 초록**이었다.
 *   ⇒ 이 파일은 **라이브 `public/contribution-review.html` 에서 매번 다시 추출**한다.
 *
 * 무엇을 단정하나 — 「분기가 실제로 갈리는가」다. 「HTML 이 나온다」가 아니다.
 *   ★ `basis` 가 null 일 때«만» 기준 경고가 뜬다 (있으면 «안» 뜬다)
 *   ★ `held` 가 true 일 때«만» 보류 배지가 뜬다
 *   ★ 모르는 오류 코드를 「알 수 없는 오류」로 뭉개지 «않고» 코드 문자열을 그대로 노출한다
 *   ★ 409 를 성공으로 표시하지 않고, 고칠 수단(기준 폼)을 함께 준다
 *   ★ 어휘 밖 기준이 폼을 통과하지 못한다 (서버 400 이전에 화면이 먼저 막는다)
 *
 * ⚠ 이 테스트가 못 보는 것: 실제 브라우저 DOM · 실제 HTTP · CSS.
 *   `cr-core` 는 DOM 을 한 줄도 안 보는 순수 블록이라 Node 에서 부를 수 있다.
 *   DOM 배선(`cr-wire`)은 여기서 검증되지 «않는다».
 * ============================================================
 */

'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

// ★ 라이브 파일에서 «매번» 추출한다. 복사본을 두지 않는다 — 그것이 거짓 초록의 씨앗이다.
const HTML_PATH = path.join(__dirname, '..', 'public', 'contribution-review.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const blocks = html.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || [];
if (blocks.length < 1) {
  console.error('❌ contribution-review.html 에서 <script> 블록을 못 찾았다.');
  process.exit(1);
}
const coreSrc = blocks[0].replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
const m = new Module('cr-core-live', null);
m._compile(coreSrc + '\n;module.exports = (typeof module!=="undefined" && module.exports && Object.keys(module.exports).length) ? module.exports : (typeof CR!=="undefined" ? CR : {});', 'cr-core-live.js');
const CR = m.exports;

const assert = require('assert');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

const LIST = {
  count: 3,
  totals: { candidate: 5, held: 1, approved_applied: 1, rejected: 0 },
  items: [
    { product_id: 1234, barcode: '8801111', product_name: '신라면 <컵>', manufacturer: '농심',
      verification: 'unverified', has_public_nutrition: true, pending_count: 1, held_count: 0,
      axes: [{ review_id: 12, axis: 'nutrition', status: 'candidate', contribution_id: 987, origin: 'merge',
        created_at: '2026-09-01T10:00:00Z', reviewed_by: null, reviewed_at: null, applied_at: null,
        reject_reason: null, held: false, basis: null, basis_raw: 'unknown', basis_from: null }] },
    { product_id: 5678, barcode: '8802222', product_name: '초코파이', manufacturer: '오리온',
      verification: 'admin_verified', has_public_nutrition: false, pending_count: 0, held_count: 1,
      axes: [{ review_id: 20, axis: 'nutrition', status: 'approved', contribution_id: 990, origin: 'single',
        created_at: '2026-09-01T10:00:00Z', reviewed_by: '제이', reviewed_at: '2026-09-02T01:00:00Z',
        applied_at: null, reject_reason: null, held: true,
        basis: 'per_serving', basis_raw: null, basis_from: 'review.evidence.admin_basis' }] },
    { product_id: 9012, barcode: '8803333', product_name: '새우깡', manufacturer: '농심',
      verification: 'admin_verified', has_public_nutrition: true, pending_count: 1, held_count: 0,
      axes: [
        { review_id: 30, axis: 'nutrition', status: 'approved', held: false, applied_at: '2026-09-02T02:00:00Z', basis: 'per_100g', basis_raw: null, basis_from: 'data.parsed_nutrition._basis', origin: 'merge' },
        { review_id: 31, axis: 'ingredients', status: 'candidate', held: false, applied_at: null, basis: null, origin: 'merge' } ] },
  ],
};

t('탭 카운트 — held 1 / all 4 / nutrition 3 / ingredients 1', () => {
  const c = CR.tabCounts(LIST.items);
  assert.strictEqual(c.held, 1); assert.strictEqual(c.all, 4);
  assert.strictEqual(c.nutrition, 3); assert.strictEqual(c.ingredients, 1); assert.strictEqual(c.allergens, 0);
});
t('★ 보류 탭 — held:true 축만 남고 다른 제품은 사라진다', () => {
  const f = CR.filterItems(LIST.items, 'held');
  assert.strictEqual(f.length, 1); assert.strictEqual(f[0].product_id, 5678);
  assert.strictEqual(f[0].axes.length, 1); assert.strictEqual(f[0].axes[0].review_id, 20);
  assert.strictEqual(LIST.items[2].axes.length, 2);
});
t('축 탭 — ingredients 는 제품 하나만', () => {
  const f = CR.filterItems(LIST.items, 'ingredients');
  assert.strictEqual(f.length, 1); assert.strictEqual(f[0].axes[0].axis, 'ingredients');
});
t('전체 탭 — 3제품 4축 그대로', () => {
  const f = CR.filterItems(LIST.items, 'all');
  assert.strictEqual(f.length, 3);
  assert.strictEqual(f.reduce((a, x) => a + x.axes.length, 0), 4);
});
t('★ basis:null 인 nutrition 만 「기준 미상 — 지금 승인하면 보류됩니다」', () => {
  const w = CR.basisWarnHtml(LIST.items[0].axes[0]);
  assert.ok(w.includes('기준 미상 — 지금 승인하면 보류됩니다'), w);
  assert.ok(w.includes('unknown'));
  assert.strictEqual(CR.basisWarnHtml(LIST.items[1].axes[0]), '');
  assert.strictEqual(CR.basisWarnHtml(LIST.items[2].axes[1]), '');
});
t('★ 경고가 «승인 버튼 옆» — 같은 .actions 안, 승인 다음', () => {
  const h = CR.axisRowHtml(LIST.items[0], LIST.items[0].axes[0]);
  const iA = h.indexOf('승인(approve)'), iW = h.indexOf('기준 미상 — 지금 승인하면 보류됩니다'), iAct = h.indexOf('<div class="actions">');
  assert.ok(iA > 0 && iW > 0); assert.ok(iAct < iA && iA < iW);
});
t('★ held:true → 주황 배지 「보류 — 반영 안 됨」', () => {
  assert.ok(CR.heldBadgeHtml(LIST.items[1].axes[0]).includes('보류 — 반영 안 됨'));
  assert.strictEqual(CR.heldBadgeHtml(LIST.items[0].axes[0]), '');
  const card = CR.queueCardHtml(LIST.items[1]);
  assert.ok(card.includes('held-badge')); assert.ok(card.includes('class="card hasheld"'));
});
t('상태별 가능한 동작이 실제로 갈린다', () => {
  assert.deepStrictEqual(CR.axisActions({ status: 'candidate', held: false }), ['approve', 'reject']);
  assert.deepStrictEqual(CR.axisActions({ status: 'approved', held: true }), ['retry', 'undo', 'reject']);
  assert.deepStrictEqual(CR.axisActions({ status: 'approved', held: false }), ['undo', 'reject']);
  assert.deepStrictEqual(CR.axisActions({ status: 'rejected' }), ['reopen']);
  assert.deepStrictEqual(CR.axisActions({ status: 'undone' }), ['reopen']);
  assert.deepStrictEqual(CR.axisActions({ status: 'superseded' }), []);
});
t('보류 축에만 retry 버튼이 난다 / 반영완료엔 reopen 없음', () => {
  assert.ok(CR.axisRowHtml(LIST.items[1], LIST.items[1].axes[0]).includes("'retry'"));
  assert.ok(!CR.axisRowHtml(LIST.items[0], LIST.items[0].axes[0]).includes("'retry'"));
  assert.ok(!CR.axisRowHtml(LIST.items[2], LIST.items[2].axes[0]).includes("'reopen'"));
});
t('반려 사유 입력칸이 반려 가능한 축에만 난다', () => {
  assert.ok(CR.axisRowHtml(LIST.items[0], LIST.items[0].axes[0]).includes('id="rr-12"'));
  assert.ok(CR.axisRowHtml(LIST.items[2], LIST.items[2].axes[1]).includes('id="rr-31"'));
});
t('listHtml — 빈 탭은 빈 상태 문구', () => {
  assert.ok(CR.listHtml(LIST.items, 'allergens').includes('이 탭에 해당하는 제보가 없습니다'));
  assert.ok(CR.listHtml([], 'all').includes('이 탭에 해당하는 제보가 없습니다'));
});
t('XSS — 제품명의 홑화살괄호가 이스케이프된다', () => {
  const card = CR.queueCardHtml(LIST.items[0]);
  assert.ok(card.includes('신라면 &lt;컵&gt;')); assert.ok(!card.includes('신라면 <컵>'));
});
t('탭 6개 — 보류가 첫 번째고 강조 클래스', () => {
  const h = CR.tabsHtml('held', CR.tabCounts(LIST.items));
  assert.deepStrictEqual(CR.TABS, ['held','all','nutrition','ingredients','allergens','additives']);
  assert.ok(h.indexOf('tab held active') > 0); assert.ok(h.includes('★ 보류(held)'));
  CR.AXES.forEach((a) => assert.ok(h.includes("switchTab('" + a + "')"), a));
  assert.ok(h.includes("switchTab('all')"));
});

const D409 = [
  { review_id: 12, axis: 'nutrition', code: 'BASIS_UNKNOWN', message: '표기 기준을 알 수 없습니다.' },
  { review_id: 13, axis: 'nutrition', code: 'CONVERT_BASIS_UNKNOWN', message: '총량을 모릅니다.' },
  { review_id: 14, axis: 'ingredients', code: 'AXIS_ALREADY_APPROVED', message: '이미 승인됨' },
  { review_id: 15, axis: 'nutrition', code: 'UNDO_REQUIRED_BEFORE_REOPEN', message: 'undo 먼저' },
  { code: 'NO_PUBLIC_NUTRITION_ROW', message: '공공 행 없음' },
  { review_id: 16, axis: 'nutrition', code: 'ALREADY_APPLIED', message: '이미 반영' },
  { review_id: 17, axis: 'nutrition', code: 'UNDO_EVIDENCE_MISSING', message: 'before 없음' },
  { review_id: 18, axis: 'allergens', code: 'NOTHING_TO_APPLY', message: '옮길 것 없음' },
  { review_id: 19, axis: 'nutrition', code: 'SOME_FUTURE_CODE_XYZ', message: '서버가 새로 낸 코드' },
];
t('★★ 계약이 요구한 8개 코드가 전부 사람 말로 풀린다', () => {
  ['BASIS_UNKNOWN','CONVERT_BASIS_UNKNOWN','AXIS_ALREADY_APPROVED','UNDO_REQUIRED_BEFORE_REOPEN',
   'NO_PUBLIC_NUTRITION_ROW','ALREADY_APPLIED','UNDO_EVIDENCE_MISSING','NOTHING_TO_APPLY'].forEach((c) => {
    const x = CR.explainFailure({ code: c });
    assert.strictEqual(x.known, true, c); assert.ok(x.text && x.text.length > 5, c);
  });
});
t('★★ 모르는 코드를 뭉개지 않고 코드 문자열 그대로 노출', () => {
  const h = CR.failuresHtml(D409, { productId: 1234, action: 'approve' });
  assert.ok(h.includes('SOME_FUTURE_CODE_XYZ'));
  assert.ok(!h.includes('알 수 없는 오류'));
  assert.ok(h.includes('서버: 서버가 새로 낸 코드'));
  const x = CR.explainFailure({ code: 'SOME_FUTURE_CODE_XYZ' });
  assert.strictEqual(x.known, false); assert.strictEqual(x.text, null);
});
t('★★ 409 는 성공이 아니다 — 실패 패널이고 보류라고 말한다', () => {
  const h = CR.failuresHtml(D409, { productId: 1234, action: 'approve' });
  assert.ok(h.includes('REVIEW_APPLY_INCOMPLETE'));
  assert.ok(h.includes('반영되지 않았습니다')); assert.ok(h.includes('보류'));
  assert.ok(!h.includes('✔'));
  const ok = CR.successHtml({ reviews: [{ applied: true }] }, 'approve');
  assert.ok(ok.includes('✔')); assert.notStrictEqual(h, ok);
});
t('★ BASIS_UNKNOWN → 기준 폼 / CONVERT_BASIS_UNKNOWN → 제공량 폼', () => {
  const h = CR.failuresHtml(D409, { productId: 1234, action: 'approve' });
  assert.ok(h.includes("openBasis(1234,12,'basis')"));
  assert.ok(h.includes('기준 입력 폼 열기'));
  assert.ok(h.includes("openBasis(1234,13,'serving')"));
  assert.ok(h.includes('제공량 입력 열기'));
  assert.ok(!h.includes("openBasis(1234,14,"));
});
t('review_id 없는 실패에도 패널이 안 깨진다', () => {
  const h = CR.failuresHtml([{ code: 'NO_PUBLIC_NUTRITION_ROW', message: 'x' }], { productId: 7 });
  assert.ok(h.includes('(축 없음)'));
  assert.ok(!h.includes('act(7,'), 'review_id 가 없으면 retry 버튼을 낼 수 없다');
});
t('details 가 비어도 죽지 않는다', () => {
  assert.ok(CR.failuresHtml(undefined, { productId: 1 }).includes('details 를 주지 않았습니다'));
  assert.ok(CR.failuresHtml([], { productId: 1 }).includes('details 를 주지 않았습니다'));
});

const DETAIL = {
  product: { product_id: 1234, barcode: '8801111', product_name: '신라면', manufacturer: '농심',
    serving_size: null, serving_unit: null, total_content: null, content_unit: null, verification: 'unverified' },
  current: {
    nutrition: { calories: 500, sodium: 1790, total_sugars: 4, total_fat: 16, saturated_fat: 8, protein: 11,
      total_carbs: 79, trans_fat: 0, cholesterol: 0, added_sugars: null, dietary_fiber: null,
      calcium: null, iron: null, vitamin_d: null, potassium: null,
      serving_size_marker: '1개(120g)', source: 'food_safety_korea' },
    ingredients: [{ name: '면', sequence: 1 }, { name: '스프', sequence: 2 }],
    allergens: [{ allergen_name: '대두', evidence_level: 'contains', detected_via: 'ocr' }],
    additives: [{ additive_id: 3, name_ko: '글루탐산나트륨', detected_name: 'MSG' }],
  },
  axes: [{
    review_id: 12, axis: 'nutrition', status: 'candidate', held: false, contribution_id: 987,
    created_at: '2026-09-01T10:00:00Z',
    proposed: { calories: 505, sodium: 1600, total_sugars: 4, protein: 11 },
    basis: { value: null, raw: 'unknown', from: null,
      // ⚠⚠ 세션67 실물 정정 — 초안의 가짜 데이터는 이 자리를 «문자열 배열»로 뒀는데
      //   실제 `resolveBasis` 는 **`{from, value}` 객체 배열**을 보낸다.
      //   그래서 테스트는 초록인데 화면에는 `[object Object]` 가 떴다.
      //   ⛔ 이 모양을 문자열 배열로 되돌리지 말 것 — 그 순간 이 테스트가 «거짓 초록»이 된다.
      considered: [
        { from: 'data.parsed_nutrition._basis', value: 'unknown' },
        { from: 'data.basis', value: 'per_pack' },
      ],
      product_basis: null, admin_basis: null },
    evidence: { origin: 'merge', merged_at: '2026-09-01T09:00:00Z', source_count: 4, distinct_device_count: 3,
      auto_verify_threshold: 3, verification: 'crowd_verified', has_significant_outliers: true,
      source_contribution_ids: [1,2,3,4],
      outliers: [{ nutrient: 'sodium', value: 3200, median: 1600, deviation: 1.0 }],
      merged_nutrition: { calories: 505, sodium: 1600 } },
  }, {
    review_id: 31, axis: 'ingredients', status: 'candidate', held: false,
    proposed: [{ name: '면', sequence: 1 }, { name: '건더기스프', sequence: 3 }],
    basis: null, evidence: { origin: 'merge', source_count: 2, distinct_device_count: 2, auto_verify_threshold: 3 },
  }],
};
t('★ 상세 — 제보값 vs 현재 공공값 나란히, 다른 값만 강조', () => {
  const h = CR.nutritionCompareHtml(DETAIL.axes[0].proposed, DETAIL.current.nutrition);
  assert.ok(h.includes('<th>제보값</th>') && h.includes('<th>현재 공공값</th>'));
  assert.ok(/<tr class="diff"><td class="k">열량\(kcal\)<\/td><td class="v">505<\/td><td>500<\/td>/.test(h));
  assert.ok(h.includes('<td class="v">1600</td><td>1790</td>'));
  assert.ok(/<tr class=""><td class="k">당류\(g\)<\/td><td class="v">4<\/td><td>4<\/td>/.test(h));
  assert.ok(/<tr class="diff"><td class="k">지방\(g\)<\/td><td class="v">–<\/td><td>16<\/td>/.test(h));
  assert.strictEqual((h.match(/<td class="k">/g) || []).length, 15);
});
t('공공 영양 행이 없으면 그렇게 말한다', () => {
  assert.ok(CR.nutritionCompareHtml(DETAIL.axes[0].proposed, null).includes('공공 영양 행이 없습니다'));
});
t('목록 축 비교 — 한쪽에만 있는 것이 강조된다', () => {
  const h = CR.listCompareHtml(DETAIL.axes[1].proposed, DETAIL.current.ingredients, '원재료');
  assert.ok(h.includes('<td class="k">면</td><td class="v">있음</td><td>있음</td>'));
  assert.ok(h.includes('<tr class="diff"><td class="k">건더기스프</td><td class="v">있음</td><td>–</td>'));
  assert.ok(h.includes('<tr class="diff"><td class="k">스프</td><td class="v">–</td><td>있음</td>'));
});
t('proposed 모양이 배열/객체/문자열 어느 쪽이어도 이름을 뽑는다', () => {
  assert.deepStrictEqual(CR.toNameList(['a','b']), ['a','b']);
  assert.deepStrictEqual(CR.toNameList([{ name: 'a' }]), ['a']);
  assert.deepStrictEqual(CR.toNameList([{ allergen_name: '대두' }]), ['대두']);
  assert.deepStrictEqual(CR.toNameList([{ name_ko: 'MSG' }]), ['MSG']);
  assert.deepStrictEqual(CR.toNameList({ names: ['x'] }), ['x']);
  assert.deepStrictEqual(CR.toNameList({ list: ['y'] }), ['y']);
  assert.deepStrictEqual(CR.toNameList(null), []);
});
t('★ evidence.origin==="merge" → 기기 수·median·이상치가 보인다', () => {
  const h = CR.mergeEvidenceHtml(DETAIL.axes[0].evidence);
  assert.ok(h.includes('merge 판정'));
  assert.ok(h.includes('서로 다른 기기 3'), h.slice(0,300));
  assert.ok(h.includes('기준 3')); assert.ok(h.includes('기여 4건')); assert.ok(h.includes('이상치 있음'));
  assert.ok(h.includes('<th>median</th>')); assert.ok(h.includes('<td>1600</td>'));
  assert.ok(h.includes('median 병합값'));
  const h2 = CR.mergeEvidenceHtml({ origin: 'single' });
  assert.ok(!h2.includes('merge 판정')); assert.ok(h2.includes('origin single'));
  assert.strictEqual(CR.mergeEvidenceHtml(null), '');
});
t('★ basis 상자 — null 이면 경고, 값 있으면 관리자 근거까지', () => {
  const h = CR.basisBoxHtml(DETAIL.axes[0].basis);
  assert.ok(h.includes('기준 미상 — 지금 승인하면 보류됩니다'));
  assert.ok(h.includes('원문 값 "unknown"') || h.includes('원문 값 &quot;unknown&quot;'));
  // ★ 「어느 자리에 무슨 값이 있었나」가 둘 다 보여야 한다. 그리고 [object Object] 가 아니어야 한다.
  assert.ok(!h.includes('[object Object]'), '기준 후보를 [object Object] 로 찍었다');
  assert.ok(h.includes('data.parsed_nutrition._basis'));
  assert.ok(h.includes('data.basis'));
  assert.ok(h.includes('per_pack'), '후보의 «값»이 화면에 없다');
  const h2 = CR.basisBoxHtml({ value: 'per_serving', from: 'review.evidence.admin_basis',
    admin_basis: { value: 'per_serving', by: '제이', at: '2026-09-03T05:00:00Z', note: '라벨 육안 확인' } });
  assert.ok(h2.includes('기준 per_serving')); assert.ok(h2.includes('라벨 육안 확인'));
  assert.ok(!h2.includes('기준 미상'));
});
t('detailHtml — 제공량·총량 둘 다 없으면 「환산 불가」', () => {
  const h = CR.detailHtml(DETAIL);
  assert.ok(h.includes('환산 불가'));
  assert.ok(h.includes('review #12') && h.includes('review #31'));
  assert.ok(h.includes('기준 입력…')); assert.ok(h.includes('공공 영양 정정…'));
  assert.ok(h.includes('<th>현재 공공값</th>'));
  assert.ok(CR.detailHtml(null).includes('상세 데이터가 비어 있습니다'));
});
t('★ note 가 비면 저장을 막는다', () => {
  const r = CR.validateBasisForm({ basis: 'per_serving', note: '   ' });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'BASIS_NOTE_REQUIRED');
});
t('★ 어휘 밖 기준은 우회로가 아니다', () => {
  ['', 'unknown', 'per_pack', null].forEach((b) => {
    const r = CR.validateBasisForm({ basis: b, note: 'x' });
    assert.strictEqual(r.ok, false, String(b)); assert.strictEqual(r.code, 'INVALID_BASIS');
  });
  assert.deepStrictEqual(CR.BASIS_OK, ['per_serving','per_100g','per_100ml','per_total']);
});
t('단위는 g·ml 만, 값만 넣고 단위 비우면 막는다', () => {
  assert.strictEqual(CR.validateBasisForm({ basis:'per_serving', note:'n', serving_size:30 }).code, 'INVALID_UNIT');
  assert.strictEqual(CR.validateBasisForm({ basis:'per_serving', note:'n', serving_size:30, serving_unit:'oz' }).code, 'INVALID_UNIT');
  assert.strictEqual(CR.validateBasisForm({ basis:'per_serving', note:'n', total_content:300, content_unit:'kg' }).code, 'INVALID_UNIT');
  assert.strictEqual(CR.validateBasisForm({ basis:'per_serving', note:'n', serving_size:'abc', serving_unit:'g' }).code, 'INVALID_NUMBER');
  assert.strictEqual(CR.validateBasisForm({ basis:'per_100g', note:'n' }).ok, true);
  assert.strictEqual(CR.validateBasisForm({ basis:'per_serving', note:'n', serving_size:30, serving_unit:'g' }).ok, true);
});
t('요청 본문 — 빈 칸은 보내지 않는다', () => {
  const b = CR.buildBasisBody({ basis:'per_serving', note:'  라벨 확인  ', serving_size:'30', serving_unit:'g',
    total_content:'', content_unit:'' }, '제이');
  assert.deepStrictEqual(b, { basis:'per_serving', note:'라벨 확인', reviewed_by:'제이', serving_size:30, serving_unit:'g' });
  assert.ok(!('total_content' in b));
  const b2 = CR.buildBasisBody({ basis:'per_total', note:'x' }, '');
  assert.strictEqual(b2.reviewed_by, 'admin'); assert.ok(!('serving_size' in b2));
});
// ── §9 ★★★★★ 목록 요청에 «탭»을 싣지 않는다 (세션67 실물 1회차 사고) ──────────
//
// 무슨 일이 있었나 — 배포 첫 실행에서 화면이 제보 5건을 «하나도» 못 보여줬다.
//   서버는 전부 정상이었다: `listReviewQueue` 가 `items_len:5` · HTTP 200 이 `count:5`.
//   범인은 화면이었다 —
//     ① 기본 탭이 「보류」이고 `loadAll` 이 서버에 `held=1` 을 보냈다
//     ② 보류 행은 «진짜로» 0건이라 서버가 옳게 빈 배열을 줬다
//     ③ `switchTab` 은 `loadAll` 을 «다시 부르지 않는다» — 이미 받은 `S.items` 를 거를 뿐이다
//     ⇒ **그 순간부터 모든 탭이 영원히 0건이었다.**
//   뿌리: 탭 필터링 규칙이 «서버 한 벌 + 클라이언트 한 벌» 두 벌이었다.
//
// ⇒ 규칙: 탭은 «클라이언트에서만» 거른다. 서버로 가는 필터는 `status` 뿐이다.
t('★★ 목록 요청에 axis·held 를 «싣지 않는다» (탭이 서버 필터를 오염시키지 않는다)', () => {
  for (const tab of ['held', 'all', 'nutrition', 'ingredients', 'allergens', 'additives']) {
    const q = CR.buildListQuery({ tab, status: 'candidate,approved', limit: 50, offset: 0 });
    assert.ok(!('axis' in q), `${tab} 탭이 axis 를 서버로 보냈다`);
    assert.ok(!('held' in q), `${tab} 탭이 held 를 서버로 보냈다`);
    assert.strictEqual(q.status, 'candidate,approved', `${tab} 탭이 status 를 잃었다`);
    assert.strictEqual(q.limit, 50);
    assert.strictEqual(q.offset, 0);
  }
});

t('★ 어느 탭에서 받았든 같은 목록이면 탭 배지가 같다 (탭 전환이 데이터를 안 잃는다)', () => {
  // 보류 탭에서 시작해도 nutrition 축이 보여야 한다 — 위 사고가 바로 이것이 깨진 것이다.
  const items = [{
    product_id: 1, barcode: 'b', product_name: 'p', manufacturer: null,
    verification: 'partial', has_public_nutrition: false, pending_count: 1, held_count: 0,
    axes: [{ review_id: 1, axis: 'nutrition', status: 'candidate', held: false, basis: null }],
  }];
  const c = CR.tabCounts(items);
  assert.strictEqual(c.nutrition, 1, 'nutrition 탭 배지가 0이다');
  assert.strictEqual(c.all, 1);
  assert.strictEqual(c.held, 0, '보류가 아닌 행이 보류로 세어졌다');
  assert.strictEqual(CR.filterItems(items, 'nutrition').length, 1, 'nutrition 탭이 비었다');
  assert.strictEqual(CR.filterItems(items, 'all').length, 1);
  assert.strictEqual(CR.filterItems(items, 'held').length, 0);
});

// ── §10 `considered` 는 «객체 배열»이다 (실물 1회차에서 [object Object] 가 떴다) ────
t('★ 기준 후보 자리를 [object Object] 로 찍지 않는다', () => {
  const s = CR.basisConsideredText([
    { from: 'data.parsed_nutrition._basis', value: 'per_100ml' },
    { from: 'data.basis', value: 'unknown' },
  ]);
  assert.ok(!s.includes('[object Object]'), '객체를 그대로 문자열화했다');
  assert.ok(s.includes('data.parsed_nutrition._basis'), '어느 «자리»였는지가 없다');
  assert.ok(s.includes('per_100ml'), '무슨 «값»이었는지가 없다');
  // 빈 값·비배열에도 안 죽는다
  assert.strictEqual(CR.basisConsideredText(null), '');
  assert.strictEqual(CR.basisConsideredText([]), '');
});

console.log('\n✔ ' + n + ' 개 단정 전부 통과');
