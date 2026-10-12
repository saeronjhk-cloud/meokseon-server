/**
 * 98-c002name-haccp-replace.js — 유지된 이름매칭(c002_name) 원재료를 HACCP 라벨 원문으로 교체 (미리보기 → 적용 → 되돌리기)  세션77b 2026-10-12
 * ============================================================================
 * 왜: 188 §5 U77-1. 97이 남긴 c002_name 1,485행은 이름·제조사는 맞지만, C002 원재료는 분류명 위주이거나 옛 배합일 수 있다.
 *     같은 제품(자기 바코드 또는 자기 품목보고번호)의 HACCP 라벨 원문이 있으면 그것이 더 정확하다.
 * 규칙(엔진): 97 planHaccp 그대로(바코드 → 보고번호 · 7월 G2·G3 게이트 · 원문 하나) → 'fill' 이면 교체.
 *   교체 = 97 applyPlan 재사용: c002_name 행·그 제품 첨가물 백업 후 삭제 + haccp_api 1행. 되돌리기도 97 undoBatch 그대로.
 *   원재료 행이 둘 이상인 제품은 건드리지 않는다.
 * 게이트: IP/eval_c002name_v1/replace_eval_v1.json 에 judge 'replace_ok' 아닌 사례가 있으면 --apply 거부.
 *
 * 실행 (meokseon-server 폴더):
 *   node scripts/98-c002name-haccp-replace.js            미리보기(읽기 전용) → .tmp/s77/98_preview_<시각>.csv
 *   node scripts/98-c002name-haccp-replace.js --apply    적용 → .tmp/s77/98_batch_<id>.json
 *   node scripts/98-c002name-haccp-replace.js --self-test
 *   (비상용 --undo <batch_id>)
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* */ }
const fs = require('fs');
const path = require('path');
const M = require('./97-c002name-audit');

const EVAL = path.resolve(__dirname, '../../IP/eval_c002name_v1/replace_eval_v1.json');
const HACCP = path.join(__dirname, 'output', 'haccp_dump.ndjson');

/** 순수. rows = [{product_id, ingredient_id, barcode, rn, product_name, manufacturer, n_ing}] */
function planReplace(rows, H) {
  const out = [], plan = { hide: [], fill: [] };
  for (const r of rows) {
    if (r.n_ing !== 1) { out.push({ ...r, action: 'hold', reason: '원재료 행 둘 이상' }); continue; }
    const h = M.planHaccp(r, H);
    if (!h) { out.push({ ...r, action: 'keep', reason: 'HACCP 원문 없음' }); continue; }
    if (h.action !== 'fill') { out.push({ ...r, action: 'keep', reason: h.reason, haccp_rn: h.haccp_rn }); continue; }
    out.push({ ...r, action: 'replace', reason: h.via, haccp_rn: h.haccp_rn, haccp_nm: h.haccp_nm, raw: h.raw });
    plan.hide.push({ product_id: r.product_id, ingredient_id: r.ingredient_id, irn: r.irn || null, reason: 'HACCP 원문으로 교체' });
    plan.fill.push({ product_id: r.product_id, raw: h.raw, via: h.via, haccp_rn: h.haccp_rn, haccp_nm: h.haccp_nm });
  }
  return { out, plan };
}
const evalGate = (e) => { const bad = e.cases.filter((c) => c.judge !== 'replace_ok').map((c) => c.id); return { pass: bad.length === 0, bad, n: e.cases.length }; };

