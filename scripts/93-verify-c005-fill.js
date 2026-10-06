/**
 * 93-verify-c005-fill.js — 91 배치가 실제 화면 경로(resolved 뷰)에 반영됐는지 확인 (읽기 전용)  세션75i 2026-10-06
 * 실행: node scripts/93-verify-c005-fill.js <batch_id> [<batch_id> …]
 *   영양: audit(c005_fill_profile).after_json.targets 각각이 product_nutrition_resolved 에서 is_inherited=true · resolved_source='entity_profile' 인가
 *   원재료: audit(c005_fill_ingredient) 의 product_id 에 source='c005_sibling' 행이 있는가
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* */ }
const { Pool } = require('pg');
const cfg = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } }
  : { host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT) || 5432, database: process.env.DB_NAME || 'meokseon', user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || '' };
Object.assign(cfg, { connectionTimeoutMillis: 25000, statement_timeout: 120000, options: '-c default_transaction_read_only=on' });
(async () => {
  const batches = process.argv.slice(2);
  if (!batches.length) throw new Error('배치 id 를 주세요');
  const pool = new Pool(cfg);
  try {
    const ro = (await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only;
    if (ro !== 'on') throw new Error('읽기 전용 아님 — 중단');
    for (const b of batches) {
      const au = (await pool.query(`SELECT action, product_id, after_json, undone_at FROM product_entity_audit WHERE eval_version = $1`, [b])).rows;
      const nutT = [...new Set(au.filter((a) => a.action === 'c005_fill_profile').flatMap((a) => (a.after_json && a.after_json.targets) || []).map(Number))];
      const ingT = au.filter((a) => a.action === 'c005_fill_ingredient').map((a) => Number(a.product_id));
      const rv = (await pool.query(`SELECT product_id, is_inherited, resolved_source, calories FROM product_nutrition_resolved WHERE product_id = ANY($1::bigint[])`, [nutT])).rows;
      const okN = rv.filter((r) => r.is_inherited && r.resolved_source === 'entity_profile' && r.calories != null).length;
      const notN = rv.filter((r) => !(r.is_inherited && r.resolved_source === 'entity_profile')).slice(0, 5).map((r) => `${r.product_id}:${r.resolved_source}`);
      const ig = (await pool.query(`SELECT count(DISTINCT product_id)::int AS n FROM product_ingredients WHERE product_id = ANY($1::bigint[]) AND source = 'c005_sibling'`, [ingT])).rows[0].n;
      console.log(`[${b}] audit ${au.length}(되돌림 ${au.filter((a) => a.undone_at).length}) · 영양 대상 ${nutT.length} → 화면 경로 상속 확인 ${okN}${notN.length ? ' · 예외 예: ' + notN.join(', ') : ''} · 원재료 대상 ${ingT.length} → 행 확인 ${ig}`);
    }
  } finally { await pool.end(); }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
