/**
 * test_contributor_notify.js — 세션75f 제보자 «관리자 확인 결과» 메일 (옵트인 · 제이 결정 2026-10-04)
 * 지키는 것
 *   ① 승인 → 신청자(notify_result=true · 이메일 있음)에게만 · 같은 사람·같은 제품은 1통 · 미신청·이메일 없음은 0
 *   ② 같은 제품을 다시 승인해도 다시 안 간다(이번에 pending→approved 로 바뀐 제보만)
 *   ③ 반려 → «반영하지 못했어요» · 관리자 반려 사유(자유 입력)는 메일에 «없다»
 *   ④ 메일 발송이 터져도 승인 응답은 200 (관리자 흐름을 막지 않는다)
 *   ⑤ 메일 본문: 제품 화면·내가 보낸 제보 링크 · 반려 메일엔 제품 링크 없음 · 개인정보(바코드·이름 외) 없음
 * pglite + 000_baseline + 023~026 + 실제 adminRoutes(HTTP). 메일은 _setSender 로 가로챈다(Resend 미호출).
 * 실행: cross-env NODE_ENV=test node tests/test_contributor_notify.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const MIG = path.join(__dirname, '..', 'scripts', 'migrations');
const TOKEN = 'test-admin-token-s75f';
process.env.ADMIN_TOKEN = TOKEN;

let pass = 0, fail = 0; const failures = [];
async function t(name, fn) { try { await fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; failures.push({ name, message: e.stack || e.message }); console.log(`  ❌ ${name}\n     → ${e.message}`); } }

async function main() {
  console.log('\n══ 세션75f — 제보자 결과 메일 (옵트인) ══');
  let PGlite; try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { console.log('⏭  pglite 미설치'); process.exit(1); }
  const db = new PGlite();
  const chain = ['000_baseline.sql', ...fs.readdirSync(MIG).sort().filter((f) => /^(021|023|024|025|026)_.*\.sql$/.test(f))];
  for (const f of chain) await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
  const shim = {
    pool: null, query: (text, params) => db.query(text, params || []),
    transaction: async (cb) => { await db.exec('BEGIN'); try { const r = await cb({ query: (tx, p) => db.query(tx, p || []) }); await db.exec('COMMIT'); return r; } catch (e) { await db.exec('ROLLBACK'); throw e; } },
    healthCheck: async () => ({ status: 'healthy' }),
  };
  const dbPath = require.resolve('../src/config/database');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };
  const loggerPath = require.resolve('../src/config/logger');
  require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: { info() {}, warn() {}, error() {}, debug() {} } };

  const notify = require('../src/services/contributorNotify');
  const sent = [];
  let boom = false;
  notify._setSender(async (mail, to) => { if (boom) throw new Error('resend down'); sent.push({ mail, to }); return { sent: true }; });

  const express = require('express');
  const app = express(); app.use(express.json()); app.use('/api/admin', require('../src/routes/adminRoutes'));
  const server = await new Promise((res) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => res(s)); });
  const PORT = server.address().port;
  const call = (p, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/api/admin' + p, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN } },
      (res) => { let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: res.statusCode, body: j, raw: s }); }); });
    req.on('error', reject); req.write(data); req.end();
  });

  const user = async (email, uid) => Number((await db.query('INSERT INTO users (supabase_uid, email) VALUES ($1,$2) RETURNING user_id', [uid, email])).rows[0].user_id);
  const product = async (bc, name) => Number((await db.query(`INSERT INTO products (barcode, product_name, data_source) VALUES ($1,$2,'ocr_crowdsource') RETURNING product_id`, [bc, name])).rows[0].product_id);
  const contrib = async (pid, uid, notifyResult) => Number((await db.query(
    `INSERT INTO contributions (product_id, user_id, contribution_type, data, status) VALUES ($1,$2,'ocr_nutrition',$3,'pending') RETURNING contribution_id`,
    [pid, uid, JSON.stringify({ notify_result: notifyResult, device_id: 'SECRET_DEVICE', ocr_raw_text: 'SECRET_OCR' })])).rows[0].contribution_id);

  const uA = await user('A@Example.com', '3f1c2a5e-9b47-4d81-a2f3-6c0e5d8b1a24');
  const uB = await user('b@example.com', 'c4d9e7b1-2a68-4f30-9c5d-8b7a6e1f3d02');
  const uC = await user('c@example.com', '00000000-1111-4222-8333-999999999999');
  const uN = await user(null, '00000000-1111-4222-8333-999999999998');
  const P1 = await product('8801117001445', '지지미 김치전맛');
  await contrib(P1, uA, true); await contrib(P1, uB, false); await contrib(P1, uC, true); await contrib(P1, uC, true); await contrib(P1, uN, true);

  await t('① 승인 → 신청자만 · 사람당 1통 · 미신청·이메일 없음 제외', async () => {
    const r = await call(`/verify/${P1}`, { action: 'approve', reviewed_by: 'jay' });
    assert.ok(r.status === 200 || r.status === 409, r.raw);
    const to = sent.map((x) => x.to[0]).sort();
    assert.deepStrictEqual(to, ['a@example.com', 'c@example.com']);
    assert.ok(sent.every((x) => x.mail.subject.includes('반영됐어요') && x.mail.subject.includes('지지미 김치전맛')));
    const nb = (r.body.data || r.body.error && r.body.data || {}).contributor_notice || r.body.data?.contributor_notice;
    assert.deepStrictEqual(nb, { candidates: 2, sent: 2, skipped: 0 });
  });
  await t('⑤ 승인 메일: 제품 화면·내가 보낸 제보 링크 · 비밀값(device_id·OCR 원문) 없음', async () => {
    const m = sent[0].mail;
    assert.ok(m.html.includes('/scan?barcode=8801117001445') && m.html.includes('/scan/reports'));
    for (const s of ['SECRET_DEVICE', 'SECRET_OCR']) assert.ok(!m.html.includes(s) && !m.text.includes(s));
  });
  await t('② 같은 제품 재승인 → 추가 메일 0', async () => {
    const before = sent.length;
    await call(`/verify/${P1}`, { action: 'approve', reviewed_by: 'jay' });
    assert.strictEqual(sent.length, before);
  });
  await t('③ 반려 → «반영하지 못했어요» · 반려 사유 원문 없음 · 제품 링크 없음', async () => {
    const P2 = await product('8801052105031', '양념 쌈장');
    await contrib(P2, uA, true);
    sent.length = 0;
    const r = await call(`/verify/${P2}`, { action: 'reject', reviewed_by: 'jay', reject_reason: 'INTERNAL_NOTE 사진 엉망' });
    assert.strictEqual(r.status, 200, r.raw);
    assert.strictEqual(sent.length, 1);
    const m = sent[0].mail;
    assert.ok(m.subject.includes('반영하지 못했어요'));
    assert.ok(!m.html.includes('INTERNAL_NOTE') && !m.text.includes('INTERNAL_NOTE'), '관리자 메모가 메일에 샜다');
    assert.ok(!m.html.includes('/scan?barcode='), '반려인데 제품 링크가 있다');
  });
  await t('④ 메일 발송이 터져도 승인 응답은 막히지 않는다', async () => {
    const P3 = await product('8801000000099', '테스트 과자');
    await contrib(P3, uA, true);
    boom = true;
    const r = await call(`/verify/${P3}`, { action: 'approve', reviewed_by: 'jay' });
    boom = false;
    assert.ok(r.status === 200 || r.status === 409, r.raw);
    const st = (await db.query('SELECT status FROM contributions WHERE product_id=$1', [P3])).rows[0].status;
    assert.strictEqual(st, 'approved');
  });
  await t('buildContributorMail — APP_BASE_URL 반영 · 바코드 형식 아니면 제품 링크 없음', async () => {
    const m = notify.buildContributorMail({ productName: 'X', barcode: 'S68R_1', decision: 'approved' }, { APP_BASE_URL: 'https://example.test/' });
    assert.ok(!m.html.includes('/scan?barcode=')); assert.ok(m.html.includes('https://example.test/scan/reports'));
  });

  server.close();
  console.log(`\n 통과 ${pass} · 실패 ${fail}`);
  for (const f of failures) console.log(`  - ${f.name}\n${f.message}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('러너 오류:', e); process.exit(1); });
