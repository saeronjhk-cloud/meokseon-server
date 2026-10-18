/**
 * test_kfind_compare.js — ★ 세션81g 판매처 ↔ 식약처 «크게 다름» 비교 표시 · 신호등 끈 사유.
 *   정답 tests/fixtures/kfind_compare_v1.json (= IP/eval_kfind_compare_v1) KC01~05(판정) · KR01~06(PGlite · 실제 서비스).
 */
'use strict';
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const MIG = path.join(__dirname, '..', 'scripts', 'migrations'); const read = (f) => fs.readFileSync(path.join(MIG, f), 'utf8');
const FX = require('./fixtures/kfind_compare_v1.json'); const G = require('../scripts/lib/web_label_gate');
let pass = 0, fail = 0; const t = async (n, fn) => { try { await fn(); pass++; console.log(`  ✅ ${n}`); } catch (e) { fail++; console.log(`  ❌ ${n}\n     → ${e.message}`); } };
(async () => {
  console.log('── KC 판정');
  for (const c of FX.check_cases) await t(`${c.id} ${c.desc}`, () => { const r = G.kfindCheck(c.wl, c.cands); assert.strictEqual(!!(r && r.gross), c.want_gross); if (c.want_result) assert.strictEqual(r.result, c.want_result); if (!c.want_gross) assert.ok(!r || !('gross' in r), 'gross 키가 없어야 한다'); });

  let PGlite; try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { console.log('⏭ pglite 미설치 — 건너뜀은 통과가 아니다'); process.exit(1); }
  const db = new PGlite();
  for (const f of ['000_baseline.sql', '021_supabase_auth.sql', '022_additive_detected_count.sql', '023_data_inspection.sql', '024_contribution_review.sql', '025_nutrition_data_crowd.sql', '026_crowd_nutrition_split.sql', '029_review_auto_applied.sql', '030_contribution_photos.sql', '031_web_label_schema.sql', '032_web_label_exposure.sql', '033_web_label_search.sql', '034_web_label_label_basis.sql', '035_kfind_schema.sql', '036_kfind_barcodes.sql', '037_kfind_barcode_claims.sql']) await db.exec(read(f));
  const q = (x, p) => db.query(x, p || []);
  const shim = { pool: null, query: q, transaction: async (cb) => cb({ query: q }), healthCheck: async () => ({ status: 'healthy' }) };
  const dbPath = require.resolve('../src/config/database'); require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };
  const svc = require('../src/services/productService');
  await q(`insert into kfind.releases (release_id) values ('20260929')`);
  const kf = (cd, rn, kcal) => q(`insert into kfind.products (food_cd, release_id, food_name, report_no, maker, food_type, basis, calories, total_fat, protein, total_carbs, sodium, total_sugars, nutrition_ok, status) values ($1,'20260929',$1,$2,'제조(주)','어묵','per_100g',$3,2,8,6,500,1,true,'active')`, [cd, rn, kcal]);
  await kf('P120-000000001-0001', 'R-G', 53); await kf('P120-000000002-0001', 'R-C', 395); await kf('P120-000000003-0001', 'R-449', 200);
  await kf('P120-000000004-0001', 'R-OK', 200); await kf('P120-000000005-0001', 'R-NONUT', 180);
  await kf('P120-000000006-0001', 'R-G2', 50); await kf('P120-000000006-0002', 'R-G2', 60);
  const wl = async (rn, nutOk, quality, kcal) => {
    const id = Number((await q(`insert into web_label.products (product_name, manufacturer, food_type, c005_report_no, data_source, verification, status, nutrition_ok, quality) values ($1,'판매','어묵',$1,'web_label','unverified','active',$2,$3::jsonb) returning product_id`, [rn, nutOk, JSON.stringify(quality)])).rows[0].product_id);
    if (kcal != null) await q(`insert into web_label.nutrition_data (product_id, calories, total_fat, protein, total_carbs, sodium, serving_size, data_source) values ($1,$2,10,10,20,500,'100g','web_label')`, [id, kcal]);
    return id;
  };
  const W1 = await wl('R-G', false, { nutrition_449: true, kfind: { result: 'conflict', diff: ['calories'], food_cd: 'P120-000000001-0001', gross: true } }, 205);
  const W2 = await wl('R-C', false, { nutrition_449: true, kfind: { result: 'conflict', diff: ['sodium'] } }, 400);
  const W3 = await wl('R-449', false, { nutrition_449: false, kfind: { result: 'agree', diff: [] } }, 200);
  const W4 = await wl('R-OK', true, { nutrition_449: true, kfind: { result: 'agree', diff: [] } }, 200);
  const W5 = await wl('R-NONUT', true, { nutrition_449: null }, null);
  const W6 = await wl('R-G2', false, { nutrition_449: true, kfind: { result: 'conflict', diff: ['calories'], gross: true } }, 205);
  const W = FX.wording;
  console.log('── KR 런타임');
  await t('KR01 gross + 후보 1 → reason kfind · kfind_gross · compare 카드', async () => {
    const x = await svc.getWebLabelProduct(W1); const b = x.web_label;
    assert.strictEqual(b.nutrition_off_reason, 'kfind'); assert.strictEqual(b.kfind_gross, true);
    assert.strictEqual(b.kfind_supplement.role, 'compare'); assert.strictEqual(b.kfind_supplement.badge, W.compare_badge); assert.strictEqual(b.kfind_supplement.nutrition.calories, 53);
    assert.strictEqual(x.traffic_light, null, '신호등은 꺼진 채'); assert.strictEqual(x.nutrition.calories, 205, '판매처 값은 그대로');
  });
  await t('KR02 conflict(gross 아님) → reason kfind · supplement null', async () => { const b = (await svc.getWebLabelProduct(W2)).web_label; assert.strictEqual(b.nutrition_off_reason, 'kfind'); assert.strictEqual(b.kfind_gross, false); assert.strictEqual(b.kfind_supplement, null); });
  await t('KR03 4·4·9 실패 → reason calc', async () => { const b = (await svc.getWebLabelProduct(W3)).web_label; assert.strictEqual(b.nutrition_off_reason, 'calc'); assert.strictEqual(b.kfind_supplement, null); });
  await t('KR04 nutrition_ok true → reason null', async () => { const b = (await svc.getWebLabelProduct(W4)).web_label; assert.strictEqual(b.nutrition_off_reason, null); assert.strictEqual(b.kfind_supplement, null); });
  await t('KR05 영양 없음 → 종전 보충(role 없음)', async () => { const s = (await svc.getWebLabelProduct(W5)).web_label.kfind_supplement; assert.ok(s); assert.strictEqual(s.role, undefined); assert.strictEqual(s.badge, '식약처 영양성분 DB 보충'); });
  await t('KR06 gross + 후보 2 → supplement null', async () => { const b = (await svc.getWebLabelProduct(W6)).web_label; assert.strictEqual(b.kfind_gross, true); assert.strictEqual(b.kfind_supplement, null); });
  console.log(`\n${pass} 통과 · ${fail} 실패`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
