/**
 * test_ocr_confirm.js — 세션64 «제품명 확정» 축 회귀
 * ============================================================================
 * 무엇을 지키는가
 *   ① `analysisCache` — 토큰 발급/조회/만료/추측불가/상한
 *   ② `mergeProductMeta` — 라벨만 / 영양표만 / 둘 다 / 둘 다 비어있음
 *      (종전 `labelMeta || nutritionMeta || {}` 는 **빈 객체도 truthy** 라
 *       라벨에서 제품명을 못 읽으면 영양표 메타를 영원히 못 봤다 — 세션44 치명B 와 같은 함정)
 *   ③ `POST /api/ocr/multi-photo` 가 `save=false` 에 **analysis_token** 을 싣는다.
 *      `save=true` 기존 경로는 **그대로**다(하위 호환).
 *   ④ `POST /api/ocr/confirm` — 400(빈 이름·공백만) · 410(없는 토큰) · 정상 저장
 *   ⑤ `crowdsourceService` 게이트 0 — **첫 원재료명 폴백이 죽었다.**
 *      실물 67건 중 21건이 그 폴백을 탔고 `"정제수"`·`"주정"`·`"륨"` 이 저장될 값이었다.
 *
 * ★ 이 파일은 **소스 문자열을 한 글자도 읽지 않는다.**
 *   전부 pglite(진짜 Postgres/wasm)에 `000_baseline.sql` 정본을 적용하고,
 *   **실제 라우터 핸들러를 HTTP 로 호출**해 나온 응답과 **DB 에 실제로 박힌 행**만 단정한다.
 *   (세션48 4차 검증: 소스 정규식 검사는 본문 오염으로 뚫렸고 12개 파일이 거짓 초록이었다.)
 *
 * ★★ Google Vision 을 부르지 않는다. `ocrService` 를 require.cache 에서 스텁으로 갈아끼운다.
 *   **파서는 스텁하지 않는다** — 라우터가 실제로 하는 일(파싱·병합·판정 배선)을 그대로 통과시킨다.
 *
 * 실행: cross-env NODE_ENV=test node tests/test_ocr_confirm.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const SRV = path.join(__dirname, '..');
const BASELINE = path.join(SRV, 'scripts', 'migrations', '000_baseline.sql');

// ══════════════════════════════════════════════════════════════════════════
// 0. 출력 (기존 테스트 파일들과 같은 형식)
// ══════════════════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════════════════
// 1. 픽스처 — 실물 라벨 2장 촬영 규칙(`_원재료` / `_영양`)을 그대로 흉내낸다
// ══════════════════════════════════════════════════════════════════════════
/** 제품명이 **찍혀 있는** 라벨 컷 */
const LABEL_WITH_NAME = [
  '제품명: 초코칩쿠키',
  '식품유형: 과자',
  '원재료명: 밀가루(밀:미국산), 설탕, 초콜릿가공품, 마가린, 정제수, 합성착향료',
  '우유, 대두, 밀 함유',
  '내용량 120g',
].join('\n');

/**
 * 제품명이 **안 찍힌** 라벨 컷 — 실물 67건 중 27건(40.3%)이 이렇다.
 * ★ 첫 원재료가 `정제수` 다. 종전 폴백이라면 이것이 `products.product_name` 이 된다.
 */
const LABEL_NO_NAME = [
  '원재료명: 정제수, 설탕, 주정, 구연산, 합성착향료',
  '대두 함유',
].join('\n');

/** 영양성분표 컷 (제품명 없음) */
const NUTRITION_ONLY = [
  '영양성분 100g당',
  '열량 480kcal',
  '나트륨 300mg',
  '탄수화물 60g',
  '당류 25g',
  '지방 22g',
  '포화지방 12g',
  '트랜스지방 0g',
  '콜레스테롤 5mg',
  '단백질 6g',
].join('\n');

/** 영양성분표 컷인데 **제품명이 여기 찍혔다** — ②의 반례 */
const NUTRITION_WITH_NAME = ['제품명: 콜라맛탄산음료', '식품유형: 탄산음료', NUTRITION_ONLY].join('\n');

