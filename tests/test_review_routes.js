/**
 * 관리자 검토 «라우터» 층 — 진짜 express + 진짜 HTTP (세션68 · U67-7 · U67-11)
 * ============================================================
 * 세션67 검증자가 지적한 것: 신설 73건은 전부 «서비스 함수 직접 호출»과 «HTML 순수 블록»이라
 * 라우터 층(경로·상태코드·409 조립·권한)에 회귀 장치가 0건이었다. 이 파일이 그 층이다.
 *
 * 무엇을 지키나
 *   §0 권한 — ADMIN_TOKEN 미설정이면 503 ADMIN_NOT_CONFIGURED · 틀리면 401 (fail-safe)
 *   §1 ★ 라우트 순서 — GET /review/contributions 가 /:productId 에 먹히지 않는다(세션67 §7 금지 항목)
 *   §2 POST …/:reviewId/override (U67-11) — 400 4종 · 404 · 409 2종 · 200 + evidence «병합» + next
 *   §3 POST …/:reviewId/basis — 400 INVALID_BASIS · BASIS_NOTE_REQUIRED · 200 next
 *   §4 POST /verify — INVALID_ACTION 400 · 'retry' 가 어휘 안내에 있다
 *   §5 ★ override → approve 사슬 — HTTP 로 정정 저장 → HTTP 로 승인 → crowd 행에 정정값 · 오타(320g)는 409 OVERRIDE_SANITY_OUTLIER
 * 하니스: pglite(000→023~026) + database/logger shim → adminRoutes 를 «그대로» 마운트 → 임시 포트.
 * ============================================================
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const SRV = path.join(__dirname, '..');
const MIG = path.join(SRV, 'scripts', 'migrations');
let pass = 0, fail = 0; const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; failures.push({ name, message: e.stack || e.message }); console.log(`  ❌ ${name}\n     → ${e.message}`); }
}
const section = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`);

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(' 세션68 — 관리자 검토 라우터 (진짜 express · 진짜 HTTP · pglite)');
  console.log('════════════════════════════════════════════════════════════════');
  let PGlite;
  try { ({ PGlite } = require('@electric-sql/pglite')); }
  catch (_) { console.log('⏭  pglite 미설치 — 「건너뜀」은 「통과」가 아니다. EXIT=1.'); process.exit(1); }

  const db = new PGlite();
  const chain = ['000_baseline.sql', ...fs.readdirSync(MIG).sort().filter((f) => /^(023|024|025|026)_.*\.sql$/.test(f))];
  for (const f of chain) await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
  console.log(`  ⓘ 적용한 마이그레이션: ${chain.join(' · ')}`);

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
  const loggerPath = require.resolve('../src/config/logger');
  require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: { info() {}, warn() {}, error() {}, debug() {} } };

  const express = require('express');
  const adminRoutes = require('../src/routes/adminRoutes');   // ★ 라우터를 «그대로» 마운트한다
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  const server = await new Promise((res) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => res(s)); });
  const PORT = server.address().port;
  const TOKEN = 'test-admin-token-s68';

  const call = (method, p, body, token = TOKEN) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: '/api/admin' + p,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) } },
    (res) => { let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: res.statusCode, body: j, raw: s }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });

  // 픽스처
  let seq = 0;
  const mkProduct = async (name, meta = {}) => { seq++; const r = await db.query(
    `INSERT INTO products (barcode, product_name, data_source, serving_size, serving_unit) VALUES ($1,$2,'ocr_crowdsource',$3,$4) RETURNING product_id`,
    [`S68R_${seq}`, name, meta.serving_size ?? null, meta.serving_unit ?? null]); return Number(r.rows[0].product_id); };
  const mkContribution = async (pid, data) => { const r = await db.query(
    `INSERT INTO contributions (product_id, contribution_type, data, status) VALUES ($1,'ocr_nutrition',$2,'pending') RETURNING contribution_id`, [pid, JSON.stringify(data)]); return Number(r.rows[0].contribution_id); };
  const mkReview = async (cid, pid, axis, status = 'candidate', evidence = null) => { const r = await db.query(
    `INSERT INTO contribution_review (contribution_id, product_id, axis, status, reviewed_by, reviewed_at, evidence) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING review_id`,
    [cid, pid, axis, status, status === 'approved' ? 'jay' : null, status === 'approved' ? new Date() : null, evidence ? JSON.stringify(evidence) : null]); return Number(r.rows[0].review_id); };
  const evidenceOf = async (rid) => { const r = await db.query('SELECT evidence FROM contribution_review WHERE review_id=$1', [rid]); const v = r.rows[0].evidence; return typeof v === 'string' ? JSON.parse(v) : v; };
  const crowdRow = async (pid) => (await db.query('SELECT * FROM nutrition_data_crowd WHERE product_id=$1', [pid])).rows[0] || null;
  const SAMCHI = { _basis: 'per_serving', calories: 80, total_fat: 32, saturated_fat: 1.1, total_carbs: 1, protein: 12, sodium: 300 };

  // ══════════════════════════════════════════════════════════════════════════
  section('§0  권한 fail-safe');
  await t('§0-1 ADMIN_TOKEN 미설정 → 503 ADMIN_NOT_CONFIGURED (모든 요청 차단)', async () => {
    delete process.env.ADMIN_TOKEN;
    const r = await call('GET', '/review/contributions');
    assert.strictEqual(r.status, 503); assert.strictEqual(r.body.error.code, 'ADMIN_NOT_CONFIGURED');
  });
  await t('§0-2 토큰 불일치 → 401 · 토큰 없음 → 401', async () => {
    process.env.ADMIN_TOKEN = TOKEN;
    assert.strictEqual((await call('GET', '/review/contributions', undefined, 'wrong')).status, 401);
    assert.strictEqual((await call('GET', '/review/contributions', undefined, null)).status, 401);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§1  라우트 순서 — 목록이 /:productId 에 먹히지 않는다');
  await t('§1-1 GET /review/contributions → 200 · items 배열 (빈 큐도 오류가 아니다)', async () => {
    const r = await call('GET', '/review/contributions');
    assert.strictEqual(r.status, 200, r.raw);
    assert.ok(Array.isArray(r.body.data.items), '★ items 가 없다 — 목록이 :productId 로 먹혔거나 깨졌다');
    assert.strictEqual(r.body.data.queue_ready, true);
  });
  await t('§1-2 GET /review/contributions/:productId → 존재하면 200 product · 없으면 404', async () => {
    const pid = await mkProduct('§1 상세');
    const ok = await call('GET', '/review/contributions/' + pid);
    assert.strictEqual(ok.status, 200, ok.raw); assert.strictEqual(Number(ok.body.data.product.product_id), pid);
    const no = await call('GET', '/review/contributions/999999');
    assert.strictEqual(no.status, 404, no.raw);
  });
  await t('§1-3 목록에 nutrition 축의 flags·override 필드가 실려 온다(세션68 계약)', async () => {
    const pid = await mkProduct('§1 flags', { serving_size: 60, serving_unit: 'g' });
    const cid = await mkContribution(pid, { parsed_nutrition: SAMCHI });
    await mkReview(cid, pid, 'nutrition', 'candidate', { sanity_warnings: [{ type: 'calorie_deviation', value: 80, limit: 340 }] });
    const r = await call('GET', '/review/contributions?status=candidate&limit=200');
    const it = r.body.data.items.find((x) => Number(x.product_id) === pid);
    assert.ok(it, '방금 만든 제품이 목록에 없다');
    assert.strictEqual(it.axes[0].flags.calorie_check.status, 'mismatch');
    assert.strictEqual(it.axes[0].flags.critical, true);
    assert.strictEqual(it.axes[0].override, null);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§2  POST /review/contributions/:reviewId/override (U67-11)');
  const P2 = await mkProduct('§2 override', { serving_size: 60, serving_unit: 'g' });
  const C2 = await mkContribution(P2, { parsed_nutrition: SAMCHI, ocr_raw_text: 'SECRET_OCR_TEXT_S68', device_id: 'DEVICE_SECRET_S68' });
  const R2 = await mkReview(C2, P2, 'nutrition', 'candidate', { origin: 'crowdsource', merge_median: { calories: 80 } });
  await t('§2-1 400 — values 없음 / 어휘 밖 키 / 음수 / note 없음 (각각 코드가 다르다)', async () => {
    const a = await call('POST', `/review/contributions/${R2}/override`, { note: 'n' });
    assert.strictEqual(a.status, 400); assert.strictEqual(a.body.error.code, 'OVERRIDE_VALUES_REQUIRED');
    const b = await call('POST', `/review/contributions/${R2}/override`, { values: { foo: 1 }, note: 'n' });
    assert.strictEqual(b.status, 400); assert.strictEqual(b.body.error.code, 'INVALID_NUTRIENT_KEY');
    const c = await call('POST', `/review/contributions/${R2}/override`, { values: { total_fat: -1 }, note: 'n' });
    assert.strictEqual(c.status, 400); assert.strictEqual(c.body.error.code, 'INVALID_NUTRIENT_VALUE');
    const d = await call('POST', `/review/contributions/${R2}/override`, { values: { total_fat: 3.2 } });
    assert.strictEqual(d.status, 400); assert.strictEqual(d.body.error.code, 'OVERRIDE_NOTE_REQUIRED');
    const e = await call('POST', `/review/contributions/${R2}/override`, { values: { _basis: 'per_100g' }, note: 'n' });
    assert.strictEqual(e.status, 400, '★ 언더스코어 키(기준)를 override 로 바꾸는 우회로가 열렸다');
    assert.strictEqual((await evidenceOf(R2)).admin_override, undefined, '400 인데 evidence 가 바뀌었다');
  });
  await t('§2-2 404 없는 review · 409 nutrition 아닌 축', async () => {
    const a = await call('POST', `/review/contributions/999999/override`, { values: { total_fat: 1 }, note: 'n' });
    assert.strictEqual(a.status, 404); assert.strictEqual(a.body.error.code, 'REVIEW_NOT_FOUND');
    const cid = await mkContribution(P2, { parsed_ingredients: ['정제수'] });
    const rid = await mkReview(cid, P2, 'ingredients');
    const b = await call('POST', `/review/contributions/${rid}/override`, { values: { total_fat: 1 }, note: 'n' });
    assert.strictEqual(b.status, 409); assert.strictEqual(b.body.error.code, 'AXIS_NOT_NUTRITION');
  });
  await t('§2-3 200 — evidence 에 «병합»되고(merge_median 생존) next=approve · 원본 무접촉', async () => {
    const r = await call('POST', `/review/contributions/${R2}/override`,
      { values: { total_fat: '3.2', sodium: null }, note: '라벨 지방 3.2g 육안 확인', reviewed_by: '제이' });
    assert.strictEqual(r.status, 200, r.raw);
    assert.strictEqual(r.body.data.next, 'approve');
    assert.deepStrictEqual(r.body.data.admin_override.values, { total_fat: 3.2, sodium: null });
    const ev = await evidenceOf(R2);
    assert.ok(ev.merge_median, '★ evidence 를 덮어써서 병합 판정이 사라졌다');
    assert.strictEqual(ev.admin_override.values.total_fat, 3.2);
    assert.strictEqual(ev.admin_override.by, '제이');
    assert.ok(ev.admin_override.at);
    const d = (await db.query('SELECT data FROM contributions WHERE contribution_id=$1', [C2])).rows[0].data;
    const dd = typeof d === 'string' ? JSON.parse(d) : d;
    assert.strictEqual(dd.parsed_nutrition.total_fat, 32, '★ contributions.data 가 바뀌었다(Q1 위반)');
  });
  await t('§2-4 두 번째 정정은 «통째로 교체» — 이전 키가 섞이지 않는다', async () => {
    const r = await call('POST', `/review/contributions/${R2}/override`, { values: { total_fat: 3.3 }, note: '재확인' });
    assert.strictEqual(r.status, 200);
    const ev = await evidenceOf(R2);
    assert.deepStrictEqual(ev.admin_override.values, { total_fat: 3.3 }, 'sodium:null 이 남아 있으면 부분 병합이다');
  });
  await t('§2-5 보류(approved + 미반영) 행은 next=retry · 이미 반영된 행은 409 ALREADY_APPLIED', async () => {
    const pid = await mkProduct('§2 held', { serving_size: 60, serving_unit: 'g' });
    const cid = await mkContribution(pid, { parsed_nutrition: { calories: 60 } });   // 기준 없음 → 보류될 제보
    const rid = await mkReview(cid, pid, 'nutrition', 'approved');
    const r = await call('POST', `/review/contributions/${rid}/override`, { values: { calories: 61 }, note: 'n' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.data.next, 'retry');
    await db.query(`UPDATE contribution_review SET applied_at = now() WHERE review_id=$1`, [rid]);
    const x = await call('POST', `/review/contributions/${rid}/override`, { values: { calories: 62 }, note: 'n' });
    assert.strictEqual(x.status, 409); assert.strictEqual(x.body.error.code, 'ALREADY_APPLIED');
    assert.strictEqual((await evidenceOf(rid)).admin_override.values.calories, 61, '409 인데 evidence 가 바뀌었다');
  });
  await t('§2-6 GET 상세에 override·effective 가 실려 온다(예고)', async () => {
    const r = await call('GET', '/review/contributions/' + P2);
    const ax = r.body.data.axes.find((a) => Number(a.review_id) === R2);
    assert.deepStrictEqual(ax.override.keys, ['total_fat']);
    assert.strictEqual(ax.effective.nutrition.total_fat, 3.3);
    assert.strictEqual(ax.proposed.nutrition.total_fat, 32);
    assert.ok(!r.raw.includes('SECRET_OCR_TEXT_S68') && !r.raw.includes('DEVICE_SECRET_S68'), 'ocr_raw_text / device_id 가 응답에 새어 나왔다');
    assert.ok(!r.raw.includes('ocr_raw_text'), 'ocr_raw_text 키가 응답에 있다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§3  POST …/basis (세션67 · 라우트 단정 0건이던 것)');
  await t('§3-1 400 INVALID_BASIS · 400 BASIS_NOTE_REQUIRED · 200 next=approve', async () => {
    const pid = await mkProduct('§3 basis');
    const cid = await mkContribution(pid, { parsed_nutrition: { calories: 60 } });
    const rid = await mkReview(cid, pid, 'nutrition', 'candidate');
    const a = await call('POST', `/review/contributions/${rid}/basis`, { basis: 'per_pack', note: 'n' });
    assert.strictEqual(a.status, 400); assert.strictEqual(a.body.error.code, 'INVALID_BASIS');
    const b = await call('POST', `/review/contributions/${rid}/basis`, { basis: 'per_100g' });
    assert.strictEqual(b.status, 400); assert.strictEqual(b.body.error.code, 'BASIS_NOTE_REQUIRED');
    const c = await call('POST', `/review/contributions/${rid}/basis`, { basis: 'per_100g', note: '라벨 100g당 확인' });
    assert.strictEqual(c.status, 200, c.raw); assert.strictEqual(c.body.data.next, 'approve');
    assert.strictEqual((await evidenceOf(rid)).admin_basis.value, 'per_100g');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§4  POST /verify — 어휘');
  await t('§4-1 모르는 action 은 400 INVALID_ACTION · retry 는 어휘에 있다', async () => {
    const a = await call('POST', `/verify/${P2}`, { action: 'bless', reviewed_by: 'jay' });
    assert.strictEqual(a.status, 400); assert.strictEqual(a.body.error.code, 'INVALID_ACTION');
    assert.ok(a.body.error.message.includes('retry'), 'retry 가 어휘 안내에 없다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§5  ★ 사슬 — HTTP 정정 → HTTP 승인 → crowd 행에 정정값');
  await t('§5-1 삼치구이 32g 을 (§2-4 에서 3.3 으로 재정정) 승인하면 crowd 행 total_fat=3.3 · 공공 행 0', async () => {
    const r = await call('POST', `/verify/${P2}`, { action: 'approve', review_ids: [R2], reviewed_by: 'jay' });
    assert.strictEqual(r.status, 200, r.raw);
    const rv = r.body.data.reviews.find((x) => Number(x.review_id) === R2);
    assert.ok(rv && rv.applied === true, JSON.stringify(r.body.data));
    const row = await crowdRow(P2);
    assert.strictEqual(Number(row.total_fat), 3.3);
    assert.strictEqual(Number(row.calories), 80);
    const pub = await db.query('SELECT count(*)::int AS n FROM nutrition_data WHERE product_id=$1', [P2]);
    assert.strictEqual(pub.rows[0].n, 0, '공공 테이블을 건드렸다(DS-7)');
    const ev = await evidenceOf(R2);
    assert.strictEqual(ev.convert.override_from, 'review.evidence.admin_override');
  });

  await t('§5-2 ★ 오타 정정(320g)은 승인 HTTP 에서 409 REVIEW_APPLY_INCOMPLETE · details[].code=OVERRIDE_SANITY_OUTLIER', async () => {
    const pid = await mkProduct('§5 오타', { serving_size: 60, serving_unit: 'g' });
    const cid = await mkContribution(pid, { parsed_nutrition: SAMCHI });
    const rid = await mkReview(cid, pid, 'nutrition', 'candidate');
    const o = await call('POST', `/review/contributions/${rid}/override`, { values: { total_fat: 320 }, note: '오타' });
    assert.strictEqual(o.status, 200);
    const r = await call('POST', `/verify/${pid}`, { action: 'approve', review_ids: [rid], reviewed_by: 'jay' });
    assert.strictEqual(r.status, 409, r.raw);
    assert.strictEqual(r.body.error.code, 'REVIEW_APPLY_INCOMPLETE');
    const d = (r.body.error.details || []).find((x) => Number(x.review_id) === rid);
    assert.ok(d && d.code === 'OVERRIDE_SANITY_OUTLIER', JSON.stringify(r.body.error.details));
    assert.strictEqual(await crowdRow(pid), null, '409 인데 행이 생겼다');
  });

  server.close();
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(` 통과 ${pass} · 실패 ${fail}`);
  if (fail > 0) { console.log('\n실패 상세:'); for (const f of failures) console.log(`\n  ❌ ${f.name}\n${f.message}`); }
  console.log('════════════════════════════════════════════════════════════════\n');
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error('테스트 러너 자체가 죽었다:', e); process.exit(1); });
