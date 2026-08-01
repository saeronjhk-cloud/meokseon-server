/**
 * test_allergen_name_normalize.js — 세션47 알레르겐 이름 오염 정리 + HACCP 출처 승격 회귀
 * ==========================================================================================
 * 무엇을 고정하나 —
 *   1) 19종 화이트리스트가 **IP/allergens_19_korea.json 정본과 같다** (사본 갈라짐 방지)
 *   2) 실측 오염 이름이 정본으로 정규화된다 (계란→난류(가금류) · 밀(성분)→밀 …)
 *   3) ★ 정규화가 **알레르겐을 잃지 않는다** — 메밀→밀, 땅콩→대두 같은 둔갑과
 *      "밀.우유.땅콩" 에서 2종이 사라지는 것을 막는다. 이 도메인에서 과소경고가 가장 위험하다.
 *   4) 혼입 어휘만 may_contain 으로 내린다. **`함유하고 있습니다` 는 내리지 않는다.**
 *   5) HACCP UPSERT 가 크라우드 출처를 **승격**한다 (`DO NOTHING` 이면 다음 merge 가 지운다)
 *   6) pglite(진짜 Postgres/wasm)에서 「크라우드 merge → HACCP 재적재 → 알레르겐 0건 merge」
 *      시나리오를 실제로 돌려 행이 살아남는지 본다.
 *
 * 실행:
 *   NODE_ENV=test node tests/test_allergen_name_normalize.js
 *   NODE_ENV=test SKIP_PGLITE=1 node tests/test_allergen_name_normalize.js   # DB 절 생략(빠름)
 *
 * ⚠ pglite 인스턴스 1회 부팅에 20~30초가 든다. 그래서 §9 는 **인스턴스 하나를 공유**한다.
 *   (기존 test_allergen_evidence_level.js 는 테스트마다 새로 띄운다 — 그쪽은 격리가 목적이다.)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  CANONICAL_19, normalizeAllergenName, normalizeAllergenNames,
  normalizeAllergenRows, isCanonicalAllergenName,
} = require('../src/services/allergenName');
const { buildAllergenUpsert } = require('../scripts/lib/allergenUpsert');
const { buildPlan } = require('../scripts/76-normalize-allergen-names');
const { buildAllergens } = require('../src/services/productService');

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { pass += 1; console.log(`  ✅ ${name}`); },
        (e) => { fail += 1; failures.push({ name, message: e.message }); console.log(`  ❌ ${name}\n     → ${e.message}`); },
      );
    }
    pass += 1; console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1; failures.push({ name, message: e.message });
    console.log(`  ❌ ${name}\n     → ${e.message}`);
  }
  return Promise.resolve();
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

/** 이름만 뽑는다(순서 무관 비교용). */
const names = (raw) => normalizeAllergenNames(raw).map((x) => x.name).sort();

// ════════════════════════════════════════════════════════════════════════════
// 실측 표본 — 2026-07-31 `parseAllergy` 를 그대로 import 해 실제 HACCP 덤프에 돌려 얻은 것.
//   **하나도 손으로 지어내지 않았다.** 괄호가 짝이 안 맞는 것들이 실제 DB 값이다.
//   숫자는 적재분(product_allergens 에 실제로 들어간) 행 수다.
const REAL_POLLUTED = [
  ['계란', '난류(가금류)', 339],
  ['조개류(굴)', '조개류', 65],
  ['소고기', '쇠고기', 34],
  ['조개류(굴', '조개류', 27],
  ['난류', '난류(가금류)', 24],
  ['홍합)', '조개류', 22],
  ['굴', '조개류', 11],
  ['대두[d-토코페롤(혼합형)]', '대두', 10],
  ['알류', '난류(가금류)', 8],
  ['바지락)', '조개류', 8],
  ['전복', '조개류', 6],
  ['홍합 )', '조개류', 6],
  ['이산화황', '아황산류', 5],
  ['우유(분유)', '우유', 4],
  ['밀(곡류)', '밀', 4],
  ['모시조개)', '조개류', 4],
  ['아황산나트륨', '아황산류', 4],
  ['소맥분(밀)', '밀', 3],
  ['탈지대두(대두)', '대두', 3],
  ['난황(계란)', '난류(가금류)', 2],
  ['밀식품', '밀', 2],
  // ★★ 운영에서 실물로 확인된 것 — GET /api/products/8801005013130 (질러 한입 육포)
  //    응답 allergens_v2.contains 에 "밀(성분)" 이 그대로 실려 나갔다.
  ['밀(성분)', '밀', 1],
  ['게란', '난류(가금류)', 1],      // 계란 오타
  ['돼고기', '돼지고기', 1],
  ['쇠구기', '쇠고기', 1],
  ['닭괴', '닭고기', 1],
  ['우류', '우유', 1],
  ['토마투', '토마토', 1],
  ['달걀', '난류(가금류)', 1],
  ['메추리알', '난류(가금류)', 1],
  ['꼬막', '조개류', 1],
  ['가리비', '조개류', 1],
  ['레시틴(대두)', '대두', 1],
  ['난각칼슘(계란)', '난류(가금류)', 1],
  ['조개류(해조칼슘)', '조개류', 1],
  ['명산 생식 프리미엄(메밀', '메밀', 1],
  ['[현미아몬드강정] 땅콩', '땅콩', 1],
  // 문장 조각 — parseAllergy 가 15자 초과분을 버리고 남긴 것
  ['쇠고기를 하고 있습니다.', '쇠고기', 1],
  ['본 제품은 새우', '새우', 1],
  ['팬케이크:계란', '난류(가금류)', 1],
];

