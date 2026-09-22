/**
 * test_multi_photo_nutrition_pick.js — 세션70 U69-2 «/multi-photo 영양 컷 빈 객체 truthy»
 * ============================================================================
 * 무엇을 지키는가
 *   `analyzeText` 는 영양표가 하나도 없어도 `nutrition` 을 **항상 객체**(`{_basis:'unknown'}`)로
 *   돌려준다. 종전 `/multi-photo` 병합은 `nutritionAnalysis?.nutrition || labelAnalysis?.nutrition || {}`
 *   였으므로 — 영양성분 컷을 보냈는데 그 컷에서 표를 못 읽으면 **라벨 컷의 영양값이 영원히 무시**됐다.
 *   세션44 치명B(빈 객체 truthy)가 `product_meta`·`allergens_v2` 는 고치고 «영양 축만» 남긴 것.
 *   세션69 검증자 발견(`.tmp/s69/검증_보고.md` 빠뜨린 위험 1).
 *
 *   ① `countNutrientValues` 순수 함수 — 메타(`_basis`·serving_size)는 세지 않는다
 *   ② `POST /api/ocr/multi-photo` — 영양표 컷에 표가 없고 라벨 컷에 있으면 라벨 컷 값이 올라온다
 *   ③ 대조군 — 영양표 컷에 표가 있으면 종전처럼 영양표 컷이 이긴다(라벨 컷에도 표가 있어도)
 *   ④ ⛔ 키 단위로 섞지 않는다 — 고른 쪽에 없는 키를 다른 쪽에서 가져오지 않는다(기준이 둘이 된다)
 *   ⑤ 라벨 컷 폴백 + 사용자 수정 → `_dv_check` 는 고친 값 기준(U68-6 과 결합)
 *
 * ★ 하니스는 `test_dv_check_remerge.js` 와 같다 — pglite 정본 SQL · Vision 스텁 · 진짜 라우터 HTTP.
 *   파서는 스텁하지 않는다.
 *
 * 실행: cross-env NODE_ENV=test node tests/test_multi_photo_nutrition_pick.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');

const SRV = path.join(__dirname, '..');
const BASELINE = path.join(SRV, 'scripts', 'migrations', '000_baseline.sql');
const MIG_021 = path.join(SRV, 'scripts', 'migrations', '021_supabase_auth.sql');
const SECRET = 'test-supabase-jwt-secret-0123456789';
process.env.SUPABASE_JWT_SECRET = SECRET;
const TEST_TOKEN = (() => {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({
    iss: 'https://lrnuqhpgyuizfggxgxpl.supabase.co/auth/v1',
    sub: '3f1c2a5e-9b47-4d81-a2f3-6c0e5d8b1a70', aud: 'authenticated',
    role: 'authenticated', aal: 'aal1', session_id: 'ffffffff-1111-4222-8333-444444444470',
    email: 'nutrition-pick-test@example.com', iat: now, exp: now + 3600,
  }, SECRET, { algorithm: 'HS256', noTimestamp: true });
})();

let pass = 0;
let fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; failures.push({ name, message: e.stack || e.message }); console.log(`  ❌ ${name}\n     → ${e.message}`); }
}
function section(title) { console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`); }

// 라벨 컷: 제품 메타 + 원재료 + (영양표가 «라벨 쪽에» 인쇄된 정상 케이스)
const LABEL_WITH_TABLE = [
  '제품명: 삼치구이',
  '식품유형: 조리식품',
  '원재료명: 삼치, 정제소금',
  '영양성분 1회 제공량 60g당',
  '열량 80kcal',
  '나트륨 300mg 15%',
  '탄수화물 1g 0%',
  '당류 0g 0%',
  '지방 42g 8%',
  '포화지방 1.1g 7%',
  '단백질 12g 22%',
].join('\n');
// 라벨 컷: 표 없음
const LABEL_NO_TABLE = '제품명: 삼치구이\n식품유형: 조리식품\n원재료명: 삼치, 정제소금';
// 영양표 컷: 표 없음(흐린 사진 · 딴 면을 찍음) — analyzeText 는 그래도 `{_basis:'unknown'}` 을 준다
const NUT_NO_TABLE = '유통기한: 2027.01.01\n보관방법: 냉동보관';
// 영양표 컷: 표 있음 · 라벨 컷과 «다른» 값(어느 쪽이 이겼는지 값으로 구분한다)
const NUT_WITH_TABLE = [
  '영양정보 총 내용량 120g당',
  '열량 160kcal',
  '나트륨 600mg 30%',
  '탄수화물 2g 1%',
  '단백질 24g 44%',
].join('\n');

function buildMultipart(fields, files) {
  const boundary = '----meokseonS70Boundary' + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  }
  for (const [name, buf] of Object.entries(files)) {
    if (!buf) continue;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`, 'utf8'));
    chunks.push(buf);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(' test_multi_photo_nutrition_pick — 세션70 U69-2 영양 컷 빈 객체 truthy');
  console.log('════════════════════════════════════════════════════════════════');

  // ════════════════════════════════════════════════════════════════════════
  section('§1. countNutrientValues 순수 함수');
  // ════════════════════════════════════════════════════════════════════════
  const { analyzeText, countNutrientValues, NUTRIENT_KEYS } = require('../src/services/ocrParser');

  await t('★ 표 없는 원문의 nutrition 은 객체(truthy)지만 값은 0개다 — 이것이 결함의 원인', () => {
    const n = analyzeText(NUT_NO_TABLE).nutrition;
    assert.ok(n && typeof n === 'object', 'analyzeText 가 nutrition 을 객체로 안 준다 — 전제가 바뀌었다');
    assert.ok(!!n, '빈 객체가 falsy 가 됐다 — 전제가 바뀌었다(그러면 이 테스트의 결함은 없다)');
    assert.strictEqual(countNutrientValues(n), 0);
  });
  await t('표 있는 원문은 값 개수가 양수다', () => {
    assert.strictEqual(countNutrientValues(analyzeText(LABEL_WITH_TABLE).nutrition), 7);
    assert.strictEqual(countNutrientValues(analyzeText(NUT_WITH_TABLE).nutrition), 4);
  });
  await t('메타(_basis · serving_size · total_content)는 세지 않는다', () => {
    assert.strictEqual(countNutrientValues({ _basis: 'per_serving', serving_size: 60, serving_unit: 'g', total_content: 120 }), 0);
    assert.strictEqual(countNutrientValues({ _basis: 'per_serving', serving_size: 60, sodium: 300 }), 1);
  });
  await t('null · 문자열 · NaN 은 값이 아니다 · 객체가 아니면 0', () => {
    assert.strictEqual(countNutrientValues({ calories: null, sodium: '300', protein: NaN, total_fat: Infinity }), 0);
    assert.strictEqual(countNutrientValues(null), 0);
    assert.strictEqual(countNutrientValues(undefined), 0);
    assert.strictEqual(countNutrientValues('x'), 0);
  });
  await t('NUTRIENT_KEYS 는 파서의 단일 패턴 키와 같다(목록을 손으로 박지 않는다)', () => {
    assert.ok(Array.isArray(NUTRIENT_KEYS) && NUTRIENT_KEYS.length >= 10);
    for (const k of ['calories', 'sodium', 'total_fat', 'saturated_fat', 'protein', 'total_sugars', 'total_carbs']) {
      assert.ok(NUTRIENT_KEYS.includes(k), `${k} 가 NUTRIENT_KEYS 에 없다`);
    }
    assert.ok(Object.isFrozen(NUTRIENT_KEYS));
  });

  // ════════════════════════════════════════════════════════════════════════
  // HTTP 하니스 (test_dv_check_remerge.js 와 같다)
  // ════════════════════════════════════════════════════════════════════════
  let PGlite;
  try { ({ PGlite } = require('@electric-sql/pglite')); }
  catch (_) { console.log('⏭  pglite 미설치 — 라우터 경로를 검증할 수 없다. EXIT=1'); process.exit(1); }
  const db = new PGlite();
  await db.exec(fs.readFileSync(BASELINE, 'utf8'));
  await db.exec(fs.readFileSync(MIG_021, 'utf8'));
  const shim = {
    pool: null,
    query: (text, params) => db.query(text, params || []),
    transaction: async (cb) => {
      await db.exec('BEGIN');
      try { const r = await cb({ query: (tx, p) => db.query(tx, p || []) }); await db.exec('COMMIT'); return r; }
      catch (e) { await db.exec('ROLLBACK'); throw e; }
    },
    healthCheck: async () => ({ status: 'healthy' }),
  };
  const dbPath = require.resolve('../src/config/database');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };

  const visionQueue = [];
  const ocrSvcPath = require.resolve('../src/services/ocrService');
  require.cache[ocrSvcPath] = {
    id: ocrSvcPath, filename: ocrSvcPath, loaded: true,
    exports: {
      callVisionAPI: async () => ({ full_text: visionQueue.length ? visionQueue.shift() : '', avg_confidence: 0.95, block_count: 3, elapsed_ms: 1 }),
      correctOcrText: (txt) => ({ corrected: txt, corrections: [] }),
    },
  };
  const loggerPath = require.resolve('../src/config/logger');
  require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } };

  const express = require('express');
  const ocrRoutes = require('../src/routes/ocrRoutes');
  const { errorHandler } = require('../src/middleware/errorHandler');
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/ocr', ocrRoutes);
  app.use(errorHandler);
  const server = app.listen(0);
  const port = server.address().port;

  function request(method, urlPath, { headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
      const h = { authorization: `Bearer ${TEST_TOKEN}`, ...headers };
      let payload = null;
      if (Buffer.isBuffer(body)) { payload = body; h['content-length'] = body.length; }
      else if (body !== null) { payload = Buffer.from(JSON.stringify(body), 'utf8'); h['content-type'] = 'application/json'; h['content-length'] = payload.length; }
      const req = http.request({ method, hostname: '127.0.0.1', port, path: urlPath, headers: h }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { let parsed = null; try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; } resolve({ status: res.statusCode, body: parsed }); });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  // ★ 라벨 컷이 먼저, 영양표 컷이 뒤 — 라우터가 Vision 을 부르는 순서(label → nutrition)와 같다.
  async function callMultiPhoto({ labelText, nutritionText, productInfo }) {
    visionQueue.length = 0;
    const files = {};
    if (labelText !== undefined) { visionQueue.push(labelText); files.label_image = Buffer.from('fakejpeg-label'); }
    if (nutritionText !== undefined) { visionQueue.push(nutritionText); files.nutrition_image = Buffer.from('fakejpeg-nut'); }
    const fields = { save: 'false' };
    if (productInfo !== undefined) fields.product_info = JSON.stringify(productInfo);
    const { body, contentType } = buildMultipart(fields, files);
    return request('POST', '/api/ocr/multi-photo', { headers: { 'content-type': contentType }, body });
  }

  // ════════════════════════════════════════════════════════════════════════
  section('§2. POST /api/ocr/multi-photo — 영양표 컷에 표가 없으면 라벨 컷 영양을 쓴다');
  // ════════════════════════════════════════════════════════════════════════
  await t('★★★ 영양표 컷 표 없음 + 라벨 컷 표 있음 → 라벨 컷 값(나트륨 300 · 단백질 12)이 올라온다', async () => {
    const r = await callMultiPhoto({ labelText: LABEL_WITH_TABLE, nutritionText: NUT_NO_TABLE });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const n = r.body.data.analysis.nutrition;
    assert.strictEqual(n.sodium, 300, `라벨 컷 영양이 무시됐다(빈 객체 truthy): ${JSON.stringify(n)}`);
    assert.strictEqual(n.protein, 12);
    assert.strictEqual(n.total_fat, 42);
    assert.strictEqual(countNutrientValues(n), 7);
  });
  await t('★ 같은 입력이면 원재료·메타는 종전처럼 라벨 컷에서 온다(영양만 고친 것이다)', async () => {
    const r = await callMultiPhoto({ labelText: LABEL_WITH_TABLE, nutritionText: NUT_NO_TABLE });
    const a = r.body.data.analysis;
    assert.ok(Array.isArray(a.ingredients) && a.ingredients.length >= 1, `원재료가 비었다: ${JSON.stringify(a.ingredients)}`);
    assert.strictEqual(a.product_meta?.product_name, '삼치구이');
  });
  await t('대조군: 영양표 컷 표 있음 + 라벨 컷 표 없음 → 영양표 컷 값(나트륨 600)', async () => {
    const r = await callMultiPhoto({ labelText: LABEL_NO_TABLE, nutritionText: NUT_WITH_TABLE });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const n = r.body.data.analysis.nutrition;
    assert.strictEqual(n.sodium, 600);
    assert.strictEqual(n.protein, 24);
  });
  await t('대조군: 두 컷 모두 표 있음 → 영양표 컷이 이긴다(종전 우선순위 유지 · 값 개수가 적어도)', async () => {
    // 라벨 컷 7개 > 영양표 컷 4개 — 그래도 영양표 컷이 «표를 읽었으면» 영양표 컷이 이긴다.
    //   ⚠ 여기서 「값이 많은 쪽」으로 바꾸면 영양표 컷을 따로 찍은 의미(세션42)가 사라진다.
    const r = await callMultiPhoto({ labelText: LABEL_WITH_TABLE, nutritionText: NUT_WITH_TABLE });
    const n = r.body.data.analysis.nutrition;
    assert.strictEqual(n.sodium, 600, `라벨 컷이 영양표 컷을 이겼다: ${JSON.stringify(n)}`);
    assert.strictEqual(n.protein, 24);
  });
  await t('⛔ 키 단위로 섞지 않는다 — 영양표 컷이 이기면 라벨 컷에만 있던 지방·포화지방은 오지 않는다', async () => {
    const r = await callMultiPhoto({ labelText: LABEL_WITH_TABLE, nutritionText: NUT_WITH_TABLE });
    const n = r.body.data.analysis.nutrition;
    assert.strictEqual(n.total_fat, undefined, `기준이 다른 두 표가 섞였다: total_fat=${n.total_fat}`);
    assert.strictEqual(n.saturated_fat, undefined);
    assert.strictEqual(n.total_sugars, undefined);
  });
  await t('둘 다 표 없음 → 200 · 값 0개 · 신호등 없음(추정하지 않는다)', async () => {
    const r = await callMultiPhoto({ labelText: LABEL_NO_TABLE, nutritionText: NUT_NO_TABLE });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const n = r.body.data.analysis.nutrition;
    assert.strictEqual(countNutrientValues(n), 0);
    assert.ok(r.body.data.analysis.traffic_light === null || r.body.data.analysis.traffic_light === undefined,
      `값이 없는데 신호등이 나왔다: ${JSON.stringify(r.body.data.analysis.traffic_light)}`);
  });
  await t('영양표 컷만 보냄(라벨 컷 없음) → 종전과 같다', async () => {
    const r = await callMultiPhoto({ nutritionText: NUT_WITH_TABLE });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.data.analysis.nutrition.sodium, 600);
  });

  // ════════════════════════════════════════════════════════════════════════
  section('§3. 라벨 컷 폴백 + 사용자 수정 — U68-6 과 결합');
  // ════════════════════════════════════════════════════════════════════════
  await t('★ 폴백으로 올라온 라벨 컷 값(지방 42)에 %열 의심이 붙는다 — 값이 올라와야 재검증이 있다', async () => {
    const r = await callMultiPhoto({ labelText: LABEL_WITH_TABLE, nutritionText: NUT_NO_TABLE });
    const n = r.body.data.analysis.nutrition;
    assert.ok(n._dv_check, '라벨 컷 값이 올라왔는데 _dv_check 가 없다');
    assert.strictEqual(n._dv_check.suspects.length, 1);
    assert.strictEqual(n._dv_check.suspects[0].key, 'total_fat');
    assert.strictEqual(n._dv_check.suspects[0].hypothesis, 4.2);
  });
  await t('★ 폴백 + 사용자가 42→4.2 로 고침 → suspects=[] (고친 값 기준 재검증)', async () => {
    const r = await callMultiPhoto({ labelText: LABEL_WITH_TABLE, nutritionText: NUT_NO_TABLE, productInfo: { nutrition: { total_fat: 4.2 } } });
    const n = r.body.data.analysis.nutrition;
    assert.strictEqual(n.total_fat, 4.2);
    assert.strictEqual(n.sodium, 300, '사용자 수정이 라벨 컷 폴백 값을 지웠다');
    assert.ok(n._dv_check, '_dv_check 가 없다');
    assert.deepStrictEqual(n._dv_check.suspects, []);
  });

  server.close();
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(` 결과: ${pass}/${pass + fail} 통과 · ${fail} 실패`);
  if (fail > 0) { console.log('\n실패 상세:'); for (const f of failures) console.log(`  - ${f.name}\n    ${f.message}`); }
  console.log('════════════════════════════════════════════════════════════════\n');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
