/**
 * ★ 세션72d — 관리자 접근(로그인 관리자) + 제보 알림 메일 (제이 결정 2026-09-30)
 *   §1 adminNotify 순수 함수 — 제목·본문·수신자 · 개인정보 없음
 *   §2 묶음 발송기 — 창 안 첫 건 즉시 · 이어진 건은 창 끝에 1통 · 실패해도 throw 없음 · 키 없으면 미발송
 *   §3 Resend 요청 모양(가짜 fetch)
 *   §4 requireAdmin — ADMIN_TOKEN(종전) · Supabase 로그인 이메일 ∈ ADMIN_EMAILS → 200 · 아니면 403 · 익명 403 · 깨진 토큰 401 · 미설정 503
 */
const assert = require('assert');
const http = require('http');
let pass = 0, fail = 0; const fails = [];
async function t(name, fn) { try { await fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; fails.push(name); console.log(`  ❌ ${name}\n     → ${e.message.split('\n')[0]}`); } }

// DB·로거 shim (adminRoutes 가 끌고 오는 모듈이 실제 Pool 을 만들지 않게)
const dbPath = require.resolve('../src/config/database');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: async () => ({ rows: [] }), transaction: async (cb) => cb({ query: async () => ({ rows: [] }) }), pool: null } };
const logPath = require.resolve('../src/config/logger');
const logs = [];
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m]), debug: () => {} } };

const N = require('../src/services/adminNotify');

