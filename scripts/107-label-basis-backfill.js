#!/usr/bin/env node
/**
 * 107-label-basis-backfill.js — ★ 세션79 «포장지 그대로» 기준 채우기(제이 2026-10-14 23:05 · 정답 IP/eval_label_basis_v1).
 *   OCR 원문을 다시 파싱해 라벨 원래 기준·인쇄 숫자를 만든 뒤, «이미 저장된 100 기준 값과 맞을 때만»(consistent) 붙인다.
 *   대상 ① web_label.nutrition_data.label_basis ② web_label.public_supplements(axis nutrition).data._label
 *   ⚠ 사람이 정정한 보충(reviewed_by)은 건드리지 않는다 · 100 기준 값 자체는 바꾸지 않는다 · public 무접촉.
 * 사용: node scripts/107-label-basis-backfill.js --ocr-dir ../.tmp/s78/crawl_run1/ocr [--apply]
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch (_) { /* */ }
const fs = require('fs'); const path = require('path');
const P = require('../src/services/ocrParser'); const { labelFromParsed, consistent } = require('./lib/label_basis');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply'); const OCR = arg('--ocr-dir');
const readOcr = (no) => { const d = path.join(OCR, 'rv_' + no); try { return fs.readdirSync(d).filter((f) => f.endsWith('.txt')).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join('\n'); } catch (_) { return null; } };
const label = (no) => { const t = readOcr(no); if (!t) return { why: 'no_ocr' }; const L = labelFromParsed(P.parseNutrition(t), t); return L ? { L } : { why: 'no_basis' }; };

(async () => {
  if (!OCR) { console.error('--ocr-dir 필요'); process.exit(1); }
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const W = (await pool.query(`select n.nutrition_id, n.product_id, row_to_json(n) n, sp.site_item_no from web_label.nutrition_data n
      join web_label.source_pages sp on sp.product_id = n.product_id and sp.target_schema = 'web_label' where n.label_basis is null`)).rows;
  const S = (await pool.query(`select s.supplement_id, s.data, sp.site_item_no from web_label.public_supplements s
      join web_label.source_pages sp on sp.url = s.source_url where s.axis = 'nutrition' and s.reviewed_by is null and not (s.data ? '_label')`)).rows;
  const st = {}; const bump = (k) => { st[k] = (st[k] || 0) + 1; };
  const upW = []; const upS = [];
  for (const r of W) { const x = label(r.site_item_no); if (!x.L) { bump('품목:' + x.why); continue; } if (!consistent(x.L, r.n)) { bump('품목:불일치'); continue; } bump('품목:ok:' + x.L.basis); upW.push([r.nutrition_id, JSON.stringify(x.L)]); }
  for (const r of S) { const x = label(r.site_item_no); if (!x.L) { bump('보충:' + x.why); continue; } if (!consistent(x.L, r.data)) { bump('보충:불일치'); continue; } bump('보충:ok:' + x.L.basis); upS.push([r.supplement_id, JSON.stringify(x.L)]); }
  console.log('대상 품목', W.length, '보충', S.length); console.log(st);
  if (APPLY) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      if (upW.length) await c.query(`update web_label.nutrition_data t set label_basis = u.l::jsonb from unnest($1::bigint[], $2::text[]) u(id, l) where t.nutrition_id = u.id`, [upW.map((x) => x[0]), upW.map((x) => x[1])]);
      if (upS.length) await c.query(`update web_label.public_supplements t set data = t.data || jsonb_build_object('_label', u.l::jsonb), updated_at = now() from unnest($1::bigint[], $2::text[]) u(id, l) where t.supplement_id = u.id`, [upS.map((x) => x[0]), upS.map((x) => x[1])]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    const f = path.join(__dirname, '..', '..', 'IP', 'eval_label_basis_v1', `backfill_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}.json`);
    fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), stats: st, products: upW.map((x) => x[0]), supplements: upS.map((x) => x[0]) }, null, 1)); console.log('✅ 적용', upW.length, upS.length, '→', f);
  }
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
