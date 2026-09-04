/**
 * test_review_queue_read.js — 세션67 `U66-3` 관리자 검토 큐 «읽기» 축
 * ============================================================================
 * 배경 (계약 `.tmp/s67/계약_세션67.md` §2 — 2026-09-03 실측)
 *   세션66 이 제보 데이터 분리를 운영에 넣었다. 그 결과:
 *     · `nutrition_data` 의 `ocr_crowdsource` = **0행**
 *     · `contribution_review` 에 `candidate` **5건 대기**
 *     · 그런데 `contribution_review` 를 **목록으로 읽는 엔드포인트가 0개**였다(`G1`)
 *   ⇒ 제보가 「아무에게도 안 보인다」. `src/services/reviewQueueRead.js` 가 그 눈이다.
 *
 * 무엇을 지키는가
 *   §1  ★ 빈 큐가 «오류가 아니다» — `items: []` 이고 500 이 아니다
 *   §2  candidate 가 **제품별로 묶이고** 축이 배열로 나온다 (N+1 이 아니라 제품 단위 페이지)
 *   §3  ★★ **보류**(`status='approved'` + `applied_at IS NULL`)가 `held:true` 로 «구분»된다
 *         — 이 화면의 존재 이유다(`G2`: 보류에서 빠져나올 경로가 지금 «없다».
 *           `approveAndApply` 는 candidate 만 집고, `undo` 는 `evidence.before` 가 없어
 *           `UNDO_EVIDENCE_MISSING` 을 던진다. 안 보이면 영원히 안 보인다)
 *   §4  ★ 기준 미상 제보의 `basis` 가 `null` 이고 `basis_raw` 에 **어휘 밖 값이 남는다**
 *         (「승인하면 보류될 것인가」를 «누르기 전»에 안다. 누른 뒤 409 로 아는 것은 늦다)
 *   §4-b ★ 관리자가 채운 `evidence.admin_basis` 가 이기고 `basis_from` 에 그 사실이 남는다
 *         ⇒ 규칙을 다시 구현하지 않고 `contributionApply.resolveBasis` 를 «부른다»(계약 Q6)
 *   §5  ★★ **개인정보 무유출** — `ocr_raw_text` · `device_id` 가 응답 원문에 **한 글자도 없다**
 *   §6  ★ `024` «미적용» DB 에서 500 이 아니다 (배포 순서 방어 · 세션66 §1)
 *   §7  `limit` 상한 200 이 **실제로 걸린다**(205개를 넣고 센다 — 반환값만 보면 거짓 초록이다)
 *   §8  ★ merge 판정(`origin='merge'` · median · 기기 «수»)이 상세에 **살아서 나온다**
 *   §9  쓰기 SQL 이 «한 줄도» 없다 — 조회 전후로 DB 가 한 행도 안 변한다
 *
 * ★ 소스 문자열을 정규식으로 검사하지 않는다. pglite 에 `000_baseline.sql` → `023~026` 을
 *   적용하고 **실제 함수**를 호출해 **반환된 객체**와 **DB 에 박힌 것**만 단정한다.
 *   (§9 도 문자열 검사가 아니다 — 조회 전후의 실제 행 수를 센다.)
 *
 * ── 뮤테이션 (2026-09-03 실행 · 전부 «빨강» 확인) ─────────────────────────────
 *   M1 `held` 판정을 `status==='approved'` 만으로 (applied_at 검사 제거)
 *        → §3 빨강: 이미 반영된 축까지 「보류」로 뜬다. 관리자가 반영된 것을 다시 누른다.
 *   M2 `scrubEvidence` 를 항등함수로 (evidence 원본 그대로 통과)
 *        → §5 빨강: `device_id` 가 응답에 실려 나온다.
 *   M3 `proposed` 의 영양 화이트리스트를 없애고 `pickNutritionObject` 원본을 그대로
 *        → §5 빨강: `ocr_raw_text` 가 딸려 나올 수 있는 구조가 된다(파서가 넣은 임의 키).
 *   M4 `limit` 상한 `Math.min(..., LIMIT_MAX)` 제거
 *        → §7 빨강: 205건이 한 번에 나온다.
 *   M5 `hasReviewTable` 가드 제거 (곧장 SELECT)
 *        → §6 빨강: 024 미적용 DB 에서 `relation "contribution_review" does not exist` 로 던진다.
 *   M6 `basis` 를 nutrition 축에서도 `null` 고정 (resolveBasis 호출 삭제)
 *        → §4 · §4-b 빨강: 「승인하면 보류된다」 예고가 사라진다.
 *
 * 실행: cross-env NODE_ENV=test node tests/test_review_queue_read.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRV = path.join(__dirname, '..');
const MIG = path.join(SRV, 'scripts', 'migrations');
const BASELINE = path.join(MIG, '000_baseline.sql');
const CHAIN = ['023', '024', '025', '026'];

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

/** pglite 를 `{query}` client 로 감싼다 (서비스는 client 를 주입받는다). */
function clientOf(db) {
  return {
    query: async (text, params) => {
      const r = await db.query(text, params || []);
      if (r && r.rowCount === undefined) r.rowCount = r.affectedRows;
      return r;
    },
  };
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(' 세션67 U66-3 — 관리자 검토 큐 읽기 (G1 · G2)');
  console.log('════════════════════════════════════════════════════════════════');

  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (_) {
    console.log('⏭  pglite 미설치 — 검증 불가. 「건너뜀」은 「통과」가 아니다. EXIT=1.');
    process.exit(1);
  }

  const MIG_FILES = fs.readdirSync(MIG);
  const migFile = (prefix) => MIG_FILES.find((x) => x.startsWith(`${prefix}_`) && x.endsWith('.sql'));

  async function freshDb(withChain) {
    const db = new PGlite();
    await db.exec(fs.readFileSync(BASELINE, 'utf8'));
    if (withChain) {
      for (const p of CHAIN) await db.exec(fs.readFileSync(path.join(MIG, migFile(p)), 'utf8'));
    }
    return db;
  }

  const db = await freshDb(true);
  const client = clientOf(db);

  // ⚠ 서비스를 «여기서» require 한다. 이 파일은 `config/database` 를 안 부르므로
  //   shim 이 필요 없다 — 그 자체가 「client 주입」 규율이 지켜졌다는 증거다.
  const {
    listReviewQueue, getReviewDetail, LIMIT_MAX,
  } = require('../src/services/reviewQueueRead');

  // ══════════════════════════════════════════════════════════════════════════
  section('§1  빈 큐 — 오류가 아니라 «빈 목록»이다');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§1 빈 큐에서 count=0 · items=[] · totals 전부 0 (throw 하지 않는다)', async () => {
    const out = await listReviewQueue(client, {});
    assert.strictEqual(out.count, 0, `count=${out.count}`);
    assert.deepStrictEqual(out.items, [], 'items 가 빈 배열이 아니다');
    assert.strictEqual(out.queue_ready, true, '024 는 적용돼 있는데 queue_ready 가 false 다');
    assert.deepStrictEqual(out.totals,
      { candidate: 0, held: 0, approved_applied: 0, rejected: 0 },
      `totals=${JSON.stringify(out.totals)}`);
  });

  // ── 고정물 ────────────────────────────────────────────────────────────────
  //   ★ 실제 운영 모양 그대로: `contributions.data` 에 `ocr_raw_text`·`device_id` 가 있고
  //     `contribution_review.evidence` 에도 `device_id` 가 있다
  //     (`crowdsourceService.commonEvidence` 가 실제로 그렇게 넣는다 — 실측).
  const OCR_SECRET = 'OCR원문비밀문자열_영양성분_나트륨350mg_제조원_주소_서울시';
  const DEVICE_SECRET = 'device-uuid-6f2a1c9e-BEEF';

  const mkProduct = async (barcode, name, opts = {}) => {
    const r = await db.query(
      `INSERT INTO products (barcode, product_name, manufacturer, data_source,
                             serving_size, serving_unit, total_content, content_unit)
       VALUES ($1, $2, $3, 'ocr_crowdsource', $4, $5, $6, $7)
       RETURNING product_id`,
      [barcode, name, opts.manufacturer || '테스트제조사',
        opts.serving_size ?? null, opts.serving_unit ?? null,
        opts.total_content ?? null, opts.content_unit ?? null]);
    return Number(r.rows[0].product_id);
  };
  const mkContribution = async (productId, data) => {
    const r = await db.query(
      `INSERT INTO contributions (product_id, contribution_type, data, status, device_id)
       VALUES ($1, 'ocr_nutrition', $2::jsonb, 'pending', $3)
       RETURNING contribution_id`,
      [productId, JSON.stringify(data), DEVICE_SECRET]);
    return Number(r.rows[0].contribution_id);
  };
  const mkReview = async (o) => {
    const r = await db.query(
      `INSERT INTO contribution_review
         (contribution_id, product_id, axis, status, reviewed_by, reviewed_at,
          applied_at, reject_reason, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       RETURNING review_id`,
      [o.contributionId, o.productId, o.axis, o.status || 'candidate',
        o.reviewedBy ?? null, o.reviewedAt ?? null, o.appliedAt ?? null,
        o.rejectReason ?? null, JSON.stringify(o.evidence || {})]);
    return Number(r.rows[0].review_id);
  };

  // (가) 기준이 «있는» 제보 — 영양 + 원재료 두 축
  const pOk = await mkProduct('S67_OK', '기준있는제품', { serving_size: 30, serving_unit: 'g' });
  const cOk = await mkContribution(pOk, {
    ocr_raw_text: OCR_SECRET,
    device_id: DEVICE_SECRET,
    avg_confidence: 0.9,
    parsed_nutrition: { _basis: 'per_serving', calories: 120, sodium: 350, 서식외키: '무시돼야' },
    parsed_ingredients: [{ name: '정제수' }, { name: '설탕' }],
    allergens_v2: { contains: ['우유'], mayContain: [], inferred: [] },
    user_input: { ingredients_text: OCR_SECRET },
  });
  const rOkNut = await mkReview({
    contributionId: cOk, productId: pOk, axis: 'nutrition',
    evidence: { origin: 'crowdsource', device_id: DEVICE_SECRET, nutrient_count: 2 },
  });
  await mkReview({
    contributionId: cOk, productId: pOk, axis: 'ingredients',
    evidence: { origin: 'crowdsource', device_id: DEVICE_SECRET, ingredient_count: 2 },
  });

  // (나) ★ 보류 — 승인됐는데 반영이 «안 됐다»
  const pHeld = await mkProduct('S67_HELD', '보류제품');
  const cHeld = await mkContribution(pHeld, {
    ocr_raw_text: OCR_SECRET,
    parsed_nutrition: { calories: 200 },        // ← 기준 없음
  });
  const rHeld = await mkReview({
    contributionId: cHeld, productId: pHeld, axis: 'nutrition',
    status: 'approved', reviewedBy: '제이', reviewedAt: new Date().toISOString(),
    appliedAt: null,                            // ★★ 이것이 「보류」다
    evidence: { origin: 'crowdsource', device_id: DEVICE_SECRET },
  });

  // (다) 어휘 밖 기준 — `basis=null` · `basis_raw='per_pack'`
  const pUnk = await mkProduct('S67_UNK', '기준미상제품');
  const cUnk = await mkContribution(pUnk, {
    parsed_nutrition: { _basis: 'per_pack', calories: 500 },
  });
  const rUnk = await mkReview({
    contributionId: cUnk, productId: pUnk, axis: 'nutrition',
    evidence: { origin: 'crowdsource', device_id: DEVICE_SECRET },
  });

  // (라) merge 판정 — 기기 3대 median. 상세에 «살아서» 나와야 한다.
  const pMerge = await mkProduct('S67_MERGE', '3기기병합제품', { serving_size: 25, serving_unit: 'g' });
  const cMerge = await mkContribution(pMerge, {
    parsed_nutrition: { _basis: 'per_serving', calories: 111, sodium: 222 },
  });
  const rMerge = await mkReview({
    contributionId: cMerge, productId: pMerge, axis: 'nutrition',
    evidence: {
      origin: 'merge',
      source_count: 3,
      distinct_device_count: 3,
      auto_verify_threshold: 3,
      outliers: [{ field: 'sodium', values: [220, 222, 900] }],
      has_significant_outliers: true,
      preview_scaled_nutrition: { calories: 111, sodium: 222 },
      device_id: DEVICE_SECRET,            // ← 지워져야 한다
      source_contribution_ids: [cMerge],   // ← 남아야 한다(제보 식별자이지 기기 식별자가 아니다)
    },
  });

  // (마) 반려 · 반영완료 — totals 대조군
  const pDone = await mkProduct('S67_DONE', '반영완료제품');
  const cDone = await mkContribution(pDone, { parsed_ingredients: [{ name: '밀가루' }] });
  await mkReview({
    contributionId: cDone, productId: pDone, axis: 'ingredients',
    status: 'approved', reviewedBy: '제이', appliedAt: new Date().toISOString(),
    evidence: { origin: 'crowdsource' },
  });
  await mkReview({
    contributionId: cDone, productId: pDone, axis: 'allergens',
    status: 'rejected', rejectReason: '사진 흐림', evidence: { origin: 'crowdsource' },
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§2  제품별로 묶이고 축이 배열로 나오는가');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§2 한 제품의 두 축이 «한 카드»의 axes[] 로 묶인다', async () => {
    const out = await listReviewQueue(client, { status: 'candidate' });
    const item = out.items.find((x) => x.product_id === pOk);
    assert.ok(item, `pOk(${pOk}) 카드가 없다. items=${out.items.map((x) => x.product_id)}`);
    assert.strictEqual(item.barcode, 'S67_OK');
    assert.strictEqual(item.product_name, '기준있는제품');
    assert.strictEqual(item.manufacturer, '테스트제조사');
    const axes = item.axes.map((a) => a.axis).sort();
    assert.deepStrictEqual(axes, ['ingredients', 'nutrition'],
      `축이 배열로 안 묶였다: ${JSON.stringify(axes)}`);
    assert.strictEqual(item.pending_count, 2, `pending_count=${item.pending_count}`);
    assert.strictEqual(item.held_count, 0, `held_count=${item.held_count}`);
    // 제품이 «중복 행»으로 튀지 않는다(축 수만큼 카드가 생기면 화면이 같은 제품을 여러 번 그린다)
    assert.strictEqual(out.items.filter((x) => x.product_id === pOk).length, 1,
      '같은 제품 카드가 두 번 나왔다 — 제품 단위로 안 묶였다');
  });

  await t('§2-b totals 는 «필터와 무관하게» 전역이다 (탭 배지가 다른 탭 상태를 말한다)', async () => {
    const out = await listReviewQueue(client, { status: 'candidate', axis: 'ingredients' });
    assert.strictEqual(out.totals.held, 1,
      `ingredients 탭인데 totals.held=${out.totals.held} 다. 보류 배지는 큐 «전체»를 말해야 한다`);
    assert.strictEqual(out.totals.rejected, 1, `totals.rejected=${out.totals.rejected}`);
    assert.strictEqual(out.totals.approved_applied, 1,
      `totals.approved_applied=${out.totals.approved_applied}`);
    // candidate 4건 = (가)영양·(가)원재료 · (다)기준미상 · (라)merge
    assert.strictEqual(out.totals.candidate, 4, `totals.candidate=${out.totals.candidate}`);
  });

  await t('§2-c axis 필터가 실제로 걸린다', async () => {
    const out = await listReviewQueue(client, { status: 'candidate', axis: 'ingredients' });
    for (const it of out.items) {
      for (const a of it.axes) {
        assert.strictEqual(a.axis, 'ingredients', `필터 밖 축이 나왔다: ${a.axis}`);
      }
    }
    assert.ok(out.items.some((x) => x.product_id === pOk), 'ingredients 축을 가진 제품이 사라졌다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§3  ★★ 보류(approved + applied_at IS NULL)가 구분되는가 — 이 화면의 존재 이유');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§3 보류 축이 held:true 이고 반영완료 축은 held:false 다', async () => {
    const out = await listReviewQueue(client, { status: 'candidate,approved' });
    const heldItem = out.items.find((x) => x.product_id === pHeld);
    assert.ok(heldItem, '보류 제품이 목록에 없다 — 보류가 어디에도 안 보인다(G2 그대로다)');
    const ax = heldItem.axes.find((a) => a.review_id === rHeld);
    assert.ok(ax, '보류 축이 없다');
    assert.strictEqual(ax.held, true,
      'approved + applied_at IS NULL 인데 held 가 false 다. 이 필드가 이 화면의 전부다');
    assert.strictEqual(ax.status, 'approved');
    assert.strictEqual(ax.applied_at, null);
    assert.strictEqual(heldItem.held_count, 1, `held_count=${heldItem.held_count}`);

    const doneItem = out.items.find((x) => x.product_id === pDone);
    assert.ok(doneItem, '반영완료 제품이 approved 필터에 안 걸렸다');
    const done = doneItem.axes.find((a) => a.axis === 'ingredients');
    assert.strictEqual(done.held, false,
      '이미 반영된(applied_at 있음) 축이 held:true 다 — 관리자가 반영된 것을 또 누른다');
    assert.strictEqual(doneItem.held_count, 0);
  });

  await t('§3-b held=1 필터가 «보류만» 낸다 (반영완료·candidate 가 안 섞인다)', async () => {
    const out = await listReviewQueue(client, { status: 'candidate,approved', held: '1' });
    assert.strictEqual(out.items.length, 1, `보류 제품이 ${out.items.length} 건이다 (기대 1)`);
    assert.strictEqual(out.items[0].product_id, pHeld);
    for (const a of out.items[0].axes) {
      assert.strictEqual(a.held, true, `보류 탭에 held:false 축이 섞였다: ${JSON.stringify(a)}`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§4  ★ 「지금 승인하면 반영될 것인가」를 «누르기 전»에 아는가');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§4 어휘 밖 기준이면 basis=null 이고 basis_raw 에 그 값이 남는다', async () => {
    const out = await listReviewQueue(client, { status: 'candidate', axis: 'nutrition' });
    const it = out.items.find((x) => x.product_id === pUnk);
    assert.ok(it, '기준미상 제품이 목록에 없다');
    const ax = it.axes.find((a) => a.review_id === rUnk);
    assert.strictEqual(ax.basis, null,
      `basis 가 '${ax.basis}' 다. 어휘 밖 값('per_pack')을 통과시키면 «추정»이 우회 입장한다`);
    assert.strictEqual(ax.basis_raw, 'per_pack',
      `basis_raw 가 '${ax.basis_raw}' 다. 「어휘 밖 값이 있었다」는 사실이 사라지면 `
      + '관리자는 「기준이 아예 없었다」와 구분하지 못한다');
  });

  await t('§4-b 기준이 있으면 basis 가 채워지고 basis_from 이 «출처»를 말한다', async () => {
    const out = await listReviewQueue(client, { status: 'candidate', axis: 'nutrition' });
    const ax = out.items.find((x) => x.product_id === pOk)
      .axes.find((a) => a.review_id === rOkNut);
    assert.strictEqual(ax.basis, 'per_serving', `basis=${ax.basis}`);
    assert.strictEqual(ax.basis_from, 'data.parsed_nutrition._basis', `basis_from=${ax.basis_from}`);
  });

  await t('§4-c ★ 관리자가 채운 admin_basis 가 «이기고» 그 사실이 basis_from 에 남는다 (Q6 배선)', async () => {
    // ⚠ 쓰기는 이 파일 소관이 아니다. 관리자 입력이 «이미 들어간» 상태를 만들어
    //   읽기가 그것을 읽는지만 본다(§5-3 엔드포인트는 메인이 만든다).
    await db.query(
      `UPDATE contribution_review
          SET evidence = COALESCE(evidence,'{}'::jsonb) || $2::jsonb
        WHERE review_id = $1`,
      [rUnk, JSON.stringify({
        admin_basis: {
          value: 'per_100g', by: '제이', at: '2026-09-03T00:00:00Z',
          note: '라벨 사진 우하단 100g당 표기 육안 확인',
        },
      })]);
    const out = await listReviewQueue(client, { status: 'candidate', axis: 'nutrition' });
    const ax = out.items.find((x) => x.product_id === pUnk).axes.find((a) => a.review_id === rUnk);
    assert.strictEqual(ax.basis, 'per_100g',
      `admin_basis 가 안 이겼다(basis=${ax.basis}). resolveBasis 3인자 호출이 빠졌는지 볼 것`);
    assert.strictEqual(ax.basis_from, 'review.evidence.admin_basis',
      `basis_from=${ax.basis_from} — 「누가 그렇게 판정했나」가 안 남는다`);
    // 되돌린다(뒤 절이 이 행을 다시 본다)
    await db.query(
      `UPDATE contribution_review SET evidence = evidence - 'admin_basis' WHERE review_id = $1`,
      [rUnk]);
  });

  await t('§4-d nutrition 이 «아닌» 축에는 basis 개념이 없다 (null 로 명시)', async () => {
    const out = await listReviewQueue(client, { status: 'candidate', axis: 'ingredients' });
    const ax = out.items.find((x) => x.product_id === pOk).axes[0];
    assert.strictEqual(ax.basis, null);
    assert.strictEqual(ax.basis_raw, null);
    assert.strictEqual(ax.basis_from, null);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§5  ★★ 개인정보 무유출 — 응답 «원문»에 한 글자도 없다');
  // ══════════════════════════════════════════════════════════════════════════
  //   세션64c `test:contributions-mine` ⑥ 과 같은 축이다. 관리자 화면이라 기준이 다르다고
  //   생각하기 쉽지만 그 판단은 제이 몫이므로, 일단 «필요한 것만» 뽑아 낸다(계약 §5-4).
  await t('§5 목록 응답에 ocr_raw_text · device_id 가 «키도 값도» 없다', async () => {
    const out = await listReviewQueue(client, { status: 'candidate,approved,rejected' });
    const raw = JSON.stringify(out);
    assert.ok(!raw.includes(OCR_SECRET), 'OCR 원문이 목록 응답에 실려 나왔다');
    assert.ok(!raw.includes(DEVICE_SECRET), '기기 식별자가 목록 응답에 실려 나왔다');
    assert.ok(!raw.includes('ocr_raw_text'), "'ocr_raw_text' 키가 응답에 있다");
    assert.ok(!raw.includes('device_id'), "'device_id' 키가 응답에 있다");
    assert.ok(!raw.includes('user_input'), "'user_input' 키가 응답에 있다");
    // 대조군 — 「전부 지웠다」가 아니라 「필요한 것은 남았다」
    assert.ok(raw.includes('기준있는제품'), '제품명까지 사라졌다 — 필터가 과하다');
  });

  await t('§5-b 상세 응답에도 없다 (proposed · evidence 둘 다 지난다)', async () => {
    const d = await getReviewDetail(client, pOk);
    const raw = JSON.stringify(d);
    assert.ok(!raw.includes(OCR_SECRET), 'OCR 원문이 상세 응답에 실려 나왔다');
    assert.ok(!raw.includes(DEVICE_SECRET), '기기 식별자가 상세 응답에 실려 나왔다');
    assert.ok(!raw.includes('ocr_raw_text'), "'ocr_raw_text' 키가 상세에 있다");
    assert.ok(!raw.includes('device_id'), "'device_id' 키가 상세에 있다");
  });

  await t('§5-c 그래도 «제보 값»은 뽑혀 나온다 (뽑기 자체가 죽지 않았다)', async () => {
    const d = await getReviewDetail(client, pOk);
    const nut = d.axes.find((a) => a.axis === 'nutrition');
    assert.strictEqual(nut.proposed.nutrition.calories, 120, '제보 칼로리가 안 나왔다');
    assert.strictEqual(nut.proposed.nutrition.sodium, 350);
    assert.strictEqual(nut.proposed.nutrient_count, 2);
    // ★ 화이트리스트 — 파서가 넣은 임의 키는 «안» 나온다
    assert.ok(!Object.prototype.hasOwnProperty.call(nut.proposed.nutrition, '서식외키'),
      'parsed_nutrition 원본이 통째로 나왔다 — 화이트리스트가 없다');
    assert.ok(!Object.prototype.hasOwnProperty.call(nut.proposed.nutrition, '_basis'),
      '_basis 가 proposed 에 섞였다 — 기준은 basis 필드가 말한다');

    const ing = d.axes.find((a) => a.axis === 'ingredients');
    assert.deepStrictEqual(ing.proposed.ingredients, ['정제수', '설탕']);
    assert.strictEqual(ing.proposed.count, 2);
  });

  await t('§5-d ★ null 과 [] 를 구분한다 (「안 봤다」 ≠ 「봤는데 없었다」 — U63-6)', async () => {
    const pEmpty = await mkProduct('S67_EMPTY', '알레르기0종제품');
    const cEmpty = await mkContribution(pEmpty, {
      parsed_ingredients: [],
      allergens_v2: { contains: [], mayContain: [], inferred: [] },
    });
    await mkReview({ contributionId: cEmpty, productId: pEmpty, axis: 'allergens' });
    await mkReview({ contributionId: cEmpty, productId: pEmpty, axis: 'ingredients' });
    const d = await getReviewDetail(client, pEmpty);
    const al = d.axes.find((a) => a.axis === 'allergens');
    assert.strictEqual(al.proposed.inspected, true, '「봤는데 0종」이 「안 봤다」가 됐다');
    assert.deepStrictEqual(al.proposed.allergens, [], 'allergens 가 [] 가 아니다');

    const pNo = await mkProduct('S67_NOING', '원재료안본제품');
    const cNo = await mkContribution(pNo, { parsed_nutrition: { _basis: 'per_100g', calories: 1 } });
    await mkReview({ contributionId: cNo, productId: pNo, axis: 'ingredients' });
    const d2 = await getReviewDetail(client, pNo);
    const ing = d2.axes.find((a) => a.axis === 'ingredients');
    assert.strictEqual(ing.proposed.ingredients, null,
      '원재료를 «안 본» 제보의 ingredients 가 null 이 아니다 — [] 와 뜻이 다르다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§8  ★ merge 판정이 상세에 «살아서» 나오는가');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§8 origin=merge · 기기 «수» · 이상치가 상세 evidence 에 남는다', async () => {
    const d = await getReviewDetail(client, pMerge);
    const ax = d.axes.find((a) => a.review_id === rMerge);
    assert.ok(ax, 'merge 축이 상세에 없다');
    assert.strictEqual(ax.origin, 'merge', `origin=${ax.origin}`);
    assert.ok(ax.evidence, 'evidence 가 통째로 사라졌다 — 관리자에게 남는 것이 사진뿐이 된다');
    assert.strictEqual(ax.evidence.distinct_device_count, 3,
      '기기 «수»가 사라졌다. 지워야 할 것은 기기 «식별자»이지 개수가 아니다');
    assert.strictEqual(ax.evidence.source_count, 3);
    assert.strictEqual(ax.evidence.has_significant_outliers, true);
    assert.ok(Array.isArray(ax.evidence.outliers) && ax.evidence.outliers.length === 1,
      '이상치 판정이 사라졌다');
    assert.strictEqual(ax.evidence.outliers[0].field, 'sodium');
    assert.deepStrictEqual(ax.evidence.preview_scaled_nutrition, { calories: 111, sodium: 222 });
    assert.deepStrictEqual(ax.evidence.source_contribution_ids, [cMerge],
      '제보 식별자까지 지워졌다 — 역추적이 불가능해진다');
    // ★ 그러나 기기 식별자는 없다
    assert.ok(!JSON.stringify(ax.evidence).includes(DEVICE_SECRET),
      'evidence 에 기기 식별자가 남았다');
  });

  await t('§8-b 상세의 basis 객체가 §5-2 모양이다 (considered · product_basis · admin_basis)', async () => {
    const d = await getReviewDetail(client, pMerge);
    const ax = d.axes.find((a) => a.review_id === rMerge);
    assert.strictEqual(ax.basis.value, 'per_serving', `basis.value=${ax.basis.value}`);
    assert.strictEqual(ax.basis.from, 'data.parsed_nutrition._basis');
    assert.ok(Array.isArray(ax.basis.considered), 'considered 가 배열이 아니다');
    assert.strictEqual(ax.basis.product_basis, null, '공공 영양 행이 없는데 product_basis 가 있다');
    assert.strictEqual(ax.basis.admin_basis, null);
  });

  await t('§8-c 상세 current 가 «공공» 값을 낸다 (제보값과 나란히 놓을 대상)', async () => {
    await db.query(
      `INSERT INTO nutrition_data (product_id, calories, sodium, serving_size, data_source)
       VALUES ($1, 99, 11, '100g', 'public_nutrition')`, [pMerge]);
    await db.query(
      `INSERT INTO product_ingredients (product_id, raw_text, parsed_ingredients, source)
       VALUES ($1, '정제수, 소금', $2::jsonb, 'c002')`,
      [pMerge, JSON.stringify(['정제수', '소금'])]);
    await db.query(
      `INSERT INTO product_allergens (product_id, allergen_name, detected_via, evidence_level)
       VALUES ($1, '우유', 'c002', 'contains')`, [pMerge]);

    const d = await getReviewDetail(client, pMerge);
    assert.ok(d.current.nutrition, 'current.nutrition 이 null 이다');
    assert.strictEqual(Number(d.current.nutrition.calories), 99);
    assert.strictEqual(d.current.nutrition.serving_size_marker, '100g',
      'basis 마커가 안 나왔다 — 화면이 「무슨 기준의 99 kcal 인가」를 모른다');
    assert.strictEqual(d.current.nutrition.source, 'public_nutrition');
    assert.deepStrictEqual(d.current.ingredients,
      [{ name: '정제수', sequence: 1 }, { name: '소금', sequence: 2 }]);
    assert.strictEqual(d.current.allergens.length, 1);
    assert.strictEqual(d.current.allergens[0].allergen_name, '우유');
    assert.strictEqual(d.current.allergens[0].evidence_level, 'contains');
    assert.deepStrictEqual(d.current.additives, []);

    // ★ 공공 행이 생겼으니 목표 기준이 그 행의 기준(per_100g)으로 잡힌다
    const ax = d.axes.find((a) => a.review_id === rMerge);
    assert.strictEqual(ax.basis.product_basis, 'per_100g',
      `product_basis=${ax.basis.product_basis} — 공공 행의 기준을 못 읽었다`);
  });

  await t('§8-d 없는 제품은 «예외»가 아니라 null 이다 (호출부가 404 를 낸다)', async () => {
    assert.strictEqual(await getReviewDetail(client, 99999999), null);
    assert.strictEqual(await getReviewDetail(client, 'abc'), null);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§9  쓰기 SQL 이 «한 줄도» 없는가 — 조회 전후로 DB 가 안 변한다');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§9 목록·상세를 여러 번 불러도 검토·제보·공식 테이블의 행이 안 변한다', async () => {
    const snap = async () => (await db.query(
      `SELECT (SELECT count(*) FROM contribution_review)::int AS cr,
              (SELECT count(*) FROM contributions)::int       AS c,
              (SELECT count(*) FROM nutrition_data)::int      AS nd,
              (SELECT count(*) FROM nutrition_data_crowd)::int AS ndc,
              (SELECT count(*) FROM product_ingredients)::int AS pi,
              (SELECT count(*) FROM product_allergens)::int   AS pa,
              (SELECT count(*) FROM product_additives)::int   AS padd,
              (SELECT count(*) FROM data_inspection)::int     AS di,
              (SELECT count(*) FROM contribution_review WHERE applied_at IS NOT NULL)::int AS applied,
              (SELECT count(*) FROM contribution_review WHERE status = 'approved')::int    AS approved`
    )).rows[0];
    const before = await snap();
    await listReviewQueue(client, {});
    await listReviewQueue(client, { status: 'candidate,approved,rejected,undone,superseded' });
    await listReviewQueue(client, { held: '1' });
    await getReviewDetail(client, pOk);
    await getReviewDetail(client, pHeld);
    await getReviewDetail(client, pMerge);
    const after = await snap();
    assert.deepStrictEqual(after, before,
      `읽기 함수가 DB 를 바꿨다.\n  before=${JSON.stringify(before)}\n  after =${JSON.stringify(after)}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§6  ★ 024 «미적용» DB 에서 500 이 아닌가 (배포 순서 방어)');
  // ══════════════════════════════════════════════════════════════════════════
  //   세션66 §1 과 같은 형태의 사고 방어다. 코드가 먼저 나가고 마이그레이션이 나중에
  //   돌 수 있다 — 그때 관리자 화면이 500 을 내면 「무엇이 잘못됐는지」조차 안 보인다.
  await t('§6 023~026 «미적용» DB 에서 목록이 throw 하지 않고 빈 큐 + queue_ready:false', async () => {
    const bare = await freshDb(false);
    try {
      const bareClient = clientOf(bare);
      const out = await listReviewQueue(bareClient, {});
      assert.strictEqual(out.queue_ready, false,
        'queue_ready 가 true 다 — 「큐가 비었다」와 「테이블이 없다」가 구분되지 않는다');
      assert.deepStrictEqual(out.items, []);
      assert.strictEqual(out.count, 0);
      assert.deepStrictEqual(out.totals,
        { candidate: 0, held: 0, approved_applied: 0, rejected: 0 });
    } finally {
      await bare.close();
    }
  });

  await t('§6-b 미적용 DB 에서도 상세가 «현재 공식값»은 낸다 (제품이 있으면 404 가 아니다)', async () => {
    const bare = await freshDb(false);
    try {
      const bareClient = clientOf(bare);
      const r = await bare.query(
        `INSERT INTO products (barcode, product_name, data_source)
         VALUES ('S67_BARE', '024없는DB제품', 'public_c005') RETURNING product_id`);
      const bpid = Number(r.rows[0].product_id);
      await bare.query(
        `INSERT INTO nutrition_data (product_id, calories, serving_size, data_source)
         VALUES ($1, 55, '100ml', 'public_nutrition')`, [bpid]);

      const d = await getReviewDetail(bareClient, bpid);
      assert.ok(d, '상세가 null 이다 — 제품은 있는데 404 가 나간다');
      assert.strictEqual(d.queue_ready, false);
      assert.deepStrictEqual(d.axes, [], 'axes 가 빈 배열이 아니다');
      assert.strictEqual(Number(d.current.nutrition.calories), 55,
        '024 가 없다는 이유로 공공 영양까지 안 나왔다');
      assert.strictEqual(d.product.product_name, '024없는DB제품');
    } finally {
      await bare.close();
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§7  limit 상한 200 이 «실제로» 걸리는가');
  // ══════════════════════════════════════════════════════════════════════════
  //   ⚠ 반환된 `limit` 값만 보면 거짓 초록이다(SQL 에 안 넘겨도 통과한다).
  //     205건을 넣고 **실제로 나온 개수**를 센다.
  await t('§7 205개 제품이 대기해도 limit=9999 로 200 «개»만 나온다', async () => {
    const before = (await listReviewQueue(client, { status: 'candidate', limit: 9999 })).count;
    await db.query(
      `INSERT INTO products (barcode, product_name, data_source)
       SELECT 'S67_BULK_' || g, '대량제품' || g, 'ocr_crowdsource'
         FROM generate_series(1, 205) g`);
    await db.query(
      `INSERT INTO contributions (product_id, contribution_type, data, status)
       SELECT product_id, 'ocr_nutrition', '{"parsed_ingredients":[{"name":"물"}]}'::jsonb, 'pending'
         FROM products WHERE barcode LIKE 'S67_BULK_%'`);
    await db.query(
      `INSERT INTO contribution_review (contribution_id, product_id, axis, status, evidence)
       SELECT c.contribution_id, c.product_id, 'ingredients', 'candidate', '{"origin":"crowdsource"}'::jsonb
         FROM contributions c JOIN products p USING (product_id)
        WHERE p.barcode LIKE 'S67_BULK_%'`);

    const total = (await db.query(
      `SELECT count(DISTINCT product_id)::int n FROM contribution_review WHERE status='candidate'`
    )).rows[0].n;
    assert.ok(total > 200, `대기 제품이 ${total} 건이다 — 상한을 시험할 수 없다`);

    const out = await listReviewQueue(client, { status: 'candidate', limit: 9999 });
    assert.strictEqual(out.limit, 200, `반환 limit=${out.limit}`);
    assert.strictEqual(out.items.length, 200,
      `${out.items.length} 건이 나왔다. 상한이 SQL 에 «안 넘어갔다» — 205건이 한 번에 나간다`);
    assert.ok(before >= 0);
  });

  await t('§7-b limit=0 · 음수 · 문자열이 기본값으로 접힌다 (0건 응답이 되지 않는다)', async () => {
    assert.strictEqual((await listReviewQueue(client, { limit: 0 })).limit, 50);
    assert.strictEqual((await listReviewQueue(client, { limit: -5 })).limit, 1,
      '음수 limit 이 하한 1 로 안 접혔다');
    assert.strictEqual((await listReviewQueue(client, { limit: 'abc' })).limit, 50);
    assert.strictEqual(LIMIT_MAX, 200, 'LIMIT_MAX 상수가 200 이 아니다');
  });

  await t('§7-c offset 이 겹치지 않는다 (같은 제품이 두 페이지에 안 나온다)', async () => {
    const p1 = await listReviewQueue(client, { status: 'candidate', limit: 5, offset: 0 });
    const p2 = await listReviewQueue(client, { status: 'candidate', limit: 5, offset: 5 });
    const ids1 = p1.items.map((x) => x.product_id);
    const ids2 = p2.items.map((x) => x.product_id);
    assert.strictEqual(ids1.length, 5);
    assert.strictEqual(ids2.length, 5);
    const overlap = ids1.filter((x) => ids2.includes(x));
    assert.deepStrictEqual(overlap, [],
      `두 페이지가 겹친다: ${overlap} — ORDER BY 에 tie-breaker 가 없다`);
  });

  await t('§7-d 어휘 밖 status·axis 는 «버려지고» 기본값으로 돈다 (오타 하나로 화면이 안 죽는다)', async () => {
    const out = await listReviewQueue(client, { status: 'pending', axis: 'calories' });
    assert.ok(out.items.length > 0,
      "status='pending'(어휘 밖)이 그대로 SQL 에 들어가 0건이 됐다");
    assert.strictEqual(out.queue_ready, true);
  });

  await db.close();

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(` 통과 ${pass} · 실패 ${fail}`);
  if (fail > 0) {
    console.log('\n실패 상세:');
    for (const f of failures) console.log(`\n[${f.name}]\n${f.message}`);
  }
  console.log('════════════════════════════════════════════════════════════════\n');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
