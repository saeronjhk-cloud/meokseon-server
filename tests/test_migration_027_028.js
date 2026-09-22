/**
 * test_migration_027_028.js — 세션70 U69-3 «verified_at 백필은 승인 리뷰를 거친 행만»
 * ============================================================================
 * 무엇을 지키는가 (운영 실측 2026-09-22 00:47Z · 인수인계 179 §3)
 *   027 첫 판이 `WHERE verified_at IS NULL AND applied_at IS NOT NULL` 만 보고 5행을 갱신했다.
 *   관리자 승인 3행은 맞았지만 026 이관 행 2건(review_id NULL · applied_by='migration_026' · unverified)까지
 *   「이관 시각 = 관리자 확인 시각」으로 채웠다 — 이관은 확인이 아니다.
 *   ① 027(고친 판)은 review_id 가 있는 행만 채운다 · 이관 행은 null 그대로
 *   ② 028 은 027 첫 판이 이관 행에 찍은 것(verified_at = applied_at)만 되돌린다 · 승인 행은 안 건드린다
 *   ③ 026 이 원본 nutrition_data.verified_at 을 승계한 이관 행(verified_at ≠ applied_at)은 028 이 건드리지 않는다
 *   ④ 둘 다 2회 돌려도 결과가 같다(멱등 · real-postgres job 이 migrate 를 2회 돌린다)
 *
 * 실행: cross-env NODE_ENV=test node tests/test_migration_027_028.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MIG = path.join(__dirname, '..', 'scripts', 'migrations');
const read = (f) => fs.readFileSync(path.join(MIG, f), 'utf8');

let pass = 0; let fail = 0; const failures = [];
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✅ ' + name); }
  catch (e) { fail += 1; failures.push({ name, message: e.stack || e.message }); console.log('  ❌ ' + name + '\n     → ' + e.message); }
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(' test_migration_027_028 — 세션70 U69-3 verified_at 백필 범위');
  console.log('════════════════════════════════════════════════════════════════');
  let PGlite;
  try { ({ PGlite } = require('@electric-sql/pglite')); }
  catch (_) { console.log('⏭  pglite 미설치 — 검증 불가. EXIT=1'); process.exit(1); }
  const db = new PGlite();
  for (const f of ['000_baseline.sql', '021_supabase_auth.sql', '022_additive_detected_count.sql', '023_data_inspection.sql',
    '024_contribution_review.sql', '025_nutrition_data_crowd.sql', '026_crowd_nutrition_split.sql']) {
    await db.exec(read(f));
  }
  const SQL027 = read('027_crowd_verified_at_backfill.sql');
  const SQL028 = read('028_crowd_verified_at_unmigrate.sql');

  // 운영 실측 5행을 재현한다: 승인 3(review_id 有 · applied_by 제이) + 이관 2(review_id NULL · migration_026)
  //   + 원본 verified_at 을 승계한 이관 1(③ 용).
  async function mkProduct(barcode, name, verification) {
    const r = await db.query(
      'INSERT INTO products (barcode, product_name, data_source, verification) VALUES ($1,$2,$3,$4) RETURNING product_id',
      [barcode, name, 'ocr_crowdsource', verification]);
    return Number(r.rows[0].product_id);
  }
  async function mkReview(productId) {
    const c = await db.query(
      "INSERT INTO contributions (product_id, contribution_type, data, status) VALUES ($1,'ocr_nutrition','{}','approved') RETURNING contribution_id",
      [productId]);
    const r = await db.query(
      "INSERT INTO contribution_review (contribution_id, product_id, axis, status, reviewed_by, reviewed_at) VALUES ($1,$2,'nutrition','approved','jay',now()) RETURNING review_id",
      [Number(c.rows[0].contribution_id), productId]);
    return Number(r.rows[0].review_id);
  }
  async function mkCrowd(productId, { reviewId = null, appliedBy, appliedAt, verifiedAt = null }) {
    await db.query(
      "INSERT INTO nutrition_data_crowd (product_id, calories, basis_stored, review_id, applied_by, applied_at, verified_at) VALUES ($1, 100, 'per_100g', $2, $3, $4, $5)",
      [productId, reviewId, appliedBy, appliedAt, verifiedAt]);
  }
  const APPROVED_AT = ['2026-09-21T06:07:42.520Z', '2026-09-05T19:09:52.416Z', '2026-09-21T06:09:29.766Z'];
  const MIGRATED_AT = '2026-09-01T05:53:14.416Z';
  const approved = [];
  for (let i = 0; i < 3; i += 1) {
    const pid = await mkProduct('S70A' + i, '승인 ' + i, 'admin_verified');
    const rid = await mkReview(pid);
    await mkCrowd(pid, { reviewId: rid, appliedBy: '제이', appliedAt: APPROVED_AT[i] });
    approved.push(pid);
  }
  const migrated = [];
  for (let i = 0; i < 2; i += 1) {
    const pid = await mkProduct('S70M' + i, '이관 ' + i, 'unverified');
    await mkCrowd(pid, { appliedBy: 'migration_026', appliedAt: MIGRATED_AT });
    migrated.push(pid);
  }
  const inherited = await mkProduct('S70I', '이관(원본 verified_at 승계)', 'verified');
  await mkCrowd(inherited, { appliedBy: 'migration_026', appliedAt: MIGRATED_AT, verifiedAt: '2026-08-20T00:00:00Z' });

  const va = async (pid) => {
    const r = await db.query('SELECT verified_at, applied_at FROM nutrition_data_crowd WHERE product_id = $1', [pid]);
    return r.rows[0];
  };
  const iso = (v) => (v === null || v === undefined ? null : new Date(v).toISOString());

  await t('① 027 — 승인 리뷰를 거친 3행만 verified_at = applied_at', async () => {
    await db.exec(SQL027);
    for (let i = 0; i < 3; i += 1) {
      const r = await va(approved[i]);
      assert.strictEqual(iso(r.verified_at), APPROVED_AT[i], '승인 행 ' + i + ' 이 안 채워졌다');
    }
  });
  await t('① 027 — 이관 행(review_id NULL · migration_026)은 null 그대로 (운영 5행 사고 재발 방지)', async () => {
    for (const pid of migrated) {
      const r = await va(pid);
      assert.strictEqual(r.verified_at, null, '이관 행에 이관 시각이 관리자 확인 시각으로 찍혔다: ' + iso(r.verified_at));
    }
  });
  await t('② 028 — 027 «첫 판»이 이관 행에 찍은 것을 되돌린다 · 승인 행은 그대로', async () => {
    // 첫 판의 결과를 재현: 이관 행에 verified_at = applied_at
    await db.query("UPDATE nutrition_data_crowd SET verified_at = applied_at WHERE applied_by = 'migration_026' AND verified_at IS NULL");
    for (const pid of migrated) assert.strictEqual(iso((await va(pid)).verified_at), MIGRATED_AT, '재현 실패');
    await db.exec(SQL028);
    for (const pid of migrated) assert.strictEqual((await va(pid)).verified_at, null, '028 이 이관 행을 안 되돌렸다');
    for (let i = 0; i < 3; i += 1) assert.strictEqual(iso((await va(approved[i])).verified_at), APPROVED_AT[i], '028 이 승인 행을 건드렸다');
  });
  await t('③ 028 — 원본 verified_at 을 승계한 이관 행(≠ applied_at)은 건드리지 않는다', async () => {
    assert.strictEqual(iso((await va(inherited)).verified_at), '2026-08-20T00:00:00.000Z');
  });
  await t('④ 027·028 2회차 — 결과 불변(멱등)', async () => {
    const before = {};
    for (const pid of [...approved, ...migrated, inherited]) before[pid] = iso((await va(pid)).verified_at);
    await db.exec(SQL027); await db.exec(SQL028); await db.exec(SQL027); await db.exec(SQL028);
    for (const pid of [...approved, ...migrated, inherited]) assert.strictEqual(iso((await va(pid)).verified_at), before[pid], 'pid ' + pid + ' 가 바뀌었다');
  });
  await t('027 의 WHERE 에 review_id IS NOT NULL 이 «파일에» 있다 (배포 산출물 검사)', () => {
    assert.ok(/review_id\s+IS\s+NOT\s+NULL/.test(SQL027), '027 이 다시 넓어졌다');
    assert.ok(/applied_by\s*=\s*'migration_026'/.test(SQL028));
  });

  console.log('\n 통과 ' + pass + ' · 실패 ' + fail);
  if (fail > 0) for (const f of failures) console.log('  - ' + f.name + '\n    ' + f.message);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
