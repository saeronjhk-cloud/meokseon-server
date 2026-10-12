/**
 * 100-name-fix-haccp.js — 깨진 제품명·제조사(U+FFFD)를 HACCP 라벨 이름으로 복구 (미리보기 → 적용 → 되돌리기)  세션77d 2026-10-12
 * ============================================================================
 * 왜: 187 §6-2 U76-4. 95(형제)·96(제조사 사전)으로 못 고친 깨진 칸 266. HACCP 덤프(2026-07)에 같은 제품(바코드 또는 품목보고번호 일치)이 있으면
 *     그 라벨 이름이 정답이다.
 * 규칙(엔진): 후보 = 바코드 일치 행 + 품목보고번호 일치 행의 이름(제품명은 «->» 뒤)·제조사. 깨진 자리(� 연속) 1곳 = 정확히 1글자(76-14).
 *   일치 후보가 정확히 하나일 때만 고친다(76-13). 쓰기·되돌리기 = 95 applyFixes / undoBatch(audit action c005_name_fix · updated_at 무접촉).
 * 게이트: IP/eval_name_fix_v1/haccp_fix_eval_v1.json 전부 correct 이고, 미리보기 fix 목록이 그 판정 목록과 같아야 --apply(76-15 precision 100%).
 *
 * 실행 (meokseon-server 폴더):
 *   node scripts/100-name-fix-haccp.js            미리보기(읽기 전용) → .tmp/s77/100_preview_<시각>.csv
 *   node scripts/100-name-fix-haccp.js --apply    적용 → .tmp/s77/100_batch_<id>.json
 *   node scripts/100-name-fix-haccp.js --self-test
 *   (비상용 --undo <batch_id>)
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* */ }
const fs = require('fs');
const path = require('path');
const N = require('./95-c005-name-fix');

