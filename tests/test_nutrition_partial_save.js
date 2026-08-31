/**
 * test_nutrition_partial_save.js — 세션64b «영양 미확보 부분 저장» 축 회귀
 * ============================================================================
 * 배경 — 외부 검토 2명의 결론 (2026-08-23)
 *   사진 제보 저장 게이트가 「값이 이상한가」는 보는데 「값이 몇 개인가」는 안 봤다.
 *   「개수 하한을 몇으로 둘까」를 물었더니 검토자 둘 다 **「그건 잘못된 질문」**이라 답했다.
 *     · 「모름」을 「없음」이나 「안전」으로 바꾸지 말 것
 *     · **저장 ≠ 표시 ≠ 검증** (Ingest Permissive, Render Conservative)
 *     · 영양소 0개는 저장 «거부»가 아니라 `incomplete` 표시
 *     · 부분 저장 — 영양 실패 때문에 원재료·알레르기 원증거까지 버리지 말 것
 *     · 개수는 **관측 지표로만**. hard threshold 는 운영 데이터가 쌓인 뒤에 판단
 *
 * 무엇을 지키는가
 *   §1 영양 실패(기준 판별 실패)가 **원재료·알레르기 저장까지 반려하지 않는다**
 *   §2 영양소 0개는 저장 거부가 아니라 `nutrition_status:'incomplete'` 다
 *   §3 영양 미확보 제품에 **신호등이 나가지 않는다** (빈 값이 `0` 으로 보이지 않는다)
 *   §4 ★★ 알레르기 도크트린 — 「OCR 에서 안 나왔다」가 「제품에 없다」로 변질되지 않는다
 *      (`allergens_available` 등 세션45~54 가 세운 계약의 «의미»를 바꾸지 않았다)
 *   §5 영양소 개수를 **관측**으로 남긴다. 그 값으로 저장을 거부하지 않는다
 *   §6 열량 0 kcal 라벨이 「영양 없음」으로 취급되지 않는다 (종전 truthy 검사 함정)
 *   §7 기존 제품(이미 등록된 바코드) 재제보 — 공공데이터 영양은 지키고 원재료는 받는다
 *   §8 「확인한 것이 없다면 부분 확인도 아니다」 — 영양 0개는 `partial` 로 승격되지 않는다
 *   §9 영양 미확보 기여가 3건 모여도 **기존 영양값을 NULL 로 지우지 않는다**
 *      (세션64b 가 새로 여는 유일한 구멍. mergeService 의 UPSERT 는 COALESCE 가 없다)
 *
 * ★ 이 파일은 **소스 문자열을 한 글자도 읽지 않는다.**
 *   pglite(진짜 Postgres/wasm)에 `000_baseline.sql` 정본을 적용하고, 정본 서비스 함수를
 *   실제로 호출해 **DB 에 실제로 박힌 행**과 반환 객체만 단정한다.
 *   (세션48 4차 검증: 소스 정규식 검사는 본문 오염으로 뚫렸고 12개 파일이 거짓 초록이었다.)
 *
 * ★★ Google Vision 을 부르지 않는다. 이 파일은 OCR 서비스를 아예 require 하지 않는다
 *    (파서 뒤의 «저장 경계»만 검사하므로 사진이 필요 없다).
 *
 * 실행: cross-env NODE_ENV=test node tests/test_nutrition_partial_save.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRV = path.join(__dirname, '..');
const BASELINE = path.join(SRV, 'scripts', 'migrations', '000_baseline.sql');
// ★★ 세션66 C6 — 제보는 이제 공식 테이블에 «즉시» 쓰지 않는다(설계 §3-2 · 계약 §7).
//   이 파일이 지키는 것(「영양 실패가 원재료·알레르기를 데려가지 않는다」)은 그대로다.
//   달라진 것은 그 증거가 «어디에» 남는가다: `contributions` + `contribution_review` candidate,
//   그리고 관리자가 승인하면 공식 테이블. 그래서 023·024·025 를 적용하고
//   승인 단계를 픽스처에 넣는다.
//   ⚠ 026(CHECK 제약)은 **일부러 적용하지 않는다** — §9 픽스처가 `nutrition_data` 에
//     `ocr_crowdsource` 행을 직접 심어 「이미 들어 있던 옛 행」을 재현하기 때문이다.
const M023 = path.join(SRV, 'scripts', 'migrations', '023_data_inspection.sql');
const M024 = path.join(SRV, 'scripts', 'migrations', '024_contribution_review.sql');
const M025 = path.join(SRV, 'scripts', 'migrations', '025_nutrition_data_crowd.sql');

// ══════════════════════════════════════════════════════════════════════════
// 0. 출력 (기존 테스트 파일들과 같은 형식)
// ══════════════════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════════════════
// 1. 실행
// ══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(' 세션64b — 영양 미확보 부분 저장 (저장 ≠ 표시 ≠ 검증)');
  console.log('════════════════════════════════════════════════════════════════');

  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (_) {
    console.log('⏭  pglite 미설치 — 저장 경로를 검증할 수 없다 (npm i -D @electric-sql/pglite)');
    console.log('   ★ 이 테스트의 목적상 「건너뜀」은 「통과」가 아니다. EXIT=1 로 남긴다.');
    process.exit(1);
  }

  const db = new PGlite();
  try {
    await db.exec(fs.readFileSync(BASELINE, 'utf8'));
    await db.exec(fs.readFileSync(M023, 'utf8'));
    await db.exec(fs.readFileSync(M024, 'utf8'));
    await db.exec(fs.readFileSync(M025, 'utf8'));
  } catch (e) {
    console.error(`000_baseline.sql 적용 실패 — 픽스처가 아니라 정본 SQL 문제다: ${e.message}`);
    process.exit(1);
  }

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

  // logger 스텁 — 3단계(개수 관측)가 로그에도 남는지 본다.
  //   ⚠ 서비스를 require 하기 **전에** 갈아끼워야 한다(모듈 최상단에서 잡아가므로).
  const infoLog = [];
  const loggerPath = require.resolve('../src/config/logger');
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: {
      info: (msg, meta) => { infoLog.push({ msg, meta }); },
      warn: () => {}, error: () => {}, debug: () => {},
    },
  };

  const crowdsource = require('../src/services/crowdsourceService');
  const productService = require('../src/services/productService');
  const { mergeAndApply } = require('../src/services/mergeService');
  const { applyApprovedContribution } = require('../src/services/contributionApply');

  /**
   * ★ 관리자 승인 1건을 흉내낸다 — 「제보 → (사람) → 공식 테이블」의 가운데 단계.
   *   ⚠ `reviewed_by` 를 채우는 것이 `cr_approve_human_chk`(DS-1 전량 수동)를 만족시키는 일이다.
   *     코드가 스스로 채울 수 없는 값이라 **테스트가 사람 대신 채운다.**
   */
  const approveAxis = async (productId, axis) => {
    await db.query(
      `UPDATE contribution_review SET status = 'superseded'
        WHERE product_id = $1 AND axis = $2 AND status = 'approved'`, [productId, axis]);
    const r = await db.query(
      `SELECT review_id FROM contribution_review
        WHERE product_id = $1 AND axis = $2 AND status = 'candidate'
        ORDER BY review_id DESC LIMIT 1`, [productId, axis]);
    if (r.rows.length === 0) return null;
    const reviewId = Number(r.rows[0].review_id);
    await db.query(
      `UPDATE contribution_review
          SET status = 'approved', reviewed_by = 'test-admin', reviewed_at = now()
        WHERE review_id = $1`, [reviewId]);
    await applyApprovedContribution({ query: (t2, p2) => db.query(t2, p2 || []) }, reviewId,
      { appliedBy: 'test-admin' });
    return reviewId;
  };
  const axisRows = async (productId) => (await db.query(
    `SELECT axis, status FROM contribution_review WHERE product_id = $1 ORDER BY axis`,
    [productId])).rows;

  /** 제보 1건. 기본은 「멀쩡한 100g 라벨 + 원재료 + 알레르기(밀)」다. */
  const report = (over = {}) => ({
    barcode: over.barcode ?? null,
    deviceId: over.deviceId ?? null,
    avgConfidence: over.avgConfidence ?? 0.95,
    productInfo: {
      product_name: over.productName ?? '테스트과자',
      food_type: over.foodType ?? '과자',
      content_unit: 'g',
      total_content: 120,
      ...(over.productInfo || {}),
    },
    ocrResult: { corrected_text: '원재료명: 밀가루, 설탕\n밀 함유\n영양성분 100g당' },
    analysis: {
      nutrition: over.nutrition !== undefined ? over.nutrition : {
        calories: 480, sodium: 300, total_carbs: 60, total_sugars: 25,
        total_fat: 22, saturated_fat: 12, trans_fat: 0, cholesterol: 5, protein: 6,
        dietary_fiber: 2, _basis: 'per_100g',
      },
      ingredients: over.ingredients !== undefined ? over.ingredients : [{ name: '밀가루' }, { name: '설탕' }],
      allergens: over.allergens !== undefined ? over.allergens : ['밀'],
      allergens_v2: over.allergensV2 !== undefined ? over.allergensV2
        : { contains: ['밀'], inferred: [], mayContain: [] },
      product_meta: {},
    },
  });

  /** 특정 제품의 마지막 기여 레코드(JSONB) */
  async function lastContribution(productId) {
    const r = await db.query(
      'SELECT data FROM contributions WHERE product_id = $1 ORDER BY contribution_id DESC LIMIT 1',
      [productId]);
    if (r.rows.length === 0) return null;
    return typeof r.rows[0].data === 'string' ? JSON.parse(r.rows[0].data) : r.rows[0].data;
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§1. 부분 저장 — 영양 실패가 원재료·알레르기를 데려가지 않는다');
  // ══════════════════════════════════════════════════════════════════════
  // 종전: 기준 판별 실패 → `return { saved:false }` → 같은 사진의 원재료·알레르기 **전멸**.
  //   알레르기는 안전 직결 축이다. 영양표를 못 읽었다는 이유로 「밀 함유」 증거를 버리면
  //   그 바코드를 나중에 조회하는 밀 알레르기 사용자가 아무 경고도 못 받는다.
  let basisProductId = null;

  await t('★★★ 표기 기준을 못 읽어도 제보 자체는 저장된다 (영양만 미확보)', async () => {
    const r = await crowdsource.saveOcrContribution(report({
      barcode: 'S64B_BASIS', deviceId: 'dev-basis-1', productName: '기준불명쿠키',
      nutrition: {
        calories: 480, sodium: 300, total_carbs: 60, total_sugars: 25, protein: 6,
        // ★ `_basis` 가 없다 — 실물 라벨에서 기준 문구가 잘려 찍힌 경우다.
      },
    }));
    assert.strictEqual(r.saved, true, `제보 전체가 반려됐다: ${r.rejectReason}`);
    assert.strictEqual(r.nutrition_status, 'incomplete');
    assert.strictEqual(r.nutrition_reject_code, 'BASIS_UNKNOWN',
      `영양 반려 사유가 기준 판별이 아니다: ${r.nutrition_reject_code}`);
    basisProductId = r.productId;
  });

  await t('★★★ 원재료가 실제로 남았다 (검토 큐 candidate + 승인하면 마스터로 간다)', async () => {
    // ★★ 세션66 C6 — 기대값이 바뀐 지점.
    //   종전: 제보 즉시 `product_ingredients` 에 1행. 지금: 미검토 상태에서는 0행이고
    //   `contribution_review` 에 `ingredients` candidate 가 선다(설계 §3-2 · `U65-8`).
    //   ⚠ 이 단정이 지키던 것은 「영양 실패가 원재료 증거를 **데려가지 않는다**」이지
    //     「어느 테이블에 즉시 들어간다」가 아니다. 그래서 ① 증거가 남았고 ② 승인하면
    //     마스터까지 간다는 것을 **둘 다** 잰다. 어느 한쪽만 재면 다시 뚫린다.
    assert.strictEqual(
      (await db.query('SELECT 1 FROM product_ingredients WHERE product_id = $1', [basisProductId]))
        .rows.length, 0,
      '미검토 제보가 공식 원재료 테이블에 들어갔다 — U65-8 이 되살아났다');
    const axes = (await axisRows(basisProductId)).map((r) => r.axis);
    assert.ok(axes.includes('ingredients'),
      `영양 실패 때문에 원재료 축이 검토 큐에서도 사라졌다: ${JSON.stringify(axes)}`);

    await approveAxis(basisProductId, 'ingredients');
    const ing = await db.query(
      'SELECT parsed_ingredients FROM product_ingredients WHERE product_id = $1', [basisProductId]);
    assert.strictEqual(ing.rows.length, 1, '승인했는데 원재료가 마스터에 반영되지 않았다');
    const parsed = typeof ing.rows[0].parsed_ingredients === 'string'
      ? JSON.parse(ing.rows[0].parsed_ingredients) : ing.rows[0].parsed_ingredients;
    assert.ok(parsed.includes('밀가루'), `원재료가 온전하지 않다: ${JSON.stringify(parsed)}`);
  });

  await t('★★★ 알레르기 «원증거» 가 기여 레코드에 남았다 (등급까지)', async () => {
    const data = await lastContribution(basisProductId);
    assert.ok(data, '기여 레코드가 아예 없다 — 원증거가 통째로 사라졌다');
    assert.ok((data.allergens || []).includes('밀'),
      `flat 알레르기가 사라졌다: ${JSON.stringify(data.allergens)}`);
    assert.ok((data.allergens_v2?.contains || []).includes('밀'),
      `3분리 등급이 사라졌다: ${JSON.stringify(data.allergens_v2)}`);
  });

  await t('★ 그런데 «영양값»은 저장되지 않았다 (게이트의 방향은 그대로다)', async () => {
    const nut = await db.query('SELECT nutrition_id FROM nutrition_data WHERE product_id = $1',
      [basisProductId]);
    assert.strictEqual(nut.rows.length, 0,
      '기준을 모르는 영양값이 마스터에 박혔다 — 100g 값이 1회분으로 읽혀 거짓 판정이 된다');
  });

  await t('★ 기준 판별 실패 시 sanity 는 [] 가 아니라 null 이다 (검사 못 함 ≠ 이상 없음)', async () => {
    const data = await lastContribution(basisProductId);
    assert.strictEqual(data.sanity_warnings, null,
      `기준을 모르는데 「검사했고 이상 없음」으로 기록됐다: ${JSON.stringify(data.sanity_warnings)}`);
  });

  await t('★ 쓸 수 없는 영양값은 parsed_nutrition 에 남지 않는다 (병합이 그것을 읽는다)', async () => {
    const data = await lastContribution(basisProductId);
    assert.strictEqual(data.parsed_nutrition, null,
      'mergeService.extractCandidatesFromContribution 이 이 키를 median 에 쓴다 — '
      + '기준 불명 값이 여기 남으면 나중 병합이 그것을 마스터에 올린다');
    assert.ok(data.rejected_nutrition && data.rejected_nutrition.calories === 480,
      '관측용 원본(rejected_nutrition)까지 사라졌다 — 왜 떨어졌는지 나중에 볼 수 없다');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§2. 영양소 0개 — 저장 «거부» 가 아니라 「미확보」 표시');
  // ══════════════════════════════════════════════════════════════════════
  let zeroProductId = null;

  await t('★★★ 영양소 0개도 저장된다 (incomplete / NO_NUTRIENTS)', async () => {
    const r = await crowdsource.saveOcrContribution(report({
      barcode: 'S64B_ZERO', deviceId: 'dev-zero-1', productName: '영양미확보젤리',
      nutrition: {},
    }));
    assert.strictEqual(r.saved, true, `영양소 0개라고 제보가 반려됐다: ${r.rejectReason}`);
    assert.strictEqual(r.nutrition_status, 'incomplete');
    assert.strictEqual(r.nutrition_reject_code, 'NO_NUTRIENTS',
      `0개인데 사유가 NO_NUTRIENTS 가 아니다: ${r.nutrition_reject_code} — `
      + '기준 판별 실패가 먼저 걸려 진짜 원인이 가려졌을 수 있다');
    assert.strictEqual(r.nutrient_count, 0);
    zeroProductId = r.productId;
  });

  await t('★★★ nutrition_data 에 행이 «생기지 않는다» (빈 값이 0 으로 보일 경로가 없다)', async () => {
    const nut = await db.query('SELECT * FROM nutrition_data WHERE product_id = $1', [zeroProductId]);
    assert.strictEqual(nut.rows.length, 0,
      '영양소 0개인데 nutrition_data 행이 만들어졌다 — 전 컬럼 NULL 행은 「모름」을 「0」처럼 보이게 한다');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§3. 소비자 응답 — 영양 미확보 제품에 신호등을 내지 않는다');
  // ══════════════════════════════════════════════════════════════════════
  await t('★★★ traffic_light 가 null 이다 (「판정 없음」이지 「초록」이 아니다)', async () => {
    const res = await productService.getProductWithTrafficLight('S64B_ZERO');
    assert.strictEqual(res.traffic_light, null,
      `영양을 하나도 모르는 제품에 신호등이 나갔다: ${JSON.stringify(res.traffic_light)}`);
  });

  await t('★★★ nutrition 블록도 null 이다 (0 으로 채워 내보내지 않는다)', async () => {
    const res = await productService.getProductWithTrafficLight('S64B_ZERO');
    assert.strictEqual(res.nutrition, null,
      `빈 영양이 객체로 나갔다 — 화면에서 0 처럼 보인다: ${JSON.stringify(res.nutrition)}`);
  });

  await t('★ 기준 판별 실패 제품도 마찬가지다 (사유가 달라도 결과는 같다)', async () => {
    const res = await productService.getProductWithTrafficLight('S64B_BASIS');
    assert.strictEqual(res.traffic_light, null);
    assert.strictEqual(res.nutrition, null);
    // 제품 자체는 조회된다 — 제보가 헛되지 않았다는 뜻이다.
    assert.strictEqual(res.product.product_name, '기준불명쿠키');
  });

  await t('★ 대조군 — 영양이 온전한 제보는 «승인 후» 신호등이 나간다 (과하게 막지 않았다)', async () => {
    // ★★ 세션66 C6 — 기대값이 바뀐 지점.
    //   종전: 제보 즉시 신호등이 나갔다. 그것이 `U65-8`(미검토 제보가 즉시 노출)이었다.
    //   지금: 미검토 상태에서는 안 나가고, 관리자가 승인하면 나간다.
    //   ⚠ 이 단정이 지키던 것은 「게이트가 «과하게» 막지 않는다」다. 그 축은 승인 후
    //     실제로 신호등이 나오는지로 그대로 잰다 — 오히려 경로 전체를 재게 됐다.
    const r = await crowdsource.saveOcrContribution(report({
      barcode: 'S64B_OK', deviceId: 'dev-ok-1', productName: '정상쿠키',
    }));
    assert.strictEqual(r.saved, true, r.rejectReason);
    assert.strictEqual(r.nutrition_status, 'ok');

    const before = await productService.getProductWithTrafficLight('S64B_OK');
    assert.strictEqual(before.traffic_light, null,
      '★ 미검토 제보가 즉시 신호등으로 나갔다 — U65-8 이 되살아났다');

    await approveAxis(r.productId, 'nutrition');
    const res = await productService.getProductWithTrafficLight('S64B_OK');
    assert.ok(res.traffic_light, '승인했는데 신호등이 안 나갔다 — 통합 뷰(DS-8)가 제보를 못 읽는다');
    assert.ok(res.nutrition, '승인했는데 nutrition 블록이 null 이다');
    assert.strictEqual(res.nutrition.calories, 480);
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§4. ★★ 알레르기 도크트린 — not detected ≠ absent (의미를 바꾸지 않았다)');
  // ══════════════════════════════════════════════════════════════════════
  // 세션45~54 가 여러 세션을 태워 세운 계약이다. 세션62 는 그 의미를 «좁히는» 데
  // 세션 하나를 썼다. 부분 저장이 이 의미를 건드리면 안 된다.
  await t('★★★ 알레르기가 «안 나온» 제보를 저장해도 「알레르기 없음」이 되지 않는다', async () => {
    const r = await crowdsource.saveOcrContribution(report({
      barcode: 'S64B_NOALG', deviceId: 'dev-noalg-1', productName: '알레르기미검출과자',
      nutrition: {},                     // 영양도 미확보 — 부분 저장 경로를 탄다
      allergens: [], allergensV2: { contains: [], inferred: [], mayContain: [] },
    }));
    assert.strictEqual(r.saved, true, r.rejectReason);

    const res = await productService.getProductWithTrafficLight('S64B_NOALG');
    assert.strictEqual(res.allergens, null,
      `「OCR 에서 안 나왔다」가 빈 배열(=「확인했고 없다」)로 나갔다: ${JSON.stringify(res.allergens)}`);
    assert.strictEqual(res.allergens_v2, null);
    assert.strictEqual(res.allergens_available, false,
      '알레르겐 행이 하나도 없는데 allergens_available 이 true 다 — 짜왕 사고의 재현이다');
    assert.strictEqual(res.allergens_flat_complete, null,
      '읽은 것이 없는데 「flat 이 전부다」를 단정했다');
  });

  await t('★★★ 부분 저장이 product_allergens 마스터를 새로 쓰지 않는다 (계약 불변)', async () => {
    // 저장 경로는 원래 `product_allergens` 에 쓰지 않는다 — 마스터 반영은 병합(3기기)의 몫이다.
    // 부분 저장을 열면서 여기에 쓰기 시작하면, 1인 제보가 곧바로 「직접 함유」 마스터가 되고
    // `allergens_available` 의 의미(수집됨)가 조용히 바뀐다. 그 문을 닫아 둔다.
    const rows = await db.query('SELECT product_id FROM product_allergens WHERE product_id = ANY($1::bigint[])',
      [[basisProductId, zeroProductId]]);
    assert.strictEqual(rows.rows.length, 0,
      '부분 저장이 product_allergens 에 직접 썼다 — 1인 제보가 마스터가 되면 계약이 바뀐다');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§5. 개수는 «관측» 지표다 — 저장을 거부하지 않는다');
  // ══════════════════════════════════════════════════════════════════════
  // 실측(세션64 라벨 67건): 0개 4건 vs 5~12개 63건. **1~4개 구간이 비어 있다.**
  // 표본이 작아 하한을 정할 근거가 없다 → 운영에서 1~4개가 실제로 나오는지부터 본다.
  await t('★★★ 영양소 3개짜리 라벨도 저장된다 (1~4개 구간에 하한을 두지 않았다)', async () => {
    const r = await crowdsource.saveOcrContribution(report({
      barcode: 'S64B_THREE', deviceId: 'dev-three-1', productName: '세개짜리라벨',
      nutrition: { calories: 120, sodium: 40, protein: 3, _basis: 'per_serving' },
    }));
    assert.strictEqual(r.saved, true, `개수로 저장을 거부했다: ${r.rejectReason}`);
    assert.strictEqual(r.nutrition_status, 'ok',
      `3개짜리를 미확보로 떨어뜨렸다 — 개수 하한이 생겼다: ${r.nutrition_reject_code}`);
    assert.strictEqual(r.nutrient_count, 3);
    // ★★ 세션66 C6 — 저장처가 `nutrition_data`(공공 전용) → `nutrition_data_crowd`(승인된 제보)로
    //   바뀌었다(`DS-7` 물리 분리). 「3개짜리도 저장 대상으로 인정된다」는 그대로 잰다.
    assert.strictEqual(
      (await db.query('SELECT 1 FROM nutrition_data WHERE product_id = $1', [r.productId])).rows.length, 0,
      '미검토 제보가 공공 영양 테이블에 들어갔다');
    await approveAxis(r.productId, 'nutrition');
    const nut = await db.query(
      'SELECT calories FROM nutrition_data_crowd WHERE product_id = $1', [r.productId]);
    assert.strictEqual(nut.rows.length, 1, '3개짜리 영양이 저장되지 않았다 — 개수 하한이 생겼다');
  });

  await t('★★★ 개수가 기여 레코드에 남는다 (나중에 분포를 볼 수 있다)', async () => {
    const r = await db.query(
      `SELECT (c.data->>'nutrient_count')::int AS n, c.data->>'nutrition_status' AS st
       FROM contributions c JOIN products p ON p.product_id = c.product_id
       WHERE p.barcode = 'S64B_THREE'`);
    assert.strictEqual(r.rows.length, 1);
    assert.strictEqual(r.rows[0].n, 3, '개수 관측이 기여 레코드에 안 남았다');
    assert.strictEqual(r.rows[0].st, 'ok');
  });

  await t('★ 개수가 로그에도 남는다 (운영 첫날부터 관찰할 수 있다)', () => {
    const hit = infoLog.filter((l) => l.meta && typeof l.meta.nutrient_count === 'number');
    assert.ok(hit.length > 0, '저장 로그에 nutrient_count 가 없다 — DB 를 파야만 볼 수 있다');
    assert.ok(hit.some((l) => l.meta.nutrition_status === 'incomplete'),
      '미확보 건이 로그에 상태로 남지 않는다');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§6. 열량 0 kcal 라벨 — 「0」과 「모름」을 섞지 않는다');
  // ══════════════════════════════════════════════════════════════════════
  // 종전: `hasNutrition = nutrition.calories || nutrition.sodium || nutrition.total_sugars`
  //   **truthy 검사**라 열량 0·나트륨 0·당류 0 인 제로칼로리 음료는 나머지 값이 다 있어도
  //   `nutrition_data` 행이 만들어지지 않았다. = 실제 라벨값 「0」이 「없음」으로 소실.
  await t('★★★ 열량 0 / 나트륨 0 / 당류 0 라벨이 저장된다 (truthy 함정)', async () => {
    const r = await crowdsource.saveOcrContribution(report({
      barcode: 'S64B_ZEROKCAL', deviceId: 'dev-zerokcal-1', productName: '제로탄산음료',
      foodType: '탄산음료',
      nutrition: {
        calories: 0, sodium: 0, total_sugars: 0, total_carbs: 0, total_fat: 0,
        saturated_fat: 0, trans_fat: 0, protein: 0, _basis: 'per_100ml',
      },
    }));
    assert.strictEqual(r.saved, true, r.rejectReason);
    assert.strictEqual(r.nutrition_status, 'ok',
      `실제 라벨값 0 이 「영양 없음」으로 취급됐다: ${r.nutrition_reject_code}`);
    assert.strictEqual(r.nutrient_count, 8, '0 을 「없음」으로 세고 있다');
    // ★★ 세션66 C6 — 저장처가 `nutrition_data_crowd` 로 바뀌었다(`DS-7`). 값 0 은 그대로 0 이다.
    await approveAxis(r.productId, 'nutrition');
    const nut = await db.query(
      'SELECT calories, sodium FROM nutrition_data_crowd WHERE product_id = $1', [r.productId]);
    assert.strictEqual(nut.rows.length, 1, '제로칼로리 라벨이 통째로 저장되지 않았다');
    assert.strictEqual(Number(nut.rows[0].calories), 0);
    assert.strictEqual(Number(nut.rows[0].sodium), 0);
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§7. 기존 제품 재제보 — 공공데이터 영양은 지키고 원재료는 받는다');
  // ══════════════════════════════════════════════════════════════════════
  // 종전: 공공데이터 영양이 이미 있으면 `return { saved:false }` → **원재료·알레르기 전멸.**
  //   식약처 데이터는 영양만 준다. 원재료·알레르기를 채우는 유일한 경로가 사진 제보인데
  //   「영양이 이미 있다」를 이유로 그것을 버리면 순손실이다.
  let publicProductId = null;

  await t('픽스처 — 공공데이터 영양이 있는 기존 제품을 심는다', async () => {
    const p = await db.query(
      `INSERT INTO products (barcode, product_name, food_type, serving_size, content_unit, data_source, verification)
       VALUES ('S64B_PUBLIC', '식약처등록라면', '유탕면', 120, 'g', 'public_c005', 'verified')
       RETURNING product_id`);
    publicProductId = p.rows[0].product_id;
    await db.query(
      `INSERT INTO nutrition_data (product_id, calories, sodium, protein, data_source)
       VALUES ($1, 505, 1790, 10, 'public_nutrition')`, [publicProductId]);
    const chk = await db.query('SELECT calories FROM nutrition_data WHERE product_id = $1', [publicProductId]);
    assert.strictEqual(Number(chk.rows[0].calories), 505);
  });

  await t('★★★ 제보가 저장된다 (영양만 미확보 · PUBLIC_DATA_PROTECTED)', async () => {
    const r = await crowdsource.saveOcrContribution(report({
      barcode: 'S64B_PUBLIC', deviceId: 'dev-public-1', productName: '식약처등록라면',
      foodType: '유탕면',
      ingredients: [{ name: '소맥분' }, { name: '팜유' }],
      allergens: ['밀', '대두'],
      allergensV2: { contains: ['밀'], inferred: ['대두'], mayContain: [] },
    }));
    assert.strictEqual(r.saved, true, `기존 제품 재제보가 통째로 반려됐다: ${r.rejectReason}`);
    assert.strictEqual(r.productId, publicProductId, '기존 제품에 붙지 않고 새 행을 만들었다');
    assert.strictEqual(r.nutrition_status, 'incomplete');
    assert.strictEqual(r.nutrition_reject_code, 'PUBLIC_DATA_PROTECTED');
  });

  await t('★★★ 공공데이터 영양값이 «그대로» 다 (OCR 이 덮지 않았다)', async () => {
    const nut = await db.query(
      'SELECT calories, sodium, data_source FROM nutrition_data WHERE product_id = $1', [publicProductId]);
    assert.strictEqual(nut.rows.length, 1, '영양 행 개수가 변했다');
    assert.strictEqual(Number(nut.rows[0].calories), 505, '공공데이터 열량이 OCR 값으로 덮였다');
    assert.strictEqual(Number(nut.rows[0].sodium), 1790);
    assert.strictEqual(nut.rows[0].data_source, 'public_nutrition', '출처가 ocr_crowdsource 로 바뀌었다');
  });

  await t('★★★ 그런데 원재료·알레르기는 «받았다» (이것이 이번에 고친 순손실이다)', async () => {
    // ★★ 세션66 C6 — 증거가 남는 «자리»가 검토 큐로 옮겨졌다. 「버려지지 않는다」는 그대로다.
    const axes = (await axisRows(publicProductId)).map((r) => r.axis);
    assert.ok(axes.includes('ingredients') && axes.includes('allergens'),
      `공공 영양이 있다는 이유로 원재료·알레르기 축이 통째로 버려졌다: ${JSON.stringify(axes)}`);
    await approveAxis(publicProductId, 'ingredients');
    const ing = await db.query(
      'SELECT parsed_ingredients FROM product_ingredients WHERE product_id = $1', [publicProductId]);
    assert.strictEqual(ing.rows.length, 1, '기존 제품의 원재료 제보가 버려졌다');
    const parsed = typeof ing.rows[0].parsed_ingredients === 'string'
      ? JSON.parse(ing.rows[0].parsed_ingredients) : ing.rows[0].parsed_ingredients;
    assert.ok(parsed.includes('소맥분'), JSON.stringify(parsed));

    const data = await lastContribution(publicProductId);
    assert.ok((data.allergens_v2?.contains || []).includes('밀'),
      `알레르기 원증거가 버려졌다: ${JSON.stringify(data.allergens_v2)}`);
  });

  await t('★ 이미 verified 인 공공 제품의 검증 상태를 강등하지 않았다', async () => {
    const p = await db.query('SELECT verification FROM products WHERE product_id = $1', [publicProductId]);
    assert.strictEqual(p.rows[0].verification, 'verified',
      '식약처 제품이 사용자 제보 한 건으로 강등됐다');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§8. 「확인한 것이 없다면 부분 확인도 아니다」 (검토자 지적)');
  // ══════════════════════════════════════════════════════════════════════
  await t('★★★ 영양 0개 + 신뢰도 0.99 여도 partial 로 승격되지 않는다', async () => {
    const r = await crowdsource.saveOcrContribution(report({
      barcode: 'S64B_NOPARTIAL', deviceId: 'dev-nopartial-1', productName: '고신뢰영양없음',
      avgConfidence: 0.99, nutrition: {},
    }));
    assert.strictEqual(r.saved, true, r.rejectReason);
    assert.strictEqual(r.verification, 'unverified',
      '영양소를 하나도 확인하지 않았는데 「부분 확인됨」으로 올라갔다');
    const p = await db.query("SELECT verification FROM products WHERE barcode = 'S64B_NOPARTIAL'");
    assert.strictEqual(p.rows[0].verification, 'unverified', 'DB 의 verification 이 partial 이다');
  });

  await t('★ 대조군 — 영양이 온전 + 신뢰도 0.99 면 partial 로 올라간다 (승격이 죽지 않았다)', async () => {
    const r = await crowdsource.saveOcrContribution(report({
      barcode: 'S64B_PARTIALOK', deviceId: 'dev-partialok-1', productName: '정상고신뢰쿠키',
      avgConfidence: 0.99,
    }));
    assert.strictEqual(r.verification, 'partial', `정상 제보가 승격되지 않았다: ${r.verification}`);
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§9. ★★★ 병합 — 「모름」이 기존 「앎」을 지우지 않는다');
  // ══════════════════════════════════════════════════════════════════════
  // 세션64b 가 «새로» 여는 유일한 구멍이다.
  //   부분 저장은 `parsed_nutrition: null` 인 기여를 만든다. 그런 기여만 3건 모이면
  //   `mergeContributions` 의 median 이 전 항목 null 을 내고,
  //   `mergeAndApply` 의 UPSERT 는 `calories = EXCLUDED.calories` 처럼 **COALESCE 없이 덮는다.**
  //   → 이미 잘 들어 있던 영양값이 전부 NULL 로 지워진다.
  await t('픽스처 — OCR 출처 영양이 이미 있는 제품 + 영양 미확보 기여 3건', async () => {
    const p = await db.query(
      `INSERT INTO products (barcode, product_name, food_type, serving_size, content_unit, data_source)
       VALUES ('S64B_MERGE', '병합대상쿠키', '과자', 30, 'g', 'ocr_crowdsource')
       RETURNING product_id`);
    const pid = p.rows[0].product_id;
    await db.query(
      `INSERT INTO nutrition_data (product_id, calories, sodium, protein, data_source)
       VALUES ($1, 480, 300, 6, 'ocr_crowdsource')`, [pid]);

    for (const dev of ['merge-dev-a', 'merge-dev-b', 'merge-dev-c']) {
      await db.query(
        `INSERT INTO contributions (product_id, contribution_type, data, status, device_id)
         VALUES ($1, 'ocr_nutrition', $2, 'pending', $3)`,
        [pid, JSON.stringify({
          // ★ 부분 저장이 만드는 «실제» 모양이다.
          parsed_nutrition: null,
          nutrition_status: 'incomplete',
          nutrition_reject_code: 'BASIS_UNKNOWN',
          nutrient_count: 0,
          parsed_ingredients: [{ name: '밀가루' }],
          allergens: ['밀'],
          allergens_v2: { contains: ['밀'], inferred: [], mayContain: [] },
          user_input: { product_name: '병합대상쿠키', food_type: '과자' },
          device_id: dev,
          avg_confidence: 0.95,
        }), dev]);
    }
    global.__s64bMergePid = pid;
  });

  await t('★★★ 영양 미확보 기여 3건이 기존 영양값을 NULL 로 지우지 않는다', async () => {
    const pid = global.__s64bMergePid;
    await mergeAndApply(pid);
    const nut = await db.query('SELECT calories, sodium, protein FROM nutrition_data WHERE product_id = $1',
      [pid]);
    assert.strictEqual(nut.rows.length, 1, '영양 행이 사라졌다');
    assert.strictEqual(Number(nut.rows[0].calories), 480,
      '「영양을 모른다」는 제보 3건이 이미 알고 있던 열량을 지웠다 — '
      + 'mergeService 의 UPSERT 에는 COALESCE 가 없다');
    assert.strictEqual(Number(nut.rows[0].sodium), 300);
    assert.strictEqual(Number(nut.rows[0].protein), 6);
  });

  await t('★ 그래도 병합은 «원재료»를 검토 큐에 올렸다 (승인하면 마스터로 간다)', async () => {
    // ★★ 세션66 C6 — 기대값이 바뀐 지점. 병합도 **자동 반영이 아니다**(설계 §3-2 · 예외 없음).
    //   ⚠ 지키던 것은 「영양이 미확보여도 원재료 증거가 헛되지 않는다」이지
    //     「병합이 즉시 마스터에 쓴다」가 아니다.
    const pid = global.__s64bMergePid;
    assert.strictEqual(
      (await db.query('SELECT 1 FROM product_ingredients WHERE product_id = $1', [pid])).rows.length, 0,
      '★ 기기 3대 병합이 원재료를 자동 반영했다 — 전량 수동에 예외가 없다(설계 §3-2)');
    const axes = (await axisRows(pid)).map((r) => r.axis);
    assert.ok(axes.includes('ingredients'), `병합이 원재료 축을 큐에 안 올렸다: ${JSON.stringify(axes)}`);

    await approveAxis(pid, 'ingredients');
    const ing = await db.query(
      'SELECT parsed_ingredients FROM product_ingredients WHERE product_id = $1 ORDER BY 1 DESC', [pid]);
    assert.ok(ing.rows.length >= 1, '승인했는데 병합 원재료가 반영되지 않았다');
  });

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(` 결과: ${pass}/${pass + fail} 통과 · ${fail} 실패`);
  if (fail > 0) {
    console.log('\n실패 상세:');
    for (const f of failures) console.log(`  - ${f.name}\n    ${f.message}`);
  }
  console.log('════════════════════════════════════════════════════════════════\n');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('테스트 실행 오류:', e);
  process.exit(1);
});
