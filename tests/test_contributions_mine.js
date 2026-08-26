/**
 * test_contributions_mine.js — 세션64c «내 제보 이력» 축 회귀
 * ============================================================================
 * ★★ 세션64c 인증 전환(제이 확정 2026-08-24: 「제보도 로그인 필수」) 이후 판이다.
 *   초판은 `?device_id=<uuid>` 를 열쇠로 썼고 **인증이 아예 없었다**. 이제 열쇠는
 *   **Supabase 토큰**이다. 「토큰이 없다/틀렸다」 자체의 회귀는 `test_supabase_auth.js` 가
 *   전담한다 — 여기서는 **목록의 의미**(격리·페이징·LEFT JOIN·개인정보·status)를 지킨다.
 *
 * 무엇을 지키는가
 *   ① `GET /api/contributions/mine` — 인증 필수 · 정상 조회 · 페이징 ·
 *      limit 상한 · **남의 제보가 섞이지 않음** · 제품이 아직 없는 제보
 *   ② **개인정보가 응답에 실리지 않는다** — `contributions.data`(OCR 원문·사용자 입력·device_id)
 *      가 통째로 새는 것이 이 엔드포인트의 가장 큰 위험이다.
 *   ③ `POST /api/ocr/confirm` — **기기 식별자는 토큰이 정본**이다(바코드와 같은 원칙).
 *      본문 값이 토큰 값을 이기면 24시간 중복 게이트 우회 · 1기기의 자동 verified 자작극 ·
 *      남의 이력 오염이 전부 열린다.
 *   ④ 「제보가 0건」과 「로그인 안 함」이 **다른 응답**이다(200 빈 목록 vs 401).
 *
 * ★ 소스 문자열을 한 글자도 읽지 않는다. pglite(진짜 Postgres/wasm)에
 *   `000_baseline.sql` 정본을 적용하고, 실제 라우터를 HTTP 로 불러 나온 응답과
 *   DB 에 실제로 박힌 행만 단정한다. (세션48 4차 검증: 소스 정규식 검사는 뚫렸다.)
 * ★★ Google Vision 을 부르지 않는다. `ocrService` 를 require.cache 에서 스텁으로 갈아끼운다.
 *
 * 실행: cross-env NODE_ENV=test node tests/test_contributions_mine.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');

const SRV = path.join(__dirname, '..');
const BASELINE = path.join(SRV, 'scripts', 'migrations', '000_baseline.sql');
const MIG_021 = path.join(SRV, 'scripts', 'migrations', '021_supabase_auth.sql');

// ★ 테스트 전용 비밀. 실제 값과 아무 관계 없다.
const SECRET = 'test-supabase-jwt-secret-0123456789';
process.env.SUPABASE_JWT_SECRET = SECRET;

// Supabase user id 는 UUID 문자열이다(@supabase/auth-js types.d.ts:1622 의 `sub`).
const UID_A = '3f1c2a5e-9b47-4d81-a2f3-6c0e5d8b1a24';
const UID_B = 'c4d9e7b1-2a68-4f30-9c5d-8b7a6e1f3d02';
const UID_EMPTY = '00000000-1111-4222-8333-999999999999';  // 제보 0건인 «정상» 사용자

/** 실제 Supabase access token 과 같은 클레임 구조로 만든다. */
function makeToken(sub, email) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({
    iss: 'https://lrnuqhpgyuizfggxgxpl.supabase.co/auth/v1',
    sub, aud: 'authenticated', role: 'authenticated', aal: 'aal1',
    session_id: 'ffffffff-1111-4222-8333-444444444444',
    email, iat: now, exp: now + 3600,
  }, SECRET, { algorithm: 'HS256', noTimestamp: true });
}
const TOKEN_A = makeToken(UID_A, 'a@example.com');
const TOKEN_B = makeToken(UID_B, 'b@example.com');
const TOKEN_EMPTY = makeToken(UID_EMPTY, 'empty@example.com');
const bearer = (tok) => (tok ? { authorization: `Bearer ${tok}` } : {});

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

// 실제 앱이 만드는 것과 같은 모양의 UUID v4 문자열
const DEV_A = '11111111-2222-4333-8444-555555555555';
const DEV_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DEV_EMPTY = '99999999-8888-4777-a666-555555555000'; // 제보 0건인 기기

const LABEL_WITH_NAME = [
  '제품명: 초코칩쿠키',
  '식품유형: 과자',
  '원재료명: 밀가루(밀:미국산), 설탕, 초콜릿가공품, 마가린, 정제수',
  '우유, 대두, 밀 함유',
  '내용량 120g',
].join('\n');

