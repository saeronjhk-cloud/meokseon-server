/**
 * 101-haccp-allergen-fill.js — HACCP 원문으로 원재료를 채운 제품에 «같은 HACCP 행»의 알레르기 표시란을 적재 (미리보기 → 적용 → 되돌리기)  세션77e 2026-10-12
 * ============================================================================
 * 왜: 97·99·98이 haccp_api 원재료는 넣었지만 알레르기는 넣지 않았다. HACCP 덤프의 `alg`는 제조사 알레르기 표시란이다(DS-6 «제조사 표기» 그대로).
 * 규칙(엔진): product_ingredients(source haccp_api)의 prdlst_report_no + raw_text 가 덤프 행과 «정확히» 같은 행의 alg 만 쓴다(같은 라벨 보증).
 *   파서 = 26번 parseAllergy(7월 적재 5,470행과 같은 함수 · 오타·별칭 처리: 메추리알·굴·콩·호도 등). 등급 contains(26과 같음 · allergenUpsert 주석 참고).
 *   대상 = 알레르기 행이 «하나도 없는» 활성 제품만. alg 가 비었거나 «없음»이면 쓰지 않는다(«없음»을 기록하는 칸이 없다).
 * 쓰는 것: product_allergens(detected_via 'haccp_api', status 'candidate', evidence_level 'contains') · 배치 기록 파일.
 * 게이트: IP/eval_allergen_db_v1/haccp_alg_eval_v1.json 전부 correct 여야 --apply.
 *
 * 실행 (meokseon-server 폴더):
 *   node scripts/101-haccp-allergen-fill.js            미리보기 → .tmp/s77/101_preview_<시각>.csv
 *   node scripts/101-haccp-allergen-fill.js --apply
 *   node scripts/101-haccp-allergen-fill.js --self-test
 *   (비상용 --undo <batch_id>)
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* */ }
const fs = require('fs');
const path = require('path');
const { parseAllergy } = require('./26-apply-haccp-dump');

const EVAL = path.resolve(__dirname, '../../IP/eval_allergen_db_v1/haccp_alg_eval_v1.json');
const HACCP = path.join(__dirname, 'output', 'haccp_dump.ndjson');
const norm = (s) => String(s || '').replace(/\s+/g, '').trim();

function loadAlg(lines) {
  const m = new Map(); // reportNo|normRaw → alg
  for (const l of lines) { if (!l.trim()) continue; const d = JSON.parse(l); if (!d.raw) continue; m.set(`${String(d.reportNo).trim()}|${norm(d.raw)}`, d.alg || ''); }
  return m;
}
/** 순수. i = {product_id, prdlst_report_no, raw_text} */
function planAlg(i, A) {
  const k = `${String(i.prdlst_report_no || '').trim()}|${norm(i.raw_text)}`;
  if (!A.has(k)) return { action: 'hold', reason: '같은 HACCP 행 없음' };
  const alg = String(A.get(k) || '').trim();
  if (!alg) return { action: 'hold', reason: '표시란 비어 있음' };
  const names = parseAllergy(alg);
  if (!names.length) return { action: 'hold', reason: '19종 없음(없음 표기 등)', alg };
  return { action: 'fill', alg, names };
}

