/**
 * 세션55 — 알레르겐 «쓰기 경로» 정본화 회귀
 *
 * ★ 이 파일이 지키는 것: **DB 에 들어가기 «전에» 이름이 정본이 되는가.**
 *
 *   2026-08-08 실측 — `product_allergens.allergen_name` 에 쓰는 경로에 정규화가 한 곳도 없었다.
 *   정규화는 **읽기 시점**(`productModel.getAllergens`)에만 있었다. 그 결과:
 *
 *     ① 같은 알레르겐이 여러 표기로 저장됐다 (2026-07-31 실측: 5,649행 중 비정본 705행 = 12.5%).
 *     ② UNIQUE 인덱스가 `(product_id, allergen_name)` 이라(`000_baseline.sql:360`)
 *        `난류` 행과 `난류(가금류)` 행은 **다른 키**다 → `ON CONFLICT` 불발 → 중복 행.
 *     ③ `scripts/76-normalize-allergen-names.js` 로 청소해도 다음 제보에 재오염됐다.
 *
 *   ⚠ 이름 축 통일(`test_allergen_axis.js`)만으로는 이 문제가 안 풀린다.
 *     축을 통일해도 «쓰기 경로가 무방비»라는 구조는 그대로였다 —
 *     다음에 다른 표기가 원재료 키워드로 들어오는 순간 같은 오염이 재발한다.
 *     그래서 두 회귀는 각각 다른 것을 지킨다. 하나로 합치지 말 것.
 *
 *   ⚠ 이 파일은 소스를 읽지 않는다. `mergeService` 의 실제 함수를 부른다.
 *
 * ── 뮤턴트 실측 (2026-08-08) — 이 회귀가 «무엇을 못 잡는지»도 적는다 ──────────────
 *   잡는 것:
 *     MUT-1 정본화 무력화(항등함수)            → 14건 실패
 *     MUT-3 v2 전용 이름 버리기                 →  1건 실패 (세션44 혼입 경로)
 *     MUT-4 등급을 «정본 키»로 조회             →  1건 실패 (혼입 → 직접함유 승격)
 *     MUT-5 정본에 안 붙는 이름 버리기          →  2건 실패 (과소경고)
 *     MUT-7 기여별 중복제거 제거                → 10건 실패 (source_count 부풀림)
 *
 *   ⚠ **못 잡는 것 — MUT-6 `strongerLevel` 을 «덮어쓰기» 로 바꾸기.**
 *     `levelsFromV2` 가 `may_contain → inferred → contains` 순, 즉 **약한 것부터** 넣는다
 *     (실측: `[['B','may_contain'],['C','inferred'],['A','contains']]`).
 *     그래서 마지막에 처리되는 등급이 항상 가장 강하고, 덮어쓰기와 `strongerLevel` 이
 *     **현재 배선에서는 동치**다. 관측 자체가 불가능하므로 억지로 잡는 케이스를 만들지 않았다.
 *     `strongerLevel` 은 그 순서 가정에 «의존하지 않기 위한» 방어다 —
 *     `levelsFromV2` 의 put 순서를 바꾸면 이 회귀는 못 잡는다. 그때는 그쪽에서 잡아야 한다.
 *     ★ 「테스트가 통과했으니 안전하다」가 아니라 「여기까지 쟀다」로 읽을 것(세션54 §7).
 */
'use strict';
const assert = require('assert');
const merge = require('../src/services/mergeService');
const { CANONICAL_19 } = require('../src/services/allergenName');

