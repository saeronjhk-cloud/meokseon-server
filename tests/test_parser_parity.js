/**
 * test_parser_parity.js — 세션44 (2026-07-30)
 * ============================================================================
 * 무엇을 고정하는가
 *   **앱 파서(src/services/ocrParser.js)와 정본 파서(scripts/lib/capture_label_parser.js)가
 *   같은 라벨에 같은 답을 낸다.**
 *
 * ★ 왜 이 테스트가 필요한가 — 세 세션 연속으로 같은 사고가 났다
 *   · 세션42 치명1 : 앱을 고쳤는데 정본에 같은 결함이 남아 있었다 (BASIS_TOTAL 순서)
 *   · 세션42 중대5 : 앱에 가드를 넣었는데 정본에는 안 넣었다 (HAS_SERVING_DECLARED)
 *   · 세션43 006   : 정본은 맞고 앱이 틀렸다 (`/i` 플래그 누락 → Kcal 대문자)
 *   전부 **"한쪽 파서만 고치기"** 안티패턴이고, 63-eval 은 정본만 보므로 못 잡는다.
 *   앱 회귀 테스트는 앱만 보므로 또 못 잡는다. **두 파서를 나란히 세우는 테스트가 없었다.**
 *
 * ★ 어휘가 다르다는 점에 주의 — 같은 개념에 다른 이름을 쓴다.
 *   앱: per_serving / per_total / per_100g / per_100ml / unknown
 *   정본: serving   / total    / per100  / per100    / unknown
 *   이 매핑을 BASIS_MAP 한 곳에만 둔다. 어휘가 갈라지면 여기서 걸린다.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const app = require('../src/services/ocrParser');
const canon = require('../scripts/lib/capture_label_parser');

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

const BASIS_MAP = {
  per_serving: 'serving',
  per_total: 'total',
  per_100g: 'per100',
  per_100ml: 'per100',
  unknown: 'unknown',
};

/** 두 파서를 한 번에 돌린다. */
function both(text) {
  const a = app.parseNutrition(text);
  const c = canon.parseLabel(text);
  return {
    app: { basis: a._basis, amount: a._basis_amount ?? null, calories: a.calories ?? null },
    canon: { basis: c.basis, amount: c.basis_amount ?? null, calories: c.nutrition.calories ?? null },
  };
}

function assertSame(text, label) {
  const r = both(text);
  assert.strictEqual(BASIS_MAP[r.app.basis], r.canon.basis,
    `${label} basis 불일치 — app=${r.app.basis} canon=${r.canon.basis}`);
  assert.strictEqual(r.app.calories, r.canon.calories,
    `${label} calories 불일치 — app=${r.app.calories} canon=${r.canon.calories}`);
  return r;
}

// ════════════════════════════════════════════════════════════════════════════
section('§1. 세션42 치명1 — "총 내용량 500 g당" (정본에 세션44까지 남아 있던 결함)');

t('총 내용량 500 g당 → 양쪽 모두 총량 기준', () => {
  const r = assertSame('총 내용량 500 g당\n열량 350 kcal\n나트륨 120 mg 6 %', 'E01');
  assert.strictEqual(r.app.basis, 'per_total');
  assert.strictEqual(r.canon.basis, 'total');
  // ★ 1회 제공량으로 읽히면 amount 에 500 이 들어간다. 그게 결함의 지문이었다.
  assert.strictEqual(r.canon.amount, null, '정본이 500 을 1회 제공량으로 잡았다');
});

t('총 내용량 당 (중량 없음) → 양쪽 모두 총량 기준', () => {
  const r = assertSame('총 내용량 당\n열량 350 kcal', '총내용량당');
  assert.strictEqual(r.canon.basis, 'total');
});

