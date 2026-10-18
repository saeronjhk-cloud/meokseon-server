/**
 * test_user_barcode_link.js — ★ 세션81 사용자 바코드 연결 런타임. 정답 tests/fixtures/user_barcode_v1.json runtime_cases UR01~06.
 *   PGlite 에 정본 마이그레이션(000 … 036 · 037)을 그대로 올리고 실제 경로(/api/barcode-links · /api/products/:barcode)를 부른다.
 */
'use strict';
const assert = require('assert'); const fs = require('fs'); const path = require('path'); const http = require('http');
const jwt = require('jsonwebtoken');
const MIG = path.join(__dirname, '..', 'scripts', 'migrations'); const read = (f) => fs.readFileSync(path.join(MIG, f), 'utf8');
const SECRET = 'test-supabase-jwt-secret-0123456789'; process.env.SUPABASE_JWT_SECRET = SECRET;
const tok = (sub) => { const now = Math.floor(Date.now() / 1000); return jwt.sign({ iss: 'https://lrnuqhpgyuizfggxgxpl.supabase.co/auth/v1', sub, aud: 'authenticated', role: 'authenticated', aal: 'aal1', session_id: 'ffffffff-1111-4222-8333-444444444444', email: sub.slice(0, 4) + '@ex.com', iat: now, exp: now + 3600 }, SECRET, { algorithm: 'HS256', noTimestamp: true }); };
const U = ['3f1c2a5e-9b47-4d81-a2f3-6c0e5d8b1a24', 'c4d9e7b1-2a68-4f30-9c5d-8b7a6e1f3d02', '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'].map(tok);
const ean = (p12) => { const d = p12.split('').map(Number); let s = 0; for (let i = 0; i < 12; i++) s += d[i] * (i % 2 ? 3 : 1); return p12 + ((10 - (s % 10)) % 10); };
let pass = 0, fail = 0; const t = async (n, fn) => { try { await fn(); pass++; console.log(`  ✅ ${n}`); } catch (e) { fail++; console.log(`  ❌ ${n}\n     → ${e.message}`); } };

