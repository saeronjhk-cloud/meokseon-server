/**
 * 세션55 — 알레르겐 «이름 축» 동일성 회귀
 *
 * ★ 이 파일이 지키는 것은 「판정이 맞는가」가 아니라 **「세 판별기가 같은 이름으로 말하는가」** 다.
 *
 *   저장소에는 알레르겐 판별기가 셋 있다:
 *     A  `allergenName.normalizeAllergenNames`   — DB 행·사용자 자유입력 정규화
 *     B  `ocrParser.detectAllergens`             — OCR 텍스트 → 평탄 목록
 *     C  `ocrParser.detectAllergensV2`           — OCR 텍스트 → 3분리(contains/inferred/mayContain)
 *
 *   세션54 까지 A 는 `난류(가금류)` 를, B·C 는 `난류` 를 냈다. 나머지 18종은 문자열까지 같았다.
 *   그 1종의 불일치가 **사용자 화면에 두 줄로 새어 나왔다** — 아래 §3 이 그 재현이다.
 *
 *   ⚠ 왜 「소스에 같은 문자열이 있는가」로 검사하지 않는가:
 *     `ALLERGEN_KEYWORDS` 는 `Object.entries(table)` 로 순회된다. 키를 바꿔도 **에러가 나지 않는다.**
 *     조용히 다른 이름을 내보낼 뿐이다. 그래서 이 파일은 **전부 실호출**로 확인한다.
 *     (세션54 §9-3 「소스 문자열 검사는 이 저장소의 상습 족쇄」)
 *
 *   ⚠ 제이 결정 2026-08-08 — **정본은 `난류(가금류)` 다.** B·C 를 이쪽으로 올렸다.
 *     되돌리려면 도메인 결정이 먼저 있어야 한다. 테스트 기대값을 구현에 맞춰 고치지 말 것.
 *     (법정 표기는 「알류(가금류에 한한다)」라 셋 다 다르다 —
 *      `IP/이름축_통일_조사_2026-08-08_세션55.md` §6. 그건 별개 과제로 남아 있다.)
 */
'use strict';
const assert = require('assert');

const { CANONICAL_19, normalizeAllergenNames } = require('../src/services/allergenName');
const { detectAllergens, detectAllergensV2, ALLERGEN_KEYWORDS, ALLERGEN_NAMES } =
  require('../src/services/ocrParser');
const { sanitizeUserAllergens } = require('../src/routes/ocrRoutes');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

console.log('\n===== 세션55 알레르겐 이름 축 동일성 =====\n');

// ------------------------------------------------------------------
// §0. ★ 표본 수 단정 — 세션54 §7 의 교훈
//   첫 실측이 GT 키 이름을 잘못 읽어 전건을 건너뛰고 「FP 0 / FN 0 = 완벽」을 냈다.
//   「아무것도 안 쟀다」와 「완벽하다」는 구별돼야 한다. 그래서 재는 대상이 있는지 먼저 단정한다.
// ------------------------------------------------------------------
console.log('§0. 표본 수 단정');
t('19종 목록이 실제로 로드됐다 (A)', () => {
  assert.ok(Array.isArray(CANONICAL_19), 'CANONICAL_19 가 배열이 아니다');
  assert.strictEqual(CANONICAL_19.length, 19, `CANONICAL_19 가 ${CANONICAL_19.length}종 — 19종이 아니다`);
});
t('판별기 B·C 의 표가 실제로 로드됐다', () => {
  assert.ok(ALLERGEN_KEYWORDS && typeof ALLERGEN_KEYWORDS === 'object', 'ALLERGEN_KEYWORDS 미로드');
  assert.ok(ALLERGEN_NAMES && typeof ALLERGEN_NAMES === 'object',
    'ALLERGEN_NAMES 미로드 — ocrParser 의 module.exports 를 확인할 것');
  assert.ok(Object.keys(ALLERGEN_KEYWORDS).length >= 15,
    `ALLERGEN_KEYWORDS 키가 ${Object.keys(ALLERGEN_KEYWORDS).length}개뿐이다`);
  assert.ok(Object.keys(ALLERGEN_NAMES).length >= 15,
    `ALLERGEN_NAMES 키가 ${Object.keys(ALLERGEN_NAMES).length}개뿐이다`);
});
t('판별기가 실제로 호출되고 무언가를 낸다', () => {
  const r = detectAllergens('원재료명: 계란, 밀가루, 우유');
  assert.ok(Array.isArray(r) && r.length >= 2,
    `detectAllergens 가 ${JSON.stringify(r)} — 아무것도 안 잡고 있다면 이 파일의 모든 단정이 무의미하다`);
});

