/**
 * test_kfind_barcode_review.js — ★ 세션81c 관리자 바코드 연결 확인 큐. 정답 tests/fixtures/kfind_barcode_review_v1.json KA01~09.
 *   PGlite + 정본 마이그레이션 + 실제 /api 라우터(requireAdmin · ADMIN_TOKEN).
 */
'use strict';
const assert = require('assert'); const fs = require('fs'); const path = require('path'); const http = require('http');
const MIG = path.join(__dirname, '..', 'scripts', 'migrations'); const read = (f) => fs.readFileSync(path.join(MIG, f), 'utf8');
process.env.ADMIN_TOKEN = 'test-admin-token-81c'; process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt-secret-0123456789';
const ean = (p12) => { const d = p12.split('').map(Number); let s = 0; for (let i = 0; i < 12; i++) s += d[i] * (i % 2 ? 3 : 1); return p12 + ((10 - (s % 10)) % 10); };
let pass = 0, fail = 0; const t = async (n, fn) => { try { await fn(); pass++; console.log(`  ✅ ${n}`); } catch (e) { fail++; console.log(`  ❌ ${n}\n     → ${e.message}`); } };

(async () => {
  let PGlite; try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { console.log('⏭ pglite 미설치 — 건너뜀은 통과가 아니다'); process.exit(1); }
  const pg = new PGlite();
  for (const f of ['000_baseline.sql', '021_supabase_auth.sql', '022_additive_detected_count.sql', '023_data_inspection.sql', '024_contribution_review.sql', '025_nutrition_data_crowd.sql', '026_crowd_nutrition_split.sql', '029_review_auto_applied.sql', '030_contribution_photos.sql', '031_web_label_schema.sql', '032_web_label_exposure.sql', '033_web_label_search.sql', '034_web_label_label_basis.sql', '035_kfind_schema.sql', '036_kfind_barcodes.sql', '037_kfind_barcode_claims.sql']) await pg.exec(read(f));
  const q = (x, p) => pg.query(x, p || []);
  const shim = { pool: null, query: q, transaction: async (cb) => cb({ query: q }), healthCheck: async () => ({ status: 'healthy' }) };
  const dbPath = require.resolve('../src/config/database'); require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };

  await q(`insert into kfind.releases (release_id) values ('20260929')`);
  const kfi = (cd, nm, rn) => q(`insert into kfind.products (food_cd, release_id, food_name, report_no, maker, food_type, basis, calories, total_fat, protein, total_carbs, sodium, total_sugars, saturated_fat, nutrition_ok, status) values ($1,'20260929',$2,$3,'(주)테스트','과자','per_100g',450,20,6,60,400,25,8,true,'active')`, [cd, nm, rn]);
  const P = (n) => `P101-00000${String(n).padStart(4, '0')}-0001`;
  for (let i = 1; i <= 8; i++) await kfi(P(i), `품목${i}`, `R${i}`);
  const B = (n) => ean(`88012300${String(n).padStart(4, '0')}`);
  const pb = (bc, fc, st, reason, batch) => q(`insert into kfind.product_barcodes (barcode, food_cd, status, reason, batch_id) values ($1,$2,$3,$4,$5)`, [bc, fc, st, reason, batch]);
  await pb(B(1), P(1), 'needs_review', 'maker_only', 'kfbc_t');                    // 승인 대상
  await q(`insert into public.products (barcode, product_name, data_source, is_active) values ('${B(2)}','공공제품','public_c005',true)`);
  await pb(B(2), P(2), 'needs_review', 'conflict_public', 'kfbc_t');               // 공공 → 409
  await pb(B(3), P(3), 'needs_review', 'conflict_user', 'ublink'); await pb(B(3), P(4), 'needs_review', 'conflict_user', 'ublink');   // 형제
  await pb(B(5), P(5), 'needs_review', 'user_pair_unverified', 'ublink');           // 반려 대상
  const wl = await q(`insert into web_label.products (product_name, manufacturer, food_type, c005_report_no, data_source, verification, status, nutrition_ok) values ('판매처','판매','과자','RW','web_label','unverified','active',true) returning product_id`);
  await q(`insert into web_label.product_barcodes (barcode, product_id, status) values ('${B(6)}', ${wl.rows[0].product_id}, 'auto')`);
  await pb(B(6), P(6), 'needs_review', 'identity', 'kfbc_t');
  await pb(B(7), P(7), 'auto', 'haccp_exact', 'kfbc_t');                            // 목록에 안 나와야 함

  require('express-async-errors');
  const express = require('express'); const { errorHandler } = require('../src/middleware/errorHandler');
  const app = express(); app.use(express.json()); app.use('/api', require('../src/routes/index')); app.use(errorHandler);
  const server = app.listen(0); const port = server.address().port;
  const req = (method, p, { token = 'test-admin-token-81c', body } = {}) => new Promise((res, rej) => { const h = {}; let pl = null; if (token) h.authorization = `Bearer ${token}`; if (body) { pl = Buffer.from(JSON.stringify(body)); h['content-type'] = 'application/json'; h['content-length'] = pl.length; }
    const r = http.request({ method, hostname: '127.0.0.1', port, path: p, headers: h }, (x) => { let d = ''; x.on('data', (c) => { d += c; }); x.on('end', () => { let b = null; try { b = JSON.parse(d); } catch { b = d; } res({ status: x.statusCode, body: b }); }); }); r.on('error', rej); if (pl) r.write(pl); r.end(); });
  const act = (bc, fc, action) => req('POST', '/api/admin/review/kfind-barcodes', { body: { barcode: bc, food_cd: fc, action } });
  const row = async (bc, fc) => (await q(`select status, reason, decided_by from kfind.product_barcodes where barcode=$1 and food_cd=$2`, [bc, fc])).rows[0];

  console.log('── KA 관리자 바코드 연결 확인');
  await t('KA01 목록 needs_review · by_reason · public_product · siblings · source', async () => {
    const r = await req('GET', '/api/admin/review/kfind-barcodes'); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data; const n = wl.rows[0] ? 6 : 6; assert.strictEqual(d.total, n);
    assert.ok(!d.items.some((x) => x.status !== 'needs_review'));
    assert.strictEqual(d.by_reason.conflict_user, 2);
    const p2 = d.items.find((x) => x.barcode === B(2)); assert.strictEqual(p2.public_product.product_name, '공공제품'); assert.strictEqual(p2.source, 'haccp');
    const s3 = d.items.find((x) => x.barcode === B(3) && x.food_cd === P(3)); assert.strictEqual(s3.source, 'user'); assert.deepStrictEqual(s3.siblings.map((s) => s.food_cd), [P(4)]);
    assert.strictEqual(s3.kfind.name, '품목3');
    const f = await req('GET', '/api/admin/review/kfind-barcodes?reason=conflict_user'); assert.strictEqual(f.body.data.total, 2);
  });
  await t('KA02 승인 → approved · decided_by admin-token · 비로그인 스캔이 품목을 냄', async () => {
    const r = await act(B(1), P(1), 'approve'); assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.data.changed, true);
    const x = await row(B(1), P(1)); assert.strictEqual(x.status, 'approved'); assert.strictEqual(x.decided_by, 'admin-token');
    const s = await req('GET', `/api/products/${B(1)}`, { token: null }); assert.strictEqual(s.status, 200, JSON.stringify(s.body)); assert.strictEqual(s.body.data.kfind.food_cd, P(1)); assert.strictEqual(s.body.data.kfind.barcode_linked, true);
  });
  await t('KA03 공공 바코드 승인 → 409 PUBLIC_EXISTS · 행 그대로', async () => {
    const r = await act(B(2), P(2), 'approve'); assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error.code, 'PUBLIC_EXISTS');
    assert.strictEqual((await row(B(2), P(2))).status, 'needs_review');
  });
  await t('KA04 형제 중 하나 승인 → 다른 하나 rejected(sibling_approved) · 스캔은 승인된 것', async () => {
    const r = await act(B(3), P(3), 'approve'); assert.strictEqual(r.body.data.siblings_changed, 1);
    const o = await row(B(3), P(4)); assert.strictEqual(o.status, 'rejected'); assert.strictEqual(o.reason, 'sibling_approved');
    const s = await req('GET', `/api/products/${B(3)}`, { token: null }); assert.strictEqual(s.body.data.kfind.food_cd, P(3));
  });
  await t('KA06 되돌리기 → needs_review · decided_by NULL · 함께 반려된 형제도 needs_review', async () => {
    const r = await act(B(3), P(3), 'reopen'); assert.strictEqual(r.body.data.siblings_changed, 1);
    const a = await row(B(3), P(3)); assert.strictEqual(a.status, 'needs_review'); assert.strictEqual(a.decided_by, null);
    assert.strictEqual((await row(B(3), P(4))).status, 'needs_review');
  });
  await t('KA05 반려 → rejected · 사용자 2명이 같은 연결 제보해도 rejected 유지 · 스캔 404', async () => {
    await act(B(5), P(5), 'reject'); assert.strictEqual((await row(B(5), P(5))).status, 'rejected');
    const svc = require('../src/services/userBarcodeLinkService'); svc._resetPrefix({ L9: {}, L8: {} });
    for (const uid of ['u-1', 'u-2']) { const u = (await q(`insert into users (supabase_uid) values ($1) returning user_id`, [uid])).rows[0].user_id; const r = await svc.submitClaim({ userId: Number(u), barcode: B(5), foodCd: P(5) }); assert.strictEqual(r.verdict, uid === 'u-2' ? 'keep' : 'keep'); }
    assert.strictEqual((await row(B(5), P(5))).status, 'rejected');
    assert.strictEqual((await req('GET', `/api/products/${B(5)}`, { token: null })).status, 404);
  });
  await t('KA07 없는 행 404 · 잘못된 action 400 · 토큰 없음 401', async () => {
    assert.strictEqual((await act(B(1), P(8), 'approve')).status, 404);
    assert.strictEqual((await act(B(1), P(1), 'delete')).status, 400);
    assert.strictEqual((await req('GET', '/api/admin/review/kfind-barcodes', { token: null })).status, 401);
  });
  await t('KA08 판매처에 연결된 바코드 승인 → 409 LINKED_ELSEWHERE', async () => {
    assert.ok(wl.rows[0], 'web_label 픽스처 생성 실패');
    const r = await act(B(6), P(6), 'approve'); assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error.code, 'LINKED_ELSEWHERE');
  });
  await t('KA09 같은 상태 재요청 → changed:false', async () => {
    const r = await act(B(1), P(1), 'approve'); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.data.changed, false);
  });
  server.close();
  console.log(`\n${pass} 통과 · ${fail} 실패`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
