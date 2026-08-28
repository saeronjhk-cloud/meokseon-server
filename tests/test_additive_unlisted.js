/**
 * test_additive_unlisted.js — 세션65 C2-a·C2-b (`U65-2`) 「불러오지 못한 N종」 회귀
 * ============================================================================
 * 배경 (`.tmp/s65/U64-3_재측정_판정.md` §4)
 *   조회 응답의 `risk_summary.total` 은 **「저장된 것의 개수」**다.
 *   그래서 서버 응답에는 「원래 몇 개였는지」가 **아예 들어 있지 않았다.**
 *   앱의 `Math.max(serverTotal, items.length)` 는 그 값으로는 구조적으로 항상 0 이 되고,
 *   「N종은 상세 정보를 불러오지 못했어요」가 **한 번도 뜬 적이 없다.**
 *   ⇒ 66.1% 가 사라지는데 화면은 **저장된 것이 전부인 것처럼** 보였다.
 *
 * 무엇을 지키는가 (계약 C2-a · C2-b)
 *   §1 `products.additive_detected_count` 컬럼이 022 로 생긴다
 *   §2 저장 경로가 거기에 **마스터 조인 «전»** 의 검출 총 개수를 기록한다
 *   §3 ★ 두 번째 제보가 «더 적게» 검출해도 값이 **내려가지 않는다**
 *      (내려가면 `unlisted` 가 줄어든다 = 경고를 지우는 방향)
 *   §4 응답에 `detected_total` · `unlisted` 가 «추가»된다
 *   §5 `unlisted = max(0, detected_total - total)` 을 **서버가** 계산한다
 *   §6 `detected_total` 이 null 인 기존 제품은 `unlisted = 0` — **화면이 지금과 같다**
 *   §7 `detected_total < total` 이어도 `unlisted` 가 음수가 되지 않는다
 *   §8 기존 필드(`total`·`by_color`·`with_v2_data`)의 **이름·의미가 안 바뀌었다**
 *   §9 ★ 022 «미적용» DB 에서도 500 이 아니라 `detected_total:null` · `unlisted:0` 이다
 *      (배포 순서 방어 — 세션45 치명1 과 같은 형태의 사고를 다시 열지 않는다)
 *  §10 0 과 null 이 **다른 뜻**이다 (0 = 검출해 봤고 없음 · null = 모름)
 *
 * ★ 소스 문자열을 읽지 않는다. pglite 에 정본 SQL 을 적용하고 실제 서비스만 호출한다.
 *
 * 실행: cross-env NODE_ENV=test node tests/test_additive_unlisted.js
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
  console.log(' 세션65 C2 — 「불러오지 못한 N종」 (U65-2 · 지금까지 한 번도 안 떴다)');
  console.log('════════════════════════════════════════════════════════════════');

  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (_) {
    console.log('⏭  pglite 미설치 — 검증 불가. 「건너뜀」은 「통과」가 아니다. EXIT=1.');
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('§0  022 가 `npm run migrate` 체인에 «이어져» 있는가');
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 왜 이 단정이 여기 있나 — 세션64c 가 마이그레이션 **파일만 만들고 체인에 안 이어서**
  //   CI gate #19 를 태웠다. 「파일을 만드는 것」과 「체인에 잇는 것」은 다른 일이다.
  //   컬럼이 없는 DB 로 배포가 나가면 이 축 전체가 조용히 무동작이 된다
  //   (`hasAdditiveDetectedCountColumn()` 가드가 500 을 막아 주므로 **더 조용하다**).
  //   ⚠ 이것은 코드 의미가 아니라 **배포 산출물** 검사다 — 그래서 파일을 읽는 것이 맞다.
  await t('§0 package.json 의 migrate 체인이 022 를 ON_ERROR_STOP=1 로 실행한다', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(SRV, 'package.json'), 'utf8'));
    const chain = String(pkg.scripts.migrate || '');
    assert.ok(chain.includes('022_additive_detected_count.sql'),
      '022 가 `npm run migrate` 체인에 없다. 파일만 만들고 체인에 안 이으면 '
      + '빈 DB·CI·신규 환경에 컬럼이 영원히 안 생긴다(세션64c gate #19 와 같은 사고).');
    // `_note:migrate2` 규칙 — 없으면 실패해도 && 가 이어져 「거짓 초록」이 된다.
    const seg = chain.split('&&').find((x) => x.includes('022_additive_detected_count.sql'));
    assert.ok(/-v\s+ON_ERROR_STOP=1/.test(seg),
      `022 구간에 -v ON_ERROR_STOP=1 이 없다: ${seg.trim()}`);
  });

  const db = new PGlite();
  try {
    await db.exec(fs.readFileSync(BASELINE, 'utf8'));
  } catch (e) {
    console.error(`000_baseline.sql 적용 실패: ${e.message}`);
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

  const productModel = require('../src/models/productModel');
  const productService = require('../src/services/productService');
  const crowdsource = require('../src/services/crowdsourceService');

  // ══════════════════════════════════════════════════════════════════════════
  section('§9 먼저 — 022 «미적용» DB (배포 순서 방어)');
  // ══════════════════════════════════════════════════════════════════════════
  // ★ 022 를 적용하기 «전»에 먼저 본다. 컬럼이 아직 없는 상태가 배포 중 실제로 존재한다.
  await db.query(
    `INSERT INTO products (barcode, product_name, data_source)
     VALUES ('S65C2_NOCOL', '022전제품', 'ocr_crowdsource')`);

  await t('§9 022 미적용 DB 에서 /additives 가 500 이 아니라 detected_total:null · unlisted:0', async () => {
    productModel._resetAdditiveDetectedCountCache();
    const r = await productService.getProductAdditives('S65C2_NOCOL');
    assert.strictEqual(r.risk_summary.detected_total, null,
      `컬럼이 없는데 detected_total 이 ${JSON.stringify(r.risk_summary.detected_total)} 다`);
    assert.strictEqual(r.risk_summary.unlisted, 0, '컬럼이 없으면 unlisted 는 0 이어야 한다');
  });

  await t('§9-b 022 미적용 DB 에 저장해도 반려되지 않는다 (컬럼 쓰기를 건너뛴다)', async () => {
    productModel._resetAdditiveDetectedCountCache();
    const r = await crowdsource.saveOcrContribution({
      barcode: 'S65C2_NOCOL_SAVE', deviceId: null, avgConfidence: 0.95,
      productInfo: { product_name: '022전저장', content_unit: 'g', total_content: 100 },
      ocrResult: { corrected_text: '원재료명: 설탕' },
      analysis: {
        nutrition: {
          calories: 100, sodium: 50, total_carbs: 20, total_sugars: 10, total_fat: 1,
          saturated_fat: 0, trans_fat: 0, cholesterol: 0, protein: 1, dietary_fiber: 0,
          _basis: 'per_100g',
        },
        ingredients: [{ name: '설탕' }],
        additives: [{ name: '카라멜색소', raw: '카라멜색소' }],
        allergens: [], allergens_v2: { contains: [], inferred: [], mayContain: [] },
        product_meta: {},
      },
    });
    assert.strictEqual(r.saved, true, `022 미적용 DB 에서 저장이 반려됐다: ${r.rejectReason}`);
  });

  // ── 이제 022 를 적용한다 ────────────────────────────────────────────────
  await db.exec(fs.readFileSync(M022, 'utf8'));
  productModel._resetAdditiveDetectedCountCache();

  await t('§1 022 가 products.additive_detected_count(INTEGER, NULL 허용)를 만든다', async () => {
    const r = await db.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name='products' AND column_name='additive_detected_count'`);
    assert.strictEqual(r.rows.length, 1, '컬럼이 생기지 않았다');
    assert.strictEqual(r.rows[0].data_type, 'integer', `타입이 integer 가 아니다: ${r.rows[0].data_type}`);
    assert.strictEqual(r.rows[0].is_nullable, 'YES', 'NULL 허용이어야 한다 — NULL 이 「모름」이다');
  });

  // ── 마스터 시드 ──
  for (const n of ['인산', '구연산']) {
    await db.query('INSERT INTO additives (name_ko, risk_color) VALUES ($1, $2)', [n, 'green']);
  }

  const report = (over = {}) => ({
    barcode: over.barcode, deviceId: null, avgConfidence: 0.95,
    productInfo: { product_name: over.productName ?? '미표시테스트', content_unit: 'g', total_content: 100 },
    ocrResult: { corrected_text: '원재료명: 정제수, 산도조절제(인산나트륨), 카라멜색소, 덱스트린, 주정' },
    analysis: {
      nutrition: {
        calories: 100, sodium: 50, total_carbs: 20, total_sugars: 10, total_fat: 1,
        saturated_fat: 0, trans_fat: 0, cholesterol: 0, protein: 1, dietary_fiber: 0,
        _basis: 'per_100g',
      },
      ingredients: [{ name: '정제수' }, { name: '산도조절제' }],
      additives: over.additives,
      allergens: [], allergens_v2: { contains: [], inferred: [], mayContain: [] },
      product_meta: {},
    },
  });

  // 검출 4종 · 그중 마스터에 있는 것은 `인산` 1종뿐 → 저장 1 · 소실 3
  const DETECTED4 = [
    { name: '인산', raw: '산도조절제(인산나트륨)' },
    { name: '카라멜색소', raw: '카라멜색소' },
    { name: '덱스트린', raw: '덱스트린' },
    { name: '주정', raw: '주정' },
  ];

  // ══════════════════════════════════════════════════════════════════════════
  section('§2~§3  저장 경로가 검출 총 개수를 기록하는가');
  // ══════════════════════════════════════════════════════════════════════════
  const saved = await crowdsource.saveOcrContribution(report({
    barcode: 'S65C2_MAIN', additives: DETECTED4,
  }));
  assert.strictEqual(saved.saved, true, `저장이 반려됐다: ${saved.rejectReason}`);

  const detCount = async (pid) => (await db.query(
    'SELECT additive_detected_count AS c FROM products WHERE product_id = $1', [pid])).rows[0].c;

  await t('§2 additive_detected_count = 4 (마스터 조인 «전» 의 검출 총 개수)', async () => {
    const c = await detCount(saved.productId);
    assert.strictEqual(Number(c), 4,
      `검출 총 개수가 4 가 아니라 ${c} 다. 마스터 조인 «후»(=1)를 넣으면 unlisted 가 영원히 0 이다`);
  });

  await t('§3 ★ 두 번째 제보가 1종만 검출해도 값이 내려가지 않는다 (경고를 지우지 않는다)', async () => {
    const again = await crowdsource.saveOcrContribution(report({
      barcode: 'S65C2_MAIN', additives: [{ name: '인산', raw: '산도조절제' }],
    }));
    assert.strictEqual(again.saved, true, `재제보가 반려됐다: ${again.rejectReason}`);
    const c = await detCount(saved.productId);
    assert.strictEqual(Number(c), 4,
      `흐린 사진 한 장이 검출 총 개수를 4 → ${c} 로 깎았다. unlisted 가 줄어든다 = 경고 삭제 방향이다`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§4~§8  응답 계약 (risk_summary)');
  // ══════════════════════════════════════════════════════════════════════════
  const resp = await productService.getProductAdditives('S65C2_MAIN');

  await t('§4 risk_summary 에 detected_total·unlisted 가 «추가»됐다', () => {
    assert.ok(Object.prototype.hasOwnProperty.call(resp.risk_summary, 'detected_total'),
      'detected_total 키가 없다');
    assert.ok(Object.prototype.hasOwnProperty.call(resp.risk_summary, 'unlisted'),
      'unlisted 키가 없다');
    assert.strictEqual(resp.risk_summary.detected_total, 4,
      `detected_total 이 4 가 아니라 ${resp.risk_summary.detected_total} 다`);
  });

  await t('§5 unlisted = max(0, detected_total - total) 을 «서버가» 계산해서 내려준다', () => {
    assert.strictEqual(resp.risk_summary.total, 1,
      `total(저장·조회된 개수)이 1 이 아니라 ${resp.risk_summary.total} 다`);
    assert.strictEqual(resp.risk_summary.unlisted, 3,
      `unlisted 가 3 이 아니라 ${resp.risk_summary.unlisted} 다. `
      + '이 값이 0 이면 「N종은 불러오지 못했어요」가 또 한 번도 안 뜬다');
  });

  await t('§8 기존 필드의 이름·의미가 안 바뀌었다 (total · by_color · with_v2_data)', () => {
    assert.strictEqual(resp.risk_summary.total, resp.additives.length,
      'total 의 의미가 「저장되어 조회된 개수」에서 바뀌었다 — 배포된 앱이 이 키를 읽는다');
    assert.ok(resp.risk_summary.by_color && typeof resp.risk_summary.by_color === 'object',
      'by_color 가 사라졌다');
    assert.strictEqual(resp.risk_summary.by_color.green, 1, 'by_color 집계가 깨졌다');
    assert.strictEqual(typeof resp.risk_summary.with_v2_data, 'number', 'with_v2_data 가 사라졌다');
  });

  await t('§6 detected_total 이 null 인 기존 제품은 unlisted = 0 (회귀 없음)', async () => {
    await db.query(
      `INSERT INTO products (barcode, product_name, data_source)
       VALUES ('S65C2_LEGACY', '기존제품', 'public_c005')`);
    const r = await productService.getProductAdditives('S65C2_LEGACY');
    assert.strictEqual(r.risk_summary.detected_total, null,
      '기존 제품(대다수)의 detected_total 은 null 이어야 한다');
    assert.strictEqual(r.risk_summary.unlisted, 0,
      '모르는 것을 「사라졌다」로 바꾸면 안 된다 — 전 제품에 거짓 경고가 뜬다');
  });

  await t('§7 detected_total < total 이어도 unlisted 가 음수가 아니다', async () => {
    await db.query(
      `UPDATE products SET additive_detected_count = 0 WHERE barcode = 'S65C2_MAIN'`);
    const r = await productService.getProductAdditives('S65C2_MAIN');
    assert.strictEqual(r.risk_summary.detected_total, 0, 'detected_total 이 0 으로 안 읽혔다');
    assert.strictEqual(r.risk_summary.unlisted, 0,
      `unlisted 가 음수/이상값이다: ${r.risk_summary.unlisted}`);
  });

  await t('§10 0 과 null 이 «다른 뜻» 이다 (0 = 검출해 봤고 없음 · null = 모름)', async () => {
    const zero = await productService.getProductAdditives('S65C2_MAIN');   // 위에서 0 으로 세팅
    const nul = await productService.getProductAdditives('S65C2_LEGACY');
    assert.strictEqual(zero.risk_summary.detected_total, 0);
    assert.strictEqual(nul.risk_summary.detected_total, null);
    assert.notStrictEqual(zero.risk_summary.detected_total, nul.risk_summary.detected_total,
      '0 과 null 이 같은 값으로 뭉개졌다 — 「검출해 봤고 없음」과 「모름」은 다르다');
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
