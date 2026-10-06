/**
 * 92-probe-c005-consistency.js — 같은 품목제조번호 형제끼리 «이미 가진» 원재료·영양이 얼마나 일치하나 (읽기 전용)  세션75i 2026-10-06
 * ============================================================================
 * 목적(제이 합의 10-06): 바코드를 하나씩 확인하는 대신 «데이터로» 증명한다.
 *   형제가 각자 원재료/영양을 갖고 있는 묶음에서 일치율이 높으면 → 빈 형제에 채워도 된다는 근거.
 *   다르게 나오는 유형은 91 채움 규칙의 보류 조건으로 넣는다.
 * 묶음·하위군 = 90-probe-c005-groups.js classifyC005Group(U1·U2 하위군만 · 깨진 글자 보정 포함).
 *
 * 원재료 비교: 최상위 쉼표로 나눈 항목 → 7월 normIngredient(괄호 부연·함량%·기호 제거) → 집합 Jaccard(하위군 안 최소값)
 *   등급: 원문 동일 / 항목 동일(순서·표기만 다름) / ≥0.9 / 0.7~0.9 / 0.5~0.7 / <0.5
 * 영양 비교: 자기 nutrition_data 가 100g/100ml 기준인 형제끼리 열량·나트륨·당류·포화지방 — 2% 안 / 15% 안 / 15% 초과
 *
 * 출력(backends/먹선/.tmp/s75/): 92_summary_<날짜>.json · 92_ing_low_<날짜>.csv(Jaccard<0.7 표본 300쌍 원문) · 92_nut_diff_<날짜>.csv(15% 초과 전부)
 * 실행 (제이 PC · meokseon-server 폴더):  node scripts/92-probe-c005-consistency.js   |  --self-test
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* */ }
const fs = require('fs');
const path = require('path');
const { classifyC005Group } = require('./90-probe-c005-groups');
// 7월 product_dedup_classify.js 의 normIngredient·jaccard 와 같은 식(그 파일은 수입 트랙 모듈까지 끌어와서 여기선 옮겨 씀 — 바꾸면 둘 다)
function normIngredient(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\([^)]*\)/g, '').replace(/[0-9]+(\.[0-9]+)?\s*%?/g, '').replace(/[^a-z0-9가-힣ㄱ-ㅎㅏ-ㅣ]/g, '').trim();
}
function jaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return null;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter; return uni === 0 ? null : inter / uni;
}

/** 최상위(괄호 밖) 쉼표로 나눈다 */
function splitTop(raw) {
  const out = []; let depth = 0, cur = '';
  for (const ch of String(raw || '')) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === '，') && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