// ------------------------------------------------------------------
// §1. 축 집합이 «정확히» 같다
// ------------------------------------------------------------------
console.log('\n§1. 세 판별기의 이름 집합이 같은가');
const axisA = new Set(CANONICAL_19);
const axisBC = new Set([...Object.keys(ALLERGEN_KEYWORDS), ...Object.keys(ALLERGEN_NAMES)]);

t('A 에만 있는 이름이 없다', () => {
  const only = [...axisA].filter(x => !axisBC.has(x));
  assert.deepStrictEqual(only, [],
    `A 에만 있는 이름: ${JSON.stringify(only)} — B·C 가 이 이름을 «절대» 낼 수 없다는 뜻이다`);
});
t('B·C 에만 있는 이름이 없다', () => {
  const only = [...axisBC].filter(x => !axisA.has(x));
  assert.deepStrictEqual(only, [],
    `B·C 에만 있는 이름: ${JSON.stringify(only)} — 이 이름은 A 의 19종 정본에 없다. ` +
    `DB 에 비정본 이름으로 적재되고, 읽기 시점 정규화에 의존하게 된다`);
});
t('두 축의 크기가 같다', () => {
  assert.strictEqual(axisBC.size, axisA.size, `A ${axisA.size}종 vs B·C ${axisBC.size}종`);
});

// ------------------------------------------------------------------
// §2. 정본 이름은 «자기 자신»으로 정규화된다 (A 가 정본을 다시 바꾸지 않는다)
//   이것이 깨지면 「정본」이라는 말이 성립하지 않는다.
// ------------------------------------------------------------------
console.log('\n§2. 정본 이름의 self-map');
for (const name of CANONICAL_19) {
  t(`normalizeAllergenNames("${name}") → 자기 자신`, () => {
    const hits = normalizeAllergenNames(name) || [];
    const names = hits.map(h => h && h.name);
    assert.ok(names.includes(name),
      `"${name}" 을 넣었더니 ${JSON.stringify(names)} 가 나왔다 — 정본이 자기 자신으로 안 돌아온다`);
  });
}

// ------------------------------------------------------------------
// §3. ★★★ 실제 버그의 재현 — OCR 응답 한 배열에 두 이름이 «동시에» 들어가는가
//
//   상황: 라벨이 계란을 담고 있고, 사용자도 계란 알레르기를 등록해 두었다.
//   `ocrRoutes.js` 는 B·C 출력과 사용자 입력(A 로 정규화됨)을 `new Set` 으로 합친다.
//   축이 갈려 있으면 문자열이 달라 **중복으로 인식되지 않는다.**
//
//   그리고 `web/src/domain/meokseon/allergens.ts` 의 `clean()` 은 trim + 중복제거만 한다 —
//   이름을 해석하지 않는다(pass-through). 그래서 **화면에 두 줄이 그대로 뜬다.**
//
//   ⚠ 이건 미관 문제가 아니다. 같은 알레르겐이 두 이름으로 뜨는 화면은
//     「이 앱의 알레르겐 목록은 정확하지 않다」는 신호를 준다 → alarm fatigue(세션44 이후 일관된 원칙).
// ------------------------------------------------------------------
console.log('\n§3. 사용자 입력 ∪ OCR 출력 — 같은 알레르겐이 두 이름으로 나오지 않는다');

function unionLikeRoute(labelText, userInput) {
  // ocrRoutes.js:383-388 과 «같은 함수»를 부른다. 로직을 베끼지 않는다.
  const fromLabel = detectAllergens(labelText) || [];
  const { accepted } = sanitizeUserAllergens(userInput);
  return Array.from(new Set([...fromLabel, ...accepted]));
}