// ══════════════════════════════════════════════════════════════════════════
// 2. multipart 요청 조립 — `/multi-photo` 는 multer 라 JSON 으로는 못 부른다
// ══════════════════════════════════════════════════════════════════════════
function buildMultipart(fields, files) {
  const boundary = '----meokseonS64Boundary' + Math.random().toString(16).slice(2);
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

// ══════════════════════════════════════════════════════════════════════════
// 3. 실행
// ══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(' 세션64 — OCR 제품명 확정 축 (analysis_token · /confirm · 폴백 폐기)');
  console.log('════════════════════════════════════════════════════════════════');

  // ── pglite ────────────────────────────────────────────────────────────
  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (_) {
    console.log('⏭  pglite 미설치 — 저장 경로를 검증할 수 없다 (npm i -D @electric-sql/pglite)');
    console.log('   ★ 이 테스트의 목적상 「건너뜀」은 「통과」가 아니다. EXIT=1 로 남긴다.');
    process.exit(1);
  }

  const db = new PGlite();
  try {
    await db.exec(fs.readFileSync(BASELINE, 'utf8'));
  } catch (e) {
    console.error(`000_baseline.sql 적용 실패 — 픽스처가 아니라 정본 SQL 문제다: ${e.message}`);
    process.exit(1);
  }

  const shim = {
    pool: null,
    query: (text, params) => db.query(text, params || []),
    transaction: async (cb) => {
      await db.exec('BEGIN');
      try {
        const r = await cb({ query: (tx, p) => db.query(tx, p || []) });
        await db.exec('COMMIT');
        return r;
      } catch (e) { await db.exec('ROLLBACK'); throw e; }
    },
    healthCheck: async () => ({ status: 'healthy' }),
  };
  const dbPath = require.resolve('../src/config/database');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };

  // ── Vision 스텁 (유료 API 를 절대 부르지 않는다) ────────────────────────
  //   요청마다 어떤 텍스트를 돌려줄지 아래 `nextTexts` 로 지정한다.
  //   multer 가 label_image → nutrition_image 순서로 넘기므로 큐로 받는다.
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

  // ── logger 스텁 ────────────────────────────────────────────────────────
  //   ★ 「경고 로그를 남긴다」는 **계약**이다(제이 지시 2026-08-21: 불일치는 공격 신호일 수 있다).
  //     로그를 안 보면 「무시했다」만 검사하게 되고, 그러면 관측 수단이 조용히 사라져도
  //     테스트가 초록이다 — 거부 대신 «경고»를 택한 판단의 근거가 통째로 무너진다.
  //   ⚠ ocrRoutes 를 require 하기 **전에** 갈아끼워야 한다(모듈 최상단에서 잡아가므로).
  const warnLog = [];
  const loggerPath = require.resolve('../src/config/logger');
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: {
      warn: (msg, meta) => { warnLog.push({ msg, meta }); },
      info: () => {}, error: () => {}, debug: () => {},
    },
  };

  const express = require('express');
  const ocrRoutes = require('../src/routes/ocrRoutes');
  const analysisCache = require('../src/services/analysisCache');
  const crowdsource = require('../src/services/crowdsourceService');
  const { errorHandler } = require('../src/middleware/errorHandler');

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/ocr', ocrRoutes);
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
            resolve({ status: res.statusCode, body: parsed });
          });
        });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * `/multi-photo` 호출기 — 두 컷의 OCR 텍스트를 큐에 넣고 multipart 로 보낸다.
   * ★ `barcode` 는 **본문 최상위 필드**로 보낸다 — 실제 앱이 그렇게 한다
   *   (`web/src/lib/meokseon.ts:337` `fd.append('barcode', barcode)`).
   *   1단계에서 이 값이 토큰에 담기는 것이 「확정 때 토큰 바코드만 쓴다」의 전제다.
   */
  async function callMultiPhoto({ labelText, nutritionText, save, productInfo, barcode }) {
    visionQueue.length = 0;
    const files = {};
    if (labelText !== undefined) { visionQueue.push(labelText); files.label_image = Buffer.from('fakejpeg-label'); }
    if (nutritionText !== undefined) { visionQueue.push(nutritionText); files.nutrition_image = Buffer.from('fakejpeg-nut'); }
    const fields = {};
    if (save !== undefined) fields.save = String(save);
    if (barcode !== undefined) fields.barcode = barcode;
    if (productInfo !== undefined) fields.product_info = JSON.stringify(productInfo);
    const { body, contentType } = buildMultipart(fields, files);
    return request('POST', '/api/ocr/multi-photo', { headers: { 'content-type': contentType }, body });
  }

  // ════════════════════════════════════════════════════════════════════════
  section('§1. analysisCache — 토큰 발급 · 조회 · 만료 · 추측불가');
  // ════════════════════════════════════════════════════════════════════════
  await t('발급한 토큰으로 담은 값을 그대로 꺼낸다', () => {
    analysisCache._clear();
    const token = analysisCache.putAnalysis({
      analysis: { nutrition: { calories: 100 }, product_meta: { product_name: 'X' } },
      barcode: '8801234567890',
      ocrResult: { corrected_text: 'abc', corrections: [] },
      avgConfidence: 0.91,
    });
    const got = analysisCache.getAnalysis(token);
    assert.ok(got, '방금 발급한 토큰이 조회되지 않는다');
    assert.strictEqual(got.barcode, '8801234567890');
    assert.strictEqual(got.avgConfidence, 0.91);
    assert.strictEqual(got.analysis.nutrition.calories, 100);
    assert.strictEqual(got.ocrResult.corrected_text, 'abc');
  });

  await t('토큰은 추측 불가하다 (48 hex · 매번 다르다)', () => {
    analysisCache._clear();
    const seen = new Set();
    for (let i = 0; i < 50; i += 1) {
      const tk = analysisCache.putAnalysis({ analysis: {} });
      assert.ok(/^[0-9a-f]{48}$/.test(tk), `토큰 형식이 randomBytes(24).hex 가 아니다: ${tk}`);
      assert.ok(!seen.has(tk), '토큰이 중복 발급됐다 — CSPRNG 가 아니다');
      seen.add(tk);
    }
  });

  await t('★ TTL 10분이 지나면 만료된다 (조회 불가 + 항목이 실제로 지워진다)', () => {
    analysisCache._clear();
    const token = analysisCache.putAnalysis({ analysis: { a: 1 } });
    const almost = Date.now() + analysisCache.TTL_MS - 1000;
    assert.ok(analysisCache.getAnalysis(token, almost), '만료 1초 전인데 벌써 사라졌다');
    const after = Date.now() + analysisCache.TTL_MS + 1000;
    assert.strictEqual(analysisCache.getAnalysis(token, after), null, 'TTL 이 지났는데 아직 조회된다');
    assert.strictEqual(analysisCache._size(), 0, '만료분이 Map 에 남아 있다 — 메모리 누수다');
    assert.strictEqual(analysisCache.TTL_MS, 10 * 60 * 1000, 'TTL 이 10분이 아니다(계약)');
  });

  await t('★ 만료분은 주기 청소(sweep)로도 사라진다 (누수 방지)', () => {
    analysisCache._clear();
    analysisCache.putAnalysis({ analysis: {} });
    analysisCache.putAnalysis({ analysis: {} });
    assert.strictEqual(analysisCache._size(), 2);
    const removed = analysisCache.sweep(Date.now() + analysisCache.TTL_MS + 1);
    assert.strictEqual(removed, 2, 'sweep 이 만료분을 안 지웠다');
    assert.strictEqual(analysisCache._size(), 0);
  });

  await t('없는 토큰 · 빈 문자열 · 비문자열은 null 이다', () => {
    analysisCache._clear();
    assert.strictEqual(analysisCache.getAnalysis('deadbeef'), null);
    assert.strictEqual(analysisCache.getAnalysis(''), null);
    assert.strictEqual(analysisCache.getAnalysis(null), null);
    assert.strictEqual(analysisCache.getAnalysis(undefined), null);
    assert.strictEqual(analysisCache.getAnalysis({ a: 1 }), null);
  });

  await t('★ 상한(MAX_ENTRIES)을 넘으면 오래된 것부터 버린다 (무한 증식 금지)', () => {
    analysisCache._clear();
    const first = analysisCache.putAnalysis({ analysis: { n: 0 } });
    for (let i = 1; i <= analysisCache.MAX_ENTRIES + 5; i += 1) {
      analysisCache.putAnalysis({ analysis: { n: i } });
    }
    assert.ok(analysisCache._size() <= analysisCache.MAX_ENTRIES,
      `상한을 넘었다: ${analysisCache._size()} > ${analysisCache.MAX_ENTRIES}`);
    assert.strictEqual(analysisCache.getAnalysis(first), null, '가장 오래된 토큰이 안 밀려났다');
    analysisCache._clear();
  });

  // ════════════════════════════════════════════════════════════════════════
  section('§2. mergeProductMeta — 세션44 치명B 와 같은 함정을 닫았는가');
  // ════════════════════════════════════════════════════════════════════════
  const { mergeProductMeta } = ocrRoutes;

  await t('라벨만 값이 있으면 라벨 값을 쓴다', () => {
    const r = mergeProductMeta({ product_name: '초코칩쿠키', food_type: '과자' }, {});
    assert.strictEqual(r.product_name, '초코칩쿠키');
    assert.strictEqual(r.food_type, '과자');
  });

  await t('★★★ 라벨이 빈 객체여도 영양표 메타를 쓴다 (이것이 이번에 고친 결함이다)', () => {
    const r = mergeProductMeta({}, { product_name: '콜라맛탄산음료', food_type: '탄산음료' });
    assert.strictEqual(r.product_name, '콜라맛탄산음료',
      '빈 객체 `{}` 가 truthy 라 영양표 메타가 통째로 버려진다 — `||` 폴백이 살아 있다');
    assert.strictEqual(r.food_type, '탄산음료');
  });

  await t('둘 다 있으면 **라벨이 이긴다** (라벨 컷이 표시사항 1차 출처)', () => {
    const r = mergeProductMeta(
      { product_name: '라벨이름', total_content: 120 },
      { product_name: '영양표이름', food_type: '과자', total_content: 999 },
    );
    assert.strictEqual(r.product_name, '라벨이름');
    assert.strictEqual(r.total_content, 120);
    // 라벨에 없는 키는 영양표에서 채워진다(키 단위 병합 — 통째 교체가 아니다)
    assert.strictEqual(r.food_type, '과자');
  });

  await t('둘 다 비어 있으면 빈 객체다 (null 이 아니다 — 하위 호환)', () => {
    assert.deepStrictEqual(mergeProductMeta({}, {}), {});
    assert.deepStrictEqual(mergeProductMeta(null, null), {});
    assert.deepStrictEqual(mergeProductMeta(undefined, undefined), {});
  });

  await t('빈 문자열·null 은 「값」이 아니다 (그것이 이 결함의 본질이다)', () => {
    const r = mergeProductMeta({ product_name: '   ', brand: null }, { product_name: '영양표이름', brand: '오리온' });
    assert.strictEqual(r.product_name, '영양표이름', '공백뿐인 라벨 값이 영양표 값을 이겼다');
    assert.strictEqual(r.brand, '오리온');
  });

  // ════════════════════════════════════════════════════════════════════════
  section('§3. /multi-photo — analysis_token 발급 (1단계)');
  // ════════════════════════════════════════════════════════════════════════
  let liveToken = null;

  await t('★ save=false 면 analysis_token 이 실린다', async () => {
    const r = await callMultiPhoto({
      labelText: LABEL_WITH_NAME, nutritionText: NUTRITION_ONLY, save: 'false',
      barcode: 'S64CONFIRM1',
    });
    assert.strictEqual(r.status, 200, `응답이 200 이 아니다: ${JSON.stringify(r.body)}`);
    const tk = r.body?.data?.analysis_token;
    assert.ok(typeof tk === 'string' && /^[0-9a-f]{48}$/.test(tk), `analysis_token 이 없다: ${tk}`);
    liveToken = tk;
  });

  await t('★ 토큰이 담은 것은 «서버가 만든 분석 결과» 전체다 (원재료·알레르기·영양)', () => {
    const cached = analysisCache.getAnalysis(liveToken);
    assert.ok(cached, '방금 받은 토큰이 캐시에 없다');
    assert.ok(cached.analysis.ingredients.length > 0, '원재료가 캐시에 없다');
    assert.strictEqual(cached.analysis.nutrition.calories, 480, '영양값이 캐시에 없다');
    assert.strictEqual(cached.analysis.nutrition._basis, 'per_100g', '표기 기준(basis)이 캐시에 없다 — 저장 게이트 2가 못 돈다');
    assert.ok((cached.analysis.allergens || []).includes('우유'), `알레르기가 캐시에 없다: ${JSON.stringify(cached.analysis.allergens)}`);
    assert.strictEqual(cached.analysis.product_meta.product_name, '초코칩쿠키');
    assert.ok(cached.avgConfidence >= 0.7, 'OCR 신뢰도가 캐시에 없다 — 저장 게이트 1이 못 돈다');
    // ★★ 1단계에서 받은 바코드가 토큰에 담겨야 한다. 이것이 「확정 때 토큰 값만 쓴다」의 전제다 —
    //    여기서 담기지 않으면 토큰만 믿는 순간 **모든 제보가 바코드를 잃는다.**
    assert.strictEqual(cached.barcode, 'S64CONFIRM1',
      '본문 최상위 barcode 가 토큰에 담기지 않았다 — 2단계가 바코드를 잃는다');
  });

  await t('★★★ 제품명이 영양표 컷에만 찍혀도 자동채움이 살아 있다 (§2 결함의 실경로 확인)', async () => {
    const r = await callMultiPhoto({
      labelText: LABEL_NO_NAME, nutritionText: NUTRITION_WITH_NAME, save: 'false',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.data.analysis.product_meta.product_name, '콜라맛탄산음료',
      '라벨 컷에 제품명이 없으면 영양표 컷의 제품명이 통째로 버려진다 — ocrRoutes 의 `||` 폴백이 살아 있다');
  });

  await t('save=true 기존 경로는 그대로다 (하위 호환 — analysis_token 은 null)', async () => {
    const r = await callMultiPhoto({
      labelText: LABEL_WITH_NAME, nutritionText: NUTRITION_ONLY, save: 'true',
      productInfo: { product_name: '하위호환쿠키', barcode: 'S64COMPAT01', food_type: '과자' },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.data.analysis_token, null, 'save=true 인데 토큰이 발급됐다');
    assert.ok(r.body.data.save_result, 'save_result 가 사라졌다 — 기존 계약이 깨졌다');
    assert.strictEqual(r.body.data.save_result.saved, true,
      `기존 저장 경로가 깨졌다: ${r.body.data.save_result.rejectReason}`);
  });

  // ════════════════════════════════════════════════════════════════════════
  section('§4. /confirm — 400 / 410 / 정상 저장 (2단계)');
  // ════════════════════════════════════════════════════════════════════════
  await t('★ product_name 이 빈 문자열이면 400 이고 한국어 사유를 준다', async () => {
    const r = await request('POST', '/api/ocr/confirm', {
      body: { analysis_token: liveToken, product_info: { product_name: '' } },
    });
    assert.strictEqual(r.status, 400, `400 이 아니다: ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.success, false);
    assert.strictEqual(r.body.error.code, 'PRODUCT_NAME_REQUIRED');
    assert.ok(/제품명/.test(r.body.error.message), `사용자에게 보여줄 한국어 사유가 아니다: ${r.body.error.message}`);
  });

  await t('★ 공백만 있는 product_name 도 400 이다', async () => {
    for (const bad of ['   ', '\t', '\n  \n', '　']) {
      const r = await request('POST', '/api/ocr/confirm', {
        body: { analysis_token: liveToken, product_info: { product_name: bad } },
      });
      assert.strictEqual(r.status, 400, `공백(${JSON.stringify(bad)})이 통과했다: ${r.status}`);
      assert.strictEqual(r.body.error.code, 'PRODUCT_NAME_REQUIRED');
    }
  });

  await t('product_info 자체가 없어도 400 이다 (500 이 아니다)', async () => {
    const r = await request('POST', '/api/ocr/confirm', { body: { analysis_token: liveToken } });
    assert.strictEqual(r.status, 400, `${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.error.code, 'PRODUCT_NAME_REQUIRED');
  });

  await t('★ 400 을 받아도 토큰은 살아 있다 (재시도가 재촬영을 부르면 Vision 이 2배가 된다)', () => {
    assert.ok(analysisCache.getAnalysis(liveToken), '400 응답이 토큰을 소모했다 — 사용자가 이름만 고쳐 재시도할 수 없다');
  });

  await t('★ 잘못된 토큰은 410 이고 「사진을 다시 읽어 주세요」 취지의 사유를 준다', async () => {
    const r = await request('POST', '/api/ocr/confirm', {
      body: { analysis_token: 'f'.repeat(48), product_info: { product_name: '정상제품명' } },
    });
    assert.strictEqual(r.status, 410, `410 이 아니다: ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.error.code, 'ANALYSIS_EXPIRED');
    assert.ok(/사진/.test(r.body.error.message), `재촬영 안내가 아니다: ${r.body.error.message}`);
  });

  await t('토큰이 아예 없으면(키 누락) 410 이다', async () => {
    const r = await request('POST', '/api/ocr/confirm', { body: { product_info: { product_name: '정상제품명' } } });
    assert.strictEqual(r.status, 410, `${r.status} ${JSON.stringify(r.body)}`);
  });

  await t('★ 만료된 토큰은 410 이다 (TTL 경과를 캐시 시계로 재현)', async () => {
    const expiring = analysisCache.putAnalysis({ analysis: { nutrition: {} } },
      Date.now() - analysisCache.TTL_MS - 1000);
    const r = await request('POST', '/api/ocr/confirm', {
      body: { analysis_token: expiring, product_info: { product_name: '만료테스트' } },
    });
    assert.strictEqual(r.status, 410, `만료 토큰이 410 이 아니다: ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.error.code, 'ANALYSIS_EXPIRED');
  });

  await t('★★★ 정상 확정 — 저장되고, DB 에 박히는 이름은 «사용자가 타이핑한 것»이다', async () => {
    const r = await request('POST', '/api/ocr/confirm', {
      body: {
        analysis_token: liveToken,
        product_info: {
          product_name: '  오리온 초코칩쿠키  ',   // 앞뒤 공백 — trim 돼야 한다
          manufacturer: '오리온', brand: '오리온', food_type: '과자',
        },
        // 실제 앱이 하는 대로 본문 최상위에 «같은» 바코드를 방어적으로 함께 싣는다
        // (`web/src/lib/meokseon.ts:403`). 일치하므로 경고는 나지 않아야 한다.
        barcode: 'S64CONFIRM1',
        device_id: 'dev-s64-confirm',
      },
    });
    assert.strictEqual(r.status, 200, `확정이 200 이 아니다: ${r.status} ${JSON.stringify(r.body)}`);
    // ★ 응답 모양이 기존 `save_result` 와 같아야 한다 — 앱이 `saved` 로 판정한다.
    assert.ok(r.body.data.save_result, 'save_result 키가 없다 — 앱 계약이 깨졌다');
    assert.strictEqual(r.body.data.save_result.saved, true,
      `저장되지 않았다: ${r.body.data.save_result.rejectReason}`);

    const row = await db.query(
      "SELECT product_name, manufacturer, food_type FROM products WHERE barcode = 'S64CONFIRM1'");
    assert.strictEqual(row.rows.length, 1, 'products 에 행이 안 생겼다');
    assert.strictEqual(row.rows[0].product_name, '오리온 초코칩쿠키',
      `DB 에 박힌 이름이 사용자 입력의 trim 값이 아니다: ${JSON.stringify(row.rows[0].product_name)}`);
    assert.strictEqual(row.rows[0].manufacturer, '오리온');
  });

  await t('★ 확정이 «서버 분석값»을 저장한다 (클라이언트가 보낸 값으로 덮지 않는다)', async () => {
    // 클라이언트가 원재료·알레르기·영양을 거짓으로 보내도 서버 캐시 값이 저장돼야 한다.
    const r = await callMultiPhoto({
      labelText: LABEL_WITH_NAME, nutritionText: NUTRITION_ONLY, save: 'false',
      barcode: 'S64SERVERWINS',
    });
    const tk = r.body.data.analysis_token;
    const c = await request('POST', '/api/ocr/confirm', {
      body: {
        analysis_token: tk,
        product_info: {
          product_name: '서버값우선쿠키',
          // ⚠ 아래는 전부 클라이언트가 «분석 결과인 척» 보낸 값이다.
          ingredients: [{ name: '가짜원재료' }],
          nutrition: { calories: 1, sodium: 1 },
        },
        device_id: 'dev-s64-serverwins',
      },
    });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    assert.strictEqual(c.body.data.save_result.saved, true, c.body.data.save_result.rejectReason);

    const nut = await db.query(
      `SELECT n.calories FROM nutrition_data n JOIN products p ON p.product_id = n.product_id
       WHERE p.barcode = 'S64SERVERWINS'`);
    assert.strictEqual(nut.rows.length, 1, 'nutrition_data 가 저장되지 않았다');
    assert.strictEqual(Number(nut.rows[0].calories), 480,
      '클라이언트가 보낸 영양값(1 kcal)이 서버 분석값(480)을 덮었다 — 계약 위반');

    const ing = await db.query(
      `SELECT i.parsed_ingredients FROM product_ingredients i JOIN products p ON p.product_id = i.product_id
       WHERE p.barcode = 'S64SERVERWINS'`);
    const parsed = typeof ing.rows[0].parsed_ingredients === 'string'
      ? JSON.parse(ing.rows[0].parsed_ingredients) : ing.rows[0].parsed_ingredients;
    assert.ok(!parsed.includes('가짜원재료'), `클라이언트가 보낸 원재료가 저장됐다: ${JSON.stringify(parsed)}`);
    assert.ok(parsed.includes('밀가루'), `서버가 읽은 원재료가 저장되지 않았다: ${JSON.stringify(parsed)}`);
  });

  // ════════════════════════════════════════════════════════════════════════
  section('§4b. ★★★ 바코드는 «토큰이 정본»이다 (제이 확정 2026-08-21)');
  // ────────────────────────────────────────────────────────────────────────
  // 왜 이 절이 있는가 — `products` 는 **바코드 단위 공용 마스터**다.
  // 확정 요청이 보낸 바코드를 믿으면, A 제품 사진을 읽어놓고 확정할 때 B 의 바코드를
  // 적어 보내는 것만으로 **B 를 조회하는 전원에게 A 의 원재료·알레르기가 간다.**
  // 토큰은 서버가 발급했고 추측 불가하므로 거기 담긴 값만 신뢰한다.
  // ────────────────────────────────────────────────────────────────────────
  await t('일치하는 경우엔 경고를 남기지 않는다 (정상 요청을 시끄럽게 만들지 않는다)', () => {
    const noise = warnLog.filter((w) => w.meta?.reason === 'CLIENT_BARCODE_IGNORED'
      && w.meta?.token_barcode === 'S64CONFIRM1');
    assert.strictEqual(noise.length, 0,
      `본문·토큰 바코드가 같은데 경고가 났다: ${JSON.stringify(noise)}`);
  });

  await t('★★★ 본문 최상위 barcode 가 토큰과 «다르면» 토큰 값으로 저장된다 (바꿔치기 차단)', async () => {
    const r = await callMultiPhoto({
      labelText: LABEL_WITH_NAME, nutritionText: NUTRITION_ONLY, save: 'false',
      barcode: 'S64TOKENBC',           // ← 서버가 사진과 함께 받은 진짜 바코드
    });
    const tk = r.body.data.analysis_token;
    const c = await request('POST', '/api/ocr/confirm', {
      body: {
        analysis_token: tk,
        product_info: { product_name: '토큰바코드승리' },
        barcode: 'S64ATTACKBC',        // ← 공격자가 바꿔치기한 «남의» 바코드
        device_id: 'dev-s64-bcmismatch',
      },
    });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    assert.strictEqual(c.body.data.save_result.saved, true, c.body.data.save_result.rejectReason);

    const good = await db.query("SELECT product_name FROM products WHERE barcode = 'S64TOKENBC'");
    assert.strictEqual(good.rows.length, 1, '토큰 바코드로 저장되지 않았다');
    assert.strictEqual(good.rows[0].product_name, '토큰바코드승리');

    const bad = await db.query("SELECT product_name FROM products WHERE barcode = 'S64ATTACKBC'");
    assert.strictEqual(bad.rows.length, 0,
      `클라이언트가 보낸 남의 바코드로 제품 레코드가 오염됐다: ${JSON.stringify(bad.rows)}`);
  });

  await t('★ 불일치는 경고 로그로 남는다 (거부하지 않는 대신 «관측»한다 — 이것이 판단의 근거다)', () => {
    const hit = warnLog.filter((w) => w.meta?.reason === 'CLIENT_BARCODE_IGNORED'
      && w.meta?.client_barcode === 'S64ATTACKBC');
    assert.strictEqual(hit.length, 1,
      `바코드 불일치 경고가 정확히 1건이 아니다(${hit.length}건) — 공격 신호를 관측할 수단이 없다`);
    assert.strictEqual(hit[0].meta.token_barcode, 'S64TOKENBC', '경고에 토큰 바코드가 안 실렸다');
    assert.strictEqual(hit[0].meta.device_id, 'dev-s64-bcmismatch', '경고에 기기 식별자가 안 실렸다');
  });

  await t('★ `product_info.barcode` 로 우회해도 무시된다 (최상위만 막으면 반쪽이다)', async () => {
    const r = await callMultiPhoto({
      labelText: LABEL_WITH_NAME, nutritionText: NUTRITION_ONLY, save: 'false',
      barcode: 'S64TOKENBC2',
    });
    const c = await request('POST', '/api/ocr/confirm', {
      body: {
        analysis_token: r.body.data.analysis_token,
        // ★ 최상위가 아니라 product_info 안에 숨겨 보낸다. 전개 순서에만 기댔다면 여기서 뚫린다.
        product_info: { product_name: '우회시도제품', barcode: 'S64BYPASSBC' },
        device_id: 'dev-s64-bypass',
      },
    });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    const bad = await db.query("SELECT barcode FROM products WHERE barcode = 'S64BYPASSBC'");
    assert.strictEqual(bad.rows.length, 0,
      'product_info.barcode 우회가 통했다 — mergedProductInfo 에서 덮어쓰지 않고 있다');
    const good = await db.query("SELECT product_name FROM products WHERE barcode = 'S64TOKENBC2'");
    assert.strictEqual(good.rows.length, 1, '토큰 바코드로 저장되지 않았다');
  });

  await t('토큰에 바코드가 없으면 클라이언트가 보내도 바코드 없이 저장된다', async () => {
    // ⚠ 이것은 «의도된 손실»이다. 앱은 1단계에서도 바코드를 보내므로(meokseon.ts:337)
    //   실경로에서는 토큰이 비어 있을 수 없다. 만약 이 경로가 실제로 발생한다면
    //   그건 앱이 1단계에 바코드를 안 실었다는 뜻이고, 서버가 아니라 앱을 고쳐야 한다.
    const r = await callMultiPhoto({ labelText: LABEL_WITH_NAME, nutritionText: NUTRITION_ONLY, save: 'false' });
    const c = await request('POST', '/api/ocr/confirm', {
      body: {
        analysis_token: r.body.data.analysis_token,
        product_info: { product_name: '바코드없는제보' },
        barcode: 'S64LATEBC',
        device_id: 'dev-s64-nobc',
      },
    });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    const bad = await db.query("SELECT product_name FROM products WHERE barcode = 'S64LATEBC'");
    assert.strictEqual(bad.rows.length, 0, '토큰에 없던 바코드가 클라이언트 값으로 채워졌다');
  });

  // ════════════════════════════════════════════════════════════════════════
  section('§5. ★★★ crowdsourceService 게이트 0 — 첫 원재료명 폴백이 죽었는가');
  // ════════════════════════════════════════════════════════════════════════
  // 실물 67건 중 21건이 이 폴백을 탔다. 저장될 값: "정제수"(6) · "주정" · "옥수수" · "륨" 등.
  const gateParams = (productName) => ({
    barcode: null,
    productInfo: productName === undefined ? {} : { product_name: productName, food_type: '음료' },
    ocrResult: { corrected_text: LABEL_NO_NAME },
    analysis: {
      nutrition: { calories: 40, sodium: 10, total_sugars: 9, _basis: 'per_100ml' },
      // ★ 첫 원재료가 `정제수` 다 — 종전 폴백이라면 이것이 제품명이 된다.
      ingredients: [{ name: '정제수' }, { name: '설탕' }],
      allergens: [], allergens_v2: null, product_meta: {},
    },
    avgConfidence: 0.95,
  });

  await t('★★★ 제품명이 없으면 저장하지 않는다 (첫 원재료 "정제수" 로 채우지 않는다)', async () => {
    const r = await crowdsource.saveOcrContribution(gateParams(undefined));
    assert.strictEqual(r.saved, false, '제품명 없이 저장됐다 — 폴백이 살아 있다');
    assert.strictEqual(r.reason_code, 'PRODUCT_NAME_REQUIRED');
    assert.ok(/제품명/.test(r.rejectReason || ''), `사유가 제품명 얘기가 아니다: ${r.rejectReason}`);
  });

  await t('★ 빈 문자열·공백만 있는 제품명도 반려된다', async () => {
    for (const bad of ['', '   ', '\t\n']) {
      const r = await crowdsource.saveOcrContribution(gateParams(bad));
      assert.strictEqual(r.saved, false, `공백(${JSON.stringify(bad)})이 통과했다`);
      assert.strictEqual(r.reason_code, 'PRODUCT_NAME_REQUIRED');
    }
  });

  await t('★★★ 반려된 요청은 DB 에 «아무 흔적도» 남기지 않는다 (오염 0)', async () => {
    const dirty = await db.query(
      `SELECT product_name FROM products
       WHERE product_name IN ('정제수','주정','옥수수','원유','륨','국산 원유','(OCR 분석 제품)','(OCR 분석)')`);
    assert.strictEqual(dirty.rows.length, 0,
      `오염된 제품명이 DB 에 들어갔다: ${JSON.stringify(dirty.rows.map((x) => x.product_name))}`);
  });

  await t('대조군 — 제품명이 있으면 정상 저장된다 (게이트가 과하게 막지 않는다)', async () => {
    const r = await crowdsource.saveOcrContribution({
      ...gateParams('사이다맛음료'),
      barcode: 'S64GATEOK01',
      deviceId: 'dev-s64-gate',
    });
    assert.strictEqual(r.saved, true, `정상 요청이 반려됐다: ${r.rejectReason}`);
    const row = await db.query("SELECT product_name FROM products WHERE barcode = 'S64GATEOK01'");
    assert.strictEqual(row.rows[0].product_name, '사이다맛음료');
  });

  // ════════════════════════════════════════════════════════════════════════
  server.close();
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
