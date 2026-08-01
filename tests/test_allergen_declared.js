/**
 * test_allergen_declared.js — 세션44 (2026-07-30)
 * ============================================================================
 * 무엇을 고정하는가
 *   ① 라벨에 **단독 명칭으로 인쇄된 법정 알레르기 표시**가 검출된다. (`밀`·`대두`·`잣`·`고등어`·`게`)
 *   ② 그 과정에서 `메밀`→`밀` 같은 **1글자 이름 오탐이 생기지 않는다.**
 *   ③ 「직접 함유」와 「혼입 가능」이 섞이지 않는다. (양방향)
 *   ④ 3분리 결과(`allergens_v2`)가 **응답에 실리고 화면에 그려진다.**
 *
 * ★ 왜 필요한가 — 세션44 실측
 *   ALLERGEN_KEYWORDS.밀 = ['밀가루','소맥분','글루텐'] — `밀` 자체가 없었다.
 *   `고등어`·`잣` 은 표 전체에 없었다(법정 19종 중 2종 누락).
 *   캡처 68건 전사에서 `밀` 이 31건, `게` 가 1건 누락되고 있었다.
 *   법정 알레르기 표시는 원재료 형태가 아니라 **공식 명칭 단독**으로 인쇄되므로 실사용 영향이 크다.
 *
 *   그리고 반대 방향의 결함도 있었다 — 캡처 030(다향훈제오리):
 *   "…아황산류, 잣을 사용한 제조시설에서 **같이** 제조하고 있습니다" 가
 *   혼입 신호에 하나도 안 걸려(`같은` 만 전제) contains 로 분류되고,
 *   "조개류(굴, 전복, 홍합 **포함**)" 의 bare `/포함/` 가 그것을 승격시켜
 *   **법정 19종 전부가 「직접 함유」** 로 나왔다.
 *
 * ★ 클라이언트 검사는 **실제 배포되는 public/ocr-test.html 을 읽어서** 실행한다.
 *   복사본을 만들지 않는다(test_withheld_client_render.js 와 같은 이유·같은 로더).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ocrParser = require('../src/services/ocrParser');

const { detectAllergens, detectAllergensV2, analyzeText } = ocrParser;

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

/**
 * ★★ 세션45 — 성능 단정은 콜드 런 1회로 재지 않는다.
 *   세션45 실측: test_parser_parity 의 같은 형태 단정이 약 40% 확률로 거짓 실패했다.
 *   원인은 ReDoS 재발이 아니라 **JIT 컴파일 스파이크**(중앙값 7.8 ms / 최댓값 42.6 ms).
 *   워밍업 후 3회 중앙값을 쓴다 — 이것이 1차 수정이다.
 *   ★ 역행추적은 입력에 결정적이라 3회 전부 느리다 — 18,000 ms 는 중앙값 뒤에 숨지 못한다.
 *
 * ⚠ 측정을 고쳐도 여전히 실패했다. 상한 수치 자체가 원인이었다 — 아래 SLOW_MS 참조.
 */
/**
 * ★★★ 세션45 — 절대 ms 상한 30 → SLOW_MS(120).
 *   세션44 의 30 ms 는 제이 PC 실측에 맞춘 숫자다. Claude 샌드박스는 1.5~2배 느려서
 *   정상 코드가 무작위로 실패한다(실측: `메타 2400자` 37.5 ms).
 *   막으려는 실패 모드는 초 단위(411 B 18,055 ms 등)이므로 120 은 여전히 49배 이상 아래다.
 *   ★ 정밀 탐지는 test_parser_parity.js §6 의 「2배 길이 → 배수」 검사가 담당한다(기계 독립).
 *   ❌ 실패할 때마다 이 숫자를 올리지 말 것 — 근거는 "정상 상한을 재실측했다" 뿐이다.
 */
const SLOW_MS = 120;

function medianMs(fn, runs = 3) {
  fn();
  const ts = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = process.hrtime.bigint();
    fn();
    ts.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  ts.sort((a, b) => a - b);
  return ts[Math.floor(ts.length / 2)];
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

// ════════════════════════════════════════════════════════════════════════════
// 0. 클라이언트 로더 (배포 파일 그대로)
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
    set(v) { _html = String(v); el.children.length = 0; },
  });
  return el;
}

function loadClient() {
  const src = fs.readFileSync(HTML_PATH, 'utf8');
  const blocks = src.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || [];
  assert.strictEqual(blocks.length, 1, `ocr-test.html 의 script 블록이 1개가 아니다 (${blocks.length}개) — 로더 갱신 필요`);
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
  new vm.Script(`${code}\n;__exports = { renderResult, esc };`).runInContext(sandbox);
  return { ...sandbox.__exports, el: (id) => document.getElementById(id) };
}

/** renderResult 가 요구하는 최소 응답 껍데기. 신호등은 비운다. */
function envelope(analysisPatch) {
  return {
    ocr: { block_count: 1, avg_confidence: 0.9, elapsed_ms: 10, corrections: [] },
    corrected_text: '테스트',
    traffic_light: null,
    analysis: {
      ingredient_count: 0, ingredients: [], additive_count: 0, additives: [],
      allergens: [], nutrition: {},
      ...analysisPatch,
    },
    sanity_warnings: [],
  };
}

// ── 실물 캡처 전사에서 그대로 가져온 문장 (.tmp/captures/transcripts) ──────────
const L030 = '알레르기 유발물질: 밀, 대두, 우유, 쇠고기 함유';
const L030_CROSS = '6. 본 제품은 알류, 메밀, 땅콩, 고등어, 게, 새우, 돼지고기, 복숭아, 토마토, 호두, 닭고기, 오징어, '
  + '조개류(굴, 전복, 홍합 포함), 아황산류, 잣을 사용한 제조시설에서 같이 제조하고 있습니다.';
const L032 = '밀 함유';
const L032_CROSS = '• 이 제품은 대두, 우유를 사용한 제품과 같은 제조시설에서 제조하고 있습니다.';
const L060 = '밀 함유\n• 대두, 계란, 메밀 혼입 가능';
const L006_CROSS = '•본 제품은 대두, 밀, 우유, 토마토를 사용한 제품과 같은 제조시설에서 제조하였습니다.';

// ════════════════════════════════════════════════════════════════════════════
section('§1. 법정 단독 명칭 검출 — 세션44 이전엔 전부 누락');

t('♥ 우유, 밀, 쇠고기 함유 ♥ → 밀이 포함된다 (이전: 쇠고기·우유만)', () => {
  assert.deepStrictEqual(detectAllergens('♥ 우유, 밀, 쇠고기 함유 ♥'), ['밀', '쇠고기', '우유']);
});

t('우유·밀 함유 → 가운뎃점 구분자에서도 밀이 잡힌다', () => {
  assert.deepStrictEqual(detectAllergens('우유·밀 함유'), ['밀', '우유']);
});

t('알레르기 유발물질: 대두, 밀 → 콜론 형식에서도 밀이 잡힌다', () => {
  assert.deepStrictEqual(detectAllergens('알레르기 유발물질: 대두, 밀'), ['대두', '밀']);
});

