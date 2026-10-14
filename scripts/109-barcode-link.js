#!/usr/bin/env node
/**
 * 109-barcode-link.js — ★ 세션79 web_label 품목 ↔ 바코드 잇기(A: HACCP 공공 번호→바코드 · B: 판매처 라벨 OCR 속 바코드).
 *   판정 = scripts/lib/barcode_link_gate.js(정답 E2 16/16). 결과 → web_label.product_barcodes(status auto|needs_review|reject 는 기록 안 함).
 *   ⚠ 사람이 정한 행(decided_by 있음)은 건드리지 않는다 · public 무접촉 · 되돌리기 --undo <batch>.
 * 사용: node scripts/109-barcode-link.js --haccp ../.tmp/s79/haccp_v2/dump.ndjson --ocr-dir ../.tmp/s78/crawl_run1/ocr [--apply]
 *       node scripts/109-barcode-link.js --undo bclink_<시각>
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch (_) { /* */ }
const fs = require('fs'); const path = require('path');
const { decide, checksumOk } = require('./lib/barcode_link_gate');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const digits = (s) => String(s || '').replace(/\D/g, '');

function haccpMap(file) {
  const m = new Map();
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue; const x = JSON.parse(l); const rn = digits(x.reportNo); const bc = digits(x.bc);
    if (!rn || !bc) continue; if (!m.has(rn)) m.set(rn, new Map()); if (!m.get(rn).has(bc)) m.get(rn).set(bc, { nm: x.nm, mfr: x.mfr });
  }
  return m;
}
function ocrBarcodes(dir, itemNo) {
  const d = path.join(dir, 'rv_' + itemNo); let t = '';
  try { for (const f of fs.readdirSync(d)) if (f.endsWith('.txt')) t += fs.readFileSync(path.join(d, f), 'utf8') + '\n'; } catch (_) { return []; }
  const raw = t.replace(/(\d)[ -](?=\d)/g, '$1');
  return [...new Set((raw.match(/(?<!\d)88\d{11}(?!\d)/g) || []).filter(checksumOk))];
}

/** 순수: 품목·후보 → 판정 목록 */
function plan(products, H, ocrOf, publicSet, linkedElsewhere) {
  const out = [];
  for (const p of products) {
    const web = { report_no: p.rn, name: p.name, maker: p.maker, content: p.content, unit: p.unit };
    const hc = H.get(digits(p.rn)) || new Map();
    const first = [...hc.entries()].map(([bc, c]) => ({ bc, c, r: decide({ source: 'haccp', barcode: bc, web, cand: { report_no: p.rn, name: c.nm, maker: c.mfr }, public_hit: publicSet.get(bc) || null, linked_other: linkedElsewhere(bc, p.id) }) }));
    const passing = first.filter((x) => x.r.status === 'auto').length;
    const autoA = new Set();
    for (const x of first) {
      const r = passing > 1 ? decide({ source: 'haccp', barcode: x.bc, web, cand: { report_no: p.rn, name: x.c.nm, maker: x.c.mfr }, siblings_pass: passing }) : x.r;
      if (r.status === 'auto') autoA.add(x.bc);
      out.push({ product_id: p.id, barcode: x.bc, source: 'haccp', status: r.status, reason: r.reason, checks: r.checks, cand_name: x.c.nm, cand_maker: x.c.mfr, report_no: p.rn });
    }
    for (const bc of ocrOf(p)) {
      if (hc.has(bc)) continue;   // A 가 이미 판정(같은 바코드)
      const r = decide({ source: 'ocr', barcode: bc, web, cand: { report_no: p.rn }, public_hit: publicSet.get(bc) || null, linked_other: linkedElsewhere(bc, p.id), haccp_same: autoA.has(bc) });
      out.push({ product_id: p.id, barcode: bc, source: 'ocr', status: r.status, reason: r.reason, checks: r.checks, report_no: p.rn, page: p.item });
    }
  }
  // 같은 바코드가 서로 다른 품목에 auto → 전부 needs_review(conflict_linked)
  const byBc = new Map(); for (const x of out) if (x.status === 'auto') byBc.set(x.barcode, (byBc.get(x.barcode) || 0) + 1);
  for (const x of out) if (x.status === 'auto' && byBc.get(x.barcode) > 1) { x.status = 'needs_review'; x.reason = 'conflict_linked'; }
  return out.filter((x) => x.status !== 'reject');
}

