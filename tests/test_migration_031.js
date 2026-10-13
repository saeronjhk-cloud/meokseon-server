/** test_migration_031.js — ★ 세션78 web_label 스키마(PGlite). 같은 양식 · 시퀀스 공유 · FK 분리 · 멱등 · public 무접촉 */
'use strict';
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const MIG = path.join(__dirname, '..', 'scripts', 'migrations'); const read = (f) => fs.readFileSync(path.join(MIG, f), 'utf8');
let pass = 0, fail = 0; const t = async (n, fn) => { try { await fn(); pass++; console.log(`  ✅ ${n}`); } catch (e) { fail++; console.log(`  ❌ ${n}\n     → ${e.message}`); } };
(async () => {
  let PGlite; try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { console.log('⏭ pglite 미설치'); process.exit(1); }
  const db = new PGlite();
  for (const f of ['000_baseline.sql', '021_supabase_auth.sql', '022_additive_detected_count.sql', '023_data_inspection.sql', '024_contribution_review.sql', '025_nutrition_data_crowd.sql', '026_crowd_nutrition_split.sql', '029_review_auto_applied.sql', '030_contribution_photos.sql']) await db.exec(read(f));
  const cols = async (s, tb) => (await db.query(`select column_name, data_type from information_schema.columns where table_schema=$1 and table_name=$2 order by ordinal_position`, [s, tb])).rows;
  const before = await cols('public', 'products');
  await t('031 적용 + 재적용(멱등)', async () => { await db.exec(read('031_web_label_schema.sql')); await db.exec(read('031_web_label_schema.sql')); });
  await t('4표 열 이름·순서가 public 과 같다(data_source 만 text)', async () => {
    for (const tb of ['products', 'product_ingredients', 'nutrition_data', 'product_allergens']) {
      const a = await cols('public', tb), b = await cols('web_label', tb);
      assert.deepStrictEqual(b.map((c) => c.column_name), a.map((c) => c.column_name), tb);
      for (let i = 0; i < a.length; i++) if (a[i].column_name !== 'data_source') assert.strictEqual(b[i].data_type, a[i].data_type, `${tb}.${a[i].column_name}`);
    }
  });
  await t('public.products 열 무변경', async () => assert.deepStrictEqual(await cols('public', 'products'), before));
  await t('product_id 시퀀스 공유 → public 과 겹치지 않음', async () => {
    const a = (await db.query("insert into public.products (barcode, product_name, data_source) values ('1','a','manual_seed') returning product_id")).rows[0].product_id;
    const b = (await db.query("insert into web_label.products (product_name, c005_report_no) values ('b','1976048700519') returning product_id, data_source")).rows[0];
    assert.notStrictEqual(Number(a), Number(b.product_id)); assert.strictEqual(b.data_source, 'web_label');
  });
  await t('FK 는 web_label.products 를 가리킨다(public id 로는 실패)', async () => {
    const pubId = (await db.query("select product_id from public.products limit 1")).rows[0].product_id;
    let threw = false; try { await db.query("insert into web_label.nutrition_data (product_id, calories) values ($1, 1)", [pubId]); } catch (_) { threw = true; } assert.ok(threw);
    const wl = (await db.query("select product_id from web_label.products limit 1")).rows[0].product_id;
    await db.query("insert into web_label.nutrition_data (product_id, calories, serving_size) values ($1, 510, '100g')", [wl]);
    await db.query("insert into web_label.product_allergens (product_id, allergen_name) values ($1, '우유')", [wl]);
    await db.query("insert into web_label.product_ingredients (product_id, raw_text) values ($1, '밀가루')", [wl]);
    const r = (await db.query("select detected_via, evidence_level from web_label.product_allergens")).rows[0]; assert.strictEqual(r.detected_via, 'web_label'); assert.strictEqual(r.evidence_level, 'contains');
  });
  await t('UNIQUE(product_id) 등 인덱스도 같은 양식(nutrition_data 중복 거부)', async () => {
    const wl = (await db.query("select product_id from web_label.products limit 1")).rows[0].product_id;
    let threw = false; try { await db.query("insert into web_label.nutrition_data (product_id) values ($1)", [wl]); } catch (_) { threw = true; } assert.ok(threw);
  });
  await t('source_pages: url 유일 · gate CHECK', async () => {
    await db.query("insert into web_label.source_pages (site,url,gate,fetched_at,batch_id) values ('kurly','u1','not_in_db',now(),'b')");
    let a = false; try { await db.query("insert into web_label.source_pages (site,url,gate,fetched_at,batch_id) values ('kurly','u1','not_in_db',now(),'b')"); } catch (_) { a = true; } assert.ok(a);
    let b = false; try { await db.query("insert into web_label.source_pages (site,url,gate,fetched_at,batch_id) values ('kurly','u2','x',now(),'b')"); } catch (_) { b = true; } assert.ok(b);
  });
  await t('public 행 수 무변경(앱 경로는 web_label 을 모른다)', async () => { const n = (await db.query('select count(*)::int n from public.products')).rows[0].n; assert.strictEqual(n, 1); });
  console.log(`\n  결과: ${pass} 통과 · ${fail} 실패`); process.exit(fail ? 1 : 0);
})();
