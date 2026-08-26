/**
 * test_supabase_auth.js — 세션64c «Supabase 인증 통합» 축 회귀
 * ============================================================================
 * 무엇을 지키는가 — 제이 확정(2026-08-24):
 *   「통합앱의 인증 방법으로 변경해야 해」 + 「Firebase → Supabase 전면 교체」 + 「제보도 로그인 필수」
 *
 *   ① 토큰 없음 401(AUTH_REQUIRED) · 위조 401 · 만료 401 · 알고리즘 위조 401 (전부 AUTH_INVALID)
 *   ② ★★★ **anon key 를 Bearer 로 보내면 거부된다** — Supabase 의 anon key 는 «같은 비밀로
 *      서명된 유효한 HS256 JWT» 이고 앱 번들에 박혀 나가는 공개 값이다. 서명만 검증하면
 *      아무나 로그인한 사람이 된다. 막는 것은 `sub` 필수 검사 하나뿐이다.
 *   ③ `users` UPSERT 가 **멱등**하다 — 같은 사람이 100번 제보해도 users 행은 1개다.
 *   ④ ★★★ `contributions.user_id` 가 **BIGINT 로 채워진다** — 종전에는 «항상 null» 이었다.
 *      supabase_uid(UUID 문자열)가 그 컬럼에 들어가면 [22P02] 로 죽거나 남의 행에 붙는다.
 *   ⑤ 「내 제보만」 보인다 — 남의 토큰으로는 내 이력이 안 나온다.
 *   ⑥ ★ 본문의 `user_id` 를 **믿지 않는다**(IDOR) — 남의 계정 번호를 적어도 내 것으로 저장된다.
 *   ⑦ 개인정보가 응답에 실리지 않는다.
 *   ⑧ ★ 제품 조회(`GET /api/products/*`)는 **무인증으로 통과한다** — 노션 §6·§9
 *      「무료·무인증 스캔 = 획득 훅」. 제이 지시는 «제보»에 대한 것이었다. 스캔을 막지 않는다.
 *   ⑨ 배포 순서가 어긋나도 **500 이 아니다** — 환경변수 미설정 503 / 021 미적용 503.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ★★★ 세션64c 후속(2026-08-26) — 이 파일의 «전제»가 바뀌었다
 *
 *   첫 판은 **HS256(대칭키)** 을 전제로 짜여 있었다. 그 전제가 틀렸다:
 *   근거로 쓴 표본이 **anon key** 였는데, anon key 는 프로젝트 API 키이지 사용자 세션
 *   토큰이 아니다. 실측(대시보드 Settings → JWT Keys 배너 「Legacy JWT secret has been
 *   migrated to new JWT Signing Keys」 · CURRENT KEY = ECC P-256 · 공개 JWKS 의
 *   `keys[0].alg = "ES256"`) 결과 **지금 발급되는 access token 은 ES256** 이다.
 *
 *   → 이 파일은 **삭제되지 않고 새 계약으로 옮겨졌다.**
 *     · `makeToken()` 의 기본이 HS256 → **ES256(+kid)** 으로 바뀌었다.
 *       그 위에 얹힌 §1~§5, §7 의 단정은 **한 글자도 바꾸지 않았다** — 지키는 성질이 같다.
 *     · 「위조」의 정의가 「다른 비밀」에서 **「JWKS 에 없는 개인키」**로 바뀌었다.
 *     · §2 의 anon key 단정은 그대로 두되, 이제 **폴백(HS256) 경로의 `sub` 방어**를 지킨다.
 *       폴백을 여는 것이 곧 anon-key 구멍을 다시 여는 일이라 오히려 더 중요해졌다.
 *     · §6 의 「SUPABASE_JWT_SECRET 미설정 → 503」은 **더 이상 참이 아니다**.
 *       비밀은 이제 «선택»이다 → 「둘 다 없을 때 503」 + 「비밀 없이 ES256 만으로 200」으로 갈랐다.
 *     · §8(신설) — ES256/폴백/JWKS 장애/alg 혼동/키 회전/URL 조립.
 *
 *   ⚠ **실제 Supabase 를 부르지 않는다.** 키 쌍을 이 파일 안에서 만들고
 *     (`crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })`),
 *     루프백에 **목 JWKS 서버**를 띄워 `SUPABASE_URL` 을 거기로 돌린다.
 *     서명은 `jsonwebtoken` 이, 검증은 `jose` 가 한다 — **서로 다른 라이브러리**다.
 *     같은 라이브러리로 서명하고 검증하면 그 라이브러리의 버그를 못 본다.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ★ 소스 문자열을 한 글자도 읽지 않는다. pglite(진짜 Postgres/wasm)에 `000_baseline.sql` +
 *   `021_supabase_auth.sql` 정본을 적용하고, 실제 라우터를 HTTP 로 불러 나온 응답과
 *   DB 에 실제로 박힌 행만 단정한다. (세션48 4차 검증: 소스 정규식 검사는 뚫렸다.)
 * ★★ Google Vision 을 부르지 않는다. `ocrService` 를 require.cache 에서 스텁으로 갈아끼운다.
 *
 * 실행: cross-env NODE_ENV=test node tests/test_supabase_auth.js
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
// ★ 정본 앱(`src/app.js:6`)이 하는 것과 같다. 없으면 라우트가 던진 비동기 에러가
//   errorHandler 로 안 가고 프로세스를 통째로 죽인다 — 500 검증이 불가능해진다.
require('express-async-errors');

const SRV = path.join(__dirname, '..');
const BASELINE = path.join(SRV, 'scripts', 'migrations', '000_baseline.sql');
const MIG_021 = path.join(SRV, 'scripts', 'migrations', '021_supabase_auth.sql');

// ★ 테스트 전용 비밀. 실제 값과 아무 관계 없다. (전환기 HS256 «폴백» 검증용)
const SECRET = 'test-supabase-jwt-secret-0123456789';
const OTHER_SECRET = 'someone-elses-secret-9876543210';
process.env.SUPABASE_JWT_SECRET = SECRET;

// ── ES256 키 쌍 · 목 JWKS ────────────────────────────────────────────────────
// ⚠ 실제 Supabase 를 부르지 않는다. 키를 여기서 만들고 루프백 서버로 내려준다.
//   kid 는 실제 CURRENT KEY ID 와 «모양»만 같게 둔다(값 자체는 아무 의미 없다).
const KID_CURRENT = 'd7edc63b-1b85-405a-a6cc-18891f96b6c5';
const KID_ROTATED = '9a2f4c10-77bd-4e52-8f31-05c6de91b3aa';
const KID_UNKNOWN = 'ffffffff-0000-4000-8000-000000000000';

function newEcKey(kid) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    kid,
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    // ★ 실제 Supabase JWKS 응답과 «같은 모양»으로 만든다(2026-08-25 실측):
    //   {"alg":"ES256","crv":"P-256","ext":true,"key_ops":["verify"],"kid":…,"kty":"EC","use":"sig","x":…,"y":…}
    jwk: { ...jwk, alg: 'ES256', use: 'sig', key_ops: ['verify'], ext: true, kid },
  };
}

const KEY_CURRENT = newEcKey(KID_CURRENT);   // JWKS 에 실려 있는 정상 키
const KEY_ROTATED = newEcKey(KID_ROTATED);   // 회전 «후» 키 — 처음엔 JWKS 에 없다
const KEY_ATTACKER = newEcKey(KID_UNKNOWN);  // JWKS 에 절대 없는 키 = 위조

/** 목 JWKS 서버가 지금 내려줄 키셋. 테스트가 중간에 바꾼다(키 회전 재현). */
let jwksBody = { keys: [KEY_CURRENT.jwk] };
/** 'ok' | 'error' — 'error' 면 500 을 준다(Supabase 장애·방화벽 재현). */
let jwksMode = 'ok';
/** 실제로 몇 번 나갔는지. 「매 요청마다 가져오지 않는다」를 이 숫자로 단정한다. */
let jwksHits = 0;

const jwksServer = http.createServer((req, res) => {
  if (req.url !== '/auth/v1/.well-known/jwks.json') {
    res.writeHead(404); res.end(); return;
  }
  jwksHits += 1;
  if (jwksMode === 'error') {
    res.writeHead(500, { 'content-type': 'text/plain' }); res.end('boom'); return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(jwksBody));
});