(async () => {
  console.log('\n── §1 순수 함수 ──');
  const one = { productId: 1, barcode: '880', productName: '하루단백<쫀쿠>', isNewProduct: true, pendingAxes: ['nutrition', 'ingredients'], allergenAutoApplied: true };
  await t('§1-0 사유 코드 → 한국어 · 자동반영 없으면 각주 없음 (72e)', () => {
    const m = N.buildMail([{ ...one, allergenAutoApplied: false, allergenAutoReason: 'RESIDUE' }], {});
    assert.ok(!m.html.includes('RESIDUE') && m.html.includes('판독 불명'), m.html);
    assert.ok(!m.html.includes('미검증'), '자동반영 0건인데 각주');
    assert.ok(N.buildMail([one], {}).html.includes('미검증'), '자동반영 1건이면 각주');
    assert.strictEqual(N.reasonKo('AUTO_APPLY_FAILED:x'), '보류 · AUTO_APPLY_FAILED:x');
    assert.strictEqual(N.reasonKo(null), '-');
  });
  await t('§1-1 1건 제목에 제품명 + 자동반영 표시 · HTML 이스케이프', () => {
    const m = N.buildMail([one], { ADMIN_PAGE_URL: 'https://x/admin' });
    assert.ok(m.subject.includes('하루단백<쫀쿠>') && m.subject.includes('자동반영'));
    assert.ok(m.html.includes('하루단백&lt;쫀쿠&gt;') && !m.html.includes('<쫀쿠>'));
    assert.ok(m.html.includes('영양·원재료') && m.html.includes('https://x/admin'));
  });
  await t('§1-2 여러 건 제목은 건수', () => {
    assert.ok(N.buildMail([one, { ...one, allergenAutoApplied: false }], {}).subject.includes('2건'));
  });
  await t('§1-3 개인정보 키(device_id·user_id·ocr)가 본문에 없다', () => {
    const m = N.buildMail([{ ...one, deviceId: 'DEV-SECRET', userId: 99, ocrText: 'RAW-OCR' }], {});
    for (const s of ['DEV-SECRET', 'RAW-OCR']) assert.ok(!m.html.includes(s) && !m.text.includes(s));
  });
  await t('§1-4 수신자: ADMIN_NOTIFY_EMAILS 우선 · 없으면 ADMIN_EMAILS · 이상한 값 제거', () => {
    assert.deepStrictEqual(N.recipients({ ADMIN_NOTIFY_EMAILS: 'A@x.com, bad, b@y.io' }), ['a@x.com', 'b@y.io']);
    assert.deepStrictEqual(N.recipients({ ADMIN_EMAILS: 'saeronjhk@gmail.com' }), ['saeronjhk@gmail.com']);
  });

  console.log('\n── §2 묶음 발송기 ──');
  let clock = 1000000; const timers = []; const sent = [];
  const nf = N.createNotifier({
    env: { ADMIN_NOTIFY_EMAILS: 'a@x.com', ADMIN_NOTIFY_WINDOW_MS: '600000' },
    now: () => clock, setTimer: (fn, ms) => { timers.push({ fn, at: clock + ms }); return 1; },
    send: async (mail, to) => { sent.push({ mail, to }); return { sent: true }; },
  });
  await t('§2-1 첫 제보 → 즉시 1통', async () => { await nf.notify(one); assert.strictEqual(sent.length, 1); });
  await t('§2-2 10분 안 두 건 → 보내지 않고 모음 · 타이머 1개', async () => {
    clock += 60000; await nf.notify({ ...one, productName: 'B' });
    clock += 60000; await nf.notify({ ...one, productName: 'C' });
    assert.strictEqual(sent.length, 1); assert.strictEqual(timers.length, 1);
    assert.strictEqual(timers[0].at, 1000000 + 600000);
  });
  await t('§2-3 창 끝 → 모은 2건이 1통으로', async () => {
    clock = timers[0].at; await timers[0].fn(); await new Promise((r) => setImmediate(r));
    assert.strictEqual(sent.length, 2); assert.ok(sent[1].mail.subject.includes('2건'));
  });
  await t('§2-4 창이 지난 뒤 새 제보 → 다시 즉시', async () => {
    clock += 700000; await nf.notify({ ...one, productName: 'D' }); assert.strictEqual(sent.length, 3);
  });
  await t('§2-5 발송이 throw 해도 notify 는 throw 하지 않는다', async () => {
    const bad = N.createNotifier({ env: {}, now: () => 0, send: async () => { throw new Error('boom'); } });
    const r = await bad.notify(one); assert.strictEqual(r.sent, false);
  });
  await t('§2-6 RESEND_API_KEY 없으면 미발송(NO_RESEND_API_KEY) · 경고 로그', async () => {
    const r = await N.sendViaResend(N.buildMail([one], {}), ['a@x.com'], {}, async () => { throw new Error('호출되면 안 됨'); });
    assert.strictEqual(r.reason, 'NO_RESEND_API_KEY');
  });

  console.log('\n── §3 Resend 요청 모양 ──');
  await t('§3-1 POST api.resend.com/emails · Bearer 키 · to 배열 · 기본 발신자(인증 도메인 send.nutriformula.co.kr)', async () => {
    let got = null;
    const r = await N.sendViaResend({ subject: 's', html: 'h', text: 't' }, ['a@x.com'], { RESEND_API_KEY: 'k' },
      async (url, init) => { got = { url, init }; return { ok: true }; });
    assert.strictEqual(r.sent, true); assert.strictEqual(got.url, 'https://api.resend.com/emails');
    assert.strictEqual(got.init.headers.Authorization, 'Bearer k');
    const b = JSON.parse(got.init.body); assert.deepStrictEqual(b.to, ['a@x.com']); assert.ok(/noreply@send\.nutriformula\.co\.kr/.test(b.from));
  });
  await t('§3-2 HTTP 실패는 sent:false + 상태코드', async () => {
    const r = await N.sendViaResend({ subject: 's', html: 'h', text: 't' }, ['a@x.com'], { RESEND_API_KEY: 'k' }, async () => ({ ok: false, status: 403, text: async () => 'domain' }));
    assert.strictEqual(r.reason, 'HTTP_403');
  });

  console.log('\n── §4 requireAdmin ──');
  const { SignJWT } = require('jose');
  const SECRET = 's72d-test-secret-0123456789abcdef0123456789';
  const tok = (claims) => new SignJWT({ role: 'authenticated', ...claims }).setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub || 'uid-1').setExpirationTime('10m').sign(new TextEncoder().encode(SECRET));
  const express = require('express');
  const app = express(); app.use(express.json()); app.use('/api/admin', require('../src/routes/adminRoutes'));
  const server = app.listen(0); const port = server.address().port;
  const who = (bearer) => new Promise((resolve, reject) => {
    const rq = http.request({ hostname: '127.0.0.1', port, path: '/api/admin/whoami', headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }));
    }); rq.on('error', reject); rq.end();
  });
  const envSet = (o) => { for (const k of ['ADMIN_TOKEN', 'ADMIN_EMAILS', 'SUPABASE_JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_PROJECT_REF']) delete process.env[k]; Object.assign(process.env, o); };

  await t('§4-1 아무 설정 없음 → 503 ADMIN_NOT_CONFIGURED', async () => { envSet({}); const r = await who('x'); assert.strictEqual(r.status, 503); assert.strictEqual(r.body.error.code, 'ADMIN_NOT_CONFIGURED'); });
  await t('§4-2 ADMIN_TOKEN(종전) → 200 via token', async () => { envSet({ ADMIN_TOKEN: 'TOK' }); const r = await who('TOK'); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.data.via, 'token'); });
  await t('§4-3 ADMIN_TOKEN 만 있고 틀린 값 → 401', async () => { envSet({ ADMIN_TOKEN: 'TOK' }); assert.strictEqual((await who('NOPE')).status, 401); });
  await t('§4-4 관리자 이메일 로그인 → 200 via supabase + email', async () => {
    envSet({ ADMIN_EMAILS: 'SaeronJHK@gmail.com', SUPABASE_JWT_SECRET: SECRET });
    const r = await who(await tok({ email: 'saeronjhk@gmail.com' }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.data.email, 'saeronjhk@gmail.com');
  });
  await t('§4-5 ★ 일반 사용자 로그인 → 403 ADMIN_FORBIDDEN', async () => {
    envSet({ ADMIN_EMAILS: 'saeronjhk@gmail.com', SUPABASE_JWT_SECRET: SECRET });
    const r = await who(await tok({ email: 'someone@else.com' })); assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error.code, 'ADMIN_FORBIDDEN');
  });
  await t('§4-6 ★ 익명 로그인은 이메일이 맞아도 403', async () => {
    envSet({ ADMIN_EMAILS: 'saeronjhk@gmail.com', SUPABASE_JWT_SECRET: SECRET });
    const r = await who(await tok({ email: 'saeronjhk@gmail.com', is_anonymous: true })); assert.strictEqual(r.status, 403);
  });
  await t('§4-7 토큰 없음 → 401 · 알고리즘 불명 토큰은 ES256 설정(SUPABASE_URL) 없으면 503(통과시키지 않음)', async () => {
    envSet({ ADMIN_EMAILS: 'saeronjhk@gmail.com', SUPABASE_JWT_SECRET: SECRET });
    assert.strictEqual((await who(null)).status, 401);
    const r = await who('abc.def.ghi'); assert.strictEqual(r.status, 503); assert.strictEqual(r.body.error.code, 'ADMIN_AUTH_UNAVAILABLE');
  });
  await t('§4-8 다른 비밀키로 서명한 «관리자 이메일» 토큰 → 401(위조 차단)', async () => {
    envSet({ ADMIN_EMAILS: 'saeronjhk@gmail.com', SUPABASE_JWT_SECRET: SECRET });
    const forged = await new SignJWT({ role: 'authenticated', email: 'saeronjhk@gmail.com' }).setProtectedHeader({ alg: 'HS256' })
      .setSubject('x').setExpirationTime('10m').sign(new TextEncoder().encode('other-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxxx'));
    assert.strictEqual((await who(forged)).status, 401);
  });
  server.close();
  console.log(`\n════ 통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
