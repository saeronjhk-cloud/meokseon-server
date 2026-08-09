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
 *
 * ★★★ 세션58 — 제이 결정 **D55-2**(2026-08-08)로 «원재료 추론»이 폐기됐다.
 *   `IP/알레르기_추론폐기_설계_2026-08-08_세션55.md` §6 이 이 파일에 대해 지시한 것:
 *     「§0 표 로드 확인 · §1 축 비교 — `ALLERGEN_KEYWORDS` 를 직접 import 한다.
 *       축 대조를 **`ALLERGEN_NAMES` 기준으로 재설계**」
 *
 *   무엇이 달라졌나 — B·C 가 «낼 수 있는» 이름의 출처가 하나로 줄었다:
 *     · `ALLERGEN_NAMES`    (법정 19종 명칭 + 라벨 인쇄 별칭)  → **이것이 남은 축이다**
 *     · `ALLERGEN_KEYWORDS` (원재료 형태 표)                  → **도달 불가**. 되돌리기 위해 남겨 둔 표다.
 *   그래서 §1 의 `axisBC` 를 `ALLERGEN_NAMES` 기준으로 좁혔다. `ALLERGEN_KEYWORDS` 는
 *   §0-C 에서 **「되돌릴 수 있게 남아 있는가」**만 확인한다 — 축 구성원으로 세지 않는다.
 *
 *   ⚠ 그리고 이 파일의 입력이 바뀌었다. **원재료 문장으로 물으면 B·C 는 이제 반드시 빈 결과다.**
 *     축을 물으려면 «법정 선언 문구»로 물어야 한다(§4). 원재료 문장 케이스는 지우지 않고
 *     **「아무것도 내지 않는다」는 추론 폐기 회귀**로 질문을 바꿔 살렸다(§4-B).
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
t('판별기 B·C 의 «축 표»가 실제로 로드됐다 (ALLERGEN_NAMES)', () => {
  // ★★★ 세션58 — 축을 세는 표는 이제 `ALLERGEN_NAMES` 하나다(설계 §6).
  assert.ok(ALLERGEN_NAMES && typeof ALLERGEN_NAMES === 'object',
    'ALLERGEN_NAMES 미로드 — ocrParser 의 module.exports 를 확인할 것');
  assert.ok(Object.keys(ALLERGEN_NAMES).length >= 15,
    `ALLERGEN_NAMES 키가 ${Object.keys(ALLERGEN_NAMES).length}개뿐이다`);
});
t('§0-C `ALLERGEN_KEYWORDS` 는 «되돌릴 수 있게» 남아 있다 (축 구성원으로는 세지 않는다)', () => {
  // ★★★ 세션58 — 이 케이스는 지우지 않고 «질문을 바꿨다».
  //   종전 질문: 「B·C 의 표가 로드됐는가」 — 이 표는 B·C 의 축이었다.
  //   지금:      D55-2 로 어느 매칭 경로도 이 표를 읽지 않는다(**도달 불가**).
  //              그런데도 `ocrParser.js` 가 «일부러» 남겨 뒀다 — 되돌리기 위해서다(설계 §5 4단계).
  //   → 그래서 「여전히 export 되는가」만 본다. 사라지면 되돌리기 경로가 끊긴 것이므로 알아야 한다.
  //   ⚠ 이 단정이 초록이라고 해서 「원재료 표가 동작 중」이라고 읽지 말 것. §4-B 가 그 반대를 못 박는다.
  assert.ok(ALLERGEN_KEYWORDS && typeof ALLERGEN_KEYWORDS === 'object',
    'ALLERGEN_KEYWORDS 가 사라졌다 — D55-2 되돌리기 경로가 끊겼다. 지우려면 도메인 결정이 먼저다');
  assert.ok(Object.keys(ALLERGEN_KEYWORDS).length >= 15,
    `ALLERGEN_KEYWORDS 키가 ${Object.keys(ALLERGEN_KEYWORDS).length}개뿐이다`);
});
t('판별기가 실제로 호출되고 무언가를 낸다', () => {
  // ★★★ 세션58 — 입력을 `'원재료명: 계란, 밀가루, 우유'` 에서 **법정 선언 문구**로 바꿨다.
  //   왜: D55-2 이후 원재료 문장은 «설계상» 빈 배열이다. 그 입력으로는 이 절의 목적
  //   (「아무것도 안 쟀다」와 「완벽하다」를 구별한다 — 세션54 §7)을 달성할 수 없다.
  //   → (가) 의도된 결과이므로 «묻는 문맥»을 B·C 가 실제로 읽는 것으로 옮긴다.
  const r = detectAllergens('알레르기 유발물질: 난류(가금류), 밀, 우유 함유');
  assert.ok(Array.isArray(r) && r.length >= 2,
    `detectAllergens 가 ${JSON.stringify(r)} — 아무것도 안 잡고 있다면 이 파일의 모든 단정이 무의미하다`);
});