let pass = 0;
const fails = [];
function t(title, fn) {
  try { fn(); pass++; console.log('  ✅ ' + title); }
  catch (e) { fails.push({ title, msg: e.message }); console.log('  ❌ ' + title + '\n     ' + e.message); }
}
function section(s) { console.log('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 66 - s.length))); }

console.log('\n===== 세션55 알레르겐 쓰기 경로 정본화 =====');

// ------------------------------------------------------------------
// §0. 표본 부재 방지 — 세션54 §7
// ------------------------------------------------------------------
section('§0. 표본 수 단정');
t('mergeService 가 정본화 함수를 노출한다', () => {
  assert.strictEqual(typeof merge.canonicalizeAllergenName, 'function',
    'canonicalizeAllergenName 미노출 — 회귀가 로직을 재현하게 되면 배선 변경을 못 잡는다');
  assert.strictEqual(typeof merge.unionAllergens, 'function');
});
t('19종 정본 목록이 로드됐다', () => {
  assert.strictEqual(CANONICAL_19.length, 19, `${CANONICAL_19.length}종 — 목록을 못 읽고 있다`);
});
t('unionAllergens 가 실제로 무언가를 낸다', () => {
  const r = merge.unionAllergens([['밀', '우유']], [null]);
  assert.ok(Array.isArray(r) && r.length === 2, `실제: ${JSON.stringify(r)}`);
});

// ------------------------------------------------------------------
// §1. 별칭이 정본으로 바뀐다
// ------------------------------------------------------------------
section('§1. 별칭 → 정본');
const ALIAS_CASES = [
  ['난류', '난류(가금류)'],
  ['알류', '난류(가금류)'],
  ['계란', '난류(가금류)'],
  ['달걀', '난류(가금류)'],
];
for (const [raw, want] of ALIAS_CASES) {
  t(`canonicalizeAllergenName("${raw}") → "${want}"`, () => {
    const got = merge.canonicalizeAllergenName(raw);
    assert.ok(got.includes(want), `실제: ${JSON.stringify(got)}`);
  });
}

t('정본 이름은 자기 자신 그대로다 (정규화가 정본을 흔들지 않는다)', () => {
  for (const n of CANONICAL_19) {
    const got = merge.canonicalizeAllergenName(n);
    assert.ok(got.includes(n), `"${n}" → ${JSON.stringify(got)}`);
  }
});

// ------------------------------------------------------------------
// §2. ★★★ 두 표기가 «한 행»으로 합쳐진다 — UNIQUE 키 중복의 원인 제거
// ------------------------------------------------------------------
section('§2. 두 표기가 한 행으로 합쳐진다');

t('같은 기여 안의 `난류` 와 `난류(가금류)` 는 «1행»이 된다', () => {
  const rows = merge.unionAllergens([['난류', '난류(가금류)']], [null]);
  const egg = rows.filter((r) => r.name === '난류(가금류)' || r.name === '난류');
  assert.strictEqual(egg.length, 1,
    `${egg.length}행이다 — UNIQUE(product_id, allergen_name) 에서 중복 행이 된다. 실제: ${JSON.stringify(rows)}`);
  assert.strictEqual(egg[0].name, '난류(가금류)', `정본이 아니다: ${egg[0].name}`);
});

t('서로 다른 기여의 `계란` 과 `난류` 도 «1행»이 되고 source_count 가 합산된다', () => {
  const rows = merge.unionAllergens([['계란'], ['난류']], [null, null]);
  const egg = rows.filter((r) => r.name === '난류(가금류)');
  assert.strictEqual(egg.length, 1, `실제: ${JSON.stringify(rows)}`);
  assert.strictEqual(egg[0].source_count, 2,
    `source_count=${egg[0].source_count} — 두 기여가 같은 알레르겐을 말했는데 합산되지 않았다. ` +
    `합산되지 않으면 자동 확정(AUTO_VERIFY) 판정이 틀린다`);
});

t('한 기여 안의 중복은 source_count 를 부풀리지 않는다', () => {
  const rows = merge.unionAllergens([['계란', '난류', '달걀']], [null]);
  const egg = rows.filter((r) => r.name === '난류(가금류)');
  assert.strictEqual(egg.length, 1, `실제: ${JSON.stringify(rows)}`);
  assert.strictEqual(egg[0].source_count, 1,
    `source_count=${egg[0].source_count} — 한 사람이 세 표기로 말한 것을 세 명으로 셌다`);
});

// ------------------------------------------------------------------
// §3. 등급이 정본화 과정에서 «떨어지지 않는다»
//   ⚠ 이것이 이 변경의 가장 위험한 지점이다.
//     이름을 바꾸면서 등급 짝맞춤이 어긋나면 「직접 함유」가 「혼입 가능」으로 강등된다 = 과소경고.
// ------------------------------------------------------------------
section('§3. 정본화가 등급을 낮추지 않는다');

t('flat 의 별칭에 붙은 contains 등급이 유지된다', () => {
  const rows = merge.unionAllergens(
    [['계란']],
    [{ contains: ['계란'], mayContain: [], inferred: [] }],
  );
  const egg = rows.find((r) => r.name === '난류(가금류)');
  assert.ok(egg, `난류가 없다: ${JSON.stringify(rows)}`);
  assert.strictEqual(egg.evidence_level, 'contains', `등급이 ${egg.evidence_level} 로 떨어졌다`);
});

t('두 표기가 서로 다른 등급이면 «강한 쪽»이 남는다 (강등 금지)', () => {
  const rows = merge.unionAllergens(
    [['난류', '계란']],
    [{ contains: ['계란'], mayContain: ['난류'], inferred: [] }],
  );
  const egg = rows.find((r) => r.name === '난류(가금류)');
  assert.ok(egg, `난류가 없다: ${JSON.stringify(rows)}`);
  assert.strictEqual(egg.evidence_level, 'contains',
    `등급이 ${egg.evidence_level} — 혼입(may_contain)이 직접함유(contains)를 덮었다. 과소경고다`);
});

t('★ flat 에도 있는 별칭이 «혼입» 이면 혼입 그대로다 — 직접함유로 승격하지 않는다', () => {
  // ⚠ MUT-4 대응 — 등급을 «정본 이름»으로 조회하면 v2 의 키(별칭)와 어긋나 miss 가 나고,
  //   기본값 `contains` 로 떨어진다. 그러면 「같은 시설에서 만들었다」가 「들어 있다」가 된다.
  //   기본값이 가장 강한 등급이라 이 사고는 **조용히 과잉경고 쪽으로** 난다.
  //   등급 조회는 반드시 «원문 이름»으로 해야 한다.
  const rows = merge.unionAllergens(
    [['계란']],
    [{ contains: [], mayContain: ['계란'], inferred: [] }],
  );
  const egg = rows.find((r) => r.name === '난류(가금류)');
  assert.ok(egg, `난류가 없다: ${JSON.stringify(rows)}`);
  assert.strictEqual(egg.evidence_level, 'may_contain',
    `등급이 ${egg.evidence_level} — 혼입이 직접함유로 올라갔다. 과잉경고이고, ` +
    `과잉경고가 흔해지면 진짜 경고를 무시하게 된다(alarm fatigue)`);
});

t('★ 두 별칭이 서로 다른 등급이어도 «어느 쪽이 contains 이든» 강한 쪽이 남는다', () => {
  // ⚠ MUT-6 대응 — 병합을 `strongerLevel` 이 아니라 «덮어쓰기» 로 바꾸면
  //   결과가 «마지막에 처리된 등급»으로 결정된다.
  //   `levelsFromV2` 의 순회 순서는 고정이므로, 한 배치만 검사하면 절반은 우연히 통과한다.
  //   → contains 를 어느 별칭에 두는지 **양쪽 다** 검사한다.
  const A = merge.unionAllergens([['난류', '계란']],
    [{ contains: ['계란'], mayContain: ['난류'], inferred: [] }]);
  const B = merge.unionAllergens([['난류', '계란']],
    [{ contains: ['난류'], mayContain: ['계란'], inferred: [] }]);
  for (const [label, rows] of [['contains=계란', A], ['contains=난류', B]]) {
    const egg = rows.find((r) => r.name === '난류(가금류)');
    assert.ok(egg, `${label}: 난류가 없다: ${JSON.stringify(rows)}`);
    assert.strictEqual(egg.evidence_level, 'contains',
      `${label}: 등급이 ${egg.evidence_level} — 직접 함유가 혼입으로 «강등»됐다. 과소경고다`);
  }
});

t('v2 에만 있는 별칭도 채택되고 등급이 붙는다 (세션44 혼입 경로)', () => {
  const rows = merge.unionAllergens(
    [[]],
    [{ contains: [], mayContain: ['계란'], inferred: [] }],
  );
  const egg = rows.find((r) => r.name === '난류(가금류)');
  assert.ok(egg, `혼입 정보가 DB 에 도달하지 못한다: ${JSON.stringify(rows)}`);
  assert.strictEqual(egg.evidence_level, 'may_contain', `실제 등급: ${egg.evidence_level}`);
});

// ------------------------------------------------------------------
// §4. ★ 모르는 이름은 «버리지 않는다» — 과소경고 방지
//   정본에 안 붙는다고 지우면 사용자가 알아야 할 정보가 사라진다.
// ------------------------------------------------------------------
section('§4. 정본에 안 붙는 이름은 원문으로 살아남는다');

t('정본화되지 않는 이름이 사라지지 않는다', () => {
  const got = merge.canonicalizeAllergenName('키위');
  assert.ok(got.length > 0, '이름이 통째로 사라졌다 — 과소경고');
  assert.ok(got.includes('키위'), `실제: ${JSON.stringify(got)}`);
});

t('unionAllergens 도 모르는 이름을 유지한다', () => {
  const rows = merge.unionAllergens([['키위', '계란']], [null]);
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('키위'), `키위가 사라졌다: ${JSON.stringify(names)}`);
  assert.ok(names.includes('난류(가금류)'), `실제: ${JSON.stringify(names)}`);
});

t('빈 문자열·비문자열은 행을 만들지 않는다', () => {
  assert.deepStrictEqual(merge.canonicalizeAllergenName(''), []);
  assert.deepStrictEqual(merge.canonicalizeAllergenName('   '), []);
  assert.deepStrictEqual(merge.canonicalizeAllergenName(null), []);
  assert.deepStrictEqual(merge.canonicalizeAllergenName(42), []);
});

// ------------------------------------------------------------------
// §5. ★★ 비정본 이름이 «쓰기 대상»에 남아 있지 않다
//   실제 OCR 출력을 그대로 흘려보내고, DB 에 갈 이름을 검사한다.
// ------------------------------------------------------------------
section('§5. 쓰기 대상에 알려진 별칭이 없다');

t('알려진 별칭이 쓰기 대상 이름으로 나오지 않는다', () => {
  const ALIASES = ['난류', '알류', '계란', '달걀'];
  const rows = merge.unionAllergens(
    [['난류', '계란'], ['알류'], ['달걀', '우유']],
    [null, null, null],
  );
  const leaked = rows.map((r) => r.name).filter((n) => ALIASES.includes(n));
  assert.deepStrictEqual(leaked, [],
    `DB 에 별칭이 그대로 들어간다: ${JSON.stringify(leaked)} / 전체: ${JSON.stringify(rows.map((r) => r.name))}`);
});

// ------------------------------------------------------------------
console.log(`\n📊 세션55 알레르겐 쓰기 경로 정본화: ${pass} 통과 / ${fails.length} 실패 (총 ${pass + fails.length})`);
if (fails.length) {
  console.log('\n실패 상세:');
  for (const f of fails) console.log(`  - ${f.title}\n    ${f.msg}`);
  process.exit(1);
}
console.log('✅ DB 에 들어가기 전에 이름이 정본이 된다.');
