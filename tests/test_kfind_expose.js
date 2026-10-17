/**
 * test_kfind_expose.js — ★ 세션80 결정 80-1 kfind 노출(PGlite · 실제 서비스 호출)
 *   정답: tests/fixtures/kfind_expose_v1.json (= IP/eval_kfind_expose_v1/cases_v1.json) K01~K11.
 *   검색(K01~K05)은 pg_trgm 없는 pglite 에서 similarity/% 가 없으므로 «숨김·상태 조건»만 같은 WHERE 로 확인하고,
 *   점수식 검색은 운영 DB 평가(scripts/112-eval-kfind-expose.js)로 돈다.
 */
'use strict';
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const MIG = path.join(__dirname, '..', 'scripts', 'migrations'); const read = (f) => fs.readFileSync(path.join(MIG, f), 'utf8');
const CASES = require('./fixtures/kfind_expose_v1.json');
let pass = 0, fail = 0; const t = async (n, fn) => { try { await fn(); pass++; console.log(`  ✅ ${n}`); } catch (e) { fail++; console.log(`  ❌ ${n}\n     → ${e.message}`); } };
const keys = (o) => Object.keys(o || {}).sort();
(async () => {
  let PGlite; try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { console.log('⏭ pglite 미설치 — 건너뜀은 통과가 아니다'); process.exit(1); }
  const db = new PGlite();
  for (const f of ['000_baseline.sql', '021_supabase_auth.sql', '022_additive_detected_count.sql', '023_data_inspection.sql', '024_contribution_review.sql', '025_nutrition_data_crowd.sql', '026_crowd_nutrition_split.sql', '029_review_auto_applied.sql', '030_contribution_photos.sql', '031_web_label_schema.sql', '032_web_label_exposure.sql', '033_web_label_search.sql', '034_web_label_label_basis.sql']) await db.exec(read(f));
  const realQuery = db.query.bind(db);
  const shim = { pool: null, query: (x, p) => realQuery(x, p || []), transaction: async (cb) => cb({ query: (x, p) => realQuery(x, p || []) }), healthCheck: async () => ({ status: 'healthy' }) };
  const dbPath = require.resolve('../src/config/database'); require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };
  const svc = require('../src/services/productService');
  const kfm = require('../src/models/kfindModel');
  const one = async (s, p) => (await realQuery(s, p)).rows[0];

  console.log('── K11 035 마이그레이션');
  const pubCols = async () => (await realQuery(`select table_name, column_name, data_type from information_schema.columns where table_schema='public' and table_name in ('products','nutrition_data','product_allergens') order by 1,2`)).rows;
  const before = await pubCols();
  await t('K11 035 적용·재적용(멱등) · public 열 무변경 · search_text 생성 컬럼', async () => {
    await db.exec(read('035_kfind_schema.sql')); await db.exec(read('035_kfind_schema.sql'));
    assert.deepStrictEqual(await pubCols(), before);
    const g = await one(`select is_generated from information_schema.columns where table_schema='kfind' and table_name='products' and column_name='search_text'`); assert.strictEqual(g.is_generated, 'ALWAYS');
  });

  // ── 픽스처
  await realQuery(`insert into kfind.releases (release_id, file_name, row_count) values ('20260929','t.xlsx',8)`);
  const kf = async (cd, name, rn, o = {}) => realQuery(`insert into kfind.products (food_cd, release_id, food_name, report_no, maker, importer, is_imported, origin_country, food_type, basis, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, nutrition_ok, status)
    values ($1,'20260929',$2,$3,$4,$5,$6,$7,'과자',$8,450,20,8,0,10,400,60,25,2,6,$9,$10)`, [cd, name, rn, o.maker ?? '국내제조(주)', o.importer ?? null, !!o.imp, o.origin ?? null, o.basis || 'per_100g', o.nok ?? true, o.status || 'active']);
  await kf('P101-000000001-0001', 'kf노출품목', 'R-K1');
  await kf('P101-000000002-0001', 'kf공공활성겹침', 'R-PUB');
  await kf('P101-000000003-0001', 'kf공공비활성겹침', 'R-PUBOFF');
  await kf('P101-000000004-0001', 'kf판매처겹침', 'R-WL');
  await kf('P101-000000005-0001', 'kf판매처검토겹침', 'R-WLREV');
  await kf('P101-000000006-0001', 'kf철회', 'R-WD', { status: 'withdrawn' });
  await kf('P109-000000007-0001', 'kf수입품', '23AU0F200D9', { imp: true, maker: 'BRICK LANE', importer: '드링크어웨이크', origin: '호주', basis: 'per_100ml' });
  await kf('P101-000000008-0001', 'kf4·4·9실패', 'R-NOK', { nok: false });
  await kf('P101-000000009-0001', 'kf보충1', 'R-SUP1');
  await kf('P101-000000010-0001', 'kf보충2a', 'R-SUP2'); await kf('P101-000000010-0002', 'kf보충2b', 'R-SUP2');
  const pub = async (bc, rn, act) => realQuery(`insert into products (barcode, product_name, food_type, data_source, c005_report_no, is_active) values ($1,'공공',$4,'manual_seed',$2,$3)`, [bc, rn, act, '과자']);
  await pub('8800000000101', 'R-PUB', true); await pub('8800000000102', 'R-PUBOFF', false);
  const wl = async (name, rn, status, withNut) => {
    const id = (await one(`insert into web_label.products (product_name, manufacturer, food_type, c005_report_no, data_source, verification, status, nutrition_ok) values ($1,'판매(주)','과자',$2,'web_label','unverified',$3,true) returning product_id`, [name, rn, status])).product_id;
    if (withNut) await realQuery(`insert into web_label.nutrition_data (product_id, calories, total_fat, protein, total_carbs, sodium, serving_size, data_source) values ($1,480,22,6,62,350,'100g','web_label')`, [id]);
    return Number(id);
  };
  await wl('판매처A', 'R-WL', 'active', true); await wl('판매처검토', 'R-WLREV', 'needs_review', true);
  const W_S1 = await wl('판매처영양없음1', 'R-SUP1', 'active', false);
  const W_S2 = await wl('판매처영양없음2', 'R-SUP2', 'active', false);
  const W_N = await wl('판매처영양있음', 'R-SUP1', 'stale', true);

  console.log('── K01~K05 숨김·상태 (searchKfind 의 WHERE 와 같은 NOT_SHADOWED 를 상세 조회로 확인)');
  const vis = async (cd) => !!(await kfm.findKfindProduct(cd));
  await t('K01 노출 품목 상세 있음 · 필드', async () => { const p = await kfm.findKfindProduct('P101-000000001-0001'); assert.ok(p); assert.strictEqual(p.product_name, 'kf노출품목'); assert.strictEqual(p.calories, 450); });
  await t('K02 public 활성 동번호 → 숨김(상세 NotFound)', async () => { assert.strictEqual(await vis('P101-000000002-0001'), false); await assert.rejects(() => svc.getKfindProduct('P101-000000002-0001')); });
  await t('K03 public 비활성만 → 노출', async () => assert.strictEqual(await vis('P101-000000003-0001'), true));
  await t('K04 web_label 노출 동번호 → 숨김 · needs_review 는 숨김 사유 아님', async () => { assert.strictEqual(await vis('P101-000000004-0001'), false); assert.strictEqual(await vis('P101-000000005-0001'), true); });
  await t('K05 withdrawn → 없음', async () => assert.strictEqual(await vis('P101-000000006-0001'), false));

  console.log('── K06~K09 상세 응답');
  await realQuery(`insert into products (barcode, product_name, food_type, data_source) values ('8800000000999','바코드기준','과자','manual_seed')`);
  const bar = await svc.getProductWithTrafficLight('8800000000999');
  const k = await svc.getKfindProduct('P109-000000007-0001');
  await t('K06 최상위 키 = 바코드 응답 키 − {web_label_supplements} ∪ {kfind}', async () => {
    const want = keys(bar).filter((x) => x !== 'web_label_supplements').concat('kfind').sort(); assert.deepStrictEqual(keys(k), want);
  });
  await t('K07 알레르기·원재료 없음(null/false) · 신호등 있음', async () => {
    assert.strictEqual(k.allergens, null); assert.strictEqual(k.allergens_v2, null); assert.strictEqual(k.allergens_available, false);
    assert.strictEqual(k.ingredients_text, null); assert.strictEqual(k.allergens_from_ingredients ?? null, null);
    assert.ok(k.traffic_light, '신호등 없음'); assert.strictEqual(k.nutrition.basis, 'per_100ml'); assert.strictEqual(k.product.barcode, null);
  });
  await t('K08 nutrition_ok=false → 신호등 null · 영양 그대로', async () => { const x = await svc.getKfindProduct('P101-000000008-0001'); assert.strictEqual(x.traffic_light, null); assert.strictEqual(x.nutrition.calories, 450); assert.strictEqual(x.kfind.nutrition_ok, false); });
  await t('K09 kfind 블록 값', async () => {
    const W = CASES.wording; const b = k.kfind;
    assert.strictEqual(b.source, 'kfind'); assert.strictEqual(b.food_cd, 'P109-000000007-0001');
    assert.strictEqual(b.badge, W.badge); assert.strictEqual(b.warning, W.warning); assert.strictEqual(b.source_label, W.source_label);
    assert.strictEqual(b.release_label, '2026.09.29 기준'); assert.strictEqual(b.is_imported, true); assert.strictEqual(b.origin_country, '호주');
    assert.strictEqual(b.importer, '드링크어웨이크'); assert.strictEqual(b.report_no, '23AU0F200D9'); assert.strictEqual(b.basis, 'per_100ml');
  });

  console.log('── K10 판매처 품목 보충');
  const webBase = keys(await svc.getWebLabelProduct(W_N));
  await t('K10 영양 없음+후보1 → web_label.kfind_supplement · 신호등 null · 최상위 키 무변경', async () => {
    const w = await svc.getWebLabelProduct(W_S1); const s = w.web_label.kfind_supplement;
    assert.ok(s); assert.strictEqual(s.badge, CASES.wording.supplement_badge); assert.strictEqual(s.source_label, CASES.wording.source_label);
    assert.strictEqual(s.food_cd, 'P101-000000009-0001'); assert.strictEqual(s.nutrition.calories, 450); assert.strictEqual(s.nutrition.basis, 'per_100g');
    assert.strictEqual(w.traffic_light, null); assert.strictEqual(w.nutrition, null); assert.deepStrictEqual(keys(w), webBase);
  });
  await t('K10 후보 2 → null', async () => assert.strictEqual((await svc.getWebLabelProduct(W_S2)).web_label.kfind_supplement, null));
  await t('K10 영양 있음 → null', async () => assert.strictEqual((await svc.getWebLabelProduct(W_N)).web_label.kfind_supplement, null));

  console.log(`[kfind expose] ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
