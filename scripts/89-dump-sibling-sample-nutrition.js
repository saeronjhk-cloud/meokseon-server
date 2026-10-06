/**
 * 89-dump-sibling-sample-nutrition.js — 형제 채움 표본 50쌍 중 «영양» 20쌍의 실제 값 (읽기 전용)  세션75h 2026-10-05
 * 입력: backends/먹선/.tmp/s75/89_input.json  [{no,target_id,sib_id}]  (Claude 가 표본 엑셀에서 뽑음)
 * 출력: backends/먹선/.tmp/s75/89_sample_nutrition.json — 형제(가져올 쪽)·대상(채울 쪽) 각각 영양 10칸 + 기준(serving_size) + 출처
 * 실행 (제이 PC · meokseon-server 폴더):  node scripts/89-dump-sibling-sample-nutrition.js
 * ⚠ 쓰기 없음 — 85/86 과 같은 읽기 전용 스타트업 파라미터 + SHOW 확인. SQL 은 86(실행 성공)과 같은 표·칸만 씀.
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* */ }
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } }
  : { host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'meokseon', user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || '' };
Object.assign(poolConfig, { connectionTimeoutMillis: 25000, statement_timeout: 120000, options: '-c default_transaction_read_only=on' });
const NUT_KEYS = ['calories','protein','total_fat','saturated_fat','trans_fat','cholesterol','sodium','total_carbs','total_sugars','dietary_fiber'];
const dir = path.join(__dirname, '..', '..', '.tmp', 's75');

async function main() {
  const pairs = JSON.parse(fs.readFileSync(path.join(dir, '89_input.json'), 'utf8'));
  const pool = new Pool(poolConfig);
  try {
    const ro = (await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only;
    if (ro !== 'on') throw new Error(`읽기 전용 아님(SHOW=${ro}) — 중단`);
    console.log(`[안전] default_transaction_read_only = ${ro}`);
    const ids = [...new Set(pairs.flatMap((p) => [p.target_id, p.sib_id]))];
    const nut = (await pool.query(
      `SELECT product_id, serving_size, resolved_source, ${NUT_KEYS.join(', ')} FROM product_nutrition_resolved WHERE product_id = ANY($1::bigint[])`, [ids])).rows;
    const prod = (await pool.query(
      `SELECT product_id, barcode, product_name FROM products WHERE product_id = ANY($1::bigint[])`, [ids])).rows;
    const byN = new Map(nut.map((r) => [String(r.product_id), r]));
    const byP = new Map(prod.map((r) => [String(r.product_id), r]));
    const out = pairs.map((p) => ({ ...p, target: { ...byP.get(String(p.target_id)), nutrition: byN.get(String(p.target_id)) || null },
      sib: { ...byP.get(String(p.sib_id)), nutrition: byN.get(String(p.sib_id)) || null } }));
    const f = path.join(dir, `89_sample_nutrition.json`);
    fs.writeFileSync(f, JSON.stringify(out, null, 1));
    console.log(`쌍 ${out.length} · 형제 영양 있음 ${out.filter((o) => o.sib.nutrition).length} · 대상 영양 있음(있으면 이상) ${out.filter((o) => o.target.nutrition).length}`);
    console.log(`저장: ${f}`);
  } finally { await pool.end(); }
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