const NUTRITION_ONLY = [
  '영양성분 100g당', '열량 480kcal', '나트륨 300mg', '탄수화물 60g',
  '당류 25g', '지방 22g', '포화지방 12g', '트랜스지방 0g',
  '콜레스테롤 5mg', '단백질 6g',
].join('\n');

function buildMultipart(fields, files) {
  const boundary = '----meokseonS64cBoundary' + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  }
  for (const [name, buf] of Object.entries(files)) {
    if (!buf) continue;
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}.jpg"\r\n`
      + 'Content-Type: image/jpeg\r\n\r\n', 'utf8'));
    chunks.push(buf);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(' 세션64c — 내 제보 이력 (GET /api/contributions/mine · device_id 정본)');
  console.log('════════════════════════════════════════════════════════════════');

  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (_) {
    console.log('⏭  pglite 미설치 — 조회 경로를 검증할 수 없다 (npm i -D @electric-sql/pglite)');
    console.log('   ★ 이 테스트의 목적상 「건너뜀」은 「통과」가 아니다. EXIT=1 로 남긴다.');
    process.exit(1);
  }

  const pg = new PGlite();
  try {
    await pg.exec(fs.readFileSync(BASELINE, 'utf8'));
    // ★ 세션64c — 인증 전환 마이그레이션. 정본 SQL 을 «가공하지 않고» 그대로 적용한다.
    await pg.exec(fs.readFileSync(MIG_021, 'utf8'));
  } catch (e) {
    console.error(`000_baseline.sql 적용 실패 — 픽스처가 아니라 정본 SQL 문제다: ${e.message}`);
    process.exit(1);
  }

  const shim = {
    pool: null,
    query: (text, params) => pg.query(text, params || []),
    transaction: async (cb) => {
      await pg.exec('BEGIN');
      try {
        const r = await cb({ query: (tx, p) => pg.query(tx, p || []) });
        await pg.exec('COMMIT');
        return r;
      } catch (e) { await pg.exec('ROLLBACK'); throw e; }
    },
    healthCheck: async () => ({ status: 'healthy' }),
  };
  const dbPath = require.resolve('../src/config/database');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };

  // ── Vision 스텁 (유료 API 를 절대 부르지 않는다) ────────────────────────
  const visionQueue = [];
  const ocrSvcPath = require.resolve('../src/services/ocrService');
  require.cache[ocrSvcPath] = {
    id: ocrSvcPath, filename: ocrSvcPath, loaded: true,
    exports: {
      callVisionAPI: async () => ({
        full_text: visionQueue.length ? visionQueue.shift() : '',
        avg_confidence: 0.95, block_count: 3, elapsed_ms: 1,
      }),
      correctOcrText: (txt) => ({ corrected: txt, corrections: [] }),
    },
  };

  // ── logger 스텁 ── 「경고 로그를 남긴다」는 계약이다(§3 이 그것을 단정한다).
  const warnLog = [];
  const loggerPath = require.resolve('../src/config/logger');
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: {
      warn: (msg, meta) => { warnLog.push({ msg, meta }); },
      info: () => {}, error: () => {}, debug: () => {},
    },
  };

  const express = require('express');
  const ocrRoutes = require('../src/routes/ocrRoutes');
  const contributionRoutes = require('../src/routes/contributionRoutes');
  const { errorHandler } = require('../src/middleware/errorHandler');
  const db = require('../src/config/database');

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/ocr', ocrRoutes);
  app.use('/api/contributions', contributionRoutes);
  app.use(errorHandler);
  const server = app.listen(0);
  const port = server.address().port;

  function request(method, urlPath, { headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
      const h = { ...headers };
      let payload = null;
      if (Buffer.isBuffer(body)) {
        payload = body;
        h['content-length'] = body.length;
      } else if (body !== null) {
        payload = Buffer.from(JSON.stringify(body), 'utf8');
        h['content-type'] = 'application/json';
        h['content-length'] = payload.length;
      }
      const req = http.request({ method, hostname: '127.0.0.1', port, path: urlPath, headers: h },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            let parsed = null;
            try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
            resolve({ status: res.statusCode, body: parsed, raw: data });
          });
        });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ★ 열쇠가 «토큰»이다. 두 번째 인자는 페이징 등 부가 쿼리뿐이다.
  const mine = (tok, qs = '') => request('GET', `/api/contributions/mine${qs}`,
    { headers: bearer(tok) });

  async function callMultiPhoto({ save, productInfo, barcode, deviceId, token = TOKEN_A }) {
    visionQueue.length = 0;
    visionQueue.push(LABEL_WITH_NAME, NUTRITION_ONLY);
    const files = { label_image: Buffer.from('fakejpeg-label'), nutrition_image: Buffer.from('fakejpeg-nut') };
    const fields = {};
    if (save !== undefined) fields.save = String(save);
    if (barcode !== undefined) fields.barcode = barcode;
    if (deviceId !== undefined) fields.device_id = deviceId;
    if (productInfo !== undefined) fields.product_info = JSON.stringify(productInfo);
    const { body, contentType } = buildMultipart(fields, files);
    return request('POST', '/api/ocr/multi-photo',
      { headers: { 'content-type': contentType, ...bearer(token) }, body });
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('§0. 픽스처 — 두 «사용자»의 제보를 실제 행으로 심는다');
  // ══════════════════════════════════════════════════════════════════════════
  // ★ 제품 2개 + 제품이 «아직 없는» 제보 1건. 마지막 것이 LEFT JOIN 을 지키는 축이다.
  const p1 = await db.query(
    `INSERT INTO products (barcode, product_name, data_source, verification, verify_count)
     VALUES ('8801111111111', '초코칩쿠키', 'ocr_crowdsource', 'unverified', 0)
     RETURNING product_id`);
  const p2 = await db.query(
    `INSERT INTO products (barcode, product_name, data_source, verification, verify_count)
     VALUES ('8802222222222', '콜라맛탄산음료', 'ocr_crowdsource', 'unverified', 0)
     RETURNING product_id`);
  const P1 = p1.rows[0].product_id;
  const P2 = p2.rows[0].product_id;

  // ★ 세션64c — 이제 목록의 열쇠는 **users.user_id(BIGINT)** 다.
  //   supabase_uid(UUID 문자열)를 contributions.user_id 에 직접 넣으면 [22P02] 로 죽는다.
  const uA = await db.query(
    "INSERT INTO users (supabase_uid, email) VALUES ($1, 'a@example.com') RETURNING user_id", [UID_A]);
  const uB = await db.query(
    "INSERT INTO users (supabase_uid, email) VALUES ($1, 'b@example.com') RETURNING user_id", [UID_B]);
  const U_A = Number(uA.rows[0].user_id);
  const U_B = Number(uB.rows[0].user_id);

  // 사용자 A: 3건 (그중 1건은 product_id NULL) · 사용자 B: 1건
  //   created_at 을 명시해 정렬을 결정적으로 만든다(같은 초에 몰리면 순서가 흔들린다).
  const seed = [
    // [user_id, device, product_id, created_at, nutrition_status, 개인정보를 잔뜩 담은 data]
    [U_A, DEV_A, P1, '2026-08-20 10:00:00+00', 'ok'],
    [U_A, DEV_A, P2, '2026-08-21 10:00:00+00', 'incomplete'],
    [U_A, DEV_A, null, '2026-08-22 10:00:00+00', null],
    [U_B, DEV_B, P1, '2026-08-22 11:00:00+00', 'ok'],
  ];
  for (const [uid, dev, pid, ts, ns] of seed) {
    await db.query(
      `INSERT INTO contributions (user_id, product_id, contribution_type, data, status, device_id, created_at)
       VALUES ($5, $1, 'ocr_nutrition', $2, 'pending', $3, $4)`,
      [
        pid,
        JSON.stringify({
          // ⚠ 아래는 전부 **응답에 나오면 안 되는 것들**이다.
          ocr_raw_text: '원재료명: 밀가루, 설탕 ... 비밀원문 SECRET_OCR_TEXT',
          device_id: dev,
          user_input: { product_name: '초코칩쿠키', manufacturer: 'SECRET_MFR' },
          allergens: ['우유', '대두'],
          avg_confidence: 0.93,
          nutrition_status: ns,
        }),
        dev, ts, uid,
      ]
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('§1. 401 — 「로그인 안 함」은 「제보 0건」이 아니다');
  // ══════════════════════════════════════════════════════════════════════════
  // ★ 토큰 검증 자체(위조·만료·alg none·anon key)는 `test_supabase_auth.js` 가 전담한다.
  //   여기서는 **이 엔드포인트의 계약**만 본다: 401 과 「빈 목록 200」이 다른 응답인가.
  await t('★★★ 토큰이 없으면 401 이다 (빈 목록 200 이 아니다)', async () => {
    const r = await mine(null);
    assert.strictEqual(r.status, 401, `401 이 아니다: ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.success, false);
    assert.strictEqual(r.body.error.code, 'AUTH_REQUIRED');
    assert.ok(!r.body.data, '401 인데 data 가 실렸다 — 앱이 빈 목록으로 오독한다');
  });

  await t('★★★ `?device_id=` 만 보내는 «구버전 앱» 요청도 401 이다 (뒷문이 없다)', async () => {
    // 초판의 열쇠였다. 인증 없이 이 값만으로 남의 이력이 나오던 경로를 완전히 닫았다.
    const r = await request('GET', `/api/contributions/mine?device_id=${DEV_A}`);
    assert.strictEqual(r.status, 401,
      `device_id 만으로 조회가 됐다 — 인증 우회 뒷문이 남아 있다: ${r.status} ${JSON.stringify(r.body)}`);
  });

  await t('★ 401 사유는 앱이 그대로 보여줄 수 있는 한국어다 (기술 용어 금지)', async () => {
    const r = await mine(null);
    assert.ok(/[가-힣]/.test(r.body.error.message), `한국어 문장이 아니다: ${r.body.error.message}`);
    assert.ok(!/UUID|uuid|regex|SQL|JWT|token|null/i.test(r.body.error.message),
      `기술 용어가 사용자에게 나간다: ${r.body.error.message}`);
  });

  await t('★★★ 제보가 0건인 «정상» 사용자는 200 + 빈 목록이다 (401 과 구분된다)', async () => {
    const r = await mine(TOKEN_EMPTY);
    assert.strictEqual(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.success, true);
    assert.deepStrictEqual(r.body.data.items, []);
    assert.strictEqual(r.body.data.total, 0);
    assert.strictEqual(typeof r.body.data.total, 'number', 'total 이 숫자가 아니다 — 앱의 「더 보기」 판단이 깨진다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§2. 정상 조회 · 격리 · 페이징 · 상한');
  // ══════════════════════════════════════════════════════════════════════════
  await t('★★★ 내 제보만 나온다 — 남의 제보가 섞이지 않는다', async () => {
    const a = await mine(TOKEN_A);
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    assert.strictEqual(a.body.data.total, 3, `A 총계가 3 이 아니다: ${a.body.data.total}`);
    assert.strictEqual(a.body.data.items.length, 3);

    const b = await mine(TOKEN_B);
    assert.strictEqual(b.body.data.total, 1, `B 총계가 1 이 아니다: ${b.body.data.total}`);

    const aIds = new Set(a.body.data.items.map((x) => x.contribution_id));
    for (const it of b.body.data.items) {
      assert.ok(!aIds.has(it.contribution_id),
        `B 의 제보가 A 목록에 있다 — 사용자 격리가 깨졌다: ${it.contribution_id}`);
    }
  });

  await t('최신순이다 (created_at DESC)', async () => {
    const r = await mine(TOKEN_A);
    const times = r.body.data.items.map((x) => new Date(x.created_at).getTime());
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i - 1] >= times[i], `최신순이 아니다: ${JSON.stringify(r.body.data.items.map((x) => x.created_at))}`);
    }
  });

  await t('★ 계약된 필드가 전부 실린다 (앱이 화면을 그릴 수 있다)', async () => {
    const r = await mine(TOKEN_A);
    for (const it of r.body.data.items) {
      for (const k of ['contribution_id', 'created_at', 'barcode', 'product_name',
        'status', 'nutrition_status', 'product_id']) {
        assert.ok(k in it, `계약 필드 \`${k}\` 가 없다: ${JSON.stringify(it)}`);
      }
      assert.strictEqual(typeof it.contribution_id, 'number',
        `contribution_id 가 숫자가 아니다(bigint 문자열): ${JSON.stringify(it.contribution_id)}`);
    }
    const withProduct = r.body.data.items.find((x) => x.barcode === '8801111111111');
    assert.ok(withProduct, '제품이 붙은 제보를 못 찾았다');
    assert.strictEqual(withProduct.product_name, '초코칩쿠키');
    assert.strictEqual(typeof withProduct.product_id, 'number', 'product_id 가 숫자가 아니다 — 앱이 이동 못 한다');
    assert.strictEqual(withProduct.nutrition_status, 'ok');
    assert.strictEqual(withProduct.status, 'pending');
  });

  await t('★★★ 제품이 아직 없는 제보도 «사라지지 않는다» (LEFT JOIN — INNER 면 없어진다)', async () => {
    const r = await mine(TOKEN_A);
    const orphan = r.body.data.items.find((x) => x.product_id === null);
    assert.ok(orphan, `product_id 가 없는 제보가 목록에서 사라졌다: ${JSON.stringify(r.body.data.items)}`);
    assert.strictEqual(orphan.barcode, null, '제품이 없는데 바코드가 실렸다');
    assert.strictEqual(orphan.product_name, null, '제품이 없는데 제품명이 실렸다');
    assert.strictEqual(orphan.status, 'pending', '상태는 제품 유무와 무관하게 실려야 한다');
  });

  await t('★ 페이징 — limit/offset 이 실제로 잘라내고, 겹치지 않는다', async () => {
    const p0 = await mine(TOKEN_A, '?limit=2&offset=0');
    const p1x = await mine(TOKEN_A, '?limit=2&offset=2');
    assert.strictEqual(p0.body.data.items.length, 2, `1페이지가 2건이 아니다: ${p0.body.data.items.length}`);
    assert.strictEqual(p1x.body.data.items.length, 1, `2페이지가 1건이 아니다: ${p1x.body.data.items.length}`);
    // ★ total 은 «페이지»가 아니라 «전체»다. 이 값으로 앱이 「더 보기」를 띄운다.
    assert.strictEqual(p0.body.data.total, 3, 'total 이 페이지 크기로 줄었다 — 「더 보기」가 사라진다');
    assert.strictEqual(p1x.body.data.total, 3);
    const ids0 = p0.body.data.items.map((x) => x.contribution_id);
    const ids1 = p1x.body.data.items.map((x) => x.contribution_id);
    assert.ok(!ids1.some((id) => ids0.includes(id)),
      `페이지가 겹친다(정렬 tie-breaker 없음): ${JSON.stringify([ids0, ids1])}`);
  });

  await t('offset 이 전체보다 크면 빈 목록이고 total 은 그대로다', async () => {
    const r = await mine(TOKEN_A, '?limit=20&offset=999');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.data.items, []);
    assert.strictEqual(r.body.data.total, 3);
  });

  await t('★★★ limit 상한(50)이 있다 — 무한 조회를 막는다', async () => {
    for (const q of ['limit=999999', 'limit=51', 'limit=100']) {
      const r = await mine(TOKEN_A, `?${q}`);
      assert.strictEqual(r.status, 200, `${q} 가 200 이 아니다: ${r.status}`);
      assert.ok(r.body.data.limit <= 50,
        `상한이 없다 — ${q} 로 limit=${r.body.data.limit} 이 통과했다`);
    }
  });

  await t('limit 이 0/음수여도 최소 1로 깎인다 (0 은 빈 목록과 구분이 안 된다)', async () => {
    const zero = await mine(TOKEN_A, '?limit=0');
    assert.strictEqual(zero.status, 200, JSON.stringify(zero.body));
    assert.ok(zero.body.data.items.length >= 1, 'limit=0 이 빈 목록을 만들었다 — 「제보 없음」과 구분이 안 된다');
  });

  await t('숫자가 아닌 limit/offset 은 400 이다 (조용히 0 이 되지 않는다)', async () => {
    for (const q of ['limit=abc', 'offset=abc', 'limit=-1', 'offset=-5', 'limit=1.5']) {
      const r = await mine(TOKEN_A, `?${q}`);
      assert.strictEqual(r.status, 400, `${q} 가 400 이 아니다: ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.error.code, 'PAGINATION_INVALID');
    }
  });

  await t('limit/offset 을 안 보내면 기본값(20 / 0)으로 돈다', async () => {
    const r = await mine(TOKEN_A);
    assert.strictEqual(r.body.data.limit, 20);
    assert.strictEqual(r.body.data.offset, 0);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§3. ★★★ 개인정보가 응답에 실리면 안 된다');
  // ══════════════════════════════════════════════════════════════════════════
  // ★ 세션64c 부터 인증이 걸렸지만 그것이 **유출을 막아주지는 않는다** — 본인이 자기 응답에서
  //   OCR 원문·기기 식별자를 보는 것도 유출이고, 로그·캐시·공유 스크린샷으로 흘러간다.
  //   `contributions.data` 를 통째로 내보내는 순간 전부 함께 샌다.
  await t('★★★ 응답 원문에 OCR 원문·사용자 입력·device_id 가 «한 글자도» 없다', async () => {
    const r = await mine(TOKEN_A);
    const raw = r.raw;
    for (const leak of ['SECRET_OCR_TEXT', 'SECRET_MFR', 'ocr_raw_text', 'user_input',
      'avg_confidence', 'device_id', DEV_A, DEV_B, UID_A, UID_B, 'user_id']) {
      assert.ok(!raw.includes(leak),
        `응답에 «${leak}» 가 실렸다 — data 컬럼이 통째로 새고 있다`);
    }
  });

  await t('★ 각 항목의 키가 «계약된 7개»뿐이다 (SELECT 에 컬럼이 늘어도 안 샌다)', async () => {
    const r = await mine(TOKEN_A);
    const allowed = new Set(['contribution_id', 'created_at', 'barcode', 'product_name',
      'status', 'nutrition_status', 'product_id']);
    for (const it of r.body.data.items) {
      for (const k of Object.keys(it)) {
        assert.ok(allowed.has(k), `계약에 없는 키가 나갔다: \`${k}\` = ${JSON.stringify(it[k])}`);
      }
    }
  });

  await t('★ user_id·supabase_uid 가 나가지 않는다 (이제 «채워지는» 값이라 더 중요하다)', async () => {
    const r = await mine(TOKEN_A);
    for (const it of r.body.data.items) {
      assert.ok(!('user_id' in it), 'user_id 가 응답에 실렸다');
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§4. ★★★ /confirm — 기기 식별자는 «토큰이 정본»이다 (바코드와 같은 원칙)');
  // ══════════════════════════════════════════════════════════════════════════
  await t('★ 1단계에서 보낸 device_id 가 토큰에 담긴다 (담기지 않으면 2단계가 통째로 잃는다)', async () => {
    const r = await callMultiPhoto({
      save: 'false', barcode: '8803333333333', deviceId: DEV_A,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const tk = r.body.data.analysis_token;
    assert.ok(tk, 'analysis_token 이 없다');
    const analysisCache = require('../src/services/analysisCache');
    const cached = analysisCache.getAnalysis(tk);
    assert.ok(cached, '토큰이 캐시에 없다');
    assert.strictEqual(cached.deviceId, DEV_A,
      `1단계 device_id 가 토큰에 안 담겼다: ${JSON.stringify(cached.deviceId)}`);
  });

  await t('★★★ 2단계 본문의 device_id 가 토큰과 다르면 «토큰 값»이 저장된다 (바꿔치기 차단)', async () => {
    const r = await callMultiPhoto({ save: 'false', barcode: '8804444444444', deviceId: DEV_A });
    const c = await request('POST', '/api/ocr/confirm', {
      // ★ 세션64c — 확정 저장도 «로그인 필수»다. 헤더가 없으면 401 이다.
      headers: bearer(TOKEN_A),
      body: {
        analysis_token: r.body.data.analysis_token,
        product_info: { product_name: '기기토큰승리쿠키', food_type: '과자' },
        device_id: DEV_B,   // ← 남의 기기 식별자로 바꿔치기
      },
    });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    assert.strictEqual(c.body.data.save_result.saved, true, c.body.data.save_result.rejectReason);

    const row = await db.query(
      `SELECT c.device_id FROM contributions c JOIN products p ON p.product_id = c.product_id
       WHERE p.barcode = '8804444444444'`);
    assert.strictEqual(row.rows.length, 1, '제보가 저장되지 않았다');
    assert.strictEqual(row.rows[0].device_id, DEV_A,
      `본문 값(${DEV_B})이 토큰 값(${DEV_A})을 이겼다 — 중복 게이트·자동승격·이력이 전부 우회된다`);
  });

  await t('★ 그 제보는 «제보한 사용자»의 이력에만 보인다 (남의 이력을 오염시키지 않는다)', async () => {
    // ⚠ 이력의 열쇠는 이제 device_id 가 아니라 user_id 다. 본문에 남의 device_id 를 적어도
    //   내 이력에 남고, 남의 이력에는 «두 겹으로» 못 끼어든다(토큰 정본 + user_id 조회).
    const a = await mine(TOKEN_A, '?limit=50');
    const b = await mine(TOKEN_B, '?limit=50');
    assert.ok(a.body.data.items.some((x) => x.barcode === '8804444444444'),
      '제보한 사용자의 이력에 안 보인다');
    assert.ok(!b.body.data.items.some((x) => x.barcode === '8804444444444'),
      '기기 식별자를 바꿔치기한 쪽의 이력에 끼어들었다');
  });

  await t('★ 불일치는 경고 로그로 «관측»된다 (거부하지 않는 대신 근거를 남긴다)', () => {
    const hit = warnLog.filter((w) => w.meta?.reason === 'CLIENT_DEVICE_ID_IGNORED');
    assert.ok(hit.length >= 1, '기기 식별자 불일치 경고가 없다 — 우회 시도를 관측할 수단이 없다');
    assert.strictEqual(hit[hit.length - 1].meta.token_device_id, DEV_A);
    assert.strictEqual(hit[hit.length - 1].meta.client_device_id, DEV_B);
  });

  await t('일치하면 경고를 남기지 않는다 (정상 요청을 시끄럽게 만들지 않는다)', async () => {
    const before = warnLog.filter((w) => w.meta?.reason === 'CLIENT_DEVICE_ID_IGNORED').length;
    const r = await callMultiPhoto({ save: 'false', barcode: '8805555555555', deviceId: DEV_A });
    const c = await request('POST', '/api/ocr/confirm', {
      // ★ 세션64c — 확정 저장도 «로그인 필수»다. 헤더가 없으면 401 이다.
      headers: bearer(TOKEN_A),
      body: {
        analysis_token: r.body.data.analysis_token,
        product_info: { product_name: '정상일치쿠키', food_type: '과자' },
        device_id: DEV_A,
      },
    });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    const after = warnLog.filter((w) => w.meta?.reason === 'CLIENT_DEVICE_ID_IGNORED').length;
    assert.strictEqual(after, before, '본문·토큰 기기 식별자가 같은데 경고가 났다');
  });

  await t('★★ 저장된 제보가 곧바로 이력에 보인다 (제보 → 확인의 «전 구간»이 이어진다)', async () => {
    const r = await mine(TOKEN_A, '?limit=50');
    const it = r.body.data.items.find((x) => x.barcode === '8805555555555');
    assert.ok(it, `방금 확정한 제보가 이력에 없다: ${JSON.stringify(r.body.data.items.map((x) => x.barcode))}`);
    assert.strictEqual(it.product_name, '정상일치쿠키');
    assert.strictEqual(it.status, 'pending');
    assert.strictEqual(it.nutrition_status, 'ok',
      `저장 당시 nutrition_status 가 안 실렸다: ${JSON.stringify(it.nutrition_status)}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§5. ⚠⚠ 24시간 중복 게이트 — «실측: 지금 발동하지 않는다»');
  // ══════════════════════════════════════════════════════════════════════════
  // ⚠⚠⚠ 이 절은 **결함을 고치는 것이 아니라 «지금 실제로 이렇다»를 못 박는다.**
  //   게이트를 임의로 완화하지도, 강화하지도 않았다(제이 판단 항목).
  //
  //   세션64c 는 「device_id 가 실리기 시작하면 종전에 안 걸리던 것이 걸린다」를 예상했다.
  //   **실측 결과 그렇지 않았다. 게이트는 device_id 와 무관하게 원래부터 죽어 있었다.**
  //
  //   원인 (`crowdsourceService.js:372~378`):
  //     WHERE product_id = $1 AND data::text LIKE '%"device_id":"<X>"%'
  //     ↑ 콜론 뒤에 **공백이 없다.**
  //     그런데 `contributions.data` 는 **jsonb** 이고, Postgres 의 jsonb::text 는
  //     `{"device_id": "X", ...}` 처럼 **콜론 뒤에 공백을 넣어** 렌더링한다.
  //     → 이 LIKE 는 **어떤 행과도 매치되지 않는다.** 게이트는 작성된 날부터 무동작이다.
  //   (부수 문제: `contributions.device_id` **컬럼**과 `idx_contributions_device` 인덱스가
  //    멀쩡히 있는데 게이트만 `data::text` 를 훑는다 — 같은 사실을 두 방식으로 읽고 있다.)
  //
  // ★ 고치지 않은 이유 — 고치면 **앱의 「영양성분표 다시 찍기」가 막힌다.**
  //   (`web/src/domain/meokseon/photoReport.ts:306` — 영양을 못 읽었을 때 앱이 사용자에게
  //    권하는 바로 그 흐름이다. 같은 기기가 같은 제품을 다시 올리는 것 = 게이트의 정의.)
  //   서버가 「다시 찍어 주세요」라고 해놓고 다시 찍으면 「24시간 내에 이미 제출하셨습니다」로
  //   반려하는 것은 앱이 지금 하는 거짓 약속보다 나쁘다. 제이 판단 사항이다.
  //
  // ⚠ 이 테스트가 **빨강이 되면 = 누군가 LIKE 패턴을 고쳤다는 뜻**이다.
  //   그때는 재촬영 경로를 어떻게 살릴지 먼저 정해야 한다. 이 절이 그 질문을 강제한다.
  await t('★★★ 실측 — 같은 기기·같은 제품 재제보가 «막히지 않는다» (게이트 무동작)', async () => {
    const r = await callMultiPhoto({ save: 'false', barcode: '8805555555555', deviceId: DEV_A });
    const c = await request('POST', '/api/ocr/confirm', {
      // ★ 세션64c — 확정 저장도 «로그인 필수»다. 헤더가 없으면 401 이다.
      headers: bearer(TOKEN_A),
      body: {
        analysis_token: r.body.data.analysis_token,
        product_info: { product_name: '정상일치쿠키', food_type: '과자' },
        device_id: DEV_A,
      },
    });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    assert.strictEqual(c.body.data.save_result.saved, true,
      '24시간 게이트가 발동했다 — LIKE 패턴이 고쳐졌다는 뜻이다. '
      + '앱의 「영양성분표 다시 찍기」가 막히지 않는지 먼저 확인할 것(세션64c 보고서 §5).');
  });

  await t('★★★ 무동작의 «정확한 원인»을 못 박는다 (jsonb::text 는 콜론 뒤에 공백을 넣는다)', async () => {
    const pid = (await db.query("SELECT product_id FROM products WHERE barcode = '8805555555555'"))
      .rows[0].product_id;
    // 게이트가 실제로 쓰는 패턴 — 공백 없음
    const asWritten = await db.query(
      `SELECT COUNT(*)::int AS c FROM contributions
       WHERE product_id = $1 AND data::text LIKE $2`,
      [pid, `%"device_id":"${DEV_A}"%`]);
    // 같은 뜻인데 공백만 넣은 패턴
    const withSpace = await db.query(
      `SELECT COUNT(*)::int AS c FROM contributions
       WHERE product_id = $1 AND data::text LIKE $2`,
      [pid, `%"device_id": "${DEV_A}"%`]);
    // 컬럼으로 보면 (게이트가 «썼어야 할» 방식)
    const byColumn = await db.query(
      'SELECT COUNT(*)::int AS c FROM contributions WHERE product_id = $1 AND device_id = $2',
      [pid, DEV_A]);

    assert.strictEqual(asWritten.rows[0].c, 0,
      '게이트 패턴이 매치됐다 — 원인 진단이 틀렸거나 jsonb 렌더링이 바뀌었다. 다시 진단할 것.');
    assert.ok(withSpace.rows[0].c > 0,
      '공백 있는 패턴도 매치가 없다 — data 에 device_id 가 아예 안 들어갔다는 뜻이다(더 큰 문제).');
    assert.ok(byColumn.rows[0].c > 0,
      'device_id 컬럼에도 값이 없다 — 배선 자체가 끊겼다.');
  });

  await t('★ 그 결과 이력에는 같은 제품이 «두 번» 보인다 (사용자가 보게 될 실제 화면)', async () => {
    const r = await mine(TOKEN_A, '?limit=50');
    const hits = r.body.data.items.filter((x) => x.barcode === '8805555555555');
    assert.strictEqual(hits.length, 2,
      `재제보가 이력에 ${hits.length}건이다 — 게이트 동작이 바뀌었다면 위 두 테스트가 먼저 빨강이어야 한다`);
  });

  await t('다른 기기·다른 사용자의 같은 제품 제보도 저장된다 (크라우드소싱 검증의 전제)', async () => {
    const r = await callMultiPhoto({ save: 'false', barcode: '8805555555555', deviceId: DEV_B, token: TOKEN_B });
    const c = await request('POST', '/api/ocr/confirm', {
      headers: bearer(TOKEN_B),
      body: {
        analysis_token: r.body.data.analysis_token,
        product_info: { product_name: '정상일치쿠키', food_type: '과자' },
        device_id: DEV_B,
      },
    });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    assert.strictEqual(c.body.data.save_result.saved, true,
      `다른 기기의 제보까지 막혔다 — 크라우드소싱 검증(distinct 3기기)이 영영 못 돈다: ${c.body.data.save_result.rejectReason}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§6. status 의 «정직성» — 지금 서버가 실제로 하는 일');
  // ══════════════════════════════════════════════════════════════════════════
  // ⚠ 이 절은 「그래야 한다」가 아니라 **「지금 실제로 이렇다」**를 고정한다.
  //   `contributions.status` 를 바꾸는 코드는 서버 전체에서 `POST /api/admin/verify/:productId`
  //   **하나뿐**이다(`adminRoutes.js:212·231·258`). 자동 전이가 없다.
  //   앱이 「검토 중 → 반영됨」을 말하려면 그 관리자 조작이 실제로 일어나야 한다.
  //   이 테스트가 빨강이 되면 = 자동 전이가 «생겼다»는 뜻이고, 앱 문구를 다시 봐야 한다.
  await t('★★ 저장 직후 status 는 언제나 pending 이다 (자동으로 승격되지 않는다)', async () => {
    const rows = await db.query(
      `SELECT DISTINCT status FROM contributions WHERE device_id IN ($1, $2)`, [DEV_A, DEV_B]);
    const statuses = rows.rows.map((x) => x.status);
    assert.deepStrictEqual(statuses, ['pending'],
      `저장 경로가 pending 외의 status 를 만들었다: ${JSON.stringify(statuses)} — 앱 문구를 다시 봐야 한다`);
  });

  await t('★ 관리자 승인이 status 를 움직이면 이력에 «그대로» 반영된다 (해석하지 않는다)', async () => {
    await db.query(
      `UPDATE contributions SET status = 'approved' WHERE product_id = $1 AND status = 'pending'`,
      [P1]);
    const r = await mine(TOKEN_A, '?limit=50');
    const it = r.body.data.items.find((x) => x.barcode === '8801111111111');
    assert.ok(it, '제보를 못 찾았다');
    assert.strictEqual(it.status, 'approved',
      `DB 의 status 가 응답에 안 실렸다 — 서버가 값을 가공하고 있다: ${it.status}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  server.close();
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(` 결과: ${pass}/${pass + fail} 통과 · ${fail} 실패`);
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
