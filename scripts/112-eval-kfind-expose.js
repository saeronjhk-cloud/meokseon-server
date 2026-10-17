#!/usr/bin/env node
/**
 * 112-eval-kfind-expose.js — ★ 세션80 결정 80-1 · kfind 노출 운영 DB 평가 E01~E03. 정답 IP/eval_kfind_expose_v1/cases_v1.json(구현 전 고정)
 *   실제 앱(src/app)을 임시 포트로 띄워 /api/products/search · /api/products/kfind/:foodCd 를 부른다. 읽기 전용.
 *   결과 → IP/eval_kfind_expose_v1/eops_result_<시각>.json
 */
'use strict';
require('dotenv').config({ quiet: true });
const assert = require('assert'); const fs = require('fs'); const path = require('path'); const http = require('http');
const CASES = require('../tests/fixtures/kfind_expose_v1.json');
const app = require('../src/app'); const db = require('../src/config/database');
(async () => {
  const srv = http.createServer(app); await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
  const get = (u) => new Promise((res, rej) => http.get(`http://127.0.0.1:${port}${u}`, (r) => { const ch = []; r.on('data', (c) => ch.push(c)); r.on('end', () => { try { res({ status: r.statusCode, body: JSON.parse(Buffer.concat(ch).toString('utf8')) }); } catch (e) { rej(e); } }); }).on('error', rej));
  const S = (q) => get(`/api/products/search?q=${encodeURIComponent(q)}`);
  const out = []; let pass = 0, fail = 0;
  const t = async (id, fn) => { const rec = { id }; try { Object.assign(rec, await fn()); rec.ok = true; pass++; } catch (e) { rec.ok = false; rec.err = e.message; fail++; } out.push(rec); console.log(rec.ok ? '  ✅' : '  ❌', id, rec.err || ''); };
  await t('E01 힙스노말', async () => { const r = await S('힙스노말'); const k = r.body.data.kfind_products; assert.ok(k.length >= 1, 'kfind 0건'); assert.ok(k.every((x) => x.is_imported === true), '수입 아님 섞임'); assert.ok(Array.isArray(r.body.data.products) && Array.isArray(r.body.data.web_label_products)); return { n: k.length, names: k.map((x) => x.product_name) }; });
  await t('E02 우리밀 한입 스콘', async () => {
    const r = await S('우리밀 한입 스콘'); const k = r.body.data.kfind_products; const hit = k.find((x) => x.food_cd === 'P101-104000100-1203'); assert.ok(hit, '대상 없음: ' + k.map((x) => x.product_name).join('|'));
    assert.strictEqual(hit.badge, CASES.wording.badge); const d = await get('/api/products/kfind/P101-104000100-1203'); assert.strictEqual(d.status, 200);
    assert.strictEqual(d.body.data.kfind.source_label, CASES.wording.source_label); assert.strictEqual(d.body.data.allergens_available, false);
    return { n: k.length, detail_kcal: d.body.data.nutrition.calories, traffic: !!d.body.data.traffic_light, release: d.body.data.kfind.release_label };
  });
  await t('E03 무작위 검색어 20 → public 활성·web_label 노출과 품목보고번호 겹침 0', async () => {
    const qs = (await db.query(`select split_part(food_name,' ',1) q from kfind.products where status='active' and length(split_part(food_name,' ',1))>=2 order by md5(food_cd||'s80') limit 20`)).rows.map((x) => x.q);
    let total = 0, overlap = 0;
    for (const q of qs) {
      const r = await S(q); const ids = r.body.data.kfind_products.map((x) => x.food_cd); total += ids.length; if (!ids.length) continue;
      const o = (await db.query(`select count(*)::int n from kfind.products k where k.food_cd = any($1) and (exists(select 1 from public.products pp where pp.is_active and pp.c005_report_no=k.report_no) or exists(select 1 from web_label.products w where w.status in ('active','stale') and w.c005_report_no=k.report_no and not exists(select 1 from public.products p2 where p2.is_active and p2.c005_report_no=w.c005_report_no)))`, [ids])).rows[0].n;
      overlap += o;
    }
    assert.strictEqual(overlap, 0); assert.ok(total > 0, '결과 0'); return { queries: qs, results: total, overlap };
  });
  await t('E-route 잘못된 식품코드 400 · 없는 코드 404', async () => { const a = await get('/api/products/kfind/abc'); const b = await get('/api/products/kfind/P999-999999999-9999'); assert.strictEqual(a.status, 400); assert.strictEqual(b.status, 404); return {}; });
  const f = path.join(__dirname, '..', '..', 'IP', 'eval_kfind_expose_v1', `eops_result_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}.json`);
  fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), pass, fail, out }, null, 1)); console.log(`[kfind E_ops] ${pass}/${pass + fail} →`, f);
  srv.close(); await db.pool.end(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
