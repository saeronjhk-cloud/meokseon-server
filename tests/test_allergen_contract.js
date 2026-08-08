/**
 * test_allergen_contract.js — 세션48 알레르기 **응답 계약** 회귀
 * ==========================================================================
 * ★★★ 이 파일이 왜 있는가
 *
 *   기존 검사는 `allergens_flat_complete` 를 **소스 문자열 정규식**으로 봤다:
 *       /^\s*allergens_flat_complete:[\s\S]{0,200}mayContain\.length === 0/m
 *   4차 검증이 실측한 결과, 아래 뮤테이션이 **전부 59/0 초록**을 통과했다:
 *       "true || …mayContain.length === 0"   (항상 true)
 *       "false && …mayContain.length === 0"  (항상 false)
 *       피연산자 순서만 교환                 (실제 응답은 TypeError → 전건 500)
 *   정규식은 「그 글자가 그 근처에 있는가」만 볼 뿐 **무엇이 나오는지**를 보지 않는다.
 *
 *   → 이 파일은 소스를 한 줄도 읽지 않는다.
 *     pglite 에 입력 클래스별 행을 **실제로 심고**
 *     `productService.getProductWithTrafficLight()` 를 **실제로 불러 나온 응답 객체**만 본다.
 *
 * ── 계약 (현행) ────────────────────────────────────────────────────────────
 *   ① allergens_available === false  →  allergens · allergens_v2 는 **null**
 *   ② allergens_available === true && allergens.length === 0
 *        →  allergens_flat_complete 를 볼 것 (false 면 「없음」이라고 말하면 안 된다)
 *   ③ allergens_v2 = { contains[], inferred[], mayContain[] },
 *      flat(allergens) 에는 **contains + inferred 만** 들어간다
 *   ④ null 은 undefined 와 같이 falsy → 구버전 앱의 `data.allergens || []` 가 그대로 동작
 *
 * ── ★ 금지 상태 (하나라도 나오면 계약 위반) ─────────────────────────────────
 *   F1  available === false  &&  allergens 가 배열       ← 「확인했고 없음」으로 읽힌다
 *   F2  available === false  &&  flat_complete === true  ← **현재 코드가 이것을 낸다**
 *   F3  mayContain 이 비어있지 않은데 flat_complete === true
 *   F4  allergens 가 배열인데 allergens_v2 가 null
 *   F5  contains/inferred 의 이름이 flat 에 없다          ← 경고 소실
 *   F6  mayContain 의 이름이 flat 에 있다                 ← 구버전이 붉게 표시 = 거짓 경고
 *   F7  available === true 인데 3구획이 전부 비었다       ← 「확인했고 없음」 상태의 재발
 *
 *   ★ F1~F7 중 **아직 안 고친 것**은 KNOWN_VIOLATIONS 대장에 있다.
 *     · 대장에 없는 위반이 나오면          → 실패 (회귀)
 *     · 대장에 있는데 이제 안 나오면       → 실패 (고쳐졌으니 대장에서 지워라)
 *     · 대장에 있고 그대로면               → 「미해결 결함」으로 보고 (기본 실행 EXIT 0)
 *
 * ── 실행 ──────────────────────────────────────────────────────────────────
 *   NODE_ENV=test node tests/test_allergen_contract.js
 *   NODE_ENV=test ALLERGEN_STRICT=1 node tests/test_allergen_contract.js
 *       → 대장의 미해결 결함도 실패로 센다. **고친 뒤 이 모드가 초록이어야 한다.**
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ══════════════════════════════════════════════════════════════════════════
// 0. 출력
// ══════════════════════════════════════════════════════════════════════════
let pass = 0;
let fail = 0;
const failures = [];
const expectedIssues = [];
const pendings = [];

async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, message: e.message });
    console.log(`  ❌ ${name}\n     → ${e.message}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

// ══════════════════════════════════════════════════════════════════════════
// 1. 입력 클래스 — 전부 pglite 에 실제로 심는다
// ══════════════════════════════════════════════════════════════════════════
/**
 * rows: [{ name, level }] — `product_allergens` 에 그대로 INSERT 되는 **원본** 이름이다.
 *   ★ 정본 19종으로 미리 정리하지 않는다. 운영 `product_allergens` 에는
 *     `계란`·`조개류(굴)`·`밀(성분)` 같은 오염 이름이 5,649행 중 705행(12.5%) 들어 있고,
 *     `productModel.getAllergens` 가 노출 직전에 `normalizeAllergenRows` 로 정규화한다.
 *     그 정규화가 **무엇을 버리는지**까지 계약의 일부다.
 */