const MIX_CASES = [
  { label: '원재료명: 계란, 밀가루, 정제수', user: ['계란'],  axis: '난류(가금류)' },
  { label: '원재료명: 계란, 밀가루, 정제수', user: ['난류'],  axis: '난류(가금류)' },
  { label: '원재료명: 계란, 밀가루, 정제수', user: ['알류'],  axis: '난류(가금류)' },
  { label: '원재료명: 정제수, 탈지분유',      user: ['우유'],  axis: '우유' },
  { label: '원재료명: 밀가루, 정제수',        user: ['밀'],    axis: '밀' },
];

for (const c of MIX_CASES) {
  t(`라벨 "${c.label.slice(0, 22)}…" + 사용자 ${JSON.stringify(c.user)} → "${c.axis}" 가 1개`, () => {
    const merged = unionLikeRoute(c.label, c.user);
    // 같은 알레르겐을 가리키는 이름이 둘 이상 들어갔는지 본다.
    const variants = merged.filter(n => n === c.axis || n === '난류' || n === '알류');
    const same = merged.filter(n => n === c.axis);
    assert.strictEqual(same.length, 1,
      `"${c.axis}" 가 ${same.length}개다. 실제 배열: ${JSON.stringify(merged)}`);
    if (c.axis === '난류(가금류)') {
      assert.strictEqual(variants.length, 1,
        `난류가 여러 이름으로 들어갔다: ${JSON.stringify(merged)} ` +
        `— 화면에 같은 알레르겐이 두 줄로 뜬다`);
    }
  });
}

// ------------------------------------------------------------------
// §4. 판별기 B·C 가 실제로 정본 이름을 «낸다» (표 키만 바꾸고 배선이 안 따라오는 것을 막는다)
// ------------------------------------------------------------------
console.log('\n§4. B·C 실출력이 정본 이름인가');

const OUT_CASES = [
  { text: '원재료명: 계란, 정제수',        expect: '난류(가금류)' },
  { text: '난류(가금류), 우유 함유',        expect: '난류(가금류)' },
  { text: '알류, 우유 함유',                expect: '난류(가금류)' },
  { text: '계란, 우유 함유',                expect: '난류(가금류)' },
  { text: '원재료명: 마요네즈, 정제수',     expect: '난류(가금류)' },
];

for (const c of OUT_CASES) {
  t(`detectAllergens("${c.text.slice(0, 20)}…") 에 "${c.expect}"`, () => {
    const r = detectAllergens(c.text) || [];
    assert.ok(r.includes(c.expect), `실제: ${JSON.stringify(r)}`);
  });
  t(`detectAllergensV2("${c.text.slice(0, 20)}…") 에 "${c.expect}"`, () => {
    const v = detectAllergensV2(c.text) || {};
    const all = [...(v.contains || []), ...(v.inferred || []), ...(v.mayContain || [])];
    assert.ok(all.includes(c.expect), `실제: ${JSON.stringify(v)}`);
  });
}

// ------------------------------------------------------------------
// §5. 비정본 이름이 «출력»으로 새어 나오지 않는다
//   입력으로 받는 것은 정상이다(별칭). 출력에 있으면 축이 다시 갈린 것이다.
// ------------------------------------------------------------------
console.log('\n§5. 비정본 이름이 출력에 없다');
const NON_CANONICAL = ['난류', '알류', '계란', '달걀'];
t('B·C 출력에 비정본 이름이 없다', () => {
  const texts = ['원재료명: 계란, 달걀, 난백, 마요네즈', '난류, 알류 함유', '계란 혼입 가능'];
  const leaked = new Set();
  for (const tx of texts) {
    const b = detectAllergens(tx) || [];
    const v = detectAllergensV2(tx) || {};
    const all = [...b, ...(v.contains || []), ...(v.inferred || []), ...(v.mayContain || [])];
    for (const n of all) if (NON_CANONICAL.includes(n)) leaked.add(n);
  }
  assert.deepStrictEqual([...leaked], [],
    `출력에 새어 나온 비정본 이름: ${JSON.stringify([...leaked])}`);
});

// ------------------------------------------------------------------
console.log(`\n📊 세션55 알레르겐 이름 축: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})`);
if (fail > 0) {
  console.log('\n⚠ 축이 갈려 있다. IP/이름축_통일_조사_2026-08-08_세션55.md 를 볼 것.');
  process.exit(1);
}
console.log('✅ 세 판별기가 같은 이름으로 말한다.');
