/**
 * test_kfind_barcode.js — ★ 세션80 kfind 바코드 잇기. 정답 tests/fixtures/kfind_barcode_v1.json (= IP/eval_kfind_barcode_v1) KL01~07 · KB01~07.
 *   KL = 113 의 순수 판정 judge()(decide 재사용) · KB = PGlite 실제 서비스(getProductWithTrafficLight 폴백).
 */
'use strict';
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const MIG = path.join(__dirname, '..', 'scripts', 'migrations'); const read = (f) => fs.readFileSync(path.join(MIG, f), 'utf8');
const CASES = require('./fixtures/kfind_barcode_v1.json');
const { judge } = require('../scripts/113-kfind-barcode-link.js');
let pass = 0, fail = 0; const t = async (n, fn) => { try { await fn(); pass++; console.log(`  ✅ ${n}`); } catch (e) { fail++; console.log(`  ❌ ${n}\n     → ${e.message}`); } };
// 유효 EAN-13 (체크섬 계산)
const ean = (p12) => { const d = p12.split('').map(Number); let s = 0; for (let i = 0; i < 12; i++) s += d[i] * (i % 2 ? 3 : 1); return p12 + ((10 - (s % 10)) % 10); };
const B1 = ean('880100000001'), B2 = ean('880100000002'), B3 = ean('880100000003'), B4 = ean('880100000004'), B5 = ean('880100000005'), B6 = ean('880100000006'), B7 = ean('880100000007');
(async () => {
  console.log('── KL 배치 판정 (judge · decide 재사용)');
  const hc = new Map([
    ['1001', new Map([[B1, { nm: '치즈얌', mfr: '테스트식품' }]])],
    ['1002', new Map([[B2, { nm: '공공겹침', mfr: '테스트식품' }]])],
    ['1003', new Map([[B3, { nm: '판매처겹침', mfr: '테스트식품' }]])],
    ['1004', new Map([[B4, { nm: '두맛', mfr: '테스트식품' }]])],
    ['1005', new Map([['8801000000000', { nm: '체크섬', mfr: '테스트식품' }]])],
    ['1006', new Map([[B6, { nm: '전혀다른이름', mfr: '다른회사' }]])],
    ['1008', new Map([[B7, { nm: '초코칩쿠키', mfr: '신흥식품' }]])],
  ]);
  const kf = [
    { food_cd: 'P101-000000001-0001', food_name: '치즈얌', maker: '테스트식품(주)', report_no: '1001' },
    { food_cd: 'P101-000000002-0001', food_name: '공공겹침', maker: '테스트식품', report_no: '1002' },
    { food_cd: 'P101-000000003-0001', food_name: '판매처겹침', maker: '테스트식품', report_no: '1003' },
    { food_cd: 'P101-000000004-0001', food_name: '두맛 딸기', maker: '테스트식품', report_no: '1004' },
    { food_cd: 'P101-000000004-0002', food_name: '두맛 바나나', maker: '테스트식품', report_no: '1004' },
    { food_cd: 'P101-000000005-0001', food_name: '체크섬', maker: '테스트식품', report_no: '1005' },
    { food_cd: 'P101-000000006-0001', food_name: '김부각', maker: '부각상회', report_no: '1006' },
    { food_cd: 'P101-000000008-0001', food_name: 'THE촉촉한 오리지널 도넛', maker: '(주)신흥식품', report_no: '1008' },
  ];
  const res = judge(kf, hc, { publicSet: new Set([B2]), linked: (bc) => bc === B3 });
  const of = (fc) => res.find((r) => r.food_cd === fc);
  await t('KL01 auto haccp_exact', async () => { const r = of('P101-000000001-0001'); assert.strictEqual(r.status, 'auto'); assert.strictEqual(r.reason, 'haccp_exact'); });
  await t('KL02 public 에 있는 바코드 → conflict_public', async () => { const r = of('P101-000000002-0001'); assert.strictEqual(r.status, 'needs_review'); assert.strictEqual(r.reason, 'conflict_public'); });
  await t('KL03 다른 곳에 연결됨 → conflict_linked', async () => { const r = of('P101-000000003-0001'); assert.strictEqual(r.status, 'needs_review'); assert.strictEqual(r.reason, 'conflict_linked'); });
  await t('KL04 같은 번호 kfind 2개 → multi_kfind', async () => { for (const fc of ['P101-000000004-0001', 'P101-000000004-0002']) { const r = of(fc); assert.strictEqual(r.status, 'needs_review', fc); assert.ok(['multi_kfind', 'identity'].includes(r.reason), r.reason); } assert.ok(res.filter((r) => r.report_no === '1004' || r.evidence.report_no === '1004').some((r) => r.reason === 'multi_kfind')); });
  await t('KL05 체크섬 실패 → reject', async () => { const r = of('P101-000000005-0001'); assert.strictEqual(r.status, 'reject'); assert.strictEqual(r.reason, 'checksum'); });
  await t('KL06 이름·제조사 불일치 → identity', async () => { const r = of('P101-000000006-0001'); assert.strictEqual(r.status, 'needs_review'); assert.strictEqual(r.reason, 'identity'); });

  await t('KL08 제조사만 일치(OEM) → maker_only', async () => { const r = of('P101-000000008-0001'); assert.strictEqual(r.status, 'needs_review'); assert.strictEqual(r.reason, 'maker_only'); });

  let PGlite; try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { console.log('⏭ pglite 미설치 — 건너뜀은 통과가 아니다'); process.exit(1); }
  const db = new PGlite();
  for (const f of ['000_baseline.sql', '021_supabase_auth.sql', '022_additive_detected_count.sql', '023_data_inspection.sql', '024_contribution_review.sql', '025_nutrition_data_crowd.sql', '026_crowd_nutrition_split.sql', '029_review_auto_applied.sql', '030_contribution_photos.sql', '031_web_label_schema.sql', '032_web_label_exposure.sql', '033_web_label_search.sql', '034_web_label_label_basis.sql', '035_kfind_schema.sql', '036_kfind_barcodes.sql', '036_kfind_barcodes.sql']) await db.exec(read(f));
  const realQuery = db.query.bind(db);
  const shim = { pool: null, query: (x, p) => realQuery(x, p || []), transaction: async (cb) => cb({ query: (x, p) => realQuery(x, p || []) }), healthCheck: async () => ({ status: 'healthy' }) };
  const dbPath = require.resolve('../src/config/database'); require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };
  const svc = require('../src/services/productService');
  const one = async (s, p) => (await realQuery(s, p)).rows[0];
  await realQuery(`insert into kfind.releases (release_id) values ('20260929')`);
  const kfi = (cd, rn, st = 'active') => realQuery(`insert into kfind.products (food_cd, release_id, food_name, report_no, maker, food_type, basis, calories, total_fat, protein, total_carbs, sodium, total_sugars, saturated_fat, nutrition_ok, status) values ($1,'20260929',$1,$2,'테스트','과자','per_100g',450,20,6,60,400,25,8,true,$3)`, [cd, rn, st]);
  const link = (bc, cd, st) => realQuery(`insert into kfind.product_barcodes (barcode, food_cd, status) values ($1,$2,$3)`, [bc, cd, st]);
  await kfi('P101-000000011-0001', 'R11'); await link(B1, 'P101-000000011-0001', 'auto');
  await kfi('P101-000000012-0001', 'R12'); await link(B2, 'P101-000000012-0001', 'needs_review');
  await kfi('P101-000000013-0001', 'R13'); await kfi('P101-000000013-0002', 'R13b'); await link(B3, 'P101-000000013-0001', 'auto'); await link(B3, 'P101-000000013-0002', 'auto');
  await kfi('P101-000000014-0001', 'R14'); await link(B4, 'P101-000000014-0001', 'auto');
  await realQuery(`insert into products (barcode, product_name, food_type, data_source) values ($1,'공공제품','과자','manual_seed')`, [B4]);
  await kfi('P101-000000015-0001', 'R15'); await link(B5, 'P101-000000015-0001', 'approved');
  const wid = (await one(`insert into web_label.products (product_name, manufacturer, food_type, c005_report_no, data_source, verification, status, nutrition_ok) values ('판매처','판매','과자','RW','web_label','unverified','active',true) returning product_id`)).product_id;
  await realQuery(`insert into web_label.product_barcodes (barcode, product_id, status) values ($1,$2,'approved')`, [B5, wid]);
  await kfi('P101-000000016-0001', 'R16'); await link(B6, 'P101-000000016-0001', 'auto');
  await realQuery(`insert into products (barcode, product_name, food_type, data_source, c005_report_no, is_active) values ('8800000000777','공공활성','과자','manual_seed','R16',true)`);
  await kfi('P101-000000017-0001', 'R17', 'withdrawn'); await link(B7, 'P101-000000017-0001', 'auto');

  console.log('── KB 스캔 폴백');
  await t('KB01 auto 1개 → kfind 응답 · 바코드 · barcode_linked · badge_linked', async () => {
    const r = await svc.getProductWithTrafficLight(B1);
    assert.ok(r.kfind); assert.strictEqual(r.product.barcode, B1); assert.strictEqual(r.kfind.barcode_linked, true); assert.strictEqual(r.kfind.badge, CASES.wording.badge_linked);
    assert.strictEqual(r.allergens_available, false); assert.ok(r.traffic_light);
  });
  await t('KB02 needs_review 만 → 404', async () => assert.rejects(() => svc.getProductWithTrafficLight(B2)));
  await t('KB03 같은 바코드 2품목 → 404', async () => assert.rejects(() => svc.getProductWithTrafficLight(B3)));
  await t('KB04 public 에 있음 → public 응답', async () => { const r = await svc.getProductWithTrafficLight(B4); assert.ok(!r.kfind); assert.strictEqual(r.product.product_name, '공공제품'); });
  await t('KB05 web_label 연결 우선', async () => { const r = await svc.getProductWithTrafficLight(B5); assert.ok(r.web_label); assert.ok(!r.kfind); });
  await t('KB06 숨김·withdrawn → 404', async () => { await assert.rejects(() => svc.getProductWithTrafficLight(B6)); await assert.rejects(() => svc.getProductWithTrafficLight(B7)); });
  await t('KB07 이름 검색 상세는 barcode_linked false · 종전 배지', async () => { const r = await svc.getKfindProduct('P101-000000011-0001'); assert.strictEqual(r.kfind.barcode_linked, false); assert.strictEqual(r.kfind.badge, svc.KFIND_BADGE); assert.strictEqual(r.product.barcode, null); });
  console.log(`[kfind barcode] ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
