/**
 * 81 — U61-2 수입 축 재측정 (Q-A 중복 · Q-B 이름 브릿지 순증). **읽기 전용.**
 * 설계 정본: IP/수입축_재측정_설계_2026-08-11_세션61.md · 합격선 D61-1(실측 전 고정, 옮기지 말 것)
 *   Q-B 순증 ≥5,000 채택 · 500~4,999 보류 · <500 기각.
 * 입력: K-FIND 가공식품DB 핵심열 CSV.gz (세션80 · 20260929판) — 수입여부=Y 행만.
 * 로직: scripts/staging/off/build_import_bridge.js 의 resolveMatches(단일 소스) 그대로 — 복제 금지.
 *   순증 = 영양 카드가 «안 뜨는» 활성 제품 중 decision≠reject 후보가 1개 이상인 제품 수.
 *   ⚠ 정책 A: 이름 브릿지는 auto-accept 없음 → 순증은 «사람 검토 후보» 수다(바로 켜지는 수 아님).
 * 사용: node scripts/81-import-remeasure.js <kfind_core.csv.gz> [--out <json>]
 */
'use strict';
const path = require('path'), fs = require('fs'), zlib = require('zlib');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
const { Pool } = require('pg');
const { resolveMatches, parseServing, toGram } = require('./staging/off/build_import_bridge');

function parseCsv(t) { const out = []; let row = [], f = '', q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; } else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f); out.push(row); row = []; f = ''; } else if (c !== '\r') f += c; } if (f || row.length) { row.push(f); out.push(row); } return out; }
const num = (v) => (v == null || v === '' ? null : Number(v));

(async () => {
  const F = process.argv[2]; const oi = process.argv.indexOf('--out'); const OUT = oi > 0 ? process.argv[oi + 1] : null;
  const rows = parseCsv(zlib.gunzipSync(fs.readFileSync(F)).toString('utf8')); const h = rows.shift(); const I = (k) => h.indexOf(k);
  const imports = [];
  for (const r of rows) {
    if (r[I('수입여부')] !== 'Y' || r[I('에너지(kcal)')] === '') continue;
    const { serving_g } = parseServing(r[I('영양성분함량기준량')]);
    imports.push({ food_cd: r[I('식품코드')], name: r[I('식품명')], nation: r[I('원산지국명')], importer: r[I('수입업체명')], kcal: num(r[I('에너지(kcal)')]), sodium: num(r[I('나트륨(mg)')]), serving_g });
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  await c.query('SET default_transaction_read_only = on');
  const prod = (await c.query(`SELECT p.product_id, p.product_name, p.brand, p.manufacturer, p.food_type, p.total_content, p.content_unit,
      EXISTS(SELECT 1 FROM product_nutrition_resolved r WHERE r.product_id=p.product_id AND r.calories IS NOT NULL) AS has_nut
    FROM products p WHERE p.is_active AND p.product_name IS NOT NULL`)).rows;
  const hasNut = new Map(prod.map((p) => [p.product_id, p.has_nut]));
  const products = prod.map((p) => ({ product_id: p.product_id, name: p.product_name, brand: p.brand, importer: p.manufacturer, category: p.food_type, quantity_g: toGram(p.total_content, p.content_unit) }));
  const t0 = Date.now(); const matches = resolveMatches(products, imports); const ms = Date.now() - t0;
  const strata = {}; for (const m of matches) { const k = m.decision + (m.reason ? ':' + m.reason : '') + '/' + (m.match_quality || 'null'); strata[k] = (strata[k] || 0) + 1; }
  const touched = new Set(matches.map((m) => m.product_id));
  const live = new Set(matches.filter((m) => m.decision !== 'reject').map((m) => m.product_id));
  let touchedNut = 0; for (const id of touched) if (hasNut.get(id)) touchedNut++;
  let net = 0, netSingle = 0; const per = new Map();
  for (const m of matches) if (m.decision !== 'reject') per.set(m.product_id, (per.get(m.product_id) || 0) + 1);
  for (const [id, n] of per) if (!hasNut.get(id)) { net++; if (n === 1) netSingle++; }
  const allNut = prod.filter((p) => p.has_nut).length;
  const qa = (await c.query(`SELECT count(*)::int n FROM import_nutrition WHERE food_cd = ANY($1)`, [imports.map((x) => x.food_cd)])).rows[0].n;
  const oldMatch = (await c.query(`SELECT decision, count(*)::int n, count(DISTINCT product_id)::int p FROM import_nutrition_product_match GROUP BY 1`)).rows;
  const sample = matches.filter((m) => m.decision !== 'reject' && !hasNut.get(m.product_id)).slice(0, 15).map((m) => ({ p: m.evidence.product_name, i: m.evidence.import_name, q: m.match_quality, n: m.candidate_count, nation: m.evidence.nation }));
  const res = {
    kfind_import_rows_with_kcal: imports.length, active_products: prod.length, matcher_ms: ms,
    QA_overlap_import_nutrition_food_cd: qa,
    match_rows: matches.length, strata,
    products_touched: touched.size, products_touched_with_nutrition: touchedNut,
    import_side_nutrition_rate: touched.size ? +(touchedNut / touched.size).toFixed(4) : null,
    overall_active_nutrition_rate: +(allNut / prod.length).toFixed(4),
    products_with_live_candidate: live.size,
    QB_net_new_candidates: net, QB_net_single_candidate: netSingle,
    D61_1: net >= 5000 ? '채택' : net >= 500 ? '보류' : '기각',
    old_match_table: oldMatch, sample,
  };
  console.log(JSON.stringify(res, null, 1));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
  c.release(); await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
