/**
 * test_allergen_ingredient_no_infer.js — 세션66 계약 C7 (`DS-6′`) 알레르겐 원칙 회귀
 * ============================================================================
 * 무엇을 지키는가 — **한 문장이다.**
 *
 *   ★★★ 「알레르겐은 원재료명으로 «판단하지 않는다».
 *          식품표시사항에 기반한 제조사 표기만 반영한다.」  (제이 확정 2026-08-30 · `DS-6′`)
 *
 * 왜 이 파일이 필요한가 (`IP/설계_제보데이터분리_2026-08-28_세션65.md` §11-A)
 *   원재료 추론 경로는 세션58 이 이미 끊었다. 즉 **오늘 이 테스트는 「지금 0인 것」을 잰다.**
 *   그런데 §0-B 가 적은 진짜 위험은 「커버리지가 낮으니 원재료명에서도 뽑자」고
 *   누군가 되살리는 것이고, 그것을 막는 것은 «축 제거»가 아니라 **회귀 + 명문화**다.
 *   ⇒ 이 파일의 값어치는 「지금 초록」이 아니라 **「되살리면 빨강」**에 있다.
 *
 * ⚠⚠ 이 테스트가 «전부 0을 내는 파서»를 통과시키면 안 된다.
 *   그래서 §2·§4 **반대 케이스**가 같은 무게로 들어 있다 —
 *   「제조사 표시란이 있으면 정상적으로 잡힌다」를 19종 전수로 단정한다.
 *   §1 만 있고 §2 가 없으면 `detectAllergens*` 를 `return []` 으로 만들어도 초록이다.
 *
 * ── 구성 ──────────────────────────────────────────────────────────────────
 *   §1 원재료명 세그먼트에만 있는 알레르겐 이름은
 *      `contains` · `mayContain` · `inferred` **어느 축으로도** 나오지 않는다 (flat 도 0)
 *   §2 ★ 반대 케이스 — 법정 표시란이 있으면 **19종 전수**가 정상적으로 잡힌다
 *   §3 ★★ 섞인 라벨 — 표시란에 «있는» 것만 나오고, 원재료명에만 있는 것은 «안» 나온다
 *      (§1+§2 를 동시에 통과하는 파서만 살아남는다. 이것이 이 파일의 핵심 단정이다)
 *   §4 ★ 혼입 문구는 여전히 `mayContain` 으로 잡힌다 (`DS-6′` 이 혼입 축을 죽이지 않았다)
 *   §5 데이터 주도 — 「원재료 형태 전용」 토큰 전수(`ALLERGEN_KEYWORDS` − `ALLERGEN_NAMES`)를
 *      원재료명에 넣어도 어느 축에도 안 나온다. **목록을 테스트에 손으로 박지 않는다.**
 *   §6 `inferred` «필드»는 계약이므로 **살아 있다** (§11-A: 지우면 과소경고·거짓 확정)
 *   §7 통합 경로(`analyzeText` → `reconcileAllergens`)에서도 원재료명이 새어 들어오지 않는다
 *
 * ⛔ 소스 문자열을 정규식으로 읽어 단정하지 않는다. **실제 파서를 호출**한다.
 *
 * 실행: cross-env NODE_ENV=test node tests/test_allergen_ingredient_no_infer.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRV = path.join(__dirname, '..');
const GATE = path.join(SRV, '.github', 'workflows', 'gate.yml');

const {
  detectAllergens,
  detectAllergensV2,
  reconcileAllergens,
  analyzeText,
  ALLERGEN_KEYWORDS,
  ALLERGEN_NAMES,
  _classifySegment,
  _splitSegments,
} = require('../src/services/ocrParser');

let pass = 0;
let fail = 0;
const failures = [];

async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, message: e.stack || e.message });
    console.log(`  ❌ ${name}\n     → ${e.message}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

/** 세 축 + flat 을 한 덩어리로. 「어느 축으로도」를 한 번에 묻기 위한 것이다. */
function allAxes(text) {
  const v2 = detectAllergensV2(text);
  const flat = detectAllergens(text);
  return {
    contains: v2.contains,
    mayContain: v2.mayContain,
    inferred: v2.inferred,
    flat,
    declarationFound: v2.declarationFound,
    union: [...new Set([...v2.contains, ...v2.mayContain, ...v2.inferred, ...flat])].sort(),
  };
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(' 세션66 C7 — `DS-6′` 「알레르겐을 원재료명으로 판단하지 않는다」');
  console.log('════════════════════════════════════════════════════════════════');

  // ══════════════════════════════════════════════════════════════════════════
  section('§0  배선 자기검사 (문법 검사 목록)');
  // ══════════════════════════════════════════════════════════════════════════
  // ⚠ 이 파일은 마이그레이션을 쓰지 않으므로 `migrate` 체인 검사는 해당이 없다.
  //   대신 gate.yml 「문법 검사」 목록 누락만 본다 —
  //   `node scripts/gate-local.js` 는 그 스텝을 «스킵»하므로 로컬에서 절대 안 잡힌다.
  //   ⚠ 이것을 **실패로 만들지 않는다**: 공유 파일(`gate.yml`)은 계약 §7-B 상
  //     에이전트가 아니라 메인이 한 번에 반영한다. 반영 전에 빨강이면 신호가 아니라 잡음이다.
  try {
    const gate = fs.readFileSync(GATE, 'utf8');
    if (gate.includes('tests/test_allergen_ingredient_no_infer.js')) {
      console.log('  ✅ gate.yml 문법 검사 목록에 등록돼 있다');
    } else {
      console.log('  ⚠  gate.yml 문법 검사 목록에 **아직 없다** — 메인이 §7-B 로 반영해야 한다.');
      console.log('     넣을 줄: `            tests/test_allergen_ingredient_no_infer.js \\`');
    }
  } catch (_) {
    console.log('  ⚠  gate.yml 을 읽지 못했다 (배선 확인 생략)');
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('§1  원재료명에만 있는 이름 → 어느 축으로도 안 나온다');
  // ══════════════════════════════════════════════════════════════════════════

  await t('§1-1 계약 예시 — `원재료명: 밀가루, 탈지분유, 대두유` 는 세 축 모두 0', () => {
    const r = allAxes('원재료명: 밀가루, 탈지분유, 대두유');
    assert.deepStrictEqual(r.contains, [], `contains 가 비지 않았다: ${JSON.stringify(r.contains)}`);
    assert.deepStrictEqual(r.mayContain, [], `mayContain 이 비지 않았다: ${JSON.stringify(r.mayContain)}`);
    assert.deepStrictEqual(r.inferred, [], `inferred 가 비지 않았다: ${JSON.stringify(r.inferred)} — 원재료 추론이 되살아났다`);
    assert.deepStrictEqual(r.flat, [], `flat 이 비지 않았다: ${JSON.stringify(r.flat)}`);
  });

  await t('§1-2 원산지 괄호 표기(`밀:미국산`)도 «직접 함유»로 승격되지 않는다', () => {
    // ⚠ 이것이 입구 가드(`kind === 'ingredients'` continue)를 지웠을 때 가장 먼저 터지는 형태다.
    //   원재료명 안의 `밀`·`대두` 는 **구분자 경계**가 성립해 법정명 매칭에 그대로 걸린다.
    const r = allAxes('원재료명: 밀가루(밀:미국산), 탈지분유(우유), 대두유(대두:수입산), 정제소금');
    assert.deepStrictEqual(r.union, [],
      `원재료명 괄호 표기가 알레르겐으로 새어 나왔다: ${JSON.stringify(r.union)}`);
  });

  await t('§1-3 「확인 못 했다」로 나간다 — 「없다」로 단정하지 않는다', () => {
    // ★ 이 단정이 §1 을 「과소경고 만들기」와 갈라놓는다.
    //   원재료명만 있는 라벨은 선언란을 «못 본» 것이지 「알레르겐이 없는」 것이 아니다.
    const v2 = detectAllergensV2('원재료명: 밀가루, 탈지분유, 대두유');
    assert.strictEqual(v2.declarationFound, false,
      'declarationFound 가 true 다 — 원재료명 줄을 선언란으로 오인하고 있다');
  });

  await t('§1-4 원재료명 줄은 실제로 `ingredients` 로 분류된다 (전제 확인)', () => {
    // 전제가 깨지면 §1 이 「우연히」 통과한다. 그 우연을 여기서 못 박는다.
    const segs = _splitSegments('원재료명: 밀가루, 탈지분유, 대두유');
    assert.ok(segs.length >= 1, '세그먼트가 0개다');
    assert.strictEqual(_classifySegment(segs[0]), 'ingredients',
      `원재료명 줄의 분류가 'ingredients' 가 아니다: ${_classifySegment(segs[0])}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§2  ★ 반대 케이스 — 제조사 표시란이 있으면 잡힌다');
  // ══════════════════════════════════════════════════════════════════════════

  await t('§2-1 `알레르기 유발물질: 밀, 우유, 대두 함유` → contains 3종', () => {
    const r = allAxes('원재료명: 정제수, 정제소금\n알레르기 유발물질: 밀, 우유, 대두 함유');
    assert.deepStrictEqual(r.contains, ['대두', '밀', '우유'],
      `contains 가 다르다: ${JSON.stringify(r.contains)}`);
    assert.deepStrictEqual(r.flat, ['대두', '밀', '우유'],
      `flat 이 다르다: ${JSON.stringify(r.flat)}`);
    assert.strictEqual(r.declarationFound, true, 'declarationFound 가 false 다');
  });

  await t('§2-2 ★★ 법정 19종 «전수» — 표시란에 인쇄되면 전부 잡힌다', () => {
    // ⚠ 종 목록을 테스트에 손으로 박지 않는다 — 박으면 표가 바뀌어도 계약이 모른다.
    //   `ALLERGEN_NAMES` 는 「법정 표시란에 인쇄되는 이름」 표다. 그 키가 곧 사용자에게 나가는 이름.
    const names = Object.keys(ALLERGEN_NAMES);
    assert.ok(names.length >= 19, `ALLERGEN_NAMES 가 ${names.length}종뿐이다 (법정 19종 미만)`);
    const missed = [];
    for (const canonical of names) {
      const printed = ALLERGEN_NAMES[canonical][0];   // 라벨에 인쇄되는 대표 표기
      const r = allAxes(`원재료명: 정제수, 정제소금\n알레르기 유발물질: ${printed} 함유`);
      if (!r.contains.includes(canonical) || !r.flat.includes(canonical)) {
        missed.push(`${canonical}(인쇄:${printed}) → contains=${JSON.stringify(r.contains)} flat=${JSON.stringify(r.flat)}`);
      }
    }
    assert.strictEqual(missed.length, 0,
      `표시란에 인쇄됐는데 못 잡은 종이 있다 — 「전부 0을 내는 파서」다:\n     ${missed.join('\n     ')}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§3  ★★ 섞인 라벨 — 표시란에 있는 것«만»');
  // ══════════════════════════════════════════════════════════════════════════

  await t('§3-1 원재료명엔 우유·대두·새우가 있고 표시란엔 밀만 → 밀 하나만 나온다', () => {
    // ★ 이 한 건이 §1(전부 0)과 §2(전부 검출) 양쪽 실패 모드를 동시에 죽인다.
    //   · 「전부 0을 내는 파서」 → 밀이 없어서 실패
    //   · 「원재료명에서 도출하는 파서」 → 우유·대두·새우가 나와서 실패
    const r = allAxes(
      '원재료명: 밀가루, 탈지분유, 대두유, 새우분말, 정제소금\n'
      + '알레르기 유발물질: 밀 함유'
    );
    assert.deepStrictEqual(r.contains, ['밀'], `contains 가 다르다: ${JSON.stringify(r.contains)}`);
    assert.deepStrictEqual(r.mayContain, [], `mayContain 이 비지 않았다: ${JSON.stringify(r.mayContain)}`);
    assert.deepStrictEqual(r.inferred, [], `inferred 가 비지 않았다: ${JSON.stringify(r.inferred)}`);
    assert.deepStrictEqual(r.union, ['밀'],
      `표시란에 없는 이름이 새어 나왔다: ${JSON.stringify(r.union)}`);
  });

  await t('§3-2 표시란이 「해당 없음」이어도 원재료명이 그것을 뒤집지 못한다', () => {
    const r = allAxes(
      '원재료명: 밀가루, 탈지분유, 대두유\n'
      + '알레르기 유발물질: 해당 없음'
    );
    assert.deepStrictEqual(r.union, [],
      `제조사가 「없다」고 적었는데 서버가 원재료명으로 뒤집었다: ${JSON.stringify(r.union)}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§4  ★ 혼입 축은 살아 있다 (`DS-6′` 이 죽인 것이 아니다)');
  // ══════════════════════════════════════════════════════════════════════════

  await t('§4-1 같은 제조시설 문구 → mayContain 으로 잡힌다', () => {
    const r = allAxes(
      '원재료명: 밀가루, 정제소금\n'
      + '알레르기 유발물질: 밀 함유\n'
      + '이 제품은 새우, 게를 사용한 제품과 같은 제조시설에서 제조하고 있습니다.'
    );
    assert.deepStrictEqual(r.contains, ['밀'], `contains 가 다르다: ${JSON.stringify(r.contains)}`);
    assert.deepStrictEqual(r.mayContain, ['게', '새우'],
      `mayContain 이 다르다: ${JSON.stringify(r.mayContain)}`);
    // ⚠ 혼입은 flat 에 들어가지 않는다 (서버 계약 — `tests/test_allergen_contract.js`)
    assert.deepStrictEqual(r.flat, ['밀'], `flat 에 혼입이 섞였다: ${JSON.stringify(r.flat)}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§5  데이터 주도 — 「원재료 형태 전용」 토큰 전수');
  // ══════════════════════════════════════════════════════════════════════════

  await t('§5-1 `ALLERGEN_KEYWORDS` − `ALLERGEN_NAMES` 토큰 전수가 어느 축에도 안 나온다', () => {
    // ★ 왜 데이터 주도인가 — 목록을 손으로 박으면 표에 항목이 추가될 때 계약이 «모른다».
    //   `ALLERGEN_KEYWORDS` 는 「원재료 형태」 표(`밀가루`·`탈지분유`·`카제인`…)이고,
    //   `DS-6′` 이후 **알레르겐 판정의 근거가 아니다**(`ocrParser.js` 절 머리말 참조).
    //   여기서는 그 표에만 있고 법정 표시명에는 «없는» 토큰만 골라 원재료명에 넣는다.
    const nameTokens = new Set();
    for (const [canonical, aliases] of Object.entries(ALLERGEN_NAMES)) {
      nameTokens.add(canonical);
      for (const a of aliases) nameTokens.add(a);
    }
    const ingredientOnly = [];
    for (const [canonical, aliases] of Object.entries(ALLERGEN_KEYWORDS)) {
      for (const a of aliases) if (!nameTokens.has(a)) ingredientOnly.push([canonical, a]);
    }
    assert.ok(ingredientOnly.length >= 30,
      `「원재료 형태 전용」 토큰이 ${ingredientOnly.length}개뿐이다 — 표가 비었거나 축이 바뀌었다`);

    const leaks = [];
    for (const [canonical, token] of ingredientOnly) {
      const r = allAxes(`원재료명: 정제수, ${token}, 정제소금`);
      if (r.union.length) leaks.push(`${token}(→${canonical}) → ${JSON.stringify(r.union)}`);
    }
    assert.strictEqual(leaks.length, 0,
      `원재료 형태 토큰이 알레르겐으로 새어 나왔다 (${leaks.length}/${ingredientOnly.length}):\n     ${leaks.join('\n     ')}`);
    console.log(`     (검사한 원재료 형태 전용 토큰 ${ingredientOnly.length}종 · 누출 0)`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§6  `inferred` «필드»는 살아 있다 (지우면 과소경고·거짓 확정)');
  // ══════════════════════════════════════════════════════════════════════════

  await t('§6-1 응답 계약 — 세 축이 «전부» 배열로 존재한다', () => {
    // ⚠ §11-A: `inferred` 를 «필드»째 지우면
    //   ① 사용자가 직접 입력한 알레르겐이 flat 에서 소실(과소경고)
    //   ② 운영 DB `evidence_level='inferred'` 행이 `contains` 로 승격(거짓 확정)
    //   ⇒ 이 테스트는 「원재료 추론 금지」를 「필드 제거」로 오해한 변경을 **빨강으로 잡는다.**
    const v2 = detectAllergensV2('원재료명: 정제수\n알레르기 유발물질: 밀 함유');
    for (const k of ['contains', 'mayContain', 'inferred', 'evidence']) {
      assert.ok(Array.isArray(v2[k]), `\`${k}\` 가 배열이 아니다 (응답 계약 위반): ${typeof v2[k]}`);
    }
    assert.strictEqual(typeof v2.declarationFound, 'boolean', '`declarationFound` 가 boolean 이 아니다');
  });

  await t('§6-2 `reconcileAllergens` 는 flat 전용 이름을 여전히 `inferred` 로 살린다', () => {
    // 세션44 치명3 방어. **이 경로는 원재료명 추론이 아니다** — 「등급을 모르는 것」이다.
    const v2 = detectAllergensV2('원재료명: 정제수\n알레르기 유발물질: 밀 함유');
    const out = reconcileAllergens(['밀', '땅콩'], v2);
    assert.ok(out.contains.includes('밀'), 'contains 에서 밀이 사라졌다');
    assert.ok(out.inferred.includes('땅콩'),
      `flat 에만 있던 이름이 소실됐다 — 세션44 치명3 재발: ${JSON.stringify(out)}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§7  통합 경로(`analyzeText` + reconcile)에서도 새지 않는다');
  // ══════════════════════════════════════════════════════════════════════════

  await t('§7-1 `analyzeText` — 원재료명만 있는 라벨은 알레르겐 0', () => {
    const a = analyzeText('제품명: 시험용과자\n원재료명: 밀가루, 탈지분유, 대두유, 새우분말\n내용량: 100g');
    assert.deepStrictEqual(a.allergens, [], `flat 이 비지 않았다: ${JSON.stringify(a.allergens)}`);
    assert.deepStrictEqual(a.allergens_v2.contains, [], `contains: ${JSON.stringify(a.allergens_v2.contains)}`);
    assert.deepStrictEqual(a.allergens_v2.mayContain, [], `mayContain: ${JSON.stringify(a.allergens_v2.mayContain)}`);
    assert.deepStrictEqual(a.allergens_v2.inferred, [], `inferred: ${JSON.stringify(a.allergens_v2.inferred)}`);
    // ⚠ 원재료 «목록» 자체는 그대로 파싱돼야 한다 — 알레르겐만 안 만드는 것이지 원재료를 버리는 게 아니다.
    assert.ok(a.ingredient_count > 0, '원재료 파싱까지 죽었다 — 이 변경의 범위가 아니다');
  });

  await t('§7-2 `analyzeText` + `reconcileAllergens` — 표시란이 있으면 그것만 나온다', () => {
    const a = analyzeText(
      '제품명: 시험용과자\n원재료명: 밀가루, 탈지분유, 대두유, 새우분말\n알레르기 유발물질: 밀 함유'
    );
    const out = reconcileAllergens(a.allergens, a.allergens_v2);
    const union = [...new Set([...out.contains, ...out.mayContain, ...out.inferred])].sort();
    assert.deepStrictEqual(union, ['밀'],
      `통합 경로에서 원재료명이 새어 들어왔다: ${JSON.stringify(union)}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(` 통과 ${pass} · 실패 ${fail}`);
  if (fail) {
    console.log('\n실패 상세:');
    for (const f of failures) console.log(`\n[${f.name}]\n${f.message}`);
  }
  console.log('════════════════════════════════════════════════════════════════\n');
  process.exit(fail > 0 ? 1 : 0);
}

main();
