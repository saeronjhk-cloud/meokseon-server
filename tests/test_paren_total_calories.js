/**
 * test_paren_total_calories.js — 세션43 (2026-07-30)
 * ============================================================================
 * 무엇을 고정하는가
 *   괄호 총열량 패턴 `(1,740 kcal)` / `(490 kcal)` / `(155 Kcal)`.
 *   세션41 §5-1 에서 발견 → 세션42 미처리 이월 → 세션43 처리.
 *
 * ★ 배수표기(`X kcal(Y kcal×N)`, 019)와 **다른 유형**이다. 괄호 안 kcal 이 하나뿐, 배수가 없다.
 *   026 코피코캔디 : `내 용 량: 384 g (32 g x 12개) (1,740 kcal)` + `1개입(32 g)당 145 kcal`
 *   082 국산콩두부 : `600 g(300 g x 2) (490 kcal)`               + `1 개 (300 g) 당 245 kcal`
 *                    ★ 082 는 `내용량` 이라는 글자조차 없다 — 중량 표기에만 붙어 있다.
 *   006 대천김     : `총 내용량 30g(155 Kcal)`  ← 총량=1회분이라 **이것이 유일한 정답**
 *
 * ★ 세 값의 성격이 다르다는 것이 이 패턴의 핵심이다.
 *   026·082 에서 괄호값은 **총량**이고 1회분으로 쓰면 12배·2배 과대(거짓 빨강)다.
 *   006 에서 괄호값은 **정답**이고 버리면 열량이 통째로 사라진다.
 *   → 후보 풀에서는 빼고, 값은 총량으로 보존하고, 기준이 총량일 때만 쓴다.
 *
 * ★ 전 텍스트는 `.tmp/captures/transcripts/` 실물 전사에서 왔다. 가공 예제가 아니다.
 */
'use strict';

const assert = require('assert');
const ocrParser = require('../src/services/ocrParser');
const capParser = require('../scripts/lib/capture_label_parser');

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
 * ★★★ 세션45 — 성능 단정의 측정법·상한을 test_parser_parity.js 와 통일했다.
 *
 * 두 가지가 잘못돼 있었다.
 *   ① 콜드 런 1회 측정 → JIT 컴파일 비용이 그대로 섞인다(중앙값 7.8 ms / 최댓값 42.6 ms).
 *   ② 상한 30 ms 가 **제이 PC 전용 숫자**였다. Claude 샌드박스는 1.5~2배 느려서
 *      정상 코드가 무작위로 실패한다(실측: 한글 70 / 내용량반복 98 / 미완성괄호 81 ms).
 *   그 결과 "수량자 중복이 남아 있다" 는 **거짓 진단**이 나왔다.
 *   무작위로 빨간불이 뜨는 감시 장치는 사람이 무시하게 된다 — 빡빡한 상한은 안전이 아니다.
 *
 * 왜 SLOW_MS(120)·SLOW_MS*2(240) 로 충분한가 —
 *   막으려는 실패 모드는 초 단위다: detectAllergens 5,000자 25초 초과 ·
 *   `_stripAllergenSuffix` 411 B 18,055 ms · 정본 ING_STOP 2,400자 5,886 ms.
 *   120 ms 는 그중 가장 작은 것보다도 49배 아래다. 감시 능력은 유지된다.
 *
 * ★ 정밀 탐지는 test_parser_parity.js §6 의 「2배 길이 → 배수」 검사가 담당한다.
 *   배수는 기계에 의존하지 않으므로 그쪽이 ReDoS 의 정확한 지문이다.
 * ❌ 실패할 때마다 이 숫자를 올리지 말 것 — 올릴 근거는 "정상 상한을 재실측했다" 뿐이다.
 */
const SLOW_MS = 120;

