/**
 * test_additive_union_save.js — 세션65 C1 (`U64-3`) 「합집합 저장」 회귀
 * ============================================================================
 * 배경 — 실측 (`.tmp/s65/U64-3_재측정_판정.md` · 라벨 67건 · 파싱 실패 0건)
 *   축 A(제보 직후 화면에 보인 첨가물) 189  vs  축 B(DB 에 저장) 150
 *     ├ 교집합                 64
 *     ├ ★ A에만 = 「봤는데 사라짐」  125 (66.1%)
 *     └ B에만                  86
 *   사라진 이름 47종 중 **37종(78.7%)이 마스터에 이미 있었다.**
 *   원인은 별칭 사전이 아니라 **저장 경로가 `identifyAdditives` 결과를 안 쓴다**는 구조 결함.
 *
 * 무엇을 지키는가 (계약 `.tmp/s65/계약_세션65.md` C1)
 *   §1 축 A 에만 있는 첨가물이 **저장된다** (= 66.1% 소실의 본체)
 *   §2 축 B(원재료명 완전일치)는 **그대로 저장된다** (회귀 없음)
 *   §3 `detected_name` 이 **라벨 원문**이다 — 마스터 이름(`name_ko`)이 아니다
 *   §4 축 B 원문은 이름 그 자체다 (두 축이 겹치면 «더 좁은» 원문이 이긴다)
 *   §5 마스터에 없는 검출은 저장되지 않는다 (`∩ additives 마스터`)
 *   §6 `analysis.additives` 가 **없어도** 기존 동작이 안 깨진다
 *   §7 `analysis.additives` 가 **비어 있어도** 기존 동작이 안 깨진다
 *   §8 `ON CONFLICT DO NOTHING` 유지 — 재제보가 행을 늘리지도, 원문을 덮지도 않는다
 *   §9 ★ 경로 ②(`mergeService.mergeAndApply`)도 **같은 합집합**으로 저장한다
 *      (계약 C1: 「한쪽만 고치면 경로 간 결과가 갈린다」)
 *   §10 두 경로가 **같은 규칙 본문**을 쓴다 — 리졸버를 직접 호출해 동치를 본다
 *
 * ★ 이 파일은 **소스 문자열을 한 글자도 읽지 않는다.**
 *   pglite(진짜 Postgres/wasm)에 `000_baseline.sql` + `022` 를 적용하고,
 *   정본 서비스를 실제로 호출해 **DB 에 실제로 박힌 행**만 단정한다.
 *   (세션48 4차 검증: 소스 정규식 검사는 본문 오염으로 뚫렸고 12개 파일이 거짓 초록이었다.)
 *
 * ★★ Google Vision 을 부르지 않는다.
 *
 * 실행: cross-env NODE_ENV=test node tests/test_additive_union_save.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRV = path.join(__dirname, '..');
const BASELINE = path.join(SRV, 'scripts', 'migrations', '000_baseline.sql');
const M022 = path.join(SRV, 'scripts', 'migrations', '022_additive_detected_count.sql');
// ★★ 세션66 C6 — 제보는 이제 `product_additives` 에 «즉시» 쓰지 않는다(설계 §3-2).
//   저장집합 규칙(합집합·라벨 원문·ON CONFLICT)은 **한 글자도 안 바뀌었고**,
//   그 규칙이 도는 «시점»만 「제보 즉시」에서 「관리자 승인」으로 옮겨졌다.
//   ⇒ 이 회귀는 그 규칙을 계속 재려고 **승인 단계를 픽스처에 넣는다.**
//     023(data_inspection) · 024(contribution_review) 가 그래서 필요하다.
const M023 = path.join(SRV, 'scripts', 'migrations', '023_data_inspection.sql');
const M024 = path.join(SRV, 'scripts', 'migrations', '024_contribution_review.sql');

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

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(' 세션65 C1 — 첨가물 «합집합» 저장 (U64-3 · 실측 소실 66.1%)');
  console.log('════════════════════════════════════════════════════════════════');

  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (_) {
    console.log('⏭  pglite 미설치 — 저장 경로를 검증할 수 없다 (npm i -D @electric-sql/pglite)');
    console.log('   ★ 이 테스트의 목적상 「건너뜀」은 「통과」가 아니다. EXIT=1 로 남긴다.');
    process.exit(1);
  }

  const db = new PGlite();
  try {
    await db.exec(fs.readFileSync(BASELINE, 'utf8'));
    await db.exec(fs.readFileSync(M022, 'utf8'));
    await db.exec(fs.readFileSync(M023, 'utf8'));
    await db.exec(fs.readFileSync(M024, 'utf8'));
  } catch (e) {
    console.error(`마이그레이션 적용 실패 — 픽스처가 아니라 정본 SQL 문제다: ${e.message}`);
    process.exit(1);
  }

  const shim = {
    pool: null,
    query: (text, params) => db.query(text, params || []),
    transaction: async (cb) => {
      await db.exec('BEGIN');
      try {
        const r = await cb({ query: (tx, p) => db.query(tx, p || []) });
        await db.exec('COMMIT');
        return r;
      } catch (e) { await db.exec('ROLLBACK'); throw e; }
    },
    healthCheck: async () => ({ status: 'healthy' }),
  };
  const dbPath = require.resolve('../src/config/database');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };

  const loggerPath = require.resolve('../src/config/logger');
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };

  const crowdsource = require('../src/services/crowdsourceService');
  const { mergeAndApply } = require('../src/services/mergeService');
  const resolver = require('../src/services/additiveResolver');
  const { applyApprovedContribution } = require('../src/services/contributionApply');

  /**
   * ★ 관리자 승인 1건을 흉내낸다 — 「제보 → (사람) → 공식 테이블」의 가운데 단계.
   *   ⚠ `reviewed_by` 를 채우는 것이 곧 `cr_approve_human_chk`(DS-1) 를 만족시키는 일이다.
   *     코드가 스스로 채우면 안 되는 값이라 **테스트가 사람 대신 채운다.**
   */
  const approveAxis = async (productId, axis) => {
    // 축당 approved 는 최대 1건(`uq_cr_approved_per_product_axis`) — 옛 것은 비켜 준다.
    await db.query(
      `UPDATE contribution_review SET status = 'superseded'
        WHERE product_id = $1 AND axis = $2 AND status = 'approved'`, [productId, axis]);
    const r = await db.query(
      `SELECT review_id FROM contribution_review
        WHERE product_id = $1 AND axis = $2 AND status = 'candidate'
        ORDER BY review_id DESC LIMIT 1`, [productId, axis]);
    if (r.rows.length === 0) return null;
    const reviewId = Number(r.rows[0].review_id);
    await db.query(
      `UPDATE contribution_review
          SET status = 'approved', reviewed_by = 'test-admin', reviewed_at = now()
        WHERE review_id = $1`, [reviewId]);
    await applyApprovedContribution({ query: (t2, p2) => db.query(t2, p2 || []) }, reviewId,
      { appliedBy: 'test-admin' });
    return reviewId;
  };

  // ── 마스터 시드 ──────────────────────────────────────────────────────────
  //   ⚠ `설탕` 은 식품첨가물이 **아니다**. 그런데 운영 마스터에 실제로 들어 있다(`U65-1`).
  //     계약 C5 가 그 정리를 **보류**했으므로 여기서도 «있는 그대로» 재현한다 —
  //     축 B(원재료명 완전일치)가 살아 있다는 것을 보이는 데도 필요하다.
  for (const n of ['인산', '구연산', '설탕', '카라기난', 'L-글루타민산나트륨']) {
    await db.query('INSERT INTO additives (name_ko) VALUES ($1)', [n]);
  }
  // 검출은 되지만 마스터에 «없는» 이름 — §5 용 (실측 상위: 카라멜색소 6건)
  const NOT_IN_MASTER = '카라멜색소';

  const additiveRows = async (productId) => (await db.query(
    `SELECT a.name_ko, pa.detected_name, pa.confidence
       FROM product_additives pa
       JOIN additives a ON a.additive_id = pa.additive_id
      WHERE pa.product_id = $1
      ORDER BY a.name_ko`, [productId])).rows;

  /**
   * 라벨 「원재료명: 정제수, 설탕, 산도조절제(인산나트륨), 카라멜색소」를 흉내낸다.
   * ★ `additives` 는 `ocrParser.identifyAdditives` 가 실제로 내는 모양 그대로다
   *   (`{name, category, raw, match_type}` · `name` 은 사전 키워드 · `raw` 는 라벨 원문).
   */
  const report = (over = {}) => ({
    barcode: over.barcode ?? null,
    deviceId: over.deviceId ?? null,
    avgConfidence: 0.95,
    productInfo: { product_name: over.productName ?? '합집합테스트', content_unit: 'g', total_content: 100 },
    ocrResult: { corrected_text: '원재료명: 정제수, 설탕, 산도조절제(인산나트륨), 카라멜색소\n영양성분 100g당' },
    analysis: {
      nutrition: {
        calories: 100, sodium: 50, total_carbs: 20, total_sugars: 10, total_fat: 1,
        saturated_fat: 0, trans_fat: 0, cholesterol: 0, protein: 1, dietary_fiber: 0,
        _basis: 'per_100g',
      },
      ingredients: over.ingredients !== undefined ? over.ingredients
        : [{ name: '정제수' }, { name: '설탕' }, { name: '산도조절제' }],
      additives: over.additives,
      allergens: [],
      allergens_v2: { contains: [], inferred: [], mayContain: [] },
      product_meta: {},
    },
  });

  const DETECTED = [
    { name: '인산', category: '산도조절제', raw: '산도조절제(인산나트륨)', match_type: 'partial(main)' },
    { name: NOT_IN_MASTER, category: '착색료', raw: '카라멜색소', match_type: 'exact(main)' },
  ];

  // ══════════════════════════════════════════════════════════════════════════
  section('§1~§5  경로 ① crowdsourceService — 합집합 · 원문 · 마스터 교집합');
  // ══════════════════════════════════════════════════════════════════════════
  const r1 = await crowdsource.saveOcrContribution(report({
    barcode: 'S65C1_UNION', additives: DETECTED,
  }));
  assert.strictEqual(r1.saved, true, `저장이 반려됐다: ${r1.rejectReason}`);
  await approveAxis(r1.productId, 'additives');
  const rows1 = await additiveRows(r1.productId);
  const byName1 = new Map(rows1.map((r) => [r.name_ko, r]));

  await t('§1 축 A 에만 있는 첨가물이 저장된다 (인산 — 종전에는 통째로 사라졌다)', () => {
    assert.ok(byName1.has('인산'),
      `축 A(identifyAdditives) 결과가 저장되지 않았다. 저장된 것: ${[...byName1.keys()].join(', ') || '(없음)'}`);
  });

  await t('§2 축 B(원재료명 완전일치)는 그대로 저장된다 (설탕 — 회귀 없음)', () => {
    assert.ok(byName1.has('설탕'),
      `축 B 가 깨졌다. 합집합으로 넓히면서 기존 경로를 잃으면 안 된다. 저장: ${[...byName1.keys()].join(', ')}`);
  });

  await t('§3 detected_name 이 «라벨 원문» 이다 — 마스터 이름이 아니다', () => {
    const row = byName1.get('인산');
    assert.ok(row, '§1 이 먼저 깨졌다');
    assert.strictEqual(row.detected_name, '산도조절제(인산나트륨)',
      `detected_name 에 라벨 원문이 아니라 "${row.detected_name}" 가 들어갔다. `
      + '마스터 이름(name_ko)을 넣으면 「라벨에 뭐라고 적혀 있었는지」가 DB 어디에도 안 남는다(계약 C1).');
  });

  await t('§4 두 축이 겹치면 «더 좁은» 원문(= 원재료명 그 자체)이 이긴다', () => {
    assert.strictEqual(byName1.get('설탕').detected_name, '설탕',
      '축 B 로 붙은 것의 detected_name 은 원재료명 그 자체여야 한다');
  });

  await t('§5 마스터에 없는 검출은 저장되지 않는다 (∩ additives 마스터)', () => {
    assert.ok(!byName1.has(NOT_IN_MASTER),
      `마스터에 없는 "${NOT_IN_MASTER}" 가 저장됐다. FK 가 있는 컬럼이라 저장될 수 없어야 한다`);
    assert.strictEqual(rows1.length, 2,
      `저장 개수가 2(인산·설탕)가 아니라 ${rows1.length} 다: ${rows1.map(r => r.name_ko).join(', ')}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§6~§8  기존 동작 보존 (additives 없음/빈배열 · ON CONFLICT)');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§6 analysis.additives 가 «없어도» 축 B 저장이 그대로 된다', async () => {
    const r = await crowdsource.saveOcrContribution(report({
      barcode: 'S65C1_NOADD', productName: '첨가물키없음', additives: undefined,
    }));
    assert.strictEqual(r.saved, true, `저장이 반려됐다: ${r.rejectReason}`);
    await approveAxis(r.productId, 'additives');
    const names = (await additiveRows(r.productId)).map((x) => x.name_ko);
    assert.ok(names.includes('설탕'),
      `analysis.additives 가 없을 때 기존 동작(축 B)이 깨졌다: [${names.join(', ')}]`);
  });

  await t('§7 analysis.additives 가 «빈 배열» 이어도 축 B 저장이 그대로 된다', async () => {
    const r = await crowdsource.saveOcrContribution(report({
      barcode: 'S65C1_EMPTY', productName: '첨가물빈배열', additives: [],
    }));
    assert.strictEqual(r.saved, true, `저장이 반려됐다: ${r.rejectReason}`);
    await approveAxis(r.productId, 'additives');
    const names = (await additiveRows(r.productId)).map((x) => x.name_ko);
    assert.deepStrictEqual(names, ['설탕'],
      `빈 배열일 때 저장집합이 축 B 와 달라졌다: [${names.join(', ')}]`);
  });

  await t('§8 재제보해도 행이 늘지 않고 첫 detected_name 이 유지된다 (ON CONFLICT DO NOTHING)', async () => {
    const before = await additiveRows(r1.productId);
    const again = await crowdsource.saveOcrContribution(report({
      barcode: 'S65C1_UNION',
      // 두 번째 제보는 같은 첨가물을 «다른 원문»으로 읽었다고 하자.
      additives: [{ name: '인산', category: '산도조절제', raw: '산도조절제', match_type: 'exact(main)' }],
    }));
    assert.strictEqual(again.saved, true, `재제보가 반려됐다: ${again.rejectReason}`);
    await approveAxis(r1.productId, 'additives');
    const after = await additiveRows(r1.productId);
    assert.strictEqual(after.length, before.length,
      `재제보로 행이 ${before.length} → ${after.length} 로 늘었다. ON CONFLICT DO NOTHING 이 깨졌다(계약 C1)`);
    assert.strictEqual(after.find((x) => x.name_ko === '인산').detected_name, '산도조절제(인산나트륨)',
      '나중에 온 «약한» 검출이 먼저 온 정확한 원문을 덮었다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§9  경로 ② mergeService.mergeAndApply — 같은 합집합인가');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§9 병합 경로도 «완전일치가 아닌» 이름에서 첨가물을 저장한다', async () => {
    const p = await db.query(
      `INSERT INTO products (barcode, product_name, data_source, verification, verify_count)
       VALUES ('S65C1_MERGE', '병합합집합', 'ocr_crowdsource', 'unverified', 0)
       RETURNING product_id`);
    const pid = p.rows[0].product_id;

    // 기여 3건 — 원재료명이 「혼합제제(카라기난)」 라 SQL `= ANY()` 완전일치로는 **절대** 안 붙는다.
    for (const dev of ['d1', 'd2', 'd3']) {
      await db.query(
        `INSERT INTO contributions (product_id, contribution_type, data, status)
         VALUES ($1, 'ocr_nutrition', $2, 'pending')`,
        [pid, JSON.stringify({
          device_id: dev,
          parsed_nutrition: { calories: 100, sodium: 50 },
          parsed_ingredients: [{ name: '혼합제제(카라기난)' }, { name: '설탕' }],
          allergens: [],
        })]);
    }
    const res = await mergeAndApply(pid);
    assert.strictEqual(res.applied, true, '병합이 적용되지 않았다');
    // ★★ 세션66 C6 — 병합도 «자동 반영»이 아니다. 판정만 하고 candidate 를 만든다.
    //   여기서 관리자 승인을 흉내내야 같은 합집합 규칙이 도는지 잴 수 있다.
    assert.ok(await approveAxis(pid, 'additives'),
      '병합이 additives candidate 를 만들지 않았다 — 검토 큐에 안 올라가면 영원히 반영되지 않는다');

    const rows = await additiveRows(pid);
    const byName = new Map(rows.map((r) => [r.name_ko, r]));
    assert.ok(byName.has('카라기난'),
      `병합 경로가 부분매칭 결과를 저장하지 않았다(경로 ①과 갈렸다). 저장: [${rows.map(r => r.name_ko).join(', ')}]`);
    assert.strictEqual(byName.get('카라기난').detected_name, '혼합제제(카라기난)',
      '병합 경로의 detected_name 이 라벨 원문이 아니다');
    assert.ok(byName.has('설탕'), '병합 경로의 축 B(완전일치)가 깨졌다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§10  두 경로가 «같은 규칙 본문»을 쓰는가 (리졸버 직접 호출)');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§10 리졸버가 축 A ∪ 축 B 를 낸다 (순수 계산 · DB 무관)', () => {
    const { names, rawByName } = resolver.buildAdditiveCandidates({
      detectedAdditives: DETECTED,
      ingredientNames: ['정제수', '설탕', '산도조절제'],
    });
    assert.ok(names.includes('인산'), `축 A 가 후보에 없다: [${names.join(', ')}]`);
    assert.ok(names.includes('설탕'), `축 B 가 후보에 없다: [${names.join(', ')}]`);
    assert.ok(names.includes('정제수'), '축 B 는 마스터 조인 «전» 이라 전 원재료가 후보다');
    assert.strictEqual(rawByName.get('인산'), '산도조절제(인산나트륨)', '축 A 원문이 raw 가 아니다');
    assert.strictEqual(rawByName.get('설탕'), '설탕', '축 B 원문이 이름 그 자체가 아니다');
  });

  await t('§10-b 리졸버가 `analysis.additives` 없이도 이름만으로 검출한다 (경로 ② 용)', () => {
    const found = resolver.detectFromIngredientNames(['혼합제제(카라기난)', '설탕']);
    assert.ok(found.some((a) => a.name === '카라기난'),
      `이름만으로 하는 검출이 죽었다: ${JSON.stringify(found)}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(` 통과 ${pass} · 실패 ${fail}`);
  if (fail > 0) {
    console.log('\n실패 상세:');
    for (const f of failures) console.log(`\n[${f.name}]\n${f.message}`);
  }
  console.log('════════════════════════════════════════════════════════════════\n');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
