/**
 * 85-probe-barcode-gap.js — 바코드 보유 품목의 «칸별 결손» + «엔진으로 채울 수 있는 몫» 실측 (읽기 전용)
 * 세션75c (2026-10-04) · 제이 요청 «바코드가 있는 품목 중 불완전한 데이터를 다 채우기» → 제이 선택 «측정 → 수요순 채움»
 * ============================================================================
 * 왜 새로 만드나 (70-probe-gap-priority.js 를 안 쓰는 이유)
 *   70 은 2026-07 기준 «품목보고번호 그룹» 단위 + `nutrition_data` 직조회다.
 *   그 뒤 화면이 실제로 읽는 영양은 `product_nutrition_resolved` 뷰(제보 영양 분리 026 포함)로 바뀌었고,
 *   스캔은 «바코드» 단위로 일어난다. ⇒ 화면 기준(바코드 1행)으로 다시 잰다.
 *
 * 무엇을 재나
 *   A. 칸별 결손 — 영양(화면 10키 중 숫자 1개라도) · 원재료(raw_text) · 알레르기 행 · 용량(1회 제공량/총 내용량) · 제조사 · 이미지
 *   B. 엔진 레버(원칙 5 — AI·웹보다 먼저) : 결손 행 중 «이미 우리 DB 안에 답이 있는» 몫
 *      L1 형제 바코드: 같은 c005_report_no 의 다른 활성 바코드에 영양/원재료가 있다
 *      L2 staging_ingredients: 같은 보고번호의 원재료 원문이 스테이징에만 남아 있다
 *      L3 OFF 원재료: openfoodfacts_raw 에 이 바코드의 ingredients_text(_ko) 가 있다
 *      L4 OFF 영양: openfoodfacts_nutrition_norm 에 이 바코드가 있는데 resolved 에 영양이 없다
 *   C. 수요 — scan_history 로 «실제로 스캔된» 결손 바코드 · 신고연도(현역 가능성)
 *
 * ★ 판정선 — 실측 «전»에 고정 (원칙 4 · K-FIND D60-1 과 같은 척도)
 *   레버 하나가 «채울 수 있는 바코드 행» >= 1,000 → 그 레버는 적재 도구를 만들 값어치가 있다(채택 후보)
 *   < 1,000 → 수요 상위(스캔된 것) 건별 처리로만. ⚠ 실측 «후»에 이 숫자를 옮기지 말 것.
 *   ⚠ 레버 수치는 «후보»다. 실제 반영 전에 레버별 표본 20건을 사람이 대조한다(eval 셋 = 출력 samples).
 *
 * ★ 안전: 읽기 전용을 스타트업 파라미터로 걸고 SHOW 로 확인(70 과 같은 방식). INSERT/UPDATE/DELETE/CREATE 없음.
 *   임시 테이블도 만들지 않는다. 테이블이 없으면(to_regclass) 그 레버는 건너뛴다.
 *
 * 실행 (제이 PC — 샌드박스·기기 셸은 Railway Postgres 에 못 붙는다)
 *   cd /d "D:\서박사의 영양공식\backends\먹선\meokseon-server"
 *   node scripts/85-probe-barcode-gap.js
 *   node scripts/85-probe-barcode-gap.js --self-test     ← DB 없이 집계 로직만
 * 출력: 화면 요약 + backends/먹선/.tmp/s75/85_gap_<날짜>.json (요약·표본·수요 상위 목록)
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* */ }
const fs = require('fs');
const path = require('path');

const SELF_TEST = process.argv.includes('--self-test');
const DECISION = { ADOPT_ROWS: 1000 };
const LEVERS = ['l1_sib_nut', 'l1_sib_ing', 'l2_stg_ing', 'l3_off_ing', 'l4_off_nut'];