// 실제 Supabase user id 와 같은 모양(UUID)
const UID_A = '3f1c2a5e-9b47-4d81-a2f3-6c0e5d8b1a24';
const UID_B = 'c4d9e7b1-2a68-4f30-9c5d-8b7a6e1f3d02';
const DEV_A = '11111111-2222-4333-8444-555555555555';
const DEV_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let pass = 0;
let fail = 0;
const failures = [];

async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, message: e.stack || e.message });
    console.log(`  ❌ ${name}\n     → ${e.message}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

/**
 * 실제 Supabase access token 과 «같은 클레임 구조»로 만든다.
 * 근거: `web/node_modules/@supabase/auth-js@2.110.8/.../types.d.ts:1622` RequiredClaims
 *       { iss, sub, aud, exp, iat, role, aal, session_id } + 선택 { email, is_anonymous, … }
 *
 * ★★ 기본은 **ES256 + kid** 다 (2026-08-25 실측 — 위 파일 머리말 참조).
 *    `{ hs256: true }` 를 주면 **전환기 폴백**용 HS256 토큰이 나온다.
 *
 * @param {object} overrides 클레임 덮어쓰기. `undefined` 를 넣으면 그 클레임이 «빠진다».
 * @param {{ key?:object, kid?:string, hs256?:boolean, secret?:string }} opts
 *   key    서명에 쓸 EC 키(기본 KEY_CURRENT). `KEY_ATTACKER` 를 주면 위조가 된다.
 *   kid    헤더에 실을 kid. 키의 kid 와 «다르게» 줄 수 있다(서명 위조 시나리오).
 *   hs256  legacy 대칭키로 서명한다.
 *   secret hs256 일 때 쓸 비밀(기본 SECRET).
 */
function makeToken(overrides = {}, opts = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'https://lrnuqhpgyuizfggxgxpl.supabase.co/auth/v1',
    sub: UID_A,
    aud: 'authenticated',
    role: 'authenticated',
    aal: 'aal1',
    session_id: 'ffffffff-1111-4222-8333-444444444444',
    email: 'jay@example.com',
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];

  if (opts.hs256 || opts.secret) {
    return jwt.sign(payload, opts.secret || SECRET, { algorithm: 'HS256', noTimestamp: true });
  }
  const key = opts.key || KEY_CURRENT;
  return jwt.sign(payload, key.pem, {
    algorithm: 'ES256', noTimestamp: true, keyid: opts.kid || key.kid,
  });
}

const bearer = (tok) => ({ authorization: `Bearer ${tok}` });

const LABEL_WITH_NAME = [
  '제품명: 초코칩쿠키',
  '식품유형: 과자',
  '원재료명: 밀가루(밀:미국산), 설탕, 초콜릿가공품, 마가린, 정제수',
  '우유, 대두, 밀 함유',
  '내용량 120g',
].join('\n');

const NUTRITION_ONLY = [
  '영양성분 100g당', '열량 480kcal', '나트륨 300mg', '탄수화물 60g',
  '당류 25g', '지방 22g', '포화지방 12g', '트랜스지방 0g',
  '콜레스테롤 5mg', '단백질 6g',
].join('\n');

function buildMultipart(fields, files) {
  const boundary = '----meokseonS64cAuth' + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  }
  for (const [name, buf] of Object.entries(files)) {
    if (!buf) continue;
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}.jpg"\r\n`
      + 'Content-Type: image/jpeg\r\n\r\n', 'utf8'));
    chunks.push(buf);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(' 세션64c — Supabase 인증 통합 (Firebase → Supabase · 제보 로그인 필수)');
  console.log('════════════════════════════════════════════════════════════════');

  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (_) {
    console.log('⏭  pglite 미설치 — 인증→DB 경로를 검증할 수 없다 (npm i -D @electric-sql/pglite)');
    console.log('   ★ 이 테스트의 목적상 「건너뜀」은 「통과」가 아니다. EXIT=1 로 남긴다.');
    process.exit(1);
  }

  const baselineSql = fs.readFileSync(BASELINE, 'utf8');
  // ★ 021 은 마지막에 «검증용 SELECT» 가 붙어 있다. pglite 에서도 무해하므로 그대로 적용한다
  //   (정본 SQL 을 «가공해서» 적용하면 그 순간 이 테스트는 정본을 검증하지 않게 된다).
  const mig021Sql = fs.readFileSync(MIG_021, 'utf8');

  const pgReady = new PGlite();     // 000 + 021 적용 (정상 배포 상태)
  const pgNo021 = new PGlite();     // 000 만 적용 (021 미적용 = 배포 순서 어긋남)
  try {
    await pgReady.exec(baselineSql);
    await pgReady.exec(mig021Sql);
    await pgNo021.exec(baselineSql);
  } catch (e) {
    console.error(`마이그레이션 적용 실패 — 픽스처가 아니라 정본 SQL 문제다: ${e.message}`);
    process.exit(1);
  }

  // ★ 어느 DB 를 볼지 런타임에 바꾼다 — §6 이 「021 미적용 운영 DB」를 재현할 때 쓴다.
  let activePg = pgReady;
  const shim = {
    pool: {
      connect: async () => ({
        query: (text, params) => activePg.query(text, params || []),
        release: () => {},
      }),
    },
    query: (text, params) => activePg.query(text, params || []),
    transaction: async (cb) => {
      await activePg.exec('BEGIN');
      try {
        const r = await cb({ query: (tx, p) => activePg.query(tx, p || []) });
        await activePg.exec('COMMIT');
        return r;
      } catch (e) { await activePg.exec('ROLLBACK'); throw e; }
    },
    healthCheck: async () => ({ status: 'healthy' }),
  };
  const dbPath = require.resolve('../src/config/database');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };

  // ── Vision 스텁 (유료 API 를 절대 부르지 않는다) ────────────────────────
  const visionQueue = [];
  const ocrSvcPath = require.resolve('../src/services/ocrService');
  require.cache[ocrSvcPath] = {
    id: ocrSvcPath, filename: ocrSvcPath, loaded: true,
    exports: {
      callVisionAPI: async () => ({
        full_text: visionQueue.length ? visionQueue.shift() : '',
        avg_confidence: 0.95, block_count: 3, elapsed_ms: 1,
      }),
      correctOcrText: (txt) => ({ corrected: txt, corrections: [] }),
    },
  };

  // ── logger 스텁 ──
  const warnLog = [];
  const errorLog = [];
  const loggerPath = require.resolve('../src/config/logger');
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: {
      warn: (msg, meta) => { warnLog.push({ msg, meta }); },
      error: (msg, meta) => { errorLog.push({ msg, meta }); },
      info: () => {}, debug: () => {},
    },
  };

  // ── 목 JWKS 서버 기동 · SUPABASE_URL 조립 ────────────────────────────────
  // ★ 하드코딩된 URL 이 아니라 **환경변수에서 조립**하는지를 이 배선이 증명한다.
  //   `SUPABASE_URL` 만 주면 서버가 `/auth/v1/.well-known/jwks.json` 을 붙여야 한다.
  //   (평문 http 는 루프백에서만 허용된다 — 그것도 §8 에서 단정한다.)
  await new Promise((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const jwksPort = jwksServer.address().port;
  process.env.SUPABASE_URL = `http://127.0.0.1:${jwksPort}`;
  delete process.env.SUPABASE_PROJECT_REF;

  const jwksCache = require('../src/config/supabaseJwks');
  const { getJwksUrl } = require('../src/middleware/supabaseAuth');

  const express = require('express');
  const ocrRoutes = require('../src/routes/ocrRoutes');
  const contributionRoutes = require('../src/routes/contributionRoutes');
  const productRoutes = require('../src/routes/productRoutes');
  const { errorHandler } = require('../src/middleware/errorHandler');
  const db = require('../src/config/database');

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/ocr', ocrRoutes);
  app.use('/api/contributions', contributionRoutes);
  app.use('/api/products', productRoutes);
  app.use(errorHandler);
  const server = app.listen(0);
  const port = server.address().port;

  function request(method, urlPath, { headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
      const h = { ...headers };
      let payload = null;
      if (Buffer.isBuffer(body)) {
        payload = body;
        h['content-length'] = body.length;
      } else if (body !== null) {
        payload = Buffer.from(JSON.stringify(body), 'utf8');
        h['content-type'] = 'application/json';
        h['content-length'] = payload.length;
      }
      const req = http.request({ method, hostname: '127.0.0.1', port, path: urlPath, headers: h },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            let parsed = null;
            try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
            resolve({ status: res.statusCode, body: parsed, raw: data });
          });
        });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  const mine = (tok, qs = '') => request('GET', `/api/contributions/mine${qs}`,
    tok ? { headers: bearer(tok) } : {});

  async function callMultiPhoto({ token, barcode, deviceId, extraFields = {} }) {
    visionQueue.length = 0;
    visionQueue.push(LABEL_WITH_NAME, NUTRITION_ONLY);
    const files = { label_image: Buffer.from('fakejpeg-label'), nutrition_image: Buffer.from('fakejpeg-nut') };
    const fields = { save: 'false', ...extraFields };
    if (barcode !== undefined) fields.barcode = barcode;
    if (deviceId !== undefined) fields.device_id = deviceId;
    const { body, contentType } = buildMultipart(fields, files);
    const headers = { 'content-type': contentType };
    if (token) Object.assign(headers, bearer(token));
    return request('POST', '/api/ocr/multi-photo', { headers, body });
  }

  /** 1단계+2단계를 한 번에 — 제보 하나를 실제로 DB 에 박는다. */
  async function contribute({ token, barcode, deviceId, productName, confirmBody = {} }) {
    const r = await callMultiPhoto({ token, barcode, deviceId });
    assert.strictEqual(r.status, 200, `1단계 실패: ${r.status} ${JSON.stringify(r.body)}`);
    const c = await request('POST', '/api/ocr/confirm', {
      headers: token ? bearer(token) : {},
      body: {
        analysis_token: r.body.data.analysis_token,
        product_info: { product_name: productName, food_type: '과자' },
        device_id: deviceId,
        ...confirmBody,
      },
    });
    return c;
  }

  const TOKEN_A = makeToken({ sub: UID_A, email: 'jay@example.com' });
  const TOKEN_B = makeToken({ sub: UID_B, email: 'other@example.com' });

  // ══════════════════════════════════════════════════════════════════════════
  section('§1. 토큰 검증 — 401 의 «네 가지 얼굴»');
  // ══════════════════════════════════════════════════════════════════════════
  await t('★★★ 토큰이 없으면 401 AUTH_REQUIRED 다 (200 빈 목록이 아니다)', async () => {
    const r = await mine(null);
    assert.strictEqual(r.status, 401, `${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.success, false);
    assert.strictEqual(r.body.error.code, 'AUTH_REQUIRED');
    assert.ok(!r.body.data, '401 인데 data 가 실렸다 — 앱이 빈 목록으로 오독한다');
  });

  await t('Bearer 형식이 아니면 401 AUTH_REQUIRED 다', async () => {
    for (const h of [{ authorization: TOKEN_A }, { authorization: 'Basic abc' }, { authorization: 'Bearer' }, { authorization: 'Bearer    ' }]) {
      const r = await request('GET', '/api/contributions/mine', { headers: h });
      assert.strictEqual(r.status, 401, `${JSON.stringify(h)} → ${r.status}`);
      assert.strictEqual(r.body.error.code, 'AUTH_REQUIRED', JSON.stringify(r.body));
    }
  });

  await t('★★★ JWKS 에 없는 개인키로 서명한 «위조» 토큰은 401 AUTH_INVALID 다', async () => {
    // ⓐ kid 는 정상인 척하고 서명만 다른 키로 한 것 → 공개키 대조에서 서명이 깨진다.
    const forgedSameKid = makeToken({ sub: UID_A }, { key: KEY_ATTACKER, kid: KID_CURRENT });
    const a = await mine(forgedSameKid);
    assert.strictEqual(a.status, 401, `위조 토큰이 통과했다: ${a.status} ${JSON.stringify(a.body)}`);
    assert.strictEqual(a.body.error.code, 'AUTH_INVALID');

    // ⓑ 자기 kid 를 그대로 쓴 것 → JWKS 에 그런 키가 없다.
    const forgedOwnKid = makeToken({ sub: UID_A }, { key: KEY_ATTACKER });
    const b = await mine(forgedOwnKid);
    assert.strictEqual(b.status, 401, `모르는 kid 토큰이 통과했다: ${b.status} ${JSON.stringify(b.body)}`);
    assert.strictEqual(b.body.error.code, 'AUTH_INVALID');
  });

  await t('★★★ 다른 «비밀»로 서명한 HS256 위조 토큰도 401 이다 (폴백이 뚫리지 않는다)', async () => {
    const forged = makeToken({ sub: UID_A }, { secret: OTHER_SECRET });
    const r = await mine(forged);
    assert.strictEqual(r.status, 401, `위조 토큰이 통과했다: ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.error.code, 'AUTH_INVALID');
  });

  await t('★★★ 만료(exp)된 토큰은 401 이다 — 만료 검증이 꺼져 있지 않다', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = makeToken({ sub: UID_A, iat: now - 7200, exp: now - 3600 });
    const r = await mine(expired);
    assert.strictEqual(r.status, 401, `만료 토큰이 통과했다 — exp 검증이 꺼졌다: ${r.status}`);
    assert.strictEqual(r.body.error.code, 'AUTH_INVALID');
    const hit = warnLog.find((w) => w.meta?.reason === 'EXPIRED');
    assert.ok(hit, '만료를 «만료»로 로깅하지 않았다 — 운영에서 원인을 못 가린다');
  });

  await t('★★★ `alg: none`(서명 없는) 토큰은 401 이다 — 알고리즘 혼동 공격 차단', async () => {
    const payload = Buffer.from(JSON.stringify({
      sub: UID_A, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64url');
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const r = await mine(`${header}.${payload}.`);
    assert.strictEqual(r.status, 401, `서명 없는 토큰이 통과했다: ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.error.code, 'AUTH_INVALID');
  });

  await t('아무 문자열이나 401 이다 (500 이 아니다 — 파싱 예외가 새지 않는다)', async () => {
    for (const junk of ['abc', 'a.b.c', '.....', '<script>x</script>']) {
      const r = await mine(junk);
      assert.strictEqual(r.status, 401, `${JSON.stringify(junk)} → ${r.status} ${JSON.stringify(r.body)}`);
    }
  });

  await t('★ 401 사유는 앱이 그대로 보여줄 수 있는 한국어다 (기술 용어 금지)', async () => {
    const a = await mine(null);
    const b = await mine('abc');
    for (const r of [a, b]) {
      assert.ok(/[가-힣]/.test(r.body.error.message), `한국어 문장이 아니다: ${r.body.error.message}`);
      assert.ok(!/JWT|jwt|token|HS256|signature|null/i.test(r.body.error.message),
        `기술 용어가 사용자에게 나간다: ${r.body.error.message}`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§2. ★★★ anon key 를 로그인으로 인정하지 않는다');
  // ══════════════════════════════════════════════════════════════════════════
  // Supabase 의 anon key 는 **legacy JWT 비밀로 서명된 유효한 HS256 토큰**이고,
  // 앱 번들·웹 페이지 소스에 그대로 박혀 나가는 «공개» 값이다(web/.env.local 실측:
  // 헤더 {"alg":"HS256","typ":"JWT"}, 클레임 { iss:'supabase', ref, role:'anon', iat, exp }).
  // → 서명만 검증하면 **아무나 그 키를 Bearer 로 보내 로그인한 사람이 된다.**
  //   막는 것은 `sub` 필수 검사 하나뿐이다. 이 절이 그 한 줄을 지킨다.
  //
  // ⚠⚠ 세션64c 후속: **HS256 폴백을 되살린 것이 바로 이 구멍을 다시 여는 일이다.**
  //   그래서 이 절은 삭제되기는커녕 «더» 중요해졌다. 아래 두 단정은 폴백 경로를 겨눈다.
  //   ES256 경로에도 같은 방어가 걸려 있는지는 그 아래 두 건이 따로 본다.
  await t('★★★ anon key 모양(sub 없음, role=anon)은 401 이다 — HS256 폴백 경로', async () => {
    const anonKey = jwt.sign(
      { iss: 'supabase', ref: 'lrnuqhpgyuizfggxgxpl', role: 'anon', iat: 1, exp: 4102444800 },
      SECRET, { algorithm: 'HS256', noTimestamp: true }
    );
    const r = await mine(anonKey);
    assert.strictEqual(r.status, 401,
      `anon key 로 로그인이 됐다 — 공개 값이 자격증명이 된다: ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.error.code, 'AUTH_INVALID');
  });

  await t('★★★ service_role key 모양도 401 이다', async () => {
    const svc = jwt.sign(
      { iss: 'supabase', ref: 'lrnuqhpgyuizfggxgxpl', role: 'service_role', iat: 1, exp: 4102444800 },
      SECRET, { algorithm: 'HS256', noTimestamp: true }
    );
    const r = await mine(svc);
    assert.strictEqual(r.status, 401, `service_role key 로 로그인이 됐다: ${r.status}`);
  });

  await t('★★★ **ES256 경로에도** 같은 방어가 걸려 있다 — sub 없는 정상 서명은 401 이다', async () => {
    // ⚠ 「폴백에만 sub 검사가 있다」가 되면 주 경로가 통째로 뚫린다.
    //   같은 검사가 두 경로 «공통 자리»에 있는지를 여기서 본다.
    // ★ role 은 일부러 `authenticated` 로 둔다 — role 거름망에 걸려서 통과하는 것이 아니라
    //   **`sub` 검사 하나로** 막히는지를 보려는 것이다(그게 anon key 를 막는 실제 방어선이다).
    for (const role of ['authenticated', 'anon']) {
      const noSub = makeToken({ sub: undefined, role });   // 정상 ES256 서명 + sub 없음
      const r = await mine(noSub);
      assert.strictEqual(r.status, 401,
        `ES256 경로에 sub 검사가 없다(role=${role}) — 주 경로가 뚫렸다: ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.error.code, 'AUTH_INVALID');
    }
  });

  await t('★ ES256 경로에서도 role=service_role 은 401 이다', async () => {
    const r = await mine(makeToken({ sub: UID_A, role: 'service_role' }));
    assert.strictEqual(r.status, 401, `service_role 이 ES256 으로 통과했다: ${r.status}`);
  });

  await t('★ 서명은 맞지만 sub 가 빈 문자열이어도 401 이다', async () => {
    for (const sub of ['', '   ', undefined]) {
      const tok = makeToken({ sub });
      const r = await mine(tok);
      assert.strictEqual(r.status, 401, `sub=${JSON.stringify(sub)} 가 통과했다: ${r.status}`);
    }
  });

  await t('★ role 이 authenticated 가 «아니어도» sub 만 있으면 통과한다 (Custom Token Hook 대비)', async () => {
    // ⚠ 「authenticated 여야 한다」로 좁히면 Supabase 의 Custom Access Token Hook 을 쓰는
    //   순간 전원이 401 을 맞는다. 거부 목록(anon/service_role)만 두는 것이 설계다.
    const tok = makeToken({ sub: UID_A, role: 'premium_member' });
    const r = await mine(tok);
    assert.strictEqual(r.status, 200, `커스텀 role 이 막혔다: ${r.status} ${JSON.stringify(r.body)}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§3. 제보는 로그인 필수 — 그리고 user_id 가 «실제로» 채워진다');
  // ══════════════════════════════════════════════════════════════════════════
  await t('★★★ POST /api/ocr/multi-photo — 토큰 없으면 401 이다', async () => {
    const r = await callMultiPhoto({ token: null, barcode: '8801111111111', deviceId: DEV_A });
    assert.strictEqual(r.status, 401, `무인증 제보가 통과했다: ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.error.code, 'AUTH_REQUIRED');
  });

  await t('★★★ POST /api/ocr/confirm — 토큰 없으면 401 이다 (1단계만 막으면 뚫린다)', async () => {
    const ok = await callMultiPhoto({ token: TOKEN_A, barcode: '8801111111111', deviceId: DEV_A });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const c = await request('POST', '/api/ocr/confirm', {
      body: {
        analysis_token: ok.body.data.analysis_token,
        product_info: { product_name: '무인증쿠키', food_type: '과자' },
      },
    });
    assert.strictEqual(c.status, 401, `토큰 없이 확정 저장이 됐다: ${c.status} ${JSON.stringify(c.body)}`);
    assert.strictEqual(c.body.error.code, 'AUTH_REQUIRED');
    const row = await db.query("SELECT COUNT(*)::int AS c FROM contributions WHERE device_id IS NOT DISTINCT FROM $1", [DEV_A]);
    assert.strictEqual(row.rows[0].c, 0, '401 인데 제보가 저장됐다');
  });

  await t('★★★ 정상 인증 — 제보가 저장되고 users 행이 생긴다', async () => {
    const c = await contribute({
      token: TOKEN_A, barcode: '8801111111111', deviceId: DEV_A, productName: '초코칩쿠키',
    });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    assert.strictEqual(c.body.data.save_result.saved, true, c.body.data.save_result.rejectReason);

    const u = await db.query('SELECT user_id, supabase_uid, email FROM users WHERE supabase_uid = $1', [UID_A]);
    assert.strictEqual(u.rows.length, 1, `users 행이 ${u.rows.length}개다 — UPSERT 가 안 돌았다`);
    assert.strictEqual(u.rows[0].email, 'jay@example.com', '토큰의 email 이 저장되지 않았다');
  });

  await t('★★★ contributions.user_id 가 **BIGINT 로** 채워진다 (종전엔 항상 null 이었다)', async () => {
    const u = await db.query('SELECT user_id FROM users WHERE supabase_uid = $1', [UID_A]);
    const uid = Number(u.rows[0].user_id);
    assert.ok(Number.isInteger(uid) && uid > 0, `내부 user_id 가 정수가 아니다: ${u.rows[0].user_id}`);

    const c = await db.query(
      `SELECT c.user_id FROM contributions c
       JOIN products p ON p.product_id = c.product_id
       WHERE p.barcode = '8801111111111'`);
    assert.ok(c.rows.length >= 1, '제보가 저장되지 않았다');
    for (const row of c.rows) {
      assert.notStrictEqual(row.user_id, null,
        'contributions.user_id 가 여전히 null 이다 — 인증→user_id 배선이 끊겼다');
      assert.strictEqual(Number(row.user_id), uid,
        `user_id 가 내부 PK 가 아니다(${row.user_id}) — supabase_uid 를 그대로 넣었을 가능성`);
    }
  });

  await t('★★★ users UPSERT 는 «멱등»하다 — 같은 사람이 여러 번 제보해도 행은 1개', async () => {
    for (const [bc, nm] of [['8802222222222', '두번째쿠키'], ['8803333333333', '세번째쿠키']]) {
      const c = await contribute({ token: TOKEN_A, barcode: bc, deviceId: DEV_A, productName: nm });
      assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    }
    const u = await db.query('SELECT COUNT(*)::int AS c FROM users WHERE supabase_uid = $1', [UID_A]);
    assert.strictEqual(u.rows[0].c, 1, `users 행이 ${u.rows[0].c}개로 늘었다 — UPSERT 가 아니라 INSERT 다`);
  });

  await t('★ email 클레임이 없는 토큰이 기존 email 을 «지우지 않는다»', async () => {
    const noEmail = makeToken({ sub: UID_A, email: undefined });
    const c = await contribute({ token: noEmail, barcode: '8809999999999', deviceId: DEV_A, productName: '이메일없쿠키' });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    const u = await db.query('SELECT email FROM users WHERE supabase_uid = $1', [UID_A]);
    assert.strictEqual(u.rows[0].email, 'jay@example.com',
      'email 이 NULL 로 덮였다 — COALESCE 가 빠졌다(세션64b mergeService 와 같은 함정)');
  });

  await t('★★★ 본문의 `user_id` 를 «믿지 않는다» (IDOR) — 남의 번호를 적어도 내 것으로 저장된다', async () => {
    // 먼저 B 를 실제로 만들어 둔다(존재하는 남의 user_id 를 얻기 위해).
    const cB = await contribute({ token: TOKEN_B, barcode: '8804444444444', deviceId: DEV_B, productName: '비의쿠키' });
    assert.strictEqual(cB.status, 200, JSON.stringify(cB.body));
    const bId = Number((await db.query('SELECT user_id FROM users WHERE supabase_uid = $1', [UID_B])).rows[0].user_id);
    const aId = Number((await db.query('SELECT user_id FROM users WHERE supabase_uid = $1', [UID_A])).rows[0].user_id);
    assert.notStrictEqual(aId, bId);

    // A 의 토큰으로 제보하면서 본문에 B 의 user_id 를 박는다.
    const c = await contribute({
      token: TOKEN_A, barcode: '8805555555555', deviceId: DEV_A, productName: '아이도알쿠키',
      confirmBody: { user_id: bId },
    });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    const row = await db.query(
      `SELECT c.user_id FROM contributions c JOIN products p ON p.product_id = c.product_id
       WHERE p.barcode = '8805555555555'`);
    assert.strictEqual(Number(row.rows[0].user_id), aId,
      `본문의 user_id(${bId})가 토큰(${aId})을 이겼다 — 남의 계정 이름으로 제보가 저장된다`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§4. 내 제보 이력 — 「내 것만」 · device_id 뒷문 없음 · 개인정보 무유출');
  // ══════════════════════════════════════════════════════════════════════════
  await t('★★★ 내 제보만 나온다 — 남의 토큰으로는 내 것이 안 보인다', async () => {
    const a = await mine(TOKEN_A, '?limit=50');
    const b = await mine(TOKEN_B, '?limit=50');
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    assert.strictEqual(b.status, 200, JSON.stringify(b.body));
    const aBarcodes = a.body.data.items.map((x) => x.barcode);
    const bBarcodes = b.body.data.items.map((x) => x.barcode);
    assert.ok(aBarcodes.includes('8801111111111'), `A 의 제보가 A 목록에 없다: ${JSON.stringify(aBarcodes)}`);
    assert.ok(bBarcodes.includes('8804444444444'), `B 의 제보가 B 목록에 없다: ${JSON.stringify(bBarcodes)}`);
    assert.ok(!aBarcodes.includes('8804444444444'), 'B 의 제보가 A 목록에 섞였다 — 사용자 격리가 깨졌다');
    assert.ok(!bBarcodes.includes('8801111111111'), 'A 의 제보가 B 목록에 섞였다');
    const aIds = new Set(a.body.data.items.map((x) => x.contribution_id));
    for (const it of b.body.data.items) {
      assert.ok(!aIds.has(it.contribution_id), `제보 ${it.contribution_id} 가 양쪽에 나온다`);
    }
  });

  await t('★★★ `?device_id=` 뒷문이 «없다» — 남의 기기 값을 넣어도 내 목록만 나온다', async () => {
    // 종전 판(인증 없음)은 이 요청으로 DEV_B 의 이력을 그대로 내줬다. 그 문을 닫았다.
    const r = await mine(TOKEN_A, `?device_id=${DEV_B}&limit=50`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const barcodes = r.body.data.items.map((x) => x.barcode);
    assert.ok(!barcodes.includes('8804444444444'),
      `device_id 쿼리가 아직 먹는다 — 인증 우회 뒷문이 남아 있다: ${JSON.stringify(barcodes)}`);
    assert.ok(barcodes.includes('8801111111111'), 'device_id 쿼리가 내 목록을 오히려 망가뜨렸다');
  });

  await t('★★★ 가입한 적 없는 «정상» 토큰은 200 + 빈 목록이다 (401·404 가 아니다)', async () => {
    const fresh = makeToken({ sub: '00000000-1111-4222-8333-999999999999', email: 'nobody@example.com' });
    const r = await mine(fresh);
    assert.strictEqual(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
    assert.deepStrictEqual(r.body.data.items, []);
    assert.strictEqual(r.body.data.total, 0);
    assert.strictEqual(typeof r.body.data.total, 'number');
  });

  await t('★ GET /mine 은 users 행을 «만들지 않는다» (읽기가 쓰기를 하지 않는다)', async () => {
    const uid = '00000000-1111-4222-8333-999999999999';
    const u = await db.query('SELECT COUNT(*)::int AS c FROM users WHERE supabase_uid = $1', [uid]);
    assert.strictEqual(u.rows[0].c, 0,
      'GET 요청이 users 행을 만들었다 — 토큰만 있으면 누구나 users 를 부풀릴 수 있다');
  });

  await t('★★★ 응답에 개인정보가 «한 글자도» 없다', async () => {
    const r = await mine(TOKEN_A, '?limit=50');
    for (const leak of ['ocr_raw_text', 'user_input', 'avg_confidence', 'device_id',
      DEV_A, DEV_B, UID_A, UID_B, 'jay@example.com', 'supabase_uid', 'user_id']) {
      assert.ok(!r.raw.includes(leak), `응답에 «${leak}» 가 실렸다`);
    }
  });

  await t('★ 각 항목의 키가 «계약된 7개»뿐이다', async () => {
    const r = await mine(TOKEN_A, '?limit=50');
    const allowed = new Set(['contribution_id', 'created_at', 'barcode', 'product_name',
      'status', 'nutrition_status', 'product_id']);
    assert.ok(r.body.data.items.length > 0, '항목이 없어 검사가 무의미하다');
    for (const it of r.body.data.items) {
      for (const k of Object.keys(it)) {
        assert.ok(allowed.has(k), `계약에 없는 키가 나갔다: \`${k}\` = ${JSON.stringify(it[k])}`);
      }
      assert.strictEqual(typeof it.contribution_id, 'number', 'contribution_id 가 숫자가 아니다');
    }
  });

  await t('페이징 상한(50)·기본값(20/0)이 그대로 산다', async () => {
    const big = await mine(TOKEN_A, '?limit=999999');
    assert.ok(big.body.data.limit <= 50, `상한이 없다: limit=${big.body.data.limit}`);
    const def = await mine(TOKEN_A);
    assert.strictEqual(def.body.data.limit, 20);
    assert.strictEqual(def.body.data.offset, 0);
    const bad = await mine(TOKEN_A, '?limit=abc');
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.error.code, 'PAGINATION_INVALID');
  });

  await t('★ 저장 직후 status 는 언제나 pending 이다 (자동 전이가 없다)', async () => {
    const rows = await db.query('SELECT DISTINCT status FROM contributions');
    assert.deepStrictEqual(rows.rows.map((x) => x.status), ['pending'],
      '저장 경로가 pending 외의 status 를 만들었다 — 앱 문구를 다시 봐야 한다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§5. ★★★ 제품 조회는 «무인증»으로 통과한다 (노션 §6·§9 획득 훅)');
  // ══════════════════════════════════════════════════════════════════════════
  // ⚠⚠ 제이 지시(「제보도 로그인 필수」)의 대상은 «제보»다. 스캔·조회까지 막으면
  //   노션이 설계한 「무료·무인증 스캔 = 획득 훅」이 사라진다. 이 절이 그 선을 지킨다.
  await t('★★★ GET /api/products/search 는 토큰 없이 401 이 «아니다»', async () => {
    // ⚠ 여기서 200 을 단정하지 «않는다». 이 쿼리는 `pg_trgm` 의 `similarity()` 를 쓰는데
    //   pglite 에는 그 확장이 없다(gate.yml 이 `real-postgres` job 을 따로 둔 이유).
    //   이 절이 지키는 것은 **인증이 걸렸는가**이지 검색 결과가 아니다 — 400/500 은 다른 축이다.
    const r = await request('GET', '/api/products/search?q=%EC%B4%88%EC%BD%94');
    assert.notStrictEqual(r.status, 401,
      `제품 검색에 인증이 걸렸다 — 무인증 스캔(획득 훅)이 죽는다: ${JSON.stringify(r.body)}`);
  });

  await t('★★★ GET /api/products/:barcode 는 토큰 없이 401 이 «아니다»', async () => {
    const r = await request('GET', '/api/products/8801111111111');
    assert.notStrictEqual(r.status, 401,
      `제품 조회에 인증이 걸렸다 — 무인증 스캔(획득 훅)이 죽는다: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
  });

  await t('GET /api/products/recent 도 무인증이다', async () => {
    const r = await request('GET', '/api/products/recent?limit=5');
    assert.notStrictEqual(r.status, 401, '최근 제품 조회에 인증이 걸렸다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§6. ⚠ 배포 순서가 어긋나도 «500 이 아니다»');
  // ══════════════════════════════════════════════════════════════════════════
  // 배포 순서는 「① 021 마이그레이션 → ② 환경변수 → ③ 코드」다.
  // 어긋나는 것은 «사고»가 아니라 «흔한 일»이다. 그때 500 스택이 나면 아무도 원인을 못 본다.
  //
  // ⚠ 세션64c 후속 — 「SUPABASE_JWT_SECRET 미설정 → 503」은 **더 이상 참이 아니다.**
  //   비밀은 이제 «전환기 폴백»이라 선택이고, 주 경로는 SUPABASE_URL + JWKS 다.
  //   그래서 두 갈래로 갈랐다: 「둘 다 없으면 503」 / 「비밀만 없으면 정상 200」.
  await t('★★★ SUPABASE_URL·SUPABASE_JWT_SECRET 이 «둘 다» 없으면 503 AUTH_NOT_CONFIGURED', async () => {
    const savedSecret = process.env.SUPABASE_JWT_SECRET;
    const savedUrl = process.env.SUPABASE_URL;
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.SUPABASE_URL;
    try {
      const r = await mine(TOKEN_A);
      assert.strictEqual(r.status, 503, `${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.error.code, 'AUTH_NOT_CONFIGURED');
      assert.ok(/[가-힣]/.test(r.body.error.message), '한국어 문장이 아니다');
      assert.ok(errorLog.some((e) => /SUPABASE_URL/.test(e.msg)),
        '서버 로그에 원인이 안 남았다 — 「왜 전부 503 인가」를 알 방법이 없다');
    } finally {
      process.env.SUPABASE_JWT_SECRET = savedSecret;
      process.env.SUPABASE_URL = savedUrl;
    }
  });

  await t('★★★ SUPABASE_URL 만 없으면(비밀은 있음) ES256 토큰은 503 이다 — 401 로 «내리지» 않는다', async () => {
    // ⚠ 설정 사고를 401 로 내리면 「사용자가 로그인을 잘못했다」로 보인다.
    //   사용자는 몇 번을 다시 로그인해도 못 고친다. 그게 가장 오래 안 잡히는 사고다.
    const savedUrl = process.env.SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    try {
      const r = await mine(TOKEN_A);
      assert.strictEqual(r.status, 503, `${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.error.code, 'AUTH_NOT_CONFIGURED');
    } finally {
      process.env.SUPABASE_URL = savedUrl;
    }
  });

  await t('★★★ SUPABASE_JWT_SECRET 이 «없어도» ES256 만으로 정상 동작한다', async () => {
    // 전환이 끝나면 legacy 비밀은 지워질 값이다. 그때 서버가 죽으면 안 된다.
    const saved = process.env.SUPABASE_JWT_SECRET;
    delete process.env.SUPABASE_JWT_SECRET;
    try {
      const r = await mine(TOKEN_A, '?limit=50');
      assert.strictEqual(r.status, 200,
        `비밀이 없다고 ES256 인증까지 막혔다: ${r.status} ${JSON.stringify(r.body)}`);
      assert.ok(r.body.data.total > 0);

      // 그 상태에서 HS256 토큰은 받지 않는다 — 그러나 **503 이 아니라 401** 이다
      // (503 이면 아무나 HS256 모양 토큰을 보내 서버를 「점검 중」으로 보이게 만들 수 있다).
      const hs = makeToken({ sub: UID_A }, { hs256: true });
      const h = await mine(hs);
      assert.strictEqual(h.status, 401, `${h.status} ${JSON.stringify(h.body)}`);
      assert.strictEqual(h.body.error.code, 'AUTH_INVALID');
    } finally {
      process.env.SUPABASE_JWT_SECRET = saved;
    }
  });

  await t('★ 환경변수를 되돌리면 다시 200 이다 (설정을 «모듈 로드 시점»에 캐시하지 않았다)', async () => {
    const r = await mine(TOKEN_A);
    assert.strictEqual(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
  });

  await t('★★★ 021 미적용 DB(users.supabase_uid 없음) → 503 AUTH_STORE_NOT_READY (500 아님)', async () => {
    activePg = pgNo021;   // ← 마이그레이션 전 운영 DB 를 그대로 재현한다
    try {
      const r = await mine(TOKEN_A);
      assert.strictEqual(r.status, 503,
        `컬럼이 없는데 ${r.status} 가 났다 — 원인이 안 보이는 실패다: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.error.code, 'AUTH_STORE_NOT_READY');
      assert.ok(errorLog.some((e) => /021_supabase_auth/.test(e.msg)),
        '서버 로그에 「021 미적용」이라고 안 적혔다');
    } finally {
      activePg = pgReady;
    }
  });

  await t('★ 제보 저장 경로도 021 미적용에서 503 이다 (500 스택이 아니다)', async () => {
    activePg = pgNo021;
    try {
      const r = await callMultiPhoto({ token: TOKEN_A, barcode: '8807777777777', deviceId: DEV_A, extraFields: { save: 'true' } });
      assert.strictEqual(r.status, 503, `${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.error.code, 'AUTH_STORE_NOT_READY');
    } finally {
      activePg = pgReady;
    }
  });

  await t('★ 021 을 적용한 DB 로 되돌리면 정상이다 (테스트가 상태를 남기지 않는다)', async () => {
    const r = await mine(TOKEN_A, '?limit=50');
    assert.strictEqual(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(r.body.data.total > 0);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§7. 021 마이그레이션 자체 — firebase_uid 를 «지우지 않았다»');
  // ══════════════════════════════════════════════════════════════════════════
  await t('★★ users.firebase_uid 가 살아 있다 (전환 기간 공존 — 지우면 되돌릴 수 없다)', async () => {
    const r = await db.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'users' AND column_name IN ('user_id','firebase_uid','supabase_uid')
       ORDER BY column_name`);
    const cols = Object.fromEntries(r.rows.map((x) => [x.column_name, x.data_type]));
    assert.ok(cols.firebase_uid, 'firebase_uid 가 사라졌다 — health-pick 등 인접 앱 확인 전에는 지우면 안 된다');
    assert.ok(cols.supabase_uid, 'supabase_uid 가 없다 — 021 이 안 돌았다');
    assert.ok(/bigint/i.test(cols.user_id),
      `user_id 가 bigint 가 아니다(${cols.user_id}) — contributions.user_id FK 가 깨진다`);
    assert.ok(/character varying/i.test(cols.supabase_uid),
      `supabase_uid 타입이 다르다: ${cols.supabase_uid}`);
  });

  await t('★★ supabase_uid 에 UNIQUE 인덱스가 있다 (없으면 ON CONFLICT 가 [42P10] 로 죽는다)', async () => {
    const r = await db.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'users' AND indexdef ILIKE '%supabase_uid%'`);
    assert.ok(r.rows.length >= 1, 'supabase_uid 인덱스가 없다');
    const dup = db.query(
      "INSERT INTO users (supabase_uid, email) VALUES ($1, 'dup@example.com')", [UID_A]);
    await assert.rejects(dup, /duplicate|unique/i,
      '같은 supabase_uid 로 두 번째 행이 들어갔다 — UNIQUE 가 아니다');
  });

  await t('★ supabase_uid 가 NULL 인 행은 여러 개 허용된다 (기존 Firebase 사용자 보존)', async () => {
    await db.query("INSERT INTO users (firebase_uid, email) VALUES ('fb-legacy-1', 'l1@example.com')");
    await db.query("INSERT INTO users (firebase_uid, email) VALUES ('fb-legacy-2', 'l2@example.com')");
    const r = await db.query('SELECT COUNT(*)::int AS c FROM users WHERE supabase_uid IS NULL');
    assert.ok(r.rows[0].c >= 2, 'supabase_uid NULL 행이 충돌했다 — 기존 사용자가 못 남는다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§8. ★★★ ES256 + JWKS (세션64c 후속 — 설계 오류 교정)');
  // ══════════════════════════════════════════════════════════════════════════
  // 여기부터는 「HS256 하나면 된다」는 첫 판의 전제를 «되돌리는» 단정들이다.
  // 실측 근거는 파일 머리말 참조(대시보드 배너 · CURRENT KEY = ECC P-256 · JWKS keys[0].alg=ES256).

  await t('★★★ ES256 정상 토큰이 통과한다 (주 경로)', async () => {
    const r = await mine(makeToken({ sub: UID_A }), '?limit=50');
    assert.strictEqual(r.status, 200, `ES256 토큰이 막혔다: ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(r.body.data.total > 0);
  });

  await t('★★★ JWKS 를 «매 요청마다» 가져오지 않는다 (캐시가 실제로 산다)', async () => {
    await mine(TOKEN_A);                 // 캐시를 확실히 데운다
    const before = jwksHits;
    for (let i = 0; i < 5; i += 1) {
      const r = await mine(makeToken({ sub: UID_A }));
      assert.strictEqual(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.strictEqual(jwksHits, before,
      `요청 5건에 JWKS 를 ${jwksHits - before}번 더 가져왔다 — 캐시가 안 먹는다(Supabase 를 두들긴다)`);
  });

  await t('★★★ **HS256 토큰이 폴백으로 통과한다** (전환 이전에 발급된 세션이 안 끊긴다)', async () => {
    // Supabase 가 legacy secret 을 「still used / only verify」로 표시하는 동안,
    // 전환 «전»에 발급돼 아직 만료되지 않은 access token 이 HS256 으로 돌아다닌다.
    const hs = makeToken({ sub: UID_A, email: 'jay@example.com' }, { hs256: true });
    const r = await mine(hs, '?limit=50');
    assert.strictEqual(r.status, 200,
      `HS256 폴백이 안 먹는다 — 전환 중인 사용자가 전부 로그아웃된다: ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(r.body.data.total > 0);
  });

  await t('★★★ alg 혼동 ⓐ — JWKS 공개키 «재료»를 HMAC 비밀로 쓴 토큰은 거부된다', async () => {
    // 고전적 공격: 공개키는 누구나 안다 → 그 값을 HMAC 비밀로 삼아 HS256 토큰을 만든다.
    // 우리 HS256 경로는 **SUPABASE_JWT_SECRET 밖에** 쓰지 않으므로 통하지 않는다.
    const jwkMaterial = `${KEY_CURRENT.jwk.x}${KEY_CURRENT.jwk.y}`;
    const pubPem = crypto.createPublicKey({ key: KEY_CURRENT.jwk, format: 'jwk' })
      .export({ format: 'pem', type: 'spki' });
    for (const fakeSecret of [jwkMaterial, pubPem, JSON.stringify(KEY_CURRENT.jwk)]) {
      const tok = makeToken({ sub: UID_A }, { secret: fakeSecret });
      const r = await mine(tok);
      assert.strictEqual(r.status, 401,
        `공개키를 HMAC 비밀로 쓴 토큰이 통과했다 — alg 혼동이 열렸다: ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.error.code, 'AUTH_INVALID');
    }
  });

  await t('★★★ alg 혼동 ⓑ — 정상 ES256 토큰의 «헤더 alg 만» HS256 으로 바꾸면 거부된다', async () => {
    const good = makeToken({ sub: UID_A });
    const [, payload, sig] = good.split('.');
    const swapped = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: KID_CURRENT }))
      .toString('base64url');
    const r = await mine(`${swapped}.${payload}.${sig}`);
    assert.strictEqual(r.status, 401,
      `헤더 alg 를 바꾼 토큰이 통과했다: ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.error.code, 'AUTH_INVALID');
  });

  await t('★★★ alg 혼동 ⓒ — ES256·HS256 이 «아닌» alg 는 전부 거부된다', async () => {
    const good = makeToken({ sub: UID_A });
    const [, payload, sig] = good.split('.');
    for (const alg of ['RS256', 'ES384', 'ES512', 'PS256', 'none', 'HS512']) {
      const h = Buffer.from(JSON.stringify({ alg, typ: 'JWT', kid: KID_CURRENT })).toString('base64url');
      const r = await mine(`${h}.${payload}.${sig}`);
      assert.strictEqual(r.status, 401, `alg=${alg} 가 통과했다: ${r.status} ${JSON.stringify(r.body)}`);
    }
  });

  await t('★★★ alg 혼동 ⓓ — JWKS 에 «RSA 키가 실려 있어도» RS256 은 거부된다 (ES256 고정)', async () => {
    // ★ 이 단정이 `algorithms: ['ES256']` 고정을 «실제로» 지키는 유일한 테스트다.
    //   서명도 맞고 kid 도 맞는 진짜 RS256 토큰을 준다 — 고정을 풀면 **통과해 버린다.**
    //   Supabase 는 RSA 서명키도 지원하므로 이건 상상 속 시나리오가 아니다.
    //   ⚠ 언젠가 제이가 «의도적으로» RSA 로 회전시키면 이 테스트가 빨강이 된다.
    //     그때는 고정을 ['ES256','RS256'] 로 넓히고 이 단정을 고쳐야 한다 —
    //     조용히 넓히지 말고 **그 결정을 여기에 적을 것.**
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaKid = 'rsa-11111111-2222-4333-8444-555555555555';
    const rsaJwk = { ...rsa.publicKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: rsaKid };
    jwksBody = { keys: [KEY_CURRENT.jwk, rsaJwk] };
    jwksCache.__testCache({ reset: true });
    try {
      const now = Math.floor(Date.now() / 1000);
      const tok = jwt.sign(
        { sub: UID_A, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 },
        rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }),
        { algorithm: 'RS256', noTimestamp: true, keyid: rsaKid }
      );
      const r = await mine(tok);
      assert.strictEqual(r.status, 401,
        `RS256 토큰이 통과했다 — algorithms 고정이 풀렸다: ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.error.code, 'AUTH_INVALID');
    } finally {
      jwksBody = { keys: [KEY_CURRENT.jwk] };
      jwksCache.__testCache({ reset: true });
    }
  });

  await t('★★★ 폴백에서도 알고리즘이 고정돼 있다 — «진짜» HS512 토큰도 401 이다', async () => {
    // ★ 이 단정이 폴백의 `algorithms: ['HS256']` 고정을 지킨다.
    //   같은 비밀로 «정상 서명»된 HS512 토큰이다 — 고정을 풀면 통과한다.
    const now = Math.floor(Date.now() / 1000);
    const tok = jwt.sign(
      { sub: UID_A, role: 'authenticated', iat: now, exp: now + 3600 },
      SECRET, { algorithm: 'HS512', noTimestamp: true }
    );
    const r = await mine(tok);
    assert.strictEqual(r.status, 401,
      `HS512 토큰이 통과했다 — 폴백의 algorithms 고정이 풀렸다: ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.error.code, 'AUTH_INVALID');
  });

  await t('★ exp 가 «없는» 토큰은 401 이다 (영원히 사는 토큰을 만들지 않는다)', async () => {
    const r = await mine(makeToken({ sub: UID_A, exp: undefined }));
    assert.strictEqual(r.status, 401, `exp 없는 토큰이 통과했다: ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.error.code, 'AUTH_INVALID');
  });

  await t('★★★ JWKS 를 못 가져오고 캐시도 없으면 **통과시키지 않는다** (fail-open 금지) → 503', async () => {
    jwksCache.__testCache({ reset: true });   // 캐시를 통째로 버린다
    jwksMode = 'error';                       // Supabase 가 500 을 준다
    try {
      const r = await mine(TOKEN_A);
      assert.notStrictEqual(r.status, 200,
        '★★ JWKS 를 못 가져왔는데 인증이 통과했다 — fail-open 이다. 이게 최악의 실패다.');
      assert.strictEqual(r.status, 503, `${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.error.code, 'AUTH_KEYS_UNAVAILABLE');
      // ⚠ 401 이면 앱이 「다시 로그인하세요」라고 말한다. 사용자는 몇 번을 해도 못 고친다.
      assert.ok(/[가-힣]/.test(r.body.error.message), '한국어 문장이 아니다');
      assert.ok(!/JWKS|jwks|JWT|token/i.test(r.body.error.message),
        `기술 용어가 사용자에게 나간다: ${r.body.error.message}`);
      assert.ok(errorLog.some((e) => /JWKS/.test(e.msg)), '서버 로그에 원인이 안 남았다');
    } finally {
      jwksMode = 'ok';
      jwksCache.__testCache({ reset: true });
    }
  });

  await t('★★★ 캐시가 «있으면» JWKS 장애를 견딘다 (낡은 키로 계속 인증한다)', async () => {
    const warm = await mine(TOKEN_A);
    assert.strictEqual(warm.status, 200, `캐시를 데우지 못했다: ${JSON.stringify(warm.body)}`);
    const before = errorLog.length;
    jwksMode = 'error';
    jwksCache.__testCache({ age: true, cooldown: true });   // TTL 만료 + 쿨다운 해제
    try {
      const r = await mine(makeToken({ sub: UID_A }), '?limit=50');
      assert.strictEqual(r.status, 200,
        `Supabase 가 잠깐 죽었다고 먹선 인증 전체가 죽었다: ${r.status} ${JSON.stringify(r.body)}`);
      assert.ok(errorLog.slice(before).some((e) => /버틴다/.test(e.msg)),
        '낡은 키로 버티고 있다는 사실이 로그에 안 남았다 — 아무도 모르게 지나간다');
    } finally {
      jwksMode = 'ok';
      jwksCache.__testCache({ reset: true });
    }
  });

  await t('★★★ 키 회전 — 모르는 kid 를 보면 JWKS 를 «다시» 가져와 통과시킨다', async () => {
    const warm = await mine(TOKEN_A);
    assert.strictEqual(warm.status, 200, JSON.stringify(warm.body));

    // Supabase 가 키를 회전시켰다: 새 키가 추가된다(옛 키는 standby 로 남는다).
    jwksBody = { keys: [KEY_CURRENT.jwk, KEY_ROTATED.jwk] };
    jwksCache.__testCache({ cooldown: true });   // 캐시는 «신선»하다 — 회전 경로만 겨눈다
    const before = jwksHits;
    try {
      const rotated = makeToken({ sub: UID_A }, { key: KEY_ROTATED });
      const r = await mine(rotated, '?limit=50');
      assert.strictEqual(r.status, 200,
        `회전한 키로 서명된 토큰이 막혔다 — TTL 10분 동안 전원이 401 을 맞는다: ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(jwksHits, before + 1,
        `회전 재조회가 ${jwksHits - before}번 일어났다 — 정확히 1번이어야 한다(쿨다운이 없으면 증폭 공격이 된다)`);

      // 쿨다운: 바로 다음의 «모르는 kid» 는 재조회를 «유발하지 않는다».
      const after = jwksHits;
      const bogus = await mine(makeToken({ sub: UID_A }, { key: KEY_ATTACKER }));
      assert.strictEqual(bogus.status, 401, `모르는 kid 가 통과했다: ${bogus.status}`);
      assert.strictEqual(jwksHits, after,
        '가짜 kid 하나마다 JWKS 를 다시 가져온다 — 아무나 우리 서버로 Supabase 를 두들기게 만들 수 있다');
    } finally {
      jwksBody = { keys: [KEY_CURRENT.jwk] };
      jwksCache.__testCache({ reset: true });
    }
  });

  await t('★★ 선택 인증도 fail-open 하지 않는다 — 토큰이 있는데 JWKS 가 죽으면 게스트로 «강등하지 않는다»', async () => {
    // ⚠ 조용히 게스트로 내리면 그 사람의 제보가 주인 없이 쌓이고 본인은 영영 못 찾는다.
    jwksCache.__testCache({ reset: true });
    jwksMode = 'error';
    try {
      const r = await request('POST', '/api/ocr/report', {
        headers: bearer(TOKEN_A), body: { product_id: 1, reason: '틀렸어요' },
      });
      assert.strictEqual(r.status, 503, `${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.error.code, 'AUTH_KEYS_UNAVAILABLE');
    } finally {
      jwksMode = 'ok';
      jwksCache.__testCache({ reset: true });
    }
  });

  await t('★★ JWKS 가 죽어도 «무인증» 제품 조회는 멀쩡하다 (획득 훅이 인증에 묶이지 않았다)', async () => {
    jwksCache.__testCache({ reset: true });
    jwksMode = 'error';
    try {
      const r = await request('GET', '/api/products/8801111111111');
      assert.strictEqual(r.status, 200,
        `인증 장애가 무인증 스캔까지 죽였다: ${r.status} ${JSON.stringify(r.body)}`);
    } finally {
      jwksMode = 'ok';
      jwksCache.__testCache({ reset: true });
    }
  });

  await t('★★★ JWKS URL 을 «하드코딩하지 않고» 환경변수에서 조립한다', async () => {
    const saved = { url: process.env.SUPABASE_URL, ref: process.env.SUPABASE_PROJECT_REF };
    const PATH = '/auth/v1/.well-known/jwks.json';
    try {
      // ① SUPABASE_URL
      process.env.SUPABASE_URL = 'https://abcdefghijklmnop.supabase.co';
      delete process.env.SUPABASE_PROJECT_REF;
      assert.strictEqual(getJwksUrl(), `https://abcdefghijklmnop.supabase.co${PATH}`);

      // 뒤에 슬래시가 붙어도 같다 (제이가 복사해 붙이면 흔한 일이다)
      process.env.SUPABASE_URL = 'https://abcdefghijklmnop.supabase.co/';
      assert.strictEqual(getJwksUrl(), `https://abcdefghijklmnop.supabase.co${PATH}`);

      // ② SUPABASE_PROJECT_REF (URL 이 없을 때만)
      delete process.env.SUPABASE_URL;
      process.env.SUPABASE_PROJECT_REF = 'abcdefghijklmnop';
      assert.strictEqual(getJwksUrl(), `https://abcdefghijklmnop.supabase.co${PATH}`);

      // ③ 둘 다 있으면 URL 이 이긴다
      process.env.SUPABASE_URL = 'https://zzzzzzzzzzzzzzzz.supabase.co';
      assert.strictEqual(getJwksUrl(), `https://zzzzzzzzzzzzzzzz.supabase.co${PATH}`);

      // ④ ★ 평문 http 는 «공개망»에서 거부한다 — 중간자가 자기 공개키를 밀어넣을 수 있다
      delete process.env.SUPABASE_PROJECT_REF;
      process.env.SUPABASE_URL = 'http://evil.example.com';
      assert.strictEqual(getJwksUrl(), null, 'http 로도 JWKS 를 가져온다 — 키를 갈아끼울 틈이 열린다');

      // ⑤ URL 이 아니면 null (500 이 아니다)
      process.env.SUPABASE_URL = 'not-a-url';
      assert.strictEqual(getJwksUrl(), null);

      // ⑥ 아무것도 없으면 null
      delete process.env.SUPABASE_URL;
      assert.strictEqual(getJwksUrl(), null);
    } finally {
      process.env.SUPABASE_URL = saved.url;
      if (saved.ref) process.env.SUPABASE_PROJECT_REF = saved.ref;
      else delete process.env.SUPABASE_PROJECT_REF;
      jwksCache.__testCache({ reset: true });
    }
  });

  await t('★ 마지막으로 다시 정상이다 (§8 이 상태를 남기지 않았다)', async () => {
    const r = await mine(TOKEN_A, '?limit=50');
    assert.strictEqual(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(r.body.data.total > 0);
  });

  // ══════════════════════════════════════════════════════════════════════════
  server.close();
  jwksServer.close();
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(` 결과: ${pass}/${pass + fail} 통과 · ${fail} 실패`);
  if (fail > 0) {
    console.log('\n실패 상세:');
    for (const f of failures) console.log(`  - ${f.name}\n    ${f.message}`);
  }
  console.log('════════════════════════════════════════════════════════════════\n');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('테스트 실행 오류:', e);
  process.exit(1);
});