const CLASSES = [
  { id: 'C01_none', label: '0행 (미수집)', barcode: 'ALG0001', rows: [] },
  { id: 'C02_may_only', label: '혼입만 1행', barcode: 'ALG0002', rows: [{ name: '대두', level: 'may_contain' }] },
  { id: 'C03_contains_only', label: '직접함유만', barcode: 'ALG0003', rows: [{ name: '밀', level: 'contains' }] },
  { id: 'C04_inferred_only', label: 'inferred만', barcode: 'ALG0004', rows: [{ name: '우유', level: 'inferred' }] },
  {
    id: 'C05_mixed', label: '혼입 + 직접함유 혼재', barcode: 'ALG0005',
    rows: [{ name: '밀', level: 'contains' }, { name: '대두', level: 'may_contain' }],
  },
  { id: 'C06_blank', label: '공백 이름만', barcode: 'ALG0006', rows: [{ name: '   ', level: 'contains' }] },
  {
    id: 'C07_unnormalizable', label: '정규화 불가 이름만', barcode: 'ALG0007',
    // '정제소금' 은 19종 별칭 어디에도 붙지 않는다 → normalizeAllergenRows 가 통째로 버린다.
    rows: [{ name: '정제소금', level: 'contains' }],
  },
  {
    id: 'C08_dup_after_norm', label: '정규화하면 중복이 되는 두 행', barcode: 'ALG0008',
    // '계란' 과 '난류' 는 둘 다 '난류(가금류)' 로 정규화된다 → 1건으로 병합돼야 한다.
    rows: [{ name: '계란', level: 'contains' }, { name: '난류', level: 'may_contain' }],
  },
  {
    id: 'C09_partial_drop', label: '일부만 정규화 소실 (살아남는 것 + 버려지는 것)', barcode: 'ALG0009',
    rows: [{ name: '밀', level: 'contains' }, { name: '카카오매스', level: 'contains' }],
  },
  {
    id: 'C10_no_level_column', label: 'evidence_level 컬럼이 없는 DB (42703 폴백)', barcode: 'ALG0010',
    rows: [{ name: '밀', level: 'contains' }, { name: '대두', level: 'may_contain' }],
    special: 'drop_column',
  },
  {
    id: 'C11_query_throws', label: 'getAllergens 가 throw', barcode: 'ALG0011',
    rows: [{ name: '밀', level: 'contains' }],
    special: 'throw',
  },
  {
    id: 'C12_valid_plus_blank', label: '유효 이름 1개 + 공백 이름 1개', barcode: 'ALG0012',
    // ★ 세션54 A2 에서 **새로 추가한 클래스.** 종전 계약에는 이 조합이 없었다.
    //   C06(공백만)은 A1 으로 collected=false → 4키가 전부 null 이라 가려지고,
    //   C09(유효 + 정규화불가)는 「이름은 읽었지만 19종에 안 붙는」 경우다.
    //   「이름 칸이 아예 비어 있는 행이 유효 행과 섞여 있을 때」는 어느 쪽도 덮지 못했다.
    rows: [{ name: '밀', level: 'contains' }, { name: '   ', level: 'contains' }],
  },
];

// ══════════════════════════════════════════════════════════════════════════
// 2. ★★★ 미해결 계약 위반 대장
// ══════════════════════════════════════════════════════════════════════════
/**
 * 키: `<classId>::<F#>`
 *
 * ── 결함 대장 ─────────────────────────────────────────────────────────────
 *   A1  `allergens_flat_complete: !(allergens && allergens.collected) || allergens.v2.mayContain.length === 0`
 *       (productService.js 응답 조립부)
 *       **미수집일 때 true 를 낸다.** 「flat 이 전부다」라는 뜻인데, 수집한 적이 없으므로
 *       참·거짓을 말할 근거가 아예 없다. 클라이언트가 이 값을 믿고 「알레르기 없음」을 쓰면 과소경고다.
 *       ★ 외부 검토 권고: `!collected ? null : (mayContain.length === 0 && dropped === 0)`
 *         — 「모른다」는 null 로 낸다. §미래계약 블록이 그것을 미리 검사한다.
 *
 *   A2  정규화 소실(dropped)이 flat_complete 에 반영되지 않는다.
 *       `normalizeAllergenRows` 가 19종에 못 붙는 이름을 **조용히 버리는데**,
 *       버린 뒤에도 응답은 `flat_complete: true` = 「flat 이 전부다」라고 말한다.
 *       C09(밀 + 카카오매스)가 그 상태였다. 실측 근거: HACCP 적재 5,649행 중 705행(12.5%)이 비정본 이름.
 *       ✅ 세션54 에 해결됐다. 배선은 3단이다 —
 *          `allergenName.normalizeAllergenRowsWithStats` 가 소실 수를 세고,
 *          `productModel.getAllergens(productId, stats)` 가 선택적 `stats` 로 흘리고,
 *          `productService` 응답 조립이 `mayContain.length === 0 && dropped === 0` 으로 판정한다.
 *       §6 의 C09·C12 단정이 이것을 고정한다. 되돌아가면 그 두 줄이 먼저 빨개진다.
 */
const KNOWN_VIOLATIONS = {
  // ── A1 (F2 · 4건) — ✅ 세션54 에 고쳐져 **대장에서 제거**했다.
  //      제거한 줄: C01_none::F2 · C06_blank::F2 · C07_unnormalizable::F2 · C11_query_throws::F2
  //      productService.js 의 응답 조립이
  //        `!(collected) || mayContain.length === 0`  →  `!(collected) ? null : mayContain.length === 0`
  //      로 바뀌었다. 미수집(0행·이름 전멸·정규화 전멸·조회 실패)일 때 이제 `null` 이 나가므로
  //      `available === false && complete === true`(F2) 가 성립하지 않는다.
  //      ★ 남겨 두면 §2 가 「고쳐졌다」로 실패시킨다 — 그것이 이 대장의 설계다.
  // ── A2 (정규화 소실 dropped 미반영) — ✅ 세션54 에 고쳐졌다.
  //      A2 는 원래 F1~F7 어디에도 걸리지 않아 이 대장에 줄이 없었다(F3 는 mayContain 만 본다).
  //      그래서 §6 의 C09·C12 단정이 A2 의 회귀 검사다. 대장이 아니라 거기를 볼 것.
};