t('★ 순서 보장 — bare "N g 당" 이 총량 규칙을 앞지르지 않는다', () => {
  // "총 내용량 500 g당" 안에는 bare 패턴("500 g당")도 들어 있다.
  // 정본 detectBasis 에서 RE_TOTAL_BASIS 가 RE_SERVING_BARE 뒤에 오면 이 케이스가 깨진다.
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'capture_label_parser.js'), 'utf8');
  const iTotal = src.indexOf('RE_TOTAL_BASIS.test(text)');
  const iBare = src.indexOf('text.match(RE_SERVING_BARE)');
  assert.ok(iTotal > 0 && iBare > 0, '두 검사 지점을 찾지 못했다 — 테스트 갱신 필요');
  assert.ok(iTotal < iBare,
    'detectBasis 에서 RE_TOTAL_BASIS 가 RE_SERVING_BARE 보다 먼저 검사되어야 한다');
});

// ════════════════════════════════════════════════════════════════════════════
section('§2. 세션42 중대5 — 1회 제공량 선언 가드 (정본에 세션44까지 없던 가드)');

t('총 내용량 500 g + 1회 제공량 100 g → 양쪽 모두 unknown', () => {
  const text = '총 내용량 500 g\n1회 제공량 100 g\n열량 45 kcal\n나트륨 400 mg 20 %';
  const r = assertSame(text, 'E02');
  assert.strictEqual(r.app.basis, 'unknown');
  assert.strictEqual(r.canon.basis, 'unknown',
    '정본이 total 로 단정했다 — 신호등이 RACC 로 한 번 더 나눠 거짓 초록이 된다');
});

t('1회 제공량 선언이 없으면 총량 기준이 유지된다 (가드가 과잉 억제하지 않는다)', () => {
  const r = assertSame('총 내용량 62 g\n315 kcal\n나트륨 500 mg 25 %', '총내용량 단독');
  assert.strictEqual(r.app.basis, 'per_total');
  assert.strictEqual(r.canon.basis, 'total');
});

