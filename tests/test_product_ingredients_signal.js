/**
 * test_product_ingredients_signal.js — 세션75j: 제품 응답에 원재료 원문 + 첨가물 신호등 v3
 *   §1 원재료 자기 것이 있으면 own 우선(형제 채움분이 같이 있어도)
 *   §2 형제 채움분만 있으면 source 'sibling'
 *   §3 원재료 행이 없으면 키는 있고 값 null(= 서버가 «없다»고 말함 → 웹 결손 배너)
 *   §4 /additives — 저장된 첨가물마다 signal(색·규칙·이유) · 기존 필드 불변 · signal_summary
 *   §5 저장된 첨가물 0개 + 원재료 원문 → derived_additives(검출기 v2) · additives/risk_summary 는 그대로 0
 *   §6 저장 첨가물이 있으면 derived_additives = null(원재료에서 다시 뽑지 않음)
 * pglite 에 정본 000_baseline.sql 을 적용하고 실제 서비스만 호출한다.
 * 실행: cross-env NODE_ENV=test node tests/test_product_ingredients_signal.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const BASELINE = path.join(__dirname, '..', 'scripts', 'migrations', '000_baseline.sql');
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.log(`  ❌ ${name}\n     → ${e.message}`); } }

(async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  await db.exec(fs.readFileSync(BASELINE, 'utf8'));
  const shim = { pool: null, query: (q, p) => db.query(q, p || []), healthCheck: async () => ({ status: 'healthy' }) };
  const dbPath = require.resolve('../src/config/database');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };
  const loggerPath = require.resolve('../src/config/logger');
  require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: { info() {}, warn() {}, error() {}, debug() {} } };
  const svc = require('../src/services/productService');

  const ins = async (bc, name) => (await db.query(`INSERT INTO products (barcode, product_name, data_source) VALUES ($1, $2, 'public_c005') RETURNING product_id`, [bc, name])).rows[0].product_id;
  const p1 = await ins('8800000075001', '자기원재료');
  const p2 = await ins('8800000075002', '형제원재료');
  const p3 = await ins('8800000075003', '원재료없음');
  const p4 = await ins('8800000075004', '첨가물있음');
  await db.query(`INSERT INTO product_ingredients (product_id, raw_text, source) VALUES ($1, '형제 원문', 'c005_sibling'), ($1, '밀가루, 설탕', 'haccp_api')`, [p1]);
  await db.query(`INSERT INTO product_ingredients (product_id, raw_text, source) VALUES ($1, '정제수, 설탕, 구연산, 아스파탐(감미료), 합성향료', 'c005_sibling')`, [p2]);
  const aid = (await db.query(`INSERT INTO additives (name_ko, category) VALUES ('이산화티타늄', '착색료') RETURNING additive_id`)).rows[0].additive_id;
  await db.query(`INSERT INTO product_additives (product_id, additive_id) VALUES ($1, $2)`, [p4, aid]);
  await db.query(`INSERT INTO product_ingredients (product_id, raw_text, source) VALUES ($1, '설탕, 구연산', 'haccp_api')`, [p4]);

  console.log('\n══ 세션75j — 원재료 원문 + 신호등 v3 ══');
  await t('§1 자기 원재료 우선', async () => {
    const r = await svc.getProductWithTrafficLight('8800000075001');
    assert.strictEqual(r.ingredients_text, '밀가루, 설탕'); assert.strictEqual(r.ingredients_source, 'own');
  });
  await t('§2 형제 채움분만 있으면 sibling', async () => {
    const r = await svc.getProductWithTrafficLight('8800000075002');
    assert.strictEqual(r.ingredients_source, 'sibling'); assert.ok(r.ingredients_text.startsWith('정제수'));
  });
  await t('§3 원재료 없으면 키는 있고 null', async () => {
    const r = await svc.getProductWithTrafficLight('8800000075003');
    assert.ok('ingredients_text' in r); assert.strictEqual(r.ingredients_text, null); assert.strictEqual(r.ingredients_source, null);
  });
  await t('§4 저장 첨가물에 signal · 기존 필드 불변 · signal_summary', async () => {
    const r = await svc.getProductAdditives('8800000075004');
    assert.strictEqual(r.additives.length, 1);
    assert.strictEqual(r.additives[0].name_ko, '이산화티타늄');
    assert.strictEqual(r.additives[0].signal.color, 'red'); assert.strictEqual(r.additives[0].signal.rule, 'R2');
    assert.strictEqual(r.risk_summary.total, 1);
    assert.strictEqual(r.signal_summary.red, 1);
    assert.strictEqual(r.derived_additives, null, '§6 저장 첨가물이 있으면 원재료에서 다시 뽑지 않는다');
  });
  await t('§5 저장 0개 + 원재료 → derived_additives(검출기 v2 + 신호) · 기존 집계는 0 그대로', async () => {
    const r = await svc.getProductAdditives('8800000075002');
    assert.strictEqual(r.additives.length, 0); assert.strictEqual(r.risk_summary.total, 0);
    assert.ok(r.derived_additives, 'derived_additives 가 없다');
    assert.strictEqual(r.derived_additives.source, 'sibling');
    const names = r.derived_additives.items.map((x) => x.name);
    assert.ok(names.includes('구연산') && names.includes('아스파탐'), JSON.stringify(names));
    const asp = r.derived_additives.items.find((x) => x.name === '아스파탐');
    assert.strictEqual(asp.signal.color, 'orange');
  });
  await t('§5-b 원재료도 첨가물도 없으면 derived_additives = null', async () => {
    const r = await svc.getProductAdditives('8800000075003');
    assert.strictEqual(r.derived_additives, null);
  });
  console.log(`\n  결과: ${pass} 통과 · ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
