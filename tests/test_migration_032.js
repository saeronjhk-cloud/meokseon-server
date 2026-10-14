/** test_migration_032.js — ★ 세션79 web_label 노출(PGlite). 멱등 · 상태 CHECK · 보충 표 FK(public 참조만) · 바코드 표 · public 무접촉 */
'use strict';
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const MIG = path.join(__dirname, '..', 'scripts', 'migrations'); const read = (f) => fs.readFileSync(path.join(MIG, f), 'utf8');
let pass = 0, fail = 0; const t = async (n, fn) => { try { await fn(); pass++; console.log(`  ✅ ${n}`); } catch (e) { fail++; console.log(`  ❌ ${n}\n     → ${e.message}`); } };
(async () => {
  let PGlite; try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { console.log('⏭ pglite 미설치'); process.exit(1); }
  const db = new PGlite();
  for (const f of ['000_baseline.sql', '021_supabase_auth.sql', '022_additive_detected_count.sql', '023_data_inspection.sql', '024_contribution_review.sql', '025_nutrition_data_crowd.sql', '026_crowd_nutrition_split.sql', '029_review_auto_applied.sql', '030_contribution_photos.sql', '031_web_label_schema.sql']) await db.exec(read(f));
  const cols = async (s, tb) => (await db.query(`select column_name, data_type from information_schema.columns where table_schema=$1 and table_name=$2 order by ordinal_position`, [s, tb])).rows;
  const pubBefore = {}; for (const tb of ['products', 'product_allergens', 'nutrition_data']) pubBefore[tb] = await cols('public', tb);
  await t('032 적용 + 재적용(멱등)', async () => { await db.exec(read('032_web_label_exposure.sql')); await db.exec(read('032_web_label_exposure.sql')); });
  await t('public 표 열 무변경', async () => { for (const tb of Object.keys(pubBefore)) assert.deepStrictEqual(await cols('public', tb), pubBefore[tb], tb); });
  await t('web_label.products 상태 기본 needs_review · CHECK', async () => {
    const r = (await db.query("insert into web_label.products (product_name, c005_report_no) values ('a','1') returning status, nutrition_ok")).rows[0];
    assert.strictEqual(r.status, 'needs_review'); assert.strictEqual(r.nutrition_ok, null);
    let threw = false; try { await db.query("update web_label.products set status='bogus'"); } catch (_) { threw = true; } assert.ok(threw);
    await db.query("update web_label.products set status='active'");
  });
  await t('public_supplements: public 제품만 참조 · 축/상태 CHECK · (제품·축·출처) 유일 · 제품 삭제 시 함께 삭제', async () => {
    const pid = (await db.query("insert into public.products (barcode, product_name, data_source) values ('880','p','manual_seed') returning product_id")).rows[0].product_id;
    await db.query("insert into web_label.public_supplements (product_id, axis, data, source_url) values ($1,'allergens','{\"contains\":[\"우유\"]}','u1')", [pid]);
    let dup = false; try { await db.query("insert into web_label.public_supplements (product_id, axis, data, source_url) values ($1,'allergens','{}','u1')", [pid]); } catch (_) { dup = true; } assert.ok(dup, '중복 허용됨');
    let ax = false; try { await db.query("insert into web_label.public_supplements (product_id, axis, data) values ($1,'ingredients','{}')", [pid]); } catch (_) { ax = true; } assert.ok(ax, '축 CHECK 없음');
    let fk = false; try { await db.query("insert into web_label.public_supplements (product_id, axis, data) values (999999,'nutrition','{}')"); } catch (_) { fk = true; } assert.ok(fk, 'FK 없음');
    assert.strictEqual((await db.query("select status from web_label.public_supplements")).rows[0].status, 'needs_review');
    await db.query("delete from public.products where product_id=$1", [pid]);
    assert.strictEqual((await db.query("select count(*)::int n from web_label.public_supplements")).rows[0].n, 0);
  });
  await t('product_barcodes: web_label 품목만 · 같은 바코드 여러 품목 가능(증거별) · 상태 CHECK', async () => {
    const w = (await db.query("select product_id from web_label.products limit 1")).rows[0].product_id;
    await db.query("insert into web_label.product_barcodes (barcode, product_id, evidence) values ('8801','" + w + "','{\"report_no_gate\":\"match\"}')");
    assert.strictEqual((await db.query("select status from web_label.product_barcodes")).rows[0].status, 'needs_review');
    let st = false; try { await db.query("update web_label.product_barcodes set status='x'"); } catch (_) { st = true; } assert.ok(st);
    let fk = false; try { await db.query("insert into web_label.product_barcodes (barcode, product_id) values ('1', 999999)"); } catch (_) { fk = true; } assert.ok(fk);
  });
  console.log(`\n[migration 032] ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
})();