async function main() {
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const undo = arg('--undo');
  if (undo) {
    const r = await pool.query(`delete from web_label.product_barcodes where evidence->>'batch' = $1 and decided_by is null returning barcode`, [undo]);
    console.log('되돌림', undo, r.rowCount); await pool.end(); return;
  }
  const H = haccpMap(arg('--haccp')); const OCR = arg('--ocr-dir'); const APPLY = process.argv.includes('--apply');
  const products = (await pool.query(`select p.product_id id, p.c005_report_no rn, p.product_name name, p.manufacturer maker, p.total_content::float content, p.content_unit unit,
      (select sp.site_item_no from web_label.source_pages sp where sp.product_id = p.product_id and sp.target_schema = 'web_label' order by sp.page_id limit 1) item
    from web_label.products p where p.c005_report_no is not null`)).rows;
  const ocrCache = new Map(); const ocrOf = (p) => { if (!OCR || !p.item) return []; if (!ocrCache.has(p.item)) ocrCache.set(p.item, ocrBarcodes(OCR, p.item)); return ocrCache.get(p.item); };
  const allBc = new Set(); for (const p of products) { for (const bc of (H.get(digits(p.rn)) || new Map()).keys()) allBc.add(bc); for (const bc of ocrOf(p)) allBc.add(bc); }
  const pub = (await pool.query(`select barcode, product_id, c005_report_no rn, is_active from public.products where barcode = any($1)`, [[...allBc]])).rows;
  const publicSet = new Map(pub.map((x) => [x.barcode, { product_id: Number(x.product_id), report_no: x.rn, is_active: x.is_active }]));
  const existing = (await pool.query(`select barcode, product_id, status, decided_by from web_label.product_barcodes`)).rows;
  const linkedElsewhere = (bc, pid) => existing.some((e) => e.barcode === bc && Number(e.product_id) !== Number(pid) && ['auto', 'approved'].includes(e.status));
  const human = new Set(existing.filter((e) => e.decided_by).map((e) => `${e.barcode}|${e.product_id}`));
  const rows = plan(products.map((p) => ({ ...p, id: Number(p.id) })), H, ocrOf, publicSet, linkedElsewhere).filter((x) => !human.has(`${x.barcode}|${x.product_id}`));
  const dist = {}; for (const x of rows) { const k = `${x.source}:${x.status}:${x.reason}`; dist[k] = (dist[k] || 0) + 1; }
  console.log('web_label 품목', products.length, '· HACCP 번호', H.size, '· 판정', rows.length); console.log(dist);
  console.log('auto 품목 수', new Set(rows.filter((x) => x.status === 'auto').map((x) => x.product_id)).size);
  const batch = 'bclink_' + new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const f = path.join(__dirname, '..', '..', 'IP', 'eval_barcode_link_v1', `${APPLY ? 'apply' : 'preview'}_${batch}.json`);
  fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), batch, dist, rows }, null, 1)); console.log('→', f);
  if (APPLY && rows.length) {
    await pool.query(`insert into web_label.product_barcodes (barcode, product_id, status, evidence)
        select u.bc, u.pid, u.st, u.ev::jsonb from unnest($1::text[], $2::bigint[], $3::text[], $4::text[]) u(bc, pid, st, ev)
        on conflict (barcode, product_id) do update set status = excluded.status, evidence = excluded.evidence
          where web_label.product_barcodes.decided_by is null`,
      [rows.map((x) => x.barcode), rows.map((x) => x.product_id), rows.map((x) => x.status), rows.map((x) => JSON.stringify({ batch, source: x.source, reason: x.reason, checks: x.checks, cand_name: x.cand_name || null, cand_maker: x.cand_maker || null, report_no: x.report_no, page: x.page || null }))]);
    console.log('✅ 적용', batch, rows.length);
  }
  await pool.end();
}
if (require.main === module) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
module.exports = { plan, haccpMap, ocrBarcodes };
