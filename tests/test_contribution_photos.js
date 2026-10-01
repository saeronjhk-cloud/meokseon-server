/**
 * ★ 세션72f — 제보 사진 축소본 보관 + 관리자 정정(알레르기·원재료) 통합 테스트 (PGlite · 실제 스키마)
 *   제이 결정 2026-09-30: 라벨 사진 축소본을 비공개 보관(90일) · 관리자 화면에서 사진 보며 정정 → 승인.
 *   §0 030 체인·멱등  §1 형식 검사(바이트를 믿는다)  §2 메모리 임시 보관(1회용·만료·상한)
 *   §3 보관 → 관리자 목록(메타만)·바이트(no-store)  §4 파기 규칙(90일·대기 보호·365일 무조건)
 *   §5 030 미적용 DB — 조용히 건너뜀  §6 알레르기 정정 → 승인 = 정정값 반영
 *   §7 원재료 정정 → 첨가물 형제 행에도 · 승인 = 정정 원문  §8 라우트 배선(정적)
 *   §9 (세션73 U72-15) 사진을 버린 이유 로그 — DISABLED·미전송·TOO_LARGE·NOT_IMAGE · stash/save/confirm 한 줄
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const SRV = path.join(__dirname, '..');
const MIG = path.join(SRV, 'scripts', 'migrations');
const MIG_FILES = fs.readdirSync(MIG);
const migFile = (p) => MIG_FILES.find((x) => x.startsWith(`${p}_`) && x.endsWith('.sql'));

let pass = 0; let fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     → ${e.message.split('\n').slice(0, 6).join('\n       ')}`); }
}
const section = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 70 - s.length))}`);

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
const f = (buf, mimetype = 'image/jpeg') => ({ buffer: buf, mimetype, size: buf.length });

async function main() {
  let PGlite;
  try { ({ PGlite } = require('@electric-sql/pglite')); }
  catch (_) { console.log('⏭  pglite 미설치 — 「건너뜀」은 「통과」가 아니다. EXIT=1.'); process.exit(1); }

  section('§0  030 — 체인 · 멱등');
  await t('§0-1 030 이 migrate 체인에 ON_ERROR_STOP=1 로 029 뒤에 있다', () => {
    const file = migFile('030'); assert.ok(file, '030 파일 없음');
    const chain = String(JSON.parse(fs.readFileSync(path.join(SRV, 'package.json'), 'utf8')).scripts.migrate || '');
    const seg = chain.split('&&').find((x) => x.includes(file));
    assert.ok(seg && /-v\s+ON_ERROR_STOP=1/.test(seg), '체인에 없음/ON_ERROR_STOP 없음');
    assert.ok(chain.indexOf(file) > chain.indexOf(migFile('029')));
  });
  const mkDb = async (with030) => {
    const db = new PGlite();
    await db.exec(fs.readFileSync(path.join(MIG, '000_baseline.sql'), 'utf8'));
    for (const p of ['023', '024', '025', '026', '029']) await db.exec(fs.readFileSync(path.join(MIG, migFile(p)), 'utf8'));
    if (with030) for (let i = 0; i < 2; i++) await db.exec(fs.readFileSync(path.join(MIG, migFile('030')), 'utf8'));
    return db;
  };
  const db = await mkDb(true);
  await t('§0-3 개인정보 최소화 — contribution_photos 에 user_id 컬럼이 없다', async () => {
    const r = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='contribution_photos'`);
    assert.ok(!r.rows.some((x) => x.column_name === 'user_id'), JSON.stringify(r.rows));
  });
  await t('§0-2 030 2회 실행 뒤 테이블·제약 3개', async () => {
    const r = await db.query(`SELECT conname FROM pg_constraint WHERE conname LIKE 'cp_%' ORDER BY 1`);
    assert.deepStrictEqual(r.rows.map((x) => x.conname), ['cp_kind_chk', 'cp_mime_chk', 'cp_size_chk']);
  });

  let cur = db;
  const q = async (text, params) => { const r = await cur.query(text, params || []); if (r && r.rowCount === undefined) r.rowCount = r.affectedRows; return r; };
  const shim = {
    pool: null, query: q,
    transaction: async (cb) => { await cur.exec('BEGIN'); try { const r = await cb({ query: q }); await cur.exec('COMMIT'); return r; } catch (e) { await cur.exec('ROLLBACK'); throw e; } },
    healthCheck: async () => ({ status: 'healthy' }),
  };
  const dbPath = require.resolve('../src/config/database');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };
  const loggerPath = require.resolve('../src/config/logger');
  require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: { info() {}, debug() {}, error() {}, warn() {} } };
  const nPath = require.resolve('../src/services/adminNotify');
  require.cache[nPath] = { id: nPath, filename: nPath, loaded: true, exports: { notifyNewContribution: () => Promise.resolve({}) } };
  process.env.ADMIN_TOKEN = 'S72F-ADMIN';
  process.env.CONTRIBUTION_PHOTOS_ENABLED = 'true';
  const P = require('../src/services/contributionPhotos');
  const crowdsource = require('../src/services/crowdsourceService');
  const express = require('express');
  const app = express(); app.use(express.json()); app.use('/api/admin', require('../src/routes/adminRoutes'));
  const server = app.listen(0); const port = server.address().port;
  const request = (method, p, body) => new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = payload.length; }
    const rq = http.request({ method, hostname: '127.0.0.1', port, path: encodeURI(p), headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const raw = Buffer.concat(chunks); let j = null; try { j = JSON.parse(raw.toString('utf8')); } catch (_) { j = null; } resolve({ status: res.statusCode, headers: res.headers, body: j, raw }); });
    });
    rq.on('error', reject); if (payload) rq.write(payload); rq.end();
  });

  section('§1  형식 검사 — 선언된 mimetype 이 아니라 바이트');
  await t('§1-1 JPEG·PNG 는 받고, 이미지 아닌 바이트는 mimetype 이 image/jpeg 여도 거부', () => {
    assert.strictEqual(P.acceptArchive('label', f(JPEG)).mime, 'image/jpeg');
    assert.strictEqual(P.acceptArchive('nutrition', f(PNG, 'image/png')).mime, 'image/png');
    assert.strictEqual(P.acceptArchive('label', f(Buffer.from('<html>not an image</html>'))), null);
    assert.strictEqual(P.acceptArchive('other', f(JPEG)), null, '모르는 kind');
  });
  await t('§1-2 1.5MB 초과는 거부(030 cp_size_chk 와 같은 상한)', () => {
    const big = Buffer.concat([JPEG.subarray(0, 4), Buffer.alloc(P.MAX_PHOTO_BYTES)]);
    assert.strictEqual(P.acceptArchive('label', f(big)), null);
  });
  await t('§1-4 ★ 스위치 CONTRIBUTION_PHOTOS_ENABLED 가 true 가 아니면 아무것도 받지 않는다(기본 꺼짐)', () => {
    const files = { label_archive: [f(JPEG)] };
    assert.deepStrictEqual(P.archivesFromRequest(files, {}), []);
    assert.deepStrictEqual(P.archivesFromRequest(files, { CONTRIBUTION_PHOTOS_ENABLED: 'false' }), []);
    assert.strictEqual(P.archivesFromRequest(files, { CONTRIBUTION_PHOTOS_ENABLED: 'true' }).length, 1);
  });
  await t('§1-3 archivesFromRequest 는 *_archive 필드만 본다(OCR 원본 label_image 는 보관 안 함)', () => {
    const out = P.archivesFromRequest({ label_image: [f(JPEG)], label_archive: [f(JPEG)], nutrition_archive: [f(PNG, 'image/png')] });
    assert.deepStrictEqual(out.map((x) => x.kind), ['label', 'nutrition']);
  });

  section('§2  메모리 임시 보관');
  await t('§2-1 take 는 한 번만 준다', () => {
    P.stash('tok1', [{ kind: 'label', mime: 'image/jpeg', bytes: JPEG }]);
    assert.strictEqual(P.take('tok1').length, 1);
    assert.strictEqual(P.take('tok1').length, 0);
  });
  await t('§2-2 15분 지나면 없다', () => {
    const now = Date.now();
    P.stash('tok2', [{ kind: 'label', mime: 'image/jpeg', bytes: JPEG }], now);
    assert.strictEqual(P.take('tok2', now + P.STASH_TTL_MS + 1).length, 0);
    assert.strictEqual(P._stashState().bytes, 0, '만료분 바이트 회계가 0 으로 돌아와야 한다');
  });

  section('§3  보관 → 관리자 목록·바이트');
  const report = (o) => ({
    barcode: o.barcode, deviceId: null, avgConfidence: 0.95,
    productInfo: { product_name: o.name, food_type: '과자', content_unit: 'g', total_content: 100, serving_size: 100 },
    ocrResult: { corrected_text: '원재료명: 밀가루, 설탕', corrections: [] },   // 알레르기 표시문 없음 → 자동반영 안 됨(candidate)
    analysis: {
      nutrition: { calories: 480, sodium: 300, total_carbs: 60, total_sugars: 25, total_fat: 22, saturated_fat: 12, trans_fat: 0, cholesterol: 5, protein: 6, dietary_fiber: 2, _basis: 'per_100g' },
      ingredients: [{ name: '밀가루' }, { name: '설탕' }], additives: [],
      allergens: ['밀'], allergens_v2: { contains: ['밀'], inferred: [], mayContain: [] }, product_meta: {},
    },
  });
  const r1 = await crowdsource.saveOcrContribution(report({ barcode: '8800072000011', name: '사진테스트' }));
  const pid = r1.productId;
  await t('§3-0 (전제) 제보 저장 · 알레르기 candidate', async () => {
    assert.ok(r1.saved, r1.rejectReason);
    const rv = (await q(`SELECT axis, status FROM contribution_review WHERE product_id=$1 ORDER BY axis`, [pid])).rows;
    assert.ok(rv.find((x) => x.axis === 'allergens' && x.status === 'candidate'), JSON.stringify(rv));
  });
  await t('§3-1 persist 2장 → 목록은 메타만(bytes·user_id 없음)', async () => {
    const n = await P.persist(shim, { productId: pid, photos: P.archivesFromRequest({ label_archive: [f(JPEG)], nutrition_archive: [f(PNG, 'image/png')] }) });
    assert.strictEqual(n, 2);
    const r = await request('GET', `/api/admin/review/contributions/${pid}/photos`);
    assert.strictEqual(r.status, 200);
    const ph = r.body.data.photos;
    assert.strictEqual(ph.length, 2);
    for (const p of ph) { assert.ok(!('bytes' in p) && !('user_id' in p), JSON.stringify(p)); assert.ok(p.photo_id > 0); }
  });
  await t('§3-2 바이트 = 받은 그대로 · Content-Type · no-store · 없는 번호 404', async () => {
    const list = (await request('GET', `/api/admin/review/contributions/${pid}/photos`)).body.data.photos;
    const lab = list.find((x) => x.kind === 'label');
    const r = await request('GET', `/api/admin/photos/${lab.photo_id}`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.raw.equals(JPEG), '바이트가 다르다');
    assert.strictEqual(r.headers['content-type'], 'image/jpeg');
    assert.ok(/no-store/.test(r.headers['cache-control']));
    assert.strictEqual((await request('GET', '/api/admin/photos/999999')).status, 404);
  });
  await t('§3-3 관리자 토큰 없으면 사진을 못 본다', async () => {
    const r = await new Promise((resolve) => http.get({ hostname: '127.0.0.1', port, path: '/api/admin/photos/1' }, (res) => { res.resume(); resolve(res.statusCode); }));
    assert.ok(r === 401 || r === 403, `status ${r}`);
  });

  section('§4  파기 규칙');
  await t('§4-1 90일 지남+대기 있음=보존 · 대기 없음=삭제 · 365일=무조건 삭제 · 새것=보존', async () => {
    const r2 = await crowdsource.saveOcrContribution(report({ barcode: '8800072000028', name: '파기테스트' }));
    const pid2 = r2.productId;
    await q(`UPDATE contribution_review SET status='rejected', reviewed_by='t', reviewed_at=NOW(), reject_reason='t' WHERE product_id=$1`, [pid2]);
    const ins = async (p, days) => (await q(`INSERT INTO contribution_photos (product_id, kind, mime, byte_size, bytes, created_at)
       VALUES ($1,'label','image/jpeg',$2,$3, NOW() - make_interval(days => $4::int)) RETURNING photo_id`, [p, JPEG.length, JPEG, days])).rows[0].photo_id;
    const keepPending = await ins(pid, 100);     // pid 는 candidate 가 남아 있다
    const dropDone = await ins(pid2, 100);       // pid2 는 대기 없음
    const dropHard = await ins(pid, 400);        // 대기가 있어도 365일 초과
    const keepNew = await ins(pid2, 10);
    const n = await P.purgeExpired(shim);
    const left = new Set((await q(`SELECT photo_id FROM contribution_photos`)).rows.map((x) => String(x.photo_id)));
    assert.strictEqual(n, 2, `지운 수 ${n}`);
    assert.ok(left.has(String(keepPending)) && left.has(String(keepNew)));
    assert.ok(!left.has(String(dropDone)) && !left.has(String(dropHard)));
  });

  section('§5  030 미적용 DB');
  await t('§5-1 persist 0 · list [] · purge 0 · throw 없음', async () => {
    const old = cur; cur = await mkDb(false);
    try {
      assert.strictEqual(await P.persist(shim, { productId: 1, photos: [{ kind: 'label', mime: 'image/jpeg', bytes: JPEG }] }), 0);
      assert.deepStrictEqual(await P.listForProduct(shim, 1), []);
      assert.strictEqual(await P.purgeExpired(shim), 0);
      assert.strictEqual(await P.getPhoto(shim, 1), null);
    } finally { cur = old; }
  });

  const reviewsOf = async (p) => (await q(`SELECT review_id, axis, status, evidence FROM contribution_review WHERE product_id=$1 ORDER BY review_id`, [p])).rows;

  section('§6  알레르기 정정 → 승인');
  await t('§6-1 19종 밖 이름은 400 INVALID_ALLERGEN_NAME', async () => {
    const al = (await reviewsOf(pid)).find((x) => x.axis === 'allergens');
    const r = await request('POST', `/api/admin/review/contributions/${al.review_id}/override`, { values: { allergens: { contains: ['밀', '초콜릿'] } }, note: '사진' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error.code, 'INVALID_ALLERGEN_NAME');
  });
  await t('§6-2 원재료 정정을 알레르기 행에 → 409 AXIS_MISMATCH · 영양 정정을 알레르기 행에 → 409 AXIS_NOT_NUTRITION(종전)', async () => {
    const al = (await reviewsOf(pid)).find((x) => x.axis === 'allergens');
    const a = await request('POST', `/api/admin/review/contributions/${al.review_id}/override`, { values: { ingredients_text: '밀가루' }, note: '사진' });
    assert.strictEqual(a.status, 409); assert.strictEqual(a.body.error.code, 'AXIS_MISMATCH');
    const b = await request('POST', `/api/admin/review/contributions/${al.review_id}/override`, { values: { total_fat: 1 }, note: '사진' });
    assert.strictEqual(b.status, 409); assert.strictEqual(b.body.error.code, 'AXIS_NOT_NUTRITION');
  });
  await t('§6-3 ★ 정정 {함유 밀·우유, 혼입 대두} → 상세 effective 가 정정값 → 승인 → product_allergens 가 정정값', async () => {
    const al = (await reviewsOf(pid)).find((x) => x.axis === 'allergens');
    const o = await request('POST', `/api/admin/review/contributions/${al.review_id}/override`,
      { values: { allergens: { contains: ['밀', '우유'], may_contain: ['대두', '우유'] } }, note: '라벨 사진 확인 · OCR 이 우유를 놓침' });
    assert.strictEqual(o.status, 200, JSON.stringify(o.body));
    const d = await request('GET', `/api/admin/review/contributions/${pid}`);
    const ax = d.body.data.axes.find((x) => x.axis === 'allergens');
    const eff = ax.effective.proposed.allergens.map((x) => `${x.name}:${x.evidence_level}`).sort();
    assert.deepStrictEqual(eff, ['대두:may_contain', '밀:contains', '우유:contains']);
    assert.deepStrictEqual(ax.proposed.allergens.map((x) => x.name), ['밀'], 'proposed(사용자 원본)는 그대로');
    const v = await request('POST', `/api/admin/verify/${pid}`, { action: 'approve', review_ids: [al.review_id], reviewed_by: 'tester' });
    assert.strictEqual(v.status, 200, JSON.stringify(v.body));
    const rows = (await q(`SELECT allergen_name, evidence_level FROM product_allergens WHERE product_id=$1 ORDER BY 1`, [pid])).rows
      .map((x) => `${x.allergen_name}:${x.evidence_level}`);
    assert.deepStrictEqual(rows, ['대두:may_contain', '밀:contains', '우유:contains']);
    const c = await q(`SELECT data FROM contributions WHERE product_id=$1`, [pid]);
    assert.ok(!JSON.stringify(c.rows[0].data).includes('우유'), 'contributions.data(사용자 원본)를 건드렸다');
  });

  section('§7  원재료 정정 → 첨가물 형제 행 · 승인');
  await t('§7-1 ★ ingredients 행 정정 → additives 행에도 같은 override · 승인 시 정정 원문이 저장', async () => {
    const rv = await reviewsOf(pid);
    const ing = rv.find((x) => x.axis === 'ingredients');
    const add = rv.find((x) => x.axis === 'additives');
    assert.ok(ing && add, JSON.stringify(rv.map((x) => x.axis)));
    const text = '밀가루(미국산), 설탕, 쇼트닝(팜유, 대두유), 합성향료(바닐린)';
    const o = await request('POST', `/api/admin/review/contributions/${ing.review_id}/override`, { values: { ingredients_text: text }, note: '라벨 사진 확인' });
    assert.strictEqual(o.status, 200, JSON.stringify(o.body));
    assert.deepStrictEqual(o.body.data.siblings, [Number(add.review_id)]);
    const add2 = (await reviewsOf(pid)).find((x) => x.axis === 'additives');
    const ev = typeof add2.evidence === 'string' ? JSON.parse(add2.evidence) : add2.evidence;
    assert.strictEqual(ev.admin_override.values.ingredients_text, text);
    const v = await request('POST', `/api/admin/verify/${pid}`, { action: 'approve', review_ids: [ing.review_id], reviewed_by: 'tester' });
    assert.strictEqual(v.status, 200, JSON.stringify(v.body));
    const pi = (await q(`SELECT raw_text, parsed_ingredients FROM product_ingredients WHERE product_id=$1`, [pid])).rows;
    assert.strictEqual(pi.length, 1); assert.strictEqual(pi[0].raw_text, text);
    const names = (typeof pi[0].parsed_ingredients === 'string' ? JSON.parse(pi[0].parsed_ingredients) : pi[0].parsed_ingredients);
    assert.deepStrictEqual(names, ['밀가루', '설탕', '쇼트닝', '합성향료']);
  });

  section('§8  라우트 배선 (정적)');
  await t('§8-1 multi-photo 가 *_archive 필드를 받고, 비저장 분석은 stash · /confirm 은 saved 일 때만 persist', () => {
    const src = fs.readFileSync(path.join(SRV, 'src', 'routes', 'ocrRoutes.js'), 'utf8');
    assert.ok(/name: 'label_archive'/.test(src) && /name: 'nutrition_archive'/.test(src));
    assert.ok(/contributionPhotos\.stash\(analysisToken/.test(src));
    assert.ok(/const photos = contributionPhotos\.take\(token\);[\s\S]{0,120}?if \(saveResult && saveResult\.saved\) persistedPhotos = await persistContributionPhotos\(saveResult\.productId, photos\)/.test(src));
  });
  await t('§8-2 server.js 가 파기 타이머를 켠다', () => {
    assert.ok(/startPurgeTimer\(/.test(fs.readFileSync(path.join(SRV, 'src', 'server.js'), 'utf8')));
  });

  section('§9  U72-15 — 사진을 버린 이유가 로그에 남는다');
  const L = require('../src/config/logger');
  const cap = []; const origInfo = L.info;
  L.info = (msg, meta) => cap.push({ msg, meta });
  const BIG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(P.MAX_PHOTO_BYTES + 1, 1)]);
  await t('§9-1 스위치 꺼짐 — 받은 2장 모두 DISABLED · photos=[]', () => {
    const i = P.intakeArchives({ label_archive: [f(JPEG)], nutrition_archive: [f(PNG, 'image/png')] }, {});
    assert.strictEqual(i.enabled, false);
    assert.deepStrictEqual(i.received, ['label', 'nutrition']);
    assert.deepStrictEqual(i.photos, []);
    assert.deepStrictEqual(i.rejected, [{ kind: 'label', reason: 'DISABLED' }, { kind: 'nutrition', reason: 'DISABLED' }]);
  });
  await t('§9-2 앱 미전송 — received=[] (원본 label_image 만 와도 0)', () => {
    const i = P.intakeArchives({ label_image: [f(JPEG)] }, { CONTRIBUTION_PHOTOS_ENABLED: 'true' });
    assert.deepStrictEqual([i.received, i.accepted, i.rejected], [[], [], []]);
  });
  await t('§9-3 켜짐 — 정상 1 · 너무 큼 TOO_LARGE · 이미지 아님 NOT_IMAGE', () => {
    const env = { CONTRIBUTION_PHOTOS_ENABLED: 'true' };
    const a = P.intakeArchives({ label_archive: [f(JPEG)], nutrition_archive: [f(BIG)] }, env);
    assert.deepStrictEqual(a.accepted, ['label']); assert.strictEqual(a.photos.length, 1);
    assert.deepStrictEqual(a.rejected, [{ kind: 'nutrition', reason: 'TOO_LARGE' }]);
    const b = P.intakeArchives({ label_archive: [f(Buffer.alloc(300, 65))] }, env);
    assert.deepStrictEqual(b.rejected, [{ kind: 'label', reason: 'NOT_IMAGE' }]);
  });
  await t('§9-4 archivesFromRequest 는 intake.photos 와 같다(하위 호환)', () => {
    const files = { label_archive: [f(JPEG)], nutrition_archive: [f(PNG, 'image/png')] };
    assert.strictEqual(P.archivesFromRequest(files, { CONTRIBUTION_PHOTOS_ENABLED: 'true' }).length, 2);
    assert.deepStrictEqual(P.archivesFromRequest(files, {}), []);
  });
  await t('§9-5 logIntake — info 한 줄 · 판정 필드 전부 · 사진 바이트 없음 · null 에도 throw 없음', () => {
    cap.length = 0;
    const i = P.intakeArchives({ label_archive: [f(JPEG)] }, {});
    P.logIntake(i, { path: 'stash', stashed: false });
    P.logIntake(null);
    assert.strictEqual(cap.length, 2);
    const m = cap[0].meta;
    assert.strictEqual(cap[0].msg, '제보 사진 축소본 수신');
    assert.deepStrictEqual([m.enabled, m.archives_received, m.accepted, m.path, m.stashed], [false, 1, 0, 'stash', false]);
    assert.deepStrictEqual(m.rejected, [{ kind: 'label', reason: 'DISABLED' }]);
    assert.ok(!JSON.stringify(cap).includes('bytes'), '로그에 바이트가 섞였다');
  });
  await t('§9-6 logConfirm — taken·saved·persisted', () => {
    cap.length = 0;
    P.logConfirm({ taken: 0, saved: true, persisted: 0 });
    assert.strictEqual(cap[0].msg, '제보 사진 축소본 확정');
    assert.deepStrictEqual(cap[0].meta, { taken: 0, saved: true, persisted: 0 });
  });
  await t('§9-7 라우트 배선 — stash·save 두 경로 모두 logIntake · /confirm 은 logConfirm', () => {
    const src = fs.readFileSync(path.join(SRV, 'src', 'routes', 'ocrRoutes.js'), 'utf8');
    assert.ok(/logIntake\(photoIntake, \{ path: 'stash', stashed \}\)/.test(src), 'stash 경로');
    assert.ok(/logIntake\(photoIntake, \{ path: 'save',/.test(src), 'save 경로');
    assert.ok(/contributionPhotos\.logConfirm\(\{ taken: photos\.length/.test(src), 'confirm');
    assert.ok(!/archivesFromRequest\(req\.files\)/.test(src), '조용히 버리는 옛 호출이 남아 있다');
  });
  L.info = origInfo;

  server.close();
  console.log(`\n════ 통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