// ------------------------------------------------------------------
// §1. 축 집합이 «정확히» 같다
// ------------------------------------------------------------------
console.log('\n§1. 세 판별기의 이름 집합이 같은가');
const axisA = new Set(CANONICAL_19);
// ★★★ 세션58 — 종전: `new Set([...keys(ALLERGEN_KEYWORDS), ...keys(ALLERGEN_NAMES)])`.
//   설계 §6 지시대로 **`ALLERGEN_NAMES` 기준으로 재설계**했다. 근거:
//     ① D55-2 이후 B·C 가 «출력할 수 있는» 키의 출처는 `ALLERGEN_NAMES` 하나뿐이다.
//        `ALLERGEN_KEYWORDS` 의 키는 어떤 경로로도 `detected.add()` 되지 않는다.
//     ② 합집합으로 두면 **거짓 초록**이 생긴다 — `ALLERGEN_NAMES` 에서 한 종이 통째로 빠져도
//        `ALLERGEN_KEYWORDS` 가 그 키를 갖고 있어 「A 에만 있는 이름 없음」이 통과한다.
//        (실제로 세션58 은 `아황산류`·`조개류` 가 B 에서 매칭 불가였던 것을 이 파일이 아니라
//         sentinel 로 발견했다 — 이 절이 표만 보고 있었기 때문이다.)
const axisBC = new Set(Object.keys(ALLERGEN_NAMES));

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

