#!/usr/bin/env node
/**
 * 117-web-label-nutrition-fill.js — ★ 세션83 판매처 신규 품목 중 «영양 행이 없는» 것에 영양을 새로 채운다(제이 결정 ⑨ «채워» 2026-10-22).
 *   왜: 102 적재 때 기준 unknown 이라 영양 없이 만들어진 품목이 83a(D 규칙) 이후 원문에서 다시 읽힌다. 115 는 «있는 값만» 고친다.
 *   정답 IP/eval_web_label_fill_v1 = tests/fixtures/web_label_fill_v1.json (F1~F5)
 *   규칙: F1 web_label.products 중 source_pages(target 'web_label') 가 있고 web_label.nutrition_data 행이 없는 것만
 *         F2 원문 → webFromText(102 와 같은 함수) per100 이 상식 범위(sane) · 두 파서 기준이 모두 unknown 아님
 *         F3 열량 + 주요 영양소(나트륨·탄수화물·당류·지방·단백질) 3개 이상 — 열량만 있는 라벨은 채우지 않음(청매실 캔디·젤리)
 *         F4 행 모양 = 102 신규 품목과 같다(serving_size '100g'/'100ml' · KEYS · label_basis 는 consistent 일 때만 · data_source 'web_label')
 *         F5 INSERT 만 · 되돌리기 = 기록의 nutrition_id DELETE(--undo). 적용 후 104 게이트 재실행.
 * 사용(meokseon-server): node scripts/117-web-label-nutrition-fill.js --ocr-dir ../.tmp/s78/crawl_run1/ocr [--expect 13] [--check-fixture] [--apply] | --undo fill_<시각>
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch (_) { /* */ }
const fs = require('fs'); const path = require('path');
const { webFromText, sane } = require('./102-web-label-load');
const canon = require('./lib/capture_label_parser');
const { consistent } = require('./lib/label_basis');
const KEYS = ['calories', 'total_fat', 'saturated_fat', 'trans_fat', 'cholesterol', 'sodium', 'total_carbs', 'total_sugars', 'protein'];
const MAJOR = ['sodium', 'total_carbs', 'total_sugars', 'total_fat', 'protein'];
const LOGDIR = path.join(__dirname, '..', '..', 'IP', 'eval_web_label_fill_v1');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };

/** 순수: 원문·상품명 → { row } | { skip: 사유 } */
function planFill(text, name) {
  if (!text) return { skip: 'no_text' };
  const w = webFromText(text);
  if (!w || !w.per100) return { skip: 'no_value' };
  if (!w.basis || w.basis === 'unknown') return { skip: 'basis_unknown_runtime' };
  const L = canon.parseLabel(text);
  if (!L.basis || L.basis === 'unknown') return { skip: 'basis_unknown_capture' };
  if (!sane(w.per100)) return { skip: 'insane' };
  if (MAJOR.filter((k) => w.per100[k] != null).length < 3) return { skip: 'sparse' };
  const unitMl = /m[lL]|㎖/.test(String(L.basis_unit || '') + String(L.total_unit || '')) || /\d\s*(?:m[lL]|㎖)\b/.test(String(name || '')) || w.basis === 'per_100ml';
  const row = { serving_size: unitMl ? '100ml' : '100g' };
  for (const k of KEYS) row[k] = w.per100[k] ?? null;
  const per = {}; for (const k of KEYS) if (row[k] != null) per[k] = row[k];
  row.label_basis = w.label && consistent(w.label, per) ? w.label : null;
  return { row, basis: w.basis, basis_amount: w.basis_amount };
}

function readOcr(dir, no) {
  const d = path.join(dir, 'rv_' + no);
  try { return fs.readdirSync(d).filter((f) => f.endsWith('.txt')).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join('\n'); } catch (_) { return null; }
}

