/**
 * 99-haccp-identity-fill.js — HACCP 원문: 바코드/품목보고번호 일치 + 이름 게이트 통과면 제조사 게이트 없이 채움·교체 (미리보기 → 적용 → 되돌리기)  세션77c 2026-10-12
 * ============================================================================
 * 왜: 188 §5 U77-3. 97·98은 7월 G2(이름)·G3(제조사) 게이트를 둘 다 요구했다. 탈락 1,597 중 1,282는 «이름은 통과, 제조사만 탈락»이었고
 *     원인은 HACCP 제조사 칸이 주소·«알수없음»·OEM 제조원·옛 상호(롯데제과→롯데웰푸드, 해태음료→해태htb)였다.
 *     바코드·품목보고번호는 제품 식별자이므로, 이름까지 맞으면 같은 제품이다(IP/eval_c002name_v1/gate_A_v1.json 20/20 same).
 *     이름까지 탈락한 군(B)은 같은 보고번호를 다른 맛·부위 제품이 공유해서 «살리지 않는다»(gate_B_v1.json different 19/24).
 * 규칙(엔진): 97 planHaccp 가 «이름·제조사 게이트 탈락»으로 보류한 제품만 대상.
 *   후보 = 바코드 일치 행(없으면 보고번호 일치 행) 중 nameGate 통과 행 → 원문이 하나면:
 *     원재료 없음 → 채움(haccp_api) / c002_name 1행뿐 → 교체(98과 같음) / 그 밖 → 건드리지 않음.
 *   쓰기·되돌리기 = 97 applyPlan / undoBatch.
 * 게이트: gate_A_v1 에 final 'different' 가 있으면 --apply 거부.
 *
 * 실행 (meokseon-server 폴더):
 *   node scripts/99-haccp-identity-fill.js            미리보기(읽기 전용) → .tmp/s77/99_preview_<시각>.csv
 *   node scripts/99-haccp-identity-fill.js --apply    적용 → .tmp/s77/99_batch_<id>.json
 *   node scripts/99-haccp-identity-fill.js --self-test
 *   (비상용 --undo <batch_id>)
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* */ }
const fs = require('fs');
const path = require('path');
const M = require('./97-c002name-audit');

const EVAL = path.resolve(__dirname, '../../IP/eval_c002name_v1/gate_A_v1.json');
const HACCP = path.join(__dirname, 'output', 'haccp_dump.ndjson');

/** 순수. p = {product_id, barcode, rn, product_name, manufacturer, ings:[{id, source}]} */
function planIdentity(p, H) {
  const h = M.planHaccp(p, H);
  if (!h || h.action !== 'hold' || h.reason !== '이름·제조사 게이트 탈락') return null;
  let via = 'barcode', all = H.byBc.get(String(p.barcode || '')) || [];
  if (!all.length) { via = 'rn'; all = H.byRn.get(String(p.rn || '').trim()) || []; }
  const ds = all.filter((d) => M.nameGate(p.product_name, M.haccpName(d.nm)));
  if (!ds.length) return { action: 'hold', via, reason: '이름 게이트 탈락(B군)' };
  const raws = [...new Set(ds.map((d) => String(d.raw).trim()))];
  if (raws.length > 1) return { action: 'hold', via, reason: `원문 ${raws.length}개` };
  const ings = p.ings || [];
  const base = { via, raw: raws[0], haccp_rn: String(ds[0].reportNo), haccp_nm: ds[0].nm, haccp_mfr: ds[0].mfr };
  if (!ings.length) return { action: 'fill', ...base };
  if (ings.length === 1 && ings[0].source === 'c002_name') return { action: 'replace', ingredient_id: ings[0].id, ...base };
  return { action: 'hold', via, reason: '다른 출처 원재료 있음' };
}
const evalGate = (e) => { const bad = e.cases.filter((c) => c.final === 'different').map((c) => c.id); return { pass: bad.length === 0, bad, n: e.cases.length }; };

