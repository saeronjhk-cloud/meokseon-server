/**
 * test_contribution_split_schema.js — 세션66 C1~C4 (`DS-1`·`DS-2`·`DS-7`·`DS-8`) 스키마 회귀
 * ============================================================================
 * 배경 (`IP/설계_제보데이터분리_2026-08-28_세션65.md` §11-B · 계약 `.tmp/s66/계약_세션66.md`)
 *   제보는 지금까지 «공식 테이블에 직접» 써졌다. 그래서 셋이 동시에 열려 있었다.
 *     `U65-6` 공공데이터 보호가 **1회용**이다 — 한 번 덮이면 그 뒤엔 제보가 이긴다
 *     `U65-7` 반려가 `nutrition_data` 를 DELETE 한다 — 공공 데이터를 지울 수 있다
 *     `U65-8` 미검토 제보가 즉시 다른 소비자에게 노출된다
 *   제이 결정 2026-08-30: **「물리 분리한다」 + 「공공데이터와 승인된 제보는 통합되도록」.**
 *   ⇒ 물리적으로 나누고(025·026), 논리적으로 뷰가 합친다(`DS-8`).
 *
 * 무엇을 지키는가
 *   §0  ★ 023·024·025·026 이 `npm run migrate` 체인에 «이어져» 있고 각 조각에
 *         `-v ON_ERROR_STOP=1` 이 있다 (세션64c gate #19 재현 방지 — 파일을 만드는 것과
 *         체인에 잇는 것은 «다른 일»이다)
 *   §1  023 `data_inspection` — 축 CHECK · found_count 가 NULL 허용(0 ≠ 「안 봤다」)
 *   §2  024 `contribution_review` — 어휘 CHECK
 *   §3  ★★ `nutrition_data` 와 `nutrition_data_crowd` 의 영양 **15컬럼이 이름·타입 모두 같다**
 *         (설계 §11-B-5 위험 2 — 한쪽에만 컬럼을 추가하면 그 영양소만 통합에서 조용히 빠진다)
 *   §4  ★ 뷰가 **필드 단위**로 통합한다 — 공공에 칼로리만, 제보에 나트륨만 있으면 **둘 다** 나온다
 *   §5  ★ 공공에 값이 있으면 **제보가 덮지 못한다** (`U65-6` 소멸 — 1회용이 아니라 영구다)
 *   §6  ★ 제보만 있는 제품에 **OFF 라이선스·신뢰도가 잘못 붙지 않는다** (계약 §4-2 (5))
 *   §7  ★ `cr_approve_human_chk` — `reviewed_by` 없는 `approved` 를 **DB 가 거부한다** (`DS-1`)
 *   §8  ★ `uq_cr_approved_per_product_axis` — 같은 (제품, 축)에 두 번째 approved 를 거부한다
 *   §9  ★ 026 CHECK — `nutrition_data` 에 `ocr_crowdsource` INSERT 를 **DB 가 거부한다** (`DS-7`)
 *  §10  ★ 026 이관 — 기존 제보 행이 crowd 로 옮겨지고 원본이 지워지고 candidate 가 생긴다
 *  §11  ★★ **멱등** — 023~026 을 연속 2회 적용해도 죽지 않고 candidate 가 두 번 안 생긴다
 *         (`real-postgres` job 이 `npm run migrate` 를 **2회** 돌린다. 여기서 죽으면 CI 빨강)
 *  §12  ★ 뷰 개정 후 **기존 24컬럼의 이름·타입·순서가 그대로**이고 `crowd_merged` 만 끝에 붙었다
 *         (소비자가 `productModel.findByBarcode` 다 — 순서가 바뀌면 조용히 값이 어긋난다)
 *  §13  ★★ **체인 «전체» 2회차** — `000_baseline.sql` 이 25컬럼 뷰를 24컬럼으로 되돌리려다
 *         죽지 않는가. §11 과 «다른» 것이다(§11 은 새 4개만, §13 은 baseline 부터).
 *
 * ⚠ §0 와 §13 은 **배선(공유 파일 수정) 전까지 빨강이 정상이다.** 둘 다 「코드가 틀렸다」가
 *   아니라 「배포 산출물이 아직 안 이어졌다」를 가리킨다. 초록으로 만드는 법은 각 절에 적혀 있다.
 *
 * ★ 소스 문자열을 읽지 않는다(§0 만 예외 — 그것은 코드 의미가 아니라 **배포 산출물** 검사다).
 *   pglite 에 정본 SQL 을 적용하고 **실제 DB 가 무엇을 거부하는가**만 단정한다.
 * ★ 기존 24컬럼 목록을 이 파일에 «옮겨 적지 않는다» — baseline 만 적용한 두 번째 pglite 를
 *   띄워 거기서 읽은 것과 대조한다. 옮겨 적으면 그 순간 대장이 낡는다.
 *
 * 실행: cross-env NODE_ENV=test node tests/test_contribution_split_schema.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRV = path.join(__dirname, '..');
const MIG = path.join(SRV, 'scripts', 'migrations');
const BASELINE = path.join(MIG, '000_baseline.sql');

const NEW_MIGRATIONS = [
  '023_data_inspection.sql',
  '024_contribution_review.sql',
  '025_nutrition_data_crowd.sql',
  '026_crowd_nutrition_split.sql',
];

// `nutrition_data` 와 `nutrition_data_crowd` 가 «반드시» 공유해야 하는 영양 컬럼.
// 뷰는 이 중 10개만 노출하지만(018 계약), 테이블은 15개를 함께 들고 있어야 한다 —
// 한쪽에만 있는 컬럼이 생기면 나중에 뷰를 넓힐 때 그 영양소만 조용히 빠진다.
const NUTRIENT_COLS = [
  'calories', 'total_fat', 'saturated_fat', 'trans_fat', 'cholesterol',
  'sodium', 'total_carbs', 'total_sugars', 'added_sugars', 'dietary_fiber',
  'protein', 'calcium', 'iron', 'vitamin_d', 'potassium',
];

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

/** 「이 SQL 이 DB 에 거부당하는가」 — 거부당하면 오류 메시지를, 통과하면 null 을 돌려준다. */
async function rejected(db, sql, params) {
  try {
    await db.query(sql, params || []);
    return null;
  } catch (e) {
    return e.message || String(e);
  }
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(' 세션66 C1~C4 — 제보 데이터 물리 분리 + 뷰 통합 (DS-7 · DS-8)');
  console.log('════════════════════════════════════════════════════════════════');

  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (_) {
    console.log('⏭  pglite 미설치 — 검증 불가. 「건너뜀」은 「통과」가 아니다. EXIT=1.');
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('§0  4개 마이그레이션이 `npm run migrate` 체인에 «이어져» 있는가');
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 왜 이 단정이 여기 있나 — 세션64c 가 마이그레이션 **파일만 만들고 체인에 안 이어서**
  //   CI gate #19 를 태웠다. 컬럼이 없는 DB 로 배포가 나가면 이 축 전체가 조용히 무동작이 된다.
  //   ⚠ 이것은 코드 의미가 아니라 **배포 산출물** 검사다 — 그래서 파일을 읽는 것이 맞다.
  const pkg = JSON.parse(fs.readFileSync(path.join(SRV, 'package.json'), 'utf8'));
  const chain = String(pkg.scripts.migrate || '');
  for (const f of NEW_MIGRATIONS) {
    await t(`§0 migrate 체인이 ${f} 를 ON_ERROR_STOP=1 로 실행한다`, () => {
      assert.ok(chain.includes(f),
        `${f} 가 \`npm run migrate\` 체인에 없다. 파일만 만들고 체인에 안 이으면 `
        + '빈 DB·CI·신규 환경에 이 스키마가 영원히 안 생긴다(세션64c gate #19 와 같은 사고).');
      const seg = chain.split('&&').find((x) => x.includes(f));
      assert.ok(/-v\s+ON_ERROR_STOP=1/.test(seg),
        `${f} 구간에 -v ON_ERROR_STOP=1 이 없다 — 실패해도 && 가 이어져 「거짓 초록」이 된다: ${seg.trim()}`);
    });
  }
  // ★ 순서도 본다: 026 은 025 «뒤»여야 한다(025 가 만든 테이블에 026 이 쓴다).
  await t('§0-순서 025 가 026 보다 «앞»에 있다 (026 은 025 가 만든 테이블에 쓴다)', () => {
    const i25 = chain.indexOf('025_nutrition_data_crowd.sql');
    const i26 = chain.indexOf('026_crowd_nutrition_split.sql');
    assert.ok(i25 >= 0 && i26 >= 0, '두 조각이 체인에 다 있어야 순서를 볼 수 있다');
    assert.ok(i25 < i26, '026 이 025 보다 앞에 있다 — nutrition_data_crowd 가 없는 채로 026 이 돈다');
  });

  const readSql = (f) => fs.readFileSync(path.join(MIG, f), 'utf8');

  // ── 기준선 DB: baseline «만» 적용. 뷰의 「개정 전」모습을 여기서 읽는다. ──
  const db0 = new PGlite();
  await db0.exec(fs.readFileSync(BASELINE, 'utf8'));
  const viewColsBefore = (await db0.query(
    `SELECT ordinal_position, column_name, data_type
       FROM information_schema.columns
      WHERE table_name = 'product_nutrition_resolved'
      ORDER BY ordinal_position`)).rows;
  assert.ok(viewColsBefore.length > 0, 'baseline 에 product_nutrition_resolved 뷰가 없다');

  // ── 본 DB ──
  const db = new PGlite();
  try {
    await db.exec(fs.readFileSync(BASELINE, 'utf8'));
  } catch (e) {
    console.error(`000_baseline.sql 적용 실패: ${e.message}`);
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('§9-전  026 «미적용» 상태 — 지금은 공공 테이블이 제보를 받아 준다');
  // ══════════════════════════════════════════════════════════════════════════
  // ★ 022 테스트 관례: 적용 «전» 동작을 먼저 단정하고, 그 다음에 적용한다.
  //   이 상태가 실제로 존재한다(운영이 지금 그렇다). 「원래부터 못 넣었다」면 026 은 무의미하다.
  const pid = async (barcode) => (await db.query(
    'SELECT product_id FROM products WHERE barcode = $1', [barcode])).rows[0].product_id;

  await db.query(
    `INSERT INTO products (barcode, product_name, data_source)
     VALUES ('S66_MIG', '이관대상제품', 'ocr_crowdsource')`);
  const pidMig = await pid('S66_MIG');
  await db.query(
    `INSERT INTO nutrition_data (product_id, calories, sodium, serving_size, ocr_confidence, data_source)
     VALUES ($1, 123, 456, '100g', 90, 'ocr_crowdsource')`, [pidMig]);
  await db.query(
    `INSERT INTO contributions (product_id, contribution_type, data, status)
     VALUES ($1, 'ocr_nutrition', '{"nutrition":{"calories":123}}'::jsonb, 'pending')`, [pidMig]);
  // 이미 처리된 제보는 큐에 되살리지 않는다 — 대조군.
  await db.query(
    `INSERT INTO contributions (product_id, contribution_type, data, status)
     VALUES ($1, 'ocr_nutrition', '{"nutrition":{"calories":123}}'::jsonb, 'verified')`, [pidMig]);

  await t('§9-전 026 적용 «전»에는 nutrition_data 가 ocr_crowdsource 를 받아 준다', async () => {
    const r = await db.query(
      `SELECT count(*)::int AS n FROM nutrition_data WHERE data_source = 'ocr_crowdsource'`);
    assert.strictEqual(r.rows[0].n, 1,
      '적용 전 상태를 재현하지 못했다 — 이 상태가 없으면 §9 가 「원래부터 안 되던 것」을 재는 셈이다');
  });

  // ── 023 → 024 → 025 → 026 적용 ─────────────────────────────────────────
  for (const f of NEW_MIGRATIONS) {
    try {
      await db.exec(readSql(f));
    } catch (e) {
      console.error(`\n${f} 적용 실패: ${e.message}\n`);
      process.exit(1);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('§1  023 data_inspection — 「봤는데 없었다」의 자리');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§1 data_inspection 이 생기고 found_count 가 NULL 허용이다 (0 ≠ 「안 봤다」)', async () => {
    const r = await db.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'data_inspection' ORDER BY ordinal_position`);
    const names = r.rows.map((x) => x.column_name);
    for (const c of ['inspection_id', 'product_id', 'axis', 'source_kind',
      'evidence_ref', 'found_count', 'scope_note', 'inspected_at']) {
      assert.ok(names.includes(c), `data_inspection.${c} 가 없다 (실측: ${names.join(', ')})`);
    }
    const fc = r.rows.find((x) => x.column_name === 'found_count');
    assert.strictEqual(fc.data_type, 'integer', `found_count 가 integer 가 아니다: ${fc.data_type}`);
    assert.strictEqual(fc.is_nullable, 'YES',
      'found_count 는 NULL 허용이어야 한다 — NULL(개수 미측정)과 0(봤는데 없음)은 다른 뜻이다');
  });

  await t('§1-b found_count = 0 이 «저장된다» (「봤는데 없었다」를 기록할 수 있다 — U63-6)', async () => {
    await db.query(
      `INSERT INTO data_inspection (product_id, axis, source_kind, found_count, scope_note)
       VALUES ($1, 'allergens', 'ocr_label', 0, 'ingredients_text_only')`, [pidMig]);
    const r = await db.query(
      `SELECT found_count, scope_note FROM data_inspection
        WHERE product_id = $1 AND axis = 'allergens'`, [pidMig]);
    assert.strictEqual(r.rows.length, 1, '「봤는데 없었다」가 저장되지 않았다');
    assert.strictEqual(Number(r.rows[0].found_count), 0);
    assert.strictEqual(r.rows[0].scope_note, 'ingredients_text_only',
      'scope_note 가 없으면 found_count=0 이 「없다」인지 「그 범위에선 없었다」인지 구분이 안 된다');
  });

  await t('§1-c di_axis_chk 가 어휘 밖 axis 를 거부한다', async () => {
    const msg = await rejected(db,
      `INSERT INTO data_inspection (product_id, axis, source_kind) VALUES ($1, 'calories', 'ocr_label')`,
      [pidMig]);
    assert.ok(msg, 'axis 어휘 밖 값이 들어갔다 — CHECK 가 안 걸려 있다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§2  024 contribution_review — 어휘');
  // ══════════════════════════════════════════════════════════════════════════
  const cidPending = (await db.query(
    `SELECT contribution_id FROM contributions
      WHERE product_id = $1 AND status = 'pending' ORDER BY contribution_id LIMIT 1`,
    [pidMig])).rows[0].contribution_id;

  await t('§2 cr_status_chk · cr_axis_chk 가 어휘 밖 값을 거부한다', async () => {
    const s = await rejected(db,
      `INSERT INTO contribution_review (contribution_id, axis, status) VALUES ($1, 'nutrition', 'pending')`,
      [cidPending]);
    assert.ok(s, "status='pending' 이 들어갔다 — 어휘는 candidate|approved|rejected|undone|superseded 다");
    const a = await rejected(db,
      `INSERT INTO contribution_review (contribution_id, axis) VALUES ($1, 'calories')`,
      [cidPending]);
    assert.ok(a, "axis='calories' 가 들어갔다 — CHECK 가 안 걸려 있다");
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§3  ★★ 두 테이블의 영양 15컬럼이 «이름·타입 모두» 같은가');
  // ══════════════════════════════════════════════════════════════════════════
  // 설계 §11-B-5 위험 2 — 한쪽에만 컬럼을 추가하면 그 영양소만 통합에서 «조용히» 빠진다.
  await t('§3 nutrition_data 와 nutrition_data_crowd 의 영양 15컬럼이 이름·타입 모두 같다', async () => {
    const cols = async (tbl) => {
      const r = await db.query(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_name = $1 AND column_name = ANY($2::text[])`, [tbl, NUTRIENT_COLS]);
      const m = {};
      for (const row of r.rows) m[row.column_name] = row.data_type;
      return m;
    };
    const a = await cols('nutrition_data');
    const b = await cols('nutrition_data_crowd');
    for (const c of NUTRIENT_COLS) {
      assert.ok(a[c], `nutrition_data.${c} 가 없다 — 대조 목록이 낡았다`);
      assert.ok(b[c],
        `nutrition_data_crowd.${c} 가 «없다». 뷰의 COALESCE(nd.${c}, ndc.${c}) 가 성립하지 않는다 `
        + '⇒ 그 영양소만 통합에서 조용히 빠진다(설계 §11-B-5 위험 2).');
      assert.strictEqual(b[c], a[c],
        `${c} 의 타입이 다르다: nutrition_data=${a[c]} · nutrition_data_crowd=${b[c]}`);
    }
  });

  await t('§3-b serving_size · ocr_confidence · verified_at 도 같은 타입이다', async () => {
    const r = await db.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_name IN ('nutrition_data','nutrition_data_crowd')
          AND column_name IN ('serving_size','ocr_confidence','verified_at')`);
    const m = {};
    for (const row of r.rows) m[`${row.table_name}.${row.column_name}`] = row.data_type;
    for (const c of ['serving_size', 'ocr_confidence', 'verified_at']) {
      assert.strictEqual(m[`nutrition_data_crowd.${c}`], m[`nutrition_data.${c}`],
        `${c} 타입 불일치: ${m[`nutrition_data.${c}`]} vs ${m[`nutrition_data_crowd.${c}`]}`);
    }
  });

  await t('§3-c basis_stored 가 NOT NULL 이다 (기준 모르는 값을 저장하면 통합이 거짓말한다)', async () => {
    const r = await db.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'nutrition_data_crowd' AND column_name = 'basis_stored'`);
    assert.strictEqual(r.rows[0].is_nullable, 'NO', 'basis_stored 는 NOT NULL 이어야 한다');
    const msg = await rejected(db,
      `INSERT INTO nutrition_data_crowd (product_id, calories) VALUES ($1, 1)`, [pidMig]);
    assert.ok(msg, 'basis_stored 없이 행이 들어갔다 — 기준 모르는 값이 뷰로 새어 나간다');
  });

  await t('§3-d uq_ndc_product — 한 제품에 승인된 제보 영양은 최대 1행', async () => {
    const r = await db.query(
      `SELECT count(*)::int AS n FROM nutrition_data_crowd WHERE product_id = $1`, [pidMig]);
    assert.strictEqual(r.rows[0].n, 1, '026 이관 결과가 1행이 아니다');
    const msg = await rejected(db,
      `INSERT INTO nutrition_data_crowd (product_id, basis_stored) VALUES ($1, 'per_100g')`, [pidMig]);
    assert.ok(msg, '같은 product_id 로 두 번째 행이 들어갔다 — 뷰가 행을 증식시킨다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§10  026 이관 — 옮기고 · 지우고 · candidate 로 올렸는가');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§10 제보 행이 nutrition_data 에서 사라지고 crowd 에 «값 그대로» 옮겨졌다', async () => {
    const left = await db.query(
      `SELECT count(*)::int AS n FROM nutrition_data WHERE data_source = 'ocr_crowdsource'`);
    assert.strictEqual(left.rows[0].n, 0, '공공 테이블에 제보 행이 남아 있다 — 분리가 안 됐다');
    const r = await db.query(
      `SELECT calories, sodium, serving_size, ocr_confidence, basis_original, basis_stored,
              convert_factor, applied_by
         FROM nutrition_data_crowd WHERE product_id = $1`, [pidMig]);
    assert.strictEqual(r.rows.length, 1, '이관된 행이 없다');
    const row = r.rows[0];
    assert.strictEqual(Number(row.calories), 123, `값이 바뀌었다: calories=${row.calories}`);
    assert.strictEqual(Number(row.sodium), 456, `값이 바뀌었다: sodium=${row.sodium}`);
    assert.strictEqual(row.serving_size, '100g', 'serving_size(basis 마커)가 승계되지 않았다');
    assert.strictEqual(Number(row.ocr_confidence), 90);
    assert.strictEqual(row.basis_stored, 'as_stored',
      "이관은 환산이 아니다 — 'per_100g' 로 «추정»해서 적으면 안 된다");
    assert.strictEqual(row.basis_original, 'as_stored');
    assert.strictEqual(Number(row.convert_factor), 1,
      '이관은 환산이 아니므로 convert_factor 는 1.0 이다');
    assert.strictEqual(row.applied_by, 'migration_026');
  });

  await t('§10-b pending 제보만 candidate 로 올라간다 (처리된 제보를 큐에 되살리지 않는다)', async () => {
    const r = await db.query(
      `SELECT cr.contribution_id, cr.axis, cr.status, c.status AS contrib_status
         FROM contribution_review cr JOIN contributions c USING (contribution_id)
        WHERE cr.product_id = $1 ORDER BY cr.review_id`, [pidMig]);
    assert.strictEqual(r.rows.length, 1,
      `candidate 가 ${r.rows.length} 건이다. pending 1건만 올라와야 한다 `
      + '(verified 제보까지 올리면 검토 큐가 이미 끝난 일로 찬다)');
    assert.strictEqual(r.rows[0].status, 'candidate');
    assert.strictEqual(r.rows[0].axis, 'nutrition');
    assert.strictEqual(r.rows[0].contrib_status, 'pending');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§7~§8  DB 가 「전량 수동」과 「축당 1건」을 강제하는가');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§7 ★ cr_approve_human_chk — reviewed_by 없는 approved 를 DB 가 거부한다 (DS-1)', async () => {
    const msg = await rejected(db,
      `INSERT INTO contribution_review (contribution_id, product_id, axis, status)
       VALUES ($1, $2, 'ingredients', 'approved')`, [cidPending, pidMig]);
    assert.ok(msg,
      '사람 없이 approved 가 들어갔다 — 코드 버그나 자동 승인 배치가 그대로 통과한다(DS-1 붕괴)');
    // 되돌려 확인: reviewed_by 를 채우면 들어간다 (제약이 「전부 막는 것」이 아님을 단정)
    await db.query(
      `INSERT INTO contribution_review (contribution_id, product_id, axis, status, reviewed_by)
       VALUES ($1, $2, 'ingredients', 'approved', 'admin@meokseon')`, [cidPending, pidMig]);
    const ok = await db.query(
      `SELECT count(*)::int AS n FROM contribution_review
        WHERE product_id = $1 AND axis = 'ingredients' AND status = 'approved'`, [pidMig]);
    assert.strictEqual(ok.rows[0].n, 1, 'reviewed_by 를 채워도 안 들어간다 — 제약이 과하다');
  });

  await t('§7-b UPDATE 로 몰래 approved 로 바꾸는 것도 거부한다', async () => {
    const ins = await db.query(
      `INSERT INTO contribution_review (contribution_id, product_id, axis, status)
       VALUES ($1, $2, 'additives', 'candidate') RETURNING review_id`, [cidPending, pidMig]);
    const rid = ins.rows[0].review_id;
    const msg = await rejected(db,
      `UPDATE contribution_review SET status = 'approved' WHERE review_id = $1`, [rid]);
    assert.ok(msg, 'UPDATE 경로로 reviewed_by 없이 approved 가 됐다 — CHECK 는 UPDATE 에도 걸려야 한다');
  });

  await t('§8 ★ uq_cr_approved_per_product_axis — 같은 (제품, 축)의 두 번째 approved 를 거부한다', async () => {
    const msg = await rejected(db,
      `INSERT INTO contribution_review (contribution_id, product_id, axis, status, reviewed_by)
       VALUES ($1, $2, 'ingredients', 'approved', 'admin2@meokseon')`, [cidPending, pidMig]);
    assert.ok(msg,
      '한 제품의 한 축에 approved 가 둘이 됐다 — 뷰 1:1 조인의 전제가 깨진다');
  });

  await t('§8-b 그러나 candidate 는 몇 건이든 쌓인다 (큐이므로 그것이 맞다)', async () => {
    await db.query(
      `INSERT INTO contribution_review (contribution_id, product_id, axis, status)
       VALUES ($1, $2, 'ingredients', 'candidate')`, [cidPending, pidMig]);
    await db.query(
      `INSERT INTO contribution_review (contribution_id, product_id, axis, status)
       VALUES ($1, $2, 'ingredients', 'candidate')`, [cidPending, pidMig]);
    const r = await db.query(
      `SELECT count(*)::int AS n FROM contribution_review
        WHERE product_id = $1 AND axis = 'ingredients' AND status = 'candidate'`, [pidMig]);
    assert.strictEqual(r.rows[0].n, 2,
      'partial unique 가 candidate 까지 막고 있다 — 검토 큐가 1건밖에 못 쌓인다');
  });

  await t('§8-c 다른 축이면 같은 제품에도 approved 가 들어간다 (축이 독립이다)', async () => {
    await db.query(
      `INSERT INTO contribution_review (contribution_id, product_id, axis, status, reviewed_by)
       VALUES ($1, $2, 'allergens', 'approved', 'admin@meokseon')`, [cidPending, pidMig]);
    const r = await db.query(
      `SELECT count(*)::int AS n FROM contribution_review
        WHERE product_id = $1 AND status = 'approved'`, [pidMig]);
    assert.strictEqual(r.rows[0].n, 2, '축이 달라도 막혔다 — 영양만 못 믿고 원재료는 멀쩡한 사진이 대부분이다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§9  026 CHECK — 제보가 공공 테이블로 «다시» 못 들어온다');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§9 ★ nutrition_data 에 ocr_crowdsource INSERT 를 DB 가 거부한다 (DS-7 강제)', async () => {
    await db.query(
      `INSERT INTO products (barcode, product_name, data_source)
       VALUES ('S66_CHK', 'CHECK시험', 'ocr_crowdsource')`);
    const p = await pid('S66_CHK');
    const msg = await rejected(db,
      `INSERT INTO nutrition_data (product_id, calories, data_source)
       VALUES ($1, 10, 'ocr_crowdsource')`, [p]);
    assert.ok(msg,
      '제보가 공공 테이블에 다시 들어갔다 — 분리가 코드 규율일 뿐 DB 강제가 아니다(설계 §11-B-5 위험 3)');
  });

  await t('§9-b 그러나 공공 출처는 그대로 들어간다 (제약이 공공을 막지 않는다)', async () => {
    const p = await pid('S66_CHK');
    await db.query(
      `INSERT INTO nutrition_data (product_id, calories, data_source)
       VALUES ($1, 10, 'public_nutrition')`, [p]);
    const r = await db.query(
      `SELECT count(*)::int AS n FROM nutrition_data WHERE product_id = $1`, [p]);
    assert.strictEqual(r.rows[0].n, 1, '공공 데이터까지 막혔다 — 제약이 과하다');
    await db.query('DELETE FROM nutrition_data WHERE product_id = $1', [p]);
  });

  await t('§9-c data_source 가 NULL 인 행은 막지 않는다 (NULL 은 「제보다」가 아니다)', async () => {
    const p = await pid('S66_CHK');
    await db.query(
      `INSERT INTO nutrition_data (product_id, calories, data_source) VALUES ($1, 11, NULL)`, [p]);
    const r = await db.query(
      `SELECT count(*)::int AS n FROM nutrition_data WHERE product_id = $1`, [p]);
    assert.strictEqual(r.rows[0].n, 1, 'data_source NULL 인 행이 거부됐다');
    await db.query('DELETE FROM nutrition_data WHERE product_id = $1', [p]);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§4~§6  뷰 통합 — 필드 단위 · 공공 우선 · 라이선스 오염 없음');
  // ══════════════════════════════════════════════════════════════════════════
  const view = async (barcode) => (await db.query(
    'SELECT * FROM product_nutrition_resolved WHERE barcode = $1', [barcode])).rows;

  // (가) 공공에 칼로리«만», 제보에 나트륨«만» → 둘 다 나와야 한다 (DS-8 「필드 단위」)
  await db.query(
    `INSERT INTO products (barcode, product_name, data_source)
     VALUES ('S66_MERGE', '필드단위통합', 'public_c005')`);
  const pMerge = await pid('S66_MERGE');
  await db.query(
    `INSERT INTO nutrition_data (product_id, calories, sodium, data_source)
     VALUES ($1, 100, NULL, 'public_nutrition')`, [pMerge]);
  await db.query(
    `INSERT INTO nutrition_data_crowd (product_id, calories, sodium, basis_stored, applied_by)
     VALUES ($1, 999, 55, 'per_100g', 'test')`, [pMerge]);

  await t('§4 ★ 필드 단위 통합 — 공공에 칼로리만, 제보에 나트륨만 있으면 «둘 다» 나온다', async () => {
    const rows = await view('S66_MERGE');
    assert.strictEqual(rows.length, 1, `뷰가 ${rows.length}행을 냈다 — 1:1 이어야 한다(행 증식)`);
    assert.strictEqual(Number(rows[0].calories), 100, '공공 칼로리가 안 나왔다');
    assert.strictEqual(Number(rows[0].sodium), 55,
      '공공 행의 «빈 칸»을 제보가 못 채웠다 — 이것이 DS-8 이 말하는 「통합」의 전부다');
  });

  await t('§5 ★ 공공에 값이 있으면 제보가 «덮지 못한다» (U65-6 소멸 — 1회용이 아니라 영구다)', async () => {
    const rows = await view('S66_MERGE');
    assert.strictEqual(Number(rows[0].calories), 100,
      `제보(999)가 공공(100)을 덮었다 — U65-6 이 그대로다. COALESCE 인자 순서가 뒤집혔는지 볼 것`);
    // 「1회용이 아니다」 — 제보를 다시 갱신해도 결과가 안 바뀐다
    await db.query(
      'UPDATE nutrition_data_crowd SET calories = 777 WHERE product_id = $1', [pMerge]);
    const again = await view('S66_MERGE');
    assert.strictEqual(Number(again[0].calories), 100,
      '제보를 다시 쓰면 공공을 덮는다 — 보호가 여전히 «1회용»이다');
  });

  await t('§5-b 통합됐다는 사실은 crowd_merged 가 말한다 (resolved_source 어휘를 늘리지 않았다)', async () => {
    const rows = await view('S66_MERGE');
    assert.strictEqual(rows[0].crowd_merged, true, 'crowd_merged 가 true 가 아니다');
    assert.strictEqual(rows[0].resolved_source, 'public_nutrition',
      `resolved_source 가 '${rows[0].resolved_source}' 다. `
      + "'public_plus_crowd' 같은 «새 값»을 만들면 앱이 어느 분기에도 안 걸린다(조용한 무동작)");
  });

  // (나) 제보«만» 있는 제품 + OFF 매치가 붙어 있는 상황 → 라이선스가 붙으면 «거짓 표시»다
  await db.query(
    `INSERT INTO products (barcode, product_name, data_source)
     VALUES ('S66_CROWDONLY', '제보만있는제품', 'ocr_crowdsource')`);
  const pCrowd = await pid('S66_CROWDONLY');
  await db.query(
    `INSERT INTO openfoodfacts_raw (code, raw, off_snapshot_date)
     VALUES ('S66OFF', '{}'::jsonb, DATE '2026-01-01')`);
  await db.query(
    `INSERT INTO openfoodfacts_nutrition_norm (code, calories, sodium_mg, basis_unit, off_grade)
     VALUES ('S66OFF', 11, 22, 'g', 'A')`);
  await db.query(
    `INSERT INTO openfoodfacts_product_match (product_id, code, decision, identity, product_fingerprint)
     VALUES ($1, 'S66OFF', 'load', 'accept', 'fp-s66')`, [pCrowd]);
  await db.query(
    `INSERT INTO nutrition_data_crowd (product_id, calories, sodium, serving_size, verified_at,
                                       basis_stored, applied_by)
     VALUES ($1, 300, 30, '100ml', TIMESTAMPTZ '2026-08-30 00:00:00+00', 'per_100ml', 'test')`,
    [pCrowd]);

  await t('§6 ★ 제보만 있는 제품에 OFF 라이선스·신뢰도·등급이 «붙지 않는다» (계약 §4-2 (5))', async () => {
    const rows = await view('S66_CROWDONLY');
    assert.strictEqual(rows.length, 1);
    const r = rows[0];
    assert.strictEqual(Number(r.calories), 300, `제보 값이 안 이겼다: ${r.calories}(OFF 는 11)`);
    assert.strictEqual(r.source_license, null,
      `source_license 가 '${r.source_license}' 다. ODbL-1.0 은 「이 값의 출처가 OFF 다」라는 «법적» 표시인데 `
      + '제보 값에 붙으면 거짓 표시다');
    assert.strictEqual(r.confidence, null, `confidence 가 '${r.confidence}' 다 — OFF tier 가 아닌데 low 가 붙었다`);
    assert.strictEqual(r.off_grade, null, `off_grade 가 '${r.off_grade}' 다`);
    assert.strictEqual(r.basis_confident, null, `basis_confident 가 '${r.basis_confident}' 다`);
    assert.strictEqual(r.is_inherited, false, 'is_inherited 가 true 다 — 엔티티 상속이 아니다');
    assert.strictEqual(r.entity_id, null);
  });

  await t('§6-b 제보만 있으면 resolved_source 는 ocr_crowdsource · serving_size·verified_at 이 제보 것', async () => {
    const r = (await view('S66_CROWDONLY'))[0];
    assert.strictEqual(r.resolved_source, 'ocr_crowdsource',
      `resolved_source 가 '${r.resolved_source}' 다 — 종전 어휘(data_source ENUM 라벨)를 그대로 쓴다`);
    assert.strictEqual(r.serving_size, '100ml', `serving_size 가 '${r.serving_size}' 다`);
    assert.ok(r.verified_at instanceof Date || typeof r.verified_at === 'string',
      'verified_at 이 제보 행에서 안 나왔다');
    assert.strictEqual(r.crowd_merged, false, '공공 행이 없는데 crowd_merged 가 true 다');
  });

  await t('§6-c 제보도 공공도 없으면 종전 그대로 OFF tier 로 내려간다 (하위 tier 무회귀)', async () => {
    await db.query(
      `INSERT INTO products (barcode, product_name, data_source)
       VALUES ('S66_OFFONLY', 'OFF만있는제품', 'public_c005')`);
    const p = await pid('S66_OFFONLY');
    await db.query(
      `INSERT INTO openfoodfacts_product_match (product_id, code, decision, identity, product_fingerprint)
       VALUES ($1, 'S66OFF', 'load', 'accept', 'fp-s66b')`, [p]);
    const r = (await view('S66_OFFONLY'))[0];
    assert.strictEqual(Number(r.calories), 11, `OFF 값이 안 나왔다: ${r.calories}`);
    assert.strictEqual(Number(r.sodium), 22, 'off.sodium_mg 매핑이 깨졌다');
    assert.strictEqual(r.resolved_source, 'openfoodfacts');
    assert.strictEqual(r.source_license, 'ODbL-1.0', 'OFF tier 인데 라이선스가 사라졌다 — 회귀다');
    assert.strictEqual(r.confidence, 'low');
    assert.strictEqual(r.off_grade, 'A');
    assert.strictEqual(r.serving_size, '100g');
    assert.strictEqual(r.crowd_merged, false);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§12  ★ 뷰 개정이 기존 24컬럼의 이름·타입·순서를 지켰는가');
  // ══════════════════════════════════════════════════════════════════════════
  await t('§12 기존 컬럼의 이름·타입·순서가 그대로이고 crowd_merged 만 «끝에» 붙었다', async () => {
    const after = (await db.query(
      `SELECT ordinal_position, column_name, data_type
         FROM information_schema.columns
        WHERE table_name = 'product_nutrition_resolved'
        ORDER BY ordinal_position`)).rows;
    assert.strictEqual(after.length, viewColsBefore.length + 1,
      `컬럼 수가 ${viewColsBefore.length} → ${after.length} 다. 정확히 1개(crowd_merged)만 늘어야 한다`);
    for (let i = 0; i < viewColsBefore.length; i += 1) {
      assert.strictEqual(after[i].column_name, viewColsBefore[i].column_name,
        `${i + 1}번째 컬럼이 '${viewColsBefore[i].column_name}' → '${after[i].column_name}' 로 바뀌었다. `
        + '소비자가 productModel.findByBarcode 다 — 순서가 밀리면 값이 조용히 어긋난다');
      assert.strictEqual(after[i].data_type, viewColsBefore[i].data_type,
        `${after[i].column_name} 의 타입이 ${viewColsBefore[i].data_type} → ${after[i].data_type} 로 바뀌었다`);
    }
    const last = after[after.length - 1];
    assert.strictEqual(last.column_name, 'crowd_merged', `마지막 컬럼이 ${last.column_name} 다`);
    assert.strictEqual(last.data_type, 'boolean', `crowd_merged 가 boolean 이 아니다: ${last.data_type}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§11  ★★ 멱등 — 023~026 을 연속 2회 적용해도 죽지 않는가');
  // ══════════════════════════════════════════════════════════════════════════
  // `real-postgres` job 이 `npm run migrate` 를 **2회** 돌린다. 여기서 죽으면 CI 가 빨강이다.
  const beforeReview = (await db.query('SELECT count(*)::int AS n FROM contribution_review')).rows[0].n;
  const beforeCrowd = (await db.query('SELECT count(*)::int AS n FROM nutrition_data_crowd')).rows[0].n;

  await t('§11 023~026 재적용이 오류 없이 끝난다 (ADD CONSTRAINT · INSERT 전부 멱등)', async () => {
    for (const f of NEW_MIGRATIONS) {
      try {
        await db.exec(readSql(f));
      } catch (e) {
        throw new Error(`${f} 2회차 적용이 죽었다: ${e.message}`);
      }
    }
  });

  await t('§11-b 재적용이 candidate 를 «두 번» 만들지 않는다 (NOT EXISTS 가드)', async () => {
    const n = (await db.query('SELECT count(*)::int AS n FROM contribution_review')).rows[0].n;
    assert.strictEqual(n, beforeReview,
      `contribution_review 가 ${beforeReview} → ${n} 로 늘었다. `
      + '026 묶음 3 에 ON CONFLICT 가 없으므로 NOT EXISTS 가드가 멱등의 «전부»다');
  });

  await t('§11-c 재적용이 crowd 행을 늘리지도 값을 바꾸지도 않는다', async () => {
    const n = (await db.query('SELECT count(*)::int AS n FROM nutrition_data_crowd')).rows[0].n;
    assert.strictEqual(n, beforeCrowd, `nutrition_data_crowd 가 ${beforeCrowd} → ${n} 로 늘었다`);
    const r = await db.query(
      'SELECT calories FROM nutrition_data_crowd WHERE product_id = $1', [pMerge]);
    assert.strictEqual(Number(r.rows[0].calories), 777,
      '2회차가 기존 crowd 행을 덮어썼다 — ON CONFLICT DO NOTHING 이 DO UPDATE 로 바뀌었는지 볼 것');
  });

  await t('§11-d 재적용 후에도 뷰 컬럼 수가 그대로다 (CREATE OR REPLACE 가 컬럼을 늘리지 않는다)', async () => {
    const n = (await db.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'product_nutrition_resolved'`)).rows[0].n;
    assert.strictEqual(n, viewColsBefore.length + 1, `뷰 컬럼이 ${n} 개다`);
  });

  await t('§11-e 재적용 후에도 CHECK 가 살아 있다 (제약이 하나만 있고 중복 생성이 아니다)', async () => {
    const r = await db.query(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'nutrition_data_no_crowd_chk'`);
    assert.strictEqual(r.rows[0].n, 1, `nutrition_data_no_crowd_chk 가 ${r.rows[0].n} 개다`);
    const p = await pid('S66_CHK');
    const msg = await rejected(db,
      `INSERT INTO nutrition_data (product_id, calories, data_source)
       VALUES ($1, 12, 'ocr_crowdsource')`, [p]);
    assert.ok(msg, '2회차 이후 CHECK 가 무력해졌다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§13  ★★ 체인 전체 2회차 — baseline 이 25컬럼 뷰를 되돌리려다 죽지 않는가');
  // ══════════════════════════════════════════════════════════════════════════
  // ⛔ 이것은 §11(023~026 재적용)과 «다른» 것이다. §11 은 새 4개만 다시 돌리지만,
  //   `npm run migrate` 2회차는 **`000_baseline.sql` 부터** 다시 돈다.
  //   baseline 안에도 같은 이름의 `CREATE OR REPLACE VIEW`(24컬럼)가 있어서,
  //   025 가 25컬럼으로 올려놓은 뷰를 24컬럼으로 «되돌리려» 한다
  //   → ERROR: cannot drop columns from view → ON_ERROR_STOP=1 로 체인이 죽는다.
  //   ⇒ `real-postgres` job 의 「마이그레이션 2회차」와 `verify:fresh-schema` 가 둘 다 빨강.
  // ★ 고치는 법: `000_baseline.sql` 의 `CREATE OR REPLACE VIEW product_nutrition_resolved AS`
  //   바로 앞에 `DROP VIEW IF EXISTS product_nutrition_resolved;` 한 줄.
  //   ⚠ 025 안에서는 못 고친다 — baseline 이 025 보다 «먼저» 돌기 때문이다.
  await t('§13 baseline → 023~026 → baseline 이 오류 없이 다시 선다 (체인 2회차 방어)', async () => {
    const db2 = new PGlite();
    try {
      await db2.exec(fs.readFileSync(BASELINE, 'utf8'));
      for (const f of NEW_MIGRATIONS) await db2.exec(readSql(f));
      try {
        await db2.exec(fs.readFileSync(BASELINE, 'utf8'));
      } catch (e) {
        throw new Error(
          `000_baseline.sql 2회차가 죽었다: ${e.message}\n`
          + '     ⇒ baseline 의 CREATE OR REPLACE VIEW product_nutrition_resolved AS 바로 앞에\n'
          + '        DROP VIEW IF EXISTS product_nutrition_resolved;\n'
          + '        한 줄을 넣을 것. (CASCADE 금지 — 의존 객체를 조용히 지운다)');
      }
      // baseline 이 24컬럼으로 되돌려 놓았어도, 025 가 다시 25컬럼으로 올릴 수 있어야 한다.
      for (const f of NEW_MIGRATIONS) await db2.exec(readSql(f));
      const n = (await db2.query(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_name = 'product_nutrition_resolved'`)).rows[0].n;
      assert.strictEqual(n, viewColsBefore.length + 1,
        `2회차 뒤 뷰 컬럼이 ${n} 개다 — crowd_merged 가 다시 안 붙었다`);
    } finally {
      await db2.close();
    }
  });

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