// ── 순수 함수 (self-test 대상) ────────────────────────────────────────────
function yearBucket(dt) {
  const d = String(dt || '').replace(/[^0-9]/g, '');
  if (d.length < 4) return 'unknown';
  const y = Number(d.slice(0, 4));
  if (y < 1950 || y > 2100) return 'unknown';
  if (y >= 2020) return '2020+';
  if (y >= 2010) return '2010s';
  if (y >= 2000) return '2000s';
  return '<2000';
}

/** 그룹 행(플래그 조합 + n) → 요약. 행의 불리언은 pg 가 true/false 로 준다. */
function summarize(rows) {
  const s = { total: 0, kr880: 0, has: { nut: 0, ing: 0, alg: 0, amt: 0, mfr: 0, img: 0 },
    combo: { both: 0, nut_only: 0, ing_only: 0, neither: 0 }, gap_rows: 0,
    lever: Object.fromEntries(LEVERS.map((k) => [k, 0])), lever_any_nut: 0, lever_any_ing: 0,
    scanned_gap_rows: 0, scanned_gap_scans: 0, year_gap: {}, verdict: {} };
  for (const r of rows) {
    const n = Number(r.n) || 0;
    s.total += n; if (r.kr) s.kr880 += n;
    for (const k of Object.keys(s.has)) if (r['has_' + k]) s.has[k] += n;
    const c = r.has_ing && r.has_nut ? 'both' : r.has_nut ? 'nut_only' : r.has_ing ? 'ing_only' : 'neither';
    s.combo[c] += n;
    if (c === 'both') continue;
    s.gap_rows += n;
    for (const k of LEVERS) if (r[k]) s.lever[k] += n;
    if (r.l1_sib_nut || r.l4_off_nut) s.lever_any_nut += n;
    if (r.l1_sib_ing || r.l2_stg_ing || r.l3_off_ing) s.lever_any_ing += n;
    if (r.scanned) { s.scanned_gap_rows += n; s.scanned_gap_scans += Number(r.scans) || 0; }
    s.year_gap[r.yb] = (s.year_gap[r.yb] || 0) + n;
  }
  for (const k of LEVERS) s.verdict[k] = s.lever[k] >= DECISION.ADOPT_ROWS ? 'ADOPT_CANDIDATE' : 'DEMAND_ONLY';
  return s;
}

