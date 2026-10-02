/**
 * ★ 세션73 U71-3 — 라벨 인쇄 % ↔ 우리 계산 % 병기 (labelDvCheck.buildLabelDv · labelDvRead.getLabelDv)
 *   §1 순수 함수 — 운영 실례(호두정과 306264 · contribution 10 의 _dv_check + nutrition_data_crowd 행)
 *   §2 경계 — weak 제외 · factor 모름 → our null · % 없음 → null
 *   §3 DB(PGlite) — 제보만 있는 제품은 값 · 공공 행이 있으면 null · 실패해도 throw 없음
 *   §4 배선 — productService 가 nutrition.label_dv 를 싣는다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let pass = 0; let fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.log(`  ❌ ${name}\n     → ${e.message.split('\n').slice(0, 4).join('\n       ')}`); }
}
const SRV = path.join(__dirname, '..');
const MIG = path.join(SRV, 'scripts', 'migrations');
const MF = fs.readdirSync(MIG);
const mig = (p) => fs.readFileSync(path.join(MIG, MF.find((x) => x.startsWith(`${p}_`) && x.endsWith('.sql'))), 'utf8');

// 운영 실측 그대로(2026-10-02 콘솔 덤프 · contribution 10)
const HODU_DV = { checked: {
  sodium: { pct: 3, value: 60, status: 'ok' }, protein: { pct: 20, value: 11, status: 'ok' },
  total_fat: { pct: 83, value: 43, status: 'mismatch' }, cholesterol: { pct: 0, value: 0, status: 'weak' },
  total_carbs: { pct: 7, value: 23, status: 'ok' }, saturated_fat: { pct: 29, value: 4.3, status: 'ok' } } };
// 운영 상품 API 값(10g 1회분 · 라벨 기준 per_total 80g → factor 10/80)
const HODU_CROWD = { basis_original: 'per_total', convert_factor: 0.125, sodium: 7.5, total_carbs: 2.875,
  total_sugars: 2.25, total_fat: 5.375, saturated_fat: 0.538, cholesterol: 0, protein: 1.375 };

async function main() {
  const L = require('../src/services/labelDvCheck');
  console.log('\n── §1 호두정과 실례');
  await t('§1-1 지방 라벨 83% · 계산 80% → 불일치 (43/54=79.6%)', () => {
    const r = L.buildLabelDv(HODU_DV, HODU_CROWD);
    assert.strictEqual(r.basis, 'per_total');
    assert.deepStrictEqual(r.items.total_fat, { label_pct: 83, our_pct: 80, agree: false });
  });
  await t('§1-2 포화지방 29/29 · 나트륨 3/3 · 탄수 7/7 · 단백질 20/20 → 일치', () => {
    const r = L.buildLabelDv(HODU_DV, HODU_CROWD);
    for (const [k, p] of [['saturated_fat', 29], ['sodium', 3], ['total_carbs', 7], ['protein', 20]]) {
      assert.deepStrictEqual(r.items[k], { label_pct: p, our_pct: p, agree: true }, k);
    }
  });
  await t('§1-3 콜레스테롤 0%(weak) 는 라벨 %로 쓰지 않는다 · 당류는 %가 원문에 없어 없음', () => {
    const r = L.buildLabelDv(HODU_DV, HODU_CROWD);
    assert.ok(!('cholesterol' in r.items)); assert.ok(!('total_sugars' in r.items));
  });
  console.log('\n── §2 경계');
  await t('§2-1 factor 모름 → our_pct·agree null(라벨 %는 그대로)', () => {
    const r = L.buildLabelDv(HODU_DV, { ...HODU_CROWD, convert_factor: null });
    assert.deepStrictEqual(r.items.total_fat, { label_pct: 83, our_pct: null, agree: null });
  });
  await t('§2-2 _dv_check 없음 · weak 만 · crowd 없음 → null', () => {
    assert.strictEqual(L.buildLabelDv(null, HODU_CROWD), null);
    assert.strictEqual(L.buildLabelDv({ checked: { cholesterol: { pct: 0, status: 'weak' } } }, HODU_CROWD), null);
    assert.strictEqual(L.buildLabelDv(HODU_DV, null), null);
  });
  await t('§2-3 관리자 정정 반영 — 저장값이 바뀌면 우리 %도 바뀐다(라벨 %는 라벨 그대로)', () => {
    const r = L.buildLabelDv(HODU_DV, { ...HODU_CROWD, total_fat: 45 * 0.125 });
    assert.deepStrictEqual(r.items.total_fat, { label_pct: 83, our_pct: 83, agree: true });
  });

  await t('§2-4 라벨 값이 정수면 반올림 폭 ±0.5 — 「단백질 4g 8%」(092 실물) 은 일치', () => {
    const r = L.buildLabelDv({ checked: { protein: { pct: 8, value: 4, status: 'ok' } } }, { convert_factor: 1, protein: 4 });
    assert.deepStrictEqual(r.items.protein, { label_pct: 8, our_pct: 7, agree: true });
  });
  await t('§2-5 실물 전사 61제품 — 불일치는 086 「당류 0 g 2%」(라벨 자체 모순) 1건뿐', () => {
    const P = require('../src/services/ocrParser');
    const dir = path.join(SRV, '..', '.tmp', 'captures', 'transcripts');
    if (!fs.existsSync(dir)) return;   // 전사가 없는 환경(CI 단독 체크아웃)은 건너뜀
    const dis = [];
    for (const f of fs.readdirSync(dir).sort()) {
      const n = P.parseNutrition(fs.readFileSync(path.join(dir, f), 'utf8'));
      const r = n._dv_check && L.buildLabelDv(n._dv_check, { ...n, convert_factor: 1 });
      if (!r) continue;
      for (const [k, v] of Object.entries(r.items)) if (v.agree === false) dis.push(`${f}:${k}`);
    }
    assert.deepStrictEqual(dis, ['086.txt:total_sugars']);
  });

  console.log('\n── §3 DB(PGlite)');
  let PGlite;
  try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { console.log('⏭ pglite 없음 — EXIT=1'); process.exit(1); }
  const db = new PGlite();
  await db.exec(mig('000'));
  for (const p of ['023', '024', '025', '026']) await db.exec(mig(p));
  const q = (text, params) => db.query(text, params || []);
  const pid = (await q(`INSERT INTO products (product_name, data_source) VALUES ('호두정과', 'ocr_crowdsource') RETURNING product_id`)).rows[0].product_id;
  const cid = (await q(`INSERT INTO contributions (product_id, contribution_type, data) VALUES ($1, 'ocr_label', $2::jsonb) RETURNING contribution_id`,
    [pid, JSON.stringify({ parsed_nutrition: { _dv_check: HODU_DV } })]).catch(async (e) => {
    // contribution_type 등 필수 컬럼이 다르면 스키마를 보고 맞춘다
    throw new Error('contributions INSERT 실패: ' + e.message);
  })).rows[0].contribution_id;
  await q(`INSERT INTO nutrition_data_crowd (product_id, total_fat, saturated_fat, sodium, total_carbs, protein, cholesterol,
            contribution_id, basis_original, basis_stored, convert_factor)
           VALUES ($1, 5.375, 0.538, 7.5, 2.875, 1.375, 0, $2, 'per_total', 'per_serving', 0.125)`, [pid, cid]);
  const { getLabelDv } = require('../src/services/labelDvRead');
  await t('§3-1 제보만 있는 제품 → label_dv 값(지방 83 vs 80)', async () => {
    const r = await getLabelDv({ query: q }, pid);
    assert.deepStrictEqual(r.items.total_fat, { label_pct: 83, our_pct: 80, agree: false });
  });
  await t('§3-2 공공 행(nutrition_data)이 있으면 null', async () => {
    await q(`INSERT INTO nutrition_data (product_id, calories) VALUES ($1, 100)`, [pid]);
    assert.strictEqual(await getLabelDv({ query: q }, pid), null);
  });
  await t('§3-3 DB 오류 → throw 없이 null', async () => {
    assert.strictEqual(await getLabelDv({ query: async () => { throw new Error('boom'); } }, pid), null);
  });

  console.log('\n── §4 배선');
  await t('§4-1 productService 가 제보 영양일 때 getLabelDv 를 부르고 nutrition.label_dv 로 싣는다', () => {
    const src = fs.readFileSync(path.join(SRV, 'src', 'services', 'productService.js'), 'utf8');
    assert.ok(/product\.nutrition_source === 'ocr_crowdsource'/.test(src));
    assert.ok(/label_dv: labelDv,/.test(src));
  });

  console.log(`\n════ 통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
