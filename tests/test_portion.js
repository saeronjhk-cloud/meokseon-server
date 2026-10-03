/**
 * ★ 2026-10-03 영양공식 웹앱트랙 — 가공식품 «먹은 양» × 영양 (portionService) 평가 C01~C15 · R01~R02
 *   평가셋 원본: 영양공식 IP/integration/meal_product_log_eval_v1.md
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
let pass = 0; let fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.log(`  ❌ ${name}\n     → ${e.message.split('\n').slice(0, 4).join('\n       ')}`); } }
const P = require('../src/services/portionService');

const per100g = (kcal, extra = {}) => ({ calories: kcal, total_carbs: 60, protein: 7, total_fat: 25, sodium: 500, total_sugars: 5, dietary_fiber: 2, saturated_fat: 10, nutrition_serving_size: '100g', ...extra });
const perServ = (kcal, extra = {}) => ({ calories: kcal, total_carbs: 20, protein: 2, total_fat: 4, sodium: 150, total_sugars: 8, dietary_fiber: 1, saturated_fat: 2, nutrition_serving_size: null, ...extra });

async function main() {
  console.log('\n── C. 계산');
  const chip = { total_content: 70, content_unit: 'g' };
  await t('C01 per_100g 500kcal · 총 70g · 1개 → 350kcal · 70g · «1개(70g)»', () => {
    const r = P.computePortion(chip, per100g(500), { kind: 'pack', qty: 1 });
    assert.ok(r.ok); assert.strictEqual(r.factor, 0.7); assert.strictEqual(r.nutrients.calories_kcal, 350);
    assert.strictEqual(r.grams, 70); assert.strictEqual(r.label, '1개(70g)'); assert.strictEqual(r.basis, 'per_100g');
    assert.strictEqual(r.nutrients.sodium_mg, 350);
  });
  await t('C02 ½개 → 175kcal · 35g · «½개(35g)»', () => {
    const r = P.computePortion(chip, per100g(500), { kind: 'pack', qty: 0.5 });
    assert.strictEqual(r.nutrients.calories_kcal, 175); assert.strictEqual(r.grams, 35); assert.strictEqual(r.label, '½개(35g)');
  });
  await t('C03 30g → 150kcal · «30g»', () => {
    const r = P.computePortion(chip, per100g(500), { kind: 'gram', qty: 30 });
    assert.strictEqual(r.nutrients.calories_kcal, 150); assert.strictEqual(r.label, '30g');
  });
  await t('C04 per_100ml 42kcal · 500ml · 1개 → 210kcal · «1개(500ml)»', () => {
    const r = P.computePortion({ total_content: 500, content_unit: 'ml' }, per100g(42, { nutrition_serving_size: '100ml' }), { kind: 'pack', qty: 1 });
    assert.strictEqual(r.nutrients.calories_kcal, 210); assert.strictEqual(r.grams, 500); assert.strictEqual(r.label, '1개(500ml)'); assert.strictEqual(r.approx, false);
  });
  await t('C05 per_serving 120kcal · 1회 30g · 총 90g · spc 없음 → 1개 = 3회 = 360kcal · 90g', () => {
    const r = P.computePortion({ serving_size: 30, total_content: 90, content_unit: 'g' }, perServ(120), { kind: 'pack', qty: 1 });
    assert.strictEqual(r.factor, 3); assert.strictEqual(r.nutrients.calories_kcal, 360); assert.strictEqual(r.grams, 90); assert.strictEqual(r.basis, 'per_serving');
  });
  await t('C06 servings_per_container 명시값 우선 → 4회 = 480kcal', () => {
    const r = P.computePortion({ serving_size: 30, total_content: 90, servings_per_container: 4 }, perServ(120), { kind: 'pack', qty: 1 });
    assert.strictEqual(r.nutrients.calories_kcal, 480);
  });
  await t('C07 1회 제공량 ×2 → 240kcal · 60g · «1회 제공량 ×2(60g)»', () => {
    const r = P.computePortion({ serving_size: 30, content_unit: 'g' }, perServ(120), { kind: 'serving', qty: 2 });
    assert.strictEqual(r.nutrients.calories_kcal, 240); assert.strictEqual(r.grams, 60); assert.strictEqual(r.label, '1회 제공량 ×2(60g)');
  });
  await t('C08 per_serving 45g → f 1.5 · 180kcal', () => {
    const r = P.computePortion({ serving_size: 30 }, perServ(120), { kind: 'gram', qty: 45 });
    assert.strictEqual(r.factor, 1.5); assert.strictEqual(r.nutrients.calories_kcal, 180);
  });
  await t('C09 per_serving · 1회·총 없음 → 1개·g 불가(need_serving_info) · 1회 1 은 가능(grams null)', () => {
    assert.deepStrictEqual(P.computePortion({}, perServ(120), { kind: 'pack', qty: 1 }), { ok: false, reason: 'need_serving_info' });
    assert.deepStrictEqual(P.computePortion({}, perServ(120), { kind: 'gram', qty: 50 }), { ok: false, reason: 'need_serving_info' });
    const r = P.computePortion({}, perServ(120), { kind: 'serving', qty: 1 });
    assert.ok(r.ok); assert.strictEqual(r.nutrients.calories_kcal, 120); assert.strictEqual(r.grams, null); assert.strictEqual(r.label, '1회 제공량');
  });
  await t('C10 per_100g · 총 없음 → 1개 불가(need_total_content) · g 가능', () => {
    assert.deepStrictEqual(P.computePortion({ content_unit: 'g' }, per100g(500), { kind: 'pack', qty: 1 }), { ok: false, reason: 'need_total_content' });
    assert.ok(P.computePortion({ content_unit: 'g' }, per100g(500), { kind: 'gram', qty: 20 }).ok);
  });
  await t('C11 영양 없음 → no_nutrition · options 전부 비활성', () => {
    const nul = { calories: null, total_carbs: null, protein: null, total_fat: null, sodium: null, total_sugars: null, dietary_fiber: null, saturated_fat: null };
    assert.deepStrictEqual(P.computePortion(chip, nul, { kind: 'pack', qty: 1 }), { ok: false, reason: 'no_nutrition' });
    assert.deepStrictEqual(P.computePortion(chip, null, { kind: 'pack', qty: 1 }), { ok: false, reason: 'no_nutrition' });
    assert.ok(P.portionOptions(chip, nul).every((o) => !o.available && o.reason === 'no_nutrition'));
  });
  await t('C12 수량 이상값 거부 (0 · −1 · 21개 · 5001g · NaN · 계수 50 초과)', () => {
    for (const a of [{ kind: 'pack', qty: 0 }, { kind: 'pack', qty: -1 }, { kind: 'pack', qty: 21 }, { kind: 'gram', qty: 5001 }, { kind: 'gram', qty: NaN }, { kind: 'serving', qty: 'x' }]) {
      assert.deepStrictEqual(P.computePortion(chip, per100g(500), a), { ok: false, reason: 'invalid_qty' }, JSON.stringify(a));
    }
    assert.deepStrictEqual(P.computePortion(chip, per100g(500), { kind: 'cup', qty: 1 }), { ok: false, reason: 'invalid_kind' });
    // 계수 상한: 1회 1g 제품 60g → f 60
    assert.deepStrictEqual(P.computePortion({ serving_size: 1 }, perServ(10), { kind: 'gram', qty: 60 }), { ok: false, reason: 'invalid_qty' });
  });
  await t('C13 per_100_unknown · 총 200g · 1개 → 계산 + approx', () => {
    const r = P.computePortion({ total_content: 200, content_unit: 'g' }, per100g(300, { nutrition_serving_size: '100unknown' }), { kind: 'pack', qty: 1 });
    assert.ok(r.ok); assert.strictEqual(r.approx, true); assert.strictEqual(r.nutrients.calories_kcal, 600);
    const r2 = P.computePortion({ total_content: 500, content_unit: 'ml' }, per100g(40), { kind: 'pack', qty: 1 });
    assert.strictEqual(r2.approx, true, 'per_100g 인데 ml 제품');
  });
  await t('C14 일부 영양 null(당류) → null 유지 · 나머지 계산', () => {
    const r = P.computePortion(chip, per100g(500, { total_sugars: null }), { kind: 'pack', qty: 1 });
    assert.strictEqual(r.nutrients.sugar_g, null); assert.strictEqual(r.nutrients.protein_g, 4.9);
  });
  await t('C15 options = 단위별 가능 여부', () => {
    const byKind = (o) => Object.fromEntries(o.map((x) => [x.kind, x.available ? 'ok' : x.reason]));
    assert.deepStrictEqual(byKind(P.portionOptions(chip, per100g(500))), { pack: 'ok', serving: 'need_serving_info', gram: 'ok' });
    assert.deepStrictEqual(byKind(P.portionOptions({}, perServ(120))), { pack: 'need_serving_info', serving: 'ok', gram: 'need_serving_info' });
    assert.deepStrictEqual(byKind(P.portionOptions({ serving_size: 30, total_content: 90 }, perServ(120))), { pack: 'ok', serving: 'ok', gram: 'ok' });
    assert.deepStrictEqual(byKind(P.portionOptions({ content_unit: 'g' }, per100g(500))), { pack: 'need_total_content', serving: 'need_serving_info', gram: 'ok' });
  });

  console.log('\n── R. 응답 키 · 라우트');
  await t('R01 GET /api/products/:barcode — nutrition.basis 키 추가(기존 키 유지)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'productService.js'), 'utf8');
    assert.ok(src.includes('basis: deriveBasis(product.nutrition_serving_size),\n'), 'basis 키');
    for (const k of ['calories: product.calories', 'label_dv: labelDv', 'basis_confident:', 'source_license:']) assert.ok(src.includes(k), k);
    const model = fs.readFileSync(path.join(__dirname, '..', 'src', 'models', 'productModel.js'), 'utf8');
    const hot = model.slice(model.indexOf('async function findByBarcode'), model.indexOf('★ 2026-10-03 영양공식 웹앱트랙 — 가공식품'));
    assert.ok(!hot.includes('servings_per_container'), '뜨거운 경로 SELECT 는 그대로');
  });
  await t('R02 GET /:barcode/portion — 200 계산 · kind 오류 400 · 잘못된 바코드 400 · 미등록 404', async () => {
    const dbPath = require.resolve('../src/config/database');
    const row = { product_id: 7, barcode: '8801234567890', product_name: '테스트칩', brand: 'B', serving_size: null, total_content: 70, content_unit: 'g', servings_per_container: null, calories: 500, total_carbs: 60, protein: 7, total_fat: 25, sodium: 500, total_sugars: 5, dietary_fiber: 2, saturated_fat: 10, nutrition_serving_size: '100g' };
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: async (_sql, params) => ({ rows: params && params[0] === '8801234567890' ? [row] : [] }) } };
    const app = require('../src/app');
    const srv = app.listen(0); const port = srv.address().port;
    const get = (p) => new Promise((res, rej) => http.get({ port, path: p }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(b) })); }).on('error', rej));
    try {
      const ok = await get('/api/products/8801234567890/portion?kind=pack&qty=0.5');
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.body.data.portion.nutrients.calories_kcal, 175);
      assert.strictEqual(ok.body.data.basis, 'per_100g');
      assert.strictEqual(ok.body.data.options.length, 3);
      const opt = await get('/api/products/8801234567890/portion');
      assert.strictEqual(opt.status, 200); assert.strictEqual(opt.body.data.portion, null);
      assert.strictEqual((await get('/api/products/8801234567890/portion?kind=cup')).status, 400);
      assert.strictEqual((await get('/api/products/12ab/portion?kind=pack')).status, 400);
      assert.strictEqual((await get('/api/products/8800000000000/portion?kind=pack')).status, 404);
    } finally { srv.close(); }
  });

  console.log(`\n결과: ${pass} 통과 · ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}
main();
