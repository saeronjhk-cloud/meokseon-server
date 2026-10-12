/**
 * test_allergen_from_ingredients.js — 세션77: DB 경로 전용 «원재료명 알레르기»(allergens_from_ingredients)
 *   정본 결정: 제이 2026-10-12 «데이터베이스 기반 추론에 한해서 변경 · OCR 파싱은 여전히 유효»
 *              → IP/결정_DS-6db_DB경로_원재료알레르기_2026-10-12.md
 *   §1 엔진 — 제외 규칙(향·콩검·강낭콩류·식물성크림·라우릴황산·둥굴레) · 정본 19종 정규화
 *   §2 eval — HACCP 원재료↔표시란 고정 400쌍에서 정밀도 ≥ 0.96 (규칙 미적용 기준선 0.961 · 규칙 적용 실측은 인수인계 188)
 *   §3 OCR 경로 불변 — ocrParser 는 이 모듈을 쓰지 않고, 원재료명만 있는 OCR 텍스트는 여전히 0(DS-6′ 회귀와 같은 방향)
 *   §4 응답 — 표시란 미수집 + 공공 DB 원재료 → allergens_from_ingredients · 표시란 키는 그대로 null
 *   §5 응답 — 표시란이 있으면 null · OCR 제보 원재료면 null · 원재료 없으면 null
 * 실행: cross-env NODE_ENV=test node tests/test_allergen_from_ingredients.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const BASELINE = path.join(__dirname, '..', 'scripts', 'migrations', '000_baseline.sql');
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.log(`  ❌ ${name}\n     → ${e.message}`); } }

(async () => {
  const { allergensFromIngredients, _excluded } = require('../src/services/allergenFromIngredients');
  console.log('\n══ §1 엔진 ══');
  await t('§1-1 기본: 밀가루·탈지분유·간장 → 밀·우유·대두', () => {
    const r = allergensFromIngredients('밀가루(밀:미국산), 탈지분유, 양조간장, 설탕');
    assert.deepStrictEqual(r.names.sort(), ['대두', '밀', '우유'].sort());
  });
  await t('§1-2 제외: 땅콩향·복숭아향·로커스트콩검·강낭콩·식물성크림·라우릴황산·둥굴레', () => {
    for (const x of ['땅콩향', '복숭아향', '로커스트콩검', '강낭콩', '완두콩', '식물성크림', '라우릴황산나트륨', '둥굴레']) assert.ok(_excluded(x), x);
    assert.deepStrictEqual(allergensFromIngredients('정제수, 땅콩향, 로커스트콩검, 강낭콩, 식물성크림, 둥굴레추출물').names, []);
  });
  await t('§1-3 굴소스 → 조개류 · 메추리알 → 난류', () => {
    const r = allergensFromIngredients('굴소스, 메추리알');
    assert.ok(r.names.includes('조개류') && r.names.includes('난류(가금류)'), JSON.stringify(r.names));
  });
  await t('§1-4 증거(evidence)에 토큰이 남는다 · 규칙 버전', () => {
    const r = allergensFromIngredients('밀가루');
    assert.deepStrictEqual(r.evidence, [{ allergen: '밀', token: '밀가루' }]);
    assert.ok(String(r.rules_version).startsWith('allergen_ing_rules_'));
  });
  await t('§1-5 빈 입력 → 빈 결과', () => { assert.deepStrictEqual(allergensFromIngredients('').names, []); assert.deepStrictEqual(allergensFromIngredients(null).names, []); });

  console.log('\n══ §2 eval (HACCP 고정 400쌍) ══');
  await t('§2 정밀도 ≥ 0.96', () => {
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'allergen_from_ingredients_eval_v1.json'), 'utf8'));
    let tp = 0, fp = 0, fn = 0;
    for (const c of fx.cases) { const truth = new Set(c.truth); const p = allergensFromIngredients(c.raw).names; for (const a of p) truth.has(a) ? tp++ : fp++; for (const a of truth) if (!p.includes(a)) fn++; }
    const prec = tp / (tp + fp), rec = tp / (tp + fn);
    console.log(`     n=${fx.cases.length} tp=${tp} fp=${fp} fn=${fn} precision=${prec.toFixed(3)} recall=${rec.toFixed(3)}`);
    assert.ok(prec >= 0.96, `precision ${prec}`);
  });

  console.log('\n══ §3 OCR 경로 불변 ══');
  await t('§3-1 ocrParser 는 allergenFromIngredients 를 require 하지 않는다', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ocrParser.js'), 'utf8');
    assert.ok(!src.includes('allergenFromIngredients'));
  });
  await t('§3-2 OCR: 원재료명에만 밀가루·우유 → 여전히 0 (DS-6′)', () => {
    const { analyzeText } = require('../src/services/ocrParser');
    const v = analyzeText('원재료명: 밀가루, 우유, 계란').allergens_v2;
    assert.deepStrictEqual([v.contains.length, v.mayContain.length, v.inferred.length], [0, 0, 0]);
  });

  console.log('\n══ §4·§5 응답 ══');
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
  const a = await ins('8800000077001', 'DB원재료·표시란없음');
  const b = await ins('8800000077002', '표시란있음');
  const c = await ins('8800000077003', 'OCR원재료');
  const d = await ins('8800000077004', '원재료없음');
  const e = await ins('8800000077005', '형제원재료');
  await db.query(`INSERT INTO product_ingredients (product_id, raw_text, source) VALUES ($1, '밀가루, 정제수, 대두유', 'c002')`, [a]);
  await db.query(`INSERT INTO product_ingredients (product_id, raw_text, source) VALUES ($1, '밀가루, 우유', 'haccp_api')`, [b]);
  await db.query(`INSERT INTO product_allergens (product_id, allergen_name, detected_via) VALUES ($1, '밀', 'haccp_api')`, [b]);
  await db.query(`INSERT INTO product_ingredients (product_id, raw_text, source) VALUES ($1, '밀가루, 우유', 'ocr_crowdsource')`, [c]);
  await db.query(`INSERT INTO product_ingredients (product_id, raw_text, source) VALUES ($1, '우유, 설탕', 'c005_sibling')`, [e]);
  await t('§4-1 DB 원재료 · 표시란 미수집 → names [밀, 대두] · 표시란 키는 null 그대로', async () => {
    const r = await svc.getProductWithTrafficLight('8800000077001');
    assert.deepStrictEqual(r.allergens_from_ingredients.names.sort(), ['대두', '밀'].sort());
    assert.strictEqual(r.allergens, null); assert.strictEqual(r.allergens_v2, null); assert.strictEqual(r.allergens_available, false);
    assert.strictEqual(r.allergens_flat_complete, null);
  });
  await t('§4-2 형제 채움 원재료도 DB 경로 · ingredient_source sibling', async () => {
    const r = await svc.getProductWithTrafficLight('8800000077005');
    assert.deepStrictEqual(r.allergens_from_ingredients.names, ['우유']); assert.strictEqual(r.allergens_from_ingredients.ingredient_source, 'sibling');
  });
  await t('§5-1 표시란 있으면 null(표시란이 우선 · 섞지 않는다)', async () => {
    const r = await svc.getProductWithTrafficLight('8800000077002');
    assert.strictEqual(r.allergens_from_ingredients, null); assert.deepStrictEqual(r.allergens, ['밀']);
  });
  await t('§5-2 OCR 제보 원재료 → null (OCR 경로는 표시사항만)', async () => {
    const r = await svc.getProductWithTrafficLight('8800000077003');
    assert.strictEqual(r.allergens_from_ingredients, null);
  });
  await t('§5-3 원재료 없음 → null', async () => {
    const r = await svc.getProductWithTrafficLight('8800000077004');
    assert.strictEqual(r.allergens_from_ingredients, null);
  });
  console.log(`\n  결과: ${pass} 통과 · ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