(async () => {
  let PGlite; try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { console.log('⏭ pglite 미설치 — 건너뜀은 통과가 아니다'); process.exit(1); }
  const pg = new PGlite();
  for (const f of ['000_baseline.sql', '021_supabase_auth.sql', '022_additive_detected_count.sql', '023_data_inspection.sql', '024_contribution_review.sql', '025_nutrition_data_crowd.sql', '026_crowd_nutrition_split.sql', '029_review_auto_applied.sql', '030_contribution_photos.sql', '031_web_label_schema.sql', '032_web_label_exposure.sql', '033_web_label_search.sql', '034_web_label_label_basis.sql', '035_kfind_schema.sql', '036_kfind_barcodes.sql', '037_kfind_barcode_claims.sql', '037_kfind_barcode_claims.sql']) await pg.exec(read(f));
  const q = (x, p) => pg.query(x, p || []);
  const shim = { pool: null, query: q, transaction: async (cb) => cb({ query: q }), healthCheck: async () => ({ status: 'healthy' }) };
  const dbPath = require.resolve('../src/config/database'); require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };
  const svc = require('../src/services/userBarcodeLinkService');
  // 대역 표: 880123456 → 부각상회 (UB 와 같은 가상 업체)
  svc._resetPrefix({ L9: { '880123456': ['부각상회'] }, L8: {} });

  await q(`insert into kfind.releases (release_id) values ('20260929')`);
  const kfi = (cd, nm, rn, mk = '(주)부각상회') => q(`insert into kfind.products (food_cd, release_id, food_name, report_no, maker, food_type, basis, calories, total_fat, protein, total_carbs, sodium, total_sugars, saturated_fat, nutrition_ok, status) values ($1,'20260929',$2,$3,$4,'과자','per_100g',450,20,6,60,400,25,8,true,'active')`, [cd, nm, rn, mk]);
  const P1 = 'P101-000000101-0001', P2 = 'P101-000000102-0001', P3 = 'P101-000000103-0001';
  await kfi(P1, '바삭김부각', 'R101'); await kfi(P2, '바삭김부각 매운맛', 'R102'); await kfi(P3, '숨김품목', 'R103');
  await q(`insert into public.products (barcode, product_name, data_source, c005_report_no, is_active) values ('${ean('880999999001')}', '공공제품', 'public_c005', 'R103', true)`);   // P3 숨김
  const PUBBC = ean('880999999001'); const BC = ean('880123456001'); const BC2 = ean('880123456002');

  require('express-async-errors');   // 운영 app.js 와 같게(비동기 오류 → errorHandler)
  const express = require('express'); const { errorHandler } = require('../src/middleware/errorHandler');
  const app = express(); app.use(express.json()); app.use('/api', require('../src/routes/index')); app.use(errorHandler);
  const server = app.listen(0); const port = server.address().port;
  const req = (method, p, { token, body } = {}) => new Promise((res, rej) => { const h = {}; let pl = null; if (token) h.authorization = `Bearer ${token}`; if (body) { pl = Buffer.from(JSON.stringify(body)); h['content-type'] = 'application/json'; h['content-length'] = pl.length; }
    const r = http.request({ method, hostname: '127.0.0.1', port, path: p, headers: h }, (x) => { let d = ''; x.on('data', (c) => { d += c; }); x.on('end', () => { let b = null; try { b = JSON.parse(d); } catch { b = d; } res({ status: x.statusCode, body: b }); }); }); r.on('error', rej); if (pl) r.write(pl); r.end(); });
  const link = (i, barcode, fc) => req('POST', '/api/barcode-links', { token: U[i], body: { barcode, food_cd: fc } });
  const cnt = async (s) => Number((await q(s)).rows[0].n);
  const before = { p: await cnt(`select count(*)::int n from public.products`), w: await cnt(`select count(*)::int n from web_label.products`) };

  console.log('── UR 런타임');
  await t('UR05 로그인 없음 401 · food_cd 형식 400 · 없는 품목 404 · 바코드 형식 400', async () => {
    assert.strictEqual((await req('POST', '/api/barcode-links', { body: { barcode: BC, food_cd: P1 } })).status, 401);
    assert.strictEqual((await link(0, BC, 'X1')).status, 400);
    assert.strictEqual((await link(0, BC, 'P101-000000999-0001')).status, 404);
    assert.strictEqual((await link(0, '12345', P1)).status, 400);
  });
  await t('UR01 첫 제보 → personal(user_single) · 응답에 K-FIND 본문 · 전역 행 없음', async () => {
    const r = await link(0, BC, P1); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.data.verdict, 'personal'); assert.strictEqual(r.body.data.reason, 'user_single'); assert.strictEqual(r.body.data.prefix, 'match');
    assert.ok(r.body.data.product && r.body.data.product.kfind && r.body.data.product.kfind.food_cd === P1);
    assert.strictEqual(await cnt(`select count(*)::int n from kfind.product_barcodes where barcode='${BC}'`), 0);
  });
  await t('UR02 본인 조회 → P1 · 다른 사용자 조회 → 404 · 비로그인 스캔은 아직 404', async () => {
    const a = await req('GET', `/api/barcode-links/mine/${BC}`, { token: U[0] }); assert.strictEqual(a.status, 200); assert.strictEqual(a.body.data.food_cd, P1); assert.ok(a.body.data.product.kfind);
    assert.strictEqual((await req('GET', `/api/barcode-links/mine/${BC}`, { token: U[1] })).status, 404);
    assert.strictEqual((await req('GET', `/api/products/${BC}`)).status, 404);
  });
  await t('UR03 두 번째 사용자 같은 품목 → auto(user_pair) · 비로그인 스캔이 K-FIND 품목을 낸다', async () => {
    const r = await link(1, BC, P1); assert.strictEqual(r.body.data.verdict, 'auto', JSON.stringify(r.body.data)); assert.strictEqual(r.body.data.reason, 'user_pair');
    const s = await req('GET', `/api/products/${BC}`); assert.strictEqual(s.status, 200, JSON.stringify(s.body)); assert.strictEqual(s.body.data.kfind.food_cd, P1); assert.strictEqual(s.body.data.kfind.barcode_linked, true);
  });
  await t('UR04 auto 행 batch ublink · decided_by 없음 · public·web_label 행 수 변화 0', async () => {
    const x = (await q(`select status, batch_id, decided_by from kfind.product_barcodes where barcode='${BC}' and food_cd='${P1}'`)).rows[0];
    assert.strictEqual(x.status, 'auto'); assert.strictEqual(x.batch_id, 'ublink'); assert.strictEqual(x.decided_by, null);
    assert.strictEqual(await cnt(`select count(*)::int n from public.products`), before.p); assert.strictEqual(await cnt(`select count(*)::int n from web_label.products`), before.w);
  });
  await t('UR07 사용자 2가 P2 로 바꿈 → P1·P2 모두 conflict_user(needs_review) · 비로그인 스캔 404', async () => {
    const r = await link(1, BC, P2); assert.strictEqual(r.body.data.verdict, 'needs_review'); assert.strictEqual(r.body.data.reason, 'conflict_user');
    const p1 = (await q(`select status from kfind.product_barcodes where barcode='${BC}' and food_cd='${P1}'`)).rows[0];
    assert.strictEqual(p1.status, 'needs_review', '사용자1 P1 · 사용자2 P2 → P1 도 conflict_user');
    assert.strictEqual((await req('GET', `/api/products/${BC}`)).status, 404);
  });
  await t('UR08 HACCP 배치 행·사람 판정 행은 덮지 않는다', async () => {
    await q(`insert into kfind.product_barcodes (barcode, food_cd, status, reason, batch_id) values ('${BC2}','${P1}','auto','haccp_exact','kfbc_test')`);
    await link(0, BC2, P2); await link(1, BC2, P2); await link(2, BC2, P2);
    const h = (await q(`select status, reason, batch_id from kfind.product_barcodes where barcode='${BC2}' and food_cd='${P1}'`)).rows[0];
    assert.deepStrictEqual([h.status, h.reason, h.batch_id], ['auto', 'haccp_exact', 'kfbc_test']);
    const p2 = (await q(`select status, reason from kfind.product_barcodes where barcode='${BC2}' and food_cd='${P2}'`)).rows[0];
    assert.strictEqual(p2.status, 'needs_review'); assert.strictEqual(p2.reason, 'conflict_linked');
  });
  await t('UR09 공공 제품 바코드 → conflict_public · 본인 표시 없음 · 숨김 품목 → target_hidden', async () => {
    const r = await link(2, PUBBC, P1); assert.strictEqual(r.body.data.reason, 'conflict_public'); assert.strictEqual(r.body.data.personal, false); assert.strictEqual(r.body.data.product, null);
    const h = await link(2, BC, P3); assert.strictEqual(h.body.data.verdict, 'reject'); assert.strictEqual(h.body.data.reason, 'target_hidden');
  });
  await t('UR06 하루 상한 30 초과 → 429', async () => {
    const n = await cnt(`select count(*)::int n from kfind.barcode_claims c join users u on u.user_id=c.user_id where u.supabase_uid='0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'`);
    for (let i = n; i < 30; i++) await link(2, BC, P1);
    const r = await link(2, BC, P1); assert.strictEqual(r.status, 429); assert.strictEqual(r.body.error.code, 'CLAIM_LIMIT');
  });
  server.close();
  console.log(`\n${pass} 통과 · ${fail} 실패`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