// 19종 어디에도 못 붙어 **버리기로 한 것** (실측 universe 에서 나온 전부)
//   근거: 식약처 의무표시 19종에 없다. 아몬드·참깨·옥수수·페닐알라닌은 실제 알레르겐/주의물질이지만
//   이 앱의 알레르기 계약은 19종 기준이라 별도 필드 없이 이름만 흘리면 오히려 오해를 만든다.
const REAL_DROPPED = [
  '아몬드', '참깨', '옥수수', '양파', '무', '페닐알라닌', '적두', '피칸', '헤이즐넛',
  '생선', '유래 원재료', '알레르기 유발제품', '평양물냉면', '함흥비빔냉면',
  '310g(고형량155g)', '식품', '.', '젤란검)',
];

async function main() {
  // ════════════════════════════════════════════════════════════════════════
  section('§1. 19종 정본과 코드 사본이 갈라지지 않는다');

  await t('★★ CANONICAL_19 가 IP/allergens_19_korea.json 과 글자까지 같다', () => {
    const p = path.join(__dirname, '..', '..', 'IP', 'allergens_19_korea.json');
    if (!fs.existsSync(p)) {
      // 배포 산출물에는 IP/ 가 없다. 그때는 개수만이라도 고정한다.
      assert.strictEqual(CANONICAL_19.length, 19, '19종이 19개가 아니다');
      console.log('     (IP/allergens_19_korea.json 없음 — 개수만 확인)');
      return;
    }
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const canon = j.allergens.map((a) => a.name);
    assert.deepStrictEqual([...CANONICAL_19].sort(), [...canon].sort(),
      `정본과 코드 사본이 갈라졌다.\n  정본: ${canon.join(', ')}\n  코드: ${CANONICAL_19.join(', ')}`);
  });

  await t('★ 19종은 자기 자신으로 정규화된다 (정본을 깎아먹지 않는다)', () => {
    for (const c of CANONICAL_19) {
      const r = normalizeAllergenNames(c);
      assert.strictEqual(r.length, 1, `${c} → ${JSON.stringify(r)}`);
      assert.strictEqual(r[0].name, c, `${c} 가 ${r[0].name} 으로 바뀐다`);
      assert.strictEqual(r[0].level, null, `${c} 의 등급이 임의로 정해졌다`);
    }
  });

  await t('정규화 결과는 반드시 19종 안에 있다 (화이트리스트 밖으로 새지 않는다)', () => {
    for (const [raw] of REAL_POLLUTED) {
      for (const hit of normalizeAllergenNames(raw)) {
        assert.ok(isCanonicalAllergenName(hit.name), `${raw} → 비정본 ${hit.name}`);
      }
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  section('§2. 실측 오염 표본 — 전수 정규화');

  await t(`★★ 실측 오염 이름 ${REAL_POLLUTED.length}종이 전부 정본으로 붙는다`, () => {
    const bad = [];
    for (const [raw, expect] of REAL_POLLUTED) {
      const got = normalizeAllergenNames(raw);
      if (!got.some((x) => x.name === expect)) bad.push(`${JSON.stringify(raw)} → ${JSON.stringify(got.map((x) => x.name))} (기대 ${expect})`);
    }
    assert.strictEqual(bad.length, 0, `\n    ${bad.join('\n    ')}`);
  });

  await t('★ 단수 API 계약 — normalizeAllergenName 은 {name, level} 또는 null', () => {
    const r = normalizeAllergenName('밀(성분)');
    assert.deepStrictEqual(r, { name: '밀', level: null });
    assert.strictEqual(normalizeAllergenName('평양물냉면'), null);
    assert.strictEqual(normalizeAllergenName(''), null);
    assert.strictEqual(normalizeAllergenName(null), null);
    assert.strictEqual(normalizeAllergenName(undefined), null);
    assert.strictEqual(normalizeAllergenName(123), null);
    assert.strictEqual(normalizeAllergenName({}), null);
  });

  await t(`19종 밖 ${REAL_DROPPED.length}종은 버린다 (빈 배열)`, () => {
    const kept = REAL_DROPPED.filter((n) => normalizeAllergenNames(n).length > 0);
    assert.strictEqual(kept.length, 0, `버려야 하는데 살아남았다: ${JSON.stringify(kept)}`);
  });

  // ════════════════════════════════════════════════════════════════════════
  section('§3. ★★★ 과소경고 방지 — 정규화가 알레르겐을 잃지 않는다');

  // 이 절이 이 파일에서 가장 중요하다. 알레르기는 경고가 줄어드는 쪽이 위험하다.

  await t('★★ 메밀이 밀로 둔갑하지 않는다 (부분 문자열 함정)', () => {
    assert.deepStrictEqual(names('메밀'), ['메밀']);
    assert.deepStrictEqual(names('메밀가루(메밀)'), ['메밀']);
    assert.deepStrictEqual(names('명산 생식 프리미엄(메밀'), ['메밀']);
    assert.deepStrictEqual(names('메밀.대두'), ['대두', '메밀']);
  });

  await t('★★ 땅콩이 대두로 둔갑하지 않는다', () => {
    assert.deepStrictEqual(names('땅콩'), ['땅콩']);
    assert.deepStrictEqual(names('땅콩볶음분(땅콩)'), ['땅콩']);
    assert.deepStrictEqual(names('땅콩 우유'), ['우유', '땅콩'].sort());
  });

  await t('★★ 계란 오타 「게란」이 갑각류 「게」가 되지 않는다', () => {
    assert.deepStrictEqual(names('게란'), ['난류(가금류)']);
    // 반대로 진짜 게는 살아야 한다
    assert.deepStrictEqual(names('게'), ['게']);
    assert.deepStrictEqual(names('게추출물(게)'), ['게']);
    assert.deepStrictEqual(names('게농축액(게)'), ['게']);
  });

  await t('★★ 한 조각에 여러 알레르겐이 있으면 전부 낸다 (하나만 내면 나머지가 사라진다)', () => {
    assert.deepStrictEqual(names('밀.우유.땅콩'), ['밀', '우유', '땅콩'].sort());
    assert.deepStrictEqual(names('새우.계란.대두.쇠고기'), ['난류(가금류)', '대두', '새우', '쇠고기'].sort());
    assert.deepStrictEqual(names('계란.토마토'), ['난류(가금류)', '토마토'].sort());
    assert.deepStrictEqual(names('대두 밀'), ['대두', '밀'].sort());
    assert.deepStrictEqual(names('쇠고기 조개류(굴)'), ['조개류', '쇠고기'].sort());
    assert.deepStrictEqual(names('대두\n[흑미아몬드강정] 땅콩'), ['대두', '땅콩'].sort());
  });

  await t('★★ 「통밀」의 밀이 사라지지 않는다 (밀크 별칭을 일부러 넣지 않은 이유)', () => {
    assert.ok(names('통밀크래커').includes('밀'), '통밀크래커에서 밀이 사라졌다');
    assert.ok(names('호두\n[통밀크래커] 밀').includes('밀'));
    assert.ok(names('호두\n[통밀크래커] 밀').includes('호두'));
  });

  await t('★ 굴비(생선)를 조개류로 읽지 않는다 (과잉경고도 신뢰를 깎는다)', () => {
    assert.deepStrictEqual(names('굴비'), []);
    assert.deepStrictEqual(names('굴'), ['조개류']);
    assert.deepStrictEqual(names('굴소스'), ['조개류']);
  });

  await t('★ 구체 조개명은 조개류로 올린다 (구체성을 잃되 경고 범위는 넓어진다)', () => {
    for (const n of ['굴', '전복', '홍합', '바지락', '모시조개', '대합', '백합', '가리비', '꼬막', '소라']) {
      assert.deepStrictEqual(names(n), ['조개류'], `${n} 이 조개류로 안 붙는다`);
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  section('§4. 혼입(may_contain) 판정');

  await t('혼입 어휘가 있으면 may_contain', () => {
    assert.deepStrictEqual(normalizeAllergenName('새우 혼입가능'), { name: '새우', level: 'may_contain' });
    assert.strictEqual(normalizeAllergenName('새우를 사용한 제품과 같은 제조시설에서 제조').level, 'may_contain');
    assert.strictEqual(normalizeAllergenName('대두 함유 제품과 같은 시설에서 생산').level, 'may_contain');
    assert.strictEqual(normalizeAllergenName('땅콩 혼입').level, 'may_contain');
    assert.strictEqual(normalizeAllergenName('우유 동일 라인').level, 'may_contain');
  });

  await t('★★ 「함유하고 있습니다」는 may_contain 이 아니다 (강등하면 곧 과소경고)', () => {
    // parseAllergy 가 '함유' 를 지운 실측 조각이다. 여기서 혼입으로 읽으면 직접 함유가 사라진다.
    assert.strictEqual(normalizeAllergenName('굴을 하고 있습니다.').level, null);
    assert.strictEqual(normalizeAllergenName('쇠고기를 하고 있습니다.').level, null);
    assert.strictEqual(normalizeAllergenName('땅콩을 하고 있습니다.').level, null);
    assert.strictEqual(normalizeAllergenName('대두 함유').level, null);
  });

  await t('★ level=null 이면 호출부가 기존 등급을 유지한다', () => {
    const rows = normalizeAllergenRows([{ allergen_name: '밀(성분)', evidence_level: 'inferred' }]);
    assert.strictEqual(rows[0].evidence_level, 'inferred', '기존 등급을 임의로 contains 로 만들었다');
  });

  // ════════════════════════════════════════════════════════════════════════
  section('§5. 중복 병합 — 정규화하면 반드시 중복이 생긴다');

  await t('★★ 계란·난류·난각칼슘(계란) 3행이 난류(가금류) 1행으로 합쳐진다', () => {
    const rows = normalizeAllergenRows([
      { allergen_name: '계란', evidence_level: 'contains', source_count: 2 },
      { allergen_name: '난류', evidence_level: 'contains', source_count: 1 },
      { allergen_name: '난각칼슘(계란)', evidence_level: 'contains', source_count: 1 },
    ]);
    assert.strictEqual(rows.length, 1, JSON.stringify(rows));
    assert.strictEqual(rows[0].allergen_name, '난류(가금류)');
    assert.strictEqual(rows[0].source_count, 4, 'source_count 가 합산되지 않았다');
  });

  await t('★★★ 병합은 강등하지 않는다 (contains + may_contain → contains)', () => {
    const rows = normalizeAllergenRows([
      { allergen_name: '새우 혼입가능', evidence_level: 'contains' },
      { allergen_name: '새우', evidence_level: 'contains' },
    ]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].evidence_level, 'contains',
      '혼입 문장 조각 하나가 직접 함유를 끌어내렸다 — 과소경고');
  });

  await t('★ 정렬(직접 함유 먼저)이 유지된다 — 입력 순서를 뒤집지 않는다', () => {
    const rows = normalizeAllergenRows([
      { allergen_name: '밀(성분)', evidence_level: 'contains' },
      { allergen_name: '조개류(굴)', evidence_level: 'may_contain' },
    ]);
    assert.deepStrictEqual(rows.map((r) => r.allergen_name), ['밀', '조개류']);
  });

  await t('행 shape 을 보존한다 (status·detected_via 를 잃지 않는다)', () => {
    const rows = normalizeAllergenRows([
      { allergen_name: '밀(성분)', evidence_level: 'contains', status: 'confirmed', detected_via: 'haccp_api', source_count: 3 },
    ]);
    assert.strictEqual(rows[0].status, 'confirmed');
    assert.strictEqual(rows[0].detected_via, 'haccp_api');
  });

  await t('rows 가 배열이 아니면 빈 배열 (호출부가 터지지 않게)', () => {
    assert.deepStrictEqual(normalizeAllergenRows(null), []);
    assert.deepStrictEqual(normalizeAllergenRows(undefined), []);
    assert.deepStrictEqual(normalizeAllergenRows('밀'), []);
  });

  // ════════════════════════════════════════════════════════════════════════
  section('§6. ★★ 노출 경로 — collected 가 어떻게 되는가');

  await t('★★★ 이름이 전부 떨어져 나가면 collected=false 다 (「알레르기 없음」이 아니다)', () => {
    // 정규화 필터는 `productModel.getAllergens` 안에 있다. 즉 buildAllergens 는 이미 걸러진 행을 본다.
    // → 전부 떨어지면 rows.length === 0 → collected=false → 응답은 allergens: null (= 정보 없음).
    //   ★ 이것이 이 도메인에서 옳은 방향이다. 「걸러 냈더니 아무것도 안 남았다」를
    //     「알레르기 없음」으로 내보내면 과소경고다 (세션46 §3-7 과 같은 사고).
    const r = buildAllergens([]);
    assert.strictEqual(r.collected, false);
    assert.deepStrictEqual(r.flat, []);
    assert.deepStrictEqual(r.v2, { contains: [], inferred: [], mayContain: [] });
  });

  await t('★ buildAllergens 반환 구조를 바꾸지 않았다 {flat, v2, collected}', () => {
    const r = buildAllergens([{ allergen_name: '밀', evidence_level: 'contains' }]);
    assert.deepStrictEqual(Object.keys(r).sort(), ['collected', 'flat', 'v2']);
    assert.strictEqual(r.collected, true);
  });

  await t('★★ productModel.getAllergens 가 정규화를 통과시킨다 (소스 검증)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'models', 'productModel.js'), 'utf8');
    assert.ok(/require\(['"]\.\.\/services\/allergenName['"]\)/.test(src),
      'productModel 이 allergenName 을 쓰지 않는다 — 오염이 그대로 노출된다');
    const fn = src.match(/async function getAllergens\([\s\S]*?\n}/);
    assert.ok(fn, 'getAllergens 를 찾지 못했다');
    const returns = fn[0].match(/return\s+[^;]+;/g) || [];
    assert.ok(returns.length >= 2, `getAllergens 의 return 이 ${returns.length}개다`);
    for (const r of returns) {
      assert.ok(/normalizeRows\(/.test(r),
        `정규화를 거치지 않는 return 경로가 있다: ${r.trim()}  ← 컬럼 부재 폴백도 같이 걸러야 한다`);
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  section('§7. ★★★ HACCP 출처 승격 — SQL 조립');

  const FULL_COLS = ['id', 'product_id', 'allergen_name', 'source_count', 'status',
    'detected_via', 'created_at', 'updated_at', 'evidence_level'];

  await t('★★★ 운영 스키마에서 DO UPDATE 로 승격한다 (DO NOTHING 이 아니다)', () => {
    const sql = buildAllergenUpsert(FULL_COLS);
    assert.ok(/ON CONFLICT \(product_id, allergen_name\) DO UPDATE SET/.test(sql),
      `승격이 아니라 무시다 — 크라우드 merge 행이 남고 다음 merge 가 지운다:\n${sql}`);
    assert.ok(!/DO NOTHING/.test(sql), `DO NOTHING 으로 되돌아갔다:\n${sql}`);
    assert.ok(/detected_via = 'haccp_api'/.test(sql), 'detected_via 를 승격하지 않는다');
    assert.ok(/updated_at = NOW\(\)/.test(sql), 'updated_at 를 갱신하지 않는다');
  });

  await t('★ evidence_level 은 건드리지 않는다 (HACCP allergy 는 등급을 구분하지 않는다)', () => {
    assert.ok(!/evidence_level/.test(buildAllergenUpsert(FULL_COLS)));
  });

  await t('컬럼 부재 폴백 — updated_at 이 없으면 SET 에서 뺀다', () => {
    const sql = buildAllergenUpsert(['product_id', 'allergen_name', 'detected_via']);
    assert.ok(/DO UPDATE SET/.test(sql));
    assert.ok(!/updated_at/.test(sql), '없는 컬럼을 SET 하면 트랜잭션이 통째로 롤백된다');
  });

  await t('컬럼 부재 폴백 — detected_via 도 updated_at 도 없으면 DO NOTHING (SET 할 게 없다)', () => {
    const sql = buildAllergenUpsert(['product_id', 'allergen_name']);
    assert.ok(/DO NOTHING/.test(sql), sql);
    assert.ok(!/detected_via/.test(sql));
  });

  await t('★★ 19·26 스크립트가 리터럴 DO NOTHING 으로 되돌아가지 않았다 (소스 검증)', () => {
    for (const f of ['19-apply-haccp.js', '26-apply-haccp-dump.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', f), 'utf8');
      assert.ok(/buildAllergenUpsert\(colNames\)/.test(src),
        `${f} 가 buildAllergenUpsert 를 쓰지 않는다`);
      const bad = src.match(/INSERT INTO product_allergens \(product_id, allergen_name[^)]*\)[\s\S]{0,160}?DO NOTHING/g);
      assert.ok(!bad, `${f} 에 allergen_name 리터럴 DO NOTHING 이 남아 있다:\n${bad}`);
    }
  });

  await t('★ 19·26 의 parseAllergy 가 여전히 같은 함수다 (한쪽만 고치면 여기서 걸린다)', () => {
    const a = require('../scripts/19-apply-haccp').parseAllergy;
    const b = require('../scripts/26-apply-haccp-dump').parseAllergy;
    assert.strictEqual(typeof a, 'function');
    assert.strictEqual(a.toString(), b.toString(), '두 스크립트의 parseAllergy 가 갈라졌다');
  });

  await t('★★ parseAllergy 는 여전히 오염을 만든다 (그래서 노출 필터가 필요하다)', () => {
    const { parseAllergy } = require('../scripts/19-apply-haccp');
    // ★ HACCP 덤프에 실재하는 원문이다(scripts/output/haccp_dump.ndjson).
    const raw = '대두, 밀, 쇠고기, 새우, 조개류(굴, 바지락) 함유';
    const got = parseAllergy(raw);
    assert.deepStrictEqual(got, ['대두', '밀', '쇠고기', '새우', '조개류(굴', '바지락)'],
      'parseAllergy 의 동작이 바뀌었다 — 이 회귀 전체의 전제가 달라졌으니 필터 설계를 재검토할 것');
    assert.ok(got.some((x) => !isCanonicalAllergenName(x)), '오염이 없다면 필터 설계를 재검토할 것');
    // 그리고 정규화가 그 오염을 정확히 되돌린다.
    const fixed = [...new Set(got.flatMap((x) => normalizeAllergenNames(x).map((y) => y.name)))].sort();
    assert.deepStrictEqual(fixed, ['대두', '밀', '새우', '조개류', '쇠고기'].sort());
  });

  // ════════════════════════════════════════════════════════════════════════
  section('§8. 백필 계획(76) — UNIQUE 충돌 처리');

  await t('★★ 같은 제품의 계란+난류 → UPDATE 1 · DELETE 1 (UNIQUE 충돌 없이)', () => {
    const plan = buildPlan([
      { id: 1, product_id: 10, allergen_name: '계란', evidence_level: 'contains', source_count: 1 },
      { id: 2, product_id: 10, allergen_name: '난류', evidence_level: 'contains', source_count: 1 },
    ]);
    assert.strictEqual(plan.updates.length, 1, JSON.stringify(plan.updates));
    assert.strictEqual(plan.updates[0].to, '난류(가금류)');
    assert.strictEqual(plan.deletes.length, 1);
    assert.strictEqual(plan.deletes[0].id, 2);
  });

  await t('★ 이미 정본인 행이 있으면 그 행을 대표로 삼는다 (rename 자체를 안 만든다)', () => {
    const plan = buildPlan([
      { id: 1, product_id: 10, allergen_name: '계란', evidence_level: 'contains', source_count: 1 },
      { id: 2, product_id: 10, allergen_name: '난류(가금류)', evidence_level: 'contains', source_count: 1 },
    ]);
    assert.strictEqual(plan.updates[0].id, 2, '이름을 바꿔야 하는 행을 대표로 골랐다');
    assert.deepStrictEqual(plan.deletes.map((d) => d.id), [1]);
  });

  await t('★★★ 정규화 불가는 삭제하지 않는다 (사용자가 결정한다)', () => {
    const plan = buildPlan([
      { id: 1, product_id: 10, allergen_name: '평양물냉면', evidence_level: 'contains', source_count: 1 },
      { id: 2, product_id: 10, allergen_name: '밀(성분)', evidence_level: 'contains', source_count: 1 },
    ]);
    assert.strictEqual(plan.unresolved.length, 1);
    assert.strictEqual(plan.unresolved[0].name, '평양물냉면');
    assert.ok(!plan.deletes.some((d) => d.id === 1), '정규화 불가 행을 지우려 했다');
  });

  await t('★★ 한 행이 2종으로 갈라지면 나머지는 INSERT 로 살린다 (알레르겐 손실 금지)', () => {
    const plan = buildPlan([
      { id: 1, product_id: 10, allergen_name: '대두 밀', evidence_level: 'contains', source_count: 1 },
    ]);
    assert.strictEqual(plan.updates.length, 1);
    assert.strictEqual(plan.inserts.length, 1);
    const covered = new Set([...plan.updates.map((u) => u.to), ...plan.inserts.map((i) => i.name)]);
    assert.deepStrictEqual([...covered].sort(), ['대두', '밀']);
    assert.strictEqual(plan.deletes.length, 0, '대표로 쓰는 행을 지우려 했다');
  });

  await t('손댈 필요 없는 정본 행은 UPDATE 목록에 넣지 않는다', () => {
    const plan = buildPlan([
      { id: 1, product_id: 10, allergen_name: '밀', evidence_level: 'contains', source_count: 1 },
    ]);
    assert.strictEqual(plan.updates.length, 0, JSON.stringify(plan.updates));
    assert.strictEqual(plan.stats.untouched, 1);
  });

  await t('★ 혼입 문장은 may_contain 으로 백필된다', () => {
    const plan = buildPlan([
      { id: 1, product_id: 10, allergen_name: '새우 혼입가능', evidence_level: 'contains', source_count: 1 },
    ]);
    assert.strictEqual(plan.updates[0].to, '새우');
    assert.strictEqual(plan.updates[0].toLevel, 'may_contain');
  });

  // ════════════════════════════════════════════════════════════════════════
  section('§9. ★★★ 진짜 Postgres(pglite) — 실 경로');

  if (process.env.SKIP_PGLITE === '1') {
    console.log('  ⏭  SKIP_PGLITE=1 — DB 절 생략');
  } else {
    let PGlite = null;
    try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) {
      console.log('  ⏭  pglite 미설치 — SQL 실행 검증 생략 (npm i -D @electric-sql/pglite)');
    }

    if (PGlite) {
      // ⚠ 인스턴스 하나를 공유한다(부팅 20~30초). 테스트끼리는 product_id 로 격리한다.
      const MIGRATION_DIR = path.join(__dirname, '..', 'scripts', 'migrations');
      const SCHEMA_MIGRATIONS = ['001_init_schema.sql', '004_add_disputed.sql',
        '005_crowdsource_merge.sql', '006_align_schema_with_production.sql',
        '020_allergen_evidence_level.sql'];
      const sanitize = (sql) => sql
        .replace(/^\s*CREATE\s+EXTENSION[^;]*;/gim, '')
        .replace(/^\s*CREATE\s+INDEX[^;]*gin_trgm_ops[^;]*;/gim, '')
        .replace(/uuid_generate_v4\(\)/gi, 'gen_random_uuid()');

      const db = new PGlite();
      for (const f of SCHEMA_MIGRATIONS) {
        await db.exec(sanitize(fs.readFileSync(path.join(MIGRATION_DIR, f), 'utf8')));
      }
      // 운영에만 있고 마이그레이션에 없는 것 (세션46 §5 — mergeService 의 ON CONFLICT 타깃)
      await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS nutrition_data_product_id_key ON nutrition_data(product_id);');

      const TEST_USER_ID = '00000000-0000-4000-8000-000000000001';
      await db.exec(`
        INSERT INTO products (product_name, data_source) VALUES ('오염정규화테스트', 'manual_seed');
        INSERT INTO products (product_name, data_source) VALUES ('출처승격테스트', 'manual_seed');
        INSERT INTO users (user_id, nickname) VALUES ('${TEST_USER_ID}', '테스트기여자');
      `);

      const shim = {
        pool: null,
        query: (text, params) => db.query(text, params || []),
        transaction: async (cb) => {
          await db.exec('BEGIN');
          try {
            const r = await cb({ query: (t2, p) => db.query(t2, p || []) });
            await db.exec('COMMIT');
            return r;
          } catch (e) { await db.exec('ROLLBACK'); throw e; }
        },
        healthCheck: async () => ({ status: 'healthy' }),
      };
      const dbPath = require.resolve('../src/config/database');
      const savedDb = require.cache[dbPath];
      require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };
      for (const p of ['../src/services/mergeService', '../src/models/productModel',
        '../src/services/productService']) delete require.cache[require.resolve(p)];
      const merge = require('../src/services/mergeService');
      const model = require('../src/models/productModel');
      model._resetEvidenceLevelCache();

      try {
        // ── (a) 오염 이름이 응답 경로에서 사라진다 ──
        await t('★★★ 실 DB — 오염 이름이 조회 경로에서 정본으로 바뀐다', async () => {
          for (const [n, lvl] of [['밀(성분)', 'contains'], ['대두', 'contains'],
            ['조개류(굴)', 'contains'], ['계란', 'contains'], ['난류', 'contains'],
            ['평양물냉면', 'contains']]) {
            await db.query(
              `INSERT INTO product_allergens (product_id, allergen_name, detected_via, evidence_level)
               VALUES (1, $1, 'haccp_api', $2)`, [n, lvl],
            );
          }
          const rows = await model.getAllergens(1);
          const got = rows.map((r) => r.allergen_name).sort();
          assert.deepStrictEqual(got, ['난류(가금류)', '대두', '밀', '조개류'].sort(),
            `실제로 나온 것: ${JSON.stringify(got)}`);
          assert.ok(!got.includes('밀(성분)'), '「밀(성분)」이 그대로 나갔다 — 운영에서 본 그 값이다');
          assert.ok(!got.includes('평양물냉면'), '19종 아닌 이름이 나갔다');
          assert.strictEqual(new Set(got).size, got.length, '중복 병합이 안 됐다 — 화면에 같은 이름이 두 번 나온다');
        });

        // ── (b) 3차 검증 중대2 — 출처 승격 시나리오 ──
        await t('★★★ 크라우드 merge → HACCP 재적재 → 알레르겐 0건 merge 후에도 행이 남는다', async () => {
          const PID = 2;
          // ① 사용자 1명이 알레르기 사진을 올려 merge → detected_via='crowdsource_merge' 행이 생긴다
          await db.query(
            `INSERT INTO contributions (user_id, product_id, contribution_type, device_id, data)
             VALUES ($1, $2, 'ocr_nutrition', 'dev-A', $3)`,
            [TEST_USER_ID, PID, JSON.stringify({
              parsed_nutrition: {}, parsed_ingredients: [],
              allergens: ['대두', '밀', '우유', '새우', '메밀', '땅콩', '게'],
              allergens_v2: { contains: ['대두', '밀', '우유', '새우', '메밀', '땅콩', '게'], inferred: [], mayContain: [] },
              user_input: {}, device_id: 'dev-A', avg_confidence: 0.9,
            })],
          );
          await merge.mergeAndApply(PID);
          const after1 = await db.query('SELECT allergen_name, detected_via FROM product_allergens WHERE product_id=$1', [PID]);
          const N = after1.rows.length;
          assert.ok(N > 0, 'merge1 이 알레르기를 한 행도 적재하지 못했다 — 시나리오 전제가 깨졌다');
          assert.ok(after1.rows.every((r) => r.detected_via === 'crowdsource_merge'),
            `merge1 행의 detected_via 가 crowdsource_merge 가 아니다: ${JSON.stringify(after1.rows)}`);

          // ② HACCP 재적재 — 같은 이름이 이미 있다. 승격되는가?
          const { rows: cols } = await db.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name='product_allergens'`);
          const colNames = cols.map((c) => c.column_name);
          const upsert = buildAllergenUpsert(colNames);
          for (const n of ['대두', '밀', '우유', '새우', '메밀', '땅콩', '게']) {
            await db.query(upsert, [PID, n]);
          }
          const after2 = await db.query(
            `SELECT count(*)::int c FROM product_allergens WHERE product_id=$1 AND detected_via='haccp_api'`, [PID]);
          assert.strictEqual(after2.rows[0].c, N,
            `HACCP 가 승격하지 못했다 (haccp_api ${after2.rows[0].c}/${N}) — ON CONFLICT DO NOTHING 으로 되돌아갔는가?`);

          // ③ 다른 기기에서 「알레르기 없음」 사진 → merge2. crowdsource_merge 행을 지운다.
          await db.query(
            `INSERT INTO contributions (user_id, product_id, contribution_type, device_id, data)
             VALUES ($1, $2, 'ocr_nutrition', 'dev-B', $3)`,
            [TEST_USER_ID, PID, JSON.stringify({
              parsed_nutrition: {}, parsed_ingredients: [],
              allergens: [], allergens_v2: { contains: [], inferred: [], mayContain: [] },
              user_input: {}, device_id: 'dev-B', avg_confidence: 0.9,
            })],
          );
          await merge.mergeAndApply(PID);
          const after3 = await db.query('SELECT allergen_name FROM product_allergens WHERE product_id=$1', [PID]);
          assert.strictEqual(after3.rows.length, N,
            `식약처 확인 알레르겐이 ${N - after3.rows.length}개 삭제됐다 (${N}행 → ${after3.rows.length}행) — 경고 소실`);
        });

        // ── (c) 백필 76 — 실 DB 에서 UNIQUE 충돌 없이 적용된다 ──
        await t('★★ 백필 계획이 실 DB 에서 UNIQUE 충돌 없이 반영된다', async () => {
          const { rows } = await db.query(
            `SELECT id, product_id, allergen_name, evidence_level, source_count, status, detected_via
               FROM product_allergens WHERE product_id = 1 ORDER BY id`);
          const plan = buildPlan(rows);
          for (const d of plan.deletes) await db.query('DELETE FROM product_allergens WHERE id=$1', [d.id]);
          for (const u of plan.updates) {
            await db.query(
              `UPDATE product_allergens SET allergen_name=$2, evidence_level=$3, source_count=$4, updated_at=NOW() WHERE id=$1`,
              [u.id, u.to, u.toLevel, u.sourceCount]);
          }
          const after = await db.query(
            'SELECT allergen_name, evidence_level FROM product_allergens WHERE product_id=1');
          const got = after.rows.map((r) => r.allergen_name).sort();
          assert.deepStrictEqual(got, ['난류(가금류)', '대두', '밀', '조개류', '평양물냉면'].sort(),
            `백필 후: ${JSON.stringify(got)}`);
          // ★ 정규화 불가 「평양물냉면」이 **살아 있다.** 지우는 것은 사용자 결정이다.
          assert.ok(got.includes('평양물냉면'), '정규화 불가 행을 백필이 지웠다');
        });
      } finally {
        if (savedDb) require.cache[dbPath] = savedDb; else delete require.cache[dbPath];
        for (const p of ['../src/services/mergeService', '../src/models/productModel',
          '../src/services/productService']) delete require.cache[require.resolve(p)];
        await db.close();
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`📊 세션47 알레르겐 이름 정규화 + 출처 승격: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})`);
  if (fail > 0) {
    console.log('\n실패 상세:');
    for (const f of failures) console.log(`  - ${f.name}\n    ${f.message}`);
    process.exit(1);
  }
  console.log('✅ 전체 통과');
}

main().catch((e) => { console.error('예상 못 한 예외:', e); process.exit(1); });