// ══════════════════════════════════════════════════════════════════════════
// 3. 금지 상태 검사기 — **응답 객체만** 본다
// ══════════════════════════════════════════════════════════════════════════
function checkForbidden(res) {
  const hits = [];
  const push = (id, msg) => hits.push({ id, msg });

  const av = res.allergens_available;
  const flat = res.allergens;
  const v2 = res.allergens_v2;
  const complete = res.allergens_flat_complete;

  if (av === false && Array.isArray(flat)) {
    push('F1', `available=false 인데 allergens 가 배열(${JSON.stringify(flat)})이다 — `
      + '클라이언트는 이것을 「확인했고 알레르겐 없음」으로 읽는다(짜왕 사고와 같은 형태)');
  }
  if (av === false && complete === true) {
    push('F2', 'available=false 인데 flat_complete=true 다 — '
      + '「정보가 없다」와 「flat 이 전부다」를 동시에 주장한다. 모르는 것은 모른다고(null) 해야 한다');
  }
  if (v2 && Array.isArray(v2.mayContain) && v2.mayContain.length > 0 && complete === true) {
    push('F3', `mayContain=${JSON.stringify(v2.mayContain)} 인데 flat_complete=true 다 — `
      + 'flat 에 없는 경고가 있는데 「flat 이 전부」라고 말한다(과소경고)');
  }
  if (Array.isArray(flat) && v2 === null) {
    push('F4', 'allergens 는 배열인데 allergens_v2 가 null 이다 — 두 키가 서로 다른 이야기를 한다');
  }
  if (v2 && Array.isArray(flat)) {
    for (const n of [...(v2.contains || []), ...(v2.inferred || [])]) {
      if (!flat.includes(n)) {
        push('F5', `「${n}」 이 v2(contains/inferred)에 있는데 flat 에 없다 — 구버전 앱에서 경고가 사라진다`);
      }
    }
    for (const n of v2.mayContain || []) {
      if (flat.includes(n)) {
        push('F6', `혼입 「${n}」 이 flat 에 있다 — 등급을 모르는 구버전 앱이 「직접 함유」로 붉게 표시한다(거짓 경고)`);
      }
    }
  }
  if (av === true && v2
      && (v2.contains || []).length === 0 && (v2.inferred || []).length === 0
      && (v2.mayContain || []).length === 0) {
    push('F7', 'available=true 인데 3구획이 전부 비었다 — '
      + '「확인했고 알레르겐 없음」 상태다. 음성 증거를 기록하는 행·컬럼·코드가 시스템에 없으므로 '
      + '이 상태는 만들어질 수 없다(만들어졌다면 available 판정이 잘못된 것이다)');
  }
  return hits;
}

/** 4키를 표 한 줄로 */
function row4(id, label, res) {
  const s = (v) => (v === null ? 'null' : v === undefined ? '(없음)' : JSON.stringify(v));
  const v2 = res.allergens_v2;
  const v2s = v2 === null ? 'null'
    : `C${JSON.stringify(v2.contains)} I${JSON.stringify(v2.inferred)} M${JSON.stringify(v2.mayContain)}`;
  return `  ${id.padEnd(22)} avail=${String(res.allergens_available).padEnd(5)} `
    + `complete=${String(res.allergens_flat_complete).padEnd(5)} flat=${s(res.allergens).padEnd(14)} v2=${v2s}`
    + `\n  ${''.padEnd(22)} ${label}`;
}

// ══════════════════════════════════════════════════════════════════════════
const SRV = path.join(__dirname, '..');
const BASELINE = path.join(SRV, 'scripts', 'migrations', '000_baseline.sql');
const MIGRATION_020 = path.join(SRV, 'scripts', 'migrations', '020_allergen_evidence_level.sql');

// 020 의 결과물만 정확히 되돌린다(손으로 적은 축소 스키마가 아니다).
const ROLLBACK_020 = `
  DROP INDEX IF EXISTS idx_product_allergens_level;
  ALTER TABLE product_allergens DROP CONSTRAINT IF EXISTS product_allergens_evidence_level_chk;
  ALTER TABLE product_allergens DROP COLUMN IF EXISTS evidence_level;
`;

