/**
 * OCR 파서 유닛 테스트
 * Google Vision API 호출 없이 파싱 로직만 검증
 */

const {
  extractIngredientSection,
  parseIngredients,
  identifyAdditives,
  parseNutrition,
  detectAllergens,
  analyzeText,
  // ★ 세션59 `U59-1` — 세그먼트 분할·분류를 «관측»한다. 응답 계약이 아니라 내부 구현이다(`_` 접두).
  //   결과(알레르겐 목록)만 보면 「우연히 맞았다」와 「구조가 옳다」를 구분할 수 없다.
  _splitSegments,
  _classifySegment,
  // ★ 세션61 `U61-5`·`U61-7` — 3분리 결과를 직접 본다(flat 은 혼입을 감춘다).
  detectAllergensV2,
} = require('../src/services/ocrParser');

const { correctOcrText } = require('../src/services/ocrService');

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ ${testName}`);
    passed++;
  } else {
    console.log(`  ❌ ${testName}`);
    failed++;
  }
}

// ============================================================
// 테스트 데이터: 실제 한국 식품 라벨 OCR 결과 시뮬레이션
// ============================================================

const SAMPLE_LABEL_1 = `새우깡
농심
내용량: 90g (30g x 3봉)
원재료명 및 함량: 소맥분(밀:미국산,호주산), 팜유(말레이시아산), 새우시즈닝[새우분말4.56%(새우:중국산), 정제소금, L-글루타민산나트륨(향미증진제), 탄산칼슘], 전분, 정제소금, 새우분말0.87%, 간장분말(대두), 조미액상
알레르기 유발물질: 밀, 대두, 새우 함유
영양정보 1회 제공량 30g
열량 140kcal
탄수화물 18g
당류 2g
단백질 2g
지방 7g
포화지방 3g
트랜스지방 0g
콜레스테롤 5mg
나트륨 200mg
유통기한: 제조일로부터 6개월`;

const SAMPLE_LABEL_2 = `비비빅 (팥맛)
롯데웰푸드
원재료명: 정제수, 설탕, 팥앙금(팥:중국산), 탈지분유, 물엿, 코코넛유, 식물성유지(팜핵경화유), 유화제(폴리소르베이트80, 글리세린지방산에스테르), 안정제(카라기난, 구아검, 로커스트콩검), 착향료(바닐린), 착색료(카라멜색소)
알레르기 유발물질: 우유 함유
영양성분 1회제공량 130ml
열량 190kcal
나트륨 55mg
탄수화물 33g
당류 25g
지방 5g
포화지방산 4.5g
트랜스지방 0g
콜레스테롤 5mg
단백질 3g`;

const SAMPLE_LABEL_OCR_ERRORS = `영양성붂 1회 제공량 30g
열렁 140kcal
탄수확물 18g
나뜨륨 200mg
탄백질 2g
브랜스지방 0g
포화지방샨 3g
콜래스테롤 5mg`;


console.log('══════════════════════════════════════════════════════');
console.log('  먹선 OCR 파서 유닛 테스트');
console.log('══════════════════════════════════════════════════════\n');

// ── 테스트 1: OCR 텍스트 교정 ──
console.log('🔧 테스트 1: OCR 오인식 교정');
const { corrected, corrections } = correctOcrText(SAMPLE_LABEL_OCR_ERRORS);
assert(corrections.length >= 6, `교정 ${corrections.length}건 감지`);
assert(corrected.includes('나트륨'), '나뜨륨 → 나트륨 교정');
assert(corrected.includes('단백질'), '탄백질 → 단백질 교정');
assert(corrected.includes('트랜스지방'), '브랜스지방 → 트랜스지방 교정');
assert(corrected.includes('콜레스테롤'), '콜래스테롤 → 콜레스테롤 교정');
assert(corrected.includes('열량'), '열렁 → 열량 교정');
assert(corrected.includes('탄수화물'), '탄수확물 → 탄수화물 교정');

// ── 테스트 2: 원재료명 섹션 추출 ──
console.log('\n📋 테스트 2: 원재료명 섹션 추출');
const section1 = extractIngredientSection(SAMPLE_LABEL_1);
assert(section1 !== null, '새우깡: 원재료명 섹션 추출 성공');
assert(section1.includes('소맥분'), '소맥분 포함');
assert(section1.includes('새우시즈닝'), '새우시즈닝 포함');
assert(!section1.includes('영양정보'), '영양정보 섹션 미포함 (종료 키워드 동작)');

const section2 = extractIngredientSection(SAMPLE_LABEL_2);
assert(section2 !== null, '비비빅: 원재료명 섹션 추출 성공');
assert(section2.includes('정제수'), '정제수 포함');
assert(section2.includes('카라멜색소'), '카라멜색소 포함');

// ── 테스트 3: 개별 성분 파싱 ──
console.log('\n🧪 테스트 3: 개별 성분 파싱');
const ingredients1 = parseIngredients(section1);
assert(ingredients1.length >= 5, `새우깡: ${ingredients1.length}개 성분 파싱`);

const flour = ingredients1.find(i => i.name.includes('소맥분'));
assert(flour !== null, '소맥분 성분 존재');
assert(flour && flour.origin === '미국산,호주산' || flour.origin !== null, '원산지 추출');

const ingredients2 = parseIngredients(section2);
assert(ingredients2.length >= 8, `비비빅: ${ingredients2.length}개 성분 파싱`);

// ── 테스트 4: 첨가물 식별 ──
console.log('\n⚗️ 테스트 4: 첨가물 식별');
const additives1 = identifyAdditives(ingredients1);
assert(additives1.length >= 1, `새우깡: ${additives1.length}개 첨가물 식별`);
const msg = additives1.find(a => a.name === 'L-글루타민산나트륨');
assert(msg !== undefined, 'L-글루타민산나트륨 (향미증진제) 식별');

const additives2 = identifyAdditives(ingredients2);
assert(additives2.length >= 3, `비비빅: ${additives2.length}개 첨가물 식별`);
const caramel = additives2.find(a => a.name === '카라멜색소');
assert(caramel !== undefined, '카라멜색소 (착색료) 식별');
const carrageenan = additives2.find(a => a.name === '카라기난');
assert(carrageenan !== undefined, '카라기난 (증점제) 식별');

// ── 테스트 5: 영양정보 파싱 ──
console.log('\n📊 테스트 5: 영양정보 파싱');
const nutrition1 = parseNutrition(SAMPLE_LABEL_1);
assert(nutrition1.calories === 140, `열량: ${nutrition1.calories}kcal`);
assert(nutrition1.sodium === 200, `나트륨: ${nutrition1.sodium}mg`);
assert(nutrition1.total_sugars === 2, `당류: ${nutrition1.total_sugars}g`);
assert(nutrition1.total_fat === 7, `지방: ${nutrition1.total_fat}g`);
assert(nutrition1.saturated_fat === 3, `포화지방: ${nutrition1.saturated_fat}g`);
assert(nutrition1.trans_fat === 0, `트랜스지방: ${nutrition1.trans_fat}g`);
assert(nutrition1.cholesterol === 5, `콜레스테롤: ${nutrition1.cholesterol}mg`);
assert(nutrition1.protein === 2, `단백질: ${nutrition1.protein}g`);

const nutrition2 = parseNutrition(SAMPLE_LABEL_2);
assert(nutrition2.calories === 190, `비비빅 열량: ${nutrition2.calories}kcal`);
assert(nutrition2.sodium === 55, `비비빅 나트륨: ${nutrition2.sodium}mg`);

// ── 테스트 6: 알레르기 탐지 ──
// ★★★ 세션58 — 이 블록이 2단계(원재료 추론 폐기, 제이 결정 D55-2)로 4건 깨졌다.
//   ⚠ 그러나 원인은 파서가 아니라 **픽스처였다.**
//     `SAMPLE_LABEL_1`(새우깡)·`SAMPLE_LABEL_2`(비비빅)에 **법정 알레르기 표시란이 통째로 없었다.**
//     실물 봉지에는 「알레르기 유발물질: 밀, 대두, 새우 함유」·「우유 함유」가 인쇄된다.
//     즉 픽스처가 라벨의 현실을 잘못 담고 있었고, 종전엔 원재료 추론이 그 구멍을 덮어 주고 있었다.
//   → 기대값을 `[]` 로 낮추지 않고 **픽스처를 실물에 맞췄다.** 그 편이 이 검사가 원래 물으려던
//     질문(「실물 라벨에서 알레르겐을 읽는가」)을 지킨다.
//   ★ 대신 「원재료만 있고 선언란이 없는 텍스트」는 아래 6-B 로 «따로» 세운다.
//     그렇게 나눠야 두 질문이 서로를 가리지 않는다.
console.log('\n⚠️ 테스트 6: 알레르기 유발물질 탐지');
const allergens1 = detectAllergens(SAMPLE_LABEL_1);
assert(allergens1.includes('밀') || allergens1.includes('대두'), `새우깡 알레르기: ${allergens1.join(', ')}`);
assert(allergens1.includes('새우'), '새우 알레르기 감지');

const allergens2 = detectAllergens(SAMPLE_LABEL_2);
assert(allergens2.includes('우유'), '비비빅: 우유 알레르기 감지 (우유 함유)');

// ── 테스트 6-B: 추론 폐기 회귀 (세션58) ──
// 선언란이 «없는» 원재료 문장은 아무것도 내지 않아야 한다. D55-2 를 되돌리면 여기가 빨간불이다.
// ⚠ 이 단정만 두면 「전부 `[]` 를 내는 구현」도 초록이 된다. 위 6 의 양성 케이스와 «쌍»으로만 의미가 있다.
console.log('\n⚠️ 테스트 6-B: 원재료 추론 폐기 회귀 (D55-2)');
const noDecl1 = detectAllergens('원재료명 및 함량: 소맥분(밀:미국산), 새우분말0.87%, 간장분말(대두)');
assert(noDecl1.length === 0, `선언란 없는 원재료 문장 → 빈 배열 (실제: [${noDecl1.join(', ')}])`);
const noDecl2 = detectAllergens('원재료명: 정제수, 설탕, 탈지분유, 코코넛유');
assert(noDecl2.length === 0, `탈지분유만 있고 선언란 없음 → 빈 배열 (실제: [${noDecl2.join(', ')}])`);

// ── 테스트 6-C: `U59-1` 세그먼트 분류 회귀 (세션59) ──
//
// 무엇을 지키나 — 원재료명 줄에 `함유` 를 품은 «복합어»(`페닐알라닌함유`)가 있어도
//   그 줄이 `contains`(직접함유 선언)로 승격되지 않아야 한다.
//   승격되면 판별기 C 의 2단계 폐기(`kind === 'ingredients'` 건너뛰기)가 **우회**된다.
//   근거·실측: `IP/U59-1_수정안_확정_2026-08-09_세션59.md`
//
// ⚠ 반대 방향도 같이 본다 — 원재료명 줄에 **진짜 법정 선언**이 같이 인쇄된 실물이 5건 있다
//   (021·031·055·082·098). 그 5건을 잃으면 **과소경고**다. 아래 §양성 이 그것을 막는다.
console.log('\n⚠️ 테스트 6-C: U59-1 — 원재료명 줄의 `함유` 복합어 (세션59)');
{
  const kinds = (t) => _splitSegments(t).map(s => _classifySegment(s));

  // §음성 — `함유` 복합어만 있는 원재료명 줄은 선언이 «아니다»
  const c1 = kinds('원재료명: 밀가루, 정제소금, 아스파탐(감미료, 페닐알라닌함유)');
  assert(c1.length === 1 && c1[0] === 'ingredients',
    `페닐알라닌함유 줄은 ingredients 여야 한다 (실제: ${JSON.stringify(c1)})`);

  // §양성 — 원재료명 줄에 «진짜 선언»이 붙어 있으면 둘로 쪼개고 선언 쪽을 contains 로 본다
  const c2 = kinds('원재료명: 콩 100 %[외국산(미국,브라질,파라과이 등)] 대두 함유');
  assert(c2.length === 2 && c2[0] === 'ingredients' && c2[1] === 'contains',
    `실물 021 형태는 ingredients + contains 로 쪼개져야 한다 (실제: ${JSON.stringify(c2)})`);

  // §양성 — 붙여 인쇄(`대두함유`, 실물 098)도 같다
  const c3 = kinds('원재료명 콩 100 %[외국산(미국,브라질,파라과이 등)] · 대두함유');
  assert(c3.length === 2 && c3[1] === 'contains',
    `붙여 인쇄된 선언도 쪼개져야 한다 (실제: ${JSON.stringify(c3)})`);

  // §마커 보존 — `함유` 외의 선언 마커는 좁히지 않았다 (좁히면 진짜 선언을 잃는다)
  const c4 = kinds('원재료명: 밀가루, 정제소금, 알레르기 유발물질: 대두');
  assert(c4.includes('contains'),
    `「알레르기 유발물질」 마커는 그대로 선언이어야 한다 (실제: ${JSON.stringify(c4)})`);
}

// ── 테스트 6-D: `U58-2` 닫는 괄호 절단 회귀 (세션60) ──
//
//  무엇을 지키나 —
//    `_stripAllergenSuffix` 4단계의 구분자 클래스 `[,·\/\s)]{1,20}` 에는 `)` 가 «의도적»으로 들어 있다.
//    「`(국내산) 밀, 우유` 처럼 괄호 직후 알레르기가 나열되는 경우」를 잡으려고 넣은 것이다.
//    그런데 `substring(0, m.index)` 가 구분자 런의 «시작»부터 버리기 때문에,
//    런이 `)` 로 시작하면 **앞 원재료의 닫는 괄호까지 같이 잘렸다.**
//
//  ★ 이 결함의 무게 —
//    세션58 은 「`착색료(카라멜색소)` 의 `)` 가 잘린다」는 부작용만 봤다.
//    세션60 실측에서 **의도했던 케이스 `G` 자체가 깨져 있었다** (`정제소금(국내산` ).
//    즉 4단계는 처음부터 반쪽이었다. `G` 를 지우면 이 결함이 다시 들어와도 아무도 모른다.
//
//  ⚠ 이 회귀를 「괄호 하나쯤」으로 낮춰 보지 말 것 — 원재료 문자열이 깨지면
//    그 뒤의 원재료 분리·첨가물 식별이 전부 어긋난 입력을 받는다.
//  ⚠ `)` 를 구분자 클래스에서 «빼는» 방식으로 고치지 말 것 — `G` 가 죽는다.
//  정본: backends/먹선/IP/U58-2_진단_확정안_2026-08-10_세션60.md
console.log('\n⚠️ 테스트 6-D: U58-2 — 닫는 괄호를 먹지 않는다 (세션60)');
{
  const U58_2_CASES = [
    ['A 다음 줄이 `X 함유`',
      '원재료명: 밀가루, 정제소금, 착색료(카라멜색소)\n우유 함유',
      '밀가루, 정제소금, 착색료(카라멜색소)'],
    ['B 다음 줄이 `알레르기 유발물질:` (종전에도 정상 — 되돌아가지 않는지 본다)',
      '원재료명: 밀가루, 정제소금, 착색료(카라멜색소)\n알레르기 유발물질: 우유',
      '밀가루, 정제소금, 착색료(카라멜색소)'],
    ['C 같은 줄에 `, 우유 함유`',
      '원재료명: 밀가루, 정제소금, 착색료(카라멜색소), 우유 함유',
      '밀가루, 정제소금, 착색료(카라멜색소)'],
    ['D 선언이 아예 없다 (4단계가 애먼 괄호를 건드리지 않는다)',
      '원재료명: 밀가루, 정제소금, 착색료(카라멜색소)',
      '밀가루, 정제소금, 착색료(카라멜색소)'],
    ['E 괄호 «안»에 알레르겐이 있다 (`밀가루(밀:미국산)`)',
      '원재료명: 밀가루(밀:미국산), 착색료(카라멜색소)\n대두 함유',
      '밀가루(밀:미국산), 착색료(카라멜색소)'],
    ['F 대괄호 중첩 (`[…(…)…]`)',
      '원재료명: 정제수, 혼합제제[산도조절제(구연산), 향료]\n밀 함유',
      '정제수, 혼합제제[산도조절제(구연산), 향료]'],
    ['G ★ 4단계가 «잡으려고 만든» 케이스 — 원산지 괄호 직후 알레르겐 나열',
      '원재료명: 정제소금(국내산) 밀, 우유',
      '정제소금(국내산)'],
    ['H 괄호 없이 알레르겐만 꼬리에 나열 (4단계 본래 기능 무손상)',
      '원재료명: 밀가루, 정제소금, 우유, 밀, 쇠고기',
      '밀가루, 정제소금'],
  ];

  for (const [name, input, expected] of U58_2_CASES) {
    const got = extractIngredientSection(input);
    assert(got === expected, `${name} → ${JSON.stringify(got)}`);
  }

  // §불변식 — 위 8건 어디에서도 괄호 짝이 깨지면 안 된다.
  //   개별 기대값과 «별도»로 둔다: 기대값을 잘못 고쳐 쓰면 그 케이스는 통과해 버리지만
  //   이 불변식은 「괄호를 먹었다」는 사실 자체를 잡는다.
  for (const [name, input] of U58_2_CASES) {
    const got = extractIngredientSection(input) || '';
    const open = (got.match(/\(/g) || []).length;
    const close = (got.match(/\)/g) || []).length;
    assert(open === close, `${name} — 괄호 짝 균형 ( ${open} / ) ${close}`);
  }
}

// ── 테스트 6-E: `U61-5`(법정 괄호) · `U61-7`(줄바꿈) 회귀 (세션61) ──
//
//  무엇을 지키나 — 실물 `005`(농심 스낵면류)에서 **알레르겐 7종이 전량 소실**되고 있었다.
//    라벨의 선언이 두 줄로 감겨 있다:
//        `계란, 대두, 밀, 새우, 쇠고기, 오징어, 조개류(홍합 포함)`
//        `함유`
//    · `_splitSegments` 가 `\n` 으로 쪼개 → 앞 줄은 'other'(버려짐), 뒷 줄은 이름이 없다
//    · 설령 한 줄이어도 `조개류(홍합포함)` 이 `)` 로 끝나 `_declaredNameBeforeHayu` 앵커가 깨진다
//    ⇒ 두 결함이 «겹쳐» 있었다. 둘 다 고쳐야 잡힌다.
//
//  ⚠⚠ 세션61 은 처음에 이걸 **괄호 문제로만 오진**했다. 손타이핑한 «한 줄» 케이스로
//    재현했기 때문이다. 실측이 갈랐다 — 개행만 제거 → 7종 전부 / 괄호만 제거 → 0종.
//    ⇒ **W1 을 지우지 말 것.** 실물 형태(개행 포함)를 재현하는 유일한 케이스다.
//
//  ⚠⚠⚠ 아래 «잡으면 안 되는» 케이스들이 이 테스트의 «절반»이자 첫째 목적이다.
//    U59-1(세션59 전체가 매달린 결함)이 되살아나는 것을 막는다. 지우지 말 것.
//
//  실물 67건 차분(세션61): 달라진 라벨 **1건(005)**, 줄어든 알레르겐 **0건**.
console.log('\n⚠️ 테스트 6-E: U61-5/U61-7 — 감긴 선언과 법정 괄호 (세션61)');
{
  const MUST = [
    ['W1 ★ 실물 005 그대로 — 두 줄로 감긴 선언 + 법정 괄호',
      '원재료명 산도조절제, 건미역, 건당근,\n건다시마\n계란, 대두, 밀, 새우, 쇠고기, 오징어, 조개류(홍합 포함)\n함유\n소비기한 후면 표기일까지',
      ['난류(가금류)', '대두', '밀', '새우', '쇠고기', '오징어', '조개류']],
    ['W2 개행만 있어도 터진다 (괄호 없음) — 두 축이 독립임을 못 박는다',
      '원재료명 밀가루, 정제소금\n대두, 밀\n함유\n소비기한', ['대두', '밀']],
    ['M2 식약처 법정 표기 그대로 — 조개류는 거의 항상 괄호를 단다',
      '원재료명 정제수, 소맥전분 밀, 대두, 조개류(굴, 전복, 홍합 포함) 함유', ['밀', '대두', '조개류']],
    ['M3 원산지 괄호', '원재료명 정제소금, 현미유 대두(국산) 함유', ['대두']],
    ['M5 괄호 뒤에도 좌측 확장이 살아 있어야 한다 (앞 이름 소실 = 서버가 알레르겐을 지우는 것)',
      '원재료명 밀가루, 정제소금 우유, 대두, 조개류(홍합 포함) 함유', ['우유', '대두', '조개류']],
  ];
  for (const [label, text, want] of MUST) {
    const got = detectAllergensV2(text).contains;
    const missing = want.filter(x => !got.includes(x));
    assert(missing.length === 0, `6-E ${label} → [${got.join(', ')}]`);
  }

  // ⚠ 여기부터가 핵심 — «잡으면 안 되는» 것들. 하나라도 깨지면 U59-1 퇴행이다.
  const MUST_NOT = [
    ['N1 ★★★ U59-1 그 자체 — 아스파탐(감미료, 페닐알라닌함유)',
      '원재료명 밀가루, 정제소금, 아스파탐(감미료, 페닐알라닌함유)', ['밀']],
    ['N2 ★★★ U59-1 변종 — 대두유에서 대두가 새면 D55-2 우회다',
      '원재료명 대두유, 정제소금, 아스파탐(페닐알라닌함유)', ['대두']],
    ['W3 ★ 실물 063 — `페닐알라닌`⏎`함유)` 는 앞 줄이 법정명이 아니다. 붙이면 안 된다',
      '원재료명 밀가루, 대두유, 아스파탐(감미료, 페닐알라닌\n함유)\n소비기한', ['밀', '대두']],
    ['W5 ★ 원재료 형태로 끝나는 줄은 붙여도 새면 안 된다 (D55-2)',
      '원재료명 정제수, 밀가루\n함유\n소비기한', ['밀']],
    ['W6 ★ 대두유 → 대두 도 마찬가지', '원재료명 정제소금, 대두유\n함유\n소비기한', ['대두']],
    ['N6 괄호를 벗겼을 때 원재료 형태가 드러나면 안 된다 — 밀가루(국내산)',
      '원재료명 정제소금, 밀가루(국내산) 함유', ['밀']],
    ['N3 실물 017 — 제품명 안의 배합비 표기',
      '제품명 에스비 골든카레매운맛 (카레분 9.5% 함유) 식품유형 카레 원재료명 밀가루, 대두유', ['밀', '대두']],
    ['N5 실물 008 — 「함유하고 있습니다」 서술문',
      '원재료명 코코넛오일, 우유맛분말 코코넛 오일은 우유 모유 등과 같이 중지방산을 함유하고 있습니다', ['우유']],
    ['N8 혼입 문구가 직접 함유로 올라오면 안 된다 (세션44 030 오탐 축)',
      '본 제품은 조개류(굴, 전복, 홍합 포함), 오징어, 잣을 사용한 제품과 동일한 제조시설에서 생산하고 있습니다',
      ['조개류', '오징어', '잣']],
  ];
  for (const [label, text, forbidden] of MUST_NOT) {
    const got = detectAllergensV2(text).contains;
    const leaked = forbidden.filter(x => got.includes(x));
    assert(leaked.length === 0, `6-E ${label} → 샌 것 [${leaked.join(', ')}] (contains=[${got.join(', ')}])`);
  }

  // ⚠ ReDoS·무한루프 방어. 세션42·43 에 두 번 겪었다. 괄호를 다루는 코드는 반드시 이걸 통과할 것.
  const ROBUST = [
    ['R1 괄호 짝 불일치 OCR 잔해', '원재료명 정제소금 조개류(홍합 함유'],
    ['R2 여는 괄호 폭주', '원재료명 ' + '('.repeat(4000) + '대두 함유'],
    ['R3 닫는 괄호 폭주', '원재료명 대두' + ')'.repeat(4000) + ' 함유'],
    ['R4 중첩 깊이 폭주', '원재료명 조개류' + '('.repeat(2000) + '홍합' + ')'.repeat(2000) + ' 함유'],
  ];
  for (const [label, text] of ROBUST) {
    const t0 = Date.now();
    let threw = false;
    try { detectAllergensV2(text); } catch (e) { threw = true; }
    const ms = Date.now() - t0;
    assert(!threw && ms < 1000, `6-E ${label} → ${threw ? 'throw' : ms + 'ms'}`);
  }
}

// ── 테스트 6-F: `U61-6` — `declarationFound`(= `allergens_available`) 회귀 (세션62) ──
//
//  무엇을 지키나 — 이 값의 뜻은 「**법정 선언란을 봤다**」이지 「「함유」라는 글자를 봤다」가 아니다.
//    `ocrRoutes.js:209`  allergens_available = v2.declarationFound   ← 응답 «계약»
//    종전에는 맨몸 `함유` 하나로 켜졌다. 실물 67건에서 **3건**이 거짓으로 켜져 있었다:
//      · `053` 「배퓨레 함유」                  ← 홍보 문구
//      · `008` 「중지방산을 함유하고 있습니다」   ← 영양 설명
//      · `017` 「(카레분 9.5% 함유)」·「1일 함유」 ← 함량 표기 + `밀`→`1일` OCR 오독
//
//  ⚠ **왜 지금 고쳤나 — 화면이 가려 주고 있어서 «안 보였을» 뿐이다.**
//    `web/src/domain/meokseon/allergens.ts:74` 가 「세 배열이 전부 비면 uncollected」로 받아 준다.
//    고지 조건 ②(㉡ 「확인했고 19종 없어요」)를 만드는 순간 그 가림막이 사라지고
//    이 3건이 곧바로 **거짓 안심**이 된다. 조건 ② 착수 «전»에 닫아야 했던 이유다.
//
//  ⚠⚠⚠ MUST 쪽(특히 F-M4·F-M5)이 이 테스트의 첫째 목적이다.
//    이 수정의 방향은 「available 을 «끄는» 것」이고, 끄는 방향의 사고는 **과소경고**다.
//    ㉡(선언란은 봤고 19종 0)을 잃으면 고지 조건 ② 자체가 **불가능**해진다. 지우지 말 것.
//
//  실물 67건 차분(세션62): declarationFound `true→false` **3건(008·017·053)**,
//    `false→true` 0건, contains/mayContain/inferred/flat **변화 0건**.
console.log('\n🏷️ 테스트 6-F: U61-6 — 「선언란을 봤다」의 근거 (세션62)');
{
  const MUST_FOUND = [
    ['F-M1 법정 선언 그 자체', '대두 함유'],
    ['F-M2 나열형 법정 선언', '우유, 밀, 쇠고기 함유'],
    ['F-M3 레이블형 선언', '알레르기 유발물질: 우유, 밀'],
    ['F-M4 ★★★ ㉡ 그 자체 — 선언란은 봤고 19종이 0. 이걸 잃으면 고지 조건 ② 가 불가능해진다',
      '알레르기 유발물질: 해당 없음'],
    ['F-M5 ★★★ ㉡ 변종 — 「알레르기 정보」 레이블 + 19종 0', '알레르기 정보: 없음'],
    ['F-M6 용언형 — 「함유」 앞이 조사(를)라 앵커가 안 잡힌다. 읽어낸 이름으로 살아야 한다',
      '본 제품은 밀, 대두를 함유합니다'],
    ['F-M7 ★ 혼입 문구 — 세션56 이 «일부러» 포함시킨 축(혼입만 있는 라벨 9건)',
      '메밀, 땅콩을 사용한 제조시설에서 같이 제조하고 있습니다'],
    ['F-M8 「포함」 계열 선언', '이 제품은 우유를 포함하고 있습니다'],
    ['F-M9 ★ 실물 005 형태 — U61-5/U61-7 이 되살린 7종이 근거가 된다',
      '원재료명 산도조절제, 건미역, 건당근,\n건다시마\n계란, 대두, 밀, 새우, 쇠고기, 오징어, 조개류(홍합 포함)\n함유\n소비기한 후면 표기일까지'],
  ];
  for (const [label, text] of MUST_FOUND) {
    const v2 = detectAllergensV2(text);
    assert(v2.declarationFound === true,
      `6-F ${label} → declarationFound=${v2.declarationFound} (contains=[${v2.contains}] mayContain=[${v2.mayContain}])`);
  }

  // ⚠ 여기부터가 U61-6 그 자체 — 「함유」 글자만 보고 「봤다」고 말하면 안 된다.
  const MUST_NOT_FOUND = [
    ['F-N1 ★ 실물 053 — 「배퓨레 함유」는 홍보 문구다', '배퓨레 함유'],
    ['F-N2 ★ 실물 008 — 「함유하고 있습니다」 서술문', '중지방산을 함유하고 있습니다.'],
    ['F-N3 ★ 실물 017 — 제품명 안의 배합비 표기',
      '제품명 에스비 골든카레매운맛 (카레분 9.5% 함유) 식품유형 카레 (고형제품)'],
    ['F-N4 ★★ 「…풍부하게 함유」 — 1글자 법정명 `게`(갑각류)가 「하게」에서 새면 안 된다',
      '비타민C를 풍부하게 함유'],
    ['F-N5 영양 강조 문구', '식이섬유 함유 · 나트륨 저감'],
    ['F-N6 ⚠ U59-1 감시 — 이걸 켜면 세션59 전체가 되살아난다',
      '원재료명: 밀가루, 정제소금, 아스파탐(감미료, 페닐알라닌함유)'],
    ['F-N7 ⚠ D55-2 감시 — 원재료 형태는 선언이 아니다', '원재료명: 밀가루, 대두유, 정제소금'],
    ['F-N8 알레르기 이야기가 없는 라벨', '제품명 생수\n내용량 500ml\n유통기한 상단표기'],
    ['F-N9 「함유」만 홀로', '함유'],
  ];
  for (const [label, text] of MUST_NOT_FOUND) {
    const v2 = detectAllergensV2(text);
    assert(v2.declarationFound === false,
      `6-F ${label} → declarationFound=${v2.declarationFound} (contains=[${v2.contains}] mayContain=[${v2.mayContain}])`);
  }

  // ★ 「끄는 수정이 알레르겐을 지우지 않았는가」를 같은 자리에서 못 박는다.
  //   실물 차분이 이미 0건을 확인했지만, 저장소 안에서도 지켜져야 한다.
  {
    const v2 = detectAllergensV2('비타민C를 풍부하게 함유\n대두, 밀 함유');
    assert(v2.declarationFound === true && v2.contains.includes('대두') && v2.contains.includes('밀'),
      `6-F F-X1 선언과 홍보 문구가 한 라벨에 → found=${v2.declarationFound} contains=[${v2.contains}]`);
  }
}

// ── 테스트 6-G: `U63-1` — 줄바꿈이 갈라 놓은 «혼입 고지» 회귀 (세션63) ──
//
//  무엇을 지키나 — 한국 라벨의 혼입 고지는 거의 항상 이 형태다:
//      `이 제품은 A, B, C를 사용한 제품과 같은 제조시설에서 제조하고 있습니다.`
//    라벨이 좁아 Vision 이 2~3줄로 끊어 주고, `_splitSegments` 는 `\n` 으로 쪼갠다.
//      · 이름이 있는 앞줄 → 마커가 없다 → `'other'` → **버려진다**
//      · 혼입 신호가 있는 뒷줄 → `'mayContain'` 이지만 **이름이 0종**
//    ⇒ 실물 67건 중 **26건(38.8%)에서 알레르겐이 화면에 아예 뜨지 않았다.** 과소경고다.
//    실물 67건 차분(세션63): mayContain 순증 **207종** · 순감 **0종** ·
//                            contains 변화 **0종** · declarationFound 변화 **0건**.
//
//  ★★ 세션44 의 `030` 수정이 **반쪽이었음**이 여기서 드러났다. 세션44 는
//    `MAY_CONTAIN_SIGNALS` 에 `시설에서같이` 를 넣어 「contains 오승격」만 고쳤고,
//    이름이 앞줄에 있어 **10종 전량이 소실되던 것**은 보지 않았다.
//    ⇒ 오분류를 고칠 때 «반대 방향(소실)»도 같이 세지 않으면 반쪽이 남는다.
//
//  ⚠⚠⚠ 아래 MUST_NOT 이 이 테스트의 «첫째» 목적이다.
//    이 수정의 방향은 「줄을 «붙이는» 것」이고, 잘못 붙이면 **직접 함유 선언이 혼입으로 강등**된다.
//    강등은 과소경고이며 이 저장소가 만들 수 있는 최악의 오류다. 하나도 지우지 말 것.
//
//  ⚠ 병합 조건 다섯 개(정본 `IP/U63-1_실측_및_합격조건_2026-08-12_세션63.md` §3):
//    ① 뒷줄에 혼입 신호  ② 앞줄이 문장부호로 끝나지 않음  ③ 앞줄에 법정명 ≥1
//    ④ 앞줄 kind = 'other'  ⑤ 앞줄에 혼입 신호 없음
//    G-N1 은 ②, G-N2 는 ④(ingredients), G-N3·G-N4 는 ④(contains), G-N5 는 ③ 을 지킨다.
console.log('\n⚠️ 테스트 6-G: U63-1 — 줄바꿈이 갈라 놓은 혼입 고지 (세션63)');
{
  // ★ 붙어야 한다 — mayContain 에 «반드시» 들어와야 하는 이름
  const MUST_MAY = [
    ['G-M1 ★ 쉼표로 끊긴 명단 (실물 001·002·019 형태)',
      '이 제품은 우유, 메밀, 땅콩,\n호두를 사용한 제품과 같은 제조시설에서 제조하고 있습니다.',
      ['우유', '메밀', '땅콩', '호두']],
    ['G-M2 ★ 「를 사용한」에서 끊긴 형태 (실물 010·040)',
      '메밀, 땅콩, 잣, 고등어를 사용한\n제품과 같은 시설에서 제조하고 있습니다',
      ['메밀', '땅콩', '잣', '고등어']],
    ['G-M3 ★★ 세 줄로 갈려도 첫 줄이 살아야 한다 — 역방향 연쇄 (실물 048·058·013)',
      '이 제품은 우유, 메밀,\n땅콩, 호두를 사용한\n제품과 같은 제조시설에서 제조하고 있습니다.',
      ['우유', '메밀', '땅콩', '호두']],
    ['G-M4 ★ 세션44 030 형태 — 「제조시설에서 같이」',
      '본 제품은 새우, 돼지고기, 복숭아, 잣을 사용한\n제조시설에서 같이 제조하고 있습니다',
      ['새우', '돼지고기', '복숭아', '잣']],
    ['G-M5 ★ 「혼입 가능」으로 끝나는 형태 (실물 075)',
      '우유, 땅콩, 게, 새우,\n오징어, 조개류(홍합 포함) 혼입 가능',
      ['우유', '땅콩', '게', '새우', '오징어', '조개류']],
    ['G-M6 ★ 법정 괄호가 줄 끝에 걸려도 살아야 한다 (U61-5 와의 합작)',
      '닭고기, 오징어, 잣, 조개류(굴, 전복, 홍합 포함)를 사용한\n제품과 같은 시설에서 제조하고 있습니다',
      ['닭고기', '오징어', '잣', '조개류']],
  ];
  for (const [label, text, want] of MUST_MAY) {
    const v2 = detectAllergensV2(text);
    const missing = want.filter(x => !v2.mayContain.includes(x));
    assert(missing.length === 0,
      `6-G ${label} → 없음 [${missing.join(', ')}] (mayContain=[${v2.mayContain.join(', ')}])`);
  }

  // ⚠⚠⚠ 여기부터가 핵심 — 붙이면 «안 되는» 것들. 하나라도 깨지면 «직접 함유 강등» = 과소경고다.
  const MUST_KEEP_CONTAINS = [
    ['G-N1 ★★★ 마침표로 끝난 독립 문장은 빨려 들어가면 안 된다 (조건 ②)',
      '본 제품은 우유를 사용하였습니다.\n땅콩을 사용한 제품과 같은 제조시설에서 제조하고 있습니다.',
      [], ['우유']],
    ['G-N2 ★★★ 원재료명 줄이 혼입으로 승격되면 안 된다 — D55-2 우회 방지 (조건 ④)',
      '원재료명 : 밀가루, 대두유, 정제소금\n땅콩을 사용한 제품과 같은 제조시설에서 제조하고 있습니다.',
      [], ['밀', '대두']],
    ['G-N3 ★★★★ 완결된 법정 선언은 강등되면 안 된다 — 실물 009 (조건 ④)',
      '밀, 달걀, 우유, 대두 함유\n땅콩, 호두를 사용한 제품과 같은 제조시설에서 제조하고 있습니다.',
      ['밀', '난류(가금류)', '우유', '대두'], []],
    ['G-N4 ★★★ 선언 뒤에 다른 내용이 붙어 있어도 강등 금지 — 실물 061 (조건 ④)',
      '토마토 함유 포장재질 용기·리드-폴리에틸렌\n대두, 밀, 우유, 조개류(굴) 혼입가능',
      ['토마토'], []],
  ];
  for (const [label, text, mustContain, mustNotMay] of MUST_KEEP_CONTAINS) {
    const v2 = detectAllergensV2(text);
    const lostC = mustContain.filter(x => !v2.contains.includes(x));
    const leakedM = mustNotMay.filter(x => v2.mayContain.includes(x));
    assert(lostC.length === 0,
      `6-G ${label} → contains 에서 «강등» [${lostC.join(', ')}] (contains=[${v2.contains.join(', ')}] mayContain=[${v2.mayContain.join(', ')}])`);
    assert(leakedM.length === 0,
      `6-G ${label} → mayContain 으로 «샘» [${leakedM.join(', ')}] (mayContain=[${v2.mayContain.join(', ')}])`);
  }

  // ⚠ 붙일 «이유»가 없는 경우 — 아무 줄이나 붙지 않는다 (조건 ③)
  {
    const v2 = detectAllergensV2('부정·불량식품 신고는 국번없이 1399\n같은 제조시설에서 제조하고 있습니다');
    assert(v2.contains.length === 0 && v2.mayContain.length === 0,
      `6-G G-N5 앞줄에 이름이 없으면 붙지 않는다 → contains=[${v2.contains}] mayContain=[${v2.mayContain}]`);
  }

  // ★★★★ G-N8 — 조건 ④ 를 «진짜로» 못 박는 케이스. 실물 `048` 형태.
  //   ⚠⚠ 왜 G-N3(`대두, 밀 함유` + 혼입줄)만으로는 부족한가 — 세션63 MUT 가 밝혔다.
  //     조건 ④ 를 지운 변이체로 돌렸더니 G-N3·G-N4 는 **초록으로 통과했다.**
  //     `_cutDeclarationTail`(U59-1)이 `… 함유` 꼬리를 별도 세그먼트로 잘라내면서
  //     «우연히» 방어하고 있었기 때문이다. 그건 이 축의 방어 장치가 아니다.
  //   ⇒ `함유` 가 «없이» contains 가 되는 형태 — 즉 `알레르기 유발물질` 마커로 잡히는 줄 —
  //     이라야 조건 ④ 만이 유일한 방어가 된다. 실물 `048` 이 정확히 그 형태다.
  //   실측: 조건 ④ 제거 시 실물 048 에서 **contains 9종이 mayContain 으로 강등**됐다(F1 위반).
  {
    const text = '이 제품은 알레르기 유발물질인 닭고기, 계란, 우유, 메밀,\n'
      + '오징어, 고등어, 복숭아를 사용한\n'
      + '제품과 같은 제조시설에서 제조하고 있습니다.';
    const v2 = detectAllergensV2(text);
    const must = ['닭고기', '난류(가금류)', '우유', '메밀'];
    const lost = must.filter(x => !v2.contains.includes(x));
    assert(lost.length === 0,
      `6-G G-N8 ★★★★ 실물 048 형태 — 「알레르기 유발물질」 줄이 강등되면 안 된다 (조건 ④) → 강등된 것 [${lost.join(', ')}] (contains=[${v2.contains.join(', ')}] mayContain=[${v2.mayContain.join(', ')}])`);
  }

  // ★★★ G-N9 — 실물 `036` 형태. `포함된` 으로 contains 가 되는 줄도 강등 금지.
  //   실측: 조건 ④ 제거 시 036 에서 쇠고기·우유가 강등됐다(F1 위반).
  //   ⚠ 이 라벨의 「아몬드우유 → 우유」 는 **별개 오탐**이다. 이 테스트가 그것을 승인하는 것이 아니다.
  {
    const v2 = detectAllergensV2('이 제품은 아몬드우유, 쇠고기가 포함된 제\n같은 제조시설에서 제조하고 있습니다');
    assert(v2.contains.includes('쇠고기'),
      `6-G G-N9 ★★★ 실물 036 형태 — 「포함된」 줄이 강등되면 안 된다 (조건 ④) → contains=[${v2.contains.join(', ')}]`);
  }

  // ★★ G-N10 — 조건 ③ 을 못 박는다. 실물 `062` 형태.
  //   Vision 이 혼입 문장 «사이»에 영양성분 줄을 끼워 읽었다:
  //     `… 이 제품은 알류, 메밀, 땅`  /  `나트륨 90 mg 5% 탄수화물 8g2%`  /  `콩, 대두, … 사용한 제품과 같은 제`
  //   조건 ③(앞줄에 법정명이 있어야 붙는다)이 없으면 **이름 없는 영양 줄을 건너뛰어** 확산한다.
  //   ⚠⚠ 이 테스트는 「현재 동작」을 못 박는 것이지 「올바른 답」을 주장하지 않는다 —
  //     062 의 알류·메밀은 «실제로» 혼입 명단이고 지금 놓치고 있다. 별개 축 `U63-2` 로 남겼다.
  //     확산을 허용하면 엉뚱한 줄이 붙는 쪽이 더 위험하다고 판단해 보수적으로 막았다.
  //   ⇒ 이 판단을 뒤집으려면 **평가 셋을 먼저** 만들 것. 그냥 조건 ③ 을 지우지 말 것.
  {
    const v2 = detectAllergensV2('이 제품은 알류, 메밀, 땅\n나트륨 90 mg 5% 탄수화물 8g2%\n콩, 대두, 밀을 사용한 제품과 같은 제조시설에서 제조');
    const leaked = ['난류(가금류)', '메밀'].filter(x => v2.mayContain.includes(x));
    assert(leaked.length === 0,
      `6-G G-N10 ★★ 조건 ③ — 이름 없는 줄을 건너뛴 확산 금지 (실물 062) → 샌 것 [${leaked.join(', ')}] (mayContain=[${v2.mayContain.join(', ')}])`);
  }

  // ⚠ 되살아난 이름은 contains 가 «아니라» mayContain 이어야 한다.
  //   `_classifySegment` 가 MAY_CONTAIN_SIGNALS 를 `함유` 보다 먼저 보는 순서에 기댄다.
  //   그 순서가 뒤집히면 26건 × 207종이 통째로 «과다경고»가 된다.
  {
    const v2 = detectAllergensV2('이 제품은 우유, 메밀,\n땅콩을 사용한 제품과 같은 제조시설에서 제조하고 있습니다.');
    assert(v2.contains.length === 0,
      `6-G G-N6 ★★ 혼입이 직접함유로 올라오면 안 된다 → contains=[${v2.contains.join(', ')}]`);
  }

  // ⚠ 선언 되붙이기(U61-7)와 «순서»가 맞아야 한다 — 선언이 먼저 완성돼야 조건 ④ 가 정확하다.
  //   `_joinWrappedMayContain` 을 `_joinWrappedDeclaration` «앞»으로 옮기면 이 케이스가 깨진다.
  {
    const v2 = detectAllergensV2('대두, 밀\n함유\n땅콩, 호두를 사용한 제품과 같은 제조시설에서 제조하고 있습니다.');
    assert(v2.contains.includes('대두') && v2.contains.includes('밀'),
      `6-G G-N7 ★★ U61-7 이 먼저 돌아야 한다 (감긴 선언 → contains 유지) → contains=[${v2.contains.join(', ')}]`);
  }

  // ⚠ ReDoS·무한루프 방어. 세션42·43 에 두 번 겪었다. 줄을 다루는 코드는 반드시 통과할 것.
  //   ★ 특히 «역방향 연쇄»는 상한(`_JOIN_MAY_MAX`)이 없으면 O(n²) 로 폭발한다.
  const ROBUST_G = [
    ['G-R1 혼입 신호 줄 폭주', '대두,\n'.repeat(3000) + '를 사용한 제품과 같은 제조시설에서 제조'],
    ['G-R2 빈 줄 폭주', '대두,' + '\n'.repeat(5000) + '를 사용한 제품과 같은 제조시설에서 제조'],
    ['G-R3 한 줄이 매우 긺', '대두, ' + '땅콩, '.repeat(5000) + '를 사용한 제품과 같은 제조시설에서 제조'],
  ];
  for (const [label, text] of ROBUST_G) {
    const t0 = Date.now();
    let threw = false;
    try { detectAllergensV2(text); } catch (e) { threw = true; }
    const ms = Date.now() - t0;
    assert(!threw && ms < 3000, `6-G ${label} → ${threw ? 'throw' : ms + 'ms'}`);
  }
}

// ── 테스트 7: 통합 분석 ──
console.log('\n🔄 테스트 7: 통합 분석 (analyzeText)');
const result = analyzeText(SAMPLE_LABEL_1);
assert(result.ingredient_count >= 5, `통합: 원재료 ${result.ingredient_count}개`);
assert(result.additive_count >= 1, `통합: 첨가물 ${result.additive_count}개`);
assert(Object.keys(result.nutrition).length >= 5, `통합: 영양정보 ${Object.keys(result.nutrition).length}항목`);
assert(result.allergens.length >= 1, `통합: 알레르기 ${result.allergens.length}종`);

// ── 테스트 8: 교정 후 영양정보 파싱 ──
console.log('\n🔧 테스트 8: 교정된 텍스트 → 영양정보 파싱');
const nutritionFromCorrected = parseNutrition(corrected);
assert(nutritionFromCorrected.calories === 140, '교정 후 열량 추출 성공');
assert(nutritionFromCorrected.sodium === 200, '교정 후 나트륨 추출 성공');
assert(nutritionFromCorrected.protein === 2, '교정 후 단백질 추출 성공');

// ── 결과 요약 ──
console.log(`\n${'═'.repeat(54)}`);
console.log(`📊 OCR 파서 테스트 결과: ${passed} 통과 / ${failed} 실패 (총 ${passed + failed}개)`);
console.log(`${'═'.repeat(54)}`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('\n✅ OCR 파서 테스트 전체 통과!');
}