function medianMs(fn, runs = 3) {
  fn();                                  // 워밍업 — JIT 컴파일 비용을 측정에서 뺀다
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

// ── 실물 전사 (핵심 줄만 발췌, 원문 표기 그대로) ─────────────────────────────
const T026 = `제 품 명: 코피코 커피맛 캔디
식품유형: 캔디류
내 용 량: 384 g (32 g x 12개) (1,740 kcal)
영양정보
총 내용량 384 g (32 g x 12개입)
1개입(32 g)당 145 kcal
나트륨 45 mg 2 %
탄수화물 29 g 9 %
당류 19 g 19 %
지방 3 g 6 %
포화지방 1.5 g 10 %
콜레스테롤 0 mg 0 %
단백질 0.35 g 1 %`;

const T082 = `제품명 : 국산콩두부
600 g(300 g x 2) (490 kcal)
· 식품유형 : 두부
영양정보
총 내용량 600 g (300 g X 2 개)
1 개 (300 g) 당 245 kcal
나트륨 10 mg 1 %
탄수화물 5 g 2 %
당류 2 g 2 %
지방 15 g 28 %
포화지방 2.7 g 18 %
단백질 24 g 44 %`;

const T006 = `제품명: 대천김 곱창김
식품유형: 가공김(조미김)
내용량: 30g
영양정보
총 내용량 30g(155 Kcal)
나트륨 430mg 22 %
탄수화물 12g 4 %
당류 0g 0 %
지방 9g 17 %
포화지방 1.2g 8 %
단백질 7g 13 %`;

// ════════════════════════════════════════════════════════════════════════════
section('§1. 026 코피코캔디 — 1,740 은 총량이다 (12배 과대 차단)');

t('026 열량 = 145 (1회분). 1,740 이 들어오면 12배 거짓 빨강', () => {
  const n = ocrParser.parseNutrition(T026);
  assert.strictEqual(n.calories, 145, `calories=${n.calories}`);
});

t('026 괄호 총열량 1,740 은 버리지 않고 _total 에 남긴다', () => {
  const n = ocrParser.parseNutrition(T026);
  assert.strictEqual(n._total && n._total.calories, 1740, `_total=${JSON.stringify(n._total)}`);
});

t('026 제거 근거가 기록된다 (감사 추적)', () => {
  const n = ocrParser.parseNutrition(T026);
  assert.ok(Array.isArray(n._calorie_noise_removed) && n._calorie_noise_removed.length > 0);
  assert.ok(n._calorie_noise_removed.join(' ').includes('1,740'));
  assert.strictEqual(n._calorie_total_from_content, 1740);
});

t('★ 괄호만 지운다 — 총 내용량 384 g 은 살아 있어야 한다', () => {
  const n = ocrParser.parseNutrition(T026);
  assert.strictEqual(n.total_content, 384, '매치 전체를 지우면 total_content 가 날아간다');
  assert.strictEqual(n.serving_size, 32);
  assert.strictEqual(n._basis, 'per_serving');
});

t('026 나트륨 등 다른 영양소는 영향받지 않는다', () => {
  const n = ocrParser.parseNutrition(T026);
  assert.strictEqual(n.sodium, 45);
  assert.strictEqual(n.total_sugars, 19);
  assert.strictEqual(n.saturated_fat, 1.5);
});

// ════════════════════════════════════════════════════════════════════════════
section('§2. 082 국산콩두부 — 「내용량」 글자가 없는 형태 (2배 과대 차단)');

t('082 열량 = 245 (490 이면 2배 거짓)', () => {
  const n = ocrParser.parseNutrition(T082);
  assert.strictEqual(n.calories, 245, `calories=${n.calories}`);
});

t('★ 레이블 없는 중량 줄에서도 괄호 총열량을 잡는다 (BARE 패턴)', () => {
  const n = ocrParser.parseNutrition(T082);
  assert.strictEqual(n._calorie_total_from_content, 490,
    '`600 g(300 g x 2) (490 kcal)` 에는 내용량 레이블이 없다 — 구조로 잡아야 한다');
});

t('082 총 내용량·1회 제공량 유지', () => {
  const n = ocrParser.parseNutrition(T082);
  assert.strictEqual(n.total_content, 600);
  assert.strictEqual(n.serving_size, 300);
  assert.strictEqual(n._basis, 'per_serving');
});

// ════════════════════════════════════════════════════════════════════════════
section('§3. 006 대천김 — 괄호값이 유일한 정답 (지우면 열량 소실)');

t('★ 006 열량 = 155. 이전에는 undefined 였다 (대문자 Kcal — 최후 fallback 에 `i` 누락)', () => {
  const n = ocrParser.parseNutrition(T006);
  assert.strictEqual(n.calories, 155, `calories=${n.calories}`);
});

t('006 은 총량 기준이다 (basis per_total)', () => {
  const n = ocrParser.parseNutrition(T006);
  assert.strictEqual(n._basis, 'per_total');
  assert.strictEqual(n.total_content, 30);
});

t('006 열량의 출처가 괄호 총열량임을 명시한다', () => {
  const n = ocrParser.parseNutrition(T006);
  assert.strictEqual(n._calorie_source, 'content_line_total');
});

t('소문자 kcal·대문자 KCAL 모두 처리된다', () => {
  for (const unit of ['kcal', 'Kcal', 'KCAL', 'kCal']) {
    const n = ocrParser.parseNutrition(T006.replace('155 Kcal', `155 ${unit}`));
    assert.strictEqual(n.calories, 155, `unit=${unit} → ${n.calories}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
section('§4. ★ 정답을 지우지 않는다 — 1회분 선언이 같은 줄에 있는 경우');

const T_SERVING_PAREN = `식품유형: 과자
총 내용량 90 g
1회 제공량 30 g (150 kcal)
나트륨 100 mg 5 %`;

t('`1회 제공량 30 g (150 kcal)` 의 150 은 1회분이다 — 지우면 안 된다', () => {
  const n = ocrParser.parseNutrition(T_SERVING_PAREN);
  assert.strictEqual(n.calories, 150, `calories=${n.calories}`);
  assert.strictEqual(n._calorie_total_from_content, undefined,
    '1회분 선언이 있는 줄을 총열량으로 오인했다');
});

t('★ 검사는 매치가 아니라 줄 전체로 한다 (BARE 매치는 `30 g (150 kcal)` 에서 시작한다)', () => {
  // 초판 구현은 매치 문자열만 검사해서 이 케이스를 놓쳤다.
  const n = ocrParser.parseNutrition(T_SERVING_PAREN);
  assert.ok(!(n._calorie_noise_removed || []).join(' ').includes('150'));
});

t('`1회 30 g 당 (150 kcal)` 도 보존된다', () => {
  const n = ocrParser.parseNutrition('총 내용량 90 g\n1회 30 g 당 (150 kcal)\n나트륨 100 mg');
  assert.strictEqual(n.calories, 150);
});

t('1회분 기준(per_serving)인데 괄호값만 있으면 열량을 비운다 (12배보다 공백이 낫다)', () => {
  // 026 에서 `당 145 kcal` 이 OCR 로 깨진 상황. basis 는 여전히 per_serving.
  const broken = T026.replace('1개입(32 g)당 145 kcal', '1개입(32 g)당 145 kca1');
  const n = ocrParser.parseNutrition(broken);
  assert.strictEqual(n._basis, 'per_serving');
  assert.notStrictEqual(n.calories, 1740, '1회분 기준에 총량을 넣으면 12배 거짓 빨강이다');
});

t('per_100g 라벨에도 괄호 총열량을 쓰지 않는다', () => {
  const n = ocrParser.parseNutrition('총 내용량 500 g (2,000 kcal)\n100 g 당\n나트륨 400 mg 20 %');
  assert.strictEqual(n._basis, 'per_100g');
  assert.notStrictEqual(n.calories, 2000);
});

// ════════════════════════════════════════════════════════════════════════════
section('§5. 019 배수표기와 충돌하지 않는다 (규칙 순서)');

const T019 = `제품명 신라면컵
중량:390 g(65 g×6입)
열량:1,800 kcal(300 kcal×6입)
총 내용량 390 g(65 g×6공기)
1용기(65 g)당 300 kcal
나트륨 1,640 mg 82 %`;

t('019 열량 = 300 (배수표기 규칙이 먼저 소화한다)', () => {
  const n = ocrParser.parseNutrition(T019);
  assert.strictEqual(n.calories, 300);
});

t('019 나트륨 1,640 유지 (세션39 천단위 콤마 방어)', () => {
  const n = ocrParser.parseNutrition(T019);
  assert.strictEqual(n.sodium, 1640);
});

t('배수표기는 괄호 총열량으로 오인되지 않는다 (`×6입)` 이 닫는 괄호 앞에 있다)', () => {
  const n = ocrParser.parseNutrition(T019);
  assert.strictEqual(n._calorie_total_from_content, undefined);
});

// ════════════════════════════════════════════════════════════════════════════
section('§6. _total.calories 구조 방어');

t('괄호값이 1회분 값보다 작으면 총량으로 기록하지 않는다', () => {
  // 구조를 잘못 읽은 경우다. 총량이 1회분보다 작을 수는 없다.
  const n = ocrParser.parseNutrition('총 내용량 500 g (100 kcal)\n1회 100 g 당 300 kcal\n나트륨 400 mg');
  assert.strictEqual(n.calories, 300);
  assert.ok(!n._total || n._total.calories !== 100, `_total=${JSON.stringify(n._total)}`);
});

t('dual-column 에서 이미 총량 열량을 얻었으면 덮어쓰지 않는다', () => {
  const n = ocrParser.parseNutrition(T026);
  assert.strictEqual(n._total.calories, 1740);
});

// ════════════════════════════════════════════════════════════════════════════
section('§7. ★ ReDoS — 세션42 치명2 재발 방지');

t('공백 3 KB 입력이 SLOW_MS(120) 안에 끝난다', () => {
  const evil = `내 용 량: 384 g ${' '.repeat(3000)}(1,740 kcal)`;
  const ms = medianMs(() => ocrParser.parseNutrition(evil));
  assert.ok(ms < SLOW_MS, `${ms.toFixed(1)}ms — 간격 수량자에 상한이 없다`);
});

t('괄호 여닫이 반복 8 KB 입력이 SLOW_MS(120) 안에 끝난다', () => {
  const evil = `총 내용량 100 g ${'(1 g x 2) '.repeat(800)}(500 kcal)`;
  const ms = medianMs(() => ocrParser.parseNutrition(evil));
  assert.ok(ms < SLOW_MS, `${ms.toFixed(1)}ms`);
});

t('숫자·콤마 긴 런이 SLOW_MS(120) 안에 끝난다', () => {
  const evil = `총 내용량 ${'1,'.repeat(4000)} g (500 kcal)`;
  const ms = medianMs(() => ocrParser.parseNutrition(evil));
  assert.ok(ms < SLOW_MS, `${ms.toFixed(1)}ms`);
});

t('정본 파서도 같은 입력에서 SLOW_MS(120) 안에 끝난다', () => {
  const evil = `내 용 량: 384 g ${' '.repeat(3000)}(1,740 kcal)`;
  const ms = medianMs(() => capParser.parseLabel(evil));
  assert.ok(ms < SLOW_MS, `${ms.toFixed(1)}ms`);
});

// ════════════════════════════════════════════════════════════════════════════
section('§8. ★ 정본(capture_label_parser)과 앱 파서가 같은 답을 낸다');

t('026 — 두 파서 모두 145', () => {
  assert.strictEqual(ocrParser.parseNutrition(T026).calories, 145);
  assert.strictEqual(capParser.parseLabel(T026).nutrition.calories, 145);
});

t('082 — 두 파서 모두 245', () => {
  assert.strictEqual(ocrParser.parseNutrition(T082).calories, 245);
  assert.strictEqual(capParser.parseLabel(T082).nutrition.calories, 245);
});

t('006 — 두 파서 모두 155', () => {
  assert.strictEqual(ocrParser.parseNutrition(T006).calories, 155);
  assert.strictEqual(capParser.parseLabel(T006).nutrition.calories, 155);
});

t('1회분 괄호 케이스 — 두 파서 모두 150 보존', () => {
  assert.strictEqual(ocrParser.parseNutrition(T_SERVING_PAREN).calories, 150);
  assert.strictEqual(capParser.parseLabel(T_SERVING_PAREN).nutrition.calories, 150);
});

t('★ 정본은 basis 를 받아서 판단한다 (인자 누락 시 조용히 퇴화하지 않도록 고정)', () => {
  // basis='serving' 을 주면 괄호 총열량을 열량으로 쓰지 않는다.
  const noServingKcal = T026.replace('1개입(32 g)당 145 kcal', '1개입(32 g)당');
  assert.notStrictEqual(capParser.extractCalories(noServingKcal, 'serving').calories, 1740);
  // basis='total' 이면 쓴다.
  assert.strictEqual(capParser.extractCalories(T006, 'total').calories, 155);
});

// ════════════════════════════════════════════════════════════════════════════
section('§9. ★★ 서브에이전트 검증에서 잡힌 결함 재발 방지 (세션43)');

t('중대3-a 원재료명의 `포도당 `·`설탕 ` 이 총열량 제거를 억제하지 않는다', () => {
  // 표가 한 줄로 평탄화된 라벨(캡처 048·065 형). 초판 가드 `당[\\s:]` 가 여기 걸렸다.
  const flat = '식품유형: 캔디류 내 용 량: 384 g (32 g x 12개) (1,740 kcal) '
    + '원재료명: 설탕, 포도당시럽 5%, 정백당 , 버터\n총 내용량 384 g\n1개입(32 g)당 145 kcal\n나트륨 45 mg';
  const n = ocrParser.parseNutrition(flat);
  assert.strictEqual(n.calories, 145);
  assert.strictEqual(n._calorie_total_from_content, 1740, '억제되면 12배 거짓 빨강 경로가 다시 열린다');
});

t('중대3-b `당류` 줄에서도 억제되지 않는다 (당 뒤 한글)', () => {
  const n = ocrParser.parseNutrition('총 내용량 30g(155 Kcal)\n당류 0g 0 %\n나트륨 430mg 22 %');
  assert.strictEqual(n.calories, 155);
  assert.strictEqual(n._calorie_total_from_content, 155);
});

t('중대3-c 1회 제공량이 괄호 **뒤**에 오면 총열량으로 제거한다 (위치 검사)', () => {
  const n = ocrParser.parseNutrition('식품유형: 과자\n총 내용량 400 g (1,600 kcal) 1회 제공량 100 g\n나트륨 400 mg 20 %');
  assert.strictEqual(n._calorie_total_from_content, 1600, '괄호는 앞의 총 내용량에 붙은 것이다');
});

t('중대3-d 그 경우 1,600 을 1회분 열량으로 쓰지 않는다 (4배 거짓 빨강 차단)', () => {
  const n = ocrParser.parseNutrition('식품유형: 과자\n총 내용량 400 g (1,600 kcal) 1회 제공량 100 g\n나트륨 400 mg 20 %');
  assert.strictEqual(n.serving_size, 100, '전제: 1회 제공량이 잡혀야 한다');
  assert.notStrictEqual(n.calories, 1600, '1회 제공량이 선언돼 있으면 총열량을 쓰지 않는다');
});

t('중대3-e 1회 제공량이 괄호 **앞**이면 그대로 보존한다', () => {
  const n = ocrParser.parseNutrition('식품유형: 과자\n총 내용량 90 g\n1회 제공량 30 g (150 kcal)\n나트륨 100 mg 5 %');
  assert.strictEqual(n.calories, 150);
  assert.strictEqual(n._calorie_total_from_content, undefined);
});

t('★ 치명1 detectAllergens ReDoS — 공백 9,900자가 SLOW_MS(120) 안에 끝난다', () => {
  // 수정 전 실측: 2,000자 1.8초 / 4,000자 14.2초 / 5,000자 25초 초과.
  // 무인증 `POST /api/ocr/analyze` 로 요청 1건이 이벤트 루프를 분 단위로 정지시킬 수 있었다.
  const evil = `${' '.repeat(9900)}\n총 내용량 30 g\n우유 함유`;
  const ms = medianMs(() => ocrParser.detectAllergens(evil));
  assert.ok(ms < SLOW_MS, `${ms.toFixed(1)}ms — 수량자 중복이 남아 있다`);
});

t('치명1 수정 후에도 알레르기 표기 3형식이 정상 동작한다', () => {
  // ★ 세션43 에서는 기대값을 **HEAD 실측**으로 고정했다("바뀌지 않았다"만 검사).
  //   그래서 `♥ 우유, 밀, 쇠고기 함유 ♥` 의 기대값이 `['쇠고기','우유']` — 즉 **틀린 답**이었다.
  //   ★ 세션44 에서 `밀` 단독 표기 누락을 고쳤으므로 기대값을 **정답**으로 올린다.
  //     상세 회귀는 tests/test_allergen_declared.js 가 담당한다. 여기서는 ReDoS 수정이
  //     검출 결과를 망가뜨리지 않았다는 것만 본다.
  assert.deepStrictEqual(ocrParser.detectAllergens('알레르기유발물질: 우유, 대두 함유'), ['대두', '우유']);
  assert.deepStrictEqual(ocrParser.detectAllergens('♥ 우유, 밀, 쇠고기 함유 ♥'), ['밀', '쇠고기', '우유']);
  // ★★★ 세션60 갱신 — 기대값이 `['대두','밀']` 이었다. `밀가루` 는 **원재료 형태**다.
  //   세션58 D55-2(원재료 추론 폐기, 제이 승인)로 판별기 B 는 **법정 19종 명칭만** 읽는다.
  //   ⇒ `밀가루` 에서 `밀` 을 만들지 않는 것이 «현재 정책상 옳은 답»이다.
  //
  //   ⚠⚠ 이 한 줄이 «5세션치 배포를 막고 있었다». 세션60 실측:
  //     · `a0dfed3`(세션54·55) → ['대두','밀'] 통과 → CI 초록 → 배포됨
  //     · `6e67532`(세션56·57·58) → ['대두'] **실패** → CI 빨강
  //       → Railway `Wait for CI` 가 배포를 SKIP → 세션56~60 이 **한 줄도 운영에 안 갔다**
  //     아무도 못 본 이유: 커밋 .bat 의 회귀 17개 목록에 **이 파일이 없었다.**
  //     `.github/workflows/gate.yml` 의 `npm run test:ocr` 에는 있다. 두 목록이 갈라져 있었다.
  //
  //   ★ 「밀을 놓치면 과소경고 아닌가」 — 그 위험은 세션59 `U58-4` 가 이미 쟀다.
  //     실물 68건 · 선언/혼입 세그먼트 106개 전수에서
  //     「법정명 없이 원재료 형태로만 인쇄된 선언」 **0건 · 과소경고 상한 0종**.
  //     `IP/U58-4_실측_2026-08-09_세션59.md`
  //   ⚠ 그러므로 이 기대값을 되돌리려면 **U58-4 를 먼저 뒤집어야 한다.** 느낌으로 바꾸지 말 것.
  //   ⓘ 판별기 C(`detectAllergensV2`)는 선언 세그먼트 안의 원재료 복합어를 여전히 읽는다(`U58-1`).
  //     B ⊆ C 이므로 화면 경고는 줄지 않는다.
  assert.deepStrictEqual(ocrParser.detectAllergens('대두, 밀가루 함유'), ['대두']);
  assert.deepStrictEqual(ocrParser.detectAllergens('본 제품은 우유, 땅콩을 함유하고 있습니다'), ['땅콩', '우유']);
});

t('★ 중대2 analyzeText 적대적 입력 16종 전부 SLOW_MS*2(240) 안에 끝난다', () => {
  const N = 9900;
  const battery = {
    공백: ' '.repeat(N),
    탭공백: '\t '.repeat(N / 2),
    콜론: ':'.repeat(N),
    공백콜론: ' : '.repeat(N / 3),
    숫자콤마: '1,'.repeat(N / 2),
    한글: '가'.repeat(N),
    괄호: '('.repeat(N),
    괄호쌍: '(1 g x 2) '.repeat(N / 10),
    '공백+라벨': `${' '.repeat(N - 40)}\n총 내용량 30 g\n우유 함유`,
    '공백+열량': `${' '.repeat(N - 40)}\n열량 100 kcal\n나트륨 10 mg`,
    내용량반복: '총 내용량 '.repeat(N / 6),
    '1회반복': '1회 '.repeat(N / 4),
    당반복: '당 '.repeat(N / 2),
    한글공백: '가 '.repeat(N / 4),
    미완성괄호: `내 용 량: 384 g ${' '.repeat(N - 60)}(1,740 kcal`,
    '열량+공백반복': `열량: ${' '.repeat(200)}`.repeat(40),
  };
  // ★ 세션44: 상한을 30 → 60 ms 로 올렸다. 근거를 남긴다.
  //   `내용량반복`(`'총 내용량 '` × 1,650)은 **실제 매치가 1,650개** 있는 입력이다.
  //   매치 수에 비례하는 선형 비용이며 ReDoS(입력 길이에 초선형)가 아니다.
  //   세션44가 `[:\s]{0,8}` → `{0,20}` 으로 넓히면서(구분자 9자 이상 값 소실 수정)
  //   매치당 비용이 조금 늘어 34 ms 가 됐다.
  // ★★ 세션45: 상한을 60 → SLOW_MS*2(240) 로 올리고 측정을 중앙값으로 바꿨다.
  //   세션44 의 60 ms 는 제이 PC 실측이다. 샌드박스 콜드 런 실측은
  //   한글 70 / 공백+라벨 62 / 내용량반복 98 / 당반복 69 / 미완성괄호 81 ms 로 전부 넘겼다.
  //   전부 **매치 수에 비례하는 선형 비용**이며(`총 내용량 ` × 1,650 개 등) 초선형이 아니다.
  //   ⚠ 세션44 주석은 "100 ms 이상 올리지 말 것" 이라고 적었지만, 그 기준으로는
  //     다른 기계에서 정상 코드가 실패한다. 절대 ms 를 기계 독립 기준처럼 쓴 것이 오류였다.
  //     → 절대 상한은 **거친 백스톱**으로 두고, 정밀 탐지는
  //       test_parser_parity.js §6 의 배수 검사(2배 길이 → 8배 미만)가 맡는다.
  const slow = [];
  for (const [k, v] of Object.entries(battery)) {
    const ms = medianMs(() => ocrParser.analyzeText(v));
    if (ms >= SLOW_MS * 2) slow.push(`${k}=${ms.toFixed(1)}ms`);
  }
  assert.strictEqual(slow.length, 0, `느린 입력: ${slow.join(', ')}`);
});

t('MAX_OCR_TEXT_LENGTH(10,000) 이내 입력이므로 절단이 방어가 되지 않는다는 전제 확인', () => {
  const routes = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'routes', 'ocrRoutes.js'), 'utf8');
  const m = routes.match(/MAX_OCR_TEXT_LENGTH\s*=\s*(\d+)/);
  assert.ok(m, 'MAX_OCR_TEXT_LENGTH 상수를 못 찾았다');
  assert.ok(Number(m[1]) >= 9900,
    '상한이 9,900 미만으로 내려갔다면 위 배터리 크기도 함께 조정할 것');
});

t('lineAt/linePrefix 경계 — offset 0 · 개행 없음 · CRLF', () => {
  assert.strictEqual(ocrParser.parseNutrition('총 내용량 30g(155 Kcal)').calories, 155);
  assert.strictEqual(ocrParser.parseNutrition('총 내용량 30g(155 Kcal)\r\n나트륨 430mg').calories, 155);
  assert.strictEqual(ocrParser.parseNutrition('\r\n총 내용량 30g(155 Kcal)').calories, 155);
});

t('두 파서의 배수표기 정규식이 문자 단위로 동일하다 (한쪽만 고치는 것을 막는다)', () => {
  const fs = require('fs');
  const path = require('path');
  const grab = (p) => {
    const src = fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    // ★ 세션44: 상한 수치를 하드코딩하지 않는다. `{0,8}` 을 박아 뒀다가
    //   상한을 `{0,20}` 으로 조정하는 순간 "정규식을 못 찾았다" 로 실패했다.
    //   검사 목적은 **두 파일이 같은지**이므로 지문은 수치를 포함하지 않아야 한다.
    const m = src.match(/\/\(\?:열량\|칼로리\)\?[^\n]*?\/gi/);
    assert.ok(m, `${p} 에서 배수표기 정규식을 못 찾았다`);
    return m[0];
  };
  assert.strictEqual(grab('src/services/ocrParser.js'), grab('scripts/lib/capture_label_parser.js'));
});

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(62)}`);
console.log(`📊 세션43 괄호 총열량: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})`);
if (fail > 0) {
  console.log('\n실패 상세:');
  for (const f of failures) console.log(`  - ${f.name}\n    ${f.message}`);
  process.exit(1);
}
console.log('✅ 전체 통과');