if (require.main === module && process.argv.includes('--self-test')) {
  let ok = 0, bad = 0;
  const eq = (a, b, n) => { const s = JSON.stringify(a) === JSON.stringify(b); s ? ok++ : bad++; console.log(`  ${s ? '✅' : '❌'} ${n}${s ? '' : `\n     기대 ${JSON.stringify(b)}\n     실제 ${JSON.stringify(a)}`}`); };
  const H = M.loadHaccp([
    JSON.stringify({ reportNo: '111', nm: '빼빼로 더블딥', mfr: '롯데제과㈜경남 양산시', bc: null, raw: '준초콜릿,밀가루' }),
    JSON.stringify({ reportNo: '222', nm: '차미돈등심카레용', mfr: '㈜지비오', bc: null, raw: '돼지고기100%' }),
    JSON.stringify({ reportNo: '333', nm: '감자칩', mfr: '알수없음', bc: '8801000000003', raw: '감자,팜유' }),
    JSON.stringify({ reportNo: '444', nm: '두유', mfr: '알수없음', bc: null, raw: 'A' }),
    JSON.stringify({ reportNo: '444', nm: '두유', mfr: '알수없음', bc: null, raw: 'B' }),
    JSON.stringify({ reportNo: '555', nm: '우유', mfr: '서울우유협동조합', bc: null, raw: '원유100%' }),
  ]);
  const P = (o) => ({ product_id: 1, barcode: '0', rn: 'x', product_name: '', manufacturer: '롯데웰푸드(주)', ings: [], ...o });
  eq(planIdentity(P({ rn: '111', product_name: '빼빼로 더블딥' }), H).action, 'fill', 'i1 보고번호+이름 OK·제조사 옛 상호 → 채움');
  eq(planIdentity(P({ rn: '222', product_name: '치타고 한돈 목심', manufacturer: '(주)지비오' }), H).reason, '이름 게이트 탈락(B군)', 'i2 이름 탈락(다른 부위 제품) → hold(B군은 살리지 않음)');
  eq(planIdentity(P({ barcode: '8801000000003', product_name: '감자칩 60g', manufacturer: '(주)농심' }), H).via, 'barcode', 'i3 바코드 일치·제조사 알수없음 → 채움(barcode)');
  eq(planIdentity(P({ rn: '444', product_name: '두유', manufacturer: '갑' }), H).reason, '원문 2개', 'i4 원문 둘 → hold');
  eq(planIdentity(P({ rn: '111', product_name: '빼빼로 더블딥', ings: [{ id: 9, source: 'c002_name' }] }), H).action, 'replace', 'i5 c002_name 1행 → 교체');
  eq(planIdentity(P({ rn: '111', product_name: '빼빼로 더블딥', ings: [{ id: 9, source: 'c002' }] }), H).reason, '다른 출처 원재료 있음', 'i6 다른 출처 → hold');
  eq(planIdentity(P({ rn: '555', product_name: '우유', manufacturer: '서울우유협동조합 안산공장' }), H), null, 'i7 97 게이트 통과분(=이미 97·98 대상) → null');
  eq(evalGate({ cases: [{ id: 'a', final: 'same' }, { id: 'b', final: 'different' }] }).pass, false, 'g1 different 있으면 거부');
  if (fs.existsSync(EVAL)) { const g = evalGate(JSON.parse(fs.readFileSync(EVAL, 'utf8'))); eq(g.pass, true, `g2 실제 gate_A_v1 (${g.n}건)`); }
  console.log(`\nself-test: ${ok} 통과 · ${bad} 실패`);
  process.exit(bad ? 1 : 0);
}
module.exports = { planIdentity, evalGate };

