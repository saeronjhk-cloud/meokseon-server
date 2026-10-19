/**
 * test_photo_kfind_supplement.js — ★ 세션82 결정 ⑧ 사진 제보 제품 ← K-FIND 보충 카드
 *   정답: tests/fixtures/photo_kfind_supplement_v1.json (= IP/eval_photo_kfind_supplement_v1/cases_v1.json · PK01~18 · 구현 전 고정)
 *   ① 순수 판정 18건 ② PGlite 실제 서비스(getProductWithTrafficLight) — 키·c005 무접촉·조건 밖 null ③ 저장 헬퍼(ocrReportNoFromText)
 */
'use strict';
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const MIG = path.join(__dirname, '..', 'scripts', 'migrations'); const read = (f) => fs.readFileSync(path.join(MIG, f), 'utf8');
const C = require('./fixtures/photo_kfind_supplement_v1.json');
let pass = 0, fail = 0; const t = async (n, fn) => { try { await fn(); pass++; console.log(`  ✅ ${n}`); } catch (e) { fail++; console.log(`  ❌ ${n}\n     → ${e.message}`); } };
(async () => {
  const { decidePhotoKfind, normalizeReportNo, ocrReportNoFromText } = require('../src/services/photoKfindSupplement');
  console.log('── ① 순수 판정 (정답 v1)');
  for (const c of C.cases) {
    await t(`${c.id} ${c.why}`, async () => { const r = decidePhotoKfind(c.product, c.kfind_rows); assert.strictEqual(r.ok, c.expect.supplement, 'ok ' + r.reason); assert.strictEqual(r.reason, c.expect.reason); });
  }
  console.log('── ③ 저장 헬퍼');
  await t('S3 정규화: 숫자만 · 10~16자리', async () => { assert.strictEqual(normalizeReportNo('1985-0499-011345'), '19850499011345'); assert.strictEqual(normalizeReportNo('123456789'), null); assert.strictEqual(normalizeReportNo(null), null); });
  await t('S2 OCR 원문 → 번호(서버 파서) · 없으면 null', async () => {
    assert.strictEqual(ocrReportNoFromText('제품명: 양념쌈장\n품목보고번호: 19850499011345\n내용량 500g'), '19850499011345');
    assert.strictEqual(ocrReportNoFromText('원재료명: 대두'), null); assert.strictEqual(ocrReportNoFromText(''), null);
  });

  let PGlite; try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { console.log('⏭ pglite 미설치 — 건너뜀은 통과가 아니다'); process.exit(1); }
  const db = new PGlite();
  for (const f of ['000_baseline.sql', '021_supabase_auth.sql', '022_additive_detected_count.sql', '023_data_inspection.sql', '024_contribution_review.sql', '025_nutrition_data_crowd.sql', '026_crowd_nutrition_split.sql', '029_review_auto_applied.sql', '030_contribution_photos.sql', '031_web_label_schema.sql', '032_web_label_exposure.sql', '033_web_label_search.sql', '034_web_label_label_basis.sql', '035_kfind_schema.sql']) await db.exec(read(f));
  const realQuery = db.query.bind(db);
  const shim = { pool: null, query: (x, p) => realQuery(x, p || []), transaction: async (cb) => cb({ query: (x, p) => realQuery(x, p || []) }), healthCheck: async () => ({ status: 'healthy' }) };
  const dbPath = require.resolve('../src/config/database'); require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };
  const svc = require('../src/services/productService');
  const one = async (s, p) => (await realQuery(s, p)).rows[0];

  await realQuery(`insert into kfind.releases (release_id, file_name, row_count) values ('20260929','t.xlsx',3)`);
  const kf = async (cd, name, rn, cal = 250) => realQuery(`insert into kfind.products (food_cd, release_id, food_name, report_no, maker, food_type, basis, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, nutrition_ok, status)
    values ($1,'20260929',$2,$3,'국내(주)','장류','per_100g',$4,5,1,0,0,2100,40,18,2,8,true,'active')`, [cd, name, rn, cal]);
  await kf('P1-0001', '양념쌈장', '19850499011345');
  await kf('P1-0002', '간편한 쌈장', '20110444050145');
  const prod = async (bc, name, ds) => Number((await one(`insert into products (barcode, product_name, food_type, data_source, verification, is_active) values ($1,$2,'장류',$3,'partial',true) returning product_id`, [bc, name, ds])).product_id);
  const contrib = async (pid, rn, status = 'pending') => realQuery(`insert into contributions (product_id, contribution_type, data, status) values ($1,'ocr_nutrition',$2,$3)`, [pid, JSON.stringify({ ocr_raw_text: 'x', ocr_report_no: rn }), status]);
  const P_OK = await prod('8801052105031', '양념 쌈장', 'ocr_crowdsource'); await contrib(P_OK, '19850499011345');
  const P_NAME = await prod('8800000000201', '양념 쌈장', 'ocr_crowdsource'); await contrib(P_NAME, '20110444050145');
  const P_CONF = await prod('8800000000202', '양념 쌈장', 'ocr_crowdsource'); await contrib(P_CONF, '19850499011345'); await contrib(P_CONF, '20110444050145');
  const P_REJ = await prod('8800000000203', '양념 쌈장', 'ocr_crowdsource'); await contrib(P_REJ, '19850499011345', 'rejected');
  const P_PUB = await prod('8800000000204', '양념쌈장', 'public_c005'); await contrib(P_PUB, '19850499011345');

  console.log('── ② 실제 서비스(바코드 응답)');
  const get = (bc) => svc.getProductWithTrafficLight(bc);
  await t('S6 통과 → kfind_supplement{badge 보충 · food_cd · nutrition · match ocr_report_no} · 신호등 없음', async () => {
    const r = await get('8801052105031'); const s = r.kfind_supplement;
    assert.ok(s, '보충 없음'); assert.strictEqual(s.badge, '식약처 영양성분 DB 보충'); assert.strictEqual(s.food_cd, 'P1-0001'); assert.strictEqual(s.match, 'ocr_report_no');
    assert.strictEqual(s.nutrition.sodium, 2100); assert.strictEqual(r.nutrition, null); assert.strictEqual(r.traffic_light, null);
  });
  await t('S2 c005_report_no 무접촉(검색 가림 키)', async () => { const x = await one(`select c005_report_no from products where product_id=$1`, [P_OK]); assert.strictEqual(x.c005_report_no, null); });
  await t('S5 이름 불일치 → null', async () => { assert.strictEqual((await get('8800000000201')).kfind_supplement, null); });
  await t('S3 제보 번호 상충 → null', async () => { assert.strictEqual((await get('8800000000202')).kfind_supplement, null); });
  await t('S2 반려된 제보의 번호는 안 씀 → null', async () => { assert.strictEqual((await get('8800000000203')).kfind_supplement, null); });
  await t('S1 공공 제품 → null(질의 안 함)', async () => { assert.strictEqual((await get('8800000000204')).kfind_supplement, null); });
  await t('S6 키는 바코드 응답에 항상 있음(null 포함)', async () => { assert.ok(Object.prototype.hasOwnProperty.call(await get('8800000000204'), 'kfind_supplement')); });

  console.log(`\n[photo kfind supplement] ${pass} 통과 · ${fail} 실패`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
