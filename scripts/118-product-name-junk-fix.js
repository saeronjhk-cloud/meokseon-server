#!/usr/bin/env node
/**
 * 118-product-name-junk-fix.js — ★ 세션83 사진 제보로 저장된 «라벨 잔해» 제품명 3건 바로잡기(정답 IP/eval_product_name_v1 · PN573 · PN579 · PN588).
 *   원인: 83e 이전 extractProductMeta 가 표 배치의 다음 라벨(«식품의 유형»)이나 OCR 잔해(«|»)를 이름으로 집었고 products.product_name 에 저장됨.
 *   이름 원문 근거: 307936 «|볶음땅콩» · 307942 «|유기농 아몬드 현미강정»(잔해 «|» 제거) · 307951 «식품의 유형» → 같은 제보 원문 첫 줄 «고단백그래놀라 검은콩 & 멀티그레인»(JAJU · 품목보고번호 20210382391136).
 *   «현재 값이 아래 before 와 정확히 같을 때만» 바꾼다(그 사이 관리자가 고쳤으면 건드리지 않음). 기록 → --undo.
 * 사용(meokseon-server): node scripts/118-product-name-junk-fix.js [--apply] | --undo pnfix_<시각>
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch (_) { /* */ }
const fs = require('fs'); const path = require('path');
const FIX = [
  { product_id: 307936, before: '|볶음땅콩', after: '볶음땅콩' },
  { product_id: 307942, before: '|유기농 아몬드 현미강정', after: '유기농 아몬드 현미강정' },
  { product_id: 307951, before: '식품의 유형', after: '고단백그래놀라 검은콩 & 멀티그레인' },
];
const LOGDIR = path.join(__dirname, '..', '..', 'IP', 'eval_product_name_v1');
(async () => {
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const ui = process.argv.indexOf('--undo');
    if (ui > 0) {
      const b = process.argv[ui + 1]; const log = JSON.parse(fs.readFileSync(path.join(LOGDIR, `apply_${b}.json`), 'utf8'));
      for (const r of log.applied) await pool.query('update products set product_name=$2, updated_at=now() where product_id=$1 and product_name=$3', [r.product_id, r.before, r.after]);
      console.log('↩ 되돌림', b, log.applied.length); return;
    }
    const cur = (await pool.query('select product_id, product_name from products where product_id = any($1)', [FIX.map((f) => f.product_id)])).rows;
    const plan = FIX.filter((f) => cur.some((c) => Number(c.product_id) === f.product_id && c.product_name === f.before));
    for (const f of FIX) console.log(plan.includes(f) ? '  바꿈' : '  건너뜀(현재 값 다름)', f.product_id, JSON.stringify(f.before), '→', JSON.stringify(f.after));
    if (!process.argv.includes('--apply')) return;
    const batch = 'pnfix_' + new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    for (const f of plan) await pool.query('update products set product_name=$2, updated_at=now() where product_id=$1 and product_name=$3', [f.product_id, f.after, f.before]);
    fs.mkdirSync(LOGDIR, { recursive: true }); fs.writeFileSync(path.join(LOGDIR, `apply_${batch}.json`), JSON.stringify({ at: new Date().toISOString(), batch, applied: plan }, null, 1));
    console.log('✅ 적용', batch, plan.length, '| 되돌리기 --undo', batch);
  } finally { await pool.end(); }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
