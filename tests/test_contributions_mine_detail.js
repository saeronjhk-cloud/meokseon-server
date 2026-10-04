/**
 * test_contributions_mine_detail.js — 세션75d «내 제보 한 건» 상세 회귀
 *   GET /api/contributions/mine/:id — 승인 전 제보는 제품 화면에 없으므로 사용자가 «자기가 보낸 것»을 보는 유일한 길.
 * 지키는 것
 *   ① 내 제보 → 200 + 읽힌 그대로(이름·원재료·알레르기 3분류·첨가물·영양 값/기준) ② 남의 제보·없는 번호 → 둘 다 404
 *   ③ 번호 형식 오류 → 400 ④ 토큰 없음 → 401 ⑤ ★ 원문·device_id·제조사(주소 잔해)·rejected 영양이 응답 «원문»에 한 글자도 없다
 *   ⑥ 영양: 숫자만(0 유지 · 문자열 버림) · 기준 모르는 값은 'unknown' ⑦ data 가 비어도 500 이 아니다
 * pglite 에 000_baseline.sql + 021 을 그대로 적용하고 실제 라우터를 HTTP 로 부른다(test_contributions_mine.js 와 같은 방식).
 * 실행: cross-env NODE_ENV=test node tests/test_contributions_mine_detail.js
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
const SECRET = 'test-supabase-jwt-secret-0123456789';
process.env.SUPABASE_JWT_SECRET = SECRET;
const UID_A = '3f1c2a5e-9b47-4d81-a2f3-6c0e5d8b1a24';
const UID_B = 'c4d9e7b1-2a68-4f30-9c5d-8b7a6e1f3d02';
function makeToken(sub, email) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iss: 'https://lrnuqhpgyuizfggxgxpl.supabase.co/auth/v1', sub, aud: 'authenticated', role: 'authenticated',
    aal: 'aal1', session_id: 'ffffffff-1111-4222-8333-444444444444', email, iat: now, exp: now + 3600 }, SECRET, { algorithm: 'HS256', noTimestamp: true });
}
const TOKEN_A = makeToken(UID_A, 'a@example.com');
const TOKEN_B = makeToken(UID_B, 'b@example.com');
const bearer = (tok) => (tok ? { authorization: `Bearer ${tok}` } : {});

let pass = 0, fail = 0; const failures = [];
async function t(name, fn) {
  try { await fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; failures.push({ name, message: e.stack || e.message }); console.log(`  ❌ ${name}\n     → ${e.message}`); }
}

async function main() {
  console.log('\n══ 세션75d — 내 제보 상세 (GET /api/contributions/mine/:id) ══');
  let PGlite;
  try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { console.log('⏭  pglite 미설치 — 건너뜀은 통과가 아니다'); process.exit(1); }
  const pg = new PGlite();
  await pg.exec(fs.readFileSync(BASELINE, 'utf8'));
  await pg.exec(fs.readFileSync(MIG_021, 'utf8'));
  const shim = { pool: null, query: (text, params) => pg.query(text, params || []), healthCheck: async () => ({ status: 'healthy' }) };
  const dbPath = require.resolve('../src/config/database');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };
  const loggerPath = require.resolve('../src/config/logger');
  require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: { warn() {}, info() {}, error() {}, debug() {} } };

  const express = require('express');
  const contributionRoutes = require('../src/routes/contributionRoutes');
  const { errorHandler } = require('../src/middleware/errorHandler');
  const app = express(); app.use(express.json()); app.use('/api/contributions', contributionRoutes); app.use(errorHandler);
  const server = app.listen(0); const port = server.address().port;
  const get = (p, tok) => new Promise((resolve, reject) => {
    const req = http.request({ method: 'GET', hostname: '127.0.0.1', port, path: p, headers: bearer(tok) }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let b = null; try { b = d ? JSON.parse(d) : null; } catch { b = d; } resolve({ status: res.statusCode, body: b, raw: d }); });
    }); req.on('error', reject); req.end();
  });

  // ── 픽스처 ──
  const P = (await shim.query(`INSERT INTO products (barcode, product_name, data_source) VALUES ('8801117001445','지지미 김치전맛','ocr_crowdsource') RETURNING product_id`)).rows[0].product_id;
  const uA = Number((await shim.query("INSERT INTO users (supabase_uid, email) VALUES ($1,'a@example.com') RETURNING user_id", [UID_A])).rows[0].user_id);
  const uB = Number((await shim.query("INSERT INTO users (supabase_uid, email) VALUES ($1,'b@example.com') RETURNING user_id", [UID_B])).rows[0].user_id);
  const DATA = {
    ocr_raw_text: 'SECRET_OCR_TEXT 원재료명: 밀가루',
    device_id: '11111111-2222-4333-8444-555555555555',
    user_input: { product_name: '지지미 김치전맛', manufacturer: 'SECRET_MFR 남부순환로', brand: 'SECRET_BRAND', food_type: '과자', total_content: 112, content_unit: 'g',
      ingredients_text: '밀가루(밀:미국산), 김치분말, 산화방지제(비타민E)' },
    parsed_ingredients: [{ name: '밀가루' }, { name: '김치분말' }, '산화방지제', { name: '밀가루' }],
    allergens_v2: { contains: ['밀', '대두'], inferred: [], mayContain: ['우유'] },
    additives: [{ name: '비타민E', category: '영양강화제/비타민' }],
    parsed_nutrition: { calories: 520, sodium: 0, total_fat: '27', protein: null, _basis: 'per_100g' },
    rejected_nutrition: { calories: 'SECRET_REJECTED' },
    nutrition_status: 'ok',
    corrections: ['SECRET_CORR'],
  };
  const ins = (uid, data) => shim.query(`INSERT INTO contributions (user_id, product_id, contribution_type, data, status) VALUES ($1,$2,'ocr_nutrition',$3,'pending') RETURNING contribution_id`, [uid, P, JSON.stringify(data)]).then((r) => Number(r.rows[0].contribution_id));
  const C_A = await ins(uA, DATA);
  const C_B = await ins(uB, DATA);
  const C_EMPTY = await ins(uA, {});

  await t('① 내 제보 → 200 · 읽힌 그대로', async () => {
    const r = await get(`/api/contributions/mine/${C_A}`, TOKEN_A);
    assert.strictEqual(r.status, 200, r.raw);
    const d = r.body.data; const rb = d.readback;
    assert.strictEqual(d.contribution_id, C_A); assert.strictEqual(d.barcode, '8801117001445'); assert.strictEqual(d.status, 'pending');
    assert.strictEqual(rb.product_name, '지지미 김치전맛'); assert.strictEqual(rb.food_type, '과자');
    assert.strictEqual(rb.total_content, 112); assert.strictEqual(rb.content_unit, 'g');
    assert.ok(rb.ingredients_text.includes('산화방지제(비타민E)'));
    assert.deepStrictEqual(rb.ingredients, ['밀가루', '김치분말', '산화방지제'], '중복 제거·문자열/객체 모두');
    assert.deepStrictEqual(rb.allergens, { contains: ['밀', '대두'], inferred: [], may_contain: ['우유'] });
    assert.deepStrictEqual(rb.additives, ['비타민E']);
    assert.strictEqual(rb.nutrition_status, 'ok');
  });
  await t('⑥ 영양: 숫자만 · 0 은 남김 · 문자열 버림 · 기준 유지', async () => {
    const rb = (await get(`/api/contributions/mine/${C_A}`, TOKEN_A)).body.data.readback;
    assert.deepStrictEqual(rb.nutrition, { basis: 'per_100g', basis_amount: null, values: { calories: 520, sodium: 0 } });
  });
  await t('⑤ 원문·device_id·제조사·브랜드·rejected·corrections 가 응답 원문에 없다', async () => {
    const r = await get(`/api/contributions/mine/${C_A}`, TOKEN_A);
    for (const s of ['SECRET_OCR_TEXT', '11111111-2222-4333-8444-555555555555', 'SECRET_MFR', 'SECRET_BRAND', 'SECRET_REJECTED', 'SECRET_CORR', 'device_id', 'ocr_raw_text'])
      assert.ok(!r.raw.includes(s), `응답에 ${s} 가 샜다`);
  });
  await t('② 남의 제보 → 404 (없는 번호와 같은 응답)', async () => {
    const a = await get(`/api/contributions/mine/${C_B}`, TOKEN_A);
    const b = await get('/api/contributions/mine/999999', TOKEN_A);
    assert.strictEqual(a.status, 404); assert.strictEqual(b.status, 404);
    assert.deepStrictEqual(a.body, b.body, '남의 것과 없는 것이 구분되면 존재 여부가 샌다');
  });
  await t('③ 번호 형식 오류 → 400', async () => {
    for (const bad of ['abc', '-1', '0', '1.5']) assert.strictEqual((await get(`/api/contributions/mine/${bad}`, TOKEN_A)).status, 400, bad);
  });
  await t('④ 토큰 없음 → 401', async () => {
    assert.strictEqual((await get(`/api/contributions/mine/${C_A}`, null)).status, 401);
  });
  await t('⑦ data 가 비어도 200 · 전부 null', async () => {
    const r = await get(`/api/contributions/mine/${C_EMPTY}`, TOKEN_A);
    assert.strictEqual(r.status, 200, r.raw);
    const rb = r.body.data.readback;
    assert.strictEqual(rb.nutrition, null); assert.strictEqual(rb.allergens, null); assert.strictEqual(rb.ingredients, null); assert.strictEqual(rb.product_name, null);
  });
  await t('목록(/mine)은 그대로 — 상세 추가가 목록을 바꾸지 않는다', async () => {
    const r = await get('/api/contributions/mine', TOKEN_A);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.data.total, 2);
    assert.ok(!r.raw.includes('SECRET_OCR_TEXT') && !r.raw.includes('readback'));
  });

  server.close();
  console.log(`\n 결과: ${pass}/${pass + fail} 통과 · ${fail} 실패`);
  for (const f of failures) console.log(`  - ${f.name}\n    ${f.message}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('테스트 실행 오류:', e); process.exit(1); });
