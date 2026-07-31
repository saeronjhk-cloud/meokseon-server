/**
 * test_withheld_client_render.js — 세션43 (2026-07-30)
 * ============================================================================
 * 무엇을 고정하는가
 *   판정 보류(is_withheld / data:'withheld' / color:null)가 **화면에서 사라지지 않는다.**
 *
 * ★ 왜 이 테스트가 필요한가
 *   세션42는 서버에서 판정 보류를 만들어 냈지만, `public/ocr-test.html:231` 의
 *   `if (!info || !info.color) continue;` 가 그것을 전부 건너뛰고 있었다.
 *   8개 영양소가 모두 보류인 제품(017 골든카레)은 **빈 카드**가 되고,
 *   빈 카드는 사용자에게 "문제 없음" 으로 읽힌다 — 거짓 초록과 결과가 같다.
 *   서버 테스트 45개가 전부 초록인 상태에서 사용자에게는 아무것도 전달되지 않았다.
 *
 * ★ 이 테스트는 **실제 배포되는 ocr-test.html 파일을 읽어서** 그 안의 스크립트를 실행한다.
 *   테스트용 복사본을 만들지 않는다. 복사본을 만들면 파일이 갈라져도 테스트가 안 잡는다.
 *   입력도 evaluateNutrition 의 **실제 출력**을 쓴다 — 서버·클라이언트 계약을 함께 고정한다.
 *
 * ★ DOM 은 최소 스텁이다. jsdom 을 새로 깔지 않았다(의존성 추가 = 안티패턴).
 *   여기서 필요한 건 innerHTML·className·appendChild 뿐이다.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  evaluateNutrition, formatResult, WITHHOLD_MESSAGES,
} = require('../src/services/nutritionTrafficLight');

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, message: e.message });
    console.log(`  ❌ ${name}\n     → ${e.message}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

// ════════════════════════════════════════════════════════════════════════════
// 0. 최소 DOM 스텁 + ocr-test.html 스크립트 로드
// ════════════════════════════════════════════════════════════════════════════

const HTML_PATH = path.join(__dirname, '..', 'public', 'ocr-test.html');

function makeEl(tag) {
  const el = {
    tagName: tag,
    children: [],
    className: '',
    textContent: '',
    style: {},
    src: null,
    disabled: false,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    addEventListener() {},
    click() {},
    appendChild(c) { this.children.push(c); return c; },
  };
  let _html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return _html; },
    // innerHTML 대입은 실제 브라우저처럼 자식을 날린다.
    // 이걸 흉내내지 않으면 "배너를 비웠다" 는 검사가 거짓 통과한다.
    set(v) { _html = String(v); el.children.length = 0; },
  });
  return el;
}

/** ocr-test.html 안의 <script> 를 그대로 실행하고 렌더 함수를 꺼낸다. */
function loadClient() {
  const src = fs.readFileSync(HTML_PATH, 'utf8');
  const blocks = src.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || [];
  assert.strictEqual(blocks.length, 1, `ocr-test.html 의 script 블록이 1개가 아니다 (${blocks.length}개) — 로더를 갱신할 것`);
  const code = blocks[0].replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');

  const registry = new Map();
  const document = {
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeEl('div'));
      return registry.get(id);
    },
    createElement(tag) { return makeEl(tag); },
  };
  const sandbox = {
    document,
    window: {},
    alert() {},
    fetch() { throw new Error('테스트에서 네트워크를 쓰지 않는다'); },
    FileReader: function FileReader() {},
    console: { log() {}, warn() {}, error() {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // 스크립트 끝에 export 를 붙여 내부 선언을 꺼낸다.
  new vm.Script(`${code}\n;__exports = { renderResult, esc, WITHHOLD_REASON_TEXT };`)
    .runInContext(sandbox);

  return { ...sandbox.__exports, el: (id) => document.getElementById(id), registry };
}

/** renderResult 가 요구하는 최소 응답 껍데기. 신호등 외 카드는 전부 비운다. */
function envelope(trafficLight) {
  return {
    ocr: { block_count: 1, avg_confidence: 0.9, elapsed_ms: 10, corrections: [] },
    corrected_text: '테스트',
    traffic_light: trafficLight,
    analysis: { ingredient_count: 0, ingredients: [], additive_count: 0, additives: [], allergens: [] },
    sanity_warnings: [],
  };
}

// ── 실물 캡처 전사 픽스처 (test_per_total_wiring.js 와 동일 출처) ──────────────
const P017 = { product_name: '골든카레', food_type: '카레', content_unit: 'g', serving_size: null, total_content: 220 };
const N017 = {
  calories: 1070, sodium: 9150, sugars: 20, basis: 'per_total',
  _label_text: '총 내용량 220 g\n열량 1070 kcal\n나트륨 9150 mg 458 %',
};

const P032 = { product_name: '떡국떡', food_type: '떡류', content_unit: 'g', serving_size: null, total_content: 500 };
const N032 = {
  calories: 1155, sodium: 1530, sugars: 0, sat_fat: 0.5, total_fat: 2, protein: 20,
  basis: 'per_total',
  _label_text: '총 내용량 500 g\n나트륨 1,530 mg 77 %',
};

// 치명3 재발 방지용 — RACC 가 1회분이라 하는데 라벨 %기준치는 여러 회분이라고 한다.
// 숙면 RACC 200 g, 총 220 g → 220/200 = 1.1 < 1.5 이므로 servings 가 1 로 확정된다.
const P_CONFLICT = { product_name: '충돌라벨', food_type: '숙면', content_unit: 'g', serving_size: null, total_content: 220 };
const N_CONFLICT = {
  calories: 1070, sodium: 9150, basis: 'per_total',
  _label_text: '총 내용량 220 g\n나트륨 9150 mg 458 %',
};

const P_NORMAL = { product_name: '일반과자', food_type: '과자', content_unit: 'g', serving_size: 30, total_content: 30 };
const N_NORMAL = { calories: 150, sodium: 100, sugars: 5, sat_fat: 1, basis: 'per_serving' };

// ════════════════════════════════════════════════════════════════════════════
section('§1. 017 골든카레 — 판정 보류가 화면에 남는다');

t('보류 영양소가 그리드에서 사라지지 않는다 (이전 결함: 8개 전부 continue)', () => {
  const c = loadClient();
  const r = evaluateNutrition(P017, N017);
  assert.strictEqual(r.is_withheld, true, '전제: 서버가 보류를 만들어야 한다');
  c.renderResult(envelope(r));
  const grid = c.el('nutrientGrid');
  assert.strictEqual(grid.children.length, Object.keys(r.nutrients).length,
    `그리드 ${grid.children.length}개 vs 영양소 ${Object.keys(r.nutrients).length}개`);
  assert.ok(grid.children.length >= 8, `보류 항목이 8개 이상이어야 한다 (${grid.children.length})`);
});

t('보류 항목은 nutrient-withheld 클래스 + “판정 보류” 문구', () => {
  const c = loadClient();
  c.renderResult(envelope(evaluateNutrition(P017, N017)));
  for (const item of c.el('nutrientGrid').children) {
    assert.ok(item.className.includes('nutrient-withheld'), `class=${item.className}`);
    assert.ok(item.innerHTML.includes('판정 보류'), `html=${item.innerHTML}`);
  }
});

t('★ 보류를 색으로 칠하지 않는다 — color-* 클래스가 하나도 없다', () => {
  const c = loadClient();
  c.renderResult(envelope(evaluateNutrition(P017, N017)));
  for (const item of c.el('nutrientGrid').children) {
    assert.ok(!/\bcolor-(green|yellow|red|gray)\b/.test(item.className),
      `보류에 판정 색이 칠해졌다: ${item.className}`);
  }
});

t('보류에 %DV 숫자를 노출하지 않는다 (458% 가 새면 거짓 빨강과 같다)', () => {
  const c = loadClient();
  c.renderResult(envelope(evaluateNutrition(P017, N017)));
  for (const item of c.el('nutrientGrid').children) {
    assert.ok(!item.innerHTML.includes('%DV'), `html=${item.innerHTML}`);
  }
});

t('보류 배너가 출력된다 (빈 카드 금지)', () => {
  const c = loadClient();
  c.renderResult(envelope(evaluateNutrition(P017, N017)));
  const b = c.el('withholdBanner').innerHTML;
  assert.ok(b.length > 0, '배너가 비어 있다');
  assert.ok(b.includes('판정 보류'), b.slice(0, 200));
});

t('★ 배너가 “무엇을 하면 되는지”를 말한다 (재촬영 안내)', () => {
  const c = loadClient();
  c.renderResult(envelope(evaluateNutrition(P017, N017)));
  const b = c.el('withholdBanner').innerHTML;
  assert.ok(b.includes('다시 촬영'), '사용자가 취할 행동이 없으면 보류는 막다른 길이다');
  assert.ok(b.includes('인분') || b.includes('1회 제공량'), b.slice(0, 300));
});

t('배너에 사유코드가 실린다 (제이가 원인을 눈으로 구분할 수 있어야 한다)', () => {
  const c = loadClient();
  const r = evaluateNutrition(P017, N017);
  c.renderResult(envelope(r));
  assert.ok(c.el('withholdBanner').innerHTML.includes(r.withhold_reason));
});

t('보류일 때 per_total 환산 배너는 뜨지 않는다 (환산한 적이 없다)', () => {
  const c = loadClient();
  c.renderResult(envelope(evaluateNutrition(P017, N017)));
  assert.strictEqual(c.el('perTotalBanner').innerHTML, '');
});

t('맥락 메시지가 배너와 중복 출력되지 않는다', () => {
  const c = loadClient();
  c.renderResult(envelope(evaluateNutrition(P017, N017)));
  assert.strictEqual(c.el('contextMessages').innerHTML, '',
    '서버 문구를 배너가 이미 쓰고 있으면 아래에 또 찍지 않는다');
});

// ════════════════════════════════════════════════════════════════════════════
section('§2. 032 떡국떡 — 환산해서 판정한 사실을 밝힌다');

t('보류 배너는 뜨지 않는다', () => {
  const c = loadClient();
  const r = evaluateNutrition(P032, N032);
  assert.ok(!r.is_withheld, '전제: 032 는 환산 성공');
  c.renderResult(envelope(r));
  assert.strictEqual(c.el('withholdBanner').innerHTML, '');
});

t('per_total 배너에 divisor(5회분)가 명시된다', () => {
  const c = loadClient();
  c.renderResult(envelope(evaluateNutrition(P032, N032)));
  const b = c.el('perTotalBanner').innerHTML;
  assert.ok(b.includes('총 내용량'), b.slice(0, 200));
  assert.ok(b.includes('5'), `divisor 가 안 보인다: ${b.slice(0, 300)}`);
});

t('정상 판정 항목은 색이 칠해진다 (보류 처리가 정상 경로를 죽이지 않았다)', () => {
  const c = loadClient();
  c.renderResult(envelope(evaluateNutrition(P032, N032)));
  const colored = c.el('nutrientGrid').children.filter(
    (i) => /\bcolor-(green|yellow|red|gray)\b/.test(i.className));
  assert.ok(colored.length > 0, '색이 칠해진 항목이 하나도 없다');
});

t('데이터 없는 영양소도 사라지지 않는다 (“데이터 없음” 으로 표시)', () => {
  const c = loadClient();
  const r = evaluateNutrition(P032, N032);
  const missingKeys = Object.entries(r.nutrients).filter(([, v]) => v.data === 'missing').map(([k]) => k);
  assert.ok(missingKeys.length > 0, `전제: 032 에 missing 영양소가 있어야 한다 (${JSON.stringify(r.nutrients)})`);
  c.renderResult(envelope(r));
  const missingItems = c.el('nutrientGrid').children.filter((i) => i.innerHTML.includes('데이터 없음'));
  assert.strictEqual(missingItems.length, missingKeys.length);
});

// ════════════════════════════════════════════════════════════════════════════
section('§3. ★ 배너 잔존(stale) — 연속 분석 시 이전 제품의 상태가 남으면 안 된다');

t('보류 제품 → 정상 제품: 보류 배너가 지워진다', () => {
  const c = loadClient();
  c.renderResult(envelope(evaluateNutrition(P017, N017)));
  assert.ok(c.el('withholdBanner').innerHTML.length > 0, '전제');
  c.renderResult(envelope(evaluateNutrition(P032, N032)));
  assert.strictEqual(c.el('withholdBanner').innerHTML, '',
    '정상 제품에 이전 제품의 보류 안내가 남으면 정상 제품이 보류로 읽힌다');
});

t('정상 제품 → 보류 제품: per_total 환산 배너가 지워진다', () => {
  const c = loadClient();
  c.renderResult(envelope(evaluateNutrition(P032, N032)));
  assert.ok(c.el('perTotalBanner').innerHTML.length > 0, '전제');
  c.renderResult(envelope(evaluateNutrition(P017, N017)));
  assert.strictEqual(c.el('perTotalBanner').innerHTML, '',
    '보류 제품에 "5회분으로 나눠 판정했습니다" 가 남으면 정면으로 거짓이다');
});

t('보류 제품 두 번 연속 → 그리드가 누적되지 않는다', () => {
  const c = loadClient();
  c.renderResult(envelope(evaluateNutrition(P017, N017)));
  const n1 = c.el('nutrientGrid').children.length;
  c.renderResult(envelope(evaluateNutrition(P017, N017)));
  assert.strictEqual(c.el('nutrientGrid').children.length, n1);
});

// ════════════════════════════════════════════════════════════════════════════
section('§4. per_serving 정상 제품 — 기존 동작 불변');

t('per_serving 제품에는 두 배너 모두 뜨지 않는다', () => {
  const c = loadClient();
  const r = evaluateNutrition(P_NORMAL, N_NORMAL);
  assert.ok(!r.is_withheld && !r.per_total, '전제: per_total 진단이 없어야 한다');
  c.renderResult(envelope(r));
  assert.strictEqual(c.el('withholdBanner').innerHTML, '');
  assert.strictEqual(c.el('perTotalBanner').innerHTML, '');
});

t('per_serving 제품의 %DV 표기가 유지된다', () => {
  const c = loadClient();
  c.renderResult(envelope(evaluateNutrition(P_NORMAL, N_NORMAL)));
  const withDv = c.el('nutrientGrid').children.filter((i) => i.innerHTML.includes('%DV'));
  assert.ok(withDv.length > 0, '%DV 가 전부 사라졌다');
});

// ════════════════════════════════════════════════════════════════════════════
section('§5. 보류 사유 2종 구분 (세션42 는 한 종으로 뭉개고 있었다)');

t('RACC↔%기준치 충돌은 별도 사유코드로 나간다', () => {
  const r = evaluateNutrition(P_CONFLICT, N_CONFLICT);
  assert.strictEqual(r.is_withheld, true, `보류여야 한다: ${JSON.stringify(r.per_total)}`);
  assert.strictEqual(r.withhold_reason, 'racc_says_single_but_pct_dv_says_multi');
});

t('두 사유의 사용자 문구가 서로 다르다', () => {
  const a = evaluateNutrition(P017, N017);
  const b = evaluateNutrition(P_CONFLICT, N_CONFLICT);
  assert.notStrictEqual(a.withhold_reason, b.withhold_reason);
  assert.notDeepStrictEqual(a.context_messages, b.context_messages);
});

t('★ 서버 사유 집합 ⊆ 클라이언트 문구 집합 (서버만 늘면 배너가 조용히 퇴화한다)', () => {
  const c = loadClient();
  for (const key of Object.keys(WITHHOLD_MESSAGES)) {
    assert.ok(key in c.WITHHOLD_REASON_TEXT,
      `클라이언트 WITHHOLD_REASON_TEXT 에 '${key}' 가 없다 — ocr-test.html 도 같이 고칠 것`);
  }
});

t('충돌 사유도 배너에 재촬영 안내가 붙는다', () => {
  const c = loadClient();
  c.renderResult(envelope(evaluateNutrition(P_CONFLICT, N_CONFLICT)));
  assert.ok(c.el('withholdBanner').innerHTML.includes('다시 촬영'));
});

// ════════════════════════════════════════════════════════════════════════════
section('§6. formatResult — 열량 표기 (경미 결함)');

t('보류 시 열량에 “null%” 이 출력되지 않는다', () => {
  const out = formatResult(evaluateNutrition(P017, N017));
  assert.ok(!out.includes('null'), out);
});

t('보류 시 열량이 총 내용량 기준이라고 밝힌다', () => {
  const out = formatResult(evaluateNutrition(P017, N017));
  assert.ok(out.includes('총 내용량 기준'), out);
});

t('보류 영양소는 “데이터 없음” 과 구분된다', () => {
  const out = formatResult(evaluateNutrition(P017, N017));
  assert.ok(out.includes('판정 보류'), out);
});

t('정상 제품의 열량 %DV 표기는 그대로다', () => {
  const out = formatResult(evaluateNutrition(P_NORMAL, N_NORMAL));
  assert.ok(/열량\s+150kcal\s+\d/.test(out), out);
  assert.ok(!out.includes('총 내용량 기준'), out);
});

// ════════════════════════════════════════════════════════════════════════════
section('§7. 이스케이프 (innerHTML 경로)');

t('esc() 가 태그를 무력화한다', () => {
  const c = loadClient();
  assert.strictEqual(c.esc('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;');
});

t('esc(null/undefined) → 빈 문자열 ("null" 문자열이 화면에 찍히지 않는다)', () => {
  const c = loadClient();
  assert.strictEqual(c.esc(null), '');
  assert.strictEqual(c.esc(undefined), '');
});

t('서버 문구에 태그가 섞여도 그대로 실행되지 않는다', () => {
  const c = loadClient();
  const r = evaluateNutrition(P017, N017);
  r.context_messages = ['<script>bad()</script> 라벨 확인 필요'];
  c.renderResult(envelope(r));
  const b = c.el('withholdBanner').innerHTML;
  assert.ok(!b.includes('<script>'), b.slice(0, 300));
  assert.ok(b.includes('&lt;script&gt;'), b.slice(0, 300));
});

// ════════════════════════════════════════════════════════════════════════════
section('§8. ★★ 서브에이전트 검증에서 잡힌 결함 재발 방지 (세션43)');

t('중대4 원재료명이 이스케이프된다 (OCR 자유 텍스트 → innerHTML)', () => {
  const c = loadClient();
  const env = envelope(evaluateNutrition(P_NORMAL, N_NORMAL));
  env.analysis = {
    ingredient_count: 1,
    ingredients: [{ name: '설탕<img src=x onerror=eval&lpar;name&rpar;>', origin: '<b>국산</b>', percentage: '5<i>' }],
    additive_count: 0, additives: [], allergens: [],
  };
  c.renderResult(env);
  const html = c.el('ingredientList').innerHTML;
  assert.ok(!html.includes('<img'), html.slice(0, 200));
  assert.ok(html.includes('&lt;img'), html.slice(0, 200));
  assert.ok(!html.includes('<b>'), html.slice(0, 200));
});

t('중대4 첨가물·알레르기·sanity 도 이스케이프된다', () => {
  const c = loadClient();
  const env = envelope(evaluateNutrition(P_NORMAL, N_NORMAL));
  env.analysis = {
    ingredient_count: 0, ingredients: [],
    additive_count: 1, additives: [{ name: '<svg onload=x>', category: '<i>산도조절제' }],
    allergens: ['<script>a()</script>'],
  };
  env.sanity_warnings = [{ nutrient: '<b>나트륨', message: '<img src=x>' }];
  c.renderResult(env);
  for (const id of ['additiveList', 'allergenList', 'sanityList']) {
    const html = c.el(id).innerHTML;
    assert.ok(!/<(svg|script|img|b|i)\b/.test(html), `${id}: ${html.slice(0, 200)}`);
  }
});

t('경미5 nutrients 가 없어도 렌더가 죽지 않는다', () => {
  const c = loadClient();
  c.renderResult(envelope({
    product_name: 'x', food_category: 'snack', is_excluded: false,
    is_withheld: true, withhold_reason: 'multi_serving_but_count_unknown',
    context_messages: [],
  }));
  assert.ok(c.el('withholdBanner').innerHTML.includes('판정 보류'));
});

t('경미5 context_messages 가 문자열이어도 렌더가 죽지 않는다', () => {
  const c = loadClient();
  const r = evaluateNutrition(P017, N017);
  r.context_messages = '문자열로 왔다';
  c.renderResult(envelope(r));
  assert.ok(c.el('withholdBanner').innerHTML.includes('문자열로 왔다'));
});

t('경미5 traffic_light = {} 여도 렌더가 죽지 않는다', () => {
  const c = loadClient();
  c.renderResult(envelope({}));
  assert.strictEqual(c.el('nutrientGrid').children.length, 0);
});

t('경미5 per_total 에 divisor 가 없어도 배너가 뜬다', () => {
  const c = loadClient();
  const r = evaluateNutrition(P032, N032);
  r.per_total = { reason: 'T2:racc' };   // divisor 누락
  c.renderResult(envelope(r));
  assert.ok(c.el('perTotalBanner').innerHTML.includes('1회분'));
});

// ════════════════════════════════════════════════════════════════════════════
section('§9. 세션45 안① — basis unknown → 판정 보류 (제이 결정 2026-07-30)');

// 캡처 018 실물: 기준 문구가 라벨에 없고 나트륨 690 mg / 당류 1 g 만 읽혔다.
// 열량·1회 제공량·총 내용량 전부 없음. 현행(unknown→per_serving)이면 과자 RACC 30 g 기준 빨강.
// 근거: IP/basis_unknown_decision_2026-07-30.md §2
const P018 = { product_name: '블랙트러플 하몽 크래커', food_type: '과자', content_unit: 'g', serving_size: null, total_content: null };
const N018 = { calories: null, sodium: 690, sugars: 1, sat_fat: 11, total_fat: 28, cholesterol: 0, basis: 'unknown' };

t('018 실물 — unknown 은 판정 보류로 떨어진다 (이전: 거짓 빨강 가능)', () => {
  const r = evaluateNutrition(P018, N018);
  assert.strictEqual(r.is_withheld, true, `보류여야 한다: ${JSON.stringify(r.nutrients.sodium)}`);
  assert.strictEqual(r.withhold_reason, 'basis_unknown');
});

t('보류이므로 어떤 영양소에도 색이 칠해지지 않는다', () => {
  const r = evaluateNutrition(P018, N018);
  for (const [k, n] of Object.entries(r.nutrients)) {
    assert.strictEqual(n.color, null, `${k} 에 색이 칠해졌다: ${JSON.stringify(n)}`);
    assert.strictEqual(n.data, 'withheld', `${k}: ${JSON.stringify(n)}`);
  }
});

t('★ basis 표기가 per_total 이 아니라 unknown 이다 (모르는 것을 총량이라 단정하지 않는다)', () => {
  const r = evaluateNutrition(P018, N018);
  assert.strictEqual(r.nutrients.sodium.basis, 'unknown');
  // 열량이 있는 경우도 같다
  const r2 = evaluateNutrition(P018, { ...N018, calories: 500 });
  assert.strictEqual(r2.calories.basis, 'unknown');
});

t('★ formatResult 가 「총 내용량 기준」이라고 거짓 인쇄하지 않는다', () => {
  const out = formatResult(evaluateNutrition(P018, { ...N018, calories: 500 }));
  assert.ok(!out.includes('총 내용량 기준'), out);
});

t('★ 보류 사유가 「기준 표기 미확인」으로 인쇄된다 (1회 섭취량 미확인 아님)', () => {
  const out = formatResult(evaluateNutrition(P018, N018));
  assert.ok(out.includes('기준 표기 미확인'), out);
  assert.ok(!out.includes('1회 섭취량 미확인'), out);
});

t('★ per_100_unknown 은 보류되지 않는다 (단위만 모르고 per-100 인 것은 확실 — 함께 막으면 퇴행)', () => {
  const r = evaluateNutrition(
    { product_name: 'x', food_type: '과자', content_unit: 'g', serving_size: 30, total_content: 30 },
    { calories: 150, sodium: 100, sugars: 5, basis: 'per_100_unknown' },
  );
  assert.ok(!r.is_withheld, `per_100_unknown 이 보류됐다: ${r.withhold_reason}`);
  assert.ok(r.nutrients.sodium.color, '색이 칠해져야 한다');
});

t('★ basis 가 아예 없으면 종전대로 per_serving (DB 상품 레코드 전수 보류 방지)', () => {
  const r = evaluateNutrition(P_NORMAL, { calories: 150, sodium: 100, sugars: 5, sat_fat: 1 });
  assert.ok(!r.is_withheld, 'basis 없는 레코드가 보류됐다 — DB 조회 경로가 전부 회색이 된다');
  assert.ok(r.nutrients.sodium.color);
});

t('보류에 sanity_warnings 를 붙이지 않는다 (근거 없는 경고)', () => {
  const r = evaluateNutrition(P018, N018);
  assert.deepStrictEqual(r.sanity_warnings, []);
});

t('★ 클라이언트 재촬영 안내가 「○인분」이 아니라 기준 문구를 지시한다', () => {
  const c = loadClient();
  c.renderResult(envelope(evaluateNutrition(P018, N018)));
  const html = c.el('withholdBanner').innerHTML;
  assert.ok(html.includes('다시 촬영'), html);
  assert.ok(html.includes('머리글') || html.includes('100 g 당'),
    `기준 문구 촬영 안내가 없다 — 사용자가 「○인분」을 찾다 헛수고한다: ${html}`);
  assert.ok(!html.includes('「○인분」'), `잘못된 행동 지시가 남아 있다: ${html}`);
});

t('★ 배너에 사유코드 basis_unknown 이 노출된다 (제이가 눈으로 잡는 유일한 지점)', () => {
  const c = loadClient();
  c.renderResult(envelope(evaluateNutrition(P018, N018)));
  assert.ok(c.el('withholdBanner').innerHTML.includes('basis_unknown'));
});

t('★ unknown 보류에는 per_total 배너가 뜨지 않는다 (환산했다는 거짓 주장)', () => {
  const c = loadClient();
  const r = evaluateNutrition(P018, N018);
  assert.strictEqual(r.per_total, undefined, 'per_total 진단이 붙었다');
  c.renderResult(envelope(r));
  assert.strictEqual(c.el('perTotalBanner').innerHTML, '');
});

t('★ 세 사유의 사용자 문구가 서로 전부 다르다', () => {
  const msgs = [
    evaluateNutrition(P017, N017).context_messages[0],
    evaluateNutrition(P_CONFLICT, N_CONFLICT).context_messages[0],
    evaluateNutrition(P018, N018).context_messages[0],
  ];
  assert.strictEqual(new Set(msgs).size, 3, `문구가 겹친다: ${JSON.stringify(msgs)}`);
});

t('★ ocrRoutes 관문이 unknown 을 per_serving 으로 눙치지 않는다 (소스 검증)', () => {
  // 정책을 신호등에만 넣고 이 줄을 안 고치면 초록 테스트와 무동작이 공존한다(세션44 중대8 유형).
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ocrRoutes.js'), 'utf8');
  assert.ok(!/BASIS_OK\[basisRaw\]\s*\|\|\s*'per_serving'/.test(src),
    "ocrRoutes 에 `BASIS_OK[basisRaw] || 'per_serving'` 이 남아 있다 — unknown 보류가 발동하지 않는다");
  assert.ok(/BASIS_OK\[basisRaw\]\s*\|\|\s*'unknown'/.test(src),
    "ocrRoutes 가 unknown 을 그대로 신호등에 넘기지 않는다");
});

t('★ crowdsourceService 는 unknown 을 DB 에 저장하지 않는다 (관문 유지 확인)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'crowdsourceService.js'), 'utf8');
  // BASIS_OK 에 unknown 이 들어가면 기준 모르는 값이 영구 저장된다. 되돌리기 가장 어려운 오염이다.
  const m = src.match(/const BASIS_OK = \{[\s\S]{0,200}?\}/);
  assert.ok(m, 'crowdsourceService 의 BASIS_OK 를 찾지 못했다 — 테스트를 갱신할 것');
  assert.ok(!/unknown/.test(m[0]), `BASIS_OK 에 unknown 이 들어갔다: ${m[0]}`);
});

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(62)}`);
console.log(`📊 세션43 판정 보류 + 세션45 안①: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})`);
if (fail > 0) {
  console.log('\n실패 상세:');
  for (const f of failures) console.log(`  - ${f.name}\n    ${f.message}`);
  process.exit(1);
}
console.log('✅ 전체 통과');