if (require.main === module && process.argv.includes('--self-test')) {
  let ok = 0, bad = 0;
  const eq = (a, b, n) => { const s = JSON.stringify(a) === JSON.stringify(b); s ? ok++ : bad++; console.log(`  ${s ? '✅' : '❌'} ${n}${s ? '' : `\n     기대 ${JSON.stringify(b)}\n     실제 ${JSON.stringify(a)}`}`); };
  const A = loadAlg([
    JSON.stringify({ reportNo: '1', raw: '밀가루, 우유', alg: '밀,우유 함유' }),
    JSON.stringify({ reportNo: '2', raw: '원유100%', alg: '없음' }),
    JSON.stringify({ reportNo: '3', raw: '쌀', alg: '' }),
    JSON.stringify({ reportNo: '4', raw: '어묵', alg: '대두,밀,메추리알' }),
  ]);
  eq(planAlg({ prdlst_report_no: '1', raw_text: '밀가루,우유' }, A).names, ['밀', '우유'], 'a1 같은 행(공백 무시) → 밀·우유');
  eq(planAlg({ prdlst_report_no: '2', raw_text: '원유100%' }, A).reason, '19종 없음(없음 표기 등)', 'a2 «없음» → 쓰지 않음');
  eq(planAlg({ prdlst_report_no: '3', raw_text: '쌀' }, A).reason, '표시란 비어 있음', 'a3 빈 표시란');
  eq(planAlg({ prdlst_report_no: '1', raw_text: '다른 원문' }, A).reason, '같은 HACCP 행 없음', 'a4 원문 다르면 다른 라벨 → hold');
  eq(planAlg({ prdlst_report_no: '4', raw_text: '어묵' }, A).names, ['대두', '밀', '난류(가금류)'], 'a5 메추리알 → 난류(26 파서)');
  if (fs.existsSync(EVAL)) { const e = JSON.parse(fs.readFileSync(EVAL, 'utf8')); eq(e.cases.every((c) => c.judge === 'correct'), true, `g1 실제 eval 전부 correct (${e.cases.length})`); }
  console.log(`\nself-test: ${ok} 통과 · ${bad} 실패`);
  process.exit(bad ? 1 : 0);
}
module.exports = { planAlg, loadAlg };

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
      const bf = path.join(DIR, `101_batch_${UNDO}.json`);
      const rec = JSON.parse(fs.readFileSync(bf, 'utf8'));
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const d = await c.query(`DELETE FROM product_allergens WHERE id = ANY($1::bigint[]) AND detected_via = 'haccp_api' RETURNING id`, [rec.ids]);
        if (d.rows.length !== rec.ids.length) throw new Error(`수 불일치(${d.rows.length}/${rec.ids.length}) — 중단`);
        await c.query('COMMIT'); console.log(`✅ 되돌리기 완료 — ${UNDO} · ${d.rows.length}행`);
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
      return;
    }
    if (!APPLY) {
      const ro = (await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only;
      if (ro !== 'on') throw new Error(`미리보기인데 읽기 전용 아님(SHOW=${ro}) — 중단`);
    }
    const ev = fs.existsSync(EVAL) ? JSON.parse(fs.readFileSync(EVAL, 'utf8')) : { cases: [] };
    console.log(`[${APPLY ? '적용' : '미리보기 · 읽기 전용'}] HACCP 알레르기 표시란 적재`);
    const A = loadAlg(fs.readFileSync(HACCP, 'utf8').split('\n'));
    const rows = (await pool.query(`SELECT i.product_id, i.prdlst_report_no, i.raw_text, p.barcode, p.product_name FROM product_ingredients i JOIN products p USING (product_id)
      WHERE i.source = 'haccp_api' AND p.is_active AND NOT EXISTS (SELECT 1 FROM product_allergens a WHERE a.product_id = i.product_id)`)).rows;
    const out = [], plan = [];
    const seen = new Set();
    for (const r of rows) {
      if (seen.has(String(r.product_id))) continue; seen.add(String(r.product_id));
      const x = planAlg(r, A);
      out.push({ product_id: r.product_id, barcode: r.barcode, product_name: r.product_name, ...x, names: (x.names || []).join('|') });
      if (x.action === 'fill') plan.push({ product_id: r.product_id, names: x.names });
    }
    const tally = {}; for (const x of out) { const k = `${x.action}${x.reason ? '|' + x.reason : ''}`; tally[k] = (tally[k] || 0) + 1; }
    console.log(`대상 제품 ${out.length} · 넣을 행 ${plan.reduce((s, p) => s + p.names.length, 0)}`);
    for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(30)} ${v}`);
    const csvCell = (v) => { const s = v == null ? '' : String(v).replace(/\r?\n/g, ' '); return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const cols = ['action', 'reason', 'product_id', 'barcode', 'product_name', 'alg', 'names'];
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const f = path.join(DIR, `101_preview_${stamp}.csv`);
    fs.writeFileSync(f, '﻿' + [cols.join(','), ...out.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n'));
    console.log(`미리보기 파일: ${f}`);
    if (!APPLY) { console.log('※ 쓰기 없음.'); return; }
    if (ev.cases.length < 20 || !ev.cases.every((c) => c.judge === 'correct')) throw new Error('eval 20건 미만이거나 오답 — 적용 거부');
    const batch = `haccpalg_${stamp}`;
    const rec = { batch, actor: ACTOR, at: new Date().toISOString(), ids: [] };
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const pids = [], names = [];
      for (const p of plan) for (const n of p.names) { pids.push(p.product_id); names.push(n); }
      // 존재 검사는 쓰기 «전»에 한 번(묶음 경계에서 같은 제품이 갈라지면 자기 행을 보고 거부하던 버그 — 10-12 첫 실행에서 발견 · 롤백됨)
      const upids = [...new Set(pids)];
      const ex = (await c.query(`SELECT count(*)::int n FROM product_allergens WHERE product_id = ANY($1::bigint[])`, [upids])).rows[0].n;
      if (ex) throw new Error('대상에 알레르기 행이 생김 — 전체 롤백');
      for (let i = 0; i < pids.length; i += 1000) {
        const r = await c.query(`INSERT INTO product_allergens (product_id, allergen_name, detected_via, status, evidence_level)
          SELECT u.pid, u.nm, 'haccp_api', 'candidate', 'contains' FROM unnest($1::bigint[], $2::text[]) AS u(pid, nm) RETURNING id`, [pids.slice(i, i + 1000), names.slice(i, i + 1000)]);
        rec.ids.push(...r.rows.map((x) => Number(x.id)));
      }
      if (rec.ids.length !== pids.length) throw new Error('행 수 불일치 — 전체 롤백');
      const bf = path.join(DIR, `101_batch_${batch}.json`);
      fs.writeFileSync(bf, JSON.stringify(rec));
      await c.query('COMMIT');
      console.log(`\n✅ 적용 완료 — 배치 ${batch} · 제품 ${plan.length} · 행 ${rec.ids.length}`);
      console.log(`기록: ${bf}`);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  } finally { await pool.end(); }
}
if (require.main === module && !process.argv.includes('--self-test')) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
