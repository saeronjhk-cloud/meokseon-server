#!/usr/bin/env node
/**
 * 106-eval-web-label-expose.js — ★ 세션79 U78-3 E1(검색 12) 운영 DB 평가. 정답: IP/eval_web_label_expose_v1/cases_v1.json (구현 전 고정)
 *   실제 앱(src/app)을 임시 포트로 띄워 GET /api/products/search 를 부른다(라우트·모델·DB 전부 실물).
 *   E1-07·08(숨김 시뮬레이션)은 트랜잭션 안에서 바꾸고 같은 연결로 검색한 뒤 ROLLBACK(운영 데이터 무변경).
 *   ⚠ 읽기 전용(시뮬레이션은 롤백). 결과 → IP/eval_web_label_expose_v1/e1_result_<시각>.json
 * 사용(meokseon-server): node scripts/106-eval-web-label-expose.js
 */
'use strict';
require('dotenv').config({ quiet: true });
const assert = require('assert'); const fs = require('fs'); const path = require('path'); const http = require('http');
const CASES = require('../tests/fixtures/web_label_expose_v1.json');
const app = require('../src/app'); const db = require('../src/config/database');
const webLabelModel = require('../src/models/webLabelModel'); const productModel = require('../src/models/productModel');

(async () => {
  const srv = http.createServer(app); await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
  const get = (q, offset) => new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${port}/api/products/search?q=${encodeURIComponent(q)}${offset ? `&offset=${offset}` : ''}`, (r) => {
      const ch = []; r.on('data', (c) => ch.push(c)); r.on('end', () => { try { res({ status: r.statusCode, body: JSON.parse(Buffer.concat(ch).toString('utf8')) }); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
  const results = []; let pass = 0;
  for (const c of CASES.E1_search_live) {
    const e = c.expect; const rec = { id: c.id, q: c.q };
    try {
      let web, pub;
      if (c.setup) {
        const cl = await db.pool.connect();
        try {
          await cl.query('BEGIN');
          if (c.id === 'E1-07') await cl.query(`update web_label.products set status='superseded' where product_id=307002`);
          if (c.id === 'E1-08') {
            const rn = (await cl.query(`select c005_report_no from public.products where is_active and c005_report_no ~ '^[0-9]{13,}$' limit 1`)).rows[0].c005_report_no;
            await cl.query(`update web_label.products set c005_report_no=$1 where product_id=307439`, [rn]);
          }
          web = (await webLabelModel.searchWebLabel(c.q, 10, cl));
          const before = await webLabelModel.searchWebLabel(c.q, 10);   // 다른 연결 = 바뀌기 전(대조: 원래는 나와야 한다)
          rec.control_contains = before.some((x) => e.web_excludes.includes(x.web_id));
          assert.ok(rec.control_contains, '대조군(변경 전)에서도 안 나온다 — 시뮬레이션이 의미 없음');
        } finally { await cl.query('ROLLBACK').catch(() => {}); cl.release(); }
      } else {
        const r = await get(c.q, c.offset); rec.status = r.status;
        const d = r.body.data || {}; pub = d.products || []; web = d.web_label_products || [];
        if (e.public_unchanged) { const direct = await productModel.searchByName(c.q, 20, c.offset || 0); assert.deepStrictEqual(JSON.parse(JSON.stringify(pub)), JSON.parse(JSON.stringify(direct)), 'products 배열이 모델 직접 결과와 다르다'); }
        if (e.public_empty) assert.strictEqual(pub.length, 0);
        if (e.public_nonempty) assert.ok(pub.length > 0, 'public 결과 없음');
        if (e.web_max) assert.ok(web.length <= e.web_max);
        if (e.every_web) for (const w of web) { assert.strictEqual(w.badge, CASES.badge); assert.strictEqual(w.barcode, null); assert.ok(Number.isInteger(w.web_id)); assert.strictEqual(w.source, 'web_label'); }
        if (e.every_web) assert.ok(web.length > 0, '모양 검사할 web 결과가 없다');
        rec.public_n = pub.length;
      }
      rec.web_ids = web.map((x) => x.web_id);
      if (e.web_contains) for (const id of e.web_contains) assert.ok(rec.web_ids.includes(id), `web 에 ${id} 없음`);
      if (e.web_excludes) for (const id of e.web_excludes) assert.ok(!rec.web_ids.includes(id), `web 에 ${id} 있음`);
      if (e.web_empty) assert.strictEqual(web.length, 0);
      rec.ok = true; pass++; console.log(`  ✅ ${c.id} ${c.q} (public ${rec.public_n ?? '-'} · web ${web.length})`);
    } catch (err) { rec.ok = false; rec.error = err.message; console.log(`  ❌ ${c.id} ${c.q} → ${err.message}`); }
    results.push(rec);
  }
  srv.close();
  const f = path.join(__dirname, '..', '..', 'IP', 'eval_web_label_expose_v1', `e1_result_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}.json`);
  fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), pass, total: results.length, results }, null, 1));
  console.log(`\n[E1 검색] ${pass}/${results.length} → ${f}`);
  await db.pool.end().catch(() => {}); process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