function ingSet(raw) { const s = new Set(); for (const t of splitTop(raw)) { const n = normIngredient(t); if (n) s.add(n); } return s; }
function ingGrade(a, b) {
  if (String(a).replace(/\s/g, '') === String(b).replace(/\s/g, '')) return { g: '원문 동일', j: 1 };
  const j = jaccard(ingSet(a), ingSet(b));
  if (j == null) return { g: '비교 불가', j: null };
  if (j === 1) return { g: '항목 동일(순서·표기만 다름)', j };
  return { g: j >= 0.9 ? '0.9 이상' : j >= 0.7 ? '0.7~0.9' : j >= 0.5 ? '0.5~0.7' : '0.5 미만', j };
}
function nutGrade(a, b) {
  const ks = ['calories', 'sodium', 'total_sugars', 'saturated_fat'];
  let worst = 0;
  for (const k of ks) {
    if (a[k] == null || b[k] == null) continue;
    const x = parseFloat(a[k]), y = parseFloat(b[k]), m = Math.max(Math.abs(x), Math.abs(y));
    if (m === 0) continue;
    // 아주 작은 값(나트륨 5mg 미만 · 그 밖 0.5 미만)은 반올림 차이로 보고 상대오차에서 뺀다
    if (m < (k === 'sodium' ? 5 : 0.5)) continue;
    worst = Math.max(worst, Math.abs(x - y) / m);
  }
  return worst <= 0.02 ? '2% 안' : worst <= 0.15 ? '15% 안' : '15% 초과';
}
const basisOf = (ss) => { const s = String(ss || '').replace(/\s/g, '').toLowerCase(); return /^100ml/.test(s) ? 'ml' : /^100g/.test(s) ? 'g' : null; };
const csvCell = (v) => { const s = v == null ? '' : String(v).replace(/\r?\n/g, ' '); return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

if (require.main === module && process.argv.includes('--self-test')) {
  let pass = 0, fail = 0; const eq = (a, b, m) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log('FAIL', m, JSON.stringify(a), JSON.stringify(b)); } };
  eq(splitTop('밀가루(밀: 미국산, 호주산), 설탕, 쇼트닝(팜유, 대두유)'), ['밀가루(밀: 미국산, 호주산)', '설탕', '쇼트닝(팜유, 대두유)'], 's1 괄호 안 쉼표');
  eq(ingGrade('밀가루, 설탕', '밀가루,설탕').g, '원문 동일', 'g1');
  eq(ingGrade('밀가루(미국산), 설탕 10%', '설탕, 밀가루(호주산)').g, '항목 동일(순서·표기만 다름)', 'g2 원산지·함량·순서 무시');
  eq(ingGrade('가, 나, 다, 라, 마, 바, 사, 아, 자, 차', '가, 나, 다, 라, 마, 바, 사, 아, 자').g, '0.9 이상', 'g3');
  eq(ingGrade('원유', '정제수, 액상과당').g, '0.5 미만', 'g4');
  eq(nutGrade({ calories: 100, sodium: 50 }, { calories: 101, sodium: 50 }), '2% 안', 'n1');
  eq(nutGrade({ calories: 100 }, { calories: 110 }), '15% 안', 'n2');
  eq(nutGrade({ calories: 100 }, { calories: 140 }), '15% 초과', 'n3');
  eq(nutGrade({ sodium: 1 }, { sodium: 3 }), '2% 안', 'n4 작은 나트륨 무시');
  console.log(`[self-test] 통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
}

const { Pool } = require('pg');
const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } }
  : { host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'meokseon', user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || '' };
Object.assign(poolConfig, { connectionTimeoutMillis: 25000, statement_timeout: 300000, keepAlive: true, options: '-c default_transaction_read_only=on' });
const NUT = ['calories','protein','total_fat','saturated_fat','trans_fat','cholesterol','sodium','total_carbs','total_sugars','dietary_fiber'];
const CHUNK = 5000;

async function main() {
  const pool = new Pool(poolConfig);
  const chunked = async (ids, sql) => { const o = []; for (let i = 0; i < ids.length; i += CHUNK) o.push(...(await pool.query(sql, [ids.slice(i, i + CHUNK)])).rows); return o; };
  const step = async (label, fn) => { const t0 = Date.now(); process.stdout.write(`  · ${label} … `); const r = await fn(); console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`); return r; };
  try {
    const ro = (await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only;
    if (ro !== 'on') throw new Error(`읽기 전용 아님(SHOW=${ro}) — 중단`);
    console.log(`[안전] default_transaction_read_only = ${ro}`);
    const prods = await step('products', async () => (await pool.query(`
      SELECT product_id, barcode, product_name, brand, manufacturer, food_type, total_content, content_unit, btrim(c005_report_no) AS rn
      FROM products WHERE is_active AND btrim(COALESCE(c005_report_no,'')) <> ''`)).rows);
    const byRn = new Map(); for (const p of prods) { if (!byRn.has(p.rn)) byRn.set(p.rn, []); byRn.get(p.rn).push(p); }
    const clusters = [];
    for (const [rn, ms] of byRn) {
      if (ms.length < 2) continue;
      const c = classifyC005Group(ms);
      if (c.cls[0] !== 'U') continue;
      for (const cl of c.clusters) if (cl.length >= 2) clusters.push({ rn, cls: c.cls, ms: cl.map((i) => ms[i]) });
    }
    const ids = clusters.flatMap((c) => c.ms.map((m) => Number(m.product_id)));
    console.log(`  · U 하위군(≥2) ${clusters.length.toLocaleString()} · 멤버 ${ids.length.toLocaleString()}`);
    const ing = new Map((await step('원재료', () => chunked(ids, `SELECT DISTINCT ON (product_id) product_id, raw_text, source FROM product_ingredients WHERE product_id = ANY($1::bigint[]) AND raw_text IS NOT NULL AND btrim(raw_text) <> '' ORDER BY product_id, id`))).map((r) => [Number(r.product_id), r]));
    const nd = new Map((await step('자기 영양', () => chunked(ids, `SELECT product_id, serving_size, ${NUT.join(', ')} FROM nutrition_data WHERE product_id = ANY($1::bigint[]) AND (${NUT.map((k) => k + ' IS NOT NULL').join(' OR ')})`))).map((r) => [Number(r.product_id), r]));

    const S = { clusters: clusters.length, ing: { clusters: 0, byGrade: {}, bySourcePair: {} }, nut: { clusters: 0, byGrade: {} } };
    const add = (o, k) => { o[k] = (o[k] || 0) + 1; };
    const low = [], ndiff = [];
    const ORDER = ['원문 동일', '항목 동일(순서·표기만 다름)', '0.9 이상', '0.7~0.9', '0.5~0.7', '0.5 미만', '비교 불가'];
    for (const c of clusters) {
      // 원재료: 하위군 안 «가장 덜 닮은 쌍» 기준(보수적)
      const im = c.ms.filter((m) => ing.has(Number(m.product_id)));
      if (im.length >= 2) {
        S.ing.clusters++;
        let worst = null;
        for (let i = 0; i < im.length; i++) for (let j = i + 1; j < im.length; j++) {
          const a = ing.get(Number(im[i].product_id)), b = ing.get(Number(im[j].product_id));
          const g = ingGrade(a.raw_text, b.raw_text);
          if (!worst || ORDER.indexOf(g.g) > ORDER.indexOf(worst.g.g)) worst = { g, a, b, ma: im[i], mb: im[j] };
        }
        add(S.ing.byGrade, worst.g.g);
        const sp = [worst.a.source, worst.b.source].sort().join('+');
        S.ing.bySourcePair[sp] = S.ing.bySourcePair[sp] || {}; add(S.ing.bySourcePair[sp], worst.g.g);
        if (worst.g.j != null && worst.g.j < 0.7) low.push({ rn: c.rn, jaccard: worst.g.j.toFixed(2), name_a: worst.ma.product_name, bc_a: worst.ma.barcode, src_a: worst.a.source, ing_a: String(worst.a.raw_text).slice(0, 200),
          name_b: worst.mb.product_name, bc_b: worst.mb.barcode, src_b: worst.b.source, ing_b: String(worst.b.raw_text).slice(0, 200) });
      }
      // 영양: 같은 기준(g/ml)끼리
      const nm = c.ms.filter((m) => { const r = nd.get(Number(m.product_id)); return r && basisOf(r.serving_size); });
      if (nm.length >= 2) {
        const b0 = basisOf(nd.get(Number(nm[0].product_id)).serving_size);
        const same = nm.filter((m) => basisOf(nd.get(Number(m.product_id)).serving_size) === b0);
        if (same.length < nm.length) { add(S.nut.byGrade, '기준(g/ml) 섞임'); S.nut.clusters++; continue; }
        S.nut.clusters++;
        let worst = '2% 안'; const G = ['2% 안', '15% 안', '15% 초과']; let pair = null;
        for (let i = 0; i < same.length; i++) for (let j = i + 1; j < same.length; j++) {
          const g = nutGrade(nd.get(Number(same[i].product_id)), nd.get(Number(same[j].product_id)));
          if (G.indexOf(g) > G.indexOf(worst)) { worst = g; pair = [same[i], same[j]]; }
        }
        add(S.nut.byGrade, worst);
        if (worst === '15% 초과') { const a = nd.get(Number(pair[0].product_id)), b = nd.get(Number(pair[1].product_id));
          ndiff.push({ rn: c.rn, name: pair[0].product_name, bc_a: pair[0].barcode, bc_b: pair[1].barcode, basis: b0,
            kcal: `${a.calories} / ${b.calories}`, sodium: `${a.sodium} / ${b.sodium}`, sugars: `${a.total_sugars} / ${b.total_sugars}`, satfat: `${a.saturated_fat} / ${b.saturated_fat}` }); }
      }
    }
    const pct = (o, n) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, `${v.toLocaleString()} (${(100 * v / n).toFixed(1)}%)`]));
    console.log('\n================ 92 형제끼리 일치율 ================');
    console.log(`원재료를 2개 이상 가진 하위군 ${S.ing.clusters.toLocaleString()} (가장 덜 닮은 쌍 기준)`);
    for (const k of ORDER) if (S.ing.byGrade[k]) console.log(`  ${k.padEnd(22)} ${pct({ [k]: S.ing.byGrade[k] }, S.ing.clusters)[k]}`);
    console.log('  출처 조합별(상위 6):');
    for (const [sp, o] of Object.entries(S.ing.bySourcePair).sort((a, b) => Object.values(b[1]).reduce((x, y) => x + y, 0) - Object.values(a[1]).reduce((x, y) => x + y, 0)).slice(0, 6)) {
      const n = Object.values(o).reduce((x, y) => x + y, 0); const hi = (o['원문 동일'] || 0) + (o['항목 동일(순서·표기만 다름)'] || 0) + (o['0.9 이상'] || 0);
      console.log(`    ${sp.padEnd(30)} ${n.toLocaleString()} · 0.9 이상 ${(100 * hi / n).toFixed(1)}%`);
    }
    console.log(`영양(100g/ml)을 2개 이상 가진 하위군 ${S.nut.clusters.toLocaleString()}`);
    for (const [k, v] of Object.entries(S.nut.byGrade)) console.log(`  ${k.padEnd(22)} ${v.toLocaleString()} (${(100 * v / S.nut.clusters).toFixed(1)}%)`);
    const dir = path.resolve(__dirname, '../../.tmp/s75'); fs.mkdirSync(dir, { recursive: true });
    const d = new Date().toISOString().slice(0, 10);
    const w = (f, rows) => { const cols = Object.keys(rows[0] || { rn: '' }); fs.writeFileSync(path.join(dir, f), '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n')); };
    w(`92_ing_low_${d}.csv`, low.sort(() => 0.5 - Math.random()).slice(0, 300)); w(`92_nut_diff_${d}.csv`, ndiff);
    S.ing_low_total = low.length; S.nut_diff_total = ndiff.length;
    fs.writeFileSync(path.join(dir, `92_summary_${d}.json`), JSON.stringify(S, null, 1));
    console.log(`\n저장: ${path.join(dir, `92_summary_${d}.json`)} · 92_ing_low_${d}.csv(${Math.min(300, low.length)}/${low.length}) · 92_nut_diff_${d}.csv(${ndiff.length})`);
  } finally { await pool.end(); }
}
module.exports = { splitTop, ingGrade, nutGrade };
if (require.main === module) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
