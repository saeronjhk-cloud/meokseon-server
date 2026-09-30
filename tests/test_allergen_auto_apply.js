/**
 * ★★★ 세션72 — 알레르기 «자동 반영» 서버 경로 통합 테스트 (PGlite · 실제 스키마 000~026 + 029)
 *
 * 정본 결정: IP/결정_알레르기자동반영_2026-09-29.md — 세션66 C6(전량 수동)의 «첫 예외».
 *   범위: 알레르기 축 · 게이트(allergen_auto_gate_v1) 통과분만. 영양·원재료·첨가물은 전량 수동 그대로.
 * 게이트 품질(치명 0 · 경미 0 · 자동 ≥23)은 tests/test_allergen_auto_gate.js 가 eval 로 지킨다.
 * 이 파일은 «배선»을 지킨다:
 *   §0 029 가 migrate 체인에 ON_ERROR_STOP=1 로 있고, 2회 실행(real-postgres job)에 멱등이다
 *   §1 게이트 통과 제보 → product_allergens(status crowd_auto · detected_via contribution_auto) + review auto_applied
 *      + 영양·원재료·첨가물 축은 여전히 candidate · 공식 테이블 0행
 *   §2 게이트 미통과(잔여 토큰 · 사용자 수정) → 종전 그대로 candidate · product_allergens 0행
 *   §3 소비자 API — allergens_crowd_auto · allergens_may_unconfirmed(혼입 문장 없음 → true, flat_complete false)
 *   §4 등급·상태를 깎지 않는다 — confirmed/admin_verified 는 crowd_auto 로 내려가지 않는다 · 사람 승인은 올린다
 *   §5 관리자 undo 가 auto_applied 를 되돌린다(자기 행만)
 *   §6 applyAutoAllergens 의 자기 방어 — 다른 축 · candidate 아님 · 게이트 미통과는 throw
 *   §7 ★ 029 미적용 DB — 자동 반영이 실패해도 제보는 저장되고 candidate 로 남는다(SAVEPOINT)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const SRV = path.join(__dirname, '..');
const MIG = path.join(SRV, 'scripts', 'migrations');
const BASELINE = path.join(MIG, '000_baseline.sql');
const CHAIN = ['023', '024', '025', '026'];
const MIG_FILES = fs.readdirSync(MIG);
const migFile = (p) => MIG_FILES.find((x) => x.startsWith(`${p}_`) && x.endsWith('.sql'));

let pass = 0; let fail = 0; const fails = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; fails.push({ name, e }); console.log(`  ❌ ${name}\n     → ${e.message.split('\n').slice(0, 6).join('\n       ')}`); }
}
const section = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 70 - s.length))}`);

const GATE_TEXT = '원재료명: 밀가루, 대두유, 설탕\n알레르기 유발물질: 밀, 대두 함유\n이 제품은 우유를 사용한 제품과 같은 제조시설에서 제조';
const NO_MAY_TEXT = '원재료명: 밀가루, 설탕\n알레르기 유발물질: 밀 함유';

async function main() {
  let PGlite;
  try { ({ PGlite } = require('@electric-sql/pglite')); }
  catch (_) { console.log('⏭  pglite 미설치 — 검증 불가. 「건너뜀」은 「통과」가 아니다. EXIT=1.'); process.exit(1); }

  section('§0  029 마이그레이션 — 체인 · 멱등');
  await t('§0-1 029 가 npm run migrate 체인에 ON_ERROR_STOP=1 로 있다', () => {
    const f = migFile('029'); assert.ok(f, '029 파일이 없다');
    const chain = String(JSON.parse(fs.readFileSync(path.join(SRV, 'package.json'), 'utf8')).scripts.migrate || '');
    const seg = chain.split('&&').find((x) => x.includes(f));
    assert.ok(seg, '029 가 체인에 없다(세션64c gate #19 와 같은 사고)');
    assert.ok(/-v\s+ON_ERROR_STOP=1/.test(seg), 'ON_ERROR_STOP=1 없음');
    assert.ok(chain.indexOf(f) > chain.indexOf(migFile('028')), '029 가 028 뒤가 아니다');
  });

  const mkDb = async (with029) => {
    const db = new PGlite();
    await db.exec(fs.readFileSync(BASELINE, 'utf8'));
    for (const p of CHAIN) await db.exec(fs.readFileSync(path.join(MIG, migFile(p)), 'utf8'));
    if (with029) {
      await db.exec(fs.readFileSync(path.join(MIG, migFile('029')), 'utf8'));
      await db.exec(fs.readFileSync(path.join(MIG, migFile('029')), 'utf8'));   // ★ 2회 — 멱등
    }
    return db;
  };
  const db = await mkDb(true);
  await t('§0-2 029 2회 실행 뒤 cr_status_chk 에 auto_applied 가 있고 cr_approve_human_chk 는 그대로다', async () => {
    const r = await db.query(`SELECT conname, pg_get_constraintdef(oid) AS d FROM pg_constraint
                               WHERE conname IN ('cr_status_chk','cr_approve_human_chk') ORDER BY 1`);
    assert.strictEqual(r.rows.length, 2);
    assert.ok(/auto_applied/.test(r.rows.find((x) => x.conname === 'cr_status_chk').d));
    assert.ok(/reviewed_by IS NOT NULL/.test(r.rows.find((x) => x.conname === 'cr_approve_human_chk').d));
  });

  // ── shim ──
  let cur = db;
  const q = async (text, params) => {
    const r = await cur.query(text, params || []);
    if (r && r.rowCount === undefined) r.rowCount = r.affectedRows;
    return r;
  };
  const shim = {
    pool: null, query: q,
    transaction: async (cb) => {
      await cur.exec('BEGIN');
      try { const r = await cb({ query: q }); await cur.exec('COMMIT'); return r; }
      catch (e) { await cur.exec('ROLLBACK'); throw e; }
    },
    healthCheck: async () => ({ status: 'healthy' }),
  };
  const dbPath = require.resolve('../src/config/database');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };
  const warnLog = [];
  const loggerPath = require.resolve('../src/config/logger');
  require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: () => {}, debug: () => {}, error: () => {}, warn: (m, meta) => warnLog.push({ m, meta }) } };

  process.env.ADMIN_TOKEN = 'S72-AUTO-ADMIN';
  const crowdsource = require('../src/services/crowdsourceService');
  const productService = require('../src/services/productService');
  const apply = require('../src/services/contributionApply');
  const { evaluateAllergenAutoGate } = require('../src/services/allergenAutoGate');
  const express = require('express');
  const app = express(); app.use(express.json()); app.use('/api/admin', require('../src/routes/adminRoutes'));
  const server = app.listen(0); const port = server.address().port;
  const request = (method, p, body) => new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = payload.length; }
    const rq = http.request({ method, hostname: '127.0.0.1', port, path: p, headers }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) { j = d; } resolve({ status: res.statusCode, body: j }); });
    });
    rq.on('error', reject); if (payload) rq.write(payload); rq.end();
  });

  const report = (o = {}) => ({
    barcode: o.barcode, deviceId: o.deviceId || null, avgConfidence: 0.95,
    productInfo: { product_name: o.name || '자동반영테스트', food_type: '과자', content_unit: 'g', total_content: 100, serving_size: 100 },
    ocrResult: { corrected_text: o.text ?? GATE_TEXT, corrections: [] },
    analysis: {
      nutrition: { calories: 480, sodium: 300, total_carbs: 60, total_sugars: 25, total_fat: 22,
        saturated_fat: 12, trans_fat: 0, cholesterol: 5, protein: 6, dietary_fiber: 2, _basis: 'per_100g' },
      ingredients: [{ name: '밀가루' }, { name: '설탕' }],
      additives: [],
      allergens: o.flat ?? ['대두', '밀'],
      allergens_v2: o.v2 ?? { contains: ['대두', '밀'], inferred: [], mayContain: ['우유'] },
      product_meta: {},
    },
  });
  const rows = async (pid) => (await cur.query(
    `SELECT allergen_name, status, detected_via, evidence_level FROM product_allergens WHERE product_id=$1 ORDER BY 1`, [pid])).rows;
  const reviews = async (pid) => (await cur.query(
    `SELECT review_id, axis, status, applied_at, reviewed_by, evidence FROM contribution_review WHERE product_id=$1 ORDER BY review_id`, [pid])).rows;

  section('§1  게이트 통과 제보 → 자동 반영');
  await t('§1-0 (전제) 이 텍스트는 게이트를 통과한다', () => {
    const g = evaluateAllergenAutoGate({ text: GATE_TEXT, storedV2: { contains: ['대두', '밀'], mayContain: ['우유'], inferred: [] } });
    assert.strictEqual(g.pass, true, `reason=${g.reason}`);
  });
  const r1 = await crowdsource.saveOcrContribution(report({ barcode: 'S72A_1', deviceId: 'd1' }));
  const pid1 = r1.productId;
  await t('§1-1 제보는 저장되고 응답이 allergen_auto_applied=true · may_inspected=true 를 말한다', () => {
    assert.strictEqual(r1.saved, true, r1.rejectReason);
    assert.strictEqual(r1.allergen_auto_applied, true, `reason=${r1.allergen_auto_reason}`);
    assert.strictEqual(r1.allergen_may_inspected, true);
    assert.ok(/바로 반영/.test(r1.allergenWarning));
  });
  await t('§1-2 product_allergens = 밀·대두(contains) + 우유(may_contain) · 전부 crowd_auto / contribution_auto', async () => {
    const r = await rows(pid1);
    assert.deepStrictEqual(r.map((x) => [x.allergen_name, x.evidence_level, x.status, x.detected_via]), [
      ['대두', 'contains', 'crowd_auto', 'contribution_auto'],
      ['밀', 'contains', 'crowd_auto', 'contribution_auto'],
      ['우유', 'may_contain', 'crowd_auto', 'contribution_auto'],
    ]);
  });
  await t('§1-3 알레르기 리뷰 = auto_applied · applied_at 있음 · reviewed_by NULL(사람 아님) · evidence.auto_gate', async () => {
    const a = (await reviews(pid1)).find((x) => x.axis === 'allergens');
    assert.strictEqual(a.status, 'auto_applied');
    assert.ok(a.applied_at);
    assert.strictEqual(a.reviewed_by, null);
    assert.strictEqual(a.evidence.auto_gate.gate_version, 'allergen_auto_gate_v2');   // 세션72 U72-8
    assert.strictEqual(a.evidence.applied_by, 'auto:allergen_auto_gate_v1');
    assert.ok(Array.isArray(a.evidence.before.rows) && a.evidence.after.detected_via === 'contribution_auto');
  });
  await t('§1-4 ⛔ 다른 축은 여전히 candidate · 공식 테이블 0행 (C6 는 알레르기 밖에선 그대로)', async () => {
    const other = (await reviews(pid1)).filter((x) => x.axis !== 'allergens');
    assert.ok(other.length >= 2 && other.every((x) => x.status === 'candidate'), JSON.stringify(other.map((x) => [x.axis, x.status])));
    for (const tb of ['nutrition_data', 'product_ingredients', 'product_additives']) {
      const c = Number((await cur.query(`SELECT count(*)::int c FROM ${tb} WHERE product_id=$1`, [pid1])).rows[0].c);
      assert.strictEqual(c, 0, `${tb} 에 ${c}행`);
    }
  });
  await t('§1-5 data_inspection 알레르기 1행(found_count 3)', async () => {
    const r = await cur.query(`SELECT found_count FROM data_inspection WHERE product_id=$1 AND axis='allergens'`, [pid1]);
    assert.strictEqual(r.rows.length, 1); assert.strictEqual(Number(r.rows[0].found_count), 3);
  });

  section('§2  게이트 미통과 → 종전 그대로 candidate');
  const rRes = await crowdsource.saveOcrContribution(report({ barcode: 'S72A_2', deviceId: 'd2',
    text: '알레르기 유발물질: 일, 대두 함유', flat: ['대두'], v2: { contains: ['대두'], inferred: [], mayContain: [] } }));
  await t('§2-1 잔여 토큰(「밀」→「일」 오독) → RESIDUE · candidate · 0행', async () => {
    assert.strictEqual(rRes.saved, true);
    assert.strictEqual(rRes.allergen_auto_applied, false);
    assert.strictEqual(rRes.allergen_auto_reason, 'RESIDUE');
    assert.strictEqual((await reviews(rRes.productId)).find((x) => x.axis === 'allergens').status, 'candidate');
    assert.strictEqual((await rows(rRes.productId)).length, 0);
  });
  const rEdit = await crowdsource.saveOcrContribution(report({ barcode: 'S72A_3', deviceId: 'd3',
    flat: ['대두', '밀', '우유'], v2: { contains: ['대두', '밀', '우유'], inferred: [], mayContain: [] } }));
  await t('§2-2 사용자 수정(혼입→함유)으로 저장본≠파서 → STORED_MISMATCH · candidate', async () => {
    assert.strictEqual(rEdit.allergen_auto_applied, false);
    assert.strictEqual(rEdit.allergen_auto_reason, 'STORED_MISMATCH');
    assert.strictEqual((await rows(rEdit.productId)).length, 0);
  });

  section('§3  소비자 API 신호');
  await t('§3-1 혼입을 읽은 자동 반영 → crowd_auto 3종 · may_unconfirmed=false', async () => {
    const p = await productService.getProductWithTrafficLight('S72A_1');
    assert.deepStrictEqual([...p.allergens_crowd_auto].sort(), ['대두', '밀', '우유']);
    assert.strictEqual(p.allergens_may_unconfirmed, false);
    assert.strictEqual(p.allergens_available, true);
  });
  const rNoMay = await crowdsource.saveOcrContribution(report({ barcode: 'S72A_4', deviceId: 'd4', text: NO_MAY_TEXT,
    flat: ['밀'], v2: { contains: ['밀'], inferred: [], mayContain: [] } }));
  await t('§3-2 ★ 혼입 문장 없음(대책3) → 자동 반영은 하되 may_unconfirmed=true · flat_complete=false', async () => {
    assert.strictEqual(rNoMay.allergen_auto_applied, true, `reason=${rNoMay.allergen_auto_reason}`);
    assert.strictEqual(rNoMay.allergen_may_inspected, false);
    const p = await productService.getProductWithTrafficLight('S72A_4');
    assert.strictEqual(p.allergens_may_unconfirmed, true);
    assert.strictEqual(p.allergens_flat_complete, false, '혼입 미확인인데 「flat 이 전부다」를 단정했다');
  });
  await t('§3-3 자동 반영이 없는 제품은 신호가 종전과 같다(crowd_auto [] · may_unconfirmed false · 미수집이면 null)', async () => {
    const p = await productService.getProductWithTrafficLight('S72A_2');
    assert.strictEqual(p.allergens_crowd_auto, null); assert.strictEqual(p.allergens_may_unconfirmed, null);
  });

  section('§4  깎지 않는다 · 사람 승인은 올린다');
  const r4 = await crowdsource.saveOcrContribution(report({ barcode: 'S72A_5', deviceId: 'd5', name: '보호테스트' }));
  await t('§4-0 (준비) 자동 반영 완료', () => assert.strictEqual(r4.allergen_auto_applied, true));
  const pid4 = r4.productId;
  await cur.query(`UPDATE product_allergens SET status='admin_verified' WHERE product_id=$1 AND allergen_name='밀'`, [pid4]);
  await cur.query(`UPDATE product_allergens SET status='confirmed' WHERE product_id=$1 AND allergen_name='대두'`, [pid4]);
  const r4b = await crowdsource.saveOcrContribution(report({ barcode: 'S72A_5', deviceId: 'd5b', name: '보호테스트' }));
  await t('§4-1 두 번째 자동 반영이 admin_verified·confirmed 를 crowd_auto 로 내리지 않는다', async () => {
    assert.strictEqual(r4b.allergen_auto_applied, true, `reason=${r4b.allergen_auto_reason}`);
    const m = Object.fromEntries((await rows(pid4)).map((x) => [x.allergen_name, x.status]));
    assert.deepStrictEqual(m, { 대두: 'confirmed', 밀: 'admin_verified', 우유: 'crowd_auto' });
  });
  const r4c = await crowdsource.saveOcrContribution(report({ barcode: 'S72A_5', deviceId: 'd5c', name: '보호테스트',
    text: '알레르기 유발물질: 일, 우유 함유', flat: ['우유'], v2: { contains: ['우유'], inferred: [], mayContain: [] } }));
  await t('§4-2 사람이 알레르기 candidate 를 승인하면 crowd_auto → confirmed(등급도 contains 로 올림)', async () => {
    assert.strictEqual(r4c.allergen_auto_applied, false);
    const cand = (await reviews(pid4)).filter((x) => x.axis === 'allergens' && x.status === 'candidate');
    const v = await request('POST', `/api/admin/verify/${pid4}`, { action: 'approve', review_ids: cand.map((x) => Number(x.review_id)), reviewed_by: 'jay' });
    assert.strictEqual(v.status, 200, JSON.stringify(v.body));
    const u = (await rows(pid4)).find((x) => x.allergen_name === '우유');
    assert.deepStrictEqual([u.status, u.evidence_level], ['confirmed', 'contains']);
  });

  section('§5  관리자 undo 가 auto_applied 를 되돌린다');
  await t('§5-1 undo → 자동 반영 행 0 · 리뷰 undone', async () => {
    const v = await request('POST', `/api/admin/verify/${pid1}`, { action: 'undo', reviewed_by: 'jay' });
    assert.strictEqual(v.status, 200, JSON.stringify(v.body));
    assert.strictEqual((await rows(pid1)).length, 0);
    assert.strictEqual((await reviews(pid1)).find((x) => x.axis === 'allergens').status, 'undone');
  });

  section('§6  applyAutoAllergens 자기 방어');
  const client = { query: q };
  const nutRv = (await reviews(pid1)).find((x) => x.axis === 'nutrition');
  const GOOD = { pass: true, gate_version: 'allergen_auto_gate_v1' };
  const expectCode = async (fn, code) => { try { await fn(); } catch (e) { assert.strictEqual(e.code, code); return; } assert.fail(`${code} 가 나지 않았다`); };
  await t('§6-1 영양 축 → AUTO_AXIS_FORBIDDEN', () => expectCode(() => apply.applyAutoAllergens(client, Number(nutRv.review_id), GOOD), 'AUTO_AXIS_FORBIDDEN'));
  await t('§6-2 auto_applied/undone 행 재적용 → REVIEW_NOT_CANDIDATE', async () => {
    const a = (await reviews(pid1)).find((x) => x.axis === 'allergens');
    await expectCode(() => apply.applyAutoAllergens(client, Number(a.review_id), GOOD), 'REVIEW_NOT_CANDIDATE');
  });
  await t('§6-3 gate.pass 가 true 가 아니면 → AUTO_GATE_NOT_PASSED', async () => {
    const a = (await reviews(rRes.productId)).find((x) => x.axis === 'allergens');
    await expectCode(() => apply.applyAutoAllergens(client, Number(a.review_id), { pass: false, reason: 'RESIDUE' }), 'AUTO_GATE_NOT_PASSED');
  });

  section('§7  ★ 029 미적용 DB — 제보는 살아야 한다');
  cur = await mkDb(false);
  const r7 = await crowdsource.saveOcrContribution(report({ barcode: 'S72A_7', deviceId: 'd7' }));
  await t('§7-1 saved=true · allergen_auto_applied=false · reason AUTO_APPLY_FAILED:* · candidate · 0행', async () => {
    assert.strictEqual(r7.saved, true, r7.rejectReason);
    assert.strictEqual(r7.allergen_auto_applied, false);
    assert.ok(/^AUTO_APPLY_FAILED/.test(r7.allergen_auto_reason), r7.allergen_auto_reason);
    assert.strictEqual((await reviews(r7.productId)).find((x) => x.axis === 'allergens').status, 'candidate');
    assert.strictEqual((await rows(r7.productId)).length, 0, 'SAVEPOINT 롤백이 product_allergens 쓰기를 안 되돌렸다');
    assert.ok(warnLog.some((w) => /자동 반영 실패/.test(w.m)));
  });

  server.close();
  console.log(`\n════ 통과 ${pass} · 실패 ${fail}`);
  for (const f of fails) console.log(`\n[${f.name}]\n${f.e.stack}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