async function main() {
  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (_) {
    console.log('⏭  pglite 미설치 — 응답 계약을 실행 검증할 수 없다 (npm i -D @electric-sql/pglite)');
    console.log('   ★ 「건너뜀」은 「통과」가 아니다. EXIT=1 로 남긴다.');
    process.exit(1);
  }

  // ── pglite 인스턴스 **1개**. 부팅(약 2.5초)이 이 파일 시간의 대부분이다.
  const db = new PGlite();
  try {
    await db.exec(fs.readFileSync(BASELINE, 'utf8'));
  } catch (e) {
    console.error(`000_baseline.sql 적용 실패 — 픽스처가 아니라 정본 SQL 문제다: ${e.message}`);
    process.exit(1);
  }

  const realQuery = db.query.bind(db);
  let queryHook = null;               // (text, params) => Promise | null

  const shim = {
    pool: null,
    query: (text, params) => {
      if (queryHook) {
        const r = queryHook(text, params);
        if (r) return r;
      }
      return realQuery(text, params || []);
    },
    transaction: async (cb) => {
      await db.exec('BEGIN');
      try {
        const r = await cb({ query: (tx, p) => realQuery(tx, p || []) });
        await db.exec('COMMIT');
        return r;
      } catch (e) { await db.exec('ROLLBACK'); throw e; }
    },
    healthCheck: async () => ({ status: 'healthy' }),
  };
  const dbPath = require.resolve('../src/config/database');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };

  const productService = require('../src/services/productService');
  const productModel = require('../src/models/productModel');
  const { buildAllergens } = productService;

  // ── 픽스처 적재
  for (const c of CLASSES) {
    const r = await realQuery(
      `INSERT INTO products (barcode, product_name, food_type, data_source)
       VALUES ($1, $2, '과자', 'manual_seed') RETURNING product_id`,
      [c.barcode, `계약테스트 ${c.id}`],
    );
    c.productId = r.rows[0].product_id;
    for (const row of c.rows) {
      await realQuery(
        `INSERT INTO product_allergens (product_id, allergen_name, evidence_level, status, detected_via)
         VALUES ($1, $2, $3, 'confirmed', 'haccp_api')`,
        [c.productId, row.name, row.level],
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§0. 전제 — 실제 응답 객체를 얻을 수 있는가');

  await t('★ getProductWithTrafficLight 가 pglite 로 실제 동작한다 (소스 문자열 검사가 아니다)', async () => {
    const res = await productService.getProductWithTrafficLight('ALG0003');
    assert.ok(res && res.product, '응답이 만들어지지 않았다');
    assert.ok('allergens' in res && 'allergens_v2' in res
      && 'allergens_available' in res && 'allergens_flat_complete' in res,
    `알레르기 4키가 응답에 없다: ${Object.keys(res).join(', ')}`);
  });

  await t('★ 정규화가 실제로 이름을 버린다 (C07·C09 픽스처의 전제)', () => {
    const { normalizeAllergenNames } = require('../src/services/allergenName');
    assert.deepStrictEqual(normalizeAllergenNames('정제소금'), [],
      '「정제소금」이 이제 정규화된다 — C07/C09 픽스처를 다른 이름으로 바꿀 것');
    assert.deepStrictEqual(normalizeAllergenNames('카카오매스'), [],
      '「카카오매스」가 이제 정규화된다 — C09 픽스처를 다른 이름으로 바꿀 것');
    assert.strictEqual(normalizeAllergenNames('계란')[0].name, '난류(가금류)');
    assert.strictEqual(normalizeAllergenNames('난류')[0].name, '난류(가금류)');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§1. 입력 클래스별 4키 — 실호출 결과표');

  const results = {};
  const crashed = [];

  for (const c of CLASSES) {
    if (c.special === 'drop_column') {
      // 020 미적용(또는 롤백) DB 재현. 정본 020 을 다시 돌려 복구한다(020 은 멱등).
      await db.exec(ROLLBACK_020);
      productModel._resetEvidenceLevelCache();
    }
    if (c.special === 'throw') {
      queryHook = (text) => (/FROM product_allergens/.test(text)
        ? Promise.reject(Object.assign(new Error('connection terminated unexpectedly'), { code: '08006' }))
        : null);
    }

    let res;
    try {
      res = await productService.getProductWithTrafficLight(c.barcode);
    } catch (e) {
      // ★ 응답 조립 자체가 터진 경우 — 운영에서는 GET /api/products/:barcode 가 **500** 이 된다.
      //   여기서 던지고 끝내면 어느 클래스에서 왜 터졌는지가 사라진다. 기록하고 계속한다.
      crashed.push({ id: c.id, label: c.label, message: e && e.message, stack: (e && e.stack || '').split('\n')[1] });
      res = { __crashed: true, allergens: undefined, allergens_v2: undefined,
        allergens_available: undefined, allergens_flat_complete: undefined };
    } finally {
      if (c.special === 'throw') queryHook = null;
      if (c.special === 'drop_column') {
        await db.exec(fs.readFileSync(MIGRATION_020, 'utf8'));
        // ★ 컬럼을 DROP 하면 값도 함께 사라진다(020 재적용은 DEFAULT 'contains' 로만 채운다).
        //   그래서 픽스처의 등급을 다시 써 넣는다. 이것을 빼면 뒤따르는 클래스가
        //   「전부 contains」인 DB 를 보게 되어 **이 테스트가 조용히 무의미해진다.**
        for (const cc of CLASSES) {
          for (const row of cc.rows) {
            await realQuery(
              `UPDATE product_allergens SET evidence_level = $3
               WHERE product_id = $1 AND allergen_name = $2`,
              [cc.productId, row.name, row.level],
            );
          }
        }
        productModel._resetEvidenceLevelCache();
      }
    }
    results[c.id] = res;
    console.log(res.__crashed
      ? `  ${c.id.padEnd(22)} ‼ 응답 조립이 예외로 실패 (운영이라면 500)\n  ${''.padEnd(22)} ${c.label}`
      : row4(c.id, c.label, res));
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§2. 금지 상태 — 대장(KNOWN_VIOLATIONS)과 대조');

  await t('★★★ 어떤 입력 클래스에서도 응답 조립이 예외로 죽지 않는다', () => {
    assert.strictEqual(crashed.length, 0,
      '\n' + crashed.map((c) => `    [500] ${c.id} (${c.label})\n      ${c.message}\n      at ${c.stack}\n`
        + '      → GET /api/products/:barcode 가 이 입력에서 통째로 실패한다. '
        + '알레르기 키 하나 때문에 제품 정보 전체를 못 주는 것은 심각도가 다르다.').join('\n'));
  });

  await t('★★★ 금지 상태가 대장과 정확히 일치한다 (새 위반 = 회귀 · 사라진 위반 = 고쳐짐)', () => {
    const problems = [];
    const seen = new Set();

    for (const c of CLASSES) {
      if (results[c.id].__crashed) continue;   // 위 검사가 이미 실패로 잡았다
      for (const h of checkForbidden(results[c.id])) {
        const key = `${c.id}::${h.id}`;
        seen.add(key);
        const entry = KNOWN_VIOLATIONS[key];
        if (!entry) {
          problems.push(
            `    [새 계약 위반] ${key}\n`
            + `      ${h.msg}\n`
            + `      응답: avail=${results[c.id].allergens_available} `
            + `complete=${results[c.id].allergens_flat_complete} `
            + `flat=${JSON.stringify(results[c.id].allergens)} `
            + `v2=${JSON.stringify(results[c.id].allergens_v2)}`);
        } else {
          expectedIssues.push({ key, defect: entry.defect, why: entry.why });
        }
      }
    }

    for (const key of Object.keys(KNOWN_VIOLATIONS)) {
      const cls = key.split('::')[0];
      if (results[cls] && results[cls].__crashed) continue;   // 터진 클래스는 「고쳐졌다」가 아니다
      if (!seen.has(key)) {
        problems.push(
          `    [고쳐졌다] ${key} — ${KNOWN_VIOLATIONS[key].why}\n`
          + '      → 이제 위반이 아니다. KNOWN_VIOLATIONS 에서 이 줄을 지울 것. '
          + '남겨 두면 다음 회귀를 못 잡는다.');
      }
    }

    assert.strictEqual(problems.length, 0, `\n${problems.join('\n')}`);
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§3. 계약 ①~④ — 클래스별 단정');

  await t('① available=false 면 allergens · allergens_v2 가 둘 다 null 이다', () => {
    const bad = [];
    for (const c of CLASSES) {
      const r = results[c.id];
      if (r.allergens_available === false) {
        if (r.allergens !== null) bad.push(`${c.id}: allergens=${JSON.stringify(r.allergens)} (null 이어야 한다)`);
        if (r.allergens_v2 !== null) bad.push(`${c.id}: allergens_v2=${JSON.stringify(r.allergens_v2)} (null 이어야 한다)`);
      }
    }
    assert.strictEqual(bad.length, 0, `\n    ${bad.join('\n    ')}`);
  });

  await t('② 「혼입만 있는 제품」은 available=true · flat=[] · flat_complete=false 로 구분된다', () => {
    const r = results.C02_may_only;
    assert.strictEqual(r.allergens_available, true,
      '혼입 정보를 가진 제품이 「정보 없음」으로 나간다 — 경고가 통째로 사라진다');
    assert.deepStrictEqual(r.allergens, [], 'flat 에 혼입이 섞였다(구버전이 붉게 표시한다)');
    assert.deepStrictEqual(r.allergens_v2.mayContain, ['대두']);
    assert.strictEqual(r.allergens_flat_complete, false,
      '★ flat 이 비었는데 flat_complete=true 다 — 클라이언트가 「알레르기 없음」이라고 쓴다(짜왕 사고)');
  });

  await t('③ allergens_v2 는 3구획 배열이고 flat = contains + inferred 다', () => {
    const bad = [];
    for (const c of CLASSES) {
      const v2 = results[c.id].allergens_v2;
      if (v2 === null) continue;
      for (const k of ['contains', 'inferred', 'mayContain']) {
        if (!Array.isArray(v2[k])) bad.push(`${c.id}: allergens_v2.${k} 가 배열이 아니다(${JSON.stringify(v2[k])})`);
      }
      const want = [...new Set([...(v2.contains || []), ...(v2.inferred || [])])].sort();
      const got = [...(results[c.id].allergens || [])].sort();
      if (JSON.stringify(want) !== JSON.stringify(got)) {
        bad.push(`${c.id}: flat=${JSON.stringify(got)} 인데 contains+inferred=${JSON.stringify(want)} 다`);
      }
    }
    assert.strictEqual(bad.length, 0, `\n    ${bad.join('\n    ')}`);
  });

  await t('④ null 은 undefined 와 같이 falsy — 구버전 `data.allergens || []` 가 그대로 동작한다', () => {
    for (const c of CLASSES) {
      const r = results[c.id];
      assert.ok(r.allergens === null || Array.isArray(r.allergens),
        `${c.id}: allergens 가 null 도 배열도 아니다(${typeof r.allergens})`);
      assert.deepStrictEqual(r.allergens || [], Array.isArray(r.allergens) ? r.allergens : [],
        `${c.id}: 구버전 폴백이 깨진다`);
      // 빈 배열이면 안 되는 이유: `[] || []` 는 `[]` 라 falsy 판정이 안 된다 = 「확인했고 없음」.
      if (r.allergens_available === false) {
        assert.notStrictEqual(JSON.stringify(r.allergens), '[]',
          `${c.id}: 미수집인데 빈 배열이다 — 구버전은 이것을 「알레르겐 없음」으로 표시한다`);
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§4. 클래스별 의미 단정 (정규화 · 폴백 · 실패)');

  await t('C03/C04 — 직접함유·원재료추정은 flat 에 들어간다 (실제로 들어 있는 원료다)', () => {
    assert.deepStrictEqual(results.C03_contains_only.allergens, ['밀']);
    assert.deepStrictEqual(results.C03_contains_only.allergens_v2.contains, ['밀']);
    assert.deepStrictEqual(results.C04_inferred_only.allergens, ['우유']);
    assert.deepStrictEqual(results.C04_inferred_only.allergens_v2.inferred, ['우유']);
    assert.strictEqual(results.C04_inferred_only.allergens_flat_complete, true,
      '혼입이 없는데 flat_complete 가 false 다');
  });

  await t('C05 — 혼입과 직접함유가 섞이면 flat 에는 직접함유만, complete=false', () => {
    const r = results.C05_mixed;
    assert.deepStrictEqual(r.allergens, ['밀']);
    assert.deepStrictEqual(r.allergens_v2.mayContain, ['대두']);
    assert.strictEqual(r.allergens_flat_complete, false,
      'flat 밖에 경고(대두 혼입)가 있는데 「flat 이 전부」라고 말한다');
  });

  await t('★★ C06/C07 — 이름을 읽지 못한 것을 「알레르겐 없음」으로 내보내지 않는다', () => {
    for (const id of ['C06_blank', 'C07_unnormalizable']) {
      const r = results[id];
      assert.strictEqual(r.allergens_available, false,
        `${id}: 행은 있는데 이름을 하나도 못 읽었다. 그것은 「없음」이 아니라 「읽지 못했다」다`);
      assert.strictEqual(r.allergens, null, `${id}: 빈 배열이 「확인했고 없음」으로 읽힌다`);
    }
  });

  await t('★ C08 — 정규화 후 같은 이름이 되는 두 행이 1건으로 병합되고 강한 등급이 남는다', () => {
    const r = results.C08_dup_after_norm;
    assert.deepStrictEqual(r.allergens_v2.contains, ['난류(가금류)'],
      `계란(contains) + 난류(may_contain) 이 1건 contains 로 병합되어야 한다: ${JSON.stringify(r.allergens_v2)}`);
    assert.deepStrictEqual(r.allergens_v2.mayContain, [],
      '같은 알레르겐이 contains 와 mayContain 양쪽에 나온다 — 화면에 모순된 두 줄이 뜬다');
    assert.deepStrictEqual(r.allergens, ['난류(가금류)']);
    assert.strictEqual(r.allergens_flat_complete, true);
  });

  await t('★ C09 — 정규화에 성공한 이름은 살아남는다 (일부 실패가 전체를 죽이지 않는다)', () => {
    const r = results.C09_partial_drop;
    assert.strictEqual(r.allergens_available, true, '한 이름이 정규화에 실패했다고 전부 버려졌다');
    assert.deepStrictEqual(r.allergens, ['밀']);
  });

  await t('★★ C12 — 유효 이름 옆에 공백 이름이 섞여 있으면 flat_complete=false 다 (세션54 신규)', () => {
    // ── 이 클래스의 기대값을 이렇게 정한 근거 (세션54) ──────────────────────
    //   ① 계약의 정의상 그렇다. `dropped` 는 「19종 어디에도 못 붙어 사라진 원본 행의 수」다.
    //      이름 칸이 공백인 행은 붙을 이름 자체가 없어 사라진다 — 읽지 못하고 버린 행이다.
    //   ② 이 저장소의 제1원칙(과소경고 > 과잉경고 위험, 애매하면 살리는 쪽)에 맞다.
    //      `false` 는 「알레르겐이 더 있다」가 아니라 「flat 이 전부라고 단정하지 말라」는 신호다.
    //   ③ 「false 남발로 신호가 무뎌진다」는 반대 논거는 **실측으로 기각됐다.**
    //      · `allergen_name` 은 VARCHAR NOT NULL — NULL 이 들어갈 수 없다.
    //      · 실행 중 `product_allergens` 에 쓰는 곳은 mergeService 한 곳이고,
    //        그 입력을 만드는 `unionAllergens` 가 `if (v) names.add(v)` 로 공백을 버린다.
    //      · HACCP 적재 경로의 `parseAllergy` 를 실제 덤프(scripts/output/haccp_dump.ndjson,
    //        14,682줄 / alg 보유 6,195건)에 그대로 돌려 이름 19,489건을 얻었는데
    //        **공백 0건**, distinct 는 정확히 정본 19종이었다.
    //      → 공백 행은 사실상 발생하지 않는다. 세는 비용이 0 에 가깝다.
    //   ⚠ 운영 DB 직접 집계는 못 했다 — 샌드박스에서 DNS 가 막혀 있다(EAI_AGAIN).
    const r = results.C12_valid_plus_blank;
    assert.strictEqual(r.allergens_available, true,
      '유효 이름 「밀」을 읽었는데 「정보 없음」으로 나간다 — 경고가 통째로 사라진다');
    assert.deepStrictEqual(r.allergens, ['밀'], '공백 행 하나 때문에 유효 이름까지 버려졌다');
    assert.deepStrictEqual(r.allergens_v2.mayContain, []);
    assert.strictEqual(r.allergens_flat_complete, false,
      '읽지 못하고 버린 행이 있는데 「flat 이 전부다」라고 단정한다');
  });

  await t('★★ C10 — evidence_level 컬럼이 없어도 죽지 않고, 등급은 contains 로 올려 잡는다', () => {
    const r = results.C10_no_level_column;
    assert.strictEqual(r.allergens_available, true, '컬럼 부재로 알레르기가 통째로 사라졌다');
    assert.deepStrictEqual([...r.allergens].sort(), ['대두', '밀'],
      `42703 폴백에서 행이 사라졌다: ${JSON.stringify(r.allergens)}`);
    assert.deepStrictEqual([...r.allergens_v2.contains].sort(), ['대두', '밀'],
      '등급을 모를 때 약한 쪽(may_contain)으로 떨어뜨리면 경고가 사라진다 — contains 로 올려 잡는 것이 맞다');
    assert.deepStrictEqual(r.allergens_v2.mayContain, []);
  });

  await t('★★ C11 — 조회가 실패해도 응답 전체가 500 이 되지 않고, 「없음」으로도 나가지 않는다', () => {
    const r = results.C11_query_throws;
    assert.strictEqual(r.allergens, null, '조회 실패가 빈 배열로 나간다 — 「확인했고 없음」으로 읽힌다');
    assert.strictEqual(r.allergens_v2, null);
    assert.strictEqual(r.allergens_available, false);
    assert.ok(r.product && r.product.product_id, '알레르기 조회 실패가 제품 응답 전체를 무너뜨렸다');
  });

  await t('★ C10 이후 스키마가 원복돼 다른 클래스에 영향을 주지 않았다', async () => {
    const q = await realQuery(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='product_allergens' AND column_name='evidence_level'`);
    assert.strictEqual(q.rows.length, 1, 'evidence_level 컬럼이 복구되지 않았다 — 020 재적용이 실패했다');
    const again = await productService.getProductWithTrafficLight('ALG0005');
    assert.deepStrictEqual(again.allergens_v2.mayContain, ['대두'],
      '컬럼 복구 후에도 등급이 살아나지 않는다 — _resetEvidenceLevelCache 가 안 먹었다');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§5. buildAllergens 단위 계약 (응답 조립 이전 단계)');

  // ★ 여기는 DB 없이 부를 수 있는 순수 함수다. 위 §1~§4 가 실경로를 보고,
  //   여기서는 **호출부가 만들 수 없는 입력**(rows 가 null 등)을 마저 덮는다.
  await t('★ rows 가 배열이 아니면 null (빈 3분리를 내면 「조회했더니 없더라」와 구별 불가)', () => {
    assert.strictEqual(buildAllergens(null), null);
    assert.strictEqual(buildAllergens(undefined), null);
    assert.strictEqual(buildAllergens('문자열'), null);
  });

  await t('★ collected 는 행 수가 아니라 **유효 이름 수**다', () => {
    assert.strictEqual(buildAllergens([]).collected, false);
    assert.strictEqual(buildAllergens([{ allergen_name: '   ', evidence_level: 'contains' }]).collected, false);
    assert.strictEqual(buildAllergens([{ allergen_name: null, evidence_level: 'contains' }]).collected, false);
    assert.strictEqual(buildAllergens([{ allergen_name: '대두', evidence_level: 'may_contain' }]).collected, true,
      '혼입만 있어도 「수집됨」이다 — flat 이 비는 것과 정보가 없는 것은 다르다');
  });

  await t('★ 등급을 모르는 행(NULL·오타값)은 contains 로 올려 잡는다 (약하게 만들지 않는다)', () => {
    assert.deepStrictEqual(buildAllergens([{ allergen_name: '메밀', evidence_level: null }]).v2.contains, ['메밀']);
    assert.deepStrictEqual(buildAllergens([{ allergen_name: '메밀', evidence_level: 'maycontain' }]).v2.contains, ['메밀']);
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§6. ★ 미래 계약 (외부 검토 권고) — 구현되면 자동으로 활성화된다');

  /**
   * 권고안 (아직 구현 안 됨):
   *   allergens_flat_complete = !collected ? null : (mayContain.length === 0 && dropped === 0)
   *   allergen_result: { status: 'unavailable'|'available',
   *                      contains, inferred, may_contain,
   *                      data_quality: 'verified'|'partial'|'unknown' }
   *   ★ 「확인했고 없음」 상태는 만들지 않는다 — 음성 증거가 시스템에 없다.
   *
   * ★ 아래 블록은 **응답에 그 키가 나타나면 자동으로 실제 검사로 바뀐다.**
   *   지금은 PENDING 으로만 보고한다(초록도 빨강도 아니다).
   */
  const sample = results.C01_none;

  await t('[미래] flat_complete 가 미수집일 때 null 이면 A1 이 해결된 것이다', () => {
    if (sample.allergens_flat_complete === null) {
      // 구현됨 → 실제 계약으로 검사한다.
      for (const id of ['C01_none', 'C06_blank', 'C07_unnormalizable', 'C11_query_throws']) {
        assert.strictEqual(results[id].allergens_flat_complete, null,
          `${id}: 미수집인데 flat_complete 가 null 이 아니다 — 부분 구현이다`);
      }
      for (const id of ['C03_contains_only', 'C04_inferred_only']) {
        assert.strictEqual(results[id].allergens_flat_complete, true, `${id}: 수집됐고 혼입이 없으면 true 여야 한다`);
      }
      assert.strictEqual(results.C09_partial_drop.allergens_flat_complete, false,
        'C09: 정규화 소실(dropped>0)이 있는데 flat_complete=true 다 — dropped 를 세지 않는다(A2)');
      // 세션54 신규 — 공백 이름 행도 「읽지 못하고 버린 행」이다(근거는 §4 의 C12 검사 주석).
      assert.strictEqual(results.C12_valid_plus_blank.allergens_flat_complete, false,
        'C12: 공백 이름 행이 버려졌는데 flat_complete=true 다 — 버린 행을 세지 않는다(A2)');
    } else {
      pendings.push('A1 미구현 — flat_complete 가 미수집일 때 true 다 (권고: null)');
      pendings.push('A2 미구현 — 정규화 소실(dropped)이 flat_complete 에 반영되지 않는다 '
        + `(C09: 밀+카카오매스 → flat=${JSON.stringify(results.C09_partial_drop.allergens)} `
        + `complete=${results.C09_partial_drop.allergens_flat_complete})`);
    }
  });

  await t('[미래] allergen_result 가 응답에 있으면 그 형태를 강제한다', () => {
    const withKey = CLASSES.filter((c) => 'allergen_result' in results[c.id]);
    if (withKey.length === 0) {
      pendings.push('allergen_result 미구현 — 응답에 그 키가 없다 (권고: discriminated union)');
      return;
    }
    assert.strictEqual(withKey.length, CLASSES.length,
      `allergen_result 가 일부 클래스에만 있다(${withKey.length}/${CLASSES.length}) — 부분 구현이다`);
    for (const c of CLASSES) {
      const ar = results[c.id].allergen_result;
      assert.ok(ar && typeof ar === 'object', `${c.id}: allergen_result 가 객체가 아니다`);
      assert.ok(['unavailable', 'available'].includes(ar.status),
        `${c.id}: status=${ar.status} — 'unavailable'|'available' 두 값만 허용된다`);
      assert.ok(['verified', 'partial', 'unknown'].includes(ar.data_quality),
        `${c.id}: data_quality=${ar.data_quality}`);
      if (ar.status === 'unavailable') {
        for (const k of ['contains', 'inferred', 'may_contain']) {
          assert.ok(ar[k] === null || ar[k] === undefined,
            `${c.id}: status=unavailable 인데 ${k} 가 값을 갖는다 — 「없음」으로 읽힌다`);
        }
      } else {
        for (const k of ['contains', 'inferred', 'may_contain']) {
          assert.ok(Array.isArray(ar[k]), `${c.id}: ${k} 가 배열이 아니다`);
        }
        const total = ar.contains.length + ar.inferred.length + ar.may_contain.length;
        assert.ok(total > 0,
          `${c.id}: status=available 인데 3구획이 전부 비었다 — `
          + '「확인했고 없음」 상태를 만들지 않기로 한 결정에 어긋난다(음성 증거가 시스템에 없다)');
      }
    }
  });

  await t('★ 「확인했고 알레르겐 없음」 상태가 현재 응답에 존재하지 않는다', () => {
    // 이 단정은 현행·미래 양쪽에 걸린다. F7 과 같은 내용이지만 전 클래스를 한 번에 본다.
    const bad = CLASSES.filter((c) => {
      const r = results[c.id];
      const v2 = r.allergens_v2;
      return r.allergens_available === true && v2
        && (v2.contains || []).length + (v2.inferred || []).length + (v2.mayContain || []).length === 0;
    });
    assert.strictEqual(bad.length, 0,
      `「확인했고 없음」 상태가 나왔다: ${bad.map((c) => c.id).join(', ')} — `
      + '음성 증거를 기록하는 수단이 시스템에 없으므로 이 상태는 만들어질 수 없다');
  });

  await db.close();

  // ══════════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`📊 세션48 알레르기 응답 계약: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})`);

  if (pendings.length > 0) {
    console.log(`\n🕓 PENDING (외부 검토 권고 · 미구현) ${pendings.length}건 — 구현되면 위 §6 이 자동으로 검사한다:`);
    for (const p of pendings) console.log(`   · ${p}`);
  }

  if (expectedIssues.length > 0) {
    console.log(`\n⚠  미해결 계약 위반 ${expectedIssues.length}건 — 대장과 일치한다:`);
    for (const e of expectedIssues) console.log(`   ${e.key} (${e.defect}) — ${e.why}`);
    console.log('   ★ 고친 뒤 ALLERGEN_STRICT=1 이 초록이어야 한다.');
  }

  if (fail > 0) {
    console.log('\n실패 상세:');
    for (const f of failures) console.log(`  - ${f.name}\n    ${f.message}`);
    process.exit(1);
  }

  if (process.env.ALLERGEN_STRICT === '1' && expectedIssues.length > 0) {
    console.log(`\n❌ ALLERGEN_STRICT=1 — 미해결 계약 위반 ${expectedIssues.length}건을 실패로 센다.`);
    process.exit(1);
  }

  console.log('✅ 새 계약 위반 없음 (미해결 결함은 위에 나열)');
}

main().catch((e) => { console.error('예상 못 한 예외:', e); process.exit(1); });
