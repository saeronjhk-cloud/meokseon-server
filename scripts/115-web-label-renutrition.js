#!/usr/bin/env node
/**
 * 115-web-label-renutrition.js — ★ 세션81 판매처 라벨 영양 재계산(파서 수정 «열량에 붙은 1회분 기준 우선» 반영).
 *   정답 IP/eval_label_basis_anchor_v1 (A 두 칸 라벨 · B 묶음 라벨). 원문 = .tmp/s78/crawl_run1/ocr/rv_<site_item_no>/*.txt
 *   대상 ① web_label.nutrition_data(판매처 신규 품목) ② web_label.public_supplements axis 'nutrition'(public 제품 보충 · reviewed_by 없는 것만)
 *   규칙: 같은 원문을 102 와 «같은 함수»(webFromText)로 다시 계산 → 100g(㎖)당 값이 바뀌고(열량 1% 또는 1kcal 넘게) 상식 범위(sane)면 갱신.
 *         기존 값이 없던 품목은 건드리지 않는다(새로 채우기는 별도 결정) · 열량이 없어지는 방향(새 값 null)은 바꾸지 않는다.
 *   되돌리기: 적용 기록(before image) → --undo <batch>. 적용 후 104 게이트를 다시 돌린다(신호등·K-FIND 교차확인 재판정).
 * 사용(meokseon-server): node scripts/115-web-label-renutrition.js --ocr-dir ../.tmp/s78/crawl_run1/ocr [--apply] | --undo renut_<시각>
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch (_) { /* */ }
const fs = require('fs'); const path = require('path');
const { webFromText, sane } = require('./102-web-label-load');
const { consistent } = require('./lib/label_basis');
const KEYS = ['calories', 'total_fat', 'saturated_fat', 'trans_fat', 'cholesterol', 'sodium', 'total_carbs', 'total_sugars', 'protein'];
const LOGDIR = path.join(__dirname, '..', '..', 'IP', 'eval_label_basis_anchor_v1');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const num = (v) => (v == null || v === '' ? null : Number(v));

/** 순수: 현재 100g 값 cur{KEYS} + 원문 → null(그대로) | { next{KEYS}, label, why } */
function recompute(cur, text) {
  if (!text || !cur || num(cur.calories) == null) return null;
  const w = webFromText(text);
  if (!w || !w.per100 || w.per100.calories == null || !sane(w.per100)) return null;
  const a = num(cur.calories); const b = w.per100.calories;
  if (Math.abs(a - b) <= Math.max(1, 0.01 * Math.max(a, b))) return null;
  const next = {}; for (const k of KEYS) next[k] = w.per100[k] ?? null;
  return { next, label: w.label && consistent(w.label, next) ? w.label : null, basis: w.basis, basis_amount: w.basis_amount, from: a, to: b };
}

function readOcr(dir, no) {
  const d = path.join(dir, 'rv_' + no);
  try { return fs.readdirSync(d).filter((f) => f.endsWith('.txt')).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join('\n'); } catch (_) { return null; }
}

async function main() {
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    if (arg('--undo')) {
      const b = arg('--undo'); const f = path.join(LOGDIR, `apply_${b}.json`); const log = JSON.parse(fs.readFileSync(f, 'utf8'));
      await c.query('BEGIN');
      for (const r of log.products) await c.query(`update web_label.nutrition_data set ${KEYS.map((k, i) => `${k}=$${i + 2}`).join(',')}, label_basis=$${KEYS.length + 2}::jsonb where nutrition_id=$1`, [r.id, ...KEYS.map((k) => r.before[k] ?? null), r.before_label == null ? null : JSON.stringify(r.before_label)]);
      for (const r of log.supplements) await c.query(`update web_label.public_supplements set data=$2::jsonb, updated_at=now() where supplement_id=$1 and reviewed_by is null`, [r.id, JSON.stringify(r.before_data)]);
      await c.query('COMMIT'); console.log('↩ 되돌림', b, log.products.length, log.supplements.length, '→ 104 게이트 다시 실행할 것'); return;
    }
    const OCR = arg('--ocr-dir'); if (!OCR) throw new Error('--ocr-dir 필요');
    const W = (await c.query(`select n.nutrition_id id, n.product_id, n.label_basis, ${KEYS.map((k) => 'n.' + k).join(',')}, sp.site_item_no, p.product_name
        from web_label.nutrition_data n join web_label.source_pages sp on sp.product_id = n.product_id and sp.target_schema = 'web_label'
        join web_label.products p on p.product_id = n.product_id`)).rows;
    const S = (await c.query(`select s.supplement_id id, s.product_id, s.data, sp.site_item_no from web_label.public_supplements s
        join web_label.source_pages sp on sp.url = s.source_url where s.axis = 'nutrition' and s.reviewed_by is null`)).rows;
    const uP = []; const uS = [];
    for (const r of W) { const x = recompute(r, readOcr(OCR, r.site_item_no)); if (x) uP.push({ id: r.id, product_id: r.product_id, name: r.product_name, before: Object.fromEntries(KEYS.map((k) => [k, num(r[k])])), before_label: r.label_basis, ...x }); }
    for (const r of S) { const x = recompute(r.data, readOcr(OCR, r.site_item_no)); if (x) uS.push({ id: r.id, product_id: r.product_id, before_data: r.data, after_data: { ...r.data, ...x.next, ...(x.label ? { _label: x.label } : {}) }, ...x }); }
    console.log('재계산 대상: 판매처 품목', uP.length, '/', W.length, '· public 보충', uS.length, '/', S.length);
    for (const r of [...uP, ...uS].slice(0, 25)) console.log('  ', r.product_id, r.name || '', r.from, '→', r.to, r.basis, r.basis_amount || '');
    if (!process.argv.includes('--apply')) return;
    const batch = 'renut_' + new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    await c.query('BEGIN');
    for (const r of uP) await c.query(`update web_label.nutrition_data set ${KEYS.map((k, i) => `${k}=$${i + 2}`).join(',')}, label_basis=coalesce($${KEYS.length + 2}::jsonb, label_basis) where nutrition_id=$1`, [r.id, ...KEYS.map((k) => r.next[k]), r.label ? JSON.stringify(r.label) : null]);
    for (const r of uS) await c.query(`update web_label.public_supplements set data=$2::jsonb, updated_at=now() where supplement_id=$1 and reviewed_by is null`, [r.id, JSON.stringify(r.after_data)]);
    await c.query('COMMIT');
    fs.mkdirSync(LOGDIR, { recursive: true }); const f = path.join(LOGDIR, `apply_${batch}.json`);
    fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), batch, products: uP, supplements: uS }, null, 1));
    console.log('✅ 적용', batch, uP.length, uS.length, '→', f, '| 다음: 104 게이트 재실행');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); await pool.end(); }
}
if (require.main === module) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
module.exports = { recompute };
