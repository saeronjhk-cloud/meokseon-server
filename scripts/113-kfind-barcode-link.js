#!/usr/bin/env node
/**
 * 113-kfind-barcode-link.js — ★ 세션80 kfind 품목 ↔ 바코드(HACCP 공공 품목보고번호→바코드) 잇기. 036 선행.
 *   판정 = scripts/lib/barcode_link_gate.decide (세션79 E2 · 그대로 재사용) + L5 multi_kfind. 정답 IP/eval_kfind_barcode_v1.
 *   저장 auto·needs_review → kfind.product_barcodes · reject 는 기록 JSON 만 · decided_by 있는 행 보존 · public·web_label 무접촉.
 * 사용(meokseon-server): node scripts/113-kfind-barcode-link.js --haccp ../.tmp/s79/haccp_v2/dump.ndjson [--apply]
 *                        node scripts/113-kfind-barcode-link.js --undo kfbc_<시각>
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch (_) { /* */ }
const fs = require('fs'); const path = require('path');
const { decide } = require('./lib/barcode_link_gate');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const digits = (s) => String(s || '').replace(/\D/g, '');
const LOGDIR = path.join(__dirname, '..', '..', 'IP', 'eval_kfind_barcode_v1');

function haccpMap(file) {
  const m = new Map();
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue; let x; try { x = JSON.parse(l); } catch (_) { continue; }
    const rn = digits(x.reportNo); const bc = digits(x.bc); if (!rn || !bc) continue;
    if (!m.has(rn)) m.set(rn, new Map()); if (!m.get(rn).has(bc)) m.get(rn).set(bc, { nm: x.nm, mfr: x.mfr });
  }
  return m;
}

/** 순수 판정(테스트 가능): kfind 행들 × HACCP 맵 → [{barcode, food_cd, status, reason, evidence}] */
function judge(kf, hc, ctx) {
  const byRn = new Map(); for (const k of kf) { const rn = digits(k.report_no); if (!rn) continue; (byRn.get(rn) || byRn.set(rn, []).get(rn)).push(k); }
  const out = [];
  for (const [rn, ks] of byRn) {
    const cands = hc.get(rn); if (!cands) continue;
    for (const k of ks) {
      const web = { report_no: k.report_no, name: k.food_name, maker: k.maker || k.importer };
      const first = [...cands.entries()].map(([bc, c]) => ({ bc, c, r: decide({ source: 'haccp', barcode: bc, web, cand: { report_no: rn, name: c.nm, maker: c.mfr }, public_hit: ctx.publicSet.has(bc) ? { barcode: bc } : null, linked_other: ctx.linked(bc, k.food_cd) }) }));
      const passing = first.filter((x) => x.r.status === 'auto').length;
      for (const x of first) {
        let r = passing > 1 && x.r.status === 'auto' ? decide({ source: 'haccp', barcode: x.bc, web, cand: { report_no: rn, name: x.c.nm, maker: x.c.mfr }, siblings_pass: passing }) : x.r;
        if (r.status === 'auto' && ks.length > 1) r = { status: 'needs_review', reason: 'multi_kfind', checks: r.checks };   // L5
        if (r.status === 'auto' && r.checks && r.checks.name === false) r = { status: 'needs_review', reason: 'maker_only', checks: r.checks };   // L7 v1.1 — 제조사만 같음은 동일성 근거가 아니다(금지 61 · OEM 반례)
        out.push({ barcode: x.bc, food_cd: k.food_cd, status: r.status, reason: r.reason, evidence: { src: 'haccp', haccp_name: x.c.nm, haccp_maker: x.c.mfr, kfind_name: k.food_name, kfind_maker: k.maker || k.importer, report_no: k.report_no, checks: r.checks } });
      }
    }
  }
  return out;
}

async function main() {
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    if (arg('--undo')) {
      const b = arg('--undo'); const r = await c.query(`delete from kfind.product_barcodes where batch_id=$1 and decided_by is null`, [b]);
      console.log('↩ 되돌림', b, r.rowCount); return;
    }
    const hc = haccpMap(arg('--haccp'));
    const kf = (await c.query(`select k.food_cd, k.food_name, k.maker, k.importer, k.report_no from kfind.products k
       where k.status='active' and k.report_no = any($1)
         and not exists(select 1 from public.products pp where pp.is_active and pp.c005_report_no=k.report_no)
         and not exists(select 1 from web_label.products w where w.status in ('active','stale') and w.c005_report_no=k.report_no)`, [[...hc.keys()]])).rows;
    const allBc = [...new Set([].concat(...[...hc.values()].map((m) => [...m.keys()])))];
    const publicSet = new Set((await c.query(`select barcode from public.products where barcode = any($1)`, [allBc])).rows.map((r) => r.barcode));
    const wlLinked = new Set((await c.query(`select barcode from web_label.product_barcodes where status in ('auto','approved') and barcode = any($1)`, [allBc])).rows.map((r) => r.barcode));
    const kfLinked = (await c.query(`select barcode, food_cd from kfind.product_barcodes where status in ('auto','approved')`)).rows;
    const linked = (bc, fc) => wlLinked.has(bc) || kfLinked.some((x) => x.barcode === bc && x.food_cd !== fc);
    const res = judge(kf, hc, { publicSet, linked });
    // 같은 바코드가 kfind 여러 품목에 auto → 전부 needs_review(conflict_linked)
    const autoBy = {}; for (const r of res) if (r.status === 'auto') autoBy[r.barcode] = (autoBy[r.barcode] || 0) + 1;
    for (const r of res) if (r.status === 'auto' && autoBy[r.barcode] > 1) { r.status = 'needs_review'; r.reason = 'conflict_linked'; }
    const dist = res.reduce((m, x) => { const k = x.status + ':' + x.reason; m[k] = (m[k] || 0) + 1; return m; }, {});
    const keep = res.filter((r) => r.status !== 'reject');
    console.log('kfind 대상', kf.length, '| 판정', JSON.stringify(dist), '| 저장 예정', keep.length, '| auto', keep.filter((r) => r.status === 'auto').length);
    for (const r of keep.filter((x) => x.status === 'auto').slice(0, 8)) console.log('  auto', r.barcode, r.evidence.kfind_name, '←', r.evidence.haccp_name);
    if (!process.argv.includes('--apply')) return;
    const batch = 'kfbc_' + new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    await c.query('BEGIN');
    const ins = await c.query(`insert into kfind.product_barcodes (barcode, food_cd, status, reason, evidence, batch_id)
      select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::jsonb[], $6::text[])
      on conflict (barcode, food_cd) do update set status=excluded.status, reason=excluded.reason, evidence=excluded.evidence, batch_id=excluded.batch_id, updated_at=now()
        where kfind.product_barcodes.decided_by is null`,
      [keep.map((r) => r.barcode), keep.map((r) => r.food_cd), keep.map((r) => r.status), keep.map((r) => r.reason), keep.map((r) => JSON.stringify(r.evidence)), keep.map(() => batch)]);
    await c.query('COMMIT');
    fs.mkdirSync(LOGDIR, { recursive: true });
    const f = path.join(LOGDIR, `apply_${batch}.json`); fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), batch, dist, written: ins.rowCount, rows: res }, null, 1));
    console.log('✅ 적용', batch, ins.rowCount, '→', f);
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); await pool.end(); }
}
if (require.main === module) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
module.exports = { judge, haccpMap };
