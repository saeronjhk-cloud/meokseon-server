#!/usr/bin/env node
/**
 * 108-haccp-barcode-dump.js — ★ 세션79 바코드 잇기(A 경로) — HACCP 인증제품 API 전량(품목보고번호·바코드·제품명·제조사·유형) 받기.
 *   23-haccp-full-dump 의 `d += c`(UTF-8 조각 깨짐 · 79a 원인) 대신 Buffer.concat. API 읽기 전용 · DB 무접촉.
 *   재개: --out 폴더의 ckpt.json(nextPage) · 기기 셸 160초 제한 → --max-sec 로 끊어서 여러 번.
 * 사용: node scripts/108-haccp-barcode-dump.js --out ../.tmp/s79/haccp_v2 [--max-sec 140]
 */
'use strict';
require('dotenv').config({ quiet: true });
const fs = require('fs'); const path = require('path'); const https = require('https');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out'); const MAX_SEC = +arg('--max-sec', 140); const ROWS = 100;
const KEY = process.env.DATA_GO_KR_KEY; if (!KEY || !OUT) { console.error('DATA_GO_KR_KEY · --out 필요'); process.exit(1); }
const BASE = 'https://apis.data.go.kr/B553748/CertImgListServiceV3/getCertImgListServiceV3';
const get = (page) => new Promise((res, rej) => {
  https.get(`${BASE}?ServiceKey=${encodeURIComponent(KEY)}&returnType=json&pageNo=${page}&numOfRows=${ROWS}`, { timeout: 30000 }, (r) => {
    const ch = []; r.on('data', (c) => ch.push(c)); r.on('end', () => { try { res(JSON.parse(Buffer.concat(ch).toString('utf8'))); } catch (e) { rej(new Error('JSON ' + Buffer.concat(ch).toString('utf8').slice(0, 100))); } });
  }).on('error', rej).on('timeout', function () { this.destroy(new Error('timeout')); });
});
const items = (j) => { const it = j && j.body && j.body.items; if (!it) return []; const a = Array.isArray(it) ? it : (Array.isArray(it.item) ? it.item : (it.item ? [it.item] : [])); return a.map((x) => x.item || x); };
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const ck = path.join(OUT, 'ckpt.json'); const nd = path.join(OUT, 'dump.ndjson');
  const c = fs.existsSync(ck) ? JSON.parse(fs.readFileSync(ck, 'utf8')) : { nextPage: 1, total: null, fetched: 0, started_at: new Date().toISOString() };
  const t0 = Date.now();
  while (c.total === null || (c.nextPage - 1) * ROWS < c.total) {
    if ((Date.now() - t0) / 1000 > MAX_SEC) break;
    let j; try { j = await get(c.nextPage); } catch (e) { console.log('오류', c.nextPage, e.message); break; }
    if (c.total === null) c.total = +(j.body && j.body.totalCount) || 0;
    const a = items(j);
    fs.appendFileSync(nd, a.map((x) => JSON.stringify({ reportNo: x.prdlstReportNo || null, nm: x.prdlstNm || null, bc: x.barcode || null, mfr: x.manufacture || null, kind: x.prdkind || null, state: x.prdkindstate || null })).join('\n') + (a.length ? '\n' : ''));
    c.fetched += a.length; c.nextPage++; c.updated_at = new Date().toISOString();
    fs.writeFileSync(ck, JSON.stringify(c, null, 1));
  }
  const done = c.total !== null && (c.nextPage - 1) * ROWS >= c.total;
  console.log(`${done ? '완료' : '이어서'} · page ${c.nextPage - 1}/${Math.ceil((c.total || 0) / ROWS)} · 행 ${c.fetched}/${c.total}`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
