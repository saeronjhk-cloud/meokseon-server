/**
 * test_web_label_expose.js — ★ 세션79 U78-3 web_label 노출(PGlite · 실제 서비스 호출 · 소스 문자열 검사 아님)
 *   정답 셋: tests/fixtures/web_label_expose_v1.json (= IP/eval_web_label_expose_v1/cases_v1.json) 의 E3(응답 모양 6) · E5(보충 5)
 *   + 033 마이그레이션(search_text 생성 컬럼 · collected_at 백필 · 멱등 · public 무접촉).
 *   E1(검색 12)은 pg_trgm 이 필요해 운영 DB 평가 스크립트(scripts/106-eval-web-label-expose.js)로 돈다.
 */
'use strict';
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const MIG = path.join(__dirname, '..', 'scripts', 'migrations'); const read = (f) => fs.readFileSync(path.join(MIG, f), 'utf8');
const CASES = require('./fixtures/web_label_expose_v1.json');
let pass = 0, fail = 0; const t = async (n, fn) => { try { await fn(); pass++; console.log(`  ✅ ${n}`); } catch (e) { fail++; console.log(`  ❌ ${n}\n     → ${e.message}`); } };
const keys = (o) => Object.keys(o || {}).sort();
(async () => {
  let PGlite; try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { console.log('⏭ pglite 미설치 — 건너뜀은 통과가 아니다'); process.exit(1); }
  const db = new PGlite();
  for (const f of ['000_baseline.sql', '021_supabase_auth.sql', '022_additive_detected_count.sql', '023_data_inspection.sql', '024_contribution_review.sql', '025_nutrition_data_crowd.sql', '026_crowd_nutrition_split.sql', '029_review_auto_applied.sql', '030_contribution_photos.sql', '031_web_label_schema.sql', '032_web_label_exposure.sql', '034_web_label_label_basis.sql']) await db.exec(read(f));
  const realQuery = db.query.bind(db);
  const shim = { pool: null, query: (x, p) => realQuery(x, p || []), transaction: async (cb) => cb({ query: (x, p) => realQuery(x, p || []) }), healthCheck: async () => ({ status: 'healthy' }) };
  const dbPath = require.resolve('../src/config/database'); require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };
  const svc = require('../src/services/productService');

  // ── 픽스처: public 제품 1(영양·알레르기 있음) · public 제품 2(둘 다 없음 → 보충 대상) · web_label 품목 4
  const one = async (s, p) => (await realQuery(s, p)).rows[0];
  const P1 = (await one(`insert into products (barcode, product_name, food_type, data_source) values ('8800000000011','공공품목A','과자','manual_seed') returning product_id`)).product_id;
  await realQuery(`insert into nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, serving_size, data_source) values ($1,500,20,8,0,10,400,70,30,2,6,'100g','manual_seed')`, [P1]);
  await realQuery(`insert into product_allergens (product_id, allergen_name, evidence_level, status, detected_via) values ($1,'밀','contains','confirmed','haccp_api')`, [P1]);
  const P2 = (await one(`insert into products (barcode, product_name, food_type, data_source) values ('8800000000028','공공품목B','과자','manual_seed') returning product_id`)).product_id;
  const wl = async (name, status, nok, rn) => {
    const id = (await one(`insert into web_label.products (product_name, manufacturer, food_type, total_content, content_unit, c005_report_no, data_source, verification, status, nutrition_ok) values ($1,'테스트식품(주)','과자',100,'g',$2,'web_label','unverified',$3,$4) returning product_id`, [name, rn, status, nok])).product_id;
    await realQuery(`insert into web_label.nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, serving_size, data_source) values ($1,480,22,9,0,5,350,62,25,1,6,'100g','web_label')`, [id]);
    await realQuery(`insert into web_label.product_allergens (product_id, allergen_name, status, detected_via, evidence_level) values ($1,'우유','candidate','web_label','contains'),($1,'땅콩','candidate','web_label','may_contain')`, [id]);
    await realQuery(`insert into web_label.product_ingredients (product_id, raw_text, prdlst_report_no, source) values ($1,'밀가루, 설탕, 우유','${rn}','web_label_ocr')`, [id]);
    await realQuery(`insert into web_label.source_pages (site, url, report_no, gate, target_schema, product_id, fetched_at, batch_id) values ('kurly',$1,$2,'not_in_db','web_label',$3,'2026-10-13T11:20:00Z','t')`, ['https://x/' + id, rn, id]);
    await realQuery(`update web_label.nutrition_data set label_basis=$2::jsonb where product_id=$1`, [id, JSON.stringify({ basis: 'per_total', amount: 100, unit: 'g', values: { calories: 480 } })]);
    return Number(id);
  };
  const W_OK = await wl('판매처품목OK', 'active', true, '20000000000001');
  const W_NOK = await wl('판매처품목4·4·9실패', 'active', false, '20000000000002');
  const W_REV = await wl('판매처품목검토', 'needs_review', true, '20000000000003');
  const W_SUP = await wl('판매처품목숨김', 'superseded', true, '20000000000004');
  // 보충: P2 에 active 알레르기·영양 + needs_review·rejected(실리면 안 됨) · P1 에도 active 보충(이미 채워졌으니 안 실림)
  await realQuery(`insert into web_label.source_pages (site, url, report_no, gate, target_schema, fetched_at, batch_id) values ('kurly','https://s/2','R2','in_db','public','2026-10-13T12:00:00Z','t')`);
  await realQuery(`insert into web_label.public_supplements (product_id, axis, data, source_url, status) values ($1,'allergens','{"contains":["대두","밀"],"may_contain":["우유"]}','https://s/2','active'),($1,'nutrition','{"_basis":"per_100g","calories":457,"sodium":2,"protein":39,"trans_fat":0.5,"_upper_bound":["trans_fat"],"_label":{"basis":"per_100g","amount":100,"unit":"g","values":{"calories":457}}}','https://s/2','active')`, [P2]);
  await realQuery(`insert into web_label.public_supplements (product_id, axis, data, source_url, status) values ($1,'allergens','{"contains":["게"]}','https://s/2b','needs_review'),($1,'nutrition','{"calories":1}','https://s/2c','rejected')`, [P2]);
  await realQuery(`insert into web_label.public_supplements (product_id, axis, data, source_url, status) values ($1,'allergens','{"contains":["대두"]}','https://s/1','active')`, [P1]);

  console.log('── 033 마이그레이션');
  const pubCols = async () => (await realQuery(`select table_name, column_name, data_type from information_schema.columns where table_schema='public' and table_name in ('products','nutrition_data','product_allergens') order by 1,2`)).rows;
  const before = await pubCols();
  await t('033 적용 + 재적용(멱등) · public 열 무변경', async () => { await db.exec(read('033_web_label_search.sql')); await db.exec(read('033_web_label_search.sql')); assert.deepStrictEqual(await pubCols(), before); });
  await t('search_text = public(009)과 같은 식의 생성 컬럼 · collected_at 백필', async () => {
    const r = await one(`select search_text, collected_at from web_label.products where product_id=$1`, [W_OK]);
    assert.strictEqual(r.search_text, '판매처품목ok테스트식품주과자'); assert.ok(r.collected_at, 'collected_at 비어 있음');
    const g = await one(`select is_generated from information_schema.columns where table_schema='web_label' and table_name='products' and column_name='search_text'`); assert.strictEqual(g.is_generated, 'ALWAYS');
  });

  console.log('── E3 응답 모양');
  const pub = await svc.getProductWithTrafficLight('8800000000011');
  const web = await svc.getWebLabelProduct(W_OK);
  await t('E3-01 최상위 키 = 바코드 응답 키 − {web_label_supplements} ∪ {web_label}', async () => {
    const a = keys(pub).filter((k) => k !== 'web_label_supplements'); const b = keys(web).filter((k) => k !== 'web_label'); assert.deepStrictEqual(b, a); assert.ok(web.web_label);
  });
  await t('E3-02 product 하위 키 동일 · barcode=null · data_source=web_label · image_url=null', async () => {
    assert.deepStrictEqual(keys(web.product), keys(pub.product)); assert.strictEqual(web.product.barcode, null); assert.strictEqual(web.product.data_source, 'web_label'); assert.strictEqual(web.product.image_url, null);
  });
  await t('E3-03 nutrition 하위 키 동일 · 숫자 · basis per_100g', async () => {
    assert.deepStrictEqual(keys(web.nutrition), keys(pub.nutrition)); assert.strictEqual(typeof web.nutrition.calories, 'number'); assert.strictEqual(web.nutrition.basis, 'per_100g'); assert.ok(web.traffic_light, '신호등 없음');
  });
  await t('E3-04 nutrition_ok=false → traffic_light null · 영양은 그대로 · web_label.nutrition_ok=false', async () => {
    const x = await svc.getWebLabelProduct(W_NOK); assert.strictEqual(x.traffic_light, null); assert.strictEqual(x.nutrition.calories, 480); assert.strictEqual(x.web_label.nutrition_ok, false); assert.deepStrictEqual(x.sources, []);
  });
  await t('E3-05 needs_review·superseded·없는 id·public 활성 동번호 → NotFound', async () => {
    for (const id of [W_REV, W_SUP, 99999999]) { let nf = false; try { await svc.getWebLabelProduct(id); } catch (e) { nf = /찾을 수 없|NotFound|제품/.test(e.message) || e.statusCode === 404; } assert.ok(nf, 'id ' + id); }
    await realQuery(`update products set c005_report_no='20000000000001', is_active=true where product_id=$1`, [P2]);
    let nf = false; try { await svc.getWebLabelProduct(W_OK); } catch (e) { nf = true; } assert.ok(nf, '활성 public 동번호인데 노출됨');
    await realQuery(`update products set is_active=false where product_id=$1`, [P2]);
    await svc.getWebLabelProduct(W_OK);   // 비활성 public 은 숨김 사유가 아니다
    await realQuery(`update products set c005_report_no=null, is_active=true where product_id=$1`, [P2]);
  });
  await t('E3-06 web_label 블록 문구 정확 · 수집월 · 알레르기 표시란만', async () => {
    assert.strictEqual(web.web_label.badge, CASES.badge); assert.strictEqual(web.web_label.warning, CASES.warning);
    assert.strictEqual(web.web_label.collected_label, '2026.10 수집'); assert.strictEqual(web.web_label.is_stale, false); assert.strictEqual(web.web_label.barcode_linked, false);
    assert.deepStrictEqual(web.allergens_v2, { contains: ['우유'], inferred: [], mayContain: ['땅콩'] }); assert.strictEqual(web.allergens_available, true);
    assert.strictEqual(web.allergens_from_ingredients, null, '표시란이 있으면 원재료 추론은 싣지 않는다');
    assert.deepStrictEqual(web.web_label.label_nutrition, { basis: 'per_total', amount: 100, unit: 'g', values: { calories: 480 } }, '포장지 기준(label_nutrition)');
  });

  console.log('── E5 public 보충');
  await t('E5-01 알레르기 미수집 + active 보충 → allergens 채움', async () => {
    const x = await svc.getProductWithTrafficLight('8800000000028');
    assert.ok(x.web_label_supplements); assert.deepStrictEqual(x.web_label_supplements.allergens.contains, ['대두', '밀']); assert.deepStrictEqual(x.web_label_supplements.allergens.may_contain, ['우유']);
    assert.strictEqual(x.web_label_supplements.allergens.collected_label, '2026.10 수집'); assert.ok(x.web_label_supplements.badge);
    assert.strictEqual(x.allergens, null, 'allergens 키는 그대로 null(보충으로 단정하지 않는다)');
  });
  await t('E5-02 알레르기 수집됨 + 영양 있음 → web_label_supplements=null', async () => { assert.strictEqual(pub.web_label_supplements, null); });
  await t('E5-03 needs_review·rejected 보충은 싣지 않음', async () => {
    const x = await svc.getProductWithTrafficLight('8800000000028'); assert.ok(!x.web_label_supplements.allergens.contains.includes('게')); assert.notStrictEqual(x.web_label_supplements.nutrition.calories, 1);
  });
  await t('E5-04 영양 없음 + active 영양 보충 → nutrition(per100·basis) · traffic_light 은 null 유지', async () => {
    const x = await svc.getProductWithTrafficLight('8800000000028'); const n = x.web_label_supplements.nutrition;
    assert.strictEqual(n.calories, 457); assert.strictEqual(n.basis, 'per_100g'); assert.strictEqual(n.label.values.calories, 457); assert.deepStrictEqual(n.upper_bound, ['trans_fat']); assert.strictEqual(n.total_fat, null); assert.strictEqual(x.traffic_light, null); assert.strictEqual(x.nutrition, null);
  });
  await t('E5-05 보충 대상 없음 → null · 보충 표 조회 실패해도 응답은 정상(null)', async () => {
    const P3 = (await one(`insert into products (barcode, product_name, data_source) values ('8800000000035','공공품목C','manual_seed') returning product_id`)).product_id;
    assert.strictEqual((await svc.getProductWithTrafficLight('8800000000035')).web_label_supplements, null);
    await realQuery('alter table web_label.public_supplements rename to ps_tmp');
    try { assert.strictEqual((await svc.getProductWithTrafficLight('8800000000028')).web_label_supplements, null); } finally { await realQuery('alter table web_label.ps_tmp rename to public_supplements'); }
    void P3;
  });
  console.log('── E7 바코드 조회 → 연결된 판매처 품목');
  const RT = require('./fixtures/barcode_link_runtime_v1.json');
  const nf = async (bc) => { try { await svc.getProductWithTrafficLight(bc); return false; } catch (e) { return true; } };
  const link = (bc, id, st) => realQuery(`insert into web_label.product_barcodes (barcode, product_id, status, evidence) values ($1,$2,$3,'{}') on conflict (barcode, product_id) do update set status=excluded.status`, [bc, id, st]);
  await t('E7-01 auto 연결 → 200 · barcode_linked · 스캔 바코드 · 배지 · 키 동일', async () => {
    await link('8809000000017', W_OK, 'auto');
    const x = await svc.getProductWithTrafficLight('8809000000017');
    assert.strictEqual(x.web_label.barcode_linked, true); assert.strictEqual(x.product.barcode, '8809000000017'); assert.strictEqual(x.web_label.badge, RT.badge_linked);
    assert.deepStrictEqual(keys(x).filter((k) => k !== 'web_label'), keys(pub).filter((k) => k !== 'web_label_supplements'));
  });
  await t('E7-02 needs_review 연결 → 404', async () => { await link('8809000000024', W_OK, 'needs_review'); assert.ok(await nf('8809000000024')); });
  await t('E7-03 품목이 needs_review → 404', async () => { await link('8809000000031', W_REV, 'auto'); assert.ok(await nf('8809000000031')); });
  await t('E7-04 같은 바코드 2품목 auto → 404(모호)', async () => { await link('8809000000048', W_OK, 'auto'); await link('8809000000048', W_NOK, 'auto'); assert.ok(await nf('8809000000048')); });
  await t('E7-05 public 에 있으면 public 우선', async () => { await link('8800000000011', W_OK, 'auto'); const x = await svc.getProductWithTrafficLight('8800000000011'); assert.ok(!x.web_label); assert.strictEqual(x.product.product_name, '공공품목A'); });
  await t('E7-06 approved 도 연결', async () => { await link('8809000000055', W_NOK, 'approved'); const x = await svc.getProductWithTrafficLight('8809000000055'); assert.strictEqual(x.web_label.barcode_linked, true); assert.strictEqual(x.traffic_light, null); });
  console.log(`\n[web_label 노출 E3·E5·E7·033] ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