if (SELF_TEST) {
  let pass = 0, fail = 0;
  const eq = (a, b, m) => { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; if (!ok) console.log('FAIL', m, a, b); };
  eq(yearBucket('20240513'), '2020+', 'y1'); eq(yearBucket('1985-01-01'), '<2000', 'y2');
  eq(yearBucket(null), 'unknown', 'y3'); eq(yearBucket('20051'), '2000s', 'y4'); eq(yearBucket('1234'), 'unknown', 'y5');
  const rows = [
    { n: 10, kr: true, has_nut: true, has_ing: true, has_alg: true, has_amt: true, has_mfr: true, has_img: false, yb: '2020+', scanned: true, scans: 5 },
    { n: 7, kr: true, has_nut: false, has_ing: true, has_alg: false, has_amt: false, has_mfr: true, has_img: false, l1_sib_nut: true, yb: '2010s', scanned: true, scans: 3 },
    { n: 5, kr: false, has_nut: false, has_ing: false, has_alg: false, has_amt: false, has_mfr: false, has_img: false, l3_off_ing: true, l4_off_nut: true, yb: 'unknown' },
    { n: 2000, kr: true, has_nut: true, has_ing: false, has_alg: false, has_amt: true, has_mfr: true, has_img: false, l2_stg_ing: true, yb: '<2000' },
  ];
  const s = summarize(rows);
  eq(s.total, 2022, 'total'); eq(s.kr880, 2017, 'kr'); eq(s.combo, { both: 10, nut_only: 2000, ing_only: 7, neither: 5 }, 'combo');
  eq(s.gap_rows, 2012, 'gap'); eq(s.lever.l1_sib_nut, 7, 'l1'); eq(s.lever.l2_stg_ing, 2000, 'l2');
  eq(s.lever_any_nut, 12, 'anyNut'); eq(s.lever_any_ing, 2005, 'anyIng');
  eq(s.scanned_gap_rows, 7, 'scanned (both 제외)'); eq(s.scanned_gap_scans, 3, 'scans');
  eq(s.verdict.l2_stg_ing, 'ADOPT_CANDIDATE', 'v1'); eq(s.verdict.l1_sib_nut, 'DEMAND_ONLY', 'v2');
  eq(s.year_gap, { '2010s': 7, unknown: 5, '<2000': 2000 }, 'year');
  console.log(`[self-test] 통과 ${pass} / 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}

// ── DB ─────────────────────────────────────────────────────────────────────
const { Pool } = require('pg');
const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } }
  : { host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'meokseon', user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || '' };
poolConfig.connectionTimeoutMillis = 25000;
poolConfig.statement_timeout = 300000;   // 단계별 5분 — 한 단계가 넘으면 그 단계 이름이 화면에 남는다
poolConfig.keepAlive = true;
poolConfig.options = '-c default_transaction_read_only=on';
const pool = new Pool(poolConfig);
const fmt = (n) => Number(n || 0).toLocaleString();
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '-');

async function exists(rel) { const r = await pool.query('SELECT to_regclass($1) AS t', [rel]); return !!r.rows[0].t; }
async function hasCol(t, c) {
  const r = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [t, c]);
  return r.rowCount > 0;
}

const NUT_KEYS = ['calories','protein','total_fat','saturated_fat','trans_fat','cholesterol','sodium','total_carbs','total_sugars','dietary_fiber'];
const CHUNK = 5000;
const isBlank = (v) => v == null || String(v).trim() === '';

/** 단계별 시간 출력 — 느린 단계를 «추측 말고» 보이게 (1차 실행 statement timeout 진단용) */
async function step(label, fn) {
  const t0 = Date.now(); process.stdout.write(`  · ${label} … `);
  const r = await fn(); console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`); return r;
}
async function chunked(ids, sql, cast) {
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const r = await pool.query(sql, [ids.slice(i, i + CHUNK)]);
    for (const x of r.rows) out.push(x);
  }
  return out;
}

/**
 * ★ 세션75c 2차 — 1차는 «한 방 거대 CTE»(resolved 뷰 전수 + IN 서브쿼리 + 행별 EXISTS + GROUP BY)가
 *   statement timeout(15분)에 걸렸다. 그래서 단순 조회 여러 개 + 5,000개씩 끊은 `= ANY($1)` + JS 결합으로 바꿨다.
 *   뷰는 `product_id = ANY` 로 끊어 부르면 findByBarcode 와 같은 경로(행 단위)로 탄다.
 */