t('실물 030 선언 줄 → 밀·대두·우유·쇠고기 4종 정확히', () => {
  assert.deepStrictEqual(detectAllergens(L030), ['대두', '밀', '쇠고기', '우유']);
});

t('★ 잣 — ALLERGEN_KEYWORDS 에 아예 없던 법정 19종 항목', () => {
  assert.deepStrictEqual(detectAllergens('잣 함유'), ['잣']);
});

t('★ 고등어 — ALLERGEN_KEYWORDS 에 아예 없던 법정 19종 항목', () => {
  assert.deepStrictEqual(detectAllergens('고등어 함유'), ['고등어']);
});

t('게 단독 표기 (기존엔 게살/크래미/꽃게만 있었다)', () => {
  assert.deepStrictEqual(detectAllergens('알레르기 유발물질: 게, 새우 함유'), ['게', '새우']);
});

t('원재료 형태 표기는 그대로 유지된다 (밀가루 → 밀)', () => {
  assert.deepStrictEqual(detectAllergens('대두, 밀가루 함유'), ['대두', '밀']);
});

t('법정 19종 전부가 한 줄에 선언돼도 19종이 나온다', () => {
  const all = '알레르기 유발물질: 알류, 우유, 메밀, 땅콩, 대두, 밀, 고등어, 게, 새우, 돼지고기, '
    + '복숭아, 토마토, 아황산류, 호두, 닭고기, 쇠고기, 오징어, 조개류, 잣 함유';
  const got = detectAllergens(all);
  for (const a of ['난류', '우유', '메밀', '땅콩', '대두', '밀', '고등어', '게', '새우',
    '돼지고기', '복숭아', '토마토', '아황산류', '호두', '닭고기', '쇠고기', '오징어', '조개류', '잣']) {
    assert.ok(got.includes(a), `${a} 누락 — got=${JSON.stringify(got)}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
section('§2. ★ 1글자 이름 오탐 차단 — 마스킹 순서가 정확성의 전제');

t('메밀 함유 → 밀이 섞이지 않는다 (긴 키워드 우선 소비)', () => {
  assert.deepStrictEqual(detectAllergens('메밀 함유'), ['메밀']);
});

t('메밀, 밀 함유 → 둘 다 나온다 (하나가 다른 하나를 먹지 않는다)', () => {
  assert.deepStrictEqual(detectAllergens('메밀, 밀 함유'), ['메밀', '밀']);
});

t('조개류(굴, 전복, 홍합 포함) 함유 → 조개류 하나로 접힌다', () => {
  assert.deepStrictEqual(detectAllergens('알레르기 유발물질: 조개류(굴, 전복, 홍합 포함) 함유'), ['조개류']);
});

t('★ 단순 includes 로는 못 막는다 — _matchSet 마스킹이 실제로 동작하는지 직접 확인', () => {
  // 마스킹이 없으면 '메밀' 안의 '밀' 이 잡혀 ['메밀','밀'] 이 된다.
  const got = detectAllergens('알레르기유발물질: 메밀 함유');
  assert.ok(!got.includes('밀'), `밀 오탐 — 마스킹 순서가 깨졌다. got=${JSON.stringify(got)}`);
});

// ════════════════════════════════════════════════════════════════════════════
section('§3. ★ 캡처 030 오탐 차단 — 혼입 문구가 「직접 함유」로 승격되던 결함');

t('「사용한 제조시설에서 같이 제조」 가 혼입으로 분류된다 (「같은」만 전제하던 결함)', () => {
  const r = detectAllergensV2(L030_CROSS);
  assert.deepStrictEqual(r.contains, [], `contains 가 비어야 한다. got=${JSON.stringify(r.contains)}`);
  assert.ok(r.mayContain.includes('잣'), '잣이 혼입으로 잡혀야 한다');
  assert.ok(r.mayContain.includes('고등어'), '고등어가 혼입으로 잡혀야 한다');
});

t('★ "홍합 포함)" 의 bare /포함/ 이 문장을 함유로 승격시키지 않는다', () => {
  const r = detectAllergensV2('조개류(굴, 전복, 홍합 포함)를 사용한 제품과 같은 제조시설에서 제조하고 있습니다.');
  assert.deepStrictEqual(r.contains, [], `contains 가 비어야 한다. got=${JSON.stringify(r.contains)}`);
  assert.ok(r.mayContain.includes('조개류'), '조개류가 혼입으로 잡혀야 한다');
});

t('조사가 붙은 실제 선언 "우유를 포함" 은 여전히 함유로 잡힌다', () => {
  const r = detectAllergensV2('이 제품은 우유를 포함합니다');
  assert.deepStrictEqual(r.contains, ['우유']);
});

t('★ 030 라벨 전체 — 선언 4종만 함유, 나머지 15종은 혼입 (이전: 19종 전부 함유)', () => {
  const r = detectAllergensV2(`${L030}\n\n주의하세요\n${L030_CROSS}`);
  assert.deepStrictEqual(r.contains, ['대두', '밀', '쇠고기', '우유'],
    `함유는 선언 4종뿐이어야 한다. got=${JSON.stringify(r.contains)}`);
  assert.ok(r.mayContain.length >= 10, `혼입이 10종 이상이어야 한다. got=${r.mayContain.length}`);
  for (const a of r.contains) {
    assert.ok(!r.mayContain.includes(a), `${a} 가 함유·혼입 양쪽에 있다(중복 제거 실패)`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
section('§4. 직접 함유 / 혼입 가능 분리 — 실물 라벨');

t('032 떡국떡 — 함유는 밀, 대두·우유는 혼입', () => {
  const r = detectAllergensV2(`${L032}\n${L032_CROSS}`);
  assert.deepStrictEqual(r.contains, ['밀']);
  assert.deepStrictEqual(r.mayContain, ['대두', '우유']);
});

t('060 — 함유는 밀, 대두·계란·메밀은 혼입', () => {
  const r = detectAllergensV2(L060);
  assert.deepStrictEqual(r.contains, ['밀']);
  assert.deepStrictEqual(r.mayContain, ['난류', '대두', '메밀']);
});

t('006 대천김 — 함유 선언이 없다. 함유는 빈 배열이어야 한다', () => {
  // ★ 세션43 까지 detectAllergens(v1)는 이 라벨을 ['대두','새우','우유','조개류','토마토'] 로
  //   **직접 함유** 처럼 보고했다. 실제 라벨에는 함유 선언이 한 글자도 없다.
  const r = detectAllergensV2(L006_CROSS);
  assert.deepStrictEqual(r.contains, [], `함유 선언이 없다. got=${JSON.stringify(r.contains)}`);
});

t('006 대천김 — 혼입 4종 정확히 (대두·밀·우유·토마토)', () => {
  const r = detectAllergensV2(L006_CROSS);
  assert.deepStrictEqual(r.mayContain.slice().sort(), ['대두', '밀', '우유', '토마토']);
});

t('★ 혼입 항목이 원재료에도 실제로 있으면 혼입으로 강등하지 않는다 (누락 방지)', () => {
  const r = detectAllergensV2('원재료명: 밀가루, 설탕\n대두를 사용한 제품과 같은 제조시설에서 제조합니다.');
  assert.ok(r.inferred.includes('밀'), '원재료의 밀은 추정으로 남아야 한다');
  assert.ok(!r.mayContain.includes('밀'), '원재료에 있는 항목이 혼입으로 강등되면 안 된다');
  assert.deepStrictEqual(r.mayContain, ['대두']);
});

// ════════════════════════════════════════════════════════════════════════════
section('§5. 서버 배선 — allergens_v2 가 계산만 되고 버려지지 않는다');

t('analyzeText 가 allergens_v2 를 3분리 구조로 낸다', () => {
  const a = analyzeText(`${L030}\n${L030_CROSS}`);
  assert.ok(a.allergens_v2, 'allergens_v2 가 없다');
  for (const k of ['contains', 'mayContain', 'inferred', 'evidence']) {
    assert.ok(Array.isArray(a.allergens_v2[k]), `allergens_v2.${k} 가 배열이 아니다`);
  }
  assert.deepStrictEqual(a.allergens_v2.contains, ['대두', '밀', '쇠고기', '우유']);
});

t('★ ocrRoutes 의 두 엔드포인트 응답에 allergens_v2 가 실린다 (세션43 context_messages 재발 방지)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ocrRoutes.js'), 'utf8');
  const hits = src.match(/allergens_v2/g) || [];
  assert.ok(hits.length >= 5,
    `ocrRoutes.js 의 allergens_v2 언급이 ${hits.length}건 — /analyze·/multi-photo 응답 양쪽 배선이 필요하다`);
  // ★ 세션46 — 세션45가 flat 을 `flattenAllergensV2(...)` 로 바꾸면서 옛 정규식
  //   (`allergens: analysis.allergens,` 뒤에 allergens_v2)이 영영 매칭되지 않게 됐다.
  //   숫자만 맞추면 또 「형태만 보는 검사」가 된다 → **응답에 실리는 v2 의 인자 짝**을 본다.
  //   `allergens_v2: reconcileAllergens(X.allergens, X.allergens_v2)` 에서 두 X 가 같아야 한다.
  //   어긋나면 A 의 이름에 B 의 등급이 붙는다 — 예외 없이 조용히 틀리는 종류다.
  const v2Wiring = [...src.matchAll(/allergens_v2:\s*reconcileAllergens\(\s*(\w+)\.allergens,\s*(\w+)\.allergens_v2\s*\)/g)];
  assert.strictEqual(v2Wiring.length, 2,
    `응답에 v2 를 싣는 지점이 ${v2Wiring.length}곳 — 2곳(/analyze·/multi-photo)이어야 한다`);
  for (const m of v2Wiring) {
    assert.strictEqual(m[1], m[2],
      `reconcileAllergens 인자 짝이 어긋났다: ${m[1]}.allergens vs ${m[2]}.allergens_v2`);
  }
  // 두 지점이 서로 다른 분석 객체여야 한다(/analyze=analysis · /multi-photo=merged).
  assert.deepStrictEqual([...new Set(v2Wiring.map((m) => m[1]))].sort(), ['analysis', 'merged'],
    '두 엔드포인트가 같은 객체를 쓴다 — 한쪽 배선이 복사된 것이다');
});

t('★★ 세션48 — 사용자 입력은 라벨 판독을 덮어쓰지 않고 합집합으로 더한다 (과소경고 방지)', () => {
  // ★★★ 이 검사는 세션44~47 동안 **정반대 계약**을 못 박고 있었다:
  //     "덮어쓰면 3분리를 null 로 내린다" → `allergens_v2 = null` 이 2곳 있는지 소스로 셌다.
  //   세션48 4차 검증이 그 계약의 대가를 실측했다 —
  //     라벨 판독 ["밀","우유","대두","새우(혼입)"] 상태에서 사용자가 "밀" 한 글자를 보내면
  //     응답이 ["밀"] + v2=null 이 된다. **우유·대두·새우가 사라진다(과소경고).**
  //   옛 코드는 문자열을 아예 무시했으므로(무해) 세션47 수정이 새 과소경고를 만든 것이다.
  //   ★ 「회귀가 결함을 계약으로 못 박고 있는지 확인하라」(세션47 §10)의 실제 사례다.
  //     코드만 고치고 이 단정을 남겼다면 다음 수정이 되돌렸을 것이다.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ocrRoutes.js'), 'utf8');
  // ⚠⚠ 세션48 실사고 — 처음엔 `/allergens_v2\s*=\s*null/g` 였는데 **바로 위 주석**이 매칭됐다.
  //   세션47 M-A 와 **글자 그대로 같은 함정**을 이 검사를 쓰면서 다시 밟았다.
  //   → 줄머리 + 좌변 형태로 **구조**를 묻는다. 그리고 주석 줄을 먼저 제거한다.
  const codeOnly = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.strictEqual((codeOnly.match(/^\s*[\w.]+\.allergens_v2\s*=\s*null\s*;/gm) || []).length, 0,
    '사용자 입력 경로에 v2 를 null 로 내리는 코드가 남아 있다 — 라벨 등급 근거가 사라진다');

  // 동작으로 고정한다. 소스 문자열만 보면 다음 리팩터에서 또 갈라진다(세션48 뮤테이션 M-A 사고).
  const { coerceUserAllergens } = require('../src/routes/ocrRoutes');
  const { normalizeAllergenNames } = require('../src/services/allergenName');

  // ① 괄호 안 구분자는 항목 경계가 아니다 — 실측 반례: 조개류 하나가 쓰레기 3행이 됐다
  assert.deepStrictEqual(coerceUserAllergens('조개류(굴,전복,홍합 포함)'), ['조개류(굴,전복,홍합 포함)'],
    '괄호 안 콤마로 쪼개면 "조개류(굴" · "전복" · "홍합 포함)" 세 행이 공용 마스터에 들어간다');
  assert.deepStrictEqual(normalizeAllergenNames('조개류(굴,전복,홍합 포함)').map((h) => h.name), ['조개류'],
    '괄호를 보존하면 정규화가 하나의 정본으로 모은다');

  // ② 구분자 집합이 ocrParser 와 맞아야 한다 — 세션44 가 전각 콤마·가운뎃점을 빠뜨려 밀을 놓쳤다
  for (const [input, want] of [
    ['밀，대두', ['밀', '대두']], ['밀、대두', ['밀', '대두']],
    ['밀ㆍ대두', ['밀', '대두']], ['밀\t대두', ['밀', '대두']],
  ]) assert.deepStrictEqual(coerceUserAllergens(input), want, `구분자 미처리: ${input}`);

  // ③ 19종에 붙지 않는 것은 공용 마스터로 가지 않는다 (20,000자·XSS 실측 근거)
  for (const junk of ['아무거나쓴글자', '<script>x<', 'ㅁㄴㅇㄹ', 'x'.repeat(500)]) {
    assert.deepStrictEqual(normalizeAllergenNames(junk.slice(0, 40)).map((h) => h.name), [],
      `정규화가 쓰레기를 통과시킨다: ${junk.slice(0, 20)}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
section('§6. 클라이언트 — 3분리가 화면에 구분되어 그려진다');

t('직접 함유 / 혼입 가능 / 원재료 추정 세 구획이 모두 나온다', () => {
  const c = loadClient();
  c.renderResult(envelope({
    allergens: ['밀'],
    allergens_v2: { contains: ['밀'], mayContain: ['대두', '우유'], inferred: ['난류'], evidence: [] },
  }));
  const html = c.el('allergenList').innerHTML;
  assert.ok(html.includes('직접 함유'), '「직접 함유」 라벨이 없다');
  assert.ok(html.includes('혼입 가능'), '「혼입 가능」 라벨이 없다');
  assert.ok(html.includes('원재료 추정'), '「원재료 추정」 라벨이 없다');
  assert.strictEqual(c.el('allergenCard').style.display, 'block');
});

t('★ 혼입 가능은 직접 함유와 같은 모양을 쓰지 않는다 (색·클래스 재사용 금지)', () => {
  const c = loadClient();
  c.renderResult(envelope({
    allergens: ['밀'],
    allergens_v2: { contains: ['밀'], mayContain: ['대두'], inferred: [], evidence: [] },
  }));
  const html = c.el('allergenList').innerHTML;
  assert.ok(/class="allergen-tag may-contain">대두</.test(html),
    `혼입 태그에 may-contain 클래스가 없다 — 직접 함유와 구별되지 않는다.\n${html}`);
  assert.ok(/class="allergen-tag">밀</.test(html), '직접 함유 태그가 기본 클래스여야 한다');
});

t('혼입 가능에는 「직접 들어 있다는 뜻이 아니다」 안내가 붙는다', () => {
  const c = loadClient();
  c.renderResult(envelope({
    allergens: [], allergens_v2: { contains: [], mayContain: ['땅콩'], inferred: [], evidence: [] },
  }));
  const html = c.el('allergenList').innerHTML;
  assert.ok(html.includes('제조시설'), '혼입 설명 문구가 없다');
  assert.ok(html.includes('직접 들어 있다는 뜻은 아니지만'), '오해 방지 문구가 없다');
});

t('★ 함유가 0이고 혼입만 있어도 카드가 표시된다 (혼입 경고가 사라지지 않는다)', () => {
  const c = loadClient();
  c.renderResult(envelope({
    allergens: [],   // flat 은 비어 있다 — 세션44 이전이라면 카드가 숨겨졌다
    allergens_v2: { contains: [], mayContain: ['대두', '우유'], inferred: [], evidence: [] },
  }));
  assert.strictEqual(c.el('allergenCard').style.display, 'block',
    '혼입만 있는 라벨(032·060·006)에서 알레르기 카드가 사라진다');
  assert.ok(c.el('allergenList').innerHTML.includes('대두'));
});

t('3분리가 없으면(사용자 덮어쓰기) flat 목록으로 폴백하고 「구분되지 않음」을 밝힌다', () => {
  const c = loadClient();
  c.renderResult(envelope({ allergens: ['대두', '우유'], allergens_v2: null }));
  const html = c.el('allergenList').innerHTML;
  assert.ok(html.includes('대두') && html.includes('우유'));
  assert.ok(html.includes('구분되지 않은'), '근거 없이 「직접 함유」로 단정하면 안 된다');
  // 안내 문구에는 '직접 함유' 라는 낱말이 들어가지만, **구획 라벨**은 붙지 않아야 한다.
  assert.ok(!html.includes('allergen-label'),
    'flat 폴백에 구획 라벨(직접 함유/혼입 가능)이 붙었다 — 근거 없이 분류한 것');
});

t('알레르기가 전혀 없으면 카드를 숨긴다', () => {
  const c = loadClient();
  c.renderResult(envelope({ allergens: [], allergens_v2: { contains: [], mayContain: [], inferred: [], evidence: [] } }));
  assert.strictEqual(c.el('allergenCard').style.display, 'none');
});

t('★ 계약 방어 — allergens_v2 필드가 배열이 아니어도 렌더가 죽지 않는다', () => {
  const c = loadClient();
  for (const bad of [
    { contains: '밀', mayContain: null, inferred: undefined },
    { contains: undefined, mayContain: undefined, inferred: undefined },
    {},
  ]) {
    c.renderResult(envelope({ allergens: ['밀'], allergens_v2: bad }));
  }
  // 예외 없이 여기까지 오면 통과 (죽으면 알레르기 카드가 통째로 사라진다)
});

t('★ XSS — 알레르기 이름에 태그가 들어와도 이스케이프된다', () => {
  const c = loadClient();
  c.renderResult(envelope({
    allergens: [],
    allergens_v2: { contains: ['<img src=x onerror=alert(1)>'], mayContain: ['<svg onload=alert(2)>'], inferred: [], evidence: [] },
  }));
  const html = c.el('allergenList').innerHTML;
  assert.ok(!html.includes('<img'), 'img 태그가 raw 로 들어갔다');
  assert.ok(!html.includes('<svg'), 'svg 태그가 raw 로 들어갔다');
  assert.ok(html.includes('&lt;img'), '이스케이프 결과가 없다');
});

// ════════════════════════════════════════════════════════════════════════════
section('§7. ReDoS 상한 유지 — 세션43 치명1 이 되살아나지 않는다');

t('공백 9,900자 + 함유 표기가 SLOW_MS(120) 안에 끝난다', () => {
  const evil = `${' '.repeat(9900)}\n밀, 대두 함유`;
  const ms = medianMs(() => detectAllergens(evil));
  assert.ok(ms < SLOW_MS, `${ms.toFixed(1)}ms — 수량자 상한이 풀렸다`);
});

t('detectAllergensV2 도 적대적 입력 5종에서 SLOW_MS(120) 안에 끝난다', () => {
  const N = 9900;
  const battery = [
    ' '.repeat(N),
    '가'.repeat(N),
    ','.repeat(N),
    `${'('.repeat(N)}밀 함유`,
    `${'혼입'.repeat(N / 2)}밀`,
  ];
  for (const s of battery) {
    const ms = medianMs(() => detectAllergensV2(s));
    assert.ok(ms < SLOW_MS, `${ms.toFixed(1)}ms — 입력 ${JSON.stringify(s.slice(0, 6))}… 에서 느리다`);
  }
});

t('★ 합본 표에 법정 19종이 빠짐없이 있다 (표를 줄이면 여기서 걸린다)', () => {
  const LEGAL_19 = ['난류', '우유', '메밀', '땅콩', '대두', '밀', '고등어', '게', '새우', '돼지고기',
    '복숭아', '토마토', '아황산류', '호두', '닭고기', '쇠고기', '오징어', '조개류', '잣'];
  for (const a of LEGAL_19) {
    const got = detectAllergens(`알레르기 유발물질: ${a} 함유`);
    assert.ok(got.length === 1, `${a} → ${JSON.stringify(got)} (1종이어야 한다)`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
section('§8. 캡처 68건 전사 — 회귀 지표 하한');

t('68건 전사에서 밀 검출이 25건 이상이다 (세션44 이전 0건)', () => {
  const dir = path.join(__dirname, '..', '..', '.tmp', 'captures', 'transcripts');
  if (!fs.existsSync(dir)) {
    console.log('     (전사 폴더 없음 — 이 케이스는 건너뜀)');
    return;
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt'));
  let n = 0;
  for (const f of files) {
    if (detectAllergens(fs.readFileSync(path.join(dir, f), 'utf8')).includes('밀')) n += 1;
  }
  assert.ok(n >= 25, `밀 검출 ${n}건 / ${files.length}건 — 세션44 실측은 31건이었다`);
});

t('68건 전사에서 함유 과다 표시 라벨이 없다 (030 재발 방지)', () => {
  // ★ 상한을 14로 잡은 근거 — 68건 실측 최댓값은 캡처 033 의 **11종**이고 그것은 정당하다:
  //   "밀, 대두, 계란, 우유, 게, 새우, 토마토, 닭고기, 쇠고기, 오징어, 조개류(홍합 포함) 함유"
  //   030 결함 시절 값은 19종(법정 전종)이었다. 11 과 19 사이에 선을 둔다.
  //   ⚠ 「19가 아니면 통과」로 느슨하게 두면 15~18종 오탐을 놓친다.
  const dir = path.join(__dirname, '..', '..', '.tmp', 'captures', 'transcripts');
  if (!fs.existsSync(dir)) {
    console.log('     (전사 폴더 없음 — 이 케이스는 건너뜀)');
    return;
  }
  let max = 0;
  let maxFile = '';
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.txt'))) {
    const r = detectAllergensV2(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (r.contains.length > max) { max = r.contains.length; maxFile = f; }
    assert.ok(r.contains.length <= 14,
      `${f}: contains ${r.contains.length}종 — 혼입 문구가 함유로 승격됐을 가능성이 높다 ${JSON.stringify(r.contains)}`);
    // 같은 알레르겐이 함유·혼입 양쪽에 동시에 있으면 병합 우선순위가 깨진 것이다.
    for (const a of r.contains) {
      assert.ok(!r.mayContain.includes(a), `${f}: ${a} 가 함유·혼입 양쪽에 있다`);
    }
  }
  console.log(`     (실측 최댓값 ${max}종 — ${maxFile})`);
});

// ════════════════════════════════════════════════════════════════════════════
section('§9. ★★★ 서브에이전트 검증 결함 재발 방지 (세션44)');

t('★ 치명1 — 긴 원재료 낱말이 짧은 알레르기 명칭을 먹지 않는다', () => {
  // 초판은 두 표를 합본해 _matchSet(최장 우선 소비)에 넣었다.
  //   `밀가루`(3) > `메밀`(2) → "메밀가루 함유" 에서 메밀이 **삭제**됐다.
  //   `콩기름`(3) > `땅콩`(2) → "땅콩기름 함유" 에서 땅콩이 **삭제**됐다.
  // 메밀·땅콩은 국내 아나필락시스 유발 상위다. 라벨에 인쇄된 표기를 지우는 것은 치명이다.
  assert.deepStrictEqual(detectAllergens('메밀가루 함유'), ['메밀', '밀']);
  assert.deepStrictEqual(detectAllergens('땅콩기름 함유'), ['대두', '땅콩']);
  assert.deepStrictEqual(detectAllergens('볶은메밀가루 함유'), ['메밀', '밀']);
  assert.deepStrictEqual(detectAllergens('계란, 메밀가루, 땅콩기름 함유'),
    ['난류', '대두', '땅콩', '메밀', '밀']);
});

t('★ 중대4 — 1글자 명칭이 무관한 낱말에 걸리지 않는다 (실물 096 포함)', () => {
  // 실물 캡처 096: `합성향료(초콜릿향, 밀크향) 우유 함유` → 초판은 `밀` 을 검출했다.
  assert.deepStrictEqual(detectAllergens('합성향료(초콜릿향, 밀크향) 우유 함유'), ['우유']);
  assert.deepStrictEqual(detectAllergens('칼슘을 풍부하게 함유'), []);       // 하「게」
  assert.deepStrictEqual(detectAllergens('우유를 진하게 함유'), ['우유']);    // 하「게」
  assert.deepStrictEqual(detectAllergens('맛의 비밀, 천연조미료 함유'), []);   // 비「밀」
  assert.deepStrictEqual(detectAllergens('밀키트, 정제수 함유'), []);         // 「밀」키트
});

t('중대4 — 조사가 붙은 정상 선언은 그대로 검출된다', () => {
  assert.deepStrictEqual(detectAllergens('이 제품은 밀을 함유하고 있습니다'), ['밀']);
  assert.deepStrictEqual(detectAllergens('밀과 대두 함유'), ['대두', '밀']);
  assert.deepStrictEqual(detectAllergens('대두 및 밀 함유'), ['대두', '밀']);
});

t('★ 중대5 — 함유 선언과 혼입 문구가 한 줄에 뭉쳐도 강등되지 않는다', () => {
  // OCR 이 마침표를 놓치면 한 세그먼트가 된다. 초판은 전부 mayContain 으로 강등했다 —
  // 실제 함유 알레르겐이 「직접 들어 있다는 뜻은 아니지만」 문구로 감싸진다(경고 약화).
  const r = detectAllergensV2('밀, 대두, 우유 함유 메밀, 땅콩을 사용한 제조시설에서 같이 제조하고 있습니다');
  assert.deepStrictEqual(r.contains, ['대두', '밀', '우유']);
  assert.deepStrictEqual(r.mayContain, ['땅콩', '메밀']);

  const r2 = detectAllergensV2('알레르기 유발물질: 우유, 대두 함유 잣을 사용한 시설에서 제조');
  assert.deepStrictEqual(r2.contains, ['대두', '우유'], '레이블 직후에서 자르면 앞부분이 비어버린다');
  assert.deepStrictEqual(r2.mayContain, ['잣']);
});

t('★ 중대5 반대 방향 — 「함유한 제품과 같은 시설」 은 여전히 전체가 혼입이다', () => {
  // 자르는 규칙을 넓히면 세션43 C6 이 깨진다. `함유한`·`함유된`·`함유하는` 은 혼입 문장의 일부다.
  for (const t2 of [
    '새우를 함유한 제품과 같은 제조시설에서 제조하고 있습니다.',
    '우유를 함유된 제품과 같은 라인에서 생산',
  ]) {
    const r = detectAllergensV2(t2);
    assert.deepStrictEqual(r.contains, [], `${t2} → contains 가 비어야 한다`);
    assert.ok(r.mayContain.length > 0, `${t2} → 혼입으로 잡혀야 한다`);
  }
});

t('★ 치명3 — reconcileAllergens 가 flat 항목을 하나도 잃지 않는다', () => {
  // 클라이언트는 v2 가 있으면 flat 을 쓰지 않는다. 둘이 어긋나면 화면에서 사라진다.
  // 실측 재현: 사진에서 11종을 얻은 뒤 사용자가 원재료 텍스트만 보내면 v2 가 `inferred:['밀']` 이
  //   되어 10종이 화면에서 소실됐다.
  const flat = ['게', '난류', '닭고기', '대두', '밀', '새우', '쇠고기', '오징어', '우유', '조개류', '토마토'];
  const r = ocrParser.reconcileAllergens(flat, { contains: [], mayContain: [], inferred: ['밀'], evidence: [] });
  const shown = new Set([...r.contains, ...r.mayContain, ...r.inferred]);
  for (const a of flat) assert.ok(shown.has(a), `${a} 가 3분리에서 빠졌다 — 화면에서 사라진다`);
  assert.strictEqual(shown.size, flat.length);
});

t('치명3 — flat 항목을 「직접 함유」로 승격하지는 않는다 (근거 없는 단정 금지)', () => {
  const r = ocrParser.reconcileAllergens(['우유'], { contains: [], mayContain: [], inferred: [], evidence: [] });
  assert.deepStrictEqual(r.contains, [], 'flat 은 등급 정보가 없다. contains 로 올리면 거짓 단정');
  assert.deepStrictEqual(r.inferred, ['우유']);
});

t('치명3 — 이미 3분리에 있는 항목의 등급을 바꾸지 않는다', () => {
  const r = ocrParser.reconcileAllergens(['우유', '대두'],
    { contains: ['우유'], mayContain: ['대두'], inferred: [], evidence: [] });
  assert.deepStrictEqual(r.contains, ['우유']);
  assert.deepStrictEqual(r.mayContain, ['대두']);
  assert.deepStrictEqual(r.inferred, []);
});

t('치명3 — v2 가 없으면 null 을 그대로 반환한다 (클라이언트 flat 폴백 경로 보존)', () => {
  assert.strictEqual(ocrParser.reconcileAllergens(['밀'], null), null);
  assert.strictEqual(ocrParser.reconcileAllergens(['밀'], undefined), null);
});

t('★ 치명3 — ocrRoutes 두 엔드포인트가 reconcileAllergens 를 거친다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ocrRoutes.js'), 'utf8');
  assert.ok(/require\(['"]\.\.\/services\/ocrParser['"]\)/.test(src)
    && src.includes('reconcileAllergens'), 'ocrRoutes 가 reconcileAllergens 를 import 하지 않는다');
  // ★ 세션46 — 세션45 중대4 수정으로 호출이 2곳에서 5곳으로 늘었다.
  //   /analyze 응답 flat + 응답 v2 · /multi-photo 저장 flat + 응답 flat + 응답 v2.
  //   ★★ 개수만 5로 바꾸면 이 검사는 아무것도 지키지 못한다.
  //      원래 의도는 「raw flat 이 reconcile 을 건너뛰고 나가지 않는다」였다. 그 의도를 검사한다.
  const calls = [...src.matchAll(/reconcileAllergens\(\s*(\w+)\.allergens,\s*(\w+)\.allergens_v2\s*\)/g)];
  assert.strictEqual(calls.length, 5,
    `reconcileAllergens 호출이 ${calls.length}곳 — 5곳(/analyze 2 · /multi-photo 3)이어야 한다`);
  for (const m of calls) {
    assert.strictEqual(m[1], m[2],
      `reconcileAllergens 인자 짝이 어긋났다: ${m[1]}.allergens vs ${m[2]}.allergens_v2`);
  }
  // ★ 어떤 지점도 reconcile 을 거치지 않은 raw flat 을 응답·저장에 그대로 쓰지 않는다.
  assert.ok(!/allergens:\s*analysis\.allergens\s*,/.test(src),
    '/analyze 가 raw flat 을 그대로 낸다 — 혼입이 「직접 함유」로 나간다');
  assert.ok(!/allergens:\s*merged\.allergens\s*,/.test(src),
    '/multi-photo 가 raw flat 을 그대로 낸다 — 혼입이 「직접 함유」로 나간다');
});

t('경미9 — 조사 없는 「밀 포함」 선언도 잡힌다 (030 오탐 재발 없이)', () => {
  assert.deepStrictEqual(detectAllergensV2('밀 포함').contains, ['밀']);
  // 조개류 정의 괄호는 여전히 함유로 승격되지 않는다
  const r = detectAllergensV2('조개류(굴, 전복, 홍합 포함)를 사용한 제품과 같은 제조시설에서 제조');
  assert.deepStrictEqual(r.contains, []);
});

t('경미10 — 「내 용 량」 정규화가 무관한 낱말을 바꾸지 않는다', () => {
  // 초판은 앞 경계가 없어 `국내 용량`·`안내 용량`·`체내 용량` 까지 바꿨다.
  for (const [input, forbidden] of [
    ['국내 용량 표시', '국내용량'],
    ['안내 용량 참고', '안내용량'],
    ['체내 용량 기준', '체내용량'],
  ]) {
    const meta = ocrParser.extractProductMeta(input);
    assert.ok(!JSON.stringify(meta).includes(forbidden),
      `${input} → ${forbidden} 로 치환됐다`);
  }
  // 정상 케이스는 계속 동작한다
  assert.strictEqual(ocrParser.parseNutrition('내 용 량: 60 g').total_content, 60);
});

t('경미11 — evidence 에 상한이 있다 (응답 비대 방지)', () => {
  const r = detectAllergensV2('밀 함유\n'.repeat(1400));
  assert.ok(r.evidence.length <= 50, `evidence ${r.evidence.length}개 — 상한 50이어야 한다`);
  assert.ok(JSON.stringify(r).length < 20000, `응답 ${JSON.stringify(r).length} 바이트 — 너무 크다`);
});

// ════════════════════════════════════════════════════════════════════════════
section('§10. ★★★ 2차 서브에이전트 검증 결함 재발 방지 (세션44)');

t('★ 치명A — `알레르기` + 공백 ReDoS. 411바이트가 SLOW_MS(120) 안에 끝난다', () => {
  // 1차 수정이 "패턴 2곳을 고쳤다"고 적었지만 실제로는 패턴1·4 만 고쳤고
  // `_stripAllergenSuffix` 패턴2(`알레르기|알러지` 접두)가 그대로 남아 있었다.
  // 실측(수정 전): 111 B 82 ms / 211 B 1,146 ms / 311 B 5,604 ms / **411 B 18,055 ms**
  // ★ 411바이트다. MAX_OCR_TEXT_LENGTH(10,000) 절단이 방어가 되지 않는다.
  for (const n of [100, 200, 300, 400, 2000, 9880]) {
    const payload = `원재료명: 알레르기${' '.repeat(n)}x`;
    const ms = medianMs(() => analyzeText(payload.substring(0, 10000)));
    assert.ok(ms < SLOW_MS, `${payload.length}B → ${ms.toFixed(1)}ms`);
  }
});

t('치명A — `알러지` 변형도 같이 막혔다', () => {
  for (const kw of ['알레르기', '알러지', '알레르기 유발물질']) {
    const ms = medianMs(() => analyzeText(`원재료명: ${kw}${' '.repeat(600)}x`));
    assert.ok(ms < SLOW_MS, `${kw} 경로가 느리다 (${ms.toFixed(1)}ms)`);
  }
});

t('★ 치명B — /multi-photo 두 사진 합집합. 표기가 영양표 쪽에 있어도 잃지 않는다', () => {
  // 초판은 `labelV2 || nutritionV2` 였고 analyzeText 는 항상 객체를 반환하므로(빈 배열도 truthy)
  // 라벨 사진이 못 잡으면 영양표 쪽이 **영원히 평가되지 않았다**. 8종 → 1종.
  const LBL = '제품명: 라면\n원재료명: 소맥분(밀:미국산), 팜유, 정제소금\n포장재질: 폴리프로필렌';
  const NUT = '영양정보\n1봉지(120g)당 500 kcal\n나트륨 1,790 mg\n'
    + '♥ 우유, 밀, 쇠고기, 게, 새우, 난류 함유 ♥\n'
    + '본 제품은 메밀, 땅콩을 사용한 제품과 같은 제조시설에서 제조합니다';
  const L = analyzeText(LBL);
  const N = analyzeText(NUT);
  const flat = [...new Set([...(L.allergens || []), ...(N.allergens || [])])].sort();
  const v2 = ocrParser.mergeAllergensV2(L.allergens_v2, N.allergens_v2);
  const fin = ocrParser.reconcileAllergens(flat, v2);
  assert.deepStrictEqual(fin.contains, ['게', '난류', '밀', '새우', '쇠고기', '우유']);
  assert.deepStrictEqual(fin.mayContain, ['땅콩', '메밀']);
  const shown = new Set([...fin.contains, ...fin.mayContain, ...fin.inferred]);
  assert.strictEqual(shown.size, 8, `화면 노출 ${shown.size}종 — 8종이어야 한다`);
});

t('★ 치명B — mergeAllergensV2 는 등급을 낮추지 않는다', () => {
  const a = { contains: ['우유'], mayContain: [], inferred: [], evidence: [] };
  const b = { contains: [], mayContain: ['우유'], inferred: [], evidence: [] };
  const r = ocrParser.mergeAllergensV2(a, b);
  assert.deepStrictEqual(r.contains, ['우유'], '한쪽이 직접 함유라고 읽었으면 그게 근거다');
  assert.deepStrictEqual(r.mayContain, []);
});

t('치명B — 한쪽이 null 이어도 안전하다', () => {
  const v = { contains: ['밀'], mayContain: [], inferred: [], evidence: [] };
  assert.deepStrictEqual(ocrParser.mergeAllergensV2(null, v).contains, ['밀']);
  assert.deepStrictEqual(ocrParser.mergeAllergensV2(v, null).contains, ['밀']);
  assert.strictEqual(ocrParser.mergeAllergensV2(null, null), null);
});

t('★ 중대C — 1글자 경계가 detectAllergensV2 에도 적용된다 (화면이 쓰는 경로)', () => {
  // 1차 수정은 경계 규칙을 flat 에만 걸었다. 화면은 v2 를 쓰므로 오탐이 그대로 보였다.
  const dir = path.join(__dirname, '..', '..', '.tmp', 'captures', 'transcripts', '096.txt');
  if (fs.existsSync(dir)) {
    const r = detectAllergensV2(fs.readFileSync(dir, 'utf8'));
    assert.ok(!r.contains.includes('밀'), `096 실물에서 밀 오탐 — contains=${JSON.stringify(r.contains)}`);
  }
  for (const [text, forbidden] of [
    ['칼슘을 풍부하게 함유', '게'],
    ['비밀 레시피 함유', '밀'],
    ['밀폐용기에 보관, 우유 함유', '밀'],
    ['얼굴 보습 성분 함유', '조개류'],
    ['분말의 밀도를 높이는 성분 함유', '밀'],
    ['비타민 게이지 함유', '게'],
  ]) {
    const v = detectAllergensV2(text);
    const all = [...v.contains, ...v.mayContain, ...v.inferred];
    assert.ok(!all.includes(forbidden), `${text} → ${forbidden} 오탐 (${JSON.stringify(all)})`);
    assert.ok(!detectAllergens(text).includes(forbidden), `${text} → flat 에서 ${forbidden} 오탐`);
  }
});

t('★ 중대D — 「N 함유 제품과 같은 시설」 을 직접 함유로 승격하지 않는다', () => {
  // 1차 수정의 `함유(?![한된하할함])` 는 `함유` + 공백 + `제품과` 형태를 통과시켜
  // 혼입 문구를 contains 로 승격시켰다(거짓 경고 = 안전한 제품을 회피하게 만든다).
  for (const text of [
    '본 제품은 메밀 함유 제품과 같은 제조시설에서 제조하고 있습니다',
    '우유 함유 제품과 같은 라인에서 생산',
    '게, 새우 함유 제품과 동일 라인에서 제조',
    '새우를 함유한 제품과 같은 제조시설에서 제조하고 있습니다.',
  ]) {
    const r = detectAllergensV2(text);
    assert.deepStrictEqual(r.contains, [], `${text} → contains=${JSON.stringify(r.contains)}`);
    assert.ok(r.mayContain.length > 0, `${text} → 혼입으로 잡혀야 한다`);
  }
});

t('★ 중대E — 「함유하고/함유하며/함유함」 선언이 혼입으로 강등되지 않는다', () => {
  // 1차 수정은 이 어미들을 제외 목록에 넣어 자르지 못했고, 세그먼트 전체가 mayContain 이 됐다.
  // s43 보다 나빠진 상태였다. 「밀, 대두를 함유하고 있습니다」는 가장 흔한 선언 어형이다.
  const cases = [
    ['알레르기 유발물질: 밀, 대두를 함유하며 메밀, 땅콩을 사용한 제조시설에서 같이 제조하고 있습니다',
      ['대두', '밀'], ['땅콩', '메밀']],
    ['이 제품은 밀, 대두를 함유하고 있으며 메밀을 사용한 제조시설에서 같이 제조',
      ['대두', '밀'], ['메밀']],
    ['우유, 밀 함유함 메밀을 사용한 제조시설에서 같이 제조',
      ['밀', '우유'], ['메밀']],
  ];
  for (const [text, expC, expM] of cases) {
    const r = detectAllergensV2(text);
    assert.deepStrictEqual(r.contains, expC, `${text.slice(0, 30)} → contains=${JSON.stringify(r.contains)}`);
    assert.deepStrictEqual(r.mayContain, expM, `${text.slice(0, 30)} → may=${JSON.stringify(r.mayContain)}`);
  }
});

t('★ 중대F — 기여 레코드에 allergens_v2 가 저장된다 (혼입 정보 소실 방지)', () => {
  // flat 에서 혼입 항목을 뺀 것은 옳지만, 그 정보가 DB 에 안 남으면 **경고 총량이 순감**한다.
  // 실측: 캡처 032 는 대두·우유, 060 은 난류·대두·메밀 이 저장 경로에서 사라졌다.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'crowdsourceService.js'), 'utf8');
  // ★ 세션46 중대4 — 이제 **raw 가 아니라 reconcile 을 거친 값**을 저장한다.
  //   세션45 판(`allergens_v2: analysis.allergens_v2`)은 응답과 등급이 갈렸다:
  //   flat 에만 있는 이름을 mergeService 가 `contains` 로 확정해 006·046·076 이
  //   응답 inferred / DB contains 로 나뉘었다(라벨이 선언한 적 없는 「직접 함유」).
  //   → 저장돼야 한다는 원래 의도는 그대로 지키되, 값의 출처를 정확히 고정한다.
  assert.ok(/allergens_v2:\s*reconcileAllergens\(\s*analysis\.allergens,\s*analysis\.allergens_v2\s*\)/.test(src),
    'crowdsourceService 가 reconcile 된 allergens_v2 를 저장하지 않는다');
  assert.ok(/allergens:\s*flattenAllergensV2\(/.test(src),
    '저장 flat 이 응답과 같은 함수를 쓰지 않는다 — 규칙이 두 곳에 생긴다');
  assert.ok(!/allergens_v2:\s*analysis\.allergens_v2\s*\|\|/.test(src),
    'raw v2 를 그대로 저장하는 경로가 남아 있다');
});

t('경미I — 「포함되어/포함된/포함하고」 선언이 배제되지 않는다', () => {
  for (const [text, exp] of [
    ['밀 포함', ['밀']],
    ['우유를 포함', ['우유']],
    ['대두 포함되어 있음', ['대두']],
    ['우유 포함된 제품', ['우유']],
    ['대두 포함하고 있습니다', ['대두']],
  ]) {
    assert.deepStrictEqual(detectAllergensV2(text).contains, exp, text);
  }
  // 030 오탐은 재발하지 않는다
  assert.deepStrictEqual(
    detectAllergensV2('조개류(굴, 전복, 홍합 포함)를 사용한 제품과 같은 제조시설에서 제조').contains, []);
});

t('경미M — allergens: [] 를 보내도 서버가 읽은 알레르기를 지우지 않는다', () => {
  // ★★ 세션47 — 옛 검사는 `Array.isArray(productInfo?.allergens) && …length > 0` 라는
  //   **구현 문자열**을 2번 세었다. 경미4 수정으로 그 문자열이 사라지자 적색이 됐다.
  //   여기서 개수만 0으로 맞추면 이 검사는 아무것도 지키지 못한다(세션46 §9 가 못 박은 함정).
  //   → 원래 의도(**빈 배열은 덮어쓰기로 보지 않는다**)를 두 경로 모두에서 검사한다.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ocrRoutes.js'), 'utf8');
  const guards = src.match(/coerceUserAllergens\(productInfo\??\.allergens\)/g) || [];
  assert.strictEqual(guards.length, 2,
    `사용자 알레르기 정규화가 ${guards.length}곳 — /analyze·/multi-photo 두 곳이어야 한다`);
  const gates = src.match(/const\s+userAllergens\w*\s*=\s*coerceUserAllergens[\s\S]{0,120}?\.length\s*>\s*0/g) || [];
  assert.strictEqual(gates.length, 2,
    `길이 가드가 ${gates.length}곳 — 빈 배열이 덮어쓰기로 처리되면 알레르기 카드가 통째로 사라진다`);

  // 그리고 **동작**으로도 고정한다. 소스 문자열 검사만 두면 다음 리팩터에서 또 갈라진다.
  const { coerceUserAllergens } = require('../src/routes/ocrRoutes');
  assert.deepStrictEqual(coerceUserAllergens([]), [], '빈 배열은 빈 배열이어야 한다(덮어쓰기 아님)');
  assert.deepStrictEqual(coerceUserAllergens(undefined), []);
  assert.deepStrictEqual(coerceUserAllergens({ 밀: true }), [], '의미를 추측할 수 없는 형태는 무시한다');
  assert.deepStrictEqual(coerceUserAllergens(['  밀 ', '', '대두']), ['밀', '대두'], '공백만 있는 항목은 버린다');
});

t('★ 세션47 경미4 — 문자열로 온 사용자 알레르기를 버리지 않는다 (과소경고)', () => {
  const { coerceUserAllergens } = require('../src/routes/ocrRoutes');
  // 옛 코드는 `Array.isArray` 가 false 라 **통째로 무시**했다. 그 값이 가는
  // `user_input.allergens` 는 extractCandidatesFromContribution 이 읽지 않으므로 회수도 안 된다.
  assert.deepStrictEqual(coerceUserAllergens('밀,대두'), ['밀', '대두']);
  assert.deepStrictEqual(coerceUserAllergens('밀 · 대두 / 우유'), ['밀', '대두', '우유']);
  assert.deepStrictEqual(coerceUserAllergens('밀\n대두;우유'), ['밀', '대두', '우유']);
  assert.deepStrictEqual(coerceUserAllergens(''), [], '빈 문자열은 덮어쓰기가 아니다');
});

t('경미L — 세그먼트 상한이 실사용 라벨의 함유 선언을 잘라내지 않는다', () => {
  const filler = Array.from({ length: 420 }, (_, i) => `주의사항 문구 ${i}`).join('\n');
  const r = detectAllergensV2(`${filler}\n♥ 우유, 밀, 쇠고기 함유 ♥`);
  assert.deepStrictEqual(r.contains, ['밀', '쇠고기', '우유'],
    '상한에 걸려 선언이 잘렸다 — 직접 함유가 원재료 추정으로 강등된다');
});

t('구분자 보강 — ㆍ·、·전각·및 로 나열된 선언도 읽는다', () => {
  for (const [text, exp] of [
    ['밀ㆍ대두 함유', ['대두', '밀']],
    ['밀、대두 함유', ['대두', '밀']],
    ['＊밀＊ 함유', ['밀']],
    ['우유및밀함유', ['밀', '우유']],
    ['대두 및 밀 함유', ['대두', '밀']],
    ['밀·대두함유', ['대두', '밀']],
  ]) {
    assert.deepStrictEqual(detectAllergens(text), exp, text);
  }
});

t('★ 68건 전사 — 화면에 표시될 최종 집합이 세션43 대비 하나도 줄지 않는다', () => {
  // 세션44는 flat 에서 혼입 항목을 뺐다. 그것이 화면에서 사라지면 안 된다(등급만 바뀌어야 한다).
  const dir = path.join(__dirname, '..', '..', '.tmp', 'captures', 'transcripts');
  if (!fs.existsSync(dir)) {
    console.log('     (전사 폴더 없음 — 건너뜀)');
    return;
  }
  const lost = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.txt'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const flat = detectAllergens(text);
    const v2 = detectAllergensV2(text);
    const fin = ocrParser.reconcileAllergens(flat, v2);
    const shown = new Set([...fin.contains, ...fin.mayContain, ...fin.inferred]);
    for (const a of flat) if (!shown.has(a)) lost.push(`${f}:${a}`);
  }
  assert.strictEqual(lost.length, 0, `화면 소실 ${lost.length}건: ${lost.slice(0, 8).join(', ')}`);
});

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n📊 세션44 알레르기 표시: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})`);
if (fail) {
  console.log('\n실패 상세:');
  failures.forEach((f) => console.log(`  - ${f.name}\n    ${f.message}`));
  process.exit(1);
}
console.log('✅ 전체 통과');
