/**
 * test_contribution_apply_basis.js — 세션67 `U66-4` 「관리자가 채운 표기 기준」 축
 * ============================================================================
 * 무엇을 지키는가 (계약 `.tmp/s67/계약_세션67.md` §4 Q1·Q2 · §6 에이전트 A)
 *
 *   ① `admin_basis` 가 «없으면» 종전과 «완전히» 같다 (회귀 0)
 *   ② `contributions.data` 에 기준이 없고 `admin_basis` 만 있으면 승인이 통과한다
 *   ③ ★ `data` 에 기준이 «있어도» `admin_basis` 가 이기고, 그 사실이 `evidence.from` 에 남는다
 *   ④ ★ `admin_basis.value` 가 어휘 밖이면 «여전히» `BASIS_UNKNOWN` — 우회로가 아니다
 *   ⑤ ★ 기준을 채워도 환산 근거(1회 제공량·총 내용량)가 없으면 «여전히»
 *       `CONVERT_BASIS_UNKNOWN` (`P1` 추정 금지) — 그리고 `products` 를 채우면 «그때» 통과한다
 *   ⑥ ★ `contributions.data` 가 «한 글자도» 안 바뀐다 (계약 §4 Q1 — 사용자가 낸 원본이다)
 *
 * ★★ 왜 이 축인가 —
 *   세션66 이 제보를 공식 테이블에서 «분리»했는데, 그 결과 `contribution_review` 에
 *   `candidate` 가 쌓이고 승인하면 `BASIS_UNKNOWN` 으로 «보류»됐다. 그런데 기준을
 *   채워 넣을 자리가 **어디에도 없었다**(계약 §2 G3) — `resolveBasis` 는
 *   `contributions.data` 의 네 자리만 봤고, `contributions.data` 는 사용자가 낸 원본이라
 *   관리자가 고쳐서는 안 되는 것이다. ⇒ 판정은 «판정 테이블»(`contribution_review.evidence`)에
 *   넣고, 읽는 쪽(이 파일이 검증하는 `resolveBasis`)이 그것을 본다.
 *
 * ⛔ 그러나 그것이 **어휘 검사와 `P1` 의 우회로가 되면 안 된다.** ④ 와 ⑤ 가 그 두 문이다.
 *   「사람이 채웠다」가 「아무 문자열이나 통과한다」·「근거 없이 환산한다」가 되는 순간
 *   `IP/basis_unknown_decision_2026-07-30.md` 가 여러 세션 싸운 그 오차가
 *   신호등 색으로 곧장 넘어간다.
 *
 * ★ 소스 문자열을 정규식으로 읽어 단정하지 않는다. pglite 에 `000_baseline.sql` →
 *   `023`~`026` 정본 마이그레이션을 적용하고 **실제 함수를 호출**해서
 *   DB 에 실제로 박힌 행·실제로 돌려받은 객체만 단정한다.
 *
 * ⚠ 뮤테이션 검증용 후크: `CONTRIB_APPLY_PATH` 가 있으면 그 경로의 서비스를 부른다
 *   (`test_contribution_apply.js` 와 같은 형식). 저장소 파일에 뮤턴트를 심지 않기 위한 것이다.
 *
 * 실행: cross-env NODE_ENV=test node tests/test_contribution_apply_basis.js
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
  console.log(' 세션67 U66-4 — 관리자가 채운 표기 기준(admin_basis)을 승인 경로가 읽는다');
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
      [`S67A_${seq}`, name, meta.serving_size ?? null, meta.serving_unit ?? null,
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

  const { resolveBasis } = SERVICE;

  // ══════════════════════════════════════════════════════════════════════════
  section('§0  export 계약 — 에이전트 B 의 읽기 API 가 이것을 «호출»한다 (Q6)');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§0-1 resolveBasis 가 export 돼 있고 3번째 인자를 받는다', () => {
    assert.strictEqual(typeof resolveBasis, 'function', 'resolveBasis 가 export 되지 않았다');
    // ★ 「인자를 «받는다»」는 것은 시그니처가 아니라 **결과가 달라진다**로 잰다.
    const without = resolveBasis({}, null);
    const with3 = resolveBasis({}, null, { admin_basis: { value: 'per_100g' } });
    assert.strictEqual(without.basis, null);
    assert.strictEqual(with3.basis, 'per_100g',
      '★ 3번째 인자를 무시했다 — 관리자가 채운 기준이 승인 경로에 도달하지 못한다');
  });

  await t('§0-2 §5-4 가 「호출하라」고 한 추출기가 export 돼 있다 (규칙 두 벌 금지)', () => {
    for (const k of ['pickNutritionObject', 'pickIngredientNames', 'buildAllergenList']) {
      assert.strictEqual(typeof SERVICE[k], 'function',
        `${k} 가 export 되지 않았다 — 읽기 API 가 규칙을 다시 구현하게 된다`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§1  ① admin_basis 가 «없으면» 종전과 완전히 같다 (회귀 0)');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§1-1 3번째 인자가 없거나 admin_basis 가 없으면 2인자 호출과 «완전히» 같다', () => {
    const cases = [
      [{ parsed_nutrition: { _basis: 'per_100g' } }, null],
      [{ parsed_nutrition: { _basis: 'unknown' } }, null],
      [{ nutrition: { _basis: 'per_100ml' } }, { has_public_nutrition: true, public_serving_marker: '100g' }],
      [{}, { has_public_nutrition: false, public_serving_marker: null }],
      [null, null],
    ];
    for (const [data, prow] of cases) {
      const base = resolveBasis(data, prow);
      for (const ev of [undefined, null, {}, '', 'not json',
        { merge_median: { calories: 100 } },              // 병합 판정만 있는 evidence
        { admin_basis: null }, { admin_basis: 'per_100g' }, // 객체가 아니면 «못 본다»
        { admin_basis: [] }]) {
        assert.deepStrictEqual(resolveBasis(data, prow, ev), base,
          `★ evidence=${JSON.stringify(ev)} 에서 결과가 달라졌다 — 회귀가 생겼다`);
      }
    }
  });

  await t('§1-2 admin_basis 가 없으면 basis·from·considered 가 종전 그대로다', () => {
    const r = resolveBasis({ parsed_nutrition: { _basis: 'per_100g' } }, null,
      { merge_median: { calories: 100 }, origin: 'merge' });
    assert.strictEqual(r.basis, 'per_100g');
    assert.strictEqual(r.evidence.from, 'data.parsed_nutrition._basis');
    assert.strictEqual(r.evidence.raw, 'per_100g');
    assert.deepStrictEqual(r.evidence.considered,
      [{ from: 'data.parsed_nutrition._basis', value: 'per_100g' }],
      '★ 후보 목록에 있지도 않은 admin_basis 가 끼어들었다');
    assert.strictEqual(r.evidence.admin_basis, null);
  });

  await t('§1-3 ★ DB 실측 — admin_basis 없는 승인이 «있을 때»와 완전히 같은 행을 만든다', async () => {
    // 대조군: evidence 가 NULL 인 종전 그대로의 승인
    const pA = await mkProduct('§1 대조군');
    const cA = await mkContribution(pA, { parsed_nutrition: NUT_100G, avg_confidence: 0.9 });
    const rA = await mkReview(cA, pA, 'nutrition');
    await SERVICE.applyApprovedContribution(client, rA, { appliedBy: 'jay' });

    // 실험군: evidence 에 «병합 판정만» 있고 admin_basis 는 없다
    const pB = await mkProduct('§1 실험군');
    const cB = await mkContribution(pB, { parsed_nutrition: NUT_100G, avg_confidence: 0.9 });
    const rB = await mkReview(cB, pB, 'nutrition');
    await setEvidence(rB, { origin: 'merge', merge_median: { calories: 100 }, device_count: 3 });
    await SERVICE.applyApprovedContribution(client, rB, { appliedBy: 'jay' });

    assert.deepStrictEqual(snapshot(await crowdRow(pB)), snapshot(await crowdRow(pA)),
      '★ admin_basis 가 «없는데» 저장 결과가 달라졌다 — 회귀다');

    const ev = await evidenceOf(rB);
    assert.ok(ev.merge_median, '병합 판정이 사라졌다 — evidence 를 덮어썼다');
    assert.strictEqual(ev.convert.basis_from, 'data.parsed_nutrition._basis',
      '기준의 출처가 반영 기록에 안 남았다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§2  ② data 에 기준이 없고 admin_basis 만 있으면 승인이 «통과한다»');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§2-1 ★ 종전엔 BASIS_UNKNOWN 으로 보류되던 제보가 기준을 채우면 반영된다', async () => {
    const productId = await mkProduct('§2 기준채움');
    const cid = await mkContribution(productId, { parsed_nutrition: NUT_NO_BASIS, avg_confidence: 0.8 });
    const rid = await mkReview(cid, productId, 'nutrition');

    // ① 채우기 «전» — 보류다(계약 §2 G3 이 말한 그 막다른 길)
    await throwsCode(() => SERVICE.applyApprovedContribution(client, rid, { appliedBy: 'jay' }),
      'BASIS_UNKNOWN');
    assert.strictEqual(await crowdRow(productId), null, '실패했는데 행이 생겼다');

    // ② 관리자가 «사람으로서» 채운다
    await setAdminBasis(rid, {
      value: 'per_100g', by: '제이', at: '2026-09-03T00:00:00Z',
      note: '라벨 사진 우하단 「100g당」 육안 확인',
    });

    // ③ 이제 통과한다
    const r = await SERVICE.applyApprovedContribution(client, rid, { appliedBy: 'jay' });
    assert.strictEqual(r.applied, true);
    assert.strictEqual(r.convert.basis_original, 'per_100g');
    assert.strictEqual(r.convert.basis_stored, 'per_100g');
    assert.strictEqual(r.convert.factor, 1);
    assert.strictEqual(r.convert.basis_from, 'review.evidence.admin_basis',
      '★ 출처가 안 남았다 — 「사용자가 신고한 것」과 「관리자가 판정한 것」이 구분되지 않는다');

    const row = await crowdRow(productId);
    assert.ok(row, 'nutrition_data_crowd 에 행이 없다');
    assert.strictEqual(numOf(row.calories), 60, '값이 변형됐다');
    assert.strictEqual(numOf(row.sodium), 15);
    assert.strictEqual(row.basis_original, 'per_100g');
    assert.strictEqual(row.serving_size, '100g',
      'basis 마커가 안 적혔다 — deriveBasis 가 이 문자열로 판정한다');
  });

  await t('§2-2 admin_basis 를 심어도 «미승인» 제보는 여전히 안 옮긴다 (DS-1 은 그대로다)', async () => {
    const productId = await mkProduct('§2 미승인');
    const cid = await mkContribution(productId, { parsed_nutrition: NUT_NO_BASIS });
    const rid = await mkReview(cid, productId, 'nutrition', 'candidate');
    await setAdminBasis(rid, { value: 'per_100g', by: '제이', note: '확인' });
    await throwsCode(() => SERVICE.applyApprovedContribution(client, rid), 'REVIEW_NOT_APPROVED');
    assert.strictEqual(await crowdRow(productId), null,
      '★ 기준을 채웠다는 이유로 미승인 제보가 반영됐다 — 승인은 사람이 누르는 사건이다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§3  ③ data 에 기준이 «있어도» admin_basis 가 이긴다 — 그 사실이 남는다');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§3-1 순수 함수: 네 자리 전부에 기준이 있어도 admin_basis 가 최상위다', () => {
    const data = {
      parsed_nutrition: { _basis: 'per_100g' },
      nutrition: { _basis: 'per_100ml' },
      _basis: 'per_total',
      basis: 'per_serving',
    };
    const r = resolveBasis(data, null, { admin_basis: { value: 'per_serving', by: '제이', note: 'x' } });
    assert.strictEqual(r.basis, 'per_serving', '★ 제보 값이 관리자 판정을 이겼다');
    assert.strictEqual(r.evidence.from, 'review.evidence.admin_basis',
      '★ 이겼다는 «사실»이 evidence.from 에 안 남았다');
    assert.strictEqual(r.evidence.considered[0].from, 'review.evidence.admin_basis',
      '★ 후보 목록의 «최상위»가 아니다');
    assert.deepStrictEqual(r.evidence.admin_basis,
      { value: 'per_serving', by: '제이', at: null, note: 'x' });
    // 제보가 낸 값도 사라지지 않는다 — 관리자가 무엇을 뒤집었는지 보여야 한다
    const seen = r.evidence.considered.map((c) => c.value);
    assert.ok(seen.includes('per_100g') && seen.includes('per_100ml'),
      `제보 후보가 considered 에서 사라졌다: ${JSON.stringify(r.evidence.considered)}`);
  });

  await t('§3-2 ★ DB 실측: data=per_100g · admin=per_serving → per_serving 으로 저장된다', async () => {
    // 공공 영양 행이 «없으므로» 목표 기준 = 제보(=관리자 판정) 기준 그대로다.
    //   admin 이 지면 basis_original='per_100g' · 마커='100g' 가 된다 — 눈에 보이게 갈린다.
    const productId = await mkProduct('§3 관리자우선', { serving_size: 50, serving_unit: 'g' });
    const cid = await mkContribution(productId, {
      parsed_nutrition: { _basis: 'per_100g', calories: 60, sodium: 15 },
    });
    const rid = await mkReview(cid, productId, 'nutrition');
    await setAdminBasis(rid, {
      value: 'per_serving', by: '제이', at: '2026-09-03T00:00:00Z',
      note: '라벨은 「1회 제공량 50g당」이다. 파서가 100g 으로 잘못 읽었다',
    });

    const r = await SERVICE.applyApprovedContribution(client, rid, { appliedBy: 'jay' });
    assert.strictEqual(r.convert.basis_original, 'per_serving',
      '★ 파서가 낸 per_100g 가 관리자 판정을 이겼다');
    assert.strictEqual(r.convert.basis_stored, 'per_serving');
    assert.strictEqual(r.convert.basis_from, 'review.evidence.admin_basis');

    const row = await crowdRow(productId);
    assert.strictEqual(row.basis_original, 'per_serving');
    assert.strictEqual(row.serving_size, null,
      'per_serving 은 마커가 «없는» 것이 그 자체로 per_serving 이다 — 100g 마커가 적혔다');
    assert.strictEqual(numOf(row.calories), 60, '기준만 바뀌어야 하는데 값이 환산됐다');

    const ev = await evidenceOf(rid);
    assert.ok(ev.admin_basis, '★ 관리자 판정이 반영 뒤에 사라졌다 — evidence 를 덮어썼다');
    assert.strictEqual(ev.admin_basis.note.length > 0, true);
    assert.strictEqual(ev.convert.basis_from, 'review.evidence.admin_basis',
      '★ 「관리자가 뒤집었다」가 반영 기록에 안 남았다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§4  ④ ★ 어휘 밖의 admin_basis 는 «여전히» BASIS_UNKNOWN — 우회로가 아니다');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§4-1 순수 함수: 어휘 4개 밖의 관리자 값은 basis 로 «인정되지 않는다»', () => {
    for (const bad of ['unknown', 'per_pack', 'per_piece', 'PER_100G', ' per_100g',
      '', null, undefined, 0, 123, true, {}, ['per_100g']]) {
      const r = resolveBasis({}, null, { admin_basis: { value: bad, by: '제이', note: 'x' } });
      assert.strictEqual(r.basis, null,
        `★ ${JSON.stringify(bad)} 가 기준으로 인정됐다 — 어휘 검사가 우회로가 됐다`);
    }
    // 어휘 4개는 «전부» 통과해야 한다 (문이 잠겨만 있으면 그것도 틀렸다)
    for (const ok of SERVICE.CONTRIBUTION_BASIS_OK) {
      assert.strictEqual(resolveBasis({}, null, { admin_basis: { value: ok } }).basis, ok,
        `정상 어휘 ${ok} 가 막혔다`);
    }
  });

  await t('§4-2 ★ DB 실측: admin_basis="unknown" 이면 승인이 여전히 보류된다', async () => {
    for (const bad of ['unknown', 'per_pack']) {
      const productId = await mkProduct(`§4 어휘밖 ${bad}`);
      const cid = await mkContribution(productId, { parsed_nutrition: NUT_NO_BASIS });
      const rid = await mkReview(cid, productId, 'nutrition');
      await setAdminBasis(rid, { value: bad, by: '제이', note: '라벨이 흐려 확실치 않다' });

      const e = await throwsCode(
        () => SERVICE.applyApprovedContribution(client, rid, { appliedBy: 'jay' }), 'BASIS_UNKNOWN');
      assert.ok(e.evidence, '.evidence 가 없다 — 관리자가 무엇이 거부됐는지 알 수 없다');
      assert.strictEqual(await crowdRow(productId), null,
        `★ ${bad} 로 추정값이 저장됐다 — 어휘 검사가 뚫렸다`);
      const cr = await db.query('SELECT applied_at FROM contribution_review WHERE review_id=$1', [rid]);
      assert.strictEqual(cr.rows[0].applied_at, null, '실패했는데 applied_at 이 찍혔다');
    }
  });

  await t('§4-3 어휘 밖 관리자 값 + 제보에 정상 기준 → 제보 기준이 쓰이고 출처가 갈린다', async () => {
    // 관리자가 잘못 채웠다고 해서 «멀쩡한 제보 기준»까지 죽이지 않는다.
    const r = resolveBasis({ parsed_nutrition: { _basis: 'per_100g' } }, null,
      { admin_basis: { value: 'per_pack', by: '제이', note: 'x' } });
    assert.strictEqual(r.basis, 'per_100g');
    assert.strictEqual(r.evidence.from, 'data.parsed_nutrition._basis',
      '★ 어휘 밖 값이 채택된 것처럼 기록됐다');
    assert.strictEqual(r.evidence.considered[0].value, 'per_pack',
      '관리자가 무엇을 적었는지가 considered 에서 사라졌다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§5  ⑤ ★ 기준을 채워도 «환산 근거»가 없으면 여전히 거부한다 (P1)');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§5-1 ★★ 기준 채움 + 1회 제공량 미상 → CONVERT_BASIS_UNKNOWN (밀도·기본값 추정 금지)', async () => {
    // 공공 행이 100g 기준 · 관리자가 「1회 제공량당」이라고 판정 · 그런데 1회 제공량을 «아무도 모른다»
    const productId = await mkProduct('§5 근거없음');   // serving_size = NULL
    await mkPublicNutrition(productId, '100g', { calories: 500 });
    const cid = await mkContribution(productId, { parsed_nutrition: { calories: 60, sodium: 15 } });
    const rid = await mkReview(cid, productId, 'nutrition');
    await setAdminBasis(rid, {
      value: 'per_serving', by: '제이', note: '라벨에 「1회 제공량당」이라고 적혀 있다',
    });

    const e = await throwsCode(
      () => SERVICE.applyApprovedContribution(client, rid, { appliedBy: 'jay' }),
      'CONVERT_BASIS_UNKNOWN');
    assert.ok(/총 내용량|1회 제공량/.test(e.message),
      `관리자에게 무엇을 채우라고 말하지 않는다: ${e.message}`);
    assert.strictEqual(await crowdRow(productId), null,
      '★ 기준을 채웠다는 이유로 추정 환산값이 저장됐다 — P1 이 뚫렸다');
    // 공공 값도 그대로다
    const nd = await db.query('SELECT calories FROM nutrition_data WHERE product_id=$1', [productId]);
    assert.strictEqual(numOf(nd.rows[0].calories), 500);

    // ── ★ 계약 §6-A-3 실측: 관리자가 `products` 를 채우면 buildConvertCtx 가 «자동으로» 잡는가 ──
    //   (`buildConvertCtx` 는 한 글자도 안 고쳤다. products.serving_size 를 최우선으로 본다.)
    await db.query(
      `UPDATE products SET serving_size = 50, serving_unit = 'g' WHERE product_id = $1`, [productId]);
    const ctx = SERVICE.buildConvertCtx({ parsed_nutrition: { calories: 60 } },
      (await db.query('SELECT serving_size, serving_unit, total_content, content_unit FROM products WHERE product_id=$1',
        [productId])).rows[0]);
    assert.strictEqual(ctx.servingSize, 50);
    assert.strictEqual(ctx.servingUnit, 'g');
    assert.strictEqual(ctx.servingSizeSource, 'products.serving_size',
      '★ products 를 최우선으로 보지 않는다 — 관리자가 채워도 안 잡힌다');

    // ⑤-b 그리고 «그때» 승인이 통과한다 (보류에서 나오는 길이 실제로 열린다)
    const r = await SERVICE.applyApprovedContribution(client, rid, { appliedBy: 'jay' });
    assert.strictEqual(r.convert.basis_original, 'per_serving');
    assert.strictEqual(r.convert.basis_stored, 'per_100g', '공공 행의 기준에 맞추지 않았다');
    assert.strictEqual(r.convert.factor, 2, `50g→100g 은 ×2 여야 한다: ${r.convert.factor}`);
    const row = await crowdRow(productId);
    assert.strictEqual(numOf(row.calories), 120, `60 × 2 = 120 이어야 한다: ${row.calories}`);
    assert.strictEqual(row.serving_size, '100g');
  });

  await t('§5-2 ★ 기준 채움 + per_total 인데 총 내용량 미상 → CONVERT_BASIS_UNKNOWN', async () => {
    const productId = await mkProduct('§5 총량미상', { serving_size: 100, serving_unit: 'g' });
    const cid = await mkContribution(productId, { parsed_nutrition: { calories: 1000, sodium: 2500 } });
    const rid = await mkReview(cid, productId, 'nutrition');
    await setAdminBasis(rid, { value: 'per_total', by: '제이', note: '라벨이 「총 내용량당」이다' });
    await throwsCode(() => SERVICE.applyApprovedContribution(client, rid), 'CONVERT_BASIS_UNKNOWN');
    assert.strictEqual(await crowdRow(productId), null, '★ 총량을 모르는데 저장됐다');
  });

  await t('§5-3 ★ 기준 채움 + g ↔ ml 어긋남 → CONVERT_BASIS_UNKNOWN (밀도 추정 금지)', async () => {
    const productId = await mkProduct('§5 단위어긋남',
      { serving_size: 200, serving_unit: 'ml', content_unit: 'ml' });
    await mkPublicNutrition(productId, '100g', { calories: 10 });
    const cid = await mkContribution(productId, { parsed_nutrition: { calories: 60 } });
    const rid = await mkReview(cid, productId, 'nutrition');
    await setAdminBasis(rid, { value: 'per_serving', by: '제이', note: '1회 200mL' });
    await throwsCode(() => SERVICE.applyApprovedContribution(client, rid), 'CONVERT_BASIS_UNKNOWN');
    assert.strictEqual(await crowdRow(productId), null);
  });

  await t('§5-4 기준을 채워도 영양값이 0개면 NOTHING_TO_APPLY — 빈 행을 만들지 않는다', async () => {
    const productId = await mkProduct('§5 값없음');
    const cid = await mkContribution(productId, { parsed_nutrition: { note: '읽을 수 없었다' } });
    const rid = await mkReview(cid, productId, 'nutrition');
    await setAdminBasis(rid, { value: 'per_100g', by: '제이', note: 'x' });
    await throwsCode(() => SERVICE.applyApprovedContribution(client, rid), 'NOTHING_TO_APPLY');
    assert.strictEqual(await crowdRow(productId), null);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§6  ⑥ ★ contributions.data 를 «한 글자도» 안 고친다 (계약 §4 Q1)');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§6-1 ★★ 승인·반영 전 과정에서 사용자가 낸 원본이 그대로다', async () => {
    const original = {
      parsed_nutrition: { calories: 60, sodium: 15 },
      ocr_raw_text: '영양정보 60kcal 나트륨 15mg',
      user_input: { device_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
      avg_confidence: 0.77,
    };
    const productId = await mkProduct('§6 원본보존');
    const cid = await mkContribution(productId, original);
    const rid = await mkReview(cid, productId, 'nutrition');
    const beforeData = await dataOf(cid);

    await setAdminBasis(rid, {
      value: 'per_100g', by: '제이', at: '2026-09-03T00:00:00Z', note: '라벨 육안 확인',
    });
    await SERVICE.applyApprovedContribution(client, rid, { appliedBy: 'jay' });

    const afterData = await dataOf(cid);
    assert.deepStrictEqual(afterData, beforeData,
      '★★ contributions.data 가 바뀌었다 — 「사용자가 신고한 것」과 「관리자가 판정한 것」이 섞였다');
    assert.deepStrictEqual(afterData, original, 'contributions.data 가 원본과 다르다');
    const rawText = JSON.stringify(afterData);
    assert.ok(!rawText.includes('admin_basis'),
      '★★ 관리자 판정이 사용자 원본에 써졌다 — 파서를 고쳐 재평가할 때 되돌릴 수 없다');
    assert.ok(!rawText.includes('제이'),
      '★ 관리자 이름이 사용자 제보 원본에 들어갔다');

    // 판정은 «판정 테이블»에만 있다
    const ev = await evidenceOf(rid);
    assert.strictEqual(ev.admin_basis.value, 'per_100g');
    assert.strictEqual(ev.admin_basis.by, '제이');
  });

  await t('§6-2 실패한 승인(BASIS_UNKNOWN)도 원본을 안 건드린다', async () => {
    const original = { parsed_nutrition: { calories: 10 } };
    const productId = await mkProduct('§6 실패시원본');
    const cid = await mkContribution(productId, original);
    const rid = await mkReview(cid, productId, 'nutrition');
    await setAdminBasis(rid, { value: 'per_pack', by: '제이', note: 'x' });
    await throwsCode(() => SERVICE.applyApprovedContribution(client, rid), 'BASIS_UNKNOWN');
    assert.deepStrictEqual(await dataOf(cid), original);
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
