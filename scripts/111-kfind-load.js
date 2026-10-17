#!/usr/bin/env node
/**
 * 111-kfind-load.js — 식약처 K-FIND 가공식품DB → kfind 스키마 적재 (세션80 · 결정 80-1 · 035 선행)
 *   입력: 핵심열 CSV.gz (.tmp/s80/kfind_<YYYYMMDD>/kfind_<YYYYMMDD>_core.csv.gz — conv.py 로 xlsx 에서 뽑은 24열)
 *   하는 일: kfind.releases 1행 + kfind.products upsert(food_cd). nutrition_ok = web_label_gate.nutritionOk(4·4·9 · 같은 함수).
 *     --withdraw-missing : 이번 판에 없는 기존 active 행 → withdrawn (분기 갱신 때)
 *   ⚠ public·web_label 무접촉. 숨김은 읽기 시점 규칙(kfindModel).
 *   되돌리기: 적재 전 상태(before image)를 .tmp/s80/kfind_load/<batch>.before.json 에 남긴다 → --undo <batch>
 * 사용(meokseon-server):
 *   node scripts/111-kfind-load.js --in <csv.gz> --release 20260929 [--file-name …] [--withdraw-missing]          미리보기
 *   node scripts/111-kfind-load.js --in <csv.gz> --release 20260929 --apply
 *   node scripts/111-kfind-load.js --undo kfind_<시각>
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch (_) { /* */ }
const fs = require('fs'); const path = require('path'); const zlib = require('zlib');
const G = require('./lib/web_label_gate');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const has = (k) => process.argv.includes(k);
const LOGDIR = path.join(__dirname, '..', '..', '.tmp', 's80', 'kfind_load');

function parseCsv(t) { const out = []; let row = [], f = '', q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; } else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f); out.push(row); row = []; f = ''; } else if (c !== '\r') f += c; } if (f || row.length) { row.push(f); out.push(row); } return out; }
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const txt = (v) => { const s = (v == null ? '' : String(v)).replace(/﻿/g, '').trim(); return s === '' || s === '해당없음' ? null : s; };
const NUT = [['calories', '에너지(kcal)'], ['total_fat', '지방(g)'], ['saturated_fat', '포화지방산(g)'], ['trans_fat', '트랜스지방산(g)'], ['cholesterol', '콜레스테롤(mg)'], ['sodium', '나트륨(mg)'], ['total_carbs', '탄수화물(g)'], ['total_sugars', '당류(g)'], ['dietary_fiber', '식이섬유(g)'], ['protein', '단백질(g)']];
const COLS = ['food_cd', 'food_name', 'report_no', 'maker', 'importer', 'distributor', 'is_imported', 'origin_country', 'category_l', 'rep_food', 'food_type', 'basis', 'food_weight', 'serving_ref', ...NUT.map((x) => x[0]), 'nutrition_ok', 'gen_method', 'gen_date'];
const TYPES = ['text', 'text', 'text', 'text', 'text', 'text', 'boolean', 'text', 'text', 'text', 'text', 'text', 'text', 'text', ...NUT.map(() => 'numeric'), 'boolean', 'text', 'date'];

/** CSV 행 → kfind.products 값(순수). 기준량이 100g/100ml 가 아니면 null(적재 안 함). */
function toRow(r, I) {
  const base = String(r[I('영양성분함량기준량')] || '').replace(/\s/g, '').toLowerCase();
  const basis = base === '100g' ? 'per_100g' : base === '100ml' ? 'per_100ml' : null;
  const name = txt(r[I('식품명')]);
  if (!basis || !name || !txt(r[I('식품코드')])) return null;
  const o = {
    food_cd: txt(r[I('식품코드')]), food_name: name, report_no: txt(r[I('품목제조보고번호')]),
    maker: txt(r[I('제조사명')]), importer: txt(r[I('수입업체명')]), distributor: txt(r[I('유통업체명')]),
    is_imported: r[I('수입여부')] === 'Y', origin_country: txt(r[I('원산지국명')]),
    category_l: txt(r[I('식품대분류명')]), rep_food: txt(r[I('대표식품명')]), food_type: txt(r[I('식품소분류명')]), basis,
    food_weight: txt(r[I('식품중량')]), serving_ref: txt(r[I('1회 섭취참고량')]),
    gen_method: txt(r[I('데이터생성방법명')]), gen_date: /^\d{4}-\d{2}-\d{2}$/.test(r[I('데이터생성일자')] || '') ? r[I('데이터생성일자')] : null,
  };
  for (const [k, h] of NUT) o[k] = num(r[I(h)]);
  const ok = G.nutritionOk(o); o.nutrition_ok = ok === null ? null : ok;
  return o;
}

