/**
 * test_promotion_rules.js — 세션65 C3 (`U64-4` · `U64-12`) 「승격 규칙」 회귀
 * ============================================================================
 * 배경 (계약 `.tmp/s65/계약_세션65.md` C3)
 *   경로 ①(`crowdsourceService`)의 SQL 에 이런 줄이 있었다:
 *     WHEN verification = 'partial' AND verify_count >= 1 THEN 'verified'
 *   이 줄에는 **기기 구분이 없다.**
 *     · 24시간 중복 게이트는 `if (deviceId && productId)` 인데
 *       **신규 제품의 첫 저장은 `productId` 가 null** 이라 애초에 안 걸린다.
 *     · 앱은 `device_id` 를 아예 안 보낸다(`U64-5`) — 웹 경로에서는 **절대** 안 걸린다.
 *   ⇒ 한 사람이 한 기기로 사진 2장이면 `unverified → partial → verified`.
 *     「다른 사용자가 확인했다」는 배지가 **혼자서** 달린다.
 *
 *   그리고 `U64-12` — 경로 ②는 `distinctDeviceCount >= 3` 이면 이상치가 없는 한
 *   무조건 `verified` 였다. 세션64b 부터 **영양 미확보 제보도 저장**되므로,
 *   영양값이 하나도 없는 제품이 「검증됨」 배지를 단다(값이 없으면 이상치도 0건이다).
 *
 * 무엇을 지키는가
 *   §1 경로 ①: `unverified → partial` 은 여전히 한다 (회귀 없음)
 *   §2 ★ 경로 ①: `partial` 에서 **더 올라가지 않는다** (자작 verified 통로 차단)
 *   §3 경로 ①: `verify_count` 는 계속 증가한다 (관측을 죽이지 않았다)
 *   §4 ★ 경로 ①로 몇 번을 제보해도 DB 에 `verified` 가 **생기지 않는다**
 *   §5 경로 ②: 서로 다른 기기 3대 + 영양값 있음 → `verified` (승격 통로는 살아 있다)
 *   §6 ★ 경로 ②: 서로 다른 기기 3대 + **영양 0개** → `verified` 아님 (`U64-12`)
 *   §7 경로 ②: 이상치가 있으면 `disputed`
 *   §8 경로 ②: 기기 2대는 `partial`
 *   §9 `admin_verified` 는 병합이 덮지 않는다
 *
 * ★ 소스 문자열을 읽지 않는다. pglite 에 `000_baseline.sql` 을 적용하고
 *   정본 서비스를 실제로 호출해 **DB 에 박힌 `products.verification`** 만 단정한다.
 *
 * 실행: cross-env NODE_ENV=test node tests/test_promotion_rules.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRV = path.join(__dirname, '..');
const BASELINE = path.join(SRV, 'scripts', 'migrations', '000_baseline.sql');
const M022 = path.join(SRV, 'scripts', 'migrations', '022_additive_detected_count.sql');

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
  console.log(' 세션65 C3 — 승격 규칙 (U64-4 자작 verified · U64-12 영양 0개)');
  console.log('════════════════════════════════════════════════════════════════');

  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (_) {
    console.log('⏭  pglite 미설치 — 검증 불가. 「건너뜀」은 「통과」가 아니다. EXIT=1.');
    process.exit(1);
  }

  const db = new PGlite();
  try {
    await db.exec(fs.readFileSync(BASELINE, 'utf8'));
    await db.exec(fs.readFileSync(M022, 'utf8'));
  } catch (e) {
    console.error(`마이그레이션 적용 실패: ${e.message}`);
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

  const GOOD_NUTRITION = {
    calories: 480, sodium: 300, total_carbs: 60, total_sugars: 25, total_fat: 22,
    saturated_fat: 12, trans_fat: 0, cholesterol: 5, protein: 6, dietary_fiber: 2,
    _basis: 'per_100g',
  };

  const report = (barcode, name) => ({
    barcode, deviceId: null, avgConfidence: 0.95,
    productInfo: { product_name: name, food_type: '과자', content_unit: 'g', total_content: 120 },
    ocrResult: { corrected_text: '원재료명: 밀가루, 설탕\n영양성분 100g당' },
    analysis: {
      nutrition: { ...GOOD_NUTRITION },
      ingredients: [{ name: '밀가루' }, { name: '설탕' }],
      additives: [],
      allergens: [], allergens_v2: { contains: [], inferred: [], mayContain: [] },
      product_meta: {},
    },
  });

  const state = async (barcode) => (await db.query(
    'SELECT verification, verify_count FROM products WHERE barcode = $1', [barcode])).rows[0];

  // ══════════════════════════════════════════════════════════════════════════
  section('§1~§4  경로 ① crowdsourceService — partial 까지만');
  // ══════════════════════════════════════════════════════════════════════════
  const first = await crowdsource.saveOcrContribution(report('S65C3_SOLO', '자작승격테스트'));
  assert.strictEqual(first.saved, true, `1회차 저장이 반려됐다: ${first.rejectReason}`);

  await t('§1 1회차 — unverified → partial 은 여전히 한다 (회귀 없음)', async () => {
    const s = await state('S65C3_SOLO');
    assert.strictEqual(s.verification, 'partial',
      `1회차 승격이 깨졌다: ${s.verification}. 이 축은 «막는» 것이지 «죽이는» 것이 아니다`);
    assert.strictEqual(Number(s.verify_count), 1, `verify_count 가 1 이 아니라 ${s.verify_count} 다`);
  });

  await t('§2 ★ 2회차 — 같은 기기로 또 올려도 verified 로 «올라가지 않는다»', async () => {
    const second = await crowdsource.saveOcrContribution(report('S65C3_SOLO', '자작승격테스트'));
    assert.strictEqual(second.saved, true, `2회차 저장이 반려됐다: ${second.rejectReason}`);
    const s = await state('S65C3_SOLO');
    assert.strictEqual(s.verification, 'partial',
      `혼자서 「검증됨」이 됐다(${s.verification}). 경로 ①에는 기기 구분이 없다 — `
      + 'verified 전이는 mergeService.mergeAndApply 만 해야 한다(계약 C3)');
  });

  await t('§3 verify_count 는 계속 증가한다 (관측을 죽이지 않았다)', async () => {
    const s = await state('S65C3_SOLO');
    assert.strictEqual(Number(s.verify_count), 2,
      `verify_count 가 2 가 아니라 ${s.verify_count} 다 — 승격을 막느라 카운트까지 멈추면 안 된다`);
  });

  await t('§4 ★ 경로 ①을 5회 더 반복해도 DB 에 verified 가 «생기지 않는다»', async () => {
    for (let i = 0; i < 5; i += 1) {
      const r = await crowdsource.saveOcrContribution(report('S65C3_SOLO', '자작승격테스트'));
      assert.strictEqual(r.saved, true, `${i + 3}회차 저장이 반려됐다: ${r.rejectReason}`);
    }
    const s = await state('S65C3_SOLO');
    assert.strictEqual(s.verification, 'partial', `7회 제보 후 상태가 ${s.verification} 다`);
    assert.strictEqual(Number(s.verify_count), 7, `verify_count 가 7 이 아니라 ${s.verify_count} 다`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§5~§9  경로 ② mergeService.mergeAndApply — 유일한 verified 통로');
  // ══════════════════════════════════════════════════════════════════════════
  /** 제품 1개 + 기여 N건을 심는다. `nutrition` 이 null 이면 영양 미확보 제보다. */
  async function seed(barcode, devices, nutritionOf) {
    const p = await db.query(
      `INSERT INTO products (barcode, product_name, data_source, verification, verify_count)
       VALUES ($1, $2, 'ocr_crowdsource', 'unverified', 0) RETURNING product_id`,
      [barcode, barcode]);
    const pid = p.rows[0].product_id;
    for (const dev of devices) {
      await db.query(
        `INSERT INTO contributions (product_id, contribution_type, data, status)
         VALUES ($1, 'ocr_nutrition', $2, 'pending')`,
        [pid, JSON.stringify({
          device_id: dev,
          avg_confidence: 0.95,
          parsed_nutrition: nutritionOf(dev),
          parsed_ingredients: [{ name: '밀가루' }, { name: '설탕' }],
          allergens: [],
          user_input: { product_name: barcode },
        })]);
    }
    return pid;
  }

  await t('§5 기기 3대 + 영양값 있음 → verified (승격 통로는 살아 있다)', async () => {
    const pid = await seed('S65C3_OK', ['a', 'b', 'c'], () => ({ calories: 100, sodium: 50 }));
    const res = await mergeAndApply(pid);
    assert.strictEqual(res.verification, 'verified',
      `승격 통로가 막혔다: ${res.verification}. 이 축은 자작 승격만 막는 것이다`);
    const s = await state('S65C3_OK');
    assert.strictEqual(s.verification, 'verified', `DB 값이 ${s.verification} 다`);
  });

  await t('§6 ★ 기기 3대 + 영양 «0개» → verified 가 아니다 (U64-12)', async () => {
    const pid = await seed('S65C3_NONUT', ['a', 'b', 'c'], () => null);
    const res = await mergeAndApply(pid);
    assert.notStrictEqual(res.verification, 'verified',
      '확인된 영양값이 0개인 제품이 「검증됨」 배지를 달았다. '
      + '값이 없으면 이상치도 0건이라 disputed 로도 안 걸린다(계약 C3 · U64-12)');
    assert.strictEqual(res.verification, 'partial',
      `0개일 때는 partial 에서 멈춘다(기기 2대가 이미 partial 인데 3대가 더 낮으면 앞뒤가 안 맞는다). 실제: ${res.verification}`);
    const s = await state('S65C3_NONUT');
    assert.notStrictEqual(s.verification, 'verified', `DB 값이 ${s.verification} 다`);
    const n = await db.query('SELECT count(*)::int AS c FROM nutrition_data WHERE product_id = $1', [pid]);
    assert.strictEqual(n.rows[0].c, 0, '영양값이 없는데 nutrition_data 행이 생겼다');
  });

  await t('§7 이상치가 있으면 disputed', async () => {
    const vals = { a: 100, b: 100, c: 1000 };
    const pid = await seed('S65C3_OUT', ['a', 'b', 'c'], (d) => ({ calories: vals[d], sodium: 50 }));
    const res = await mergeAndApply(pid);
    assert.strictEqual(res.verification, 'disputed', `이상치 판정이 깨졌다: ${res.verification}`);
  });

  await t('§8 기기 2대는 partial', async () => {
    const pid = await seed('S65C3_TWO', ['a', 'b'], () => ({ calories: 100, sodium: 50 }));
    const res = await mergeAndApply(pid);
    assert.strictEqual(res.verification, 'partial', `2대 규칙이 깨졌다: ${res.verification}`);
  });

  await t('§9 admin_verified 는 병합이 덮지 않는다', async () => {
    const pid = await seed('S65C3_ADMIN', ['a', 'b', 'c'], () => ({ calories: 100, sodium: 50 }));
    await db.query(
      `UPDATE products SET verification = 'admin_verified' WHERE product_id = $1`, [pid]);
    await mergeAndApply(pid);
    const s = await state('S65C3_ADMIN');
    assert.strictEqual(s.verification, 'admin_verified',
      `관리자 검증이 병합에 덮였다: ${s.verification}`);
  });

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
