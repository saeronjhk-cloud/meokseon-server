#!/usr/bin/env node
/**
 * 110-public-barcode-supplement.js — ★ 세션79(제이 2026-10-15 00:09 «제안대로 진행»)
 *   바코드 잇기에서 «공공에 같은 바코드가 이미 있음»(product_barcodes needs_review · reason conflict_public) →
 *   판매처 품목을 잇지 않고 그 공공 제품의 «빈 축»만 web_label.public_supplements 로 보충. 정답 E8 IP/eval_barcode_link_v1/public_supplement_v1.json.
 *   보충은 needs_review 로 넣고 → 104 게이트가 판정. public 표 무접촉. 되돌리기 --undo <batch>.
 * 사용: node scripts/110-public-barcode-supplement.js [--apply] | --undo pbsupp_<시각>
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch (_) { /* */ }
const fs = require('fs'); const path = require('path');
const { nameMatch } = require('./lib/barcode_link_gate');

/** 순수: E8 */
function planOne(web, pub) {
  // v1.1 — 이름 일치 필수(제조사만 같은 것은 불충분 · 우렁강된장↔마파두부양념 실측)
  if (!(nameMatch(web.name, pub.name) || nameMatch(pub.name, web.name))) return { axes: [], barcode: 'identity' };
  const axes = [];
  if (!pub.has_alg && Array.isArray(web.alg) && web.alg.length) axes.push('allergens');
  if (!pub.has_nut && web.nut && web.nut.calories != null) axes.push('nutrition');
  if (axes.length) return { axes, barcode: 'moved_to_supplement' };
  return { axes, barcode: (pub.has_alg && pub.has_nut) ? 'public_complete' : 'nothing_to_add' };
}

async function main() {
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const undo = arg('--undo');
  if (undo) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const s = await c.query(`delete from web_label.public_supplements where batch_id = $1`, [undo]);
      const b = await c.query(`update web_label.product_barcodes set status = 'needs_review', decided_by = null, decided_at = null, evidence = evidence - 'closed' where evidence->'closed'->>'batch' = $1`, [undo]);
      await c.query('COMMIT'); console.log('되돌림', undo, '보충', s.rowCount, '바코드 행', b.rowCount);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); await pool.end(); }
    return;
  }
  const APPLY = process.argv.includes('--apply');
  const rows = (await pool.query(`
    select b.barcode, b.product_id wid, w.product_name wname, w.manufacturer wmaker,
      (select coalesce(json_agg(allergen_name) filter (where evidence_level='contains'), '[]') from web_label.product_allergens a where a.product_id=w.product_id) walg,
      (select json_agg(allergen_name) filter (where evidence_level='may_contain') from web_label.product_allergens a where a.product_id=w.product_id) wmay,
      (select row_to_json(n) from web_label.nutrition_data n where n.product_id=w.product_id limit 1) wnut,
      (select sp.url from web_label.source_pages sp where sp.product_id=w.product_id and sp.target_schema='web_label' order by sp.page_id limit 1) url,
      w.c005_report_no wrn, pp.product_id pid, pp.product_name pname, pp.manufacturer pmaker, pp.is_active,
      exists(select 1 from public.product_allergens pa where pa.product_id=pp.product_id) has_alg,
      (exists(select 1 from public.nutrition_data n where n.product_id=pp.product_id) or exists(select 1 from public.nutrition_data_crowd c where c.product_id=pp.product_id)) has_nut
    from web_label.product_barcodes b join web_label.products w on w.product_id=b.product_id
    join public.products pp on pp.barcode=b.barcode
    where b.status='needs_review' and b.evidence->>'reason'='conflict_public' and b.decided_by is null`)).rows;
  const batch = 'pbsupp_' + new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const plan = rows.map((r) => {
    const n = r.wnut || null;
    const d = planOne({ name: r.wname, maker: r.wmaker, alg: r.walg, nut: n }, { name: r.pname, maker: r.pmaker, has_alg: r.has_alg, has_nut: r.has_nut });
    const supp = d.axes.map((ax) => {
      if (ax === 'allergens') return { axis: ax, data: { contains: r.walg, may_contain: (r.wmay || []).filter((x) => !r.walg.includes(x)) } };
      const o = { _basis: String(n.serving_size || '').toLowerCase().startsWith('100ml') ? 'per_100ml' : 'per_100g' };
      for (const k of ['calories', 'total_fat', 'saturated_fat', 'trans_fat', 'cholesterol', 'sodium', 'total_carbs', 'total_sugars', 'dietary_fiber', 'protein']) if (n[k] != null) o[k] = Number(n[k]);
      if (n.label_basis) o._label = n.label_basis;
      return { axis: ax, data: o };
    });
    return { barcode: r.barcode, wid: Number(r.wid), wname: r.wname, pid: Number(r.pid), pname: r.pname, pub_active: r.is_active, url: r.url, report_no: r.wrn, decision: d.barcode, supp };
  });
  const dist = plan.reduce((m, x) => { m[x.decision] = (m[x.decision] || 0) + 1; return m; }, {});
  console.log('대상', plan.length, dist, '보충 행', plan.reduce((s, x) => s + x.supp.length, 0));
  for (const x of plan) console.log(` ${x.decision.padEnd(20)} ${x.barcode} 판매처「${x.wname}」 ↔ 공공「${x.pname}」${x.pub_active ? '' : '(비활성)'} ${x.supp.map((s) => s.axis).join('+')}`);
  const f = path.join(__dirname, '..', '..', 'IP', 'eval_barcode_link_v1', `${APPLY ? 'pbsupp_apply' : 'pbsupp_preview'}_${batch}.json`);
  fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), batch, dist, plan }, null, 1)); console.log('→', f);
  if (APPLY) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const x of plan) {
        for (const s of x.supp) await c.query(`insert into web_label.public_supplements (product_id, axis, data, source_url, report_no, batch_id, quality) values ($1,$2,$3::jsonb,$4,$5,$6,$7::jsonb) on conflict do nothing`,
          [x.pid, s.axis, JSON.stringify(s.data), x.url, x.report_no, batch, JSON.stringify({ origin: 'barcode_conflict_public', barcode: x.barcode, web_product_id: x.wid })]);
        if (x.decision !== 'identity') await c.query(`update web_label.product_barcodes set status='rejected', decided_by='rule:110', decided_at=now(), evidence = evidence || jsonb_build_object('closed', jsonb_build_object('batch', $3::text, 'reason', $4::text, 'public_product_id', $5::bigint)) where barcode=$1 and product_id=$2`,
          [x.barcode, x.wid, batch, x.decision, x.pid]);
      }
      await c.query('COMMIT'); console.log('✅ 적용', batch);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  await pool.end();
}
if (require.main === module) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
module.exports = { planOne };
