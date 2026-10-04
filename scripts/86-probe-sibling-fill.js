/**
 * 86-probe-sibling-fill.js — L1 «형제 바코드» 채움 후보 상세 (읽기 전용 · dry-run 자료)  세션75c 2026-10-04
 * ============================================================================
 * 85 실측: 결손 바코드 중 같은 품목보고번호(c005_report_no)의 다른 활성 행이 값을 가진 것 —
 *   영양 1,364 · 원재료 3,566 (판정선 1,000 이상 → 채택 후보). 반영 «전»에 쌍을 하나씩 볼 수 있게 펼친다.
 *
 * 쌍마다 남기는 것
 *   대상(바코드·이름·제조사) ↔ 형제(id·바코드·이름·제조사) · 형제 원재료 원문 앞부분/출처 · 형제 영양 기준(serving_size 마커)·출처
 *   name_rel : SAME(용량·괄호·공백 떼면 같음) | CONTAINS(한쪽이 다른 쪽을 품음) | DIFF
 *   nut_basis: 형제 영양의 기준 — '100g'/'100ml' 만 «용량이 달라도 그대로 옮길 수 있다». 그 밖(1회분·총량·미상)은 옮기면 거짓.
 *
 * 출력: backends/먹선/.tmp/s75/86_sibling_<날짜>.csv (+ 화면 분포)
 * 실행 (제이 PC):  node scripts/86-probe-sibling-fill.js      |  --self-test (DB 없이)
 * ⚠ 쓰기 없음 — 85 와 같은 읽기 전용 스타트업 파라미터 + SHOW 확인.
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* */ }
const fs = require('fs');
const path = require('path');

const isBlank = (v) => v == null || String(v).trim() === '';
/** 이름 비교용 정규화: 괄호 내용·용량(숫자+단위)·개수·공백·기호 제거 */
function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .replace(/\d+(\.\d+)?\s*(kg|g|mg|ml|l|리터|개입|개|입|봉|팩|매|ea|x|\*)/gi, '')
    .replace(/[^0-9a-z가-힣]/g, '');
}
function nameRel(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return 'DIFF';
  if (x === y) return 'SAME';
  if (x.includes(y) || y.includes(x)) return 'CONTAINS';
  return 'DIFF';
}
function basisOf(ss) {
  const s = String(ss || '').replace(/\s/g, '').toLowerCase();
  if (/^100ml/.test(s)) return '100ml';
  if (/^100g/.test(s)) return '100g';
  if (/^100unknown/.test(s)) return '100unknown';
  return s ? 'serving_or_total' : 'unknown';
}
const csvCell = (v) => { const s = v == null ? '' : String(v).replace(/\r?\n/g, ' '); return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

if (process.argv.includes('--self-test')) {
  let pass = 0, fail = 0; const eq = (a, b, m) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log('FAIL', m, a, b); } };
  eq(nameRel('허니버터칩 60g', '허니버터칩(120g)'), 'SAME', 'n1');
  eq(nameRel('매일우유 오리지널 200ml', '매일우유 오리지널 1L'), 'SAME', 'n2');
  eq(nameRel('포카칩 어니언맛', '포카칩 어니언맛 대용량'), 'CONTAINS', 'n3');
  eq(nameRel('포카칩 어니언맛', '포카칩 오리지널'), 'DIFF', 'n4');
  eq(nameRel('', '무엇'), 'DIFF', 'n5');
  eq(basisOf('100g'), '100g', 'b1'); eq(basisOf('100 ml'), '100ml', 'b2'); eq(basisOf('30'), 'serving_or_total', 'b3');
  eq(basisOf(null), 'unknown', 'b4'); eq(basisOf('100unknown'), '100unknown', 'b5');
  eq(csvCell('a,"b"'), '"a,""b"""', 'c1');
  console.log(`[self-test] 통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
}

const { Pool } = require('pg');
const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } }
  : { host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'meokseon', user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || '' };
Object.assign(poolConfig, { connectionTimeoutMillis: 25000, statement_timeout: 300000, keepAlive: true, options: '-c default_transaction_read_only=on' });
const pool = new Pool(poolConfig);
const CHUNK = 5000;
const NUT_KEYS = ['calories','protein','total_fat','saturated_fat','trans_fat','cholesterol','sodium','total_carbs','total_sugars','dietary_fiber'];
async function chunked(ids, sql) { const out = []; for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await pool.query(sql, [ids.slice(i, i + CHUNK)])).rows); return out; }
async function step(label, fn) { const t0 = Date.now(); process.stdout.write(`  · ${label} … `); const r = await fn(); console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`); return r; }