async function main() {
  const { Pool } = require('pg');
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const APPLY = process.argv.includes('--apply');
  const UNDO = arg('--undo');
  const ACTOR = arg('--actor') || '김재환';
  const DIR = path.resolve(__dirname, '../../.tmp/s77');
  fs.mkdirSync(DIR, { recursive: true });
  const poolConfig = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } }
    : { host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'meokseon', user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || '' };
  Object.assign(poolConfig, { connectionTimeoutMillis: 25000, statement_timeout: 300000, keepAlive: true });
  if (!APPLY && !UNDO) poolConfig.options = '-c default_transaction_read_only=on';
  const pool = new Pool(poolConfig);
  try {
    if (UNDO) {
      const bf = path.join(DIR, `99_batch_${UNDO}.json`);
      if (!fs.existsSync(bf)) throw new Error(`배치 기록 없음: ${bf}`);
      const rec = JSON.parse(fs.readFileSync(bf, 'utf8'));
      const c = await pool.connect();
      try { await c.query('BEGIN'); const r = await M.undoBatch(c, rec); await c.query('COMMIT'); console.log(`✅ 되돌리기 완료 — ${UNDO}`, r); }
      catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
      return;
    }
    if (!APPLY) {
      const ro = (await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only;
      if (ro !== 'on') throw new Error(`미리보기인데 읽기 전용 아님(SHOW=${ro}) — 중단`);
    }
    const ev = JSON.parse(fs.readFileSync(EVAL, 'utf8'));
    const gate = evalGate(ev);
    const evalVersion = `gate_A_v1@${ev.frozen_at}`;
    console.log(`[${APPLY ? '적용' : '미리보기 · 읽기 전용'}] HACCP 식별자+이름 일치 채움·교체`);
    console.log(`eval 게이트: ${gate.pass ? '통과' : '❌ 실패 ' + gate.bad.join(',')} (${gate.n}건)`);
    const H = M.loadHaccp(fs.readFileSync(HACCP, 'utf8').split('\n'));
    const prods = (await pool.query(`SELECT p.product_id, p.barcode, btrim(p.c005_report_no) AS rn, p.product_name, p.manufacturer
      FROM products p WHERE p.is_active AND (p.barcode = ANY($1::text[]) OR btrim(p.c005_report_no) = ANY($2::text[]))`, [[...H.byBc.keys()], [...H.byRn.keys()]])).rows;
    const ingRows = (await pool.query(`SELECT id, product_id, source FROM product_ingredients WHERE product_id = ANY($1::bigint[])`, [prods.map((p) => p.product_id)])).rows;
    const ingBy = new Map(); for (const r of ingRows) { const k = String(r.product_id); if (!ingBy.has(k)) ingBy.set(k, []); ingBy.get(k).push(r); }
    const out = [], plan = { hide: [], fill: [] };
    for (const p of prods) {
      const x = planIdentity({ ...p, ings: ingBy.get(String(p.product_id)) || [] }, H);
      if (!x) continue;
      out.push({ ...p, ...x, raw: x.raw ? x.raw.slice(0, 120) : '' });
      if (x.action === 'replace') plan.hide.push({ product_id: p.product_id, ingredient_id: x.ingredient_id, irn: null, reason: 'HACCP 원문으로 교체(식별자+이름)' });
      if (x.action === 'fill' || x.action === 'replace') plan.fill.push({ product_id: p.product_id, raw: x.raw, via: x.via, haccp_rn: x.haccp_rn, haccp_nm: x.haccp_nm });
    }
    const tally = {}; for (const x of out) { const k = `${x.action}|${x.reason || x.via}`; tally[k] = (tally[k] || 0) + 1; }
    for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(40)} ${v.toLocaleString()}`);
    const csvCell = (v) => { const s = v == null ? '' : String(v).replace(/\r?\n/g, ' '); return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const cols = ['action', 'reason', 'via', 'product_id', 'barcode', 'rn', 'product_name', 'manufacturer', 'haccp_rn', 'haccp_nm', 'haccp_mfr', 'raw'];
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const f = path.join(DIR, `99_preview_${stamp}.csv`);
    fs.writeFileSync(f, '﻿' + [cols.join(','), ...out.map((r) => cols.map((c) => csvCell(c === 'haccp_mfr' && r[c] ? String(r[c]).slice(0, 40) : r[c])).join(','))].join('\n'));
    console.log(`미리보기 파일: ${f}`);
    if (!APPLY) { console.log('※ 쓰기 없음.'); return; }
    if (!gate.pass) throw new Error('eval 게이트 실패 — 적용 거부');
    const batch = `haccpident_${stamp}`;
    const rec = { batch, version: 'haccp_identity@1', eval: evalVersion, actor: ACTOR, at: new Date().toISOString(), hide: [], fill: [], audits: [] };
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await M.applyPlan(c, plan, rec, ACTOR, evalVersion);
      const bf = path.join(DIR, `99_batch_${batch}.json`);
      fs.writeFileSync(bf, JSON.stringify(rec));
      await c.query('COMMIT');
      console.log(`\n✅ 적용 완료 — 배치 ${batch} · 교체 ${rec.hide.length} · 채움 ${rec.fill.length - rec.hide.length}`);
      console.log(`기록: ${bf}`);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  } finally { await pool.end(); }
}
if (require.main === module && !process.argv.includes('--self-test')) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
