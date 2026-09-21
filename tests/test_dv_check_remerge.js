/**
 * test_dv_check_remerge.js — 세션69 U68-6 «사용자 수정 뒤 %열 재검증»
 * ============================================================================
 * 무엇을 지키는가
 *   세션68 이 `parseNutrition` 에 `_dv_check`(라벨 %열 교차검증)를 붙였다. 그런데 라우트는
 *   그 «뒤»에 사용자 수정값(`productInfo.nutrition`)을 병합한다. 사용자가 앱에서 42→4.2 로 고쳐
 *   보내도 `suspects[{parsed:42}]` 가 그대로 저장돼 검토 큐에 **거짓 붉은 배지**가 떴다
 *   (세션68 검증자 발견 · 인수인계 177 §0-0 위험 3).
 *
 *   ① `applyDvCheck` 순수 함수 — 낡은 것을 버리고 현재 값으로 다시 만든다 · 삼중항 0 이면 안 붙인다
 *   ② `POST /api/ocr/analyze` — 사용자가 고친 뒤 suspects 가 비고, 대조군(무수정)은 남는다
 *   ③ `POST /api/ocr/multi-photo` save=false → `/confirm` — **DB 에 저장된** `parsed_nutrition._dv_check`
 *      가 «고친 값» 기준이다 (검토 큐가 읽는 바로 그 자리)
 *   ④ 앱이 `analysis.nutrition` 을 통째로 되돌려 보내도(`_dv_check` 포함) 낡은 것이 덮어쓰지 않는다
 *
 * ★ 하니스는 `test_ocr_confirm.js` 와 같다 — pglite 정본 SQL · Vision 스텁 · 진짜 라우터 HTTP.
 *   파서는 스텁하지 않는다.
 *
 * 실행: cross-env NODE_ENV=test node tests/test_dv_check_remerge.js
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
    sub: '3f1c2a5e-9b47-4d81-a2f3-6c0e5d8b1a69', aud: 'authenticated',
    role: 'authenticated', aal: 'aal1', session_id: 'ffffffff-1111-4222-8333-444444444469',
    email: 'dv-remerge-test@example.com', iat: now, exp: now + 3600,
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

// 세션67 삼치구이형 — 지방 «42g 8%» 는 소수점 손실(4.2). 8%×54g = 4.32 → 4.2 표기 반올림 허용.
const LABEL_DECIMAL_LOST = [
  '제품명: 삼치구이',
  '식품유형: 조리식품',
  // ⚠ 「영양정보 1회 제공량 60g」은 basis=unknown → BASIS_UNKNOWN 게이트가 parsed_nutrition 을 null 로 만든다.
  //   «당» 이 붙어야 per_serving 으로 읽힌다(detectNutritionBasis). 이 테스트의 관심사가 아니므로 통과형으로.
  '영양성분 1회 제공량 60g당',
  '열량 80kcal',
  '나트륨 300mg 15%',
  '탄수화물 1g 0%',
  '당류 0g 0%',
  '지방 42g 8%',
  '포화지방 1.1g 7%',
  '단백질 12g 22%',
].join('\n');

function buildMultipart(fields, files) {
  const boundary = '----meokseonS69Boundary' + Math.random().toString(16).slice(2);
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
  console.log(' 세션69 U68-6 — 사용자 수정 뒤 _dv_check 재검증 (거짓 붉은 배지 차단)');
  console.log('════════════════════════════════════════════════════════════════');

  // ════════════════════════════════════════════════════════════════════════
  section('§1. applyDvCheck 순수 함수');
  // ════════════════════════════════════════════════════════════════════════
  const { applyDvCheck, dvCheck } = require('../src/services/labelDvCheck');
  const { analyzeText } = require('../src/services/ocrParser');

  await t('OCR 값(42)으로는 suspects 가 있고, 4.2 로 고친 뒤 다시 부르면 suspects 가 비고 status=ok', () => {
    const a = analyzeText(LABEL_DECIMAL_LOST);
    assert.strictEqual(a.nutrition.total_fat, 42, '전제: 파서가 42 로 읽어야 한다');
    assert.strictEqual(a.nutrition._dv_check.suspects.length, 1);
    assert.strictEqual(a.nutrition._dv_check.suspects[0].hypothesis, 4.2);
    const merged = { ...a.nutrition, total_fat: 4.2 };
    const out = applyDvCheck(merged, LABEL_DECIMAL_LOST);
    assert.strictEqual(out, merged, '같은 객체를 돌려줘야 한다(라우트가 참조를 그대로 쓴다)');
    assert.deepStrictEqual(merged._dv_check.suspects, []);
    assert.strictEqual(merged._dv_check.checked.total_fat.status, 'ok');
    assert.strictEqual(merged._dv_check.checked.total_fat.value, 4.2);
  });

  await t('값은 고치지 않는다(P1) — 고친 값이 %와 «안 맞아도» 값 그대로, suspects 로만 말한다', () => {
    const merged = { ...analyzeText(LABEL_DECIMAL_LOST).nutrition, total_fat: 50 };
    applyDvCheck(merged, LABEL_DECIMAL_LOST);
    assert.strictEqual(merged.total_fat, 50);
    assert.strictEqual(merged._dv_check.suspects.length, 1);
    assert.strictEqual(merged._dv_check.suspects[0].parsed, 50);
  });

  await t('낡은 _dv_check(사용자 쪽에서 되돌아온 것)는 «버린다» — 병합으로 덮어써도 남지 않는다', () => {
    const stale = { checked: { total_fat: { value: 42, pct: 8, status: 'mismatch' } }, suspects: [{ key: 'total_fat', parsed: 42 }] };
    const merged = { calories: 80, total_fat: 4.2, _dv_check: stale };
    applyDvCheck(merged, LABEL_DECIMAL_LOST);
    assert.notStrictEqual(merged._dv_check, stale);
    assert.deepStrictEqual(merged._dv_check.suspects, []);
  });

  await t('삼중항이 하나도 없으면 _dv_check 를 붙이지 않는다 — 낡은 것도 지운다 (「검사 안 함」≠「이상 없음」)', () => {
    const merged = { calories: 80, total_fat: 4.2, _dv_check: { checked: {}, suspects: [] } };
    applyDvCheck(merged, '열량 80kcal\n지방 4.2g');
    assert.ok(!('_dv_check' in merged), '삼중항 0 인데 _dv_check 가 붙어 있다');
    applyDvCheck(merged, '');
    assert.ok(!('_dv_check' in merged));
  });

  await t('객체가 아니면 그대로 돌려준다(null · undefined) — 라우트 방어', () => {
    assert.strictEqual(applyDvCheck(null, LABEL_DECIMAL_LOST), null);
    assert.strictEqual(applyDvCheck(undefined, LABEL_DECIMAL_LOST), undefined);
  });

  await t('파서 6단계와 같은 규칙이다 — parseNutrition 결과 == applyDvCheck 결과 (출처 하나)', () => {
    const a = analyzeText(LABEL_DECIMAL_LOST).nutrition;
    const copy = { ...a };
    delete copy._dv_check;
    applyDvCheck(copy, LABEL_DECIMAL_LOST);
    assert.deepStrictEqual(copy._dv_check, a._dv_check);
    assert.deepStrictEqual(copy._dv_check, dvCheck(a, LABEL_DECIMAL_LOST));
  });

  // ════════════════════════════════════════════════════════════════════════
  // HTTP 하니스
  // ════════════════════════════════════════════════════════════════════════
  let PGlite;
  try { ({ PGlite } = require('@electric-sql/pglite')); }
  catch (_) { console.log('⏭  pglite 미설치 — 저장 경로를 검증할 수 없다. EXIT=1'); process.exit(1); }
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
  const FAKE_IMG = Buffer.from('x'.repeat(400)).toString('base64');   // /analyze 는 base64 길이 ≥100 만 본다
  async function callAnalyze({ text, productInfo }) {
    visionQueue.length = 0; visionQueue.push(text);
    const body = { image: FAKE_IMG };
    if (productInfo !== undefined) body.product_info = productInfo;
    return request('POST', '/api/ocr/analyze', { body });
  }
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
  section('§2. POST /api/ocr/analyze — 사용자 수정 뒤 재검증');
  // ════════════════════════════════════════════════════════════════════════
  await t('대조군: 수정 없이 보내면 suspects 에 42 가 있다 (세션68 동작 회귀 0)', async () => {
    const r = await callAnalyze({ text: LABEL_DECIMAL_LOST });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const n = r.body.data.analysis.nutrition;
    assert.strictEqual(n.total_fat, 42);
    assert.strictEqual(n._dv_check.suspects.length, 1);
    assert.strictEqual(n._dv_check.suspects[0].parsed, 42);
  });

  await t('★ 사용자가 지방을 4.2 로 고쳐 보내면 suspects 가 비고 checked.total_fat=ok', async () => {
    const r = await callAnalyze({ text: LABEL_DECIMAL_LOST, productInfo: { nutrition: { total_fat: 4.2 } } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const n = r.body.data.analysis.nutrition;
    assert.strictEqual(n.total_fat, 4.2, '사용자 값이 이겨야 한다(기존 계약)');
    assert.ok(n._dv_check, '_dv_check 가 사라졌다 — 다른 삼중항(나트륨 등)은 여전히 검사돼야 한다');
    assert.deepStrictEqual(n._dv_check.suspects, [], `거짓 붉은 배지: ${JSON.stringify(n._dv_check.suspects)}`);
    assert.strictEqual(n._dv_check.checked.total_fat.status, 'ok');
    assert.strictEqual(n._dv_check.checked.sodium.status, 'ok', '다른 키의 검사 결과가 유지돼야 한다');
  });

  await t('★ 앱이 analysis.nutrition 을 «통째로» 되돌려 보내도(낡은 _dv_check 포함) 현재 값으로 다시 만든다', async () => {
    const first = await callAnalyze({ text: LABEL_DECIMAL_LOST });
    const echoed = { ...first.body.data.analysis.nutrition, total_fat: 4.2 };   // 앱이 하는 일: 받은 객체를 고쳐서 그대로 보냄
    assert.ok(echoed._dv_check.suspects.length === 1, '전제: 되돌려 보내는 객체에 낡은 suspects 가 있다');
    const r = await callAnalyze({ text: LABEL_DECIMAL_LOST, productInfo: { nutrition: echoed } });
    const n = r.body.data.analysis.nutrition;
    assert.strictEqual(n.total_fat, 4.2);
    assert.deepStrictEqual(n._dv_check.suspects, [], '낡은 _dv_check 가 병합으로 덮어써졌다');
  });

  await t('사용자가 «틀리게» 고치면(50) suspects 에 50 이 실린다 — 값은 안 고치고 말만 한다', async () => {
    const r = await callAnalyze({ text: LABEL_DECIMAL_LOST, productInfo: { nutrition: { total_fat: 50 } } });
    const n = r.body.data.analysis.nutrition;
    assert.strictEqual(n.total_fat, 50);
    assert.strictEqual(n._dv_check.suspects.length, 1);
    assert.strictEqual(n._dv_check.suspects[0].parsed, 50);
  });

  // ════════════════════════════════════════════════════════════════════════
  section('§3. multi-photo → confirm — DB 에 저장되는 parsed_nutrition._dv_check 가 «고친 값» 기준');
  // ════════════════════════════════════════════════════════════════════════
  await t('★★ save=false + 수정값 → /confirm → contributions.data.parsed_nutrition._dv_check.suspects=[]', async () => {
    const r = await callMultiPhoto({
      labelText: '제품명: 삼치구이\n식품유형: 조리식품', nutritionText: LABEL_DECIMAL_LOST, save: 'false',
      barcode: 'S69DVREMERGE1', productInfo: { nutrition: { total_fat: 4.2 } },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const n = r.body.data.analysis.nutrition;
    assert.strictEqual(n.total_fat, 4.2);
    assert.deepStrictEqual(n._dv_check.suspects, [], `응답부터 거짓 배지: ${JSON.stringify(n._dv_check.suspects)}`);
    const tk = r.body.data.analysis_token;
    assert.ok(tk, 'analysis_token 이 없다');
    const c = await request('POST', '/api/ocr/confirm', {
      body: { analysis_token: tk, product_info: { product_name: '삼치구이' }, device_id: 'dev-s69-dv' },
    });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    assert.strictEqual(c.body.data.save_result.saved, true, c.body.data.save_result.rejectReason);
    const row = await db.query(
      `SELECT c.data FROM contributions c JOIN products p ON p.product_id = c.product_id
       WHERE p.barcode = 'S69DVREMERGE1' ORDER BY c.contribution_id DESC LIMIT 1`);
    assert.strictEqual(row.rows.length, 1, '제보 원본이 저장되지 않았다');
    const data = typeof row.rows[0].data === 'string' ? JSON.parse(row.rows[0].data) : row.rows[0].data;
    assert.strictEqual(Number(data.parsed_nutrition.total_fat), 4.2);
    assert.ok(data.parsed_nutrition._dv_check, 'DB 에 _dv_check 가 없다 — 검토 큐가 %열 배지를 못 단다');
    assert.deepStrictEqual(data.parsed_nutrition._dv_check.suspects, [],
      `★ DB 에 낡은 suspects 가 저장됐다(검토 큐 거짓 붉은 배지): ${JSON.stringify(data.parsed_nutrition._dv_check.suspects)}`);
  });

  await t('대조군: save=false 무수정 → /confirm → DB suspects 에 42 (세션68 경로 회귀 0)', async () => {
    const r = await callMultiPhoto({
      labelText: '제품명: 삼치구이\n식품유형: 조리식품', nutritionText: LABEL_DECIMAL_LOST, save: 'false', barcode: 'S69DVREMERGE2',
    });
    const c = await request('POST', '/api/ocr/confirm', {
      body: { analysis_token: r.body.data.analysis_token, product_info: { product_name: '삼치구이' }, device_id: 'dev-s69-dv2' },
    });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    const row = await db.query(
      `SELECT c.data FROM contributions c JOIN products p ON p.product_id = c.product_id
       WHERE p.barcode = 'S69DVREMERGE2' ORDER BY c.contribution_id DESC LIMIT 1`);
    const data = typeof row.rows[0].data === 'string' ? JSON.parse(row.rows[0].data) : row.rows[0].data;
    assert.strictEqual(Number(data.parsed_nutrition.total_fat), 42);
    assert.strictEqual(data.parsed_nutrition._dv_check.suspects.length, 1);
    assert.strictEqual(data.parsed_nutrition._dv_check.suspects[0].hypothesis, 4.2);
  });

  await t('영양표 컷 없이 라벨 컷에만 영양표가 있어도 재검증한다 (원문 폴백: nutrition → label)', async () => {
    const r = await callMultiPhoto({ labelText: LABEL_DECIMAL_LOST, save: 'false', productInfo: { nutrition: { total_fat: 4.2 } } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const n = r.body.data.analysis.nutrition;
    assert.strictEqual(n.total_fat, 4.2);
    assert.ok(n._dv_check, '라벨 컷 원문으로 재검증하지 않았다');
    assert.deepStrictEqual(n._dv_check.suspects, []);
  });

  server.close();
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(` 결과: ${pass}/${pass + fail} 통과 · ${fail} 실패`);
  if (fail > 0) { console.log('\n실패 상세:'); for (const f of failures) console.log(`  - ${f.name}\n    ${f.message}`); }
  console.log('════════════════════════════════════════════════════════════════\n');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('테스트 실행 오류:', e); process.exit(1); });