// ★★★ 세션58 — 라벨 문자열에 **법정 선언 줄을 붙였다.** 케이스는 한 건도 지우지 않았다.
//   왜 고쳤나: D55-2 이후 원재료 문장만 있는 라벨에서는 `detectAllergens` 가 [] 를 낸다.
//   그러면 이 절이 **여전히 초록이지만 아무것도 재지 않는다** — 합집합의 한쪽(라벨)이 비어 있으므로
//   「같은 알레르겐이 두 이름으로 들어가는가」를 물을 수 없다. 세션54 §7 이 경고한 «거짓 초록»이다.
//   → 원재료 줄은 남겨 두고(추론이 되살아나면 §4-B 가 잡는다) 선언 줄을 덧붙여 라벨 쪽을 되살렸다.
const MIX_CASES = [
  { label: '원재료명: 계란, 밀가루, 정제수\n알레르기 유발물질: 난류(가금류), 밀 함유', user: ['계란'],  axis: '난류(가금류)' },
  { label: '원재료명: 계란, 밀가루, 정제수\n알레르기 유발물질: 난류(가금류), 밀 함유', user: ['난류'],  axis: '난류(가금류)' },
  { label: '원재료명: 계란, 밀가루, 정제수\n알레르기 유발물질: 난류(가금류), 밀 함유', user: ['알류'],  axis: '난류(가금류)' },
  { label: '원재료명: 정제수, 탈지분유\n우유 함유',                                  user: ['우유'],  axis: '우유' },
  { label: '원재료명: 밀가루, 정제수\n밀 함유',                                      user: ['밀'],    axis: '밀' },
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

// ★★★ 세션58 — OUT_CASES 를 **두 갈래로 나눴다.** 케이스는 한 건도 지우지 않았다.
//   제이 결정 D55-2 이후 B·C 가 읽는 문맥은 «법정 선언 문구» 하나다. 그래서
//     · 선언 문구 입력 → 정본 이름이 «나와야» 한다            (OUT_CASES, 종전 그대로)
//     · 원재료 문장 입력 → 정본 이름이 «나오면 안 된다»        (OUT_CASES_INGREDIENT, §4-B)
//   종전 목록의 `원재료명: 계란, 정제수` 와 `원재료명: 마요네즈, 정제수` 두 건은 후자로 옮겼다.
const OUT_CASES = [
  // ★ 세션58 — 종전 첫 줄 `원재료명: 계란, 정제수` 가 «묻던 것»(계란 별칭 → 정본 이름)을
  //   잃지 않도록, 같은 별칭을 **법정 선언 문구**로 다시 묻는 줄을 넣었다.
  { text: '알레르기 유발물질: 계란, 정제수 함유', expect: '난류(가금류)' },
  { text: '난류(가금류), 우유 함유',        expect: '난류(가금류)' },
  { text: '알류, 우유 함유',                expect: '난류(가금류)' },
  { text: '계란, 우유 함유',                expect: '난류(가금류)' },
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
// §4-B. ★★★ 세션58 — 원재료 문장에서는 B·C 가 «아무것도 내지 않는다» (추론 폐기 회귀)
//
//   제이 결정 D55-2 (2026-08-08) · `IP/알레르기_추론폐기_설계_2026-08-08_세션55.md`:
//     알레르기 유발물질은 원재료명 표시란 근처의 «별도 표시란»에 함유량과 무관하게 전부 표기된다.
//     `밀가루` 에서 `밀` 을, `마요네즈` 에서 난류를 추론할 필요가 없다.
//     실측(라벨 68건): 추론의 «순수 추가분» 0종. v1 이 더 낸 4종 중 3종은 오탐이었다.
//
//   ⚠ 아래 두 줄은 종전 §4 의 케이스 그대로다. **기대값을 뒤집은 것이 아니라 «질문»을 뒤집었다.**
//     `마요네즈` 는 `ALLERGEN_KEYWORDS`(원재료 형태 표)에만 있는 항목이고, 그 표는 이제 도달 불가다.
//     즉 「B·C 가 마요네즈에서 정본 이름을 내는가」는 **무의미해진 질문**이라 살릴 수 없다.
//     대신 그 자리에서 답할 수 있는 유일하게 의미 있는 질문 —「정말 안 내는가」— 로 바꿨다.
//   ⚠ 이 단정이 빨개지는 유일한 방법은 원재료 추론을 되살리는 것이다. 그때는 도메인 결정이 먼저다.
// ------------------------------------------------------------------
console.log('\n§4-B. 원재료 문장에서는 B·C 가 아무것도 내지 않는다 (D55-2 추론 폐기 회귀)');

const OUT_CASES_INGREDIENT = [
  '원재료명: 계란, 정제수',
  '원재료명: 마요네즈, 정제수',
  '원재료명: 밀가루, 정제수, 탈지분유',
  '원재료명: 새우살, 게살, 대두레시틴',
];

for (const text of OUT_CASES_INGREDIENT) {
  t(`detectAllergens("${text.slice(0, 20)}…") → [] (추론 폐기)`, () => {
    const r = detectAllergens(text) || [];
    assert.deepStrictEqual(r, [], `원재료에서 추론이 나왔다: ${JSON.stringify(r)} — D55-2 위반`);
  });
  t(`detectAllergensV2("${text.slice(0, 20)}…") → 3구획 전부 [] (추론 폐기)`, () => {
    const v = detectAllergensV2(text) || {};
    const all = [...(v.contains || []), ...(v.inferred || []), ...(v.mayContain || [])];
    assert.deepStrictEqual(all, [], `원재료에서 추론이 나왔다: ${JSON.stringify(v)} — D55-2 위반`);
    // ★ `inferred` 필드 «자체»는 응답 계약이라 남아 있어야 한다(항상 빈 배열).
    //   없애면 세션44 치명3(「flat 에만 있는 알레르기가 화면에서 통째로 사라진다」)이 되살아난다.
    assert.ok(Array.isArray(v.inferred), 'inferred 필드가 사라졌다 — 응답 계약 위반');
  });
}

// ------------------------------------------------------------------
// §5. 비정본 이름이 «출력»으로 새어 나오지 않는다
//   입력으로 받는 것은 정상이다(별칭). 출력에 있으면 축이 다시 갈린 것이다.
// ------------------------------------------------------------------
console.log('\n§5. 비정본 이름이 출력에 없다');
const NON_CANONICAL = ['난류', '알류', '계란', '달걀'];
t('B·C 출력에 비정본 이름이 없다', () => {
  // ★ 세션58 — 첫 줄(원재료 문장)은 D55-2 로 «항상 빈 결과»라 이제 누출을 시험하지 못한다.
  //   지우지 않고 남긴다(§4-B 가 그 공백 자체를 단정한다). 실제로 축 누출을 시험하는 것은
  //   뒤의 두 줄(선언·혼입 문구)이다. 여기에 새 탐침을 넣을 때는 반드시 선언/혼입 형태로 쓸 것.
  const texts = ['원재료명: 계란, 달걀, 난백, 마요네즈', '난류, 알류 함유', '계란 혼입 가능',
    '알레르기 유발물질: 계란, 달걀, 난백 함유', '난백, 난황을 함유'];
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