const EVAL = path.resolve(__dirname, '../../IP/eval_name_fix_v1/haccp_fix_eval_v1.json');
const HACCP = path.join(__dirname, 'output', 'haccp_dump.ndjson');
const F = '�';
const onePat = (s) => new RegExp('^' + String(s).replace(/�+|[^�]/gu, (t) => (t[0] === F ? '.' : t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) + '$', 'u');
const hName = (nm) => { const t = String(nm || ''); const i = t.lastIndexOf('->'); return (i >= 0 ? t.slice(i + 2) : t).trim(); };

function loadIndex(lines) {
  const byBc = new Map(), byRn = new Map();
  const add = (m, k, d) => { if (!m.has(k)) m.set(k, []); m.get(k).push(d); };
  for (const l of lines) { if (!l.trim()) continue; const d = JSON.parse(l); add(byRn, String(d.reportNo).trim(), d); for (const b of String(d.bc || '').match(/\d[\d ]{6,16}\d/g) || []) add(byBc, b.replace(/ /g, ''), d); }
  return { byBc, byRn };
}
/** 순수. p = {product_id, barcode, rn, product_name, manufacturer} */
function planName(p, I) {
  const ds = [...(I.byBc.get(String(p.barcode || '')) || []), ...(I.byRn.get(String(p.rn || '').trim()) || [])];
  const out = [];
  for (const f of ['product_name', 'manufacturer']) {
    const v = p[f]; if (v == null || !String(v).includes(F)) continue;
    const base = { product_id: p.product_id, barcode: p.barcode, field: f, old: String(v), new: null };
    if (!ds.length) { out.push({ ...base, action: 'hold', reason: 'HACCP 행 없음' }); continue; }
    const re = onePat(v);
    const vals = [...new Set(ds.map((d) => (f === 'product_name' ? hName(d.nm) : String(d.mfr || '').trim())).filter(Boolean))];
    const m = [...new Set(vals.filter((x) => re.test(x)))];
    if (m.length !== 1) { out.push({ ...base, action: 'hold', reason: m.length ? `후보 ${m.length}개` : '일치 없음' }); continue; }
    out.push({ ...base, new: m[0], action: 'fix', reason: '' });
  }
  return out;
}

if (require.main === module && process.argv.includes('--self-test')) {
  let ok = 0, bad = 0;
  const eq = (a, b, n) => { const s = JSON.stringify(a) === JSON.stringify(b); s ? ok++ : bad++; console.log(`  ${s ? '✅' : '❌'} ${n}${s ? '' : `\n     기대 ${JSON.stringify(b)}\n     실제 ${JSON.stringify(a)}`}`); };
  const I = loadIndex([
    JSON.stringify({ reportNo: '1', nm: '펩시 -> 펩시', mfr: '롯데칠성', bc: '8801056061548' }),
    JSON.stringify({ reportNo: '2', nm: '편강', mfr: 'A', bc: null }),
    JSON.stringify({ reportNo: '2', nm: '생강', mfr: 'A', bc: null }),
    JSON.stringify({ reportNo: '3', nm: '라즈베리케익', mfr: 'B', bc: null }),
  ]);
  const P = (o) => ({ product_id: 1, barcode: '0', rn: 'x', product_name: 'ok', manufacturer: 'ok', ...o });
  eq(planName(P({ barcode: '8801056061548', product_name: '펩���' }), I).map((x) => [x.action, x.new]), [['fix', '펩시']], 'n1 바코드 일치 · ��� = 1글자');
  eq(planName(P({ rn: '2', product_name: '��강' }), I)[0].reason, '후보 2개', 'n2 후보 둘(편강·생강) → hold');
  eq(planName(P({ rn: '3', product_name: '라즈��리케익' }), I)[0].new, '라즈베리케익', 'n3 보고번호 일치');
  eq(planName(P({ rn: '3', product_name: '라즈��케익' }), I)[0].reason, '일치 없음', 'n4 1글자 규칙 — 2글자 자리 안 맞음');
  eq(planName(P({ rn: '9', product_name: '깨�' }), I)[0].reason, 'HACCP 행 없음', 'n5 HACCP 없음');
  eq(planName(P({ rn: '3' }), I).length, 0, 'n6 깨지지 않은 칸은 계획 없음');
  if (fs.existsSync(EVAL)) { const e = JSON.parse(fs.readFileSync(EVAL, 'utf8')); eq(e.cases.every((c) => c.judge === 'correct'), true, `g1 실제 haccp_fix_eval_v1 전부 correct (${e.cases.length})`); }
  console.log(`\nself-test: ${ok} 통과 · ${bad} 실패`);
  process.exit(bad ? 1 : 0);
}
module.exports = { planName, loadIndex };

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
      const bf = path.join(DIR, `100_batch_${UNDO}.json`);
      if (!fs.existsSync(bf)) throw new Error(`배치 기록 없음: ${bf}`);
      const rec = JSON.parse(fs.readFileSync(bf, 'utf8'));
      const c = await pool.connect();
      try { await c.query('BEGIN'); const r = await N.undoBatch(c, rec); await c.query('COMMIT'); console.log(`✅ 되돌리기 완료 — ${UNDO}`, r); }
      catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
      return;
    }
    if (!APPLY) {
      const ro = (await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only;
      if (ro !== 'on') throw new Error(`미리보기인데 읽기 전용 아님(SHOW=${ro}) — 중단`);
    }
    const ev = JSON.parse(fs.readFileSync(EVAL, 'utf8'));
    console.log(`[${APPLY ? '적용' : '미리보기 · 읽기 전용'}] 깨진 이름 → HACCP 라벨 이름`);
    const I = loadIndex(fs.readFileSync(HACCP, 'utf8').split('\n'));
    const prods = (await pool.query(`SELECT product_id, barcode, btrim(c005_report_no) AS rn, product_name, manufacturer FROM products
      WHERE is_active AND (strpos(product_name, U&'\\FFFD') > 0 OR strpos(manufacturer, U&'\\FFFD') > 0)`)).rows;
    const plan = prods.flatMap((p) => planName(p, I));
    const tally = {}; for (const x of plan) { const k = `${x.field}|${x.action}${x.reason ? '|' + x.reason : ''}`; tally[k] = (tally[k] || 0) + 1; }
    console.log(`깨진 제품 ${prods.length}`); for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(36)} ${v}`);
    const csvCell = (v) => { const s = v == null ? '' : String(v).replace(/\r?\n/g, ' '); return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const cols = ['product_id', 'barcode', 'field', 'action', 'reason', 'old', 'new'];
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const f = path.join(DIR, `100_preview_${stamp}.csv`);
    fs.writeFileSync(f, '﻿' + [cols.join(','), ...plan.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n'));
    console.log(`미리보기 파일: ${f}`);
    const fixes = plan.filter((x) => x.action === 'fix');
    const key = (x) => `${x.product_id}|${x.field}|${x.new}`;
    const judged = new Set(ev.cases.filter((c) => c.judge === 'correct').map((c) => `${c.product_id}|${c.field}|${c.new}`));
    const unjudged = fixes.filter((x) => !judged.has(key(x)));
    console.log(`판정 대조: fix ${fixes.length} · 판정 목록에 없는 fix ${unjudged.length}`);
    if (!APPLY) { console.log('※ 쓰기 없음.'); return; }
    if (unjudged.length || ev.cases.some((c) => c.judge !== 'correct')) throw new Error('판정되지 않은 fix 가 있거나 오답 판정 — 적용 거부(76-15)');
    const batch = `namefixhaccp_${stamp}`;
    const rec = { batch, version: 'name_fix_haccp@1', actor: ACTOR, at: new Date().toISOString(), fixes: [], audits: [] };
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await N.applyFixes(c, fixes, rec, ACTOR);
      const bf = path.join(DIR, `100_batch_${batch}.json`);
      fs.writeFileSync(bf, JSON.stringify(rec, null, 1));
      await c.query('COMMIT');
      console.log(`\n✅ 적용 완료 — 배치 ${batch} · 복구 ${rec.fixes.length}칸`);
      console.log(`기록: ${bf}`);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  } finally { await pool.end(); }
}
if (require.main === module && !process.argv.includes('--self-test')) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