if (require.main === module && process.argv.includes('--self-test')) {
  let ok = 0, bad = 0;
  const eq = (a, b, n) => { const s = JSON.stringify(a) === JSON.stringify(b); s ? ok++ : bad++; console.log(`  ${s ? '✅' : '❌'} ${n}${s ? '' : `\n     기대 ${JSON.stringify(b)}\n     실제 ${JSON.stringify(a)}`}`); };
  const H = M.loadHaccp([
    JSON.stringify({ reportNo: '111', nm: '동원참치', mfr: '(주)동원F&B', bc: null, raw: '다랑어79%,카놀라유' }),
    JSON.stringify({ reportNo: '222', nm: '감자칩', mfr: '(주)오리온', bc: '8801000000002', raw: '감자' }),
  ]);
  const R = (id, o) => ({ product_id: id, ingredient_id: 100 + id, barcode: '0', rn: 'x', product_name: '동원참치', manufacturer: '(주)동원F&B', n_ing: 1, ...o });
  const { out, plan } = planReplace([R(1, { rn: '111' }), R(2, {}), R(3, { rn: '111', n_ing: 2 }), R(4, { barcode: '8801000000002', product_name: '감자칩', manufacturer: '(주)농심' })], H);
  eq(out.map((x) => [x.product_id, x.action]), [[1, 'replace'], [2, 'keep'], [3, 'hold'], [4, 'keep']], 'r1 교체/유지/보류/게이트 탈락 유지');
  eq([plan.hide.map((x) => x.ingredient_id), plan.fill.map((x) => x.raw)], [[101], ['다랑어79%,카놀라유']], 'r2 계획 = 숨김 1 + 채움 1(같은 제품)');
  eq(evalGate({ cases: [{ id: 'a', judge: 'replace_ok' }, { id: 'b', judge: 'wrong' }] }).pass, false, 'g1 오답 있으면 거부');
  if (fs.existsSync(EVAL)) { const g = evalGate(JSON.parse(fs.readFileSync(EVAL, 'utf8'))); eq(g.pass, true, `g2 실제 replace_eval_v1 (${g.n}건)`); }
  console.log(`\nself-test: ${ok} 통과 · ${bad} 실패`);
  process.exit(bad ? 1 : 0);
}
module.exports = { planReplace, evalGate };

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
      const bf = path.join(DIR, `98_batch_${UNDO}.json`);
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
    const evalVersion = `replace_eval_v1@${ev.judged_at}`;
    console.log(`[${APPLY ? '적용' : '미리보기 · 읽기 전용'}] c002_name → HACCP 원문 교체`);
    console.log(`eval 게이트: ${gate.pass ? '통과' : '❌ 실패 ' + gate.bad.join(',')} (${gate.n}건)`);
    const rows = (await pool.query(`SELECT i.id AS ingredient_id, i.product_id, i.prdlst_report_no AS irn, p.barcode, btrim(p.c005_report_no) AS rn,
        p.product_name, p.manufacturer, (SELECT count(*)::int FROM product_ingredients j WHERE j.product_id = i.product_id) AS n_ing
      FROM product_ingredients i JOIN products p USING (product_id) WHERE i.source = 'c002_name'`)).rows;
    const H = M.loadHaccp(fs.readFileSync(HACCP, 'utf8').split('\n'));
    const { out, plan } = planReplace(rows, H);
    const tally = {}; for (const x of out) { const k = `${x.action}|${x.reason}`; tally[k] = (tally[k] || 0) + 1; }
    console.log(`c002_name 행 ${rows.length.toLocaleString()}`);
    for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(40)} ${v.toLocaleString()}`);
    const csvCell = (v) => { const s = v == null ? '' : String(v).replace(/\r?\n/g, ' '); return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const cols = ['action', 'reason', 'product_id', 'barcode', 'rn', 'product_name', 'manufacturer', 'haccp_rn', 'haccp_nm', 'raw'];
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const f = path.join(DIR, `98_preview_${stamp}.csv`);
    fs.writeFileSync(f, '﻿' + [cols.join(','), ...out.filter((x) => x.action !== 'keep' || x.haccp_rn).map((r) => cols.map((c) => csvCell(c === 'raw' && r.raw ? r.raw.slice(0, 120) : r[c])).join(','))].join('\n'));
    console.log(`미리보기 파일: ${f}`);
    if (!APPLY) { console.log('※ 쓰기 없음.'); return; }
    if (!gate.pass) throw new Error('eval 게이트 실패 — 적용 거부');
    const batch = `c002replace_${stamp}`;
    const rec = { batch, version: 'c002name_replace@1', eval: evalVersion, actor: ACTOR, at: new Date().toISOString(), hide: [], fill: [], audits: [] };
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await M.applyPlan(c, plan, rec, ACTOR, evalVersion);
      const bf = path.join(DIR, `98_batch_${batch}.json`);
      fs.writeFileSync(bf, JSON.stringify(rec));
      await c.query('COMMIT');
      console.log(`\n✅ 적용 완료 — 배치 ${batch} · 교체 ${rec.fill.length}`);
      console.log(`기록: ${bf}`);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  } finally { await pool.end(); }
}
if (require.main === module && !process.argv.includes('--self-test')) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