t('1회분/1회 섭취량 표기도 가드에 걸린다 (표현 변형)', () => {
  for (const decl of ['1회분 100 g', '1회 섭취량 100 g', '1회 제공 기준 100 g']) {
    const r = both(`총 내용량 500 g\n${decl}\n열량 45 kcal`);
    assert.strictEqual(r.canon.basis, 'unknown', `정본이 "${decl}" 를 무시했다`);
    assert.strictEqual(r.app.basis, 'unknown', `앱이 "${decl}" 를 무시했다`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
section('§3. 기존 basis 유형이 양쪽에서 동일 (회귀)');

t('1봉지(120 g)당 → serving 120', () => {
  const r = assertSame('총 내용량 600 g (120 g × 5봉지)\n1봉지(120 g)당 500 kcal', '019형');
  assert.strictEqual(r.app.basis, 'per_serving');
  assert.strictEqual(r.app.amount, 120);
  assert.strictEqual(r.canon.amount, 120);
});

t('100 g 당 → per100 (bare 로 새지 않는다)', () => {
  const r = assertSame('총 내용량 600 g\n100 g 당 231 kcal', '030형');
  assert.strictEqual(r.app.basis, 'per_100g');
  assert.strictEqual(r.canon.basis, 'per100');
});

t('60 g 당 (1+단위어 없음) → serving 60', () => {
  const r = assertSame('총 내용량 60 g\n60 g 당 140 kcal', '027형');
  assert.strictEqual(r.app.basis, 'per_serving');
  assert.strictEqual(r.canon.amount, 60);
});

t('★ 세션42 치명 — "탄수화물 250 g / 당류 0 g" 이 1회 제공량 250 으로 읽히지 않는다', () => {
  const text = '총 내용량 500 g\n열량 1155 kcal\n탄수화물 250 g\n당류 0 g';
  const r = both(text);
  assert.notStrictEqual(r.app.amount, 250, '앱이 탄수화물 그램수를 1회 제공량으로 읽었다');
  assert.notStrictEqual(r.canon.amount, 250, '정본이 탄수화물 그램수를 1회 제공량으로 읽었다');
  assert.strictEqual(BASIS_MAP[r.app.basis], r.canon.basis);
});

// ════════════════════════════════════════════════════════════════════════════
section('§4. 세션43 006 — 괄호 총열량 / 대소문자 kcal 이 양쪽에서 같다');

t('총 내용량 30g(155 Kcal) → 양쪽 모두 155', () => {
  const r = assertSame('총 내용량 30g(155 Kcal)\n나트륨 100 mg 5 %', '006');
  assert.strictEqual(r.app.calories, 155, '대문자 Kcal 을 못 읽으면 열량이 통째로 사라진다');
});

t('kcal 대소문자 4종이 양쪽에서 같다', () => {
  for (const u of ['kcal', 'Kcal', 'KCAL', 'kCal']) {
    assertSame(`총 내용량 30 g(155 ${u})`, `단위 ${u}`);
  }
});

t('★ 배수표기 정규식이 두 파일에서 문자 단위로 같다', () => {
  // 세션43 §9 에서 도입한 검사를 여기로 옮겨 유지한다.
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ocrParser.js'), 'utf8');
  const canonSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'capture_label_parser.js'), 'utf8');
  // 이름 있는 상수는 이름으로 뽑는다. 정의가 다음 줄로 넘어가는 경우가 있어 개행을 허용한다.
  const pick = (src, name) => {
    const m = src.match(new RegExp(`${name}\\s*=\\s*\\n?\\s*(/.+?/[gimsuy]*)\\s*;`, 's'));
    return m ? m[1] : null;
  };
  // ★ 정본은 배수표기 정규식을 **이름 없이 inline** 으로 쓴다(replace 인자).
  //   그래서 이름으로 못 찾는다 — 리터럴의 시작 지문으로 찾는다.
  //   (세션43 §9 가 검사하던 대상이 바로 이것이다. 여기로 옮겨 유지한다.)
  const pickMultiplier = (src) => {
    const m = src.match(/\/\(\?:열량\|칼로리\)\?.+?\/gi/s);
    return m ? m[0] : null;
  };
  const appMul = pickMultiplier(appSrc);
  const canonMul = pickMultiplier(canonSrc);
  assert.ok(appMul && canonMul, '배수표기 정규식 리터럴을 찾지 못했다 — 지문이 바뀌었으면 갱신할 것');
  assert.strictEqual(appMul, canonMul,
    `배수표기 정규식이 갈라졌다\n  앱  : ${appMul}\n  정본: ${canonMul}`);

  const pairs = [
    ['BASIS_SERVING_BARE', 'RE_SERVING_BARE'],
    ['BASIS_TOTAL', 'RE_TOTAL_BASIS'],
    ['HAS_SERVING_DECLARED', 'HAS_SERVING_DECLARED'],
    ['BASIS_TOTAL_AMOUNT', 'RE_TOTAL_AMOUNT'],
    ['BASIS_PER100', 'RE_PER100'],
    ['BASIS_SERVING', 'RE_SERVING'],
  ];
  const missing = [];
  for (const [an, cn] of pairs) {
    const a = pick(appSrc, an);
    const c = pick(canonSrc, cn);
    if (!a || !c) { missing.push(`${an}/${cn}`); continue; }
    assert.strictEqual(a, c, `${an}(앱) ≠ ${cn}(정본)\n  앱  : ${a}\n  정본: ${c}`);
  }
  assert.strictEqual(missing.length, 0,
    `정규식을 찾지 못했다: ${missing.join(', ')} — 이름이 바뀌었으면 이 목록을 갱신할 것`);
});

// ════════════════════════════════════════════════════════════════════════════
section('§5. 캡처 68건 전사 전수 — 앱↔정본 동일 답');

t('68건 전사에서 basis 불일치 0건 · calories 불일치 0건', () => {
  const dir = path.join(__dirname, '..', '..', '.tmp', 'captures', 'transcripts');
  if (!fs.existsSync(dir)) {
    console.log('     (전사 폴더 없음 — 이 케이스는 건너뜀)');
    return;
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
  const bad = [];
  const dist = {};
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const r = both(text);
    dist[r.app.basis] = (dist[r.app.basis] || 0) + 1;
    if (BASIS_MAP[r.app.basis] !== r.canon.basis) {
      bad.push(`${f} basis app=${r.app.basis} canon=${r.canon.basis}`);
    }
    if (r.app.calories !== r.canon.calories) {
      bad.push(`${f} calories app=${r.app.calories} canon=${r.canon.calories}`);
    }
  }
  console.log(`     (${files.length}건 · basis 분포 ${JSON.stringify(dist)})`);
  assert.strictEqual(bad.length, 0, `불일치 ${bad.length}건\n  ${bad.slice(0, 10).join('\n  ')}`);
});

t('68건 전사에서 basis unknown 이 12건 이하다 (세션44 실측 7건)', () => {
  // ★ 상한을 두는 이유 — 파서를 보수적으로 만들다가 unknown 이 늘면
  //   신호등이 unknown 을 per_serving 으로 취급하는 현재 정책 때문에 조용히 오판이 늘어난다.
  //   (인수인계 §6-3 — unknown 처리 정책은 제이 결정 대기)
  const dir = path.join(__dirname, '..', '..', '.tmp', 'captures', 'transcripts');
  if (!fs.existsSync(dir)) {
    console.log('     (전사 폴더 없음 — 이 케이스는 건너뜀)');
    return;
  }
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.txt'))) {
    if (app.parseNutrition(fs.readFileSync(path.join(dir, f), 'utf8'))._basis === 'unknown') n += 1;
  }
  assert.ok(n <= 12, `unknown ${n}건 — 세션44 실측은 7건이었다`);
});

// ════════════════════════════════════════════════════════════════════════════
section('§6. ★★★ 서브에이전트 검증 결함 재발 방지 (세션44)');

t('★ 중대6 — 「당류」를 기준 표기로 오독하지 않는다 (양쪽 파서)', () => {
  // 세션44 역이식 초판은 RE_TOTAL_BASIS 에 `(?![가-힣])` 가 없는 채로 순서를 bare 앞으로 옮겼다.
  //   `총 내용량 180 g` + `당류 11 g` + `60 g 당 140 kcal`
  //   → 「당류」의 첫 글자를 기준 표기로 읽어 serving(60) 이 **total** 로 뒤집혔다(거짓 초록 방향).
  // 세션42가 앱 파서에서 고쳤다고 기록한 결함 유형을 정본에 새로 만든 것이다.
  const text = '영양정보\n총 내용량 180 g\n당류 11 g\n60 g 당 140 kcal\n나트륨 1,140 mg';
  const r = both(text);
  assert.strictEqual(r.canon.basis, 'serving', `정본이 ${r.canon.basis} 로 읽었다 — 당류 오독`);
  assert.strictEqual(r.canon.amount, 60);
  assert.strictEqual(r.app.basis, 'per_serving', `앱이 ${r.app.basis} 로 읽었다 — 당류 오독`);
  assert.strictEqual(r.app.amount, 60);
});

t('중대6 — 당알코올·당분도 같이 막는다', () => {
  for (const w of ['당류', '당알코올', '당분']) {
    const r = both(`총 내용량 500 g\n${w} 2 g\n100 g 당 231 kcal`);
    assert.strictEqual(r.app.basis, 'per_100g', `${w} 에서 앱 basis=${r.app.basis}`);
    assert.strictEqual(r.canon.basis, 'per100', `${w} 에서 정본 basis=${r.canon.basis}`);
  }
});

t('중대6 — 「총 내용량 당」 은 여전히 총량 기준으로 읽는다 (경계가 과잉 억제하지 않는다)', () => {
  const r = both('총 내용량 당\n열량 350 kcal');
  assert.strictEqual(r.app.basis, 'per_total');
  assert.strictEqual(r.canon.basis, 'total');
});

t('★ 중대7 — 정본 detectBasis 가 적대적 공백에서 30 ms 안에 끝난다', () => {
  // 역이식 초판은 상한 없는 수량자 4개를 그대로 복사해 3,200자에서 7,861 ms 였다.
  for (const n of [1600, 3200, 9900]) {
    const s = `총 내용량${' '.repeat(n)}`;
    const t0 = Date.now();
    canon.detectBasis(s);
    const ms = Date.now() - t0;
    assert.ok(ms < 30, `정본 ${n}자 ${ms}ms — 수량자 상한이 풀렸다`);
  }
});

t('★ 중대8 — parseNutrition 과 detectNutritionBasis 가 같은 답을 낸다', () => {
  // 초판은 정규화를 parseNutrition 입구에만 넣어 같은 모듈의 두 export 가 다른 답을 냈다.
  //   parseNutrition(096) = per_total  /  detectNutritionBasis(096) = unknown
  // 후자는 ocrRoutes.judgeNutrition 의 basis 폴백 경로다 → per_serving 강등(거짓 빨강).
  const t096 = '※ 총 내용 량 당 (1일 영양성분 기준치에 대한 비율)\n열량 130 kcal\n나트륨 90 mg 5 %';
  assert.strictEqual(app.parseNutrition(t096)._basis, 'per_total');
  assert.strictEqual(app.detectNutritionBasis(t096).basis, 'per_total',
    'detectNutritionBasis 에 정규화가 빠졌다 — 두 export 가 갈라진다');
  assert.strictEqual(canon.detectBasis(t096).basis, 'total');
});

t('★ 중대8 — extractProductMeta 도 「내 용 량」 을 읽는다 (DB 영구 저장 경로)', () => {
  // 실물 캡처 027 `내 용 량: 60 g×3개입`. 이 값은 products.total_content 로 저장된다.
  const meta = app.extractProductMeta('제품명: 쇠고기볶음고추장\n내 용 량: 60 g×3개입\n식품유형: 혼합장');
  assert.strictEqual(meta.total_content, 60, `total_content=${meta.total_content} — 정규화가 빠졌다`);
});

t('★ 치명2 — analyzeText 가 적대적 입력 20종에서 전부 60 ms 안에 끝난다', () => {
  // 세션43 은 16종 12 ms 를 기록했지만, 그 16종에 걸리지 않는 경로 3개가 남아 있었다:
  //   `_stripAllergenSuffix`(404자 3,156 ms) · `1회` serving(402자 16,974 ms) ·
  //   `extractIngredientSection`(9,900자 369 ms) · `extractByLabels`(339 ms) ·
  //   `[,·/\s)]+\s*` while 루프(1,200자 816 ms) · `\d+[.,]?\d*%`(1,200자 620 ms)
  // 교훈: 배터리에 **없던 입력 모양**이 문제였다. 종류를 늘리는 것이 상한을 조이는 것보다 먼저다.
  const M = 9900;
  const battery = {
    공백: ' '.repeat(M),
    탭공백: ' \t'.repeat(M / 2),
    '원재료명+공백+가': `원재료명: 밀가루${' '.repeat(M - 20)}가`,
    '원재료명+공백+가※': `원재료명: 밀가루${' '.repeat(M - 22)}가※`,
    '원재료+공백+가함유': `원재료명: 밀가루${' '.repeat(M - 27)}가 함유`,
    '원재료명만+공백': `원재료명${' '.repeat(M - 8)}`,
    '원재료+콜론런': `원재료명${':'.repeat(M - 10)}설탕`,
    '면콜론런': `*면:${' '.repeat(M - 6)}가`,
    '총내용량+공백': `총 내용량${' '.repeat(M - 10)}`,
    '총내용량+공백탭': `총 내용량${' \t'.repeat((M - 10) / 2)}`,
    '총내용량+당류': `총 내용량${' '.repeat(M - 20)}당류 0 g`,
    '총내용량+콤마런': `총 내용량 ${'1,'.repeat(M / 2)} g (500 kcal)`,
    '1회+공백': `1회${' '.repeat(M - 4)}`,
    '1회+공백탭': `1회${' \t'.repeat((M - 4) / 2)}`,
    '1회+공백+5g': `1회${' '.repeat(M - 8)}5 g`,
    내용량런: '내 용 량'.repeat(M / 8),
    함유런: '밀 함유\n'.repeat(M / 7),
    숫자퍼센트런: `${'1'.repeat(M - 2)} %`,
    원재료퍼센트런: `원재료명: 설탕${'1'.repeat(M - 20)}%`,
    메타혼합: `제품명: 내용량: 식품유형: 원재료명: ${' '.repeat(M - 40)}`,
  };
  let worst = 0;
  let worstKey = '';
  for (const [k, v] of Object.entries(battery)) {
    const t0 = Date.now();
    app.analyzeText(v);
    const ms = Date.now() - t0;
    if (ms > worst) { worst = ms; worstKey = k; }
  }
  console.log(`     (${Object.keys(battery).length}종 · 최악 ${worst} ms — ${worstKey})`);
  assert.ok(worst < 60, `${worstKey} = ${worst}ms — 상한 없는 수량자가 남아 있다`);
});

t('치명2 — 개별 저격 입력이 30 ms 안에 끝난다 (O(n²) 지문 검사)', () => {
  // 9,900자로만 재면 O(n²) 를 놓칠 수 있다. 짧은 입력에서 이미 느린지 본다.
  const shots = {
    'stripAllergenSuffix 804자': `원재료명: 밀가루${' '.repeat(800)}가`,
    '1회 serving 402자': `1회${' '.repeat(400)}`,
    '퍼센트 1200자': `원재료명: 설탕${'1'.repeat(1200)}%`,
    '메타 2400자': `제품명: ${' \t'.repeat(1200)}`,
  };
  for (const [k, v] of Object.entries(shots)) {
    const t0 = Date.now();
    app.analyzeText(v);
    const ms = Date.now() - t0;
    assert.ok(ms < 30, `${k} = ${ms}ms`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
section('§7. 2차 검증 — 정본 ReDoS · 구분자 상한 · 원재료 절단');

t('★ 경미K — 정본 ING_STOP 이 개행런에서 30 ms 안에 끝난다', () => {
  // 실측(수정 전): `밀가루` + 개행 1,200 → search 697 ms / 2,400 → parseLabel 5,886 ms.
  // ★ 방법론 — 순수 개행 문자열은 V8 1바이트 fast-path 때문에 0 ms 로 나온다.
  //   한글을 1글자 섞어 **2바이트 문자열**로 만들어야 드러난다. 1차 검증이 놓친 이유다.
  for (const n of [1200, 2400, 4800]) {
    const s = `원재료명: 밀가루${'\n'.repeat(n)}`;
    const t0 = Date.now();
    canon.parseLabel(s);
    const ms = Date.now() - t0;
    assert.ok(ms < 30, `정본 개행 ${n}자 ${ms}ms`);
  }
});

t('경미G — 레이블·값 구분자가 20자까지 읽힌다 (일괄 치환 축소 보정)', () => {
  // `\s*[:\s]*` → `[:\s]{0,8}` 로 바꾸면서 s43(무제한) 대비 **순수 축소**가 됐다.
  // 68건 실물 최대 4자라 영향 0건이었지만, 9자에서 정본 영양소 10종이 전량 소실됐다.
  for (const gap of [1, 4, 8, 12, 20]) {
    const t = `총 내용량${' '.repeat(gap)}600 g\n나트륨${' '.repeat(gap)}1790 mg`;
    assert.strictEqual(app.parseNutrition(t).total_content, 600, `gap ${gap} 에서 총 내용량 소실`);
    assert.strictEqual(app.parseNutrition(t).sodium, 1790, `gap ${gap} 에서 나트륨 소실`);
  }
});

t('★ 원재료명 상한 2,000자 — 68건 실물에서 문자 단위로 변화가 없다', () => {
  // `(.+?)` → `(.{1,2000}?)` 는 **동작을 바꾼다**(주석이 처음에 반대로 적혀 있었다).
  // 실물에서 영향이 없다는 것을 회귀로 고정한다. 68건 최장 644자.
  const dir = path.join(__dirname, '..', '..', '.tmp', 'captures', 'transcripts');
  if (!fs.existsSync(dir)) {
    console.log('     (전사 폴더 없음 — 건너뜀)');
    return;
  }
  let max = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.txt'))) {
    const s = app.extractIngredientSection(fs.readFileSync(path.join(dir, f), 'utf8')) || '';
    if (s.length > max) max = s.length;
  }
  console.log(`     (원재료명 최장 ${max}자 / 상한 2,000)`);
  assert.ok(max < 2000, `원재료명 최장 ${max}자 — 상한 2,000 에 근접했다. 상한을 올릴지 검토할 것`);
});

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n📊 세션44 앱↔정본 파서 동치: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})`);
if (fail) {
  console.log('\n실패 상세:');
  failures.forEach((f) => console.log(`  - ${f.name}\n    ${f.message}`));
  process.exit(1);
}
console.log('✅ 전체 통과');