async function main() {
  const ro = (await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only;
  if (ro !== 'on') throw new Error(`읽기 전용 아님(SHOW=${ro}) — 중단`);
  console.log(`[안전] default_transaction_read_only = ${ro}`);

  const prods = await step('products(보고번호 있는 활성)', async () => (await pool.query(`
    SELECT product_id, barcode, product_name, manufacturer, c005_report_no AS rn, (barcode ~ '^[0-9]{8,14}$') AS is_bc
    FROM products WHERE is_active AND btrim(COALESCE(c005_report_no,'')) <> ''`)).rows);
  const ids = prods.map((p) => Number(p.product_id));
  const nutRows = await step('resolved 영양(묶음)', () => chunked(ids,
    `SELECT product_id, serving_size, resolved_source FROM product_nutrition_resolved WHERE product_id = ANY($1::bigint[]) AND (${NUT_KEYS.map((k) => k + ' IS NOT NULL').join(' OR ')})`));
  const nut = new Map(nutRows.map((r) => [Number(r.product_id), r]));
  const ingRows = await step('원재료', async () => (await pool.query(
    `SELECT DISTINCT ON (product_id) product_id, raw_text, source FROM product_ingredients WHERE raw_text IS NOT NULL AND btrim(raw_text) <> '' ORDER BY product_id, id`)).rows);
  const ing = new Map(ingRows.map((r) => [Number(r.product_id), r]));

  const byRn = new Map();
  for (const p of prods) { const k = p.rn; if (!byRn.has(k)) byRn.set(k, []); byRn.get(k).push(p); }

  const out = []; const dist = {};
  const bump = (k) => { dist[k] = (dist[k] || 0) + 1; };
  for (const t of prods) {
    if (!t.is_bc) continue;
    const tid = Number(t.product_id);
    for (const axis of ['ing', 'nut']) {
      const has = axis === 'ing' ? ing.has(tid) : nut.has(tid);
      if (has) continue;
      const sibs = (byRn.get(t.rn) || []).filter((s) => Number(s.product_id) !== tid && (axis === 'ing' ? ing.has(Number(s.product_id)) : nut.has(Number(s.product_id))));
      if (!sibs.length) continue;
      // 이름이 가장 가까운 형제 하나 (SAME > CONTAINS > DIFF)
      const rank = { SAME: 0, CONTAINS: 1, DIFF: 2 };
      sibs.sort((a, b) => rank[nameRel(t.product_name, a.product_name)] - rank[nameRel(t.product_name, b.product_name)]);
      const s = sibs[0], sid = Number(s.product_id), rel = nameRel(t.product_name, s.product_name);
      const mfrSame = !isBlank(normName(t.manufacturer)) && normName(t.manufacturer).slice(0, 4) === normName(s.manufacturer).slice(0, 4); // 둘 중 하나라도 비면 «같음» 아님
      const n = nut.get(sid), g = ing.get(sid);
      const basis = axis === 'nut' ? basisOf(n.serving_size) : '';
      bump(`${axis}|${rel}|${axis === 'nut' ? basis : '-'}|mfr${mfrSame ? '같음' : '다름'}`);
      out.push({ axis, target_id: tid, target_bc: t.barcode, target_name: t.product_name, target_mfr: t.manufacturer, rn: t.rn,
        sib_id: sid, sib_bc: s.barcode, sib_name: s.product_name, sib_mfr: s.manufacturer, n_sibs: sibs.length,
        name_rel: rel, mfr_same: mfrSame, nut_basis: basis, nut_source: axis === 'nut' ? n.resolved_source : '',
        ing_source: axis === 'ing' ? g.source : '', ing_head: axis === 'ing' ? String(g.raw_text).slice(0, 120) : '' });
    }
  }

  console.log('\n================ 86 형제 채움 후보 ================');
  console.log(`후보 쌍 ${out.length.toLocaleString()} (원재료 ${out.filter((x) => x.axis === 'ing').length.toLocaleString()} · 영양 ${out.filter((x) => x.axis === 'nut').length.toLocaleString()})`);
  for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(40)} ${v.toLocaleString()}`);

  const dir = path.resolve(__dirname, '../../.tmp/s75'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `86_sibling_${new Date().toISOString().slice(0, 10)}.csv`);
  const cols = Object.keys(out[0] || { axis: '' });
  fs.writeFileSync(f, '﻿' + [cols.join(','), ...out.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n'));
  console.log(`\n저장: ${f}`);
  console.log('SUMMARY ' + JSON.stringify({ pairs: out.length, dist }));
}
main().then(() => pool.end()).catch((e) => { console.error('ERR', e.message); pool.end(); process.exit(1); });
