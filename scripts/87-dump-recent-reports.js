/**
 * 87-dump-recent-reports.js — 최근 사진 제보의 «읽은 그대로» 덤프 (읽기 전용)  세션75d 2026-10-04
 *   제이 실물 제보(10-04 슈퍼마켓)에서 «산화방지제 등이 첨가물로 안 잡힌다» 진단용.
 *   contributions.data 의 OCR 원문·원재료 원문·파싱 원재료·검출 첨가물·알레르기를 그대로 옮긴다(수정 0).
 * 실행 (제이 PC): node scripts/87-dump-recent-reports.js            ← 오늘(KST) 이후
 *                 node scripts/87-dump-recent-reports.js --since 2026-09-29
 * 출력: backends/먹선/.tmp/s75/87_reports_<since>.json + 화면에 제품별 한 줄
 * ⚠ 개인정보: user_id·device_id 는 꺼내지 않는다. 사진 바이트도 꺼내지 않는다.
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* */ }
const fs = require('fs'); const path = require('path');
const { Pool } = require('pg');
const i = process.argv.indexOf('--since');
const kstToday = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const SINCE = i > -1 ? process.argv[i + 1] : kstToday;
if (!/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) { console.error('ERR --since YYYY-MM-DD'); process.exit(1); }
const cfg = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } }
  : { host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT) || 5432, database: process.env.DB_NAME || 'meokseon', user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || '' };
Object.assign(cfg, { connectionTimeoutMillis: 25000, statement_timeout: 120000, options: '-c default_transaction_read_only=on' });
const pool = new Pool(cfg);
(async () => {
  const ro = (await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only;
  if (ro !== 'on') throw new Error('읽기 전용 아님 — 중단');
  const r = await pool.query(`
    SELECT c.contribution_id, c.created_at, c.status, c.contribution_type, c.product_id, p.barcode, p.product_name,
           c.data->'user_input'->>'ingredients_text' AS ingredients_text,
           c.data->'parsed_ingredients' AS parsed_ingredients,
           c.data->'additives' AS additives,
           c.data->'allergens_v2' AS allergens_v2,
           c.data->>'nutrition_status' AS nutrition_status,
           c.data->>'ocr_raw_text' AS ocr_raw_text
    FROM contributions c LEFT JOIN products p ON p.product_id = c.product_id
    WHERE c.created_at >= ($1::date - interval '9 hours')
    ORDER BY c.created_at`, [SINCE]);
  const out = r.rows.map((x) => ({ ...x, n_parsed: Array.isArray(x.parsed_ingredients) ? x.parsed_ingredients.length : null,
    additive_names: Array.isArray(x.additives) ? x.additives.map((a) => (typeof a === 'string' ? a : a?.name || a?.detected_name || a?.matched_name)).filter(Boolean) : null }));
  for (const x of out) console.log(`#${x.contribution_id} ${x.barcode || '-'} ${x.product_name || '-'} | 원재료 ${x.n_parsed ?? '?'}개 · 첨가물 ${x.additive_names ? x.additive_names.length : '?'}개 · 원문 ${x.ingredients_text ? x.ingredients_text.length : 0}자`);
  const dir = path.resolve(__dirname, '../../.tmp/s75'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `87_reports_${SINCE}.json`); fs.writeFileSync(f, JSON.stringify(out, null, 1));
  console.log(`\n${out.length}건 저장: ${f}`);
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); pool.end(); process.exit(1); });