async function main() {
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    if (arg('--undo')) return await undo(c, arg('--undo'));
    const F = arg('--in'); const REL = arg('--release'); if (!F || !/^\d{8}$/.test(REL || '')) throw new Error('--in <csv.gz> --release YYYYMMDD 필요');
    const rows = parseCsv(zlib.gunzipSync(fs.readFileSync(F)).toString('utf8')); const h = rows.shift(); const I = (k) => { const i = h.indexOf(k); if (i < 0) throw new Error('열 없음: ' + k); return i; };
    const recs = []; let skipped = 0; const seen = new Set(); let dup = 0;
    for (const r of rows) { if (!r[0]) continue; const o = toRow(r, I); if (!o) { skipped++; continue; } if (seen.has(o.food_cd)) { dup++; continue; } seen.add(o.food_cd); recs.push(o); }
    const st = { rows: recs.length, skipped, dup_food_cd: dup, imported: recs.filter((x) => x.is_imported).length, nutrition_ok_false: recs.filter((x) => x.nutrition_ok === false).length, nutrition_ok_null: recs.filter((x) => x.nutrition_ok === null).length };
    const ex = (await c.query(`select count(*)::int n, count(*) filter (where status='active')::int act from kfind.products`)).rows[0];
    const missing = has('--withdraw-missing') ? (await c.query(`select count(*)::int n from kfind.products where status='active' and not (food_cd = any($1))`, [recs.map((x) => x.food_cd)])).rows[0].n : 0;
    console.log('미리보기', JSON.stringify({ release: REL, ...st, existing: ex, withdraw_missing: missing }));
    if (!has('--apply')) return;
    const batch = 'kfind_' + new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    fs.mkdirSync(LOGDIR, { recursive: true });
    const before = (await c.query(`select * from kfind.products where food_cd = any($1) or ($2::boolean and status='active')`, [recs.map((x) => x.food_cd), has('--withdraw-missing')])).rows;
    const relBefore = (await c.query(`select * from kfind.releases where release_id=$1`, [REL])).rows[0] || null;
    fs.writeFileSync(path.join(LOGDIR, batch + '.before.json'), JSON.stringify({ batch, release: REL, rel_before: relBefore, rows: before }));
    await c.query('BEGIN');
    await c.query(`insert into kfind.releases (release_id, file_name, row_count, source_url, batch_id) values ($1,$2,$3,$4,$5)
      on conflict (release_id) do update set file_name=excluded.file_name, row_count=excluded.row_count, batch_id=excluded.batch_id, loaded_at=now()`,
      [REL, arg('--file-name') || path.basename(F), recs.length, 'https://various.foodsafetykorea.go.kr/nutrient/general/down/historyList.do', batch]);
    const B = 20000;
    for (let i = 0; i < recs.length; i += B) {
      const ch = recs.slice(i, i + B);
      const params = COLS.map((k) => ch.map((x) => x[k]));
      await c.query(`insert into kfind.products (${COLS.join(',')}, release_id, status, batch_id, updated_at)
        select ${COLS.map((k) => 'u.' + k).join(',')}, $${COLS.length + 1}, 'active', $${COLS.length + 2}, now()
          from unnest(${COLS.map((k, j) => `$${j + 1}::${TYPES[j]}[]`).join(',')}) u(${COLS.join(',')})
        on conflict (food_cd) do update set ${COLS.filter((k) => k !== 'food_cd').map((k) => `${k}=excluded.${k}`).join(',')},
          release_id=excluded.release_id, status='active', batch_id=excluded.batch_id, updated_at=now()`, [...params, REL, batch]);
      process.stdout.write(`  적재 ${Math.min(i + B, recs.length)}/${recs.length}\n`);
    }
    let wd = 0;
    if (has('--withdraw-missing')) wd = (await c.query(`update kfind.products set status='withdrawn', batch_id=$2, updated_at=now() where status='active' and not (food_cd = any($1))`, [recs.map((x) => x.food_cd), batch])).rowCount;
    await c.query('COMMIT');
    const rec = { at: new Date().toISOString(), batch, release: REL, ...st, withdrawn: wd };
    fs.writeFileSync(path.join(LOGDIR, batch + '.json'), JSON.stringify(rec, null, 1));
    console.log('✅ 적용', JSON.stringify(rec));
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); await pool.end(); }
}

async function undo(c, batch) {
  const f = path.join(LOGDIR, batch + '.before.json'); const b = JSON.parse(fs.readFileSync(f, 'utf8'));
  await c.query('BEGIN');
  const del = (await c.query(`delete from kfind.products where batch_id=$1`, [batch])).rowCount;
  let restored = 0;
  const cols = (await c.query(`select column_name from information_schema.columns where table_schema='kfind' and table_name='products' and is_generated='NEVER' order by ordinal_position`)).rows.map((x) => x.column_name);
  for (let i = 0; i < b.rows.length; i += 5000) {
    const ch = b.rows.slice(i, i + 5000);
    const r = await c.query(`insert into kfind.products (${cols.join(',')}) select ${cols.join(',')} from json_populate_recordset(null::kfind.products, $1::json) on conflict (food_cd) do nothing`, [JSON.stringify(ch.map(({ search_text, ...x }) => x))]);
    restored += r.rowCount;
  }
  if (b.rel_before) await c.query(`update kfind.releases set file_name=$2,row_count=$3,batch_id=$4,loaded_at=$5 where release_id=$1`, [b.release, b.rel_before.file_name, b.rel_before.row_count, b.rel_before.batch_id, b.rel_before.loaded_at]);
  else if (!(await c.query(`select 1 from kfind.products where release_id=$1 limit 1`, [b.release])).rows.length) await c.query(`delete from kfind.releases where release_id=$1`, [b.release]);
  await c.query('COMMIT');
  console.log('↩ 되돌림', JSON.stringify({ batch, deleted: del, restored }));
}

if (require.main === module) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
module.exports = { toRow };
