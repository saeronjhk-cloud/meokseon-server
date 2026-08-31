/**
 * test_contribution_apply.js — 세션66 C5 「승인된 제보를 옮기는 유일한 곳」 회귀
 * ============================================================================
 * 무엇을 지키는가 (계약 `.tmp/s66/계약_세션66.md` §6 · 설계 §11-B)
 *   §1  순수 함수 3개 — `resolveBasis` · `computeConvertFactor` · `scaleNutrition` (DB 없이)
 *   §2  `status !== 'approved'` 면 **옮기지 않는다** (`REVIEW_NOT_APPROVED`)
 *   §3  `applied_at` 이 이미 있으면 **두 번 옮기지 않는다** (`ALREADY_APPLIED`) — 멱등
 *   §4  기준이 같으면 `convert_factor = 1.0`, 값이 그대로
 *   §5  기준이 다르고 근거가 있으면 **환산된 값**이 저장되고 `convert_note` 가 남는다
 *   §6  ★ 기준을 모르면 **던진다.** 추정값이 저장되지 않는다 (`BASIS_UNKNOWN`)
 *   §7  ★ 환산 근거가 없으면 **던진다** (`CONVERT_BASIS_UNKNOWN`)
 *   §8  4축이 각각 올바른 테이블에 쓴다
 *   §9  `data_inspection` 에 행이 남고, ★ **알레르겐 0종이면 `found_count = 0`** (`U63-6`)
 *   §10 `undo` 가 **그 제보가 넣은 것만** 되돌리고, 다른 출처의 행은 **건드리지 않는다**
 *   §11 `contribution_review.evidence` 에 `before`·`after` 가 들어간다
 *
 * ★ 소스 문자열을 정규식으로 읽어 단정하지 않는다. pglite 에 정본 SQL 을 적용하고
 *   **실제 서비스를 호출**해서 DB 에 실제로 박힌 것만 단정한다.
 *
 * ⚠ 023~026 마이그레이션은 «다른 에이전트»가 만든다. 파일이 있으면 그것을 읽어 적용하고,
 *   아직 없으면 **계약 §2~§4 의 정본 SQL 을 이 파일 안에서 인라인으로** 적용한다.
 *   (인라인 SQL 은 계약 문서에서 한 글자도 바꾸지 않고 옮긴 것이다.)
 *
 * ⚠ 뮤테이션 검증용 후크: `CONTRIB_APPLY_PATH` 환경변수가 있으면 그 경로의 서비스를 부른다.
 *   저장소 파일에 뮤턴트를 심지 않기 위한 것이다(설계 §8-3).
 *
 * 실행: cross-env NODE_ENV=test node tests/test_contribution_apply.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRV = path.join(__dirname, '..');
const MIG = path.join(SRV, 'scripts', 'migrations');
const BASELINE = path.join(MIG, '000_baseline.sql');

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

// ── 계약 §2 정본 SQL (023) ──────────────────────────────────────────────────
const SQL_023 = `
CREATE TABLE IF NOT EXISTS data_inspection (
  inspection_id  BIGSERIAL PRIMARY KEY,
  product_id     BIGINT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  axis           TEXT   NOT NULL,
  source_kind    TEXT   NOT NULL,
  evidence_ref   TEXT,
  found_count    INTEGER,
  scope_note     TEXT,
  inspected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT di_axis_chk CHECK (axis IN ('nutrition','ingredients','allergens','additives'))
);
CREATE INDEX IF NOT EXISTS idx_di_product_axis
  ON data_inspection (product_id, axis, inspected_at DESC);
`;

// ── 계약 §3 정본 SQL (024) ──────────────────────────────────────────────────
const SQL_024 = `
CREATE TABLE IF NOT EXISTS contribution_review (
  review_id       BIGSERIAL PRIMARY KEY,
  contribution_id BIGINT NOT NULL REFERENCES contributions(contribution_id) ON DELETE CASCADE,
  product_id      BIGINT REFERENCES products(product_id) ON DELETE CASCADE,
  axis            TEXT   NOT NULL,
  status          TEXT   NOT NULL DEFAULT 'candidate',
  reviewed_by     TEXT,
  reviewed_at     TIMESTAMPTZ,
  applied_at      TIMESTAMPTZ,
  reject_reason   TEXT,
  evidence        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cr_axis_chk   CHECK (axis IN ('nutrition','ingredients','allergens','additives')),
  CONSTRAINT cr_status_chk CHECK (status IN ('candidate','approved','rejected','undone','superseded')),
  CONSTRAINT cr_approve_human_chk CHECK (status <> 'approved' OR reviewed_by IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cr_approved_per_product_axis
  ON contribution_review (product_id, axis) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_cr_status ON contribution_review (status, created_at);
CREATE INDEX IF NOT EXISTS idx_cr_contribution ON contribution_review (contribution_id);
`;

// ── 계약 §4-1 정본 SQL (025 의 테이블 부분) ─────────────────────────────────
//   ⚠ 025 의 «뷰 개정»은 이 계약(C5)의 소관이 아니다. 파일이 있으면 통째로 적용하고,
//     없으면 이 테이블만 만든다 — 이 파일이 검증하는 것은 «쓰기»이지 뷰가 아니다.
const SQL_025_TABLE = `
CREATE TABLE IF NOT EXISTS nutrition_data_crowd (
  crowd_nutrition_id BIGSERIAL PRIMARY KEY,
  product_id      BIGINT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  calories        NUMERIC,
  total_fat       NUMERIC,
  saturated_fat   NUMERIC,
  trans_fat       NUMERIC,
  cholesterol     NUMERIC,
  sodium          NUMERIC,
  total_carbs     NUMERIC,
  total_sugars    NUMERIC,
  added_sugars    NUMERIC,
  dietary_fiber   NUMERIC,
  protein         NUMERIC,
  calcium         NUMERIC,
  iron            NUMERIC,
  vitamin_d       NUMERIC,
  potassium       NUMERIC,
  serving_size    VARCHAR,
  ocr_confidence  INTEGER,
  verified_at     TIMESTAMPTZ,
  contribution_id BIGINT REFERENCES contributions(contribution_id) ON DELETE SET NULL,
  review_id       BIGINT REFERENCES contribution_review(review_id) ON DELETE SET NULL,
  basis_original  TEXT,
  basis_stored    TEXT NOT NULL,
  convert_factor  NUMERIC,
  convert_note    TEXT,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ndc_product ON nutrition_data_crowd (product_id);
`;

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(' 세션66 C5 — applyApprovedContribution (승인 반영의 유일한 경로)');
  console.log('════════════════════════════════════════════════════════════════');

  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (_) {
    console.log('⏭  pglite 미설치 — 검증 불가. 「건너뜀」은 「통과」가 아니다. EXIT=1.');
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('§0  새 마이그레이션이 `npm run migrate` 체인에 «이어져» 있는가');
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 왜 이 단정이 여기 있나 — 세션64c 가 마이그레이션 **파일만 만들고 체인에 안 이어서**
  //   CI gate #19 를 태웠다. 「파일을 만드는 것」과 「체인에 잇는 것」은 다른 일이다.
  //   ⚠ 이것은 코드 의미가 아니라 **배포 산출물** 검사라서 파일을 읽는 것이 맞다.
  // ⚠ 023~026 은 «다른 에이전트»가 만든다. **파일이 실제로 존재하는 것만** 단정한다 —
  //   존재하지 않는 파일을 체인에서 찾으면 병렬 작업 중 거짓 빨강이 된다.
  //   파일이 하나도 없으면 이 절은 「아직 검사할 것이 없다」로 남고, 아래 인라인 SQL 로 진행한다.
  const MIG_FILES = fs.existsSync(MIG) ? fs.readdirSync(MIG) : [];
  const NEW_MIGS = MIG_FILES.filter((f) => /^(023|024|025|026)_.*\.sql$/.test(f)).sort();
  if (NEW_MIGS.length === 0) {
    console.log('  ⓘ 023~026 이 아직 없다 — 계약 §2~§4 정본 SQL 을 «인라인»으로 적용해 진행한다.');
    console.log('    (에이전트 B 가 파일을 만들면 이 절이 자동으로 체인 검사를 시작한다.)');
  }
  for (const f of NEW_MIGS) {
    await t(`§0 package.json 의 migrate 체인이 ${f} 를 ON_ERROR_STOP=1 로 실행한다`, () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(SRV, 'package.json'), 'utf8'));
      const chain = String(pkg.scripts.migrate || '');
      assert.ok(chain.includes(f),
        `${f} 가 \`npm run migrate\` 체인에 없다. 파일만 만들고 체인에 안 이으면 `
        + '빈 DB·CI·신규 환경에 테이블이 영원히 안 생긴다(세션64c gate #19 와 같은 사고).');
      const seg = chain.split('&&').find((x) => x.includes(f));
      assert.ok(/-v\s+ON_ERROR_STOP=1/.test(seg),
        `${f} 구간에 -v ON_ERROR_STOP=1 이 없다: ${String(seg).trim()}`);
    });
  }

  // ── DB 준비 ────────────────────────────────────────────────────────────────
  const db = new PGlite();
  try {
    await db.exec(fs.readFileSync(BASELINE, 'utf8'));
  } catch (e) {
    console.error(`000_baseline.sql 적용 실패: ${e.message}`);
    process.exit(1);
  }

  const applied = [];
  const applyMig = async (prefix, inlineSql, label) => {
    const f = NEW_MIGS.find((x) => x.startsWith(prefix));
    if (f) {
      await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
      applied.push(`${f} (파일)`);
    } else if (inlineSql) {
      await db.exec(inlineSql);
      applied.push(`${label} (계약 인라인)`);
    } else {
      applied.push(`${label} (없음 — 건너뜀)`);
    }
  };
  await applyMig('023', SQL_023, '023 data_inspection');
  await applyMig('024', SQL_024, '024 contribution_review');
  await applyMig('025', SQL_025_TABLE, '025 nutrition_data_crowd');
  // ★ 026 은 «있으면만» 적용한다 — 인라인 대체본이 없다(이관 SQL 은 C4 소관이다).
  //   적용하면 `nutrition_data_no_crowd_chk` 가 살아나므로, 이 파일의 「제보는 공공 테이블을
  //   건드리지 않는다」(§4-2)가 **DB 제약으로도** 확인된다.
  await applyMig('026', null, '026');
  console.log(`  ⓘ 적용한 스키마: ${applied.join(' · ')}`);

  // ── DB shim 을 «먼저» 심고, 그 «다음»에» 서비스를 require 한다 ────────────
  //   뒤집으면 진짜 pg Pool 이 붙는다(계약 §10).
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

  // ⚠ 뮤테이션 검증용 후크. 평소에는 저장소 파일을 쓴다.
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
      [`S66C5_${seq}`, name, meta.serving_size ?? null, meta.serving_unit ?? null,
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
  /** 제품 + 제보 + 리뷰를 한 번에. */
  async function scenario(name, data, axis, meta = {}, status = 'approved') {
    const productId = await mkProduct(name, meta);
    const contributionId = await mkContribution(productId, data);
    const reviewId = await mkReview(contributionId, productId, axis, status);
    return { productId, contributionId, reviewId };
  }
  const crowdRow = async (productId) => {
    const r = await db.query('SELECT * FROM nutrition_data_crowd WHERE product_id = $1', [productId]);
    return r.rows[0] || null;
  };
  const numOf = (v) => (v === null || v === undefined ? null : Number(v));

  const NUT_100G = {
    _basis: 'per_100g',
    calories: 100, sodium: 200, protein: 5, total_fat: 3, saturated_fat: 1,
    trans_fat: 0, cholesterol: 0, total_carbs: 20, total_sugars: 10, dietary_fiber: 2,
  };

  // ══════════════════════════════════════════════════════════════════════════
  section('§1  순수 함수 3개 — DB 없이 단정한다');
  // ══════════════════════════════════════════════════════════════════════════
  const { resolveBasis, computeConvertFactor, scaleNutrition } = SERVICE;

  await t('§1-1 resolveBasis 가 parsed_nutrition._basis 를 읽는다', () => {
    const r = resolveBasis({ parsed_nutrition: { _basis: 'per_100g' } }, null);
    assert.strictEqual(r.basis, 'per_100g');
    assert.strictEqual(r.evidence.from, 'data.parsed_nutrition._basis');
  });

  await t('§1-2 ★ 어휘 밖의 기준은 basis:null 이다 — 추정하지 않는다', () => {
    for (const bad of ['unknown', 'per_pack', '', null, undefined, 123]) {
      const r = resolveBasis({ parsed_nutrition: { _basis: bad } }, null);
      assert.strictEqual(r.basis, null, `${JSON.stringify(bad)} 가 basis 로 인정됐다`);
    }
    // 제보 자체에 영양이 없으면 당연히 null
    assert.strictEqual(resolveBasis({}, null).basis, null);
    assert.strictEqual(resolveBasis(null, null).basis, null);
  });

  await t('§1-3 ★ rejected_nutrition 은 기준의 출처가 «아니다»', () => {
    // 저장 게이트가 「쓸 수 없다」고 판정한 값이 승인 경로로 우회 입장하면 안 된다.
    const r = resolveBasis({ rejected_nutrition: { _basis: 'per_100g' } }, null);
    assert.strictEqual(r.basis, null,
      'rejected_nutrition 의 기준을 채택했다 — 게이트가 막은 값이 우회 입장한다');
  });

  await t('§1-4 목표 기준: 공공 영양 행이 있으면 그 행의 basis 마커를 따른다', () => {
    const a = resolveBasis({ parsed_nutrition: { _basis: 'per_serving' } },
      { has_public_nutrition: true, public_serving_marker: '100g' });
    assert.strictEqual(a.evidence.product_basis, 'per_100g');
    const b = resolveBasis({ parsed_nutrition: { _basis: 'per_serving' } },
      { has_public_nutrition: true, public_serving_marker: '100ml' });
    assert.strictEqual(b.evidence.product_basis, 'per_100ml');
    // 공공 행이 없으면 목표가 없다 — 제보 기준을 그대로 쓴다
    const c = resolveBasis({ parsed_nutrition: { _basis: 'per_serving' } },
      { has_public_nutrition: false, public_serving_marker: null });
    assert.strictEqual(c.evidence.product_basis, null);
  });

  await t('§1-5 computeConvertFactor: 기준이 같으면 정확히 1.0', () => {
    for (const b of ['per_serving', 'per_100g', 'per_100ml', 'per_total']) {
      const r = computeConvertFactor(b, b, {});
      assert.strictEqual(r.factor, 1, `${b} 의 factor 가 1 이 아니다: ${r.factor}`);
      assert.ok(typeof r.note === 'string' && r.note.length > 0, 'note 가 비었다');
    }
  });

  await t('§1-6 computeConvertFactor: 저장값 = 원본값 × factor (곱셈 계수)', () => {
    // 100g 당 값 → 50g(1회 제공량) 기준 = × 0.5
    const a = computeConvertFactor('per_100g', 'per_serving',
      { servingSize: 50, servingUnit: 'g' });
    assert.strictEqual(a.factor, 0.5, `100g→50g 은 0.5 여야 한다: ${a.factor}`);
    // 50g(1회) → 100g 기준 = × 2
    const b = computeConvertFactor('per_serving', 'per_100g',
      { servingSize: 50, servingUnit: 'g' });
    assert.strictEqual(b.factor, 2, `50g→100g 은 2 여야 한다: ${b.factor}`);
    // 총 내용량 500g → 1회 100g = × 0.2
    const c = computeConvertFactor('per_total', 'per_serving',
      { totalContent: 500, contentUnit: 'g', servingSize: 100, servingUnit: 'g' });
    assert.strictEqual(c.factor, 0.2, `500g→100g 은 0.2 여야 한다: ${c.factor}`);
  });

  await t('§1-7 ★ 환산 근거가 없으면 CONVERT_BASIS_UNKNOWN 을 던진다', async () => {
    // 1회 제공량을 모른다
    await throwsCode(() => computeConvertFactor('per_100g', 'per_serving', {}),
      'CONVERT_BASIS_UNKNOWN');
    // 총 내용량을 모른다
    await throwsCode(() => computeConvertFactor('per_total', 'per_100g', { contentUnit: 'g' }),
      'CONVERT_BASIS_UNKNOWN');
    // 단위를 모른다 (숫자만 있고 g/ml 가 없다) — g 로 «가정»하지 않는다
    await throwsCode(() => computeConvertFactor('per_100g', 'per_serving', { servingSize: 50 }),
      'CONVERT_BASIS_UNKNOWN');
    // 0 이나 음수는 근거가 아니다
    await throwsCode(
      () => computeConvertFactor('per_100g', 'per_serving', { servingSize: 0, servingUnit: 'g' }),
      'CONVERT_BASIS_UNKNOWN');
  });

  await t('§1-8 ★ g ↔ ml 환산은 던진다 (밀도를 모른다)', async () => {
    await throwsCode(() => computeConvertFactor('per_100g', 'per_100ml', {}),
      'CONVERT_BASIS_UNKNOWN');
    await throwsCode(
      () => computeConvertFactor('per_100ml', 'per_serving', { servingSize: 30, servingUnit: 'g' }),
      'CONVERT_BASIS_UNKNOWN');
  });

  await t('§1-9 computeConvertFactor: 기준 자체를 모르면 BASIS_UNKNOWN', async () => {
    await throwsCode(() => computeConvertFactor(null, 'per_100g', {}), 'BASIS_UNKNOWN');
    await throwsCode(() => computeConvertFactor('per_pack', 'per_100g', {}), 'BASIS_UNKNOWN');
  });

  await t('§1-10 scaleNutrition 은 새 객체를 돌려주고 입력을 바꾸지 않는다', () => {
    const input = { calories: 100, sodium: 200, _basis: 'per_100g' };
    const frozen = JSON.stringify(input);
    const out = scaleNutrition(input, 0.5);
    assert.strictEqual(JSON.stringify(input), frozen, '입력이 변경됐다');
    assert.notStrictEqual(out, input, '같은 객체를 돌려줬다');
    assert.strictEqual(out.calories, 50);
    assert.strictEqual(out.sodium, 100);
    assert.strictEqual(out._basis, undefined,
      '_basis 가 따라 나왔다 — 환산 뒤에도 옛 기준이 붙어 다니면 반드시 틀리게 읽힌다');
  });

  await t('§1-11 scaleNutrition: factor 1 은 값을 «건드리지 않는다»', () => {
    const out = scaleNutrition({ calories: 0.0001, sodium: 0, protein: null }, 1);
    assert.strictEqual(out.calories, 0.0001, '반올림에 미세값이 삼켜졌다');
    assert.strictEqual(out.sodium, 0, '0 이 사라졌다 — 0 은 「없음」이 아니다');
    assert.strictEqual(out.protein, null, 'null 은 null 로 남아야 한다(키 자체가 없는 것과 다르다)');
  });

  await t('§1-12 scaleNutrition: 잘못된 계수는 조용히 NaN 을 만들지 않고 던진다', async () => {
    for (const bad of [0, -1, NaN, null, undefined, 'x']) {
      await throwsCode(() => scaleNutrition({ calories: 100 }, bad), 'CONVERT_BASIS_UNKNOWN');
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§2  승인되지 않은 것은 «옮기지 않는다»');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§2-1 status=candidate 면 REVIEW_NOT_APPROVED 이고 아무것도 안 쓴다', async () => {
    const s = await scenario('§2 미승인', { parsed_nutrition: NUT_100G }, 'nutrition', {}, 'candidate');
    await throwsCode(() => SERVICE.applyApprovedContribution(client, s.reviewId, { appliedBy: 'jay' }),
      'REVIEW_NOT_APPROVED');
    assert.strictEqual(await crowdRow(s.productId), null, '미승인 제보가 저장됐다');
    const di = await db.query('SELECT count(*)::int c FROM data_inspection WHERE product_id=$1', [s.productId]);
    assert.strictEqual(di.rows[0].c, 0, '미승인인데 검사 기록이 남았다');
  });

  await t('§2-2 status=rejected 도 REVIEW_NOT_APPROVED', async () => {
    const s = await scenario('§2 반려', { parsed_nutrition: NUT_100G }, 'nutrition', {}, 'rejected');
    await throwsCode(() => SERVICE.applyApprovedContribution(client, s.reviewId), 'REVIEW_NOT_APPROVED');
    assert.strictEqual(await crowdRow(s.productId), null);
  });

  await t('§2-3 없는 review_id 는 REVIEW_NOT_FOUND', async () => {
    await throwsCode(() => SERVICE.applyApprovedContribution(client, 99999999), 'REVIEW_NOT_FOUND');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§3·§4  멱등 · 기준이 같을 때');
  // ══════════════════════════════════════════════════════════════════════════
  const same = await scenario('§4 기준 동일', { parsed_nutrition: NUT_100G, avg_confidence: 0.93 },
    'nutrition');

  await t('§4-1 공공 행이 없으면 제보 기준 그대로 · convert_factor = 1.0 · 값이 그대로', async () => {
    const r = await SERVICE.applyApprovedContribution(client, same.reviewId, { appliedBy: 'jay' });
    assert.strictEqual(r.applied, true);
    assert.strictEqual(r.axis, 'nutrition');
    assert.strictEqual(r.convert.factor, 1, `factor 가 1 이 아니다: ${r.convert.factor}`);
    assert.strictEqual(r.convert.basis_original, 'per_100g');
    assert.strictEqual(r.convert.basis_stored, 'per_100g');

    const row = await crowdRow(same.productId);
    assert.ok(row, 'nutrition_data_crowd 에 행이 없다');
    assert.strictEqual(numOf(row.calories), 100, '값이 변형됐다');
    assert.strictEqual(numOf(row.sodium), 200);
    assert.strictEqual(numOf(row.convert_factor), 1);
    assert.strictEqual(row.basis_stored, 'per_100g');
    assert.strictEqual(row.serving_size, '100g',
      'basis 마커가 안 적혔다 — deriveBasis 가 이 문자열로 판정한다');
    assert.strictEqual(row.ocr_confidence, 93);
    assert.strictEqual(Number(row.review_id), same.reviewId, '계보(review_id)가 안 남았다');
  });

  await t('§4-2 ★ 제보는 nutrition_data(공공 테이블)를 «건드리지 않는다» (U65-6 소멸)', async () => {
    const r = await db.query('SELECT count(*)::int c FROM nutrition_data WHERE product_id=$1',
      [same.productId]);
    assert.strictEqual(r.rows[0].c, 0,
      '승인된 제보가 공공 테이블에 들어갔다 — 물리 분리(DS-7)가 깨졌다');
  });

  await t('§3-1 ★ 두 번째 호출은 ALREADY_APPLIED — 두 번 옮기지 않는다', async () => {
    await throwsCode(() => SERVICE.applyApprovedContribution(client, same.reviewId, { appliedBy: 'jay' }),
      'ALREADY_APPLIED');
    const di = await db.query(
      'SELECT count(*)::int c FROM data_inspection WHERE product_id=$1 AND axis=$2',
      [same.productId, 'nutrition']);
    assert.strictEqual(di.rows[0].c, 1, '검사 기록이 두 번 남았다 — 멱등이 아니다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§5  기준이 다르고 근거가 있으면 «환산»해서 저장한다 (DS-9)');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§5-1 공공 행이 100g 기준 · 제보가 1회(50g) 기준 → × 2 로 환산되어 저장된다', async () => {
    const productId = await mkProduct('§5 환산', { serving_size: 50, serving_unit: 'g' });
    await mkPublicNutrition(productId, '100g', { calories: 999 });
    const cid = await mkContribution(productId, {
      parsed_nutrition: { _basis: 'per_serving', calories: 60, sodium: 15, protein: 2 },
      avg_confidence: 0.9,
    });
    const rid = await mkReview(cid, productId, 'nutrition');

    const r = await SERVICE.applyApprovedContribution(client, rid, { appliedBy: 'jay' });
    assert.strictEqual(r.convert.basis_original, 'per_serving');
    assert.strictEqual(r.convert.basis_stored, 'per_100g',
      '공공 행의 기준(100g)에 맞추지 않았다 — 통합이 안 된다');
    assert.strictEqual(r.convert.factor, 2, `factor 가 2 가 아니다: ${r.convert.factor}`);

    const row = await crowdRow(productId);
    assert.strictEqual(numOf(row.calories), 120, `60 × 2 = 120 이어야 한다: ${row.calories}`);
    assert.strictEqual(numOf(row.sodium), 30);
    assert.strictEqual(numOf(row.protein), 4);
    assert.strictEqual(row.basis_stored, 'per_100g');
    assert.strictEqual(row.serving_size, '100g');
    assert.ok(typeof row.convert_note === 'string' && row.convert_note.length > 0,
      'convert_note 가 비었다 — 무엇을 무엇으로 나눴는지 남지 않으면 되돌릴 수 없다');
    assert.ok(row.convert_note.includes('per_serving') && row.convert_note.includes('per_100g'),
      `convert_note 에 기준이 안 적혔다: ${row.convert_note}`);
    // 공공 값은 그대로다 — 제보가 덮지 않는다
    const nd = await db.query('SELECT calories FROM nutrition_data WHERE product_id=$1', [productId]);
    assert.strictEqual(numOf(nd.rows[0].calories), 999, '제보가 공공 값을 덮었다');
  });

  await t('§5-2 per_total 은 «저장 기준이 될 수 없다» — 1회분으로 환산해서 저장한다', async () => {
    // 총 500g / 1회 100g → × 0.2
    const productId = await mkProduct('§5 총량', {
      serving_size: 100, serving_unit: 'g', total_content: 500, content_unit: 'g',
    });
    const cid = await mkContribution(productId, {
      parsed_nutrition: { _basis: 'per_total', calories: 1000, sodium: 2500 },
    });
    const rid = await mkReview(cid, productId, 'nutrition');
    const r = await SERVICE.applyApprovedContribution(client, rid);
    assert.strictEqual(r.convert.basis_stored, 'per_serving',
      'per_total 로 저장하면 마커가 없어 deriveBasis 가 per_serving 으로 읽는다 = 총량을 1회분으로 오독');
    assert.strictEqual(r.convert.factor, 0.2);
    const row = await crowdRow(productId);
    assert.strictEqual(numOf(row.calories), 200, `1000 × 0.2 = 200 이어야 한다: ${row.calories}`);
    assert.strictEqual(row.serving_size, null,
      'per_serving 은 마커가 «없는» 것이 그 자체로 per_serving 이다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§6·§7  ★ 모르면 «던진다». 추정값을 저장하지 않는다');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§6-1 ★ 기준을 모르면 BASIS_UNKNOWN — 아무것도 저장되지 않는다', async () => {
    const s = await scenario('§6 기준불명',
      { parsed_nutrition: { calories: 100, sodium: 200 } }, 'nutrition');
    const e = await throwsCode(() => SERVICE.applyApprovedContribution(client, s.reviewId, { appliedBy: 'jay' }),
      'BASIS_UNKNOWN');
    assert.ok(e.evidence, '.evidence 가 없다 — 관리자가 무엇을 봤는지 알 수 없다');
    assert.strictEqual(await crowdRow(s.productId), null, '★ 추정값이 저장됐다');
    const cr = await db.query('SELECT applied_at FROM contribution_review WHERE review_id=$1', [s.reviewId]);
    assert.strictEqual(cr.rows[0].applied_at, null, '실패했는데 applied_at 이 찍혔다');
    const di = await db.query('SELECT count(*)::int c FROM data_inspection WHERE product_id=$1', [s.productId]);
    assert.strictEqual(di.rows[0].c, 0, '실패했는데 검사 기록이 남았다');
  });

  await t('§6-2 ★ _basis 가 "unknown" 이어도 BASIS_UNKNOWN 이다', async () => {
    const s = await scenario('§6 unknown',
      { parsed_nutrition: { _basis: 'unknown', calories: 100 } }, 'nutrition');
    await throwsCode(() => SERVICE.applyApprovedContribution(client, s.reviewId), 'BASIS_UNKNOWN');
    assert.strictEqual(await crowdRow(s.productId), null);
  });

  await t('§7-1 ★ 환산 근거가 없으면 CONVERT_BASIS_UNKNOWN — 아무것도 저장되지 않는다', async () => {
    // 공공 행은 100g 기준인데 제보는 1회 기준이고, 1회 제공량을 «아무도 모른다»
    const productId = await mkProduct('§7 근거없음');   // serving_size = null
    await mkPublicNutrition(productId, '100g', { calories: 500 });
    const cid = await mkContribution(productId, {
      parsed_nutrition: { _basis: 'per_serving', calories: 60 },
    });
    const rid = await mkReview(cid, productId, 'nutrition');
    const e = await throwsCode(() => SERVICE.applyApprovedContribution(client, rid), 'CONVERT_BASIS_UNKNOWN');
    assert.ok(/총 내용량|1회 제공량/.test(e.message),
      `관리자에게 무엇을 채우라고 말하지 않는다: ${e.message}`);
    assert.strictEqual(await crowdRow(productId), null, '★ 추정 환산값이 저장됐다');
  });

  await t('§7-2 ★ 단위가 g ↔ ml 로 어긋나면 CONVERT_BASIS_UNKNOWN', async () => {
    const productId = await mkProduct('§7 단위', { serving_size: 200, serving_unit: 'ml', content_unit: 'ml' });
    await mkPublicNutrition(productId, '100g', { calories: 10 });
    const cid = await mkContribution(productId, {
      parsed_nutrition: { _basis: 'per_serving', calories: 60 },
    });
    const rid = await mkReview(cid, productId, 'nutrition');
    await throwsCode(() => SERVICE.applyApprovedContribution(client, rid), 'CONVERT_BASIS_UNKNOWN');
    assert.strictEqual(await crowdRow(productId), null);
  });

  await t('§7-3 per_total 인데 총 내용량을 모르면 CONVERT_BASIS_UNKNOWN', async () => {
    const s = await scenario('§7 총량불명',
      { parsed_nutrition: { _basis: 'per_total', calories: 1000 } }, 'nutrition',
      { serving_size: 100, serving_unit: 'g' });
    await throwsCode(() => SERVICE.applyApprovedContribution(client, s.reviewId), 'CONVERT_BASIS_UNKNOWN');
    assert.strictEqual(await crowdRow(s.productId), null);
  });

  await t('§7-4 영양값이 0개면 NOTHING_TO_APPLY (빈 행을 만들지 않는다)', async () => {
    const s = await scenario('§7 값없음', { parsed_nutrition: { _basis: 'per_100g' } }, 'nutrition');
    await throwsCode(() => SERVICE.applyApprovedContribution(client, s.reviewId), 'NOTHING_TO_APPLY');
    assert.strictEqual(await crowdRow(s.productId), null);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§8  4축이 각각 «올바른 테이블»에 쓴다');
  // ══════════════════════════════════════════════════════════════════════════
  // 첨가물 마스터 시드
  for (const n of ['카라멜색소', '구연산']) {
    await db.query('INSERT INTO additives (name_ko, risk_color) VALUES ($1, $2)', [n, 'green']);
  }

  await t('§8-1 axis=ingredients → product_ingredients 에만 쓴다', async () => {
    const s = await scenario('§8 원재료', {
      parsed_ingredients: [{ name: '정제수' }, { name: '설탕' }],
      ocr_raw_text: '원재료명: 정제수, 설탕',
    }, 'ingredients');
    const r = await SERVICE.applyApprovedContribution(client, s.reviewId, { appliedBy: 'jay' });
    assert.strictEqual(r.axis, 'ingredients');
    const pi = await db.query(
      'SELECT raw_text, parsed_ingredients, source FROM product_ingredients WHERE product_id=$1',
      [s.productId]);
    assert.strictEqual(pi.rows.length, 1, `행이 ${pi.rows.length} 개다`);
    assert.strictEqual(pi.rows[0].raw_text, '원재료명: 정제수, 설탕');
    assert.deepStrictEqual(pi.rows[0].parsed_ingredients, ['정제수', '설탕']);
    // 다른 축의 테이블은 안 건드린다
    assert.strictEqual(await crowdRow(s.productId), null, '원재료 축이 영양 테이블을 건드렸다');
    const pa = await db.query('SELECT count(*)::int c FROM product_allergens WHERE product_id=$1', [s.productId]);
    assert.strictEqual(pa.rows[0].c, 0, '원재료 축이 알레르겐 테이블을 건드렸다');
  });

  await t('§8-1b ★ 중복 적재 가드 — 같은 원문이 두 줄이 되지 않는다 (UNIQUE 가 없다)', async () => {
    // 같은 제품·같은 원문으로 두 번째 제보를 승인한다(다른 review 라 ALREADY_APPLIED 가 아니다).
    const productId = await mkProduct('§8 중복');
    const data = { parsed_ingredients: [{ name: '밀가루' }], ocr_raw_text: '원재료명: 밀가루' };
    const c1 = await mkContribution(productId, data);
    const r1 = await mkReview(c1, productId, 'ingredients');
    await SERVICE.applyApprovedContribution(client, r1);
    // 1건을 superseded 로 내려 UNIQUE(승인 1건) 제약을 비운 뒤 두 번째를 승인한다
    await db.query(`UPDATE contribution_review SET status='superseded' WHERE review_id=$1`, [r1]);
    const c2 = await mkContribution(productId, data);
    const r2 = await mkReview(c2, productId, 'ingredients');
    const out = await SERVICE.applyApprovedContribution(client, r2);
    assert.strictEqual(out.counts.inserted, 0, '같은 원문이 다시 INSERT 됐다');
    const pi = await db.query('SELECT count(*)::int c FROM product_ingredients WHERE product_id=$1', [productId]);
    assert.strictEqual(pi.rows[0].c, 1, `원재료가 ${pi.rows[0].c} 줄이다 — 중복 적재 가드가 없다`);
  });

  await t('§8-2 axis=allergens → product_allergens 에 등급과 함께 쓴다', async () => {
    const s = await scenario('§8 알레르겐', {
      allergens: ['우유'],
      allergens_v2: { contains: ['우유'], inferred: [], mayContain: ['대두'] },
    }, 'allergens');
    const r = await SERVICE.applyApprovedContribution(client, s.reviewId, { appliedBy: 'jay' });
    const expected = SERVICE.buildAllergenList({
      allergens: ['우유'],
      allergens_v2: { contains: ['우유'], inferred: [], mayContain: ['대두'] },
    }).list;
    const pa = await db.query(
      'SELECT allergen_name, evidence_level, detected_via FROM product_allergens WHERE product_id=$1 ORDER BY allergen_name',
      [s.productId]);
    assert.strictEqual(pa.rows.length, expected.length,
      `알레르겐 ${pa.rows.length} 행 (기대 ${expected.length})`);
    const byName = new Map(pa.rows.map((x) => [x.allergen_name, x]));
    for (const e of expected) {
      assert.ok(byName.has(e.name), `${e.name} 이 저장되지 않았다`);
      assert.strictEqual(byName.get(e.name).evidence_level, e.evidence_level,
        `${e.name} 의 등급이 다르다`);
      assert.strictEqual(byName.get(e.name).detected_via, SERVICE.ALLERGEN_DETECTED_VIA,
        '★ detected_via 가 crowdsource_merge 면 다음 병합이 이 행을 삭제한다');
    }
    assert.strictEqual(r.counts.allergens, expected.length);
  });

  await t('§8-2b ★★ evidence_level 은 «올리기만» 한다 — 등급을 내리지 않는다', async () => {
    // ★ 이 방향을 안 재면 「EXCLUDED.evidence_level 을 그대로 대입」하는 코드가 통과한다.
    //   그러면 이번 제보가 «혼입만» 읽었을 때 식약처가 적어 둔 「직접 함유」가 강등된다 —
    //   화면에서 붉은 태그가 점선으로 바뀐다 = **경고를 지우는 방향**이다.
    //   `mergeService.js` 가 세션45 에 같은 결함을 고쳤고, 그 CASE 를 그대로 옮겨 왔다.
    const productId = await mkProduct('§8 등급강등');
    const data = {
      allergens: [],
      allergens_v2: { contains: [], inferred: [], mayContain: ['대두', '밀'] },
    };
    const list = SERVICE.buildAllergenList(data).list;
    assert.strictEqual(list.length, 2, `픽스처 전제가 깨졌다: ${JSON.stringify(list)}`);
    for (const a of list) {
      assert.strictEqual(a.evidence_level, 'may_contain', `${a.name} 이 may_contain 이 아니다`);
    }
    const [soy, wheat] = list;
    // 이미 «더 강한» 등급으로 적혀 있는 행 두 개
    await db.query(
      `INSERT INTO product_allergens (product_id, allergen_name, source_count, status, detected_via, evidence_level)
       VALUES ($1, $2, 3, 'confirmed', 'haccp_api', 'contains')`, [productId, soy.name]);
    await db.query(
      `INSERT INTO product_allergens (product_id, allergen_name, source_count, status, detected_via, evidence_level)
       VALUES ($1, $2, 1, 'candidate', 'haccp_api', 'inferred')`, [productId, wheat.name]);

    const cid = await mkContribution(productId, data);
    const rid = await mkReview(cid, productId, 'allergens');
    await SERVICE.applyApprovedContribution(client, rid, { appliedBy: 'jay' });

    const r = await db.query(
      'SELECT allergen_name, evidence_level FROM product_allergens WHERE product_id=$1', [productId]);
    const m = new Map(r.rows.map((x) => [x.allergen_name, x.evidence_level]));
    assert.strictEqual(m.get(soy.name), 'contains',
      `★ 「직접 함유」가 ${m.get(soy.name)} 로 강등됐다 — 경고를 지우는 방향이다`);
    assert.strictEqual(m.get(wheat.name), 'inferred',
      `★ 「원재료 추정」이 ${m.get(wheat.name)} 로 강등됐다`);
  });

  await t('§8-3 axis=additives → additiveResolver 를 통해 product_additives 에 쓴다', async () => {
    const s = await scenario('§8 첨가물', {
      parsed_ingredients: [{ name: '정제수' }, { name: '카라멜색소' }, { name: '구연산' }],
      avg_confidence: 0.88,
    }, 'additives');
    const r = await SERVICE.applyApprovedContribution(client, s.reviewId, { appliedBy: 'jay' });
    const pad = await db.query(
      `SELECT a.name_ko, pa.detected_name, pa.confidence
         FROM product_additives pa JOIN additives a ON a.additive_id = pa.additive_id
        WHERE pa.product_id = $1 ORDER BY a.name_ko`, [s.productId]);
    const names = pad.rows.map((x) => x.name_ko);
    assert.ok(names.includes('카라멜색소'), `카라멜색소가 저장되지 않았다: ${JSON.stringify(names)}`);
    assert.ok(names.includes('구연산'), `구연산이 저장되지 않았다: ${JSON.stringify(names)}`);
    assert.strictEqual(pad.rows[0].confidence, 88, 'confidence 가 안 넘어갔다');
    assert.ok(r.counts.matched >= 2, `matched=${r.counts.matched}`);
    // 원재료 테이블은 안 건드린다 — 축이 다르다
    const pi = await db.query('SELECT count(*)::int c FROM product_ingredients WHERE product_id=$1', [s.productId]);
    assert.strictEqual(pi.rows[0].c, 0, '첨가물 축이 원재료 테이블을 건드렸다');
  });

  await t('§8-4 알 수 없는 축은 UNSUPPORTED_AXIS (CHECK 를 우회해 넣어도)', async () => {
    const productId = await mkProduct('§8 이상축');
    const cid = await mkContribution(productId, {});
    // CHECK 제약이 있으므로 정상 축으로 넣은 뒤 제약을 잠시 내려 값을 바꾼다.
    const rid = await mkReview(cid, productId, 'nutrition');
    await db.query('ALTER TABLE contribution_review DROP CONSTRAINT cr_axis_chk');
    await db.query(`UPDATE contribution_review SET axis='calories_only' WHERE review_id=$1`, [rid]);
    try {
      await throwsCode(() => SERVICE.applyApprovedContribution(client, rid), 'UNSUPPORTED_AXIS');
    } finally {
      await db.query(`UPDATE contribution_review SET axis='nutrition' WHERE review_id=$1`, [rid]);
      await db.query(`ALTER TABLE contribution_review ADD CONSTRAINT cr_axis_chk
        CHECK (axis IN ('nutrition','ingredients','allergens','additives'))`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§9  data_inspection — 「봤는데 없었다」를 적을 수 있다 (U63-6)');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§9-1 4축 모두 data_inspection 에 1행씩 남는다 (source_kind · evidence_ref 포함)', async () => {
    const r = await db.query(
      `SELECT axis, source_kind, evidence_ref, found_count FROM data_inspection ORDER BY inspection_id`);
    const axes = new Set(r.rows.map((x) => x.axis));
    for (const a of ['nutrition', 'ingredients', 'allergens', 'additives']) {
      assert.ok(axes.has(a), `axis=${a} 의 검사 기록이 없다`);
    }
    for (const row of r.rows) {
      assert.strictEqual(row.source_kind, 'ocr_label', `source_kind 가 ${row.source_kind} 다`);
      assert.ok(row.evidence_ref && /^\d+$/.test(row.evidence_ref),
        `evidence_ref 에 contribution_id 가 없다: ${row.evidence_ref}`);
    }
  });

  await t('§9-2 ★★ 알레르겐 0종이면 found_count = 0 이다 (행이 없는 것 ≠ 0종)', async () => {
    const s = await scenario('§9 알레르겐 0종', {
      allergens: [],
      allergens_v2: { contains: [], inferred: [], mayContain: [] },
    }, 'allergens');
    const r = await SERVICE.applyApprovedContribution(client, s.reviewId, { appliedBy: 'jay' });
    assert.strictEqual(r.applied, true,
      '★ 「봤는데 0종」이 NOTHING_TO_APPLY 가 됐다 — 그러면 U63-6 을 못 푼다');
    assert.strictEqual(r.counts.allergens, 0);

    const di = await db.query(
      `SELECT found_count FROM data_inspection WHERE product_id=$1 AND axis='allergens'`, [s.productId]);
    assert.strictEqual(di.rows.length, 1, '검사 기록이 없다 — 「안 봤다」와 구분이 안 된다');
    assert.strictEqual(di.rows[0].found_count, 0,
      `★ found_count 가 ${di.rows[0].found_count} 다. 0 이어야 「봤는데 없었다」가 된다`);

    const pa = await db.query('SELECT count(*)::int c FROM product_allergens WHERE product_id=$1', [s.productId]);
    assert.strictEqual(pa.rows[0].c, 0, '0종인데 알레르겐 행이 생겼다');
  });

  await t('§9-3 알레르기 항목 «자체»가 없으면 NOTHING_TO_APPLY — 검사 기록도 안 남는다', async () => {
    // 「안 봤다」와 「봤는데 없었다」의 구분이 이 두 테스트다.
    const s = await scenario('§9 안봄', { parsed_ingredients: [] }, 'allergens');
    await throwsCode(() => SERVICE.applyApprovedContribution(client, s.reviewId), 'NOTHING_TO_APPLY');
    const di = await db.query(
      `SELECT count(*)::int c FROM data_inspection WHERE product_id=$1 AND axis='allergens'`, [s.productId]);
    assert.strictEqual(di.rows[0].c, 0, '안 봤는데 「봤다」는 기록이 남았다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§11  before / after 가 evidence 에 «반드시» 남는다');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§11-1 evidence 에 before·after·convert 가 들어간다', async () => {
    const r = await db.query('SELECT evidence FROM contribution_review WHERE review_id=$1', [same.reviewId]);
    const ev = typeof r.rows[0].evidence === 'string'
      ? JSON.parse(r.rows[0].evidence) : r.rows[0].evidence;
    assert.ok(ev && typeof ev === 'object', 'evidence 가 비었다');
    assert.ok(Object.prototype.hasOwnProperty.call(ev, 'before'),
      '★ before 가 없다 — undo 가 원리적으로 불가능해진다');
    assert.ok(Object.prototype.hasOwnProperty.call(ev, 'after'), '★ after 가 없다');
    assert.strictEqual(ev.before.crowd_row, null, '적용 전엔 행이 없었다');
    assert.ok(ev.after.crowd_row, '적용 후 행이 after 에 안 담겼다');
    assert.strictEqual(ev.convert.basis_stored, 'per_100g');
    assert.strictEqual(ev.applied_by, 'jay');
  });

  await t('§11-2 기존 evidence(병합 판정 등)를 «덮어쓰지 않는다»', async () => {
    const s = await scenario('§11 병합증거', { parsed_nutrition: NUT_100G }, 'nutrition');
    await db.query(
      `UPDATE contribution_review SET evidence = '{"merge_median":{"calories":100}}'::jsonb
        WHERE review_id=$1`, [s.reviewId]);
    await SERVICE.applyApprovedContribution(client, s.reviewId);
    const r = await db.query('SELECT evidence FROM contribution_review WHERE review_id=$1', [s.reviewId]);
    const ev = typeof r.rows[0].evidence === 'string' ? JSON.parse(r.rows[0].evidence) : r.rows[0].evidence;
    assert.ok(ev.merge_median, '병합 판정이 사라졌다 — evidence 를 통째로 덮어썼다');
    assert.ok(ev.after, 'after 가 안 들어갔다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§10  undo — 그 제보가 넣은 것«만» 되돌린다 (DS-4)');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§10-1 nutrition: 적용 전에 행이 없었으면 행이 사라진다 · applied_at 이 풀린다', async () => {
    const s = await scenario('§10 영양', { parsed_nutrition: NUT_100G }, 'nutrition');
    await SERVICE.applyApprovedContribution(client, s.reviewId, { appliedBy: 'jay' });
    assert.ok(await crowdRow(s.productId), '적용이 안 됐다');
    const u = await SERVICE.undoAppliedContribution(client, s.reviewId, { undoneBy: 'jay' });
    assert.strictEqual(u.undone, true);
    assert.strictEqual(await crowdRow(s.productId), null, '되돌렸는데 행이 남았다');
    const cr = await db.query('SELECT applied_at FROM contribution_review WHERE review_id=$1', [s.reviewId]);
    assert.strictEqual(cr.rows[0].applied_at, null, 'applied_at 이 안 풀렸다 — 재적용이 막힌다');
  });

  await t('§10-2 nutrition: «다른» 제보의 행이 있었으면 그 행이 그대로 복원된다', async () => {
    const productId = await mkProduct('§10 영양복원');
    // 먼저 다른 제보(A)가 승인·적용된 상태를 만든다
    const cA = await mkContribution(productId, {
      parsed_nutrition: { _basis: 'per_100g', calories: 11, sodium: 22 },
    });
    const rA = await mkReview(cA, productId, 'nutrition');
    await SERVICE.applyApprovedContribution(client, rA, { appliedBy: 'A' });
    await db.query(`UPDATE contribution_review SET status='superseded' WHERE review_id=$1`, [rA]);
    // 그 위에 제보 B 가 승인·적용된다
    const cB = await mkContribution(productId, {
      parsed_nutrition: { _basis: 'per_100g', calories: 99, sodium: 88 },
    });
    const rB = await mkReview(cB, productId, 'nutrition');
    await SERVICE.applyApprovedContribution(client, rB, { appliedBy: 'B' });
    assert.strictEqual(numOf((await crowdRow(productId)).calories), 99);

    await SERVICE.undoAppliedContribution(client, rB);
    const row = await crowdRow(productId);
    assert.ok(row, '★ A 의 행까지 사라졌다 — 다른 출처를 건드렸다');
    assert.strictEqual(numOf(row.calories), 11, `A 의 값으로 복원되지 않았다: ${row.calories}`);
    assert.strictEqual(numOf(row.sodium), 22);
    assert.strictEqual(Number(row.review_id), rA, '계보가 A 로 복원되지 않았다');
  });

  await t('§10-3 ingredients: 그 제보가 넣은 «그 줄»만 지운다 (식약처 행은 남는다)', async () => {
    const productId = await mkProduct('§10 원재료');
    await db.query(
      `INSERT INTO product_ingredients (product_id, raw_text, source) VALUES ($1, $2, 'haccp_api')`,
      [productId, '식약처 원재료: 밀가루, 설탕']);
    const cid = await mkContribution(productId, {
      parsed_ingredients: [{ name: '정제수' }], ocr_raw_text: '원재료명: 정제수',
    });
    const rid = await mkReview(cid, productId, 'ingredients');
    await SERVICE.applyApprovedContribution(client, rid);
    let pi = await db.query('SELECT source FROM product_ingredients WHERE product_id=$1 ORDER BY id', [productId]);
    assert.strictEqual(pi.rows.length, 2);

    await SERVICE.undoAppliedContribution(client, rid);
    pi = await db.query('SELECT source, raw_text FROM product_ingredients WHERE product_id=$1', [productId]);
    assert.strictEqual(pi.rows.length, 1, `되돌린 뒤 ${pi.rows.length} 줄이다`);
    assert.strictEqual(pi.rows[0].source, 'haccp_api', '★ 식약처 원재료가 지워졌다');
  });

  await t('§10-4 allergens: 새로 넣은 것은 지우고, 올린 등급은 «원래대로» 내리고, 남의 행은 안 건드린다', async () => {
    const productId = await mkProduct('§10 알레르겐');
    const data = {
      allergens: [],
      allergens_v2: { contains: ['우유'], inferred: [], mayContain: ['대두'] },
    };
    const expected = SERVICE.buildAllergenList(data).list;
    const milk = expected.find((x) => x.evidence_level === 'contains');
    const soy = expected.find((x) => x.evidence_level === 'may_contain');
    assert.ok(milk && soy, `픽스처 전제가 깨졌다: ${JSON.stringify(expected)}`);

    // ① 남의 행 — 이 제보와 무관한 알레르겐
    await db.query(
      `INSERT INTO product_allergens (product_id, allergen_name, source_count, status, detected_via, evidence_level)
       VALUES ($1, '밀', 3, 'confirmed', 'haccp_api', 'contains')`, [productId]);
    // ② 이 제보가 «등급을 올릴» 행 — 원래 may_contain 이던 것
    await db.query(
      `INSERT INTO product_allergens (product_id, allergen_name, source_count, status, detected_via, evidence_level)
       VALUES ($1, $2, 2, 'candidate', 'haccp_api', 'may_contain')`, [productId, milk.name]);

    const cid = await mkContribution(productId, data);
    const rid = await mkReview(cid, productId, 'allergens');
    await SERVICE.applyApprovedContribution(client, rid, { appliedBy: 'jay' });

    let pa = await db.query(
      'SELECT allergen_name, evidence_level, detected_via, source_count FROM product_allergens WHERE product_id=$1 ORDER BY allergen_name',
      [productId]);
    const m = new Map(pa.rows.map((x) => [x.allergen_name, x]));
    assert.strictEqual(m.get(milk.name).evidence_level, 'contains', '등급이 안 올라갔다');
    assert.strictEqual(m.get(milk.name).source_count, 2,
      '★ source_count 가 내려갔다 — 관측을 지우는 방향이다');
    assert.ok(m.has(soy.name), '새 알레르겐이 안 들어갔다');

    await SERVICE.undoAppliedContribution(client, rid);
    pa = await db.query(
      'SELECT allergen_name, evidence_level, detected_via, source_count, status FROM product_allergens WHERE product_id=$1 ORDER BY allergen_name',
      [productId]);
    const m2 = new Map(pa.rows.map((x) => [x.allergen_name, x]));
    assert.ok(m2.has('밀'), '★ 무관한 식약처 알레르겐이 지워졌다');
    assert.strictEqual(m2.get('밀').evidence_level, 'contains');
    assert.strictEqual(m2.get('밀').source_count, 3);
    assert.ok(!m2.has(soy.name), `새로 넣은 ${soy.name} 이 안 지워졌다`);
    assert.ok(m2.has(milk.name), `등급만 올렸던 ${milk.name} 행이 통째로 지워졌다`);
    assert.strictEqual(m2.get(milk.name).evidence_level, 'may_contain',
      '올렸던 등급이 원래대로 안 돌아갔다');
    assert.strictEqual(m2.get(milk.name).detected_via, 'haccp_api', '출처가 복원되지 않았다');
    assert.strictEqual(m2.get(milk.name).status, 'candidate');
  });

  await t('§10-5 additives: «새로» 넣은 것만 지운다. 이미 있던 첨가물은 남는다', async () => {
    const productId = await mkProduct('§10 첨가물');
    const pre = await db.query(`SELECT additive_id FROM additives WHERE name_ko='구연산'`);
    const preId = Number(pre.rows[0].additive_id);
    await db.query(
      `INSERT INTO product_additives (product_id, additive_id, detected_name) VALUES ($1,$2,'구연산')`,
      [productId, preId]);

    const cid = await mkContribution(productId, {
      parsed_ingredients: [{ name: '구연산' }, { name: '카라멜색소' }],
    });
    const rid = await mkReview(cid, productId, 'additives');
    await SERVICE.applyApprovedContribution(client, rid);
    let pad = await db.query('SELECT additive_id FROM product_additives WHERE product_id=$1', [productId]);
    assert.strictEqual(pad.rows.length, 2, `적용 후 ${pad.rows.length} 종이다`);

    await SERVICE.undoAppliedContribution(client, rid);
    pad = await db.query(
      `SELECT a.name_ko FROM product_additives pa JOIN additives a ON a.additive_id=pa.additive_id
        WHERE pa.product_id=$1`, [productId]);
    assert.strictEqual(pad.rows.length, 1, `되돌린 뒤 ${pad.rows.length} 종이다`);
    assert.strictEqual(pad.rows[0].name_ko, '구연산', '★ 원래 있던 첨가물이 지워졌다');
  });

  await t('§10-6 반영된 적 없는 건은 undone:false — 조용히 「되돌렸다」고 말하지 않는다', async () => {
    const s = await scenario('§10 미반영', { parsed_nutrition: NUT_100G }, 'nutrition');
    const u = await SERVICE.undoAppliedContribution(client, s.reviewId);
    assert.strictEqual(u.undone, false);
    assert.strictEqual(u.reason, 'NOT_APPLIED');
  });

  await t('§10-7 되돌린 뒤에는 «다시» 반영할 수 있다 (applied_at 이 풀렸으므로)', async () => {
    const s = await scenario('§10 재반영', { parsed_nutrition: NUT_100G }, 'nutrition');
    await SERVICE.applyApprovedContribution(client, s.reviewId);
    await SERVICE.undoAppliedContribution(client, s.reviewId);
    const r = await SERVICE.applyApprovedContribution(client, s.reviewId);
    assert.strictEqual(r.applied, true);
    assert.strictEqual(numOf((await crowdRow(s.productId)).calories), 100);
  });

  await t('§10-8 근거(before/after)가 없는 행은 조용히 되돌리지 않고 던진다', async () => {
    const s = await scenario('§10 근거없음', { parsed_nutrition: NUT_100G }, 'nutrition');
    await db.query(
      `UPDATE contribution_review SET applied_at = now(), evidence = '{"x":1}'::jsonb WHERE review_id=$1`,
      [s.reviewId]);
    await throwsCode(() => SERVICE.undoAppliedContribution(client, s.reviewId), 'UNDO_EVIDENCE_MISSING');
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
