/**
 * test_write_path_split.js — 세션66 C6 「제보는 공식 테이블에 쓰지 않는다」 회귀
 * ============================================================================
 * 무엇을 지키는가 (계약 `.tmp/s66/계약_세션66.md` §7 · 설계 §3 · §11)
 *   §1  ★★ 제보 후 `nutrition_data`·`product_ingredients`·`product_allergens`
 *          ·`product_additives` 에 행이 **생기지 않는다**
 *   §2  ★★ 대신 `contribution_review` 에 축별 `candidate` 가 생긴다 (내용 있는 축에만)
 *   §3  ★★ `contributions` 원본 적립은 **그대로** — 제보가 유실되지 않는다
 *   §4  ★  제보자 «본인» 응답에 OCR 파싱 결과가 여전히 실린다 (`DS-0` 획득 훅)
 *   §5  ★★ `U65-6` 소멸 — 공공 영양이 있는 제품에 몇 번 제보해도 `nutrition_data` 불변
 *   §6  ★★ `U65-7` 소멸 — 관리자 `reject` 가 `nutrition_data` 를 **한 행도 지우지 않는다**
 *   §7  ★★ `U65-8` 소멸 — 미검토 제보가 다른 사용자의 조회 결과를 바꾸지 않는다
 *   §8  관리자 `approve` → `applyApprovedContribution` 이 실제로 불려 공식 테이블에 반영된다
 *   §9  `undo` → 되돌아간다. `reopen` → `candidate` 로 돌아간다
 *   §10 ★★ 3기기 병합이 **자동 반영되지 않고** candidate 를 만든다 (설계 §3-2)
 *   §11 `action='correct'` 인데 `corrections` 가 없으면 **`success:true` 가 아니다**
 *   §12 024 «미적용» DB 에서도 제보가 500 이 되지 않는다 (배포순서 방어)
 *
 * ★ 소스 문자열을 정규식으로 읽어 단정하지 않는다. pglite 에 정본 마이그레이션을 적용하고
 *   **실제 서비스·실제 라우터**를 호출해서 DB 에 박힌 것만 단정한다.
 *
 * 실행: cross-env NODE_ENV=test node tests/test_write_path_split.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const SRV = path.join(__dirname, '..');
const MIG = path.join(SRV, 'scripts', 'migrations');
const BASELINE = path.join(MIG, '000_baseline.sql');
const CHAIN = ['023', '024', '025', '026'];

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
  console.log(' 세션66 C6 — 쓰기 경로 분리 (제보는 공식 테이블에 쓰지 않는다)');
  console.log('════════════════════════════════════════════════════════════════');

  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (_) {
    console.log('⏭  pglite 미설치 — 쓰기 경로를 검증할 수 없다. 「건너뜀」은 「통과」가 아니다. EXIT=1.');
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('§0  023~026 이 `npm run migrate` 체인에 «이어져» 있는가');
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 세션64c 가 마이그레이션 **파일만 만들고 체인에 안 이어서** CI gate #19 를 태웠다.
  //   「파일을 만드는 것」과 「체인에 잇는 것」은 다른 일이다. 이 축은 더 위험하다 —
  //   024 가 없는 DB 에 코드가 배포되면 제보가 검토 큐에 **영원히 안 들어간다**(조용하다).
  //   ⚠ 이것은 코드 의미가 아니라 **배포 산출물** 검사라서 파일을 읽는 것이 맞다.
  const MIG_FILES = fs.readdirSync(MIG);
  for (const prefix of CHAIN) {
    const f = MIG_FILES.find((x) => x.startsWith(`${prefix}_`) && x.endsWith('.sql'));
    await t(`§0 migrate 체인이 ${prefix} 를 ON_ERROR_STOP=1 로 실행한다`, () => {
      assert.ok(f, `${prefix}_*.sql 이 없다`);
      const pkg = JSON.parse(fs.readFileSync(path.join(SRV, 'package.json'), 'utf8'));
      const chain = String(pkg.scripts.migrate || '');
      assert.ok(chain.includes(f), `${f} 가 migrate 체인에 없다 — 빈 DB·CI 에 테이블이 영원히 안 생긴다`);
      const seg = chain.split('&&').find((x) => x.includes(f));
      assert.ok(/-v\s+ON_ERROR_STOP=1/.test(seg),
        `${f} 구간에 -v ON_ERROR_STOP=1 이 없다: ${String(seg).trim()}`);
    });
  }

  // ── DB 준비 ────────────────────────────────────────────────────────────────
  const db = new PGlite();
  await db.exec(fs.readFileSync(BASELINE, 'utf8'));
  for (const prefix of CHAIN) {
    const f = MIG_FILES.find((x) => x.startsWith(`${prefix}_`) && x.endsWith('.sql'));
    await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
  }

  // ── DB shim 을 «먼저» 심고, 그 «다음»에 서비스를 require 한다 ──────────────
  //   뒤집으면 진짜 pg Pool 이 붙는다(계약 §10).
  // ⚠ pglite 는 `affectedRows` 를, 진짜 `pg` 는 `rowCount` 를 준다.
  //   서비스 코드는 **드라이버 정본인 `rowCount`** 를 쓴다(「몇 행을 고쳤나」를 응답에 싣는다).
  //   여기서 값을 «지어내는» 것이 아니라 **같은 값에 pg 의 이름을 붙여** 드라이버를 흉내낸다.
  //   안 붙이면 「0행 갱신을 성공이라 하지 않는다」 축이 테스트에서만 거짓 빨강이 된다.
  const q = async (text, params) => {
    const r = await db.query(text, params || []);
    if (r && r.rowCount === undefined) r.rowCount = r.affectedRows;
    return r;
  };
  const shim = {
    pool: null,
    query: q,
    transaction: async (cb) => {
      await db.exec('BEGIN');
      try {
        const r = await cb({ query: q });
        await db.exec('COMMIT');
        return r;
      } catch (e) { await db.exec('ROLLBACK'); throw e; }
    },
    healthCheck: async () => ({ status: 'healthy' }),
  };
  const dbPath = require.resolve('../src/config/database');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };

  const errorLog = [];
  const loggerPath = require.resolve('../src/config/logger');
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: {
      info: () => {}, warn: () => {}, debug: () => {},
      error: (msg, meta) => { errorLog.push({ msg, meta }); },
    },
  };

  process.env.ADMIN_TOKEN = 'S66-C6-ADMIN';
  const crowdsource = require('../src/services/crowdsourceService');
  const merge = require('../src/services/mergeService');
  const productService = require('../src/services/productService');

  // ── 관리자 라우터를 «실제로» 띄운다 ────────────────────────────────────────
  const express = require('express');
  const adminRoutes = require('../src/routes/adminRoutes');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/admin', adminRoutes);
  const server = app.listen(0);
  const port = server.address().port;

  function request(method, urlPath, body = null) {
    return new Promise((resolve, reject) => {
      const headers = { authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
      let payload = null;
      if (body !== null) {
        payload = Buffer.from(JSON.stringify(body), 'utf8');
        headers['content-type'] = 'application/json';
        headers['content-length'] = payload.length;
      }
      const req = http.request({ method, hostname: '127.0.0.1', port, path: urlPath, headers },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            let parsed = null;
            try { parsed = data ? JSON.parse(data) : null; } catch (_) { parsed = data; }
            resolve({ status: res.statusCode, body: parsed });
          });
        });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  const verify = (productId, body) => request('POST', `/api/admin/verify/${productId}`, body);

  // ── 첨가물 마스터 (승인 시 `additiveResolver` 가 교집합을 낸다) ────────────
  for (const n of ['설탕', '인산', '구연산']) {
    await db.query('INSERT INTO additives (name_ko) VALUES ($1)', [n]);
  }

  /** 제보 1건. 기본은 「멀쩡한 100g 라벨 + 원재료 + 알레르기(밀) + 첨가물」이다. */
  const report = (over = {}) => ({
    barcode: over.barcode ?? null,
    deviceId: over.deviceId ?? null,
    avgConfidence: over.avgConfidence ?? 0.95,
    productInfo: {
      product_name: over.productName ?? '분리테스트쿠키',
      food_type: '과자',
      content_unit: 'g',
      total_content: 120,
      serving_size: 30,
      ...(over.productInfo || {}),
    },
    ocrResult: { corrected_text: '원재료명: 밀가루, 설탕, 산도조절제(인산나트륨)\n밀 함유\n영양성분 100g당' },
    analysis: {
      nutrition: over.nutrition !== undefined ? over.nutrition : {
        calories: 480, sodium: 300, total_carbs: 60, total_sugars: 25,
        total_fat: 22, saturated_fat: 12, trans_fat: 0, cholesterol: 5, protein: 6,
        dietary_fiber: 2, _basis: 'per_100g',
      },
      ingredients: over.ingredients !== undefined ? over.ingredients
        : [{ name: '밀가루' }, { name: '설탕' }, { name: '산도조절제' }],
      additives: over.additives !== undefined ? over.additives
        : [{ name: '인산', category: '산도조절제', raw: '산도조절제(인산나트륨)', match_type: 'partial(main)' }],
      allergens: over.allergens !== undefined ? over.allergens : ['밀'],
      allergens_v2: over.allergensV2 !== undefined ? over.allergensV2
        : { contains: ['밀'], inferred: [], mayContain: [] },
      product_meta: {},
    },
  });

  const count = async (table, productId) => Number(
    (await db.query(`SELECT count(*)::int AS c FROM ${table} WHERE product_id = $1`, [productId]))
      .rows[0].c);
  const reviews = async (productId) => (await db.query(
    `SELECT review_id, axis, status, applied_at, reject_reason, reviewed_by
       FROM contribution_review WHERE product_id = $1 ORDER BY review_id`, [productId])).rows;

  // ══════════════════════════════════════════════════════════════════════════
  section('§1~§4  제보 1건 — 공식 테이블 0행 · 검토 큐 4축 · 원본 적립');
  // ══════════════════════════════════════════════════════════════════════════
  const r1 = await crowdsource.saveOcrContribution(report({
    barcode: 'S66C6_A', deviceId: 'dev-a1', productName: '분리테스트쿠키',
  }));
  assert.strictEqual(r1.saved, true, `제보가 반려됐다: ${r1.rejectReason}`);
  const pidA = r1.productId;

  await t('§1-1 ★★ nutrition_data 에 행이 생기지 않는다 (026 CHECK 가 DB 로도 막는다)', async () => {
    assert.strictEqual(await count('nutrition_data', pidA), 0,
      '제보가 공공 영양 테이블에 썼다 — 026 의 nutrition_data_no_crowd_chk 가 곧 이것을 거부한다');
  });
  await t('§1-2 ★★ product_ingredients 에 행이 생기지 않는다', async () => {
    assert.strictEqual(await count('product_ingredients', pidA), 0,
      '미검토 제보가 공식 원재료 테이블에 들어갔다');
  });
  await t('§1-3 ★★ product_allergens 에 행이 생기지 않는다', async () => {
    assert.strictEqual(await count('product_allergens', pidA), 0);
  });
  await t('§1-4 ★★ product_additives 에 행이 생기지 않는다', async () => {
    assert.strictEqual(await count('product_additives', pidA), 0,
      '미검토 제보의 첨가물이 공식 테이블에 들어갔다');
  });

  await t('§2-1 ★★ contribution_review 에 축별 candidate 가 생긴다', async () => {
    const rows = await reviews(pidA);
    const axes = rows.map((r) => r.axis).sort();
    assert.deepStrictEqual(axes, ['additives', 'allergens', 'ingredients', 'nutrition'],
      `축이 다르다: ${JSON.stringify(axes)}`);
    assert.ok(rows.every((r) => r.status === 'candidate'),
      `candidate 가 아닌 상태로 만들어졌다: ${JSON.stringify(rows.map((r) => r.status))}`);
    assert.ok(rows.every((r) => r.applied_at === null), 'applied_at 이 처음부터 채워져 있다');
    assert.ok(rows.every((r) => r.reviewed_by === null),
      '★ 코드가 스스로 reviewed_by 를 채웠다 — DS-1(전량 수동)의 우회로다');
  });

  await t('§2-2 ★ 응답이 만들어진 candidate 를 알려준다 (관리자 화면이 이것으로 큐를 연다)', () => {
    assert.strictEqual(r1.queued_for_review, true);
    assert.strictEqual((r1.review_candidates || []).length, 4,
      `review_candidates: ${JSON.stringify(r1.review_candidates)}`);
  });

  await t('§2-3 ★★ «빈 축»에는 candidate 를 만들지 않는다 (검토 큐가 쓰레기로 차지 않는다)', async () => {
    const r = await crowdsource.saveOcrContribution(report({
      barcode: 'S66C6_EMPTY', deviceId: 'dev-empty', productName: '알레르기없는물',
      ingredients: [], additives: [], allergens: [], allergensV2: { contains: [], inferred: [], mayContain: [] },
      productInfo: { ingredients_text: null },
    }));
    assert.strictEqual(r.saved, true, r.rejectReason);
    const axes = (await reviews(r.productId)).map((x) => x.axis);
    assert.deepStrictEqual(axes, ['nutrition'],
      `내용 없는 축까지 candidate 가 생겼다: ${JSON.stringify(axes)}`);
  });

  await t('§3 ★★ contributions 원본 적립은 그대로다 (제보가 유실되지 않는다)', async () => {
    const c = await db.query(
      `SELECT contribution_id, status, data FROM contributions WHERE product_id = $1`, [pidA]);
    assert.strictEqual(c.rows.length, 1, '원본 제보가 사라졌다 — 이번 변경이 절대 해서는 안 되는 일이다');
    assert.strictEqual(c.rows[0].status, 'pending');
    const data = typeof c.rows[0].data === 'string' ? JSON.parse(c.rows[0].data) : c.rows[0].data;
    assert.strictEqual(data.parsed_nutrition.calories, 480, '영양 원증거가 사라졌다');
    assert.ok(data.parsed_ingredients.some((i) => i.name === '밀가루'), '원재료 원증거가 사라졌다');
    assert.ok((data.allergens_v2.contains || []).includes('밀'), '알레르기 등급 원증거가 사라졌다');
    assert.ok(Array.isArray(data.additives) && data.additives.length > 0,
      '첨가물 검출 원본이 적립되지 않았다 — 승인 시 detail 스캔 결과를 재현할 수 없다');
  });

  await t('§4 ★ 제보자 «본인» 응답은 종전 그대로다 (DS-0 — 획득 훅을 죽이지 않았다)', () => {
    assert.strictEqual(r1.saved, true);
    assert.strictEqual(r1.nutrition_status, 'ok',
      `영양 파싱 결과가 응답에서 사라졌다: ${r1.nutrition_reject_code}`);
    assert.strictEqual(r1.nutrient_count, 10);
    assert.strictEqual(r1.verification, 'partial');
    assert.ok(typeof r1.message === 'string' && r1.message.length > 0);
    assert.ok(Array.isArray(r1.warnings));
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§5  ★★ U65-6 소멸 — 공공 영양은 제보 몇 번에도 안 바뀐다');
  // ══════════════════════════════════════════════════════════════════════════
  // 종전 결함: 게이트가 「기존 `data_source` 가 public_ 인가」만 봤다.
  //   제보가 한 번 `ocr_crowdsource` 로 덮으면 그 다음부터는 공공이 아니므로 **영원히 열렸다.**
  //   ⇒ 보호가 «1회용»이었다. 이제는 제보가 그 테이블을 쓰는 경로 자체가 없다.
  let pidPublic = null;
  await t('§5-0 픽스처 — 공공 영양이 있는 제품', async () => {
    const p = await db.query(
      `INSERT INTO products (barcode, product_name, food_type, serving_size, content_unit, data_source, verification)
       VALUES ('S66C6_PUB', '식약처등록라면', '유탕면', 120, 'g', 'public_c005', 'verified')
       RETURNING product_id`);
    pidPublic = Number(p.rows[0].product_id);
    await db.query(
      `INSERT INTO nutrition_data (product_id, calories, sodium, protein, data_source)
       VALUES ($1, 505, 1790, 10, 'public_nutrition')`, [pidPublic]);
  });

  await t('§5-1 ★★ 제보 5회 후에도 공공 영양값·출처가 «한 자리도» 안 바뀐다', async () => {
    for (let i = 0; i < 5; i += 1) {
      const r = await crowdsource.saveOcrContribution(report({
        barcode: 'S66C6_PUB', deviceId: `dev-pub-${i}`, productName: '식약처등록라면',
      }));
      assert.strictEqual(r.saved, true, `${i}회차 제보가 반려됐다: ${r.rejectReason}`);
    }
    const n = await db.query(
      'SELECT calories, sodium, protein, data_source FROM nutrition_data WHERE product_id = $1',
      [pidPublic]);
    assert.strictEqual(n.rows.length, 1, '영양 행 개수가 변했다');
    assert.strictEqual(Number(n.rows[0].calories), 505, '공공 열량이 제보로 덮였다');
    assert.strictEqual(Number(n.rows[0].sodium), 1790);
    assert.strictEqual(n.rows[0].data_source, 'public_nutrition',
      '★ data_source 가 바뀌었다 — 이것이 U65-6(보호가 1회용)의 시작점이었다');
  });

  await t('§5-2 ★ 그래도 제보는 5건 다 적립됐고 검토 큐에 올라갔다 (버리지 않는다)', async () => {
    const c = await db.query(
      'SELECT count(*)::int AS c FROM contributions WHERE product_id = $1', [pidPublic]);
    assert.strictEqual(c.rows[0].c, 5, '제보가 버려졌다');
    const rows = await reviews(pidPublic);
    assert.ok(rows.length >= 5, `검토 큐가 비었다: ${rows.length}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§6  ★★ U65-7 소멸 — reject 가 nutrition_data 를 한 행도 안 지운다');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§6-1 ★★ 반려해도 공공 영양 행이 그대로 있다', async () => {
    const before = await db.query('SELECT count(*)::int AS c FROM nutrition_data');
    const res = await verify(pidPublic, {
      action: 'reject', reviewed_by: 'jay', reject_reason: '사진이 흐리다',
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const after = await db.query(
      'SELECT calories, data_source FROM nutrition_data WHERE product_id = $1', [pidPublic]);
    assert.strictEqual(after.rows.length, 1,
      '★ 반려가 공공 영양 행을 지웠다 — DELETE FROM nutrition_data 가 되살아났다(U65-7)');
    assert.strictEqual(Number(after.rows[0].calories), 505);
    const total = await db.query('SELECT count(*)::int AS c FROM nutrition_data');
    assert.strictEqual(total.rows[0].c, before.rows[0].c, '전체 영양 행 수가 줄었다');
  });

  await t('§6-2 ★ 반려는 «상태 전이»로 남는다 (사유까지)', async () => {
    const rows = await reviews(pidPublic);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.status === 'rejected'),
      `반려되지 않은 행이 남았다: ${JSON.stringify(rows.map((r) => r.status))}`);
    assert.ok(rows.every((r) => r.reject_reason === '사진이 흐리다'), '반려 사유가 안 남았다');
    assert.ok(rows.every((r) => r.reviewed_by === 'jay'), '누가 반려했는지 안 남았다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§7  ★★ U65-8 소멸 — 미검토 제보가 남의 조회 결과를 안 바꾼다');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§7-1 ★★ 미검토 제보만 있는 제품은 신호등·영양이 나가지 않는다', async () => {
    const res = await productService.getProductWithTrafficLight('S66C6_A');
    assert.strictEqual(res.traffic_light, null,
      `미검토 제보로 신호등이 나갔다: ${JSON.stringify(res.traffic_light)}`);
    assert.strictEqual(res.nutrition, null,
      `미검토 제보 영양이 다른 사용자에게 나갔다: ${JSON.stringify(res.nutrition)}`);
  });

  await t('§7-2 ★★ 미검토 제보의 알레르기가 다른 사용자에게 「직접 함유」로 나가지 않는다', async () => {
    const res = await productService.getProductWithTrafficLight('S66C6_A');
    assert.strictEqual(res.allergens_available, false,
      `미검토 제보 1건이 알레르기 마스터가 됐다: ${JSON.stringify(res.allergens_v2)}`);
  });

  await t('§7-3 ★ 제품 자체는 조회된다 (제보가 헛되지 않았다)', async () => {
    const res = await productService.getProductWithTrafficLight('S66C6_A');
    assert.strictEqual(res.product.product_name, '분리테스트쿠키');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§8  approve → applyApprovedContribution 이 실제로 돈다');
  // ══════════════════════════════════════════════════════════════════════════
  let approveBody = null;
  await t('§8-1 ★★ 승인이 4축을 공식 테이블에 반영한다', async () => {
    const res = await verify(pidA, { action: 'approve', reviewed_by: 'jay' });
    approveBody = res.body;
    assert.strictEqual(res.status, 200,
      `승인이 실패했다: ${JSON.stringify(res.body && res.body.error)}`);
    assert.strictEqual(res.body.success, true);
    const applied = res.body.data.reviews.filter((r) => r.applied);
    assert.strictEqual(applied.length, 4,
      `4축이 반영되지 않았다: ${JSON.stringify(res.body.data.reviews)}`);
  });

  await t('§8-2 ★★ 영양은 nutrition_data «가 아니라» nutrition_data_crowd 로 간다 (DS-7)', async () => {
    assert.strictEqual(await count('nutrition_data', pidA), 0,
      '승인이 공공 테이블에 썼다 — 물리 분리가 깨졌다(026 CHECK 가 곧 거부한다)');
    const c = await db.query(
      `SELECT calories, basis_original, basis_stored, convert_factor, review_id
         FROM nutrition_data_crowd WHERE product_id = $1`, [pidA]);
    assert.strictEqual(c.rows.length, 1, '승인했는데 nutrition_data_crowd 행이 없다');
    assert.strictEqual(c.rows[0].basis_original, 'per_100g');
    assert.ok(c.rows[0].basis_stored, 'basis_stored 가 비었다 — NOT NULL 이 그것을 막는다');
    assert.ok(c.rows[0].review_id, '계보(review_id)가 안 남았다 — undo 가 불가능해진다');
  });

  await t('§8-3 ★ 원재료·알레르기·첨가물도 승인 시점에 반영된다', async () => {
    assert.strictEqual(await count('product_ingredients', pidA), 1, '원재료가 반영되지 않았다');
    assert.ok(await count('product_allergens', pidA) >= 1, '알레르기가 반영되지 않았다');
    const add = await db.query(
      `SELECT a.name_ko, pa.detected_name FROM product_additives pa
         JOIN additives a ON a.additive_id = pa.additive_id
        WHERE pa.product_id = $1 ORDER BY a.name_ko`, [pidA]);
    const names = add.rows.map((x) => x.name_ko);
    assert.ok(names.includes('인산'),
      `★ 검출 축(identifyAdditives)이 승인 경로에서 사라졌다: ${JSON.stringify(names)} — `
      + '세션65 C1 이 66.1% 소실로 실측한 그 축이다');
    assert.ok(names.includes('설탕'),
      `★ 원재료명 완전일치 축이 승인 경로에서 사라졌다: ${JSON.stringify(names)}`);
  });

  await t('§8-4 ★★ data_inspection 에 축별 검사 기록이 남는다 (U63-6 의 자리)', async () => {
    const di = await db.query(
      `SELECT axis, source_kind, found_count FROM data_inspection
        WHERE product_id = $1 ORDER BY axis`, [pidA]);
    assert.strictEqual(di.rows.length, 4, `검사 기록이 4행이 아니다: ${JSON.stringify(di.rows)}`);
    assert.ok(di.rows.every((r) => r.source_kind === 'ocr_label'));
    assert.ok(di.rows.every((r) => r.found_count !== null),
      '★ found_count 가 null 이다 — 「봤는데 없었다(0)」와 「안 봤다(행 없음)」의 구분이 무너진다');
  });

  await t('§8-5 ★ 승인 실패 코드는 «삼켜지지 않고» 관리자에게 그대로 간다', async () => {
    // 기준을 못 읽은 영양 제보 → contributionApply 가 BASIS_UNKNOWN 을 던진다.
    // ⚠ 저장 게이트가 그런 제보의 nutrition candidate 를 애초에 안 만들므로,
    //   candidate 를 «직접» 만들어 관리자 경로만 검사한다.
    const p = await db.query(
      `INSERT INTO products (barcode, product_name, data_source)
       VALUES ('S66C6_BADBASIS', '기준불명', 'ocr_crowdsource') RETURNING product_id`);
    const pid = Number(p.rows[0].product_id);
    const c = await db.query(
      `INSERT INTO contributions (product_id, contribution_type, data, status)
       VALUES ($1, 'ocr_nutrition', $2, 'pending') RETURNING contribution_id`,
      [pid, JSON.stringify({ parsed_nutrition: { calories: 100 } })]);   // ← _basis 가 없다
    await db.query(
      `INSERT INTO contribution_review (contribution_id, product_id, axis, status)
       VALUES ($1, $2, 'nutrition', 'candidate')`,
      [Number(c.rows[0].contribution_id), pid]);

    const res = await verify(pid, { action: 'approve', reviewed_by: 'jay' });
    assert.strictEqual(res.status, 409,
      `실패를 성공으로 보고했다: ${res.status} ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.success, false);
    const codes = (res.body.error.details || []).map((d) => d.code);
    assert.ok(codes.includes('BASIS_UNKNOWN'),
      `관리자에게 원인 코드가 안 갔다: ${JSON.stringify(res.body.error)}`);
    // ★ 「보류」다 — 승인은 남고 반영만 안 됐다(024 의 applied_at IS NULL 의 뜻).
    const rv = await reviews(pid);
    assert.strictEqual(rv[0].status, 'approved', '실패했다고 승인이 취소됐다 — 보류가 아니라 거절이 됐다');
    assert.strictEqual(rv[0].applied_at, null);
    assert.strictEqual(await count('nutrition_data_crowd', pid), 0, '추정값이 저장됐다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§9  undo → 되돌아간다 · reopen → candidate 로 돌아간다');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§9-1 ★★ undo 가 그 제보가 넣은 것을 되돌린다', async () => {
    const res = await verify(pidA, { action: 'undo', reviewed_by: 'jay' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(await count('nutrition_data_crowd', pidA), 0, '영양이 안 되돌려졌다');
    assert.strictEqual(await count('product_ingredients', pidA), 0, '원재료가 안 되돌려졌다');
    assert.strictEqual(await count('product_additives', pidA), 0, '첨가물이 안 되돌려졌다');
    const rows = await reviews(pidA);
    assert.ok(rows.every((r) => r.status === 'undone'),
      `상태가 undone 이 아니다: ${JSON.stringify(rows.map((r) => r.status))}`);
    assert.ok(rows.every((r) => r.applied_at === null), 'applied_at 이 남아 있다');
  });

  await t('§9-2 ★ reopen 이 candidate 로 되돌린다 (reviewActions 4큐와 같은 어휘)', async () => {
    const res = await verify(pidA, { action: 'reopen', reviewed_by: 'jay' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const rows = await reviews(pidA);
    assert.ok(rows.every((r) => r.status === 'candidate'),
      `reopen 후 상태: ${JSON.stringify(rows.map((r) => r.status))}`);
  });

  await t('§9-3 ★ 반영된 채로는 reopen 되지 않는다 (「검토 대기인데 데이터는 나가 있다」 금지)', async () => {
    await verify(pidA, { action: 'approve', reviewed_by: 'jay' });   // 다시 반영
    const res = await verify(pidA, { action: 'reopen', reviewed_by: 'jay' });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    const codes = (res.body.error.details || []).map((d) => d.code);
    assert.ok(codes.includes('UNDO_REQUIRED_BEFORE_REOPEN'), JSON.stringify(res.body.error));
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§10 ★★ 3기기 병합도 «자동 반영»이 아니다 (설계 §3-2 · 예외 없음)');
  // ══════════════════════════════════════════════════════════════════════════
  let pidMerge = null;
  await t('§10-0 픽스처 — 같은 제품에 서로 다른 기기 3대의 제보', async () => {
    const p = await db.query(
      `INSERT INTO products (barcode, product_name, food_type, serving_size, content_unit, data_source)
       VALUES ('S66C6_MERGE', '병합대상쿠키', '과자', 30, 'g', 'ocr_crowdsource')
       RETURNING product_id`);
    pidMerge = Number(p.rows[0].product_id);
    for (const dev of ['m-a', 'm-b', 'm-c']) {
      await db.query(
        `INSERT INTO contributions (product_id, contribution_type, data, status, device_id)
         VALUES ($1, 'ocr_nutrition', $2, 'pending', $3)`,
        [pidMerge, JSON.stringify({
          parsed_nutrition: {
            calories: 480, sodium: 300, protein: 6, total_fat: 22, _basis: 'per_100g',
          },
          parsed_ingredients: [{ name: '밀가루' }, { name: '설탕' }],
          allergens: ['밀'],
          allergens_v2: { contains: ['밀'], inferred: [], mayContain: [] },
          user_input: { product_name: '병합대상쿠키' },
          device_id: dev, avg_confidence: 0.95,
        }), dev]);
    }
  });

  await t('§10-1 ★★ 병합이 공식 테이블에 «한 행도» 쓰지 않는다', async () => {
    const res = await merge.mergeAndApply(pidMerge);
    assert.strictEqual(res.applied, true, '병합 자체가 안 돌았다');
    assert.strictEqual(await count('nutrition_data', pidMerge), 0,
      '★ 기기 3대 병합이 영양을 자동 반영했다 — 전량 수동에 예외가 없다(설계 §3-2)');
    assert.strictEqual(await count('product_ingredients', pidMerge), 0);
    assert.strictEqual(await count('product_allergens', pidMerge), 0);
    assert.strictEqual(await count('product_additives', pidMerge), 0);
  });

  await t('§10-2 ★★ 대신 병합 «판정»이 evidence 에 실린 candidate 가 생긴다', async () => {
    const rows = await db.query(
      `SELECT axis, status, evidence FROM contribution_review WHERE product_id = $1 ORDER BY axis`,
      [pidMerge]);
    const axes = rows.rows.map((r) => r.axis).sort();
    assert.deepStrictEqual(axes, ['additives', 'allergens', 'ingredients', 'nutrition'], JSON.stringify(axes));
    const nut = rows.rows.find((r) => r.axis === 'nutrition');
    const ev = typeof nut.evidence === 'string' ? JSON.parse(nut.evidence) : nut.evidence;
    assert.strictEqual(ev.origin, 'merge');
    assert.strictEqual(ev.distinct_device_count, 3,
      '★ 「기기 3대가 일치했다」는 판정이 사라졌다 — 관리자가 무엇을 보고 승인하나');
    assert.strictEqual(Number(ev.merged_nutrition.calories), 480,
      `median 판정 결과가 안 실렸다: ${JSON.stringify(ev.merged_nutrition)}`);
    assert.ok(Array.isArray(ev.source_contribution_ids) && ev.source_contribution_ids.length === 3);
  });

  await t('§10-3 ★ 병합을 다시 돌려도 candidate 가 늘지 않는다 (큐가 쌓이지 않는다)', async () => {
    const before = (await reviews(pidMerge)).length;
    await merge.mergeAndApply(pidMerge);
    await merge.mergeAndApply(pidMerge);
    const after = (await reviews(pidMerge)).length;
    assert.strictEqual(after, before, `병합 2회로 검토 큐가 ${before} → ${after} 로 늘었다`);
  });

  await t('§10-4 ★ 병합 «판정» 자체(median·기기 수·verification)는 그대로 살아 있다', async () => {
    const res = await merge.mergeAndApply(pidMerge);
    assert.strictEqual(res.distinctDeviceCount, 3);
    assert.strictEqual(res.verification, 'verified',
      `승격 판정이 사라졌다: ${res.verification} — U66-1(products 수명주기)은 이번 범위가 아니다`);
    assert.strictEqual(Number(res.merged.nutrition.calories), 480);
  });

  await t('§10-5 ★★ 병합이 «다른 출처의» 알레르기 행을 지우지 않는다 (경고 순감 방지)', async () => {
    for (const n of ['대두', '우유']) {
      await db.query(
        `INSERT INTO product_allergens (product_id, allergen_name, status, detected_via, evidence_level)
         VALUES ($1, $2, 'confirmed', 'haccp_api', 'contains')`, [pidMerge, n]);
    }
    await merge.mergeAndApply(pidMerge);
    const rows = await db.query(
      `SELECT allergen_name FROM product_allergens WHERE product_id = $1 ORDER BY allergen_name`,
      [pidMerge]);
    assert.deepStrictEqual(rows.rows.map((r) => r.allergen_name), ['대두', '우유'],
      '★ 병합이 식약처 알레르기를 지웠다 — DELETE ... crowdsource_merge 가 되살아났다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§11 correct — corrections 없이 success:true 가 나가지 않는다');
  // ══════════════════════════════════════════════════════════════════════════
  await t("§11-1 ★★ action='correct' + corrections 없음 → 400 (조용한 무동작 금지)", async () => {
    for (const body of [
      { action: 'correct' },
      { action: 'correct', corrections: null },
      { action: 'correct', corrections: {} },
      { action: 'correct', corrections: [] },
    ]) {
      const res = await verify(pidPublic, body);
      assert.strictEqual(res.status, 400,
        `corrections=${JSON.stringify(body.corrections)} 인데 ${res.status} 가 나갔다: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.error.code, 'CORRECTIONS_REQUIRED');
    }
  });

  await t('§11-2 ★ 정상 correct 는 공공 영양 행을 실제로 고치고 «몇 행»인지 돌려준다', async () => {
    const res = await verify(pidPublic, {
      action: 'correct', reviewed_by: 'jay', corrections: { nutrition: { calories: 500 } },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.data.nutritionCorrectedRows, 1);
    const n = await db.query('SELECT calories FROM nutrition_data WHERE product_id = $1', [pidPublic]);
    assert.strictEqual(Number(n.rows[0].calories), 500);
  });

  await t('§11-3 ★ 고칠 공공 행이 없으면 그 사실을 말한다 (0행 갱신을 성공이라 하지 않는다)', async () => {
    const res = await verify(pidMerge, {
      action: 'correct', reviewed_by: 'jay', corrections: { nutrition: { calories: 111 } },
    });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    const codes = (res.body.error.details || []).map((d) => d.code);
    assert.ok(codes.includes('NO_PUBLIC_NUTRITION_ROW'), JSON.stringify(res.body.error));
  });

  await t('§11-4 알 수 없는 action 은 400 이다', async () => {
    const res = await verify(pidA, { action: 'delete_everything' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, 'INVALID_ACTION');
  });

  server.close();

  // ══════════════════════════════════════════════════════════════════════════
  section('§12 ★ 024 «미적용» DB 에서도 제보가 죽지 않는다 (배포순서 방어)');
  // ══════════════════════════════════════════════════════════════════════════
  // 세션45 치명1 과 같은 형태의 사고를 다시 열지 않는다:
  //   쓰기 경로에 가드가 없으면 테이블 부재 예외가 **트랜잭션 전체를 롤백**하고,
  //   호출부가 그것을 삼켜 API 는 조용히 실패한다.
  await t('§12-1 ★★ contribution_review 가 없어도 제보는 저장되고 500 이 아니다', async () => {
    const db2 = new PGlite();
    await db2.exec(fs.readFileSync(BASELINE, 'utf8'));   // ← 023~026 을 적용하지 «않는다»
    const shim2 = {
      pool: null,
      query: (text, params) => db2.query(text, params || []),
      transaction: async (cb) => {
        await db2.exec('BEGIN');
        try {
          const r = await cb({ query: (tx, p) => db2.query(tx, p || []) });
          await db2.exec('COMMIT');
          return r;
        } catch (e) { await db2.exec('ROLLBACK'); throw e; }
      },
      healthCheck: async () => ({ status: 'healthy' }),
    };
    const saved = require.cache[dbPath];
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim2 };
    for (const p of ['../src/services/crowdsourceService', '../src/services/mergeService',
      '../src/services/additiveResolver', '../src/models/productModel',
      '../src/services/productService']) {
      delete require.cache[require.resolve(p)];
    }
    try {
      const fresh = require('../src/services/crowdsourceService');
      const r = await fresh.saveOcrContribution(report({
        barcode: 'S66C6_NO024', deviceId: 'dev-no024', productName: '024미적용제보',
      }));
      assert.strictEqual(r.saved, true, `024 미적용 DB 에서 제보가 반려됐다: ${r.rejectReason}`);
      assert.strictEqual(r.queued_for_review, false, '테이블이 없는데 큐에 넣었다고 말했다');
      const c = await db2.query(
        'SELECT count(*)::int AS c FROM contributions WHERE product_id = $1', [r.productId]);
      assert.strictEqual(c.rows[0].c, 1, '★ 원본 제보까지 사라졌다 — 조용한 전멸이다');
      assert.ok(errorLog.some((l) => /024 미적용/.test(l.msg || '')),
        '024 미적용 상태가 로그에 남지 않았다 — 운영에서 아무도 모른다');
    } finally {
      require.cache[dbPath] = saved;
      for (const p of ['../src/services/crowdsourceService', '../src/services/mergeService',
        '../src/services/additiveResolver', '../src/models/productModel',
        '../src/services/productService']) {
        delete require.cache[require.resolve(p)];
      }
      await db2.close();
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(` 결과: 통과 ${pass} · 실패 ${fail}`);
  if (fail > 0) {
    console.log('\n실패 상세:');
    for (const f of failures) console.log(`  - ${f.name}\n    ${f.message}`);
  }
  console.log('════════════════════════════════════════════════════════════════\n');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('테스트 실행 오류:', e);
  process.exit(1);
});