async function main() {
  const ro = (await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only;
  if (ro !== 'on') throw new Error(`읽기 전용 아님(SHOW=${ro}) — 중단`);
  console.log(`[안전] default_transaction_read_only = ${ro}`);
  await pool.query("SET statement_timeout = '300s'");

  const t = {
    stg: await exists('public.staging_ingredients'),
    offRaw: await exists('public.openfoodfacts_raw'),
    offNut: await exists('public.openfoodfacts_nutrition_norm'),
    scan: await exists('public.scan_history'),
    alg: await exists('public.product_allergens'),
  };
  const dtCol = (await hasCol('products', 'prms_dt_i1250')) ? 'prms_dt_i1250' : 'NULL';
  console.log('[테이블]', JSON.stringify(t), 'date=', dtCol);

  console.log('[1/3] 단계별 조회');
  // 활성 제품 중 «바코드 행» 또는 «보고번호가 있는 행»(형제 판정용)
  const prods = await step('products', async () => (await pool.query(`
    SELECT product_id, barcode, product_name, manufacturer, c005_report_no AS rn, ${dtCol}::text AS dt,
           (COALESCE(serving_size,0) > 0 OR COALESCE(total_content,0) > 0) AS has_amt,
           (btrim(COALESCE(manufacturer,'')) <> '') AS has_mfr,
           (btrim(COALESCE(image_url,'')) <> '') AS has_img,
           (barcode ~ '^[0-9]{8,14}$') AS is_bc
    FROM products
    WHERE is_active AND (barcode ~ '^[0-9]{8,14}$' OR btrim(COALESCE(c005_report_no,'')) <> '')`)).rows);
  console.log(`    rows=${fmt(prods.length)}`);
  const ids = prods.map((p) => Number(p.product_id));
  const bcRows = prods.filter((p) => p.is_bc);
  const codes = bcRows.map((p) => p.barcode);

  const nutSet = new Set((await step(`resolved 뷰 영양 (${Math.ceil(ids.length / CHUNK)}묶음)`, () => chunked(ids,
    `SELECT product_id FROM product_nutrition_resolved WHERE product_id = ANY($1::bigint[]) AND (${NUT_KEYS.map((k) => k + ' IS NOT NULL').join(' OR ')})`)))
    .map((r) => Number(r.product_id)));
  const ingSet = new Set((await step('원재료', async () => (await pool.query(
    `SELECT DISTINCT product_id FROM product_ingredients WHERE raw_text IS NOT NULL AND btrim(raw_text) <> ''`)).rows)).map((r) => Number(r.product_id)));
  const algSet = t.alg ? new Set((await step('알레르기', async () => (await pool.query(
    `SELECT DISTINCT product_id FROM product_allergens`)).rows)).map((r) => Number(r.product_id))) : new Set();
  const stgSet = t.stg ? new Set((await step('staging_ingredients', async () => (await pool.query(
    `SELECT DISTINCT prdlst_report_no AS rn FROM staging_ingredients WHERE rawmtrl_nm IS NOT NULL AND btrim(rawmtrl_nm) <> ''`)).rows)).map((r) => r.rn)) : new Set();
  const offiSet = t.offRaw ? new Set((await step('OFF 원재료(바코드 묶음)', () => chunked(codes,
    `SELECT code FROM openfoodfacts_raw WHERE code = ANY($1::text[]) AND btrim(COALESCE(raw->>'ingredients_text_ko', raw->>'ingredients_text', '')) <> ''`)))
    .map((r) => r.code)) : new Set();
  const offnSet = t.offNut ? new Set((await step('OFF 영양(바코드 묶음)', () => chunked(codes,
    `SELECT code FROM openfoodfacts_nutrition_norm WHERE code = ANY($1::text[]) AND (calories IS NOT NULL OR sodium_mg IS NOT NULL OR total_carbs IS NOT NULL)`)))
    .map((r) => r.code)) : new Set();
  const scans = new Map(t.scan ? (await step('scan_history', async () => (await pool.query(
    `SELECT product_id, COUNT(*)::int AS n FROM scan_history GROUP BY product_id`)).rows)).map((r) => [Number(r.product_id), r.n]) : []);

  // 형제(같은 보고번호)의 보유 여부
  const rnNut = new Set(), rnIng = new Set();
  for (const p of prods) {
    if (isBlank(p.rn)) continue;
    const id = Number(p.product_id);
    if (nutSet.has(id)) rnNut.add(p.rn);
    if (ingSet.has(id)) rnIng.add(p.rn);
  }

  console.log('[2/3] 행 판정·집계');
  const flagged = bcRows.map((p) => {
    const id = Number(p.product_id);
    const has_nut = nutSet.has(id), has_ing = ingSet.has(id), rn = isBlank(p.rn) ? null : p.rn;
    return { product_id: id, barcode: p.barcode, product_name: p.product_name, manufacturer: p.manufacturer, rn,
      kr: /^880/.test(p.barcode), has_nut, has_ing, has_alg: algSet.has(id), has_amt: p.has_amt, has_mfr: p.has_mfr, has_img: p.has_img,
      l1_sib_nut: !has_nut && !!rn && rnNut.has(rn), l1_sib_ing: !has_ing && !!rn && rnIng.has(rn),
      l2_stg_ing: !has_ing && !!rn && stgSet.has(rn), l3_off_ing: !has_ing && offiSet.has(p.barcode),
      l4_off_nut: !has_nut && offnSet.has(p.barcode),
      scans: scans.get(id) || 0, yb: yearBucket(p.dt) };
  });
  const s = summarize(flagged.map((r) => ({ ...r, n: 1, scanned: r.scans > 0 })));
  // summarize 는 행별 scans 를 더한다 — n=1 이므로 그대로 맞다

  const gap = flagged.filter((r) => !(r.has_nut && r.has_ing));
  const byScan = (a, b) => b.scans - a.scans || String(a.barcode).localeCompare(String(b.barcode));
  const samples = {};
  for (const k of LEVERS) {
    const xs = gap.filter((r) => r[k]);
    // 스캔된 것 우선, 나머지는 바코드 기준 고르게(결정적)
    const top = xs.filter((r) => r.scans > 0).sort(byScan).slice(0, 10);
    const rest = xs.filter((r) => !r.scans); const stepN = Math.max(1, Math.floor(rest.length / (20 - top.length || 1)));
    samples[k] = [...top, ...rest.filter((_, i) => i % stepN === 0).slice(0, 20 - top.length)];
  }
  const demand = gap.filter((r) => r.scans > 0).sort(byScan).slice(0, 300);

  console.log('[3/3] 출력');
  const T = s.total;
  console.log('\n================ 85 바코드 결손 실측 ================');
  console.log(`활성·바코드 행 ${fmt(T)} (880 국내 ${fmt(s.kr880)})`);
  console.log(`영양 ${pct(s.has.nut, T)} · 원재료 ${pct(s.has.ing, T)} · 알레르기행 ${pct(s.has.alg, T)} · 용량 ${pct(s.has.amt, T)} · 제조사 ${pct(s.has.mfr, T)} · 이미지 ${pct(s.has.img, T)}`);
  console.log(`조합: 둘 다 ${fmt(s.combo.both)} (${pct(s.combo.both, T)}) · 영양만 ${fmt(s.combo.nut_only)} · 원재료만 ${fmt(s.combo.ing_only)} · 둘 다 없음 ${fmt(s.combo.neither)}`);
  console.log(`결손(영양·원재료 중 하나라도 없음) ${fmt(s.gap_rows)}`);
  console.log('엔진 레버(결손 행 중 DB 안에 답이 있는 몫) — 판정선 >= 1,000:');
  for (const k of LEVERS) console.log(`  ${k.padEnd(12)} ${fmt(s.lever[k]).padStart(8)}  ${s.verdict[k]}`);
  console.log(`  영양 레버 합(중복 제거) ${fmt(s.lever_any_nut)} · 원재료 레버 합 ${fmt(s.lever_any_ing)}`);
  console.log(`수요: 스캔된 결손 바코드 ${fmt(s.scanned_gap_rows)} (스캔 ${fmt(s.scanned_gap_scans)}회)`);
  console.log('결손 신고연도:', JSON.stringify(s.year_gap));

  const outDir = path.resolve(__dirname, '../../.tmp/s75');
  fs.mkdirSync(outDir, { recursive: true });
  const f = path.join(outDir, `85_gap_${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), tables: t, decision: DECISION, summary: s, samples, demand }, null, 1));
  console.log(`\n저장: ${f}`);
  console.log('SUMMARY ' + JSON.stringify({ total: T, gap: s.gap_rows, lever: s.lever, scanned_gap: s.scanned_gap_rows }));
}

main().then(() => pool.end()).catch((e) => { console.error('ERR', e.message); pool.end(); process.exit(1); });
