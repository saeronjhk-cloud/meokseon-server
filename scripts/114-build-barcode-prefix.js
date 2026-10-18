#!/usr/bin/env node
/**
 * 114-build-barcode-prefix.js — ★ 세션81 업체 바코드 대역 표(880 + 업체코드 → 알려진 제조사 키). 사용자 바코드 연결 R7 의 근거.
 *   --offline : 로컬 파일(.tmp/s75 c005 members CSV + .tmp/s79 HACCP 덤프)에서 만든다(DB 없음 · v1).
 *   (기본)    : 운영 public.products(바코드·manufacturer) + HACCP 덤프에서 만든다(DATABASE_URL · 읽기 전용).
 *   출력: ../IP/barcode_prefix_v1/prefix_table.json (정본) → src/data/barcode_prefix.json (사본 · 런타임이 읽음)
 *   제조사 키 = userBarcodeGate.makerKey (같은 함수 · 복제 금지). 대역당 최대 30개 — 넘으면 공용 대역 ['*'](판정 불가 = unknown · 잘린 목록으로 «다른 회사» 오판 금지).
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch (_) { /* */ }
const fs = require('fs'); const path = require('path');
const G = require('./lib/barcode_link_gate'); const { makerKey } = require('../src/services/userBarcodeGate');
const ROOT = path.join(__dirname, '..', '..');
const OUT_IP = path.join(ROOT, 'IP', 'barcode_prefix_v1', 'prefix_table.json');
const OUT_DATA = path.join(__dirname, '..', 'src', 'data', 'barcode_prefix.json');
const CAP = 30;

function csvRows(f) {
  const t = fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split('\n'); const h = t[0].split(',').map((x) => x.trim()); const out = [];
  for (let i = 1; i < t.length; i++) { if (!t[i]) continue; const c = []; let cur = ''; let q = false;
    for (const ch of t[i]) { if (ch === '"') { q = !q; continue; } if (ch === ',' && !q) { c.push(cur); cur = ''; continue; } cur += ch; }
    c.push(cur.replace(/\r$/, '')); const o = {}; h.forEach((k, j) => { o[k] = c[j]; }); out.push(o); }
  return out;
}
function build(pairs, meta) {
  const L9 = {}; const L8 = {}; let n = 0; const trunc = { 9: 0, 8: 0 };
  for (const [bc, m] of pairs) {
    if (!/^880\d{10}$/.test(bc) || !G.checksumOk(bc)) continue; const k = makerKey(m); if (k.length < 2) continue; n++;
    for (const [L, T] of [[9, L9], [8, L8]]) { const p = bc.slice(0, L); const a = T[p] || (T[p] = []); if (a[0] !== '*' && !a.includes(k)) { if (a.length < CAP) a.push(k); else { T[p] = ['*']; trunc[L]++; } } }
  }
  return { version: 'barcode_prefix_v1', built_at: new Date().toISOString(), ...meta, barcodes: n, prefixes9: Object.keys(L9).length, prefixes8: Object.keys(L8).length, cap: CAP, truncated: trunc, L9, L8 };
}
function haccpPairs() {
  const f = path.join(ROOT, '.tmp', 's79', 'haccp_v2', 'dump.ndjson'); const out = [];
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (!l) continue; let o; try { o = JSON.parse(l); } catch (_) { continue; } out.push([String(o.bc || '').replace(/\D/g, ''), o.mfr]); }
  return out;
}
async function main() {
  let pairs; let meta;
  if (process.argv.includes('--offline')) {
    const c = csvRows(path.join(ROOT, '.tmp', 's75', '90_c005_members_2026-10-05.csv')).flatMap((r) => [[String(r.barcode || '').replace(/\D/g, ''), r.manufacturer], [String(r.barcode || '').replace(/\D/g, ''), r.brand]]);   // 브랜드도 같은 대역의 회사 이름(세션81 실측: 판정 불가 52→32)
    pairs = [...c, ...haccpPairs()]; meta = { source: 'offline: .tmp/s75/90_c005_members_2026-10-05.csv + .tmp/s79/haccp_v2/dump.ndjson' };
  } else {
    const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try { const r = await pool.query(`select barcode, to_jsonb(p)->>'manufacturer' as manufacturer, to_jsonb(p)->>'brand' as brand from public.products p where barcode ~ '^880[0-9]{10}$'`);
      pairs = [...r.rows.flatMap((x) => [[x.barcode, x.manufacturer], [x.barcode, x.brand]]), ...haccpPairs()]; meta = { source: `db: public.products(${r.rowCount}) + .tmp/s79/haccp_v2/dump.ndjson` };
    } finally { await pool.end(); }
  }
  const t = build(pairs, meta);
  fs.mkdirSync(path.dirname(OUT_IP), { recursive: true }); fs.writeFileSync(OUT_IP, JSON.stringify(t)); fs.copyFileSync(OUT_IP, OUT_DATA);
  console.log('✅ 대역 표', t.source, '| 바코드', t.barcodes, '| 9자리', t.prefixes9, '| 8자리', t.prefixes8, '| 잘림', JSON.stringify(t.truncated), '|', (fs.statSync(OUT_IP).size / 1024).toFixed(0) + 'KB');
}
if (require.main === module) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
module.exports = { build };
