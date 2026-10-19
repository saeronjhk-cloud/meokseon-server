#!/usr/bin/env node
/**
 * 116-ocr-report-no-backfill.js — ★ 세션82 결정 ⑧ 기존 사진 제보(contributions ocr_nutrition)에 서버 OCR 품목보고번호 채우기
 *   data.ocr_report_no 가 «없는» 행만 · 원문(data.ocr_raw_text)을 서버 파서(photoKfindSupplement.ocrReportNoFromText)로 재판독.
 *   ⚠ products.c005_report_no 무접촉(검색 가림 키) · 정답 IP/eval_photo_kfind_supplement_v1 S2.
 * 사용: node scripts/116-ocr-report-no-backfill.js            (미리보기 · 쓰기 없음)
 *       node scripts/116-ocr-report-no-backfill.js --apply    (적용 · 기록 ../IP/eval_photo_kfind_supplement_v1/apply_<batch>.json)
 *       node scripts/116-ocr-report-no-backfill.js --undo <batch>
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch (_) { /* */ }
const fs = require('fs'); const path = require('path');
const { ocrReportNoFromText } = require('../src/services/photoKfindSupplement');
const OUT = path.join(__dirname, '..', '..', 'IP', 'eval_photo_kfind_supplement_v1');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
(async () => {
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const undo = arg('--undo');
    if (undo) {
      const rec = JSON.parse(fs.readFileSync(path.join(OUT, `apply_${undo}.json`), 'utf8'));
      const ids = rec.rows.map((r) => r.contribution_id);
      const r = await pool.query(`UPDATE contributions SET data = data - 'ocr_report_no' - 'ocr_report_no_batch'
        WHERE contribution_id = ANY($1::bigint[]) AND data->>'ocr_report_no_batch' = $2`, [ids, undo]);
      console.log(`되돌림 ${r.rowCount}행 (${undo})`); return;
    }
    const rows = (await pool.query(`SELECT contribution_id, product_id, data->>'ocr_raw_text' AS t FROM contributions
      WHERE contribution_type = 'ocr_nutrition' AND NOT (data ? 'ocr_report_no') ORDER BY contribution_id`)).rows;
    const plan = rows.map((r) => ({ contribution_id: Number(r.contribution_id), product_id: r.product_id == null ? null : Number(r.product_id), ocr_report_no: ocrReportNoFromText(r.t || '') }));
    const withRn = plan.filter((p) => p.ocr_report_no);
    console.log(`대상 ${plan.length}행 · 번호 읽힘 ${withRn.length} · 없음 ${plan.length - withRn.length}`);
    for (const p of withRn) console.log(`  #${p.contribution_id} product ${p.product_id} → ${p.ocr_report_no}`);
    if (!process.argv.includes('--apply')) { console.log('미리보기(--apply 없음) — 쓰지 않았다'); return; }
    const batch = 'ocrrn_' + new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    // 번호가 없는 행에도 null 로 기록한다(«읽어 봤고 없었다» · 재실행 시 다시 안 건드림).
    let n = 0;
    for (const p of plan) {
      const r = await pool.query(`UPDATE contributions SET data = data || jsonb_build_object('ocr_report_no', $2::text, 'ocr_report_no_batch', $3::text)
        WHERE contribution_id = $1 AND NOT (data ? 'ocr_report_no')`, [p.contribution_id, p.ocr_report_no, batch]);
      n += r.rowCount;
    }
    fs.mkdirSync(OUT, { recursive: true });
    const f = path.join(OUT, `apply_${batch}.json`); fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), batch, updated: n, rows: plan }, null, 1));
    console.log(`적용 ${n}행 · batch ${batch} → ${f}`);
  } finally { await pool.end(); }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
