#!/usr/bin/env node
/**
 * 119-company-junk-fix.js — ★ 세션83 사진 제보 제품(data_source ocr_crowdsource)의 판매원·제조원 «잔해» 정리(정답 IP/eval_company_junk_v1).
 *   판정 = scripts/73-brand-junk-cleanup.js isJunk(세션73 반품 문장 + 세션83 isCompanyJunk: 라벨 낱말 · 주소/전화 조각 · OCR 조각).
 *   처리: 잔해 → NULL(추정으로 채우지 않음 · 다음 정상 제보가 COALESCE 로 채운다) · 앞 OCR 잔해(| · •)만 있는 값은 떼어 냄.
 *   73 은 Railway 콘솔용(src/config/database) — 이 스크립트는 노트북에서 DATABASE_URL 로 돈다 · 공공 데이터(public_c005)는 건드리지 않는다.
 *   «현재 값이 미리보기 때와 같을 때만» 바꾼다. 기록 → --undo.
 * 사용(meokseon-server): node scripts/119-company-junk-fix.js [--expect N] [--apply] | --undo cjfix_<시각>
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch (_) { /* */ }
const fs = require('fs'); const path = require('path');
const dbPath = require.resolve('../src/config/database');
require.cache[dbPath] = require.cache[dbPath] || { id: dbPath, filename: dbPath, loaded: true, exports: {} };
const { isJunk } = require('./73-brand-junk-cleanup');
const LOGDIR = path.join(__dirname, '..', '..', 'IP', 'eval_company_junk_v1');
const LEAD = /^[|·•▲■*\s]+/;
(async () => {
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const ui = process.argv.indexOf('--undo');
    if (ui > 0) {
      const b = process.argv[ui + 1]; const log = JSON.parse(fs.readFileSync(path.join(LOGDIR, `apply_${b}.json`), 'utf8'));
      for (const r of log.applied) await pool.query(`update products set ${r.field}=$2 where product_id=$1 and ${r.field} is not distinct from $3`, [r.product_id, r.before, r.after]);
      console.log('↩ 되돌림', b, log.applied.length); return;
    }
    const rows = (await pool.query(`select product_id, product_name, brand, manufacturer from products where data_source='ocr_crowdsource' and (brand is not null or manufacturer is not null) order by product_id`)).rows;
    const plan = [];
    for (const r of rows) for (const field of ['brand', 'manufacturer']) {
      const v = r[field]; if (v == null) continue;
      if (isJunk(v)) plan.push({ product_id: r.product_id, name: r.product_name, field, before: v, after: null });
      else if (LEAD.test(v)) plan.push({ product_id: r.product_id, name: r.product_name, field, before: v, after: v.replace(LEAD, '').trim() });
    }
    for (const p of plan) console.log('  ', p.product_id, p.name, p.field, JSON.stringify(p.before), '→', JSON.stringify(p.after));
    console.log('대상', plan.length);
    const ex = process.argv.indexOf('--expect'); if (ex > 0 && Number(process.argv[ex + 1]) !== plan.length) throw new Error(`대상 ${plan.length} ≠ 기대 ${process.argv[ex + 1]} — 적용하지 않음`);
    if (!process.argv.includes('--apply')) return;
    const batch = 'cjfix_' + new Date().toISOString().replace(/\D/g, '').slice(0, 14); const applied = [];
    for (const p of plan) { const u = await pool.query(`update products set ${p.field}=$2 where product_id=$1 and ${p.field}=$3`, [p.product_id, p.after, p.before]); if (u.rowCount) applied.push(p); }
    fs.mkdirSync(LOGDIR, { recursive: true }); fs.writeFileSync(path.join(LOGDIR, `apply_${batch}.json`), JSON.stringify({ at: new Date().toISOString(), batch, applied }, null, 1));
    console.log('✅ 적용', batch, applied.length, '| 되돌리기 --undo', batch);
  } finally { await pool.end(); }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
