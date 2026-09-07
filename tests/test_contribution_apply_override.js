/**
 * 관리자 «값 정정»(contribution_review.evidence.admin_override) — 세션68 U67-11
 * ============================================================
 * 세션67 실물 1회차: 「지방 32g ↔ 열량 80kcal」 제보를 관리자가 반려할 수밖에 없었다.
 * 지방 한 값만 3.2 로 고치면 쓸 수 있었는데 「고쳐서 승인」할 자리가 없었다(설계 누락).
 *
 * 형태는 admin_basis 와 같다. 지키는 것:
 *   §0 순수 함수 applyAdminOverride — 키 어휘·null 비움·쓰레기 값 무시·원본 무변형
 *   §1 override 가 «없으면» 종전과 완전히 같다(회귀 0 · DB 실측 대조군)
 *   §2 ★ 32g 제보에 override {total_fat:3.2} 를 얹으면 crowd 행에 3.2 가 저장되고
 *      convert.override_from / override_keys 가 남는다
 *   §3 ⛔ contributions.data 는 한 글자도 안 바뀐다(원본과 판정의 분리)
 *   §4 null 은 «비움»이다 — 저장 행에서 그 영양소가 NULL 이 된다(0 이 아니다)
 *   §5 환산(per_100g→per_serving)이 정정값 «위에» 걸린다 — 순서가 바뀌면 값이 두 번 나뉜다
 *   §6 읽기 API 의 effective 가 승인 결과와 «같은 값»이다(예고 = 실제 · Q6)
 * 하니스는 test_contribution_apply_basis.js 와 같다(pglite · 000→023~026).
 * ============================================================
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRV = path.join(__dirname, '..');
const MIG = path.join(SRV, 'scripts', 'migrations');

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

/** `.code` 를 확인하며 던지기를 단정한다. 「던졌다」만으로는 부족하다. */
async function throwsCode(fn, code) {
  let caught = null;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, `던지지 않았다 — ${code} 를 기대했다`);
  assert.strictEqual(caught.code, code,
    `.code 가 ${JSON.stringify(caught.code)} 다 (기대: ${code}) — 메시지: ${caught.message}`);
  return caught;
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(' 세션68 U67-11 — 관리자 값 정정(admin_override)을 승인 경로가 «얹는다»');
  console.log('════════════════════════════════════════════════════════════════');

  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (_) {
    console.log('⏭  pglite 미설치 — 검증 불가. 「건너뜀」은 「통과」가 아니다. EXIT=1.');
    process.exit(1);
  }

  // ── DB 준비: 000_baseline → 023 → 024 → 025 → 026 (전부 «파일»이다) ────────
  const db = new PGlite();
  const chain = ['000_baseline.sql'];
  for (const f of fs.readdirSync(MIG).sort()) {
    if (/^(023|024|025|026)_.*\.sql$/.test(f)) chain.push(f);
  }
  for (const f of chain) {
    const p = path.join(MIG, f);
    if (!fs.existsSync(p)) {
      console.error(`마이그레이션 ${f} 가 없다 — 이 축은 023~026 위에서만 성립한다.`);
      process.exit(1);
    }
    try {
      await db.exec(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      console.error(`${f} 적용 실패: ${e.message}`);
      process.exit(1);
    }
  }
  console.log(`  ⓘ 적용한 마이그레이션: ${chain.join(' · ')}`);

  // ── DB shim 을 «먼저» 심고, 그 «다음»에 서비스를 require 한다 ──────────────
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

  const loggerPath = require.resolve('../src/config/logger');
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };

  const SERVICE = process.env.CONTRIB_APPLY_PATH
    ? require(process.env.CONTRIB_APPLY_PATH)
    : require('../src/services/contributionApply');

  const client = { query: (text, params) => db.query(text, params || []) };

  // ── 픽스처 헬퍼 ────────────────────────────────────────────────────────────
  let seq = 0;
  async function mkProduct(name, meta = {}) {
    seq += 1;
    const r = await db.query(
      `INSERT INTO products
         (barcode, product_name, data_source, serving_size, serving_unit, total_content, content_unit)
       VALUES ($1, $2, 'ocr_crowdsource', $3, $4, $5, $6)
       RETURNING product_id`,
      [`S68O_${seq}`, name, meta.serving_size ?? null, meta.serving_unit ?? null,
        meta.total_content ?? null, meta.content_unit ?? null]);
    return Number(r.rows[0].product_id);
  }
  async function mkPublicNutrition(productId, marker, cols = {}) {
    await db.query(
      `INSERT INTO nutrition_data (product_id, calories, sodium, serving_size, data_source)
       VALUES ($1, $2, $3, $4, 'public_nutrition')`,
      [productId, cols.calories ?? null, cols.sodium ?? null, marker]);
  }
  async function mkContribution(productId, data) {
    const r = await db.query(
      `INSERT INTO contributions (product_id, contribution_type, data, status)
       VALUES ($1, 'ocr_nutrition', $2, 'pending') RETURNING contribution_id`,
      [productId, JSON.stringify(data)]);
    return Number(r.rows[0].contribution_id);
  }
  async function mkReview(contributionId, productId, axis, status = 'approved') {
    const r = await db.query(
      `INSERT INTO contribution_review
         (contribution_id, product_id, axis, status, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING review_id`,
      [contributionId, productId, axis, status, status === 'approved' ? 'jay' : null]);
    return Number(r.rows[0].review_id);
  }
  /**
   * ★ 「메인이 만드는 `POST …/basis` 가 한 일」을 그대로 흉내 낸다.
   *   계약 §5-3: `evidence` 를 **`||` 로 병합**한다 — 덮어쓰면 merge 판정이 사라진다.
   *   ⛔ 그리고 `contributions.data` 는 **건드리지 않는다**(계약 §4 Q1).
   */
  async function setAdminBasis(reviewId, adminBasis) {
    await db.query(
      `UPDATE contribution_review
          SET evidence = COALESCE(evidence, '{}'::jsonb)
                         || jsonb_build_object('admin_basis', $2::jsonb)
        WHERE review_id = $1`,
      [reviewId, JSON.stringify(adminBasis)]);
  }
  async function setEvidence(reviewId, obj) {
    await db.query(
      `UPDATE contribution_review SET evidence = $2::jsonb WHERE review_id = $1`,
      [reviewId, JSON.stringify(obj)]);
  }
  const crowdRow = async (productId) => {
    const r = await db.query('SELECT * FROM nutrition_data_crowd WHERE product_id = $1', [productId]);
    return r.rows[0] || null;
  };
  const evidenceOf = async (reviewId) => {
    const r = await db.query('SELECT evidence FROM contribution_review WHERE review_id=$1', [reviewId]);
    const v = r.rows[0].evidence;
    return typeof v === 'string' ? JSON.parse(v) : v;
  };
  const dataOf = async (contributionId) => {
    const r = await db.query('SELECT data FROM contributions WHERE contribution_id=$1', [contributionId]);
    const v = r.rows[0].data;
    return typeof v === 'string' ? JSON.parse(v) : v;
  };
  const numOf = (v) => (v === null || v === undefined ? null : Number(v));

  /** 비교용으로 뽑는 저장 결과 — 「종전과 같은가」를 이 15+6 개로 잰다. */
  const CMP_COLS = [
    'calories', 'total_fat', 'saturated_fat', 'trans_fat', 'cholesterol', 'sodium',
    'total_carbs', 'total_sugars', 'added_sugars', 'dietary_fiber', 'protein',
    'calcium', 'iron', 'vitamin_d', 'potassium',
  ];
  const snapshot = (row) => {
    if (!row) return null;
    const o = {};
    for (const k of CMP_COLS) o[k] = numOf(row[k]);
    o.serving_size = row.serving_size;
    o.ocr_confidence = row.ocr_confidence;
    o.basis_original = row.basis_original;
    o.basis_stored = row.basis_stored;
    o.convert_factor = numOf(row.convert_factor);
    o.convert_note = row.convert_note;
    return o;
  };

  const NUT_100G = {
    _basis: 'per_100g',
    calories: 100, sodium: 200, protein: 5, total_fat: 3,
  };
  /** 기준이 «없는» 제보 — 지금 큐에 쌓여 보류되는 바로 그 모양이다. */
  const NUT_NO_BASIS = { calories: 60, sodium: 15, protein: 2 };

  const { applyAdminOverride } = SERVICE;
  const READ = require('../src/services/reviewQueueRead');

  async function setOverride(reviewId, ov) {
    await db.query(
      `UPDATE contribution_review
          SET evidence = COALESCE(evidence, '{}'::jsonb) || jsonb_build_object('admin_override', $2::jsonb)
        WHERE review_id = $1`,
      [reviewId, JSON.stringify(ov)]);
  }
  /** 세션67 실물 — 삼치구이(60g · per_serving) 제보 그대로. 지방 32 는 OCR 소수점 손실. */
  const SAMCHI = { _basis: 'per_serving', calories: 80, total_fat: 32, saturated_fat: 1.1, total_carbs: 1, protein: 12, sodium: 300 };

  // ══════════════════════════════════════════════════════════════════════════
  section('§0  순수 함수 applyAdminOverride');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§0-1 export 돼 있고, override 가 없으면 입력과 같은 값·from=null', () => {
    assert.strictEqual(typeof applyAdminOverride, 'function');
    for (const ev of [undefined, null, {}, '', 'x', { admin_basis: { value: 'per_100g' } },
      { admin_override: null }, { admin_override: 'x' }, { admin_override: [] }, { admin_override: { values: [] } }]) {
      const r = applyAdminOverride(SAMCHI, ev);
      assert.deepStrictEqual(r.nutrition, SAMCHI, `ev=${JSON.stringify(ev)} 에서 값이 바뀌었다`);
      assert.strictEqual(r.from, null); assert.deepStrictEqual(r.applied_keys, []);
    }
  });
  await t('§0-2 숫자는 덮어쓰고 null 은 비우고 쓰레기는 무시한다 · 어휘 밖 키는 못 들어온다', () => {
    const r = applyAdminOverride(SAMCHI, { admin_override: { values: {
      total_fat: 3.2, sodium: null, protein: 'abc', calories: -5, total_sugars: '4.5', _basis: 'per_100g', foo: 1 } } });
    assert.strictEqual(r.nutrition.total_fat, 3.2);
    assert.strictEqual(r.nutrition.sodium, null, 'null 은 비움이다');
    assert.strictEqual(r.nutrition.protein, 12, '문자열 쓰레기는 무시(원값 유지)');
    assert.strictEqual(r.nutrition.calories, 80, '음수는 무시');
    assert.strictEqual(r.nutrition.total_sugars, 4.5, '숫자 문자열은 받는다');
    assert.strictEqual(r.nutrition._basis, 'per_serving', '★ 언더스코어 키(기준)는 override 로 못 바꾼다');
    assert.strictEqual(r.nutrition.foo, undefined);
    assert.deepStrictEqual(r.applied_keys, ['total_fat', 'total_sugars']);
    assert.deepStrictEqual(r.cleared_keys, ['sodium']);
    assert.strictEqual(r.from, 'review.evidence.admin_override');
  });
  await t('§0-3 입력 객체를 변형하지 않는다', () => {
    const inp = { ...SAMCHI }; const before = JSON.stringify(inp);
    applyAdminOverride(inp, { admin_override: { values: { total_fat: 3.2 } } });
    assert.strictEqual(JSON.stringify(inp), before);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§1  override 가 «없으면» 종전과 완전히 같다 (회귀 0)');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§1-1 DB 실측 — evidence 에 병합 판정만 있는 승인이 대조군과 같은 행을 만든다', async () => {
    const pA = await mkProduct('§1 대조군', { serving_size: 60, serving_unit: 'g' });
    const cA = await mkContribution(pA, { parsed_nutrition: SAMCHI, avg_confidence: 0.9 });
    const rA = await mkReview(cA, pA, 'nutrition');
    const outA = await SERVICE.applyApprovedContribution(client, rA, { appliedBy: 'jay' });
    const pB = await mkProduct('§1 실험군', { serving_size: 60, serving_unit: 'g' });
    const cB = await mkContribution(pB, { parsed_nutrition: SAMCHI, avg_confidence: 0.9 });
    const rB = await mkReview(cB, pB, 'nutrition');
    await setEvidence(rB, { origin: 'merge', merge_median: { calories: 80 } });
    const outB = await SERVICE.applyApprovedContribution(client, rB, { appliedBy: 'jay' });
    assert.deepStrictEqual(snapshot(await crowdRow(pB)), snapshot(await crowdRow(pA)));
    assert.strictEqual(outA.convert.override_from, null);
    assert.strictEqual(outB.convert.override_from, null);
    assert.deepStrictEqual(outB.convert.override_keys, []);
    assert.strictEqual(numOf((await crowdRow(pA)).total_fat), 32, '(대조군은 32 그대로 — 게이트가 아니라 사람이 잡는다)');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§2  ★ 32g 제보에 {total_fat:3.2} 를 얹으면 3.2 가 저장된다');
  // ══════════════════════════════════════════════════════════════════════════
  let P2, C2, R2;
  await t('§2-1 정정값이 crowd 행에 저장되고 출처가 반영 기록에 남는다', async () => {
    P2 = await mkProduct('§2 삼치구이', { serving_size: 60, serving_unit: 'g' });
    C2 = await mkContribution(P2, { parsed_nutrition: SAMCHI, avg_confidence: 0.9, ocr_raw_text: 'raw' });
    R2 = await mkReview(C2, P2, 'nutrition');
    await setEvidence(R2, { origin: 'single', sanity_warnings: [{ type: 'calorie_deviation', value: 80, limit: 340 }] });
    await setOverride(R2, { values: { total_fat: 3.2 }, by: '제이', at: '2026-09-06T00:00:00Z', note: '라벨 지방 3.2g 육안 확인 · 4-9-4 정합' });
    const r = await SERVICE.applyApprovedContribution(client, R2, { appliedBy: 'jay' });
    assert.strictEqual(r.applied, true);
    const row = await crowdRow(P2);
    assert.strictEqual(numOf(row.total_fat), 3.2, '★ 정정값이 저장되지 않았다');
    assert.strictEqual(numOf(row.calories), 80); assert.strictEqual(numOf(row.protein), 12);
    assert.strictEqual(r.convert.override_from, 'review.evidence.admin_override');
    assert.deepStrictEqual(r.convert.override_keys, ['total_fat']);
    assert.strictEqual(r.counts.overridden, 1);
    const ev = await evidenceOf(R2);
    assert.ok(ev.sanity_warnings && ev.admin_override, 'evidence 의 다른 키가 사라졌다(덮어씀)');
    assert.strictEqual(ev.convert.override_from, 'review.evidence.admin_override', '반영 evidence 에 출처가 없다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§3  ⛔ contributions.data 는 한 글자도 안 바뀐다');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§3-1 원본 parsed_nutrition.total_fat 은 여전히 32 다', async () => {
    const d = await dataOf(C2);
    assert.strictEqual(d.parsed_nutrition.total_fat, 32, '★ 원본이 오염됐다 — 사용자 신고와 관리자 판정이 뒤섞였다');
    assert.strictEqual(d.ocr_raw_text, 'raw');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§4  null 은 «비움»이다');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§4-1 {sodium:null} 이면 저장 행의 sodium 이 NULL (0 이 아니다)', async () => {
    const p = await mkProduct('§4 비움', { serving_size: 60, serving_unit: 'g' });
    const c = await mkContribution(p, { parsed_nutrition: SAMCHI });
    const r = await mkReview(c, p, 'nutrition');
    await setOverride(r, { values: { sodium: null, total_fat: 3.2 }, by: '제이', note: '나트륨 칸이 OCR 쓰레기' });
    const out = await SERVICE.applyApprovedContribution(client, r, { appliedBy: 'jay' });
    const row = await crowdRow(p);
    assert.strictEqual(row.sodium, null);
    assert.strictEqual(numOf(row.total_fat), 3.2);
    assert.deepStrictEqual(out.convert.override_cleared, ['sodium']);
    assert.strictEqual(out.counts.nutrients_stored, 5, '비운 값은 세지 않는다');
  });
  await t('§4-2 전부 비우면 NOTHING_TO_APPLY — 값 없는 행을 만들지 않는다', async () => {
    const p = await mkProduct('§4 전부비움', { serving_size: 60, serving_unit: 'g' });
    const c = await mkContribution(p, { parsed_nutrition: { _basis: 'per_serving', calories: 80 } });
    const r = await mkReview(c, p, 'nutrition');
    await setOverride(r, { values: { calories: null }, by: '제이', note: 'x' });
    await throwsCode(() => SERVICE.applyApprovedContribution(client, r, { appliedBy: 'jay' }), 'NOTHING_TO_APPLY');
    assert.strictEqual(await crowdRow(p), null);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§5  환산이 정정값 «위에» 걸린다');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§5-1 per_100g 제보 + 공공 per_serving(50g) → 정정값 4.2 가 ×0.5 로 2.1 저장', async () => {
    const p = await mkProduct('§5 환산', { serving_size: 50, serving_unit: 'g' });
    await mkPublicNutrition(p, '50g', { calories: 200 });
    const c = await mkContribution(p, { parsed_nutrition: { _basis: 'per_100g', calories: 394, total_fat: 42, protein: 7 } });
    const r = await mkReview(c, p, 'nutrition');
    await setOverride(r, { values: { total_fat: 4.2 }, by: '제이', note: '%열 8% → 4.2' });
    const out = await SERVICE.applyApprovedContribution(client, r, { appliedBy: 'jay' });
    assert.strictEqual(out.convert.factor, 0.5);
    const row = await crowdRow(p);
    assert.strictEqual(numOf(row.total_fat), 2.1, '정정 «뒤에» 환산돼야 한다(42×0.5=21 이면 순서가 틀렸다)');
    assert.strictEqual(numOf(row.calories), 197);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§6  읽기 API 의 effective = 승인 결과 (예고 = 실제 · Q6)');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§6-1 getReviewDetail.axes[].effective.nutrition.total_fat === 저장된 값(환산 전 기준)', async () => {
    const p = await mkProduct('§6 예고', { serving_size: 60, serving_unit: 'g' });
    const c = await mkContribution(p, { parsed_nutrition: SAMCHI });
    const r = await mkReview(c, p, 'nutrition', 'candidate');
    await setOverride(r, { values: { total_fat: 3.2, sodium: null }, by: '제이', at: '2026-09-06T00:00:00Z', note: 'n' });
    const d = await READ.getReviewDetail(client, p);
    const ax = d.axes.find((a) => a.review_id === r);
    assert.ok(ax.override, 'override 가 상세에 없다');
    assert.deepStrictEqual([...ax.override.keys].sort(), ['sodium', 'total_fat']);  // JSONB 는 키 순서를 보존하지 않는다
    assert.strictEqual(ax.override.values.total_fat, 3.2);
    assert.strictEqual(ax.effective.nutrition.total_fat, 3.2);
    assert.strictEqual(ax.effective.nutrition.sodium, null);
    assert.strictEqual(ax.effective.nutrition.calories, 80);
    assert.strictEqual(ax.effective.from, 'review.evidence.admin_override');
    assert.strictEqual(ax.proposed.nutrition.total_fat, 32, 'proposed 는 «제보 원본»이어야 한다');
    // 목록도 «있다»를 안다
    const list = await READ.listReviewQueue(client, { status: 'candidate' });
    const it = list.items.find((x) => x.product_id === p);
    assert.deepStrictEqual([...it.axes[0].override.keys].sort(), ['sodium', 'total_fat']);
    // 승인하면 예고와 같다
    await db.query(`UPDATE contribution_review SET status='approved', reviewed_by='jay', reviewed_at=now() WHERE review_id=$1`, [r]);
    await SERVICE.applyApprovedContribution(client, r, { appliedBy: 'jay' });
    const row = await crowdRow(p);
    assert.strictEqual(numOf(row.total_fat), ax.effective.nutrition.total_fat);
    assert.strictEqual(row.sodium, null);
  });
  await t('§6-2 override 없는 상세는 override:null · effective 는 proposed 와 같다', async () => {
    const p = await mkProduct('§6 없음', { serving_size: 60, serving_unit: 'g' });
    const c = await mkContribution(p, { parsed_nutrition: SAMCHI });
    const r = await mkReview(c, p, 'nutrition', 'candidate');
    const d = await READ.getReviewDetail(client, p);
    const ax = d.axes.find((a) => a.review_id === r);
    assert.strictEqual(ax.override, null);
    assert.deepStrictEqual(ax.effective.nutrition, ax.proposed.nutrition);
    assert.strictEqual(ax.effective.from, null);
    const list = await READ.listReviewQueue(client, { status: 'candidate' });
    assert.strictEqual(list.items.find((x) => x.product_id === p).axes[0].override, null);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§7  ★ 정정값도 엔진의 sanity 를 거친다 (세션68 검증이 찾은 구멍)');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§7-1 오타(3.2 → 320g)는 OVERRIDE_SANITY_OUTLIER 로 막힌다 · 행이 안 생긴다', async () => {
    const p = await mkProduct('§7 오타', { serving_size: 60, serving_unit: 'g' });
    const c = await mkContribution(p, { parsed_nutrition: SAMCHI });
    const r = await mkReview(c, p, 'nutrition');
    await setOverride(r, { values: { total_fat: 320 }, by: '제이', note: '오타' });
    const e = await throwsCode(() => SERVICE.applyApprovedContribution(client, r, { appliedBy: 'jay' }), 'OVERRIDE_SANITY_OUTLIER');
    assert.ok(Array.isArray(e.warnings) && e.warnings[0].type === 'per_serving_exceeded', JSON.stringify(e.warnings));
    assert.strictEqual(await crowdRow(p), null);
  });
  await t('§7-2 정정이 «없는» 행은 종전대로 검사하지 않는다(회귀 0) — 32g 그대로 저장', async () => {
    const p = await mkProduct('§7 무정정', { serving_size: 60, serving_unit: 'g' });
    const c = await mkContribution(p, { parsed_nutrition: { ...SAMCHI, sodium: 9000 } });   // 상한 5000 초과지만 정정이 없다
    const r = await mkReview(c, p, 'nutrition');
    const out = await SERVICE.applyApprovedContribution(client, r, { appliedBy: 'jay' });
    assert.strictEqual(out.applied, true);
    assert.strictEqual(numOf((await crowdRow(p)).sodium), 9000);
  });
  await t('§7-3 순수 함수 overrideCriticalWarnings — per_100g 기준·제공량 없음도 돈다', () => {
    const { overrideCriticalWarnings } = SERVICE;
    assert.deepStrictEqual(overrideCriticalWarnings({ total_fat: 3.2, sodium: 300 }, 60, 'per_serving'), []);
    assert.strictEqual(overrideCriticalWarnings({ total_fat: -1 }, null, 'per_100g')[0].type, 'negative_value');
    assert.strictEqual(overrideCriticalWarnings({ sodium: 6000 }, null, 'per_serving')[0].type, 'per_serving_exceeded');
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(` 통과 ${pass} · 실패 ${fail}`);
  if (fail > 0) {
    console.log('\n실패 상세:');
    for (const f of failures) console.log(`\n  ❌ ${f.name}\n${f.message}`);
  }
  console.log('════════════════════════════════════════════════════════════════\n');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('테스트 러너 자체가 죽었다:', e);
  process.exit(1);
});