async function main() {
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const undo = arg('--undo');
    if (undo) {
      const log = JSON.parse(fs.readFileSync(path.join(LOGDIR, `apply_${undo}.json`), 'utf8'));
      const ids = log.inserted.map((r) => r.nutrition_id);
      const r = await c.query('delete from web_label.nutrition_data where nutrition_id = any($1) returning nutrition_id', [ids]);
      console.log('↩ 되돌림', undo, r.rowCount, '/', ids.length, '| 다음: 104 게이트 재실행'); return;
    }
    const OCR = arg('--ocr-dir'); if (!OCR) throw new Error('--ocr-dir 필요');
    const rows = (await c.query(`select p.product_id, p.product_name, p.status, min(sp.site_item_no) site_item_no
        from web_label.products p join web_label.source_pages sp on sp.product_id = p.product_id and sp.target_schema = 'web_label'
        where not exists (select 1 from web_label.nutrition_data n where n.product_id = p.product_id)
        group by p.product_id, p.product_name, p.status order by p.product_id`)).rows;
    const plan = []; const skip = {};
    for (const r of rows) { const x = planFill(readOcr(OCR, r.site_item_no), r.product_name); if (x.row) plan.push({ ...r, ...x }); else skip[x.skip] = (skip[x.skip] || 0) + 1; }
    console.log('영양 없는 판매처 품목', rows.length, '· 채울 대상', plan.length, '· 제외', JSON.stringify(skip));
    for (const r of plan) console.log('  ', r.product_id, r.product_name, '|', r.status, '|', r.basis, r.basis_amount || '', '→', r.row.serving_size, 'kcal', r.row.calories, 'Na', r.row.sodium, '당', r.row.total_sugars);
    const ex = arg('--expect'); if (ex != null && Number(ex) !== plan.length) throw new Error(`대상 수 ${plan.length} ≠ 기대 ${ex} — 적용하지 않음`);
    // F6 — 정답의 양성 product_id 와 «같은 목록»이어야 적용(수만 같고 품목이 다르면 거부)
    if (process.argv.includes('--check-fixture')) {
      const want = require('../tests/fixtures/web_label_fill_v1.json').cases.filter((x) => x.product_id).map((x) => String(x.product_id)).sort().join(',');
      const got = plan.map((r) => String(r.product_id)).sort().join(',');
      if (want !== got) throw new Error(`대상 목록이 정답(F01~F13)과 다름 — 적용하지 않음\n  정답 ${want}\n  지금 ${got}`);
      console.log('F6 대상 목록 = 정답 F01~F13 ✅');
    }
    if (!process.argv.includes('--apply')) return;
    const batch = 'fill_' + new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const inserted = [];
    await c.query('BEGIN');
    for (const r of plan) {
      const q = await c.query(`insert into web_label.nutrition_data (product_id, ${KEYS.join(',')}, serving_size, data_source, label_basis)
          select $1, ${KEYS.map((_, i) => `$${i + 2}::numeric`).join(',')}, $${KEYS.length + 2}, 'web_label', $${KEYS.length + 3}::jsonb
          where not exists (select 1 from web_label.nutrition_data n where n.product_id = $1) returning nutrition_id`,
        [r.product_id, ...KEYS.map((k) => r.row[k]), r.row.serving_size, r.row.label_basis ? JSON.stringify(r.row.label_basis) : null]);
      if (q.rows[0]) inserted.push({ nutrition_id: q.rows[0].nutrition_id, product_id: r.product_id, name: r.product_name, row: r.row });
    }
    await c.query('COMMIT');
    fs.mkdirSync(LOGDIR, { recursive: true }); const f = path.join(LOGDIR, `apply_${batch}.json`);
    fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), batch, inserted }, null, 1));
    console.log('✅ 적용', batch, inserted.length, '→', f, '| 다음: 104 게이트 재실행 · 되돌리기 --undo', batch);
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); await pool.end(); }
}
if (require.main === module) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
module.exports = { planFill };
