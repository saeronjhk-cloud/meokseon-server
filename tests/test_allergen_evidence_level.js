/**
 * test_allergen_evidence_level.js — 세션45 알레르기 근거 등급 회귀
 * ==========================================================================
 * 무엇을 고정하나 —
 *   1) 마이그레이션 020 의 **SQL 을 실제로 실행**한다 (pglite = 진짜 Postgres/wasm).
 *      DDL 을 눈으로 읽고 "맞아 보인다" 로 넘기지 않는다. 멱등성·CHECK·기본값을 돌려서 확인한다.
 *   2) mergeService 의 등급 병합이 **낮추지 않는다.**
 *   3) `ON CONFLICT` 의 CASE 식이 실제 Postgres 에서 강등을 막는다.
 *      ★ 이 CASE 는 JS 로 검증할 수 없다. SQL 안에서 도는 로직이므로 SQL 로 재야 한다.
 *   4) 세션44 가 기여에 저장한 `allergens_v2` 가 마스터 테이블까지 **도달**한다(§6-2 의 나머지 절반).
 *
 * 실행: NODE_ENV=test node tests/test_allergen_evidence_level.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  unionAllergens, levelsFromV2, strongerLevel,
  extractCandidatesFromContribution, mergeContributions,
  ALLERGEN_LEVEL_RANK, ALLERGEN_LEVEL_DEFAULT,
} = require('../src/services/mergeService');

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(
      () => { pass += 1; console.log(`  ✅ ${name}`); },
      (e) => { fail += 1; failures.push({ name, message: e.message }); console.log(`  ❌ ${name}\n     → ${e.message}`); },
    );
    pass += 1; console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1; failures.push({ name, message: e.message });
    console.log(`  ❌ ${name}\n     → ${e.message}`);
  }
  return Promise.resolve();
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

const MIGRATION = path.join(__dirname, '..', 'scripts', 'migrations', '020_allergen_evidence_level.sql');

// ══════════════════════════════════════════════════════════════════════════
// ★★ 픽스처를 손으로 적지 않는다 — 정본 마이그레이션을 그대로 돌린다.
//   세션45 는 CREATE TABLE 을 테스트 안에 손으로 적었다가 `servings_per_container`
//   ENUM `verification_status` 가 빠져 §6 이 3건 실패했다. 손으로 적은 스키마는
//   **운영과 조용히 갈라진다** — 이 프로젝트가 반복해 겪은 「한쪽만 고치기」다.
//   → 앞으로 컬럼이 늘어도 이 파일은 고칠 필요가 없다.
const MIGRATION_DIR = path.join(__dirname, '..', 'scripts', 'migrations');
const BASELINE = path.join(MIGRATION_DIR, '000_baseline.sql');

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 세션47 — 픽스처를 `000_baseline.sql` 로 옮겼다. `PRODUCTION_ONLY_SCHEMA` 는 사라졌다.
//
//   세션46 판은 001+004+005+006 을 돌린 뒤, 마이그레이션에 없고 운영에만 있던
//   `nutrition_data(product_id)` UNIQUE 를 `PRODUCTION_ONLY_SCHEMA` 라는 이름으로
//   **테스트가 몰래 보태서** 통과시키고 있었다. 그 상수는 「저장소가 운영을 재현하지 못한다」는
//   부채의 잔량 표시기였다.
//
//   이제 `000_baseline.sql`(= 운영 덤프 IP/production_schema_2026-07-31.txt 정본)이
//   그 UNIQUE 를 포함한 운영 스키마 전체를 만든다. 그래서 상수를 **지웠다.**
//   → 픽스처가 운영과 같다. 갈라지면 `npm run verify:fresh-schema` 가 먼저 잡는다.
//
//   ⚠ 따라온 결과: `users.user_id` 가 **bigint** 다(001 의 UUID 가 아니다). 운영이 그렇다.
//     그래서 아래 픽스처는 user_id 를 하드코딩하지 않고 INSERT … RETURNING 으로 받는다.
//     `users.nickname` 도 없다 — 운영 컬럼은 `display_name` 이다.
//
//   ⚠ pglite 는 pg_trgm 을 탑재하지 않지만 baseline 이 그것을 **조건부로** 처리하므로
//     세션46 의 `sanitizeForPglite` 같은 「테스트가 SQL 을 고치는」 단계가 필요 없어졌다.
//     정본 SQL 을 글자 하나 바꾸지 않고 그대로 돌린다.
// ══════════════════════════════════════════════════════════════════════════

// baseline 은 020 을 이미 흡수했다. 「020 미적용 DB」(배포 순서 역전)는
// **020 의 DDL 을 정확히 되돌려** 만든다. 손으로 적은 축소 스키마가 아니다.
const ROLLBACK_020 = `
  DROP INDEX IF EXISTS idx_product_allergens_level;
  ALTER TABLE product_allergens DROP CONSTRAINT IF EXISTS product_allergens_evidence_level_chk;
  ALTER TABLE product_allergens DROP COLUMN IF EXISTS evidence_level;
`;

/**
 * 운영 정본 baseline 으로 pglite 스키마를 만든다.
 * @param {boolean} with020 false 면 **020 의 결과물만 되돌린다** — 배포 순서 역전(치명1) 재현용.
 */
async function applyRealMigrations(db, with020 = true) {
  try {
    await db.exec(fs.readFileSync(BASELINE, 'utf8'));
  } catch (e) {
    throw new Error(`000_baseline.sql 적용 실패 — 픽스처가 아니라 정본 SQL 문제다: ${e.message}`);
  }
  if (!with020) await db.exec(ROLLBACK_020);
}

// ══════════════════════════════════════════════════════════════════════════
// ★ pglite 인스턴스 재사용 (세션47)
//   세션46 판은 인스턴스를 8개 띄웠다 — 부팅이 전체 시간의 거의 전부였다.
//   변형은 「020 적용 / 미적용」 두 가지뿐이므로 **인스턴스도 두 개만** 둔다.
//   매 획득 시 스키마를 정본으로 되돌리고 데이터를 비운다.
//   ⚠ 격리는 유지된다 — 아래 reset 이 앞 테스트의 행·스키마 변경(020 DROP 시험 포함)을 지운다.
// ══════════════════════════════════════════════════════════════════════════
const _dbPool = new Map();   // 'with020' | 'no020' → PGlite

async function acquireDb(PGliteCtor, with020 = true) {
  const key = with020 ? 'with020' : 'no020';
  let db = _dbPool.get(key);
  if (!db) {
    db = new PGliteCtor();
    await applyRealMigrations(db, with020);
    _dbPool.set(key, db);
    return db;
  }
  // 스키마 원복 — 020 은 멱등이라 그대로 다시 돌리면 DROP 된 컬럼·CHECK·인덱스가 살아난다.
  await db.exec(fs.readFileSync(MIGRATION, 'utf8'));
  if (!with020) await db.exec(ROLLBACK_020);
  // 데이터 원복
  await db.exec(`
    DELETE FROM contributions;
    DELETE FROM product_allergens;
    DELETE FROM nutrition_data;
    DELETE FROM product_additives;
    DELETE FROM product_ingredients;
    DELETE FROM nutrition_traffic_light;
    DELETE FROM products;
    DELETE FROM users;
    ALTER SEQUENCE products_product_id_seq       RESTART WITH 1;
    ALTER SEQUENCE users_user_id_seq             RESTART WITH 1;
    ALTER SEQUENCE product_allergens_id_seq      RESTART WITH 1;
    ALTER SEQUENCE nutrition_data_nutrition_id_seq RESTART WITH 1;
    ALTER SEQUENCE contributions_contribution_id_seq RESTART WITH 1;
  `);
  return db;
}

async function closeAllDbs() {
  for (const db of _dbPool.values()) await db.close();
  _dbPool.clear();
}

// mergeService.mergeAndApply 의 INSERT 와 **문자 단위로 같은** upsert.
// ★ 여기에 복사본을 두는 것은 위험하다(두 곳 동기화). 그래서 §3 이 소스에서 CASE 식을 추출해
//   이 문자열과 동일한지 검사한다. 복사본이 낡으면 테스트가 실패한다.
const UPSERT = `INSERT INTO product_allergens
   (product_id, allergen_name, source_count, status, detected_via, evidence_level)
 VALUES ($1, $2, $3, $4, 'crowdsource_merge', $5)
 ON CONFLICT (product_id, allergen_name) DO UPDATE SET
   source_count = EXCLUDED.source_count,
   status = EXCLUDED.status,
   evidence_level = CASE
     WHEN COALESCE(product_allergens.evidence_level, 'contains') = 'contains' THEN 'contains'
     WHEN EXCLUDED.evidence_level = 'contains' THEN 'contains'
     WHEN COALESCE(product_allergens.evidence_level, 'contains') = 'inferred'
       OR EXCLUDED.evidence_level = 'inferred' THEN 'inferred'
     ELSE 'may_contain'
   END,
   updated_at = NOW()`;

async function main() {
  // ════════════════════════════════════════════════════════════════════════
  section('§1. 등급 서열 — 병합은 올리기만 한다');

  await t('서열: contains > inferred > may_contain', () => {
    assert.ok(ALLERGEN_LEVEL_RANK.contains > ALLERGEN_LEVEL_RANK.inferred);
    assert.ok(ALLERGEN_LEVEL_RANK.inferred > ALLERGEN_LEVEL_RANK.may_contain);
    assert.strictEqual(ALLERGEN_LEVEL_DEFAULT, 'contains');
  });

  await t('★ strongerLevel 은 강등하지 않는다 (순서 무관)', () => {
    assert.strictEqual(strongerLevel('contains', 'may_contain'), 'contains');
    assert.strictEqual(strongerLevel('may_contain', 'contains'), 'contains');
    assert.strictEqual(strongerLevel('inferred', 'may_contain'), 'inferred');
    assert.strictEqual(strongerLevel('may_contain', 'inferred'), 'inferred');
    assert.strictEqual(strongerLevel(undefined, 'may_contain'), 'may_contain');
  });

  await t('levelsFromV2 — 3분리를 이름→등급으로 평탄화', () => {
    const m = levelsFromV2({ contains: ['밀', '대두'], inferred: ['우유'], mayContain: ['메밀'] });
    assert.strictEqual(m.get('밀'), 'contains');
    assert.strictEqual(m.get('우유'), 'inferred');
    assert.strictEqual(m.get('메밀'), 'may_contain');
  });

  await t('★ 같은 이름이 두 등급에 걸치면 강한 쪽 (라벨이 선언 + 시설 문구 둘 다 가진 실물이 있다)', () => {
    const m = levelsFromV2({ contains: ['대두'], mayContain: ['대두'], inferred: [] });
    assert.strictEqual(m.get('대두'), 'contains');
  });

  await t('★ v2 가 null 이면 빈 map (구 기여 전량 강등 방지)', () => {
    assert.strictEqual(levelsFromV2(null).size, 0);
    assert.strictEqual(levelsFromV2(undefined).size, 0);
    assert.strictEqual(levelsFromV2('문자열').size, 0);
    assert.strictEqual(levelsFromV2([]).size, 0);
  });

  // ════════════════════════════════════════════════════════════════════════
  section('§2. unionAllergens — 등급 병합 + 구 형식 호환');

  await t('구 호출(v2 인자 없음)은 전부 contains — 하위 호환', () => {
    const r = unionAllergens([['우유', '밀'], ['우유']]);
    assert.strictEqual(r.length, 2);
    for (const a of r) assert.strictEqual(a.evidence_level, 'contains');
  });

  await t('source_count 는 종전 그대로', () => {
    const r = unionAllergens([['우유', '밀'], ['우유'], ['우유']]);
    assert.strictEqual(r.find((x) => x.name === '우유').source_count, 3);
    assert.strictEqual(r.find((x) => x.name === '밀').source_count, 1);
  });

  await t('★ flat 에 없고 v2 에만 있는 혼입 항목이 채택된다 (§6-2 가 풀려던 문제)', () => {
    // 세션44 는 flat 에서 혼입을 정확히 제거했다. 그래서 flat 만 보면 대두가 사라진다.
    const r = unionAllergens(
      [['밀']],
      [{ contains: ['밀'], inferred: [], mayContain: ['대두', '우유'] }],
    );
    const names = r.map((x) => x.name).sort();
    assert.deepStrictEqual(names, ['대두', '밀', '우유']);
    assert.strictEqual(r.find((x) => x.name === '대두').evidence_level, 'may_contain');
    assert.strictEqual(r.find((x) => x.name === '밀').evidence_level, 'contains');
  });

  await t('★ 기여 A 직접함유 + 기여 B 혼입 → contains 유지 (강등 금지)', () => {
    const r = unionAllergens(
      [['대두'], []],
      [{ contains: ['대두'], inferred: [], mayContain: [] },
        { contains: [], inferred: [], mayContain: ['대두'] }],
    );
    assert.strictEqual(r.find((x) => x.name === '대두').evidence_level, 'contains');
  });

  await t('★ 반대 순서에서도 contains 유지 (순서 의존이 있으면 재현 불가 버그가 된다)', () => {
    const r = unionAllergens(
      [[], ['대두']],
      [{ contains: [], inferred: [], mayContain: ['대두'] },
        { contains: ['대두'], inferred: [], mayContain: [] }],
    );
    assert.strictEqual(r.find((x) => x.name === '대두').evidence_level, 'contains');
  });

  await t('★ v2 배열 인덱스가 flat 과 짝을 이룬다 (어긋나면 A 이름에 B 등급이 붙는다)', () => {
    const r = unionAllergens(
      [['밀'], ['대두']],
      [{ contains: [], inferred: [], mayContain: ['밀'] },
        { contains: ['대두'], inferred: [], mayContain: [] }],
    );
    assert.strictEqual(r.find((x) => x.name === '밀').evidence_level, 'may_contain');
    assert.strictEqual(r.find((x) => x.name === '대두').evidence_level, 'contains');
  });

  await t('v2 만 있고 flat 이 아예 없는 기여도 처리된다', () => {
    const r = unionAllergens([null], [{ contains: ['난류'], inferred: [], mayContain: [] }]);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].evidence_level, 'contains');
  });

  // ════════════════════════════════════════════════════════════════════════
  section('§3. 기여 → 마스터 도달 경로 (세션44 중대F 의 나머지 절반)');

  const contribution = (v2, flat, device) => ({
    contribution_id: Math.random(),
    device_id: device,
    data: {
      parsed_nutrition: { calories: 100, sodium: 200 },
      parsed_ingredients: ['밀가루'],
      allergens: flat,
      allergens_v2: v2,
      user_input: {},
      device_id: device,
      avg_confidence: 0.9,
    },
  });

  await t('★ extractCandidates 가 allergens_v2 를 꺼낸다 (안 꺼내면 마스터에 영원히 안 온다)', () => {
    const c = extractCandidatesFromContribution(
      contribution({ contains: ['밀'], inferred: [], mayContain: ['대두'] }, ['밀'], 'd1'),
    );
    assert.ok(c.allergensV2, 'allergensV2 가 없다');
    assert.deepStrictEqual(c.allergensV2.mayContain, ['대두']);
  });

  await t('구 기여(allergens_v2 없음)는 allergensV2 = null', () => {
    const raw = contribution(null, ['밀'], 'd1');
    delete raw.data.allergens_v2;
    assert.strictEqual(extractCandidatesFromContribution(raw).allergensV2, null);
  });

  await t('★ mergeContributions 결과에 등급이 실린다 (캡처 032 실물 형태)', () => {
    // 032 떡국떡: flat 에서 대두·우유가 혼입으로 제거됐다.
    const m = mergeContributions([
      contribution({ contains: ['밀'], inferred: [], mayContain: ['대두', '우유'] }, ['밀'], 'd1'),
      contribution({ contains: ['밀'], inferred: [], mayContain: ['대두', '우유'] }, ['밀'], 'd2'),
    ]);
    const byName = Object.fromEntries(m.allergens.map((a) => [a.name, a.evidence_level]));
    assert.strictEqual(byName['밀'], 'contains');
    assert.strictEqual(byName['대두'], 'may_contain', JSON.stringify(m.allergens));
    assert.strictEqual(byName['우유'], 'may_contain');
  });

  await t('★ 승격 CASE 식이 이 테스트의 복사본과 일치한다 (규칙 본문 = contributionApply)', () => {
    // 복사본이 낡으면 §4 가 실제와 다른 SQL 을 검증하게 된다 — 조용히 무의미해지는 테스트.
    // ★★ 세션66 C6 — 규칙 본문이 «이사»했다. `mergeService` 는 더 이상 `product_allergens` 에
    //   쓰지 않는다(병합은 `contribution_review` candidate 만 만든다). 등급 승격 UPSERT 는
    //   승인 시점의 `contributionApply.applyAllergensAxis` 한 곳으로 옮겼다.
    //   ⇒ 검사 «대상 파일»만 바꾼다. 검사하는 «규칙»은 한 글자도 안 바뀌었다.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'contributionApply.js'), 'utf8');
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const caseOnly = norm(UPSERT.slice(UPSERT.indexOf('evidence_level = CASE')));
    assert.ok(norm(src).includes(caseOnly),
      'contributionApply 의 ON CONFLICT CASE 식이 바뀌었다 — 이 테스트의 UPSERT 상수를 함께 갱신할 것');
    // ★ 그리고 «옛 자리»가 되살아나지 않았는지도 본다. 병합이 다시 마스터에 쓰기 시작하면
    //   기기 3대가 사람 없이 알레르기를 확정한다(설계 §3-2 가 끊은 그 경로다).
    // ⚠ 주석에 「지웠다」고 적어 둔 문장이 있으므로 **주석을 걷어내고** 본다.
    //   안 걷으면 「되살아났다」를 설명하는 주석 때문에 테스트가 거짓 빨강이 된다.
    const mergeSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'mergeService.js'), 'utf8')
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    assert.ok(!/INSERT\s+INTO\s+product_allergens/.test(mergeSrc),
      'mergeService 가 product_allergens 에 다시 쓴다 — 자동 반영이 되살아났다(설계 §3-2)');
    assert.ok(!/DELETE\s+FROM\s+product_allergens/.test(mergeSrc),
      'mergeService 가 product_allergens 를 다시 지운다 — 경고 순감 경로가 되살아났다');
  });

  // ════════════════════════════════════════════════════════════════════════
  section('§4. 마이그레이션 020 을 실제 Postgres(pglite)에서 실행');

  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (_) {
    console.log('  ⏭  pglite 미설치 — SQL 실행 검증 생략 (npm i -D @electric-sql/pglite)');
    PGlite = null;
  }

  if (PGlite) {
    // ★★ 세션47 — 손으로 적은 축소 스키마를 없앴다.
    //   세션46 판은 여기서 `CREATE TABLE products/product_allergens` 를 직접 적었다.
    //   그러면 020 을 「테스트가 만든 테이블」에 적용해 보는 것이라 운영과 무관해진다.
    //   지금은 **운영 정본 baseline 에서 020 만 되돌린 스키마**(= 020 직전 운영 상태)에
    //   정본 020 을 적용한다. 실제 배포에서 일어나는 일 그대로다.
    const db = await acquireDb(PGlite, false);
    await db.exec(`
      INSERT INTO products (product_name, data_source) VALUES ('테스트제품', 'manual_seed');
    `);

    // 마이그레이션 이전에 쌓인 행 — 의미는 「직접 함유」다.
    await db.query(
      `INSERT INTO product_allergens (product_id, allergen_name, status, detected_via)
       VALUES (1, '우유', 'confirmed', 'explicit_marker')`,
    );

    const sql = fs.readFileSync(MIGRATION, 'utf8');

    await t('마이그레이션이 오류 없이 실행된다', async () => { await db.exec(sql); });

    await t('★ 멱등 — 두 번 실행해도 오류가 없다 (운영 DB 재실행 안전)', async () => { await db.exec(sql); });

    await t('★ 기존 행이 contains 로 남는다 (일괄 강등되지 않는다)', async () => {
      const r = await db.query(`SELECT evidence_level FROM product_allergens WHERE allergen_name = '우유'`);
      assert.strictEqual(r.rows[0].evidence_level, 'contains');
    });

    await t('★ CHECK 제약이 오타 값을 거부한다 (조용히 빗나가는 분기 방지)', async () => {
      let threw = false;
      try {
        await db.query(
          `INSERT INTO product_allergens (product_id, allergen_name, evidence_level)
           VALUES (1, '오타테스트', 'maycontain')`,
        );
      } catch (_) { threw = true; }
      assert.ok(threw, "evidence_level='maycontain' 이 통과했다 — CHECK 가 없다");
    });

    await t('신규 행의 기본값은 contains', async () => {
      await db.query(`INSERT INTO product_allergens (product_id, allergen_name) VALUES (1, '기본값테스트')`);
      const r = await db.query(`SELECT evidence_level FROM product_allergens WHERE allergen_name = '기본값테스트'`);
      assert.strictEqual(r.rows[0].evidence_level, 'contains');
    });

    await t('복합 인덱스가 생성된다', async () => {
      const r = await db.query(`SELECT indexname FROM pg_indexes WHERE indexname = 'idx_product_allergens_level'`);
      assert.strictEqual(r.rows.length, 1);
    });

    // ── upsert 강등 방지: 실제 SQL 로 검증 ──
    const upsert = (name, level, count = 1) =>
      db.query(UPSERT, [1, name, count, 'candidate', level]);

    await t('★★ upsert: contains 행에 may_contain 이 들어와도 강등되지 않는다', async () => {
      await upsert('대두', 'contains');
      await upsert('대두', 'may_contain');
      const r = await db.query(`SELECT evidence_level FROM product_allergens WHERE allergen_name = '대두'`);
      assert.strictEqual(r.rows[0].evidence_level, 'contains');
    });

    await t('★★ upsert: may_contain 행에 contains 가 들어오면 승격된다', async () => {
      await upsert('메밀', 'may_contain');
      await upsert('메밀', 'contains');
      const r = await db.query(`SELECT evidence_level FROM product_allergens WHERE allergen_name = '메밀'`);
      assert.strictEqual(r.rows[0].evidence_level, 'contains');
    });

    await t('★ upsert: may_contain → inferred 는 승격, 역방향은 유지', async () => {
      await upsert('땅콩', 'may_contain');
      await upsert('땅콩', 'inferred');
      let r = await db.query(`SELECT evidence_level FROM product_allergens WHERE allergen_name = '땅콩'`);
      assert.strictEqual(r.rows[0].evidence_level, 'inferred');
      await upsert('땅콩', 'may_contain');
      r = await db.query(`SELECT evidence_level FROM product_allergens WHERE allergen_name = '땅콩'`);
      assert.strictEqual(r.rows[0].evidence_level, 'inferred');
    });

    await t('★ upsert: inferred 행에 contains 가 오면 승격 (원재료 추정 → 명시 선언 확인)', async () => {
      await upsert('난류', 'inferred');
      await upsert('난류', 'contains');
      const r = await db.query(`SELECT evidence_level FROM product_allergens WHERE allergen_name = '난류'`);
      assert.strictEqual(r.rows[0].evidence_level, 'contains');
    });

    await t('upsert 는 source_count·status 를 종전대로 갱신한다', async () => {
      await upsert('새우', 'contains', 1);
      await upsert('새우', 'contains', 5);
      const r = await db.query(`SELECT source_count FROM product_allergens WHERE allergen_name = '새우'`);
      assert.strictEqual(Number(r.rows[0].source_count), 5);
    });

    await t('★ 같은 이름이 두 행으로 갈라지지 않는다 (UNIQUE 유지 확인)', async () => {
      const r = await db.query(`SELECT COUNT(*)::int AS n FROM product_allergens WHERE allergen_name = '대두'`);
      assert.strictEqual(r.rows[0].n, 1);
    });

    // ★ 인스턴스를 닫지 않는다 — §6 이 같은 것을 재사용한다(acquireDb 가 원복한다).
  }

  // ════════════════════════════════════════════════════════════════════════
  section('§5. 바코드 조회 경로 — 알레르기가 응답에 실린다');

  // ★ 세션44 §6-2 는 「구분이 전달되지 않는다」고 적었다. 실제로는 더 나빴다:
  //   GET /api/products/:barcode 응답에 **알레르기 키가 아예 없었다.**
  const { buildAllergens } = require('../src/services/productService');

  await t('행이 없으면 빈 3분리 (렌더가 죽지 않게 형태는 유지)', () => {
    const r = buildAllergens([]);
    assert.deepStrictEqual(r.flat, []);
    assert.deepStrictEqual(r.v2, { contains: [], inferred: [], mayContain: [] });
  });

  await t('★ rows 가 null/undefined 면 null 을 낸다 (중대5 — 빈 배열이면 「없음」으로 단정된다)', () => {
    assert.strictEqual(buildAllergens(null), null);
    assert.strictEqual(buildAllergens(undefined), null);
    assert.strictEqual(buildAllergens('문자열'), null);
  });

  await t('3등급이 각 구획으로 갈린다', () => {
    const r = buildAllergens([
      { allergen_name: '밀', evidence_level: 'contains' },
      { allergen_name: '우유', evidence_level: 'inferred' },
      { allergen_name: '대두', evidence_level: 'may_contain' },
    ]);
    assert.deepStrictEqual(r.v2.contains, ['밀']);
    assert.deepStrictEqual(r.v2.inferred, ['우유']);
    assert.deepStrictEqual(r.v2.mayContain, ['대두']);
  });

  await t('★★ flat 에 혼입 가능이 들어가지 않는다 (구버전 앱이 붉게 표시 = 거짓 경고)', () => {
    const r = buildAllergens([
      { allergen_name: '밀', evidence_level: 'contains' },
      { allergen_name: '대두', evidence_level: 'may_contain' },
    ]);
    assert.ok(!r.flat.includes('대두'), `flat: ${JSON.stringify(r.flat)}`);
    assert.ok(r.flat.includes('밀'));
  });

  await t('★ flat 에 원재료 추정은 들어간다 (실제로 들어 있는 원료다 — 빼면 경고 순감)', () => {
    const r = buildAllergens([{ allergen_name: '밀', evidence_level: 'inferred' }]);
    assert.deepStrictEqual(r.flat, ['밀']);
  });

  await t('★ evidence_level 이 NULL 인 구 행을 버리지 않는다 (020 이전 데이터)', () => {
    const r = buildAllergens([{ allergen_name: '메밀', evidence_level: null }]);
    assert.deepStrictEqual(r.v2.contains, ['메밀'], '등급 없는 행이 사라졌다 — 경고 소실');
    assert.deepStrictEqual(r.flat, ['메밀']);
  });

  await t('빈 이름·비문자열은 걸러진다', () => {
    const r = buildAllergens([
      { allergen_name: '   ', evidence_level: 'contains' },
      { allergen_name: null, evidence_level: 'contains' },
      { allergen_name: 12345, evidence_level: 'contains' },
      { allergen_name: '밀', evidence_level: 'contains' },
    ]);
    assert.deepStrictEqual(r.v2.contains, ['밀']);
  });

  await t('flat 중복이 제거된다', () => {
    const r = buildAllergens([
      { allergen_name: '밀', evidence_level: 'contains' },
      { allergen_name: '밀', evidence_level: 'inferred' },
    ]);
    assert.deepStrictEqual(r.flat, ['밀']);
  });

  await t('★ getProductWithTrafficLight 응답에 allergens / allergens_v2 키가 있다 (소스 검증)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'productService.js'), 'utf8');
    // ★ 세션46: 게이트가 `allergens` 에서 `allergens && allergens.collected` 로 바뀌었다.
    //   미수집(0행)을 「없음」으로 내보내지 않기 위해서다. 상세는 아래 §7 의 세션46 케이스.
    assert.ok(/allergens:\s*allergens && allergens\.collected \? allergens\.flat : null/.test(src),
      '응답에 flat 알레르기가 실리지 않는다');
    assert.ok(/allergens_v2:\s*allergens && allergens\.collected \? allergens\.v2 : null/.test(src),
      '응답에 3분리가 실리지 않는다');
    assert.ok(/productModel\.getAllergens/.test(src), 'productService 가 알레르기를 조회하지 않는다');
  });

  await t('★ productModel.getAllergens 가 evidence_level 을 SELECT 한다', () => {
    // ★ 세션46: SQL 조립이 `buildAllergenQuery` 로 분리됐다(020 롤백 시 등급 없이 재시도하기 위함).
    //   함수 이름을 따라가되, **이 소스 검사만으로는 부족하다** — 뮤테이션 M9 가 이런 검사를
    //   통과했었다. 실제 SQL 실행 검증은 §6 이 한다.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'models', 'productModel.js'), 'utf8');
    const m = src.match(/function buildAllergenQuery[\s\S]{0,900}?\n}/);
    assert.ok(m, 'buildAllergenQuery 를 찾지 못했다 (getAllergens 의 SQL 조립부)');
    assert.ok(/evidence_level/.test(m[0]), 'evidence_level 을 SELECT 하지 않는다 — 등급이 조회 경로에 도달하지 않는다');
    assert.ok(/product_allergens/.test(m[0]));
    assert.ok(/buildAllergenQuery\(/.test(src.match(/async function getAllergens[\s\S]{0,900}?\n}/)[0]),
      'getAllergens 가 buildAllergenQuery 를 쓰지 않는다 — SQL 이 두 곳에 생겼다');
  });

  await t('★ OCR 경로와 키 이름이 같다 (경로별 분기를 만들지 않는다)', () => {
    const ocrSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ocrRoutes.js'), 'utf8');
    const prodSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'productService.js'), 'utf8');
    assert.ok(/allergens_v2:/.test(ocrSrc) && /allergens_v2:/.test(prodSrc),
      '두 경로가 같은 키(allergens_v2)를 쓰지 않는다 — 클라이언트에 경로별 분기가 생긴다');
  });

  // ════════════════════════════════════════════════════════════════════════
  section('§6. ★★★ 실제 쓰기·읽기 경로 (1차 검증 치명2 · 중대3 맹점 M8/M9)');

  // ★★ 왜 이 절이 필요한가 — 1차 검증이 뮤테이션으로 실증한 맹점이다.
  //   §4 는 `mergeAndApply` 를 부르지 않고 **테스트가 들고 있는 UPSERT 복사본**만 실행했고,
  //   §5 는 `getAllergens` 의 SQL 을 실행하지 않고 **소스 문자열 정규식**만 봤다.
  //   그래서 아래 두 파괴가 39/39 초록을 통과했다:
  //     M8: DELETE 에서 `AND status != 'admin_verified'` 제거 = 알레르기 행 무조건 전삭제
  //     M9: getAllergens 에 `AND evidence_level = 'contains'` 추가 = 혼입·추정 경고 전부 소거
  //   둘 다 이 프로젝트가 치명으로 규정한 「경고를 지우는 방향」이다.
  //   → `src/config/database` 를 pglite 로 갈아끼워 **정본 함수를 그대로 호출**한다.

  // ★ 세션54 — §10 이 소스 문자열 검사를 버리고 **실호출 검사**로 바뀌면서 이 헬퍼가
  //   블록 밖에서도 필요해졌다. 그래서 함수 선언을 바깥 변수 대입으로 바꿨다.
  //   (내용은 그대로다 — 아래 정의 위치도 그대로 §6 블록 안이다.)
  let withPgliteDb = null;

  if (PGlite) {
    const PGModule = require('@electric-sql/pglite');

    /** src/config/database 를 pglite 로 갈아끼우고 정본 모듈을 새로 로드한다. */
    withPgliteDb = async function withPgliteDbImpl(applyMigration020 = true) {
      // ★ 세션47 — 인스턴스를 새로 띄우지 않고 재사용한다(acquireDb 가 스키마·데이터를 원복).
      const db = await acquireDb(PGModule.PGlite, applyMigration020);
      const origQuery = db.query.bind(db);   // 중대2 테스트가 query 를 갈아끼운다 → 원복용
      await db.exec(`
        INSERT INTO products (product_name, data_source) VALUES ('실경로테스트', 'manual_seed');
      `);
      // ★ contributions.user_id 는 users 를 참조한다. 기여자를 먼저 만든다.
      //   ⚠ 세션47 — `users.user_id` 는 **bigint** 다(운영 실측). 하드코딩하지 않고 받아 온다.
      //     `nickname` 은 운영에 없다 — `display_name` 이다.
      const testUserId = (await db.query(
        `INSERT INTO users (firebase_uid, display_name) VALUES ('test-uid-1', '테스트기여자')
         RETURNING user_id`)).rows[0].user_id;

      // pg 와 같은 인터페이스만 흉내낸다(query / transaction).
      const shim = {
        pool: null,
        query: (text, params) => db.query(text, params || []),
        transaction: async (cb) => {
          // pglite 는 단일 커넥션이다. BEGIN/COMMIT 을 직접 감싼다.
          await db.exec('BEGIN');
          try {
            const r = await cb({ query: (t, p) => db.query(t, p || []) });
            await db.exec('COMMIT');
            return r;
          } catch (e) { await db.exec('ROLLBACK'); throw e; }
        },
        healthCheck: async () => ({ status: 'healthy' }),
      };

      // require 캐시 교체 — 정본 모듈이 이 shim 을 쓰게 만든다.
      const dbPath = require.resolve('../src/config/database');
      const saved = require.cache[dbPath];
      require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };
      for (const p of ['../src/services/mergeService', '../src/models/productModel',
        '../src/services/productService']) {
        delete require.cache[require.resolve(p)];
      }
      const merge = require('../src/services/mergeService');
      const model = require('../src/models/productModel');
      const svc = require('../src/services/productService');
      model._resetEvidenceLevelCache();

      return {
        db,
        merge,
        model,
        svc,
        testUserId,
        restore() {
          db.query = origQuery;   // ★ 인스턴스를 공유하므로 갈아끼운 query 를 반드시 되돌린다
          if (saved) require.cache[dbPath] = saved; else delete require.cache[dbPath];
          for (const p of ['../src/services/mergeService', '../src/models/productModel',
            '../src/services/productService']) {
            delete require.cache[require.resolve(p)];
          }
        },
      };
    };

    // ★ mergeAndApply(productId) 는 **DB 에서 contributions 를 직접 읽는다.**
    //   그래서 배열을 인자로 넘길 수 없다 — 실제 행을 넣어야 정본 경로를 그대로 통과한다.
    //   (이 사실을 몰랐다면 테스트가 또 "복사본만 검사" 로 빠졌을 것이다.)
    const putContrib = (h, device, v2, flat) => h.db.query(
      `INSERT INTO contributions (user_id, product_id, contribution_type, device_id, data)
       VALUES ($3, 1, 'ocr_nutrition', $1, $2)`,
      [device, JSON.stringify({
        parsed_nutrition: {}, parsed_ingredients: [],
        allergens: flat, allergens_v2: v2, user_input: {},
        device_id: device, avg_confidence: 0.9,
      }), h.testUserId],
    );

    await t('★★ 치명2 — 식약처 적재분이 크라우드 merge 1건으로 삭제되지 않는다', async () => {
      const h = await withPgliteDb();
      try {
        // 식약처(HACCP) 적재분: 직접 함유 3종
        for (const n of ['대두', '밀', '우유']) {
          await h.db.query(
            `INSERT INTO product_allergens (product_id, allergen_name, status, detected_via, evidence_level)
             VALUES (1, $1, 'confirmed', 'haccp_api', 'contains')`, [n],
          );
        }
        // 사용자가 「대두 혼입」 사진 1장 등록 → merge
        await putContrib(h, 'd1', { contains: [], inferred: [], mayContain: ['대두'] }, []);
        await h.merge.mergeAndApply(1);
        const rows = await h.model.getAllergens(1);
        const byName = Object.fromEntries(rows.map((r) => [r.allergen_name, r.evidence_level]));
        assert.ok(byName['밀'], `밀이 삭제됐다: ${JSON.stringify(byName)}`);
        assert.ok(byName['우유'], `우유가 삭제됐다: ${JSON.stringify(byName)}`);
        assert.strictEqual(byName['대두'], 'contains',
          `대두가 혼입으로 강등됐다: ${JSON.stringify(byName)}`);
      } finally { h.restore(); }   // ★ 인스턴스는 공유 — 닫지 않는다
    });

    await t('★★ 치명2-B — admin_verified 가 merge 2회에도 살아남는다', async () => {
      const h = await withPgliteDb();
      try {
        await h.db.query(
          `INSERT INTO product_allergens (product_id, allergen_name, status, detected_via, evidence_level)
           VALUES (1, '대두', 'admin_verified', 'admin_verified', 'contains')`,
        );
        await putContrib(h, 'd1', { contains: [], inferred: [], mayContain: ['대두'] }, []);
        await h.merge.mergeAndApply(1);
        await h.merge.mergeAndApply(1);
        const r = await h.db.query(
          `SELECT status, evidence_level FROM product_allergens WHERE allergen_name = '대두'`);
        assert.strictEqual(r.rows.length, 1, '대두 행이 사라졌다');
        assert.strictEqual(r.rows[0].status, 'admin_verified', 'status 가 깎였다');
        assert.strictEqual(r.rows[0].evidence_level, 'contains', '등급이 강등됐다');
      } finally { h.restore(); }   // ★ 인스턴스는 공유 — 닫지 않는다
    });

    // ★★ 세션66 C6 — 이 절의 «기대값»이 바뀌었다. 왜인지 남긴다.
    //   종전 규칙: 병합이 `detected_via='crowdsource_merge'` 행을 만들고,
    //             다음 병합이 그 행을 DELETE 해서 누적 쓰레기를 막았다.
    //   지금 규칙: 병합이 **애초에 행을 만들지 않는다**(설계 §3-2 · 전량 수동에 예외 없음).
    //             ⇒ 「누적 쓰레기」가 원천적으로 생기지 않으므로 청소가 필요 없다.
    //   ⚠ 이것은 「경고가 사라지지 않는다」를 지키던 단정이 **아니다**(그 축은 바로 위 치명2·
    //     아래 경미6 이 지킨다 — 둘 다 그대로 초록이다). 이 단정은 「병합이 자기 쓰레기를
    //     치운다」였고, 쓰레기를 만들지 않게 된 지금은 **더 강한 상태**다.
    await t('★ 병합은 애초에 product_allergens 에 행을 만들지 않는다 (누적 쓰레기가 생기지 않는다)', async () => {
      const h = await withPgliteDb();
      try {
        await putContrib(h, 'd1', null, ['밀', '대두']);
        await h.merge.mergeAndApply(1);
        let rows = await h.model.getAllergens(1);
        assert.strictEqual(rows.length, 0,
          `병합이 알레르기를 자동 반영했다: ${JSON.stringify(rows)} — 사람 승인 없이 마스터가 됐다`);
        // 기여를 갈아끼워 다시 돌려도 마찬가지다(만들지도, 지우지도 않는다).
        await h.db.query('DELETE FROM contributions');
        await putContrib(h, 'd2', null, ['밀']);
        await h.merge.mergeAndApply(1);
        rows = await h.model.getAllergens(1);
        assert.strictEqual(rows.length, 0, JSON.stringify(rows));
        // ★ 그런데 병합 «판정»은 살아 있어야 한다 — 그것이 없으면 관리자가 볼 근거가 없다.
        const res = await h.merge.mergeAndApply(1);
        assert.ok(res.merged.allergens.some((a) => a.name === '밀'),
          `병합 판정에서 알레르기가 사라졌다: ${JSON.stringify(res.merged.allergens)}`);
      } finally { h.restore(); }   // ★ 인스턴스는 공유 — 닫지 않는다
    });

    // ══════════════════════════════════════════════════════════════════════
    // ★★★ 세션46 2차 검증 — 아래 4건은 **세션45 수정이 만든 새 결함**의 회귀다.
    //   1차 수정이 새 결함을 만드는 것이 이 프로젝트의 반복 패턴이라 절마다 못 박는다.

    await t('★★★ 세션46 치명1 — 020 미적용 DB 에서도 merge 가 통째로 실패하지 않는다', async () => {
      // 세션45 는 조회 경로에만 컬럼 가드를 넣었다. 쓰기 경로(INSERT ... evidence_level)가
      // 예외를 던지면 **트랜잭션 전체가 롤백**되어 영양·메타·알레르기가 하나도 반영되지 않는다.
      // 게다가 crowdsourceService 가 그 예외를 삼켜 API 는 saved:true 를 반환한다(조용한 전멸).
      // ★★ 세션66 C6 — 기대값이 바뀐 지점. 병합은 이제 `product_allergens` 에 «쓰지 않는다»
      //   (설계 §3-2). 그래서 「적재됐는가」로는 더 이상 잴 수 없다.
      //   ⚠ 이 단정이 «진짜로» 지키던 것은 「쓰기 경로의 컬럼/테이블 부재 예외가
      //     트랜잭션 전체를 롤백해 영양·메타까지 통째로 날리지 않는다」다.
      //     그 축은 `merged_at` + 판정 결과로 그대로 잴 수 있고, 아래가 그렇게 잰다.
      //   ★ 그리고 024 «미적용» DB 라 검토 큐도 없다 — 그때도 죽지 않아야 한다(배포순서 방어).
      const h = await withPgliteDb(false);   // ← 020 미적용
      try {
        await putContrib(h, 'd1', { contains: ['밀'], inferred: [], mayContain: ['대두'] }, ['밀']);
        const res = await h.merge.mergeAndApply(1);   // 이전 코드는 여기서 throw
        assert.strictEqual(res.applied, true, '병합이 통째로 실패했다');
        assert.deepStrictEqual(
          res.merged.allergens.map((a) => a.name).sort(), ['대두', '밀'],
          `병합 판정에서 알레르기가 사라졌다: ${JSON.stringify(res.merged.allergens)}`);
        const p = await h.db.query(`SELECT merged_at FROM products WHERE product_id = 1`);
        assert.ok(p.rows[0].merged_at, 'merged_at 이 비었다 — 트랜잭션이 롤백됐다(영양·메타도 함께 사라진다)');
      } finally { h.restore(); }   // ★ 인스턴스는 공유 — 닫지 않는다
    });

    await t('★★ 세션46 중대2 — 컬럼 판정 실패를 영구 캐싱하지 않는다', async () => {
      // 020 이 정상 적용된 DB 에서도 첫 조회 순간 커넥션이 한 번 끊기면,
      // 세션45 판은 false 를 **프로세스 수명 내내** 들고 있어 모든 등급이 contains 로 나갔다.
      // = 혼입 가능이 「직접 함유」로 표시된다(과잉경고) + 「직접 함유 먼저」 정렬 계약도 깨진다.
      const h = await withPgliteDb();
      try {
        await h.db.query(
          `INSERT INTO product_allergens (product_id, allergen_name, detected_via, evidence_level)
           VALUES (1,'밀','x','contains'), (1,'대두','x','may_contain')`);
        // information_schema 조회를 **1회만** 실패시킨다.
        const real = h.db.query.bind(h.db);
        let injected = false;
        h.db.query = (text, params) => {
          if (!injected && /information_schema/.test(text)) {
            injected = true;
            return Promise.reject(new Error('Connection terminated unexpectedly'));
          }
          return real(text, params || []);
        };
        const first = await h.model.getAllergens(1);
        assert.ok(first.every((r) => r.evidence_level === 'contains'),
          '1회 실패 시에는 보수적으로 contains 폴백이 맞다');
        // DB 는 멀쩡하다. 두 번째 조회는 스스로 회복해야 한다.
        const second = await h.model.getAllergens(1);
        assert.deepStrictEqual(
          second.map((r) => `${r.allergen_name}=${r.evidence_level}`),
          ['밀=contains', '대두=may_contain'],
          `실패가 캐싱돼 회복하지 못했다: ${JSON.stringify(second)}`);
      } finally { h.restore(); }   // ★ 인스턴스는 공유 — 닫지 않는다
    });

    await t('★★ 세션46 중대2-(c) — 020 롤백(컬럼 DROP)에도 조회가 500 이 되지 않는다', async () => {
      const h = await withPgliteDb();
      try {
        await h.db.query(
          `INSERT INTO product_allergens (product_id, allergen_name, detected_via, evidence_level)
           VALUES (1,'우유','x','contains')`);
        await h.model.getAllergens(1);                       // 캐시를 true 로 굳힌다
        await h.db.query('ALTER TABLE product_allergens DROP COLUMN evidence_level');
        const rows = await h.model.getAllergens(1);          // 이전 코드는 여기서 throw → 응답 전체 500
        assert.strictEqual(rows.length, 1, JSON.stringify(rows));
        assert.strictEqual(rows[0].evidence_level, 'contains',
          '대체 등급이 contains 가 아니다(약하게 만들면 안 된다)');
      } finally { h.restore(); }   // ★ 인스턴스는 공유 — 닫지 않는다
    });

    await t('★ 세션46 경미6 — detected_via 가 NULL 인 행이 merge 2회에 삭제되지 않는다', async () => {
      // COALESCE 로 NULL 을 'crowdsource_merge' 로 세탁하면 다음 merge 의 DELETE 대상이 된다.
      // 19-apply-haccp.js 의 컬럼 부재 폴백이 detected_via 없이 INSERT 하므로 NULL 행은 실재한다.
      const h = await withPgliteDb();
      try {
        await h.db.query(
          `INSERT INTO product_allergens (product_id, allergen_name, detected_via, evidence_level)
           VALUES (1,'게',NULL,'contains')`);
        await putContrib(h, 'd1', { contains: ['게'], inferred: [], mayContain: [] }, ['게']);
        await h.merge.mergeAndApply(1);
        let r = await h.db.query(`SELECT detected_via FROM product_allergens WHERE allergen_name='게'`);
        assert.strictEqual(r.rows.length, 1, 'merge 1회에 게가 사라졌다');
        assert.strictEqual(r.rows[0].detected_via, null,
          `detected_via 가 세탁됐다(${r.rows[0].detected_via}) — 다음 merge 에서 삭제된다`);
        await h.db.query('DELETE FROM contributions');
        await putContrib(h, 'd2', { contains: ['밀'], inferred: [], mayContain: [] }, ['밀']);
        await h.merge.mergeAndApply(1);
        r = await h.db.query(`SELECT allergen_name FROM product_allergens WHERE allergen_name='게'`);
        assert.strictEqual(r.rows.length, 1,
          '★ 게(비-크라우드소싱 출처)가 merge 2회 만에 삭제됐다 — 경고가 사라지는 방향이다');
      } finally { h.restore(); }   // ★ 인스턴스는 공유 — 닫지 않는다
    });

    await t('★★ 맹점 M9 — getAllergens 가 혼입·추정을 실제 SQL 에서 빠뜨리지 않는다', async () => {
      const h = await withPgliteDb();
      try {
        await h.db.query(
          `INSERT INTO product_allergens (product_id, allergen_name, detected_via, evidence_level)
           VALUES (1,'밀','x','contains'), (1,'우유','x','inferred'), (1,'대두','x','may_contain')`);
        const rows = await h.model.getAllergens(1);
        assert.strictEqual(rows.length, 3, `등급별 누락: ${JSON.stringify(rows)}`);
        // 정렬 계약: 직접 함유가 먼저
        assert.strictEqual(rows[0].allergen_name, '밀', JSON.stringify(rows.map((r) => r.allergen_name)));
        assert.strictEqual(rows[2].allergen_name, '대두');
      } finally { h.restore(); }   // ★ 인스턴스는 공유 — 닫지 않는다
    });

    await t('★★★ 치명1 — 마이그레이션 020 미적용 DB 에서도 getAllergens 가 죽지 않는다', async () => {
      // 020 을 **적용하지 않은** 스키마를 만든다(배포 순서 역전 재현).
      // ★ 손으로 적은 축소 스키마가 아니라 **운영 정본 baseline 에서 020 의 결과물만 되돌린 것**이다.
      //   운영에서 실제로 일어날 수 있는 상태(코드 먼저 배포 · 020 미적용)를 그대로 만든다.
      const db = await acquireDb(PGModule.PGlite, false);
      await db.exec(`
        INSERT INTO products (product_name, data_source) VALUES ('구스키마', 'manual_seed');
        INSERT INTO product_allergens (product_id, allergen_name) VALUES (1,'우유'), (1,'대두');
      `);
      const dbPath = require.resolve('../src/config/database');
      const saved = require.cache[dbPath];
      require.cache[dbPath] = {
        id: dbPath, filename: dbPath, loaded: true,
        exports: { query: (t2, p) => db.query(t2, p || []), transaction: async () => {}, pool: null },
      };
      delete require.cache[require.resolve('../src/models/productModel')];
      const model = require('../src/models/productModel');
      model._resetEvidenceLevelCache();
      try {
        const rows = await model.getAllergens(1);   // 이전 코드는 여기서 throw → 응답 전체 500
        assert.strictEqual(rows.length, 2, `020 미적용 DB 에서 행이 사라졌다: ${JSON.stringify(rows)}`);
        for (const r of rows) {
          assert.strictEqual(r.evidence_level, 'contains',
            `대체 등급이 contains 가 아니다(약하게 만들면 안 된다): ${JSON.stringify(r)}`);
        }
      } finally {
        if (saved) require.cache[dbPath] = saved; else delete require.cache[dbPath];
        delete require.cache[require.resolve('../src/models/productModel')];
        // ★ 인스턴스는 공유 — 닫지 않는다
      }
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  section('§7. 중대4 — 두 경로의 flat `allergens` 가 같은 의미다');

  const { flattenAllergensV2, analyzeText, reconcileAllergens } = require('../src/services/ocrParser');

  await t('★★ 혼입만 있는 라벨 — OCR 응답 flat 에 혼입이 들어가지 않는다', () => {
    // 1차 검증 실측: 이전에는 analysis.allergens = ["대두","우유"] 였다(v1 폴백 키워드 추론).
    const text = '• 이 제품은 대두, 우유를 사용한 제품과 같은 제조시설에서 제조하고 있습니다.';
    const a = analyzeText(text);
    const v2 = reconcileAllergens(a.allergens, a.allergens_v2);
    const flat = flattenAllergensV2(v2, a.allergens);
    for (const n of v2.mayContain) {
      assert.ok(!flat.includes(n), `혼입 「${n}」 이 flat 에 있다 — 구버전 앱이 붉게 표시한다`);
    }
  });

  await t('★ 직접 함유는 flat 에 남는다 (과잉 제거가 아니다)', () => {
    const a = analyzeText('밀 함유\n• 이 제품은 대두를 사용한 제품과 같은 제조시설에서 제조합니다.');
    const v2 = reconcileAllergens(a.allergens, a.allergens_v2);
    const flat = flattenAllergensV2(v2, a.allergens);
    assert.ok(flat.includes('밀'), `직접 함유가 사라졌다: ${JSON.stringify(flat)}`);
    assert.ok(!flat.includes('대두'), `혼입이 남았다: ${JSON.stringify(flat)}`);
  });

  await t('★ 사용자 덮어쓰기(v2 = null)면 준 목록을 그대로 쓴다', () => {
    assert.deepStrictEqual(flattenAllergensV2(null, ['밀', '대두']), ['밀', '대두']);
    assert.deepStrictEqual(flattenAllergensV2(null, null), []);
  });

  await t('★★ 두 라우트가 flat 을 같은 함수로 만든다 (소스 검증 — 갈라지면 여기서 걸린다)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ocrRoutes.js'), 'utf8');
    // ★★★ 세션54 D4 — 종전에는 `allergens: flattenAllergensV2(` 리터럴이 «3곳» 인지 셌다.
    //   D4 수정으로 세 지점이 한 헬퍼(`buildAllergenKeys`)를 부르게 되면서,
    //   **의도가 더 강하게 지켜졌는데도** 그 검사가 깨졌다. 리터럴이 아니라 의도를 검사한다.
    //   ⚠ 이 파일에서 세션54 에 같은 이유로 고친 검사가 이것으로 두 번째다(§10 도 교체됐다).
    //     「소스 문자열로 배선을 보는 검사」는 이 저장소에서 반복적으로 족쇄가 됐다 —
    //     새로 쓸 때는 실호출을 우선할 것.
    // ★ 세션64 — 사용처가 3 → 4 가 됐다. `POST /api/ocr/confirm` 이 저장 직전에
    //   같은 헬퍼로 flat 을 만든다(사용자가 제품명을 확정하는 2단계 경로).
    //   **개수가 는 것 자체는 위반이 아니다** — 위반은 「헬퍼를 «안» 거치는 지점이 생기는 것」이다.
    //   그 진짜 불변식은 바로 아래 `flattenAllergensV2` 검사가 본다(개수와 무관하게 지킨다).
    // 사용처: /analyze 응답 · /multi-photo 응답 · /multi-photo 저장(user_input) · /confirm 저장 + 정의 1.
    const n = (src.match(/buildAllergenKeys\(/g) || []).length;
    assert.strictEqual(n, 5, `flat 을 만드는 지점이 정의1+사용4 이어야 한다 (현재 ${n}곳)`);

    // ★★★ 세션64 — 여기가 «진짜» 불변식이다: **flat 은 오직 헬퍼 안에서만 만들어진다.**
    //   위 개수 단정은 새 라우트가 생길 때마다 숫자를 올려야 해서 이 파일에서 이미 두 번 족쇄가 됐다
    //   (세션54 주석 참조). 숫자를 올리는 의식이 반복되면, 언젠가 「헬퍼를 안 거치는 새 지점」이
    //   생겼을 때도 그냥 숫자만 올리고 넘어간다. 그것을 막는 것이 이 한 줄이다.
    const rawFlat = (src.match(/flattenAllergensV2\(/g) || []).length;
    assert.strictEqual(rawFlat, 1,
      `ocrRoutes 에서 flattenAllergensV2 는 buildAllergenKeys 안에서 «한 번»만 불려야 한다 (현재 ${rawFlat}곳)`
      + ' — 헬퍼를 거치지 않고 flat 을 만드는 지점이 생겼다.');
    // ★ 그 헬퍼가 실제로 flat 규칙(혼입 제외)을 적용하는지 실호출로 본다 — 개수만 맞추면 통과하는 것 방지.
    const { buildAllergenKeys } = require('../src/routes/ocrRoutes');
    const out = buildAllergenKeys([], { contains: ['밀'], mayContain: ['대두'], inferred: [], evidence: [] });
    assert.deepStrictEqual(out.allergens, ['밀'],
      'flat 규칙이 깨졌다 — 혼입(대두)이 섞였거나 직접함유(밀)가 빠졌다');
    assert.ok(!/allergens:\s*analysis\.allergens,/.test(src), '/analyze 가 raw flat 을 그대로 낸다');
    assert.ok(!/allergens:\s*merged\.allergens,/.test(src), 'raw flat 을 그대로 내는 지점이 남아 있다');
  });

  await t('★ productService 도 같은 함수를 쓴다 (규칙을 두 번 적지 않는다)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'productService.js'), 'utf8');
    assert.ok(/flattenAllergensV2\(v2, \[\]\)/.test(src),
      'productService 가 flat 규칙을 따로 구현했다 — 한쪽만 고치는 사고가 재발한다');
  });

  // ══════════════════════════════════════════════════════════════════════════
  section('§8. 세션46 중대4 — 저장 경계도 응답과 같은 의미다');

  await t('★★★ crowdsourceService 가 raw 가 아니라 reconcile 된 값을 저장한다', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'crowdsourceService.js'), 'utf8');
    assert.ok(!/allergens:\s*analysis\.allergens\s*\|\|/.test(src),
      'raw v1 flat 을 그대로 저장한다 — flat-only 이름이 DB 에 contains 로 확정된다');
    assert.ok(!/allergens_v2:\s*analysis\.allergens_v2\s*\|\|/.test(src),
      'raw v2 를 그대로 저장한다 — 응답(reconcile 후)과 등급이 어긋난다');
    // ★★ 세션66 C6 — 저장 경로가 reconcile 을 **한 번만** 부르고 그 결과를 flat·v2 에 나눠 쓴다.
    //   종전 기대값은 「호출이 «2곳»이고 인자 짝이 서로 같다」였다. 지금은 호출이 하나라
    //   **짝이 어긋날 여지가 구조적으로 사라졌다** — 종전보다 강한 보증이다.
    //   ⚠ 지키는 것은 그대로다: 저장 flat 과 v2 가 «같은 reconcile 결과»에서 나온다.
    const pairs = [...src.matchAll(/reconcileAllergens\(\s*(\w+)\.allergens,\s*(\w+)\.allergens_v2\s*\)/g)];
    assert.ok(pairs.length >= 1, '저장 경로에 reconcileAllergens 호출이 없다');
    for (const m of pairs) assert.strictEqual(m[1], m[2], `인자 짝이 어긋났다: ${m[1]} vs ${m[2]}`);
    const v2Var = (src.match(/const\s+(\w+)\s*=\s*reconcileAllergens\(/) || [])[1];
    assert.ok(v2Var, 'reconcile 결과를 변수에 담지 않았다 — flat 과 v2 가 갈릴 수 있다');
    const flatVar = (src.match(/const\s+(\w+)\s*=\s*flattenAllergensV2\(/) || [])[1];
    assert.ok(flatVar, '저장 flat 이 flattenAllergensV2 로 만들어지지 않는다 — 규칙이 두 곳에 생긴다');
    assert.ok(new RegExp(`flattenAllergensV2\\(\\s*${v2Var}\\b`).test(src),
      'flat 이 reconcile 결과가 «아닌» 것에서 만들어진다 — 응답과 등급이 어긋난다');
    assert.ok(new RegExp(`allergens:\\s*${flatVar}\\b`).test(src),
      `저장 flat 이 flattenAllergensV2 결과(${flatVar})가 아니다`);
    assert.ok(new RegExp(`allergens_v2:\\s*${v2Var}\\b`).test(src),
      `저장 v2 가 reconcile 결과(${v2Var})가 아니다`);
  });

  await t('★★★ 68건 전수 — 응답 등급과 DB 등급이 한 건도 어긋나지 않는다', () => {
    // ★ 이것이 중대4 의 본체다. 소스 검사만으로는 못 잡는다.
    //   세션45 판에서는 006(새우·조개류) · 046(토마토) · 076(대두) 3건이
    //   응답 inferred / DB contains 로 갈렸다(= 라벨이 선언한 적 없는 것을 「직접 함유」로 표시).
    const dir = path.join(__dirname, '..', '..', '.tmp', 'captures', 'transcripts');
    if (!fs.existsSync(dir)) { console.log('     (전사 폴더 없음 — 건너뜀)'); return; }
    const { analyzeText, reconcileAllergens: rec, flattenAllergensV2: flat } = require('../src/services/ocrParser');
    const { mergeContributions } = require('../src/services/mergeService');
    const mismatched = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.txt')).sort()) {
      const a = analyzeText(fs.readFileSync(path.join(dir, f), 'utf8'));
      const v2 = rec(a.allergens, a.allergens_v2);
      // crowdsourceService 가 저장하는 것과 **같은 형태**로 만든다.
      const merged = mergeContributions([{ data: { allergens: flat(v2, a.allergens), allergens_v2: v2 }, device_id: 'd1' }]);
      const dbLevel = Object.fromEntries((merged.allergens || []).map((x) => [x.name, x.evidence_level]));
      const respLevel = {};
      for (const n of v2.mayContain) respLevel[n] = 'may_contain';
      for (const n of v2.inferred) respLevel[n] = 'inferred';
      for (const n of v2.contains) respLevel[n] = 'contains';
      for (const [n, lv] of Object.entries(respLevel)) {
        if (dbLevel[n] && dbLevel[n] !== lv) mismatched.push(`${f}:${n} 응답=${lv} DB=${dbLevel[n]}`);
      }
    }
    assert.deepStrictEqual(mismatched, [],
      `응답과 DB 의 등급이 갈렸다 — 같은 제품이 화면마다 다르게 보인다:\n${mismatched.join('\n')}`);
  });

  await t('★ 조회 실패/행 없음이 「알레르기 없음」으로 단정되지 않는다 (중대5)', () => {
    assert.strictEqual(buildAllergens(null), null, '조회 실패가 빈 배열로 나온다');
    const empty = buildAllergens([]);
    assert.deepStrictEqual(empty.flat, [], '행이 없으면 빈 목록이 맞다');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'productService.js'), 'utf8');
    assert.ok(/allergens_available:/.test(src),
      '「정보 없음」과 「없음」을 구분할 신호가 응답에 없다');
  });

  await t('★★★ 세션46 — 행이 0개인 제품이 「알레르기 없음」으로 나가지 않는다 (과소경고)', () => {
    // ★ 이 결함은 1차·2차 검증을 모두 통과하고 **배포 후 실물 응답에서** 잡혔다.
    //   세션45 판: allergens_available = !!allergens  ← 「쿼리가 성공했는가」일 뿐이다.
    //   실측(8801043032155 짜왕 = 유탕면): allergens [] · v2 전부 빈 배열 · available **true**.
    //   밀이 든 라면이 「정보 있음 + 알레르겐 없음」으로 나갔다.
    //
    // ★★ 왜 0행이 「없음」일 수 없는가 (이 근거가 이 검사의 전부다) —
    //   product_allergens 에 INSERT 하는 지점이 저장소에 8곳인데 **전부 발견된 것만 넣는다.**
    //   「확인했으나 없음」을 기록하는 행·컬럼·코드가 존재하지 않는다.
    //   → 0행은 예외 없이 「미수집」이다. 아래가 그 사실을 소스에서 고정한다.
    const insertSrcs = [
      ['src/services/mergeService.js', true],
      ['scripts/19-apply-haccp.js', false],
      ['scripts/26-apply-haccp-dump.js', false],
    ];
    for (const [rel, required] of insertSrcs) {
      const p = path.join(__dirname, '..', rel);
      if (!fs.existsSync(p)) { assert.ok(!required, `${rel} 이 없다`); continue; }
      const s = fs.readFileSync(p, 'utf8');
      assert.ok(!/allergen_name\s*=\s*['"](없음|none|NONE)['"]/.test(s),
        `${rel} 이 「없음」 마커 행을 넣는다 — 그렇다면 이 검사의 전제가 깨진다. 정책을 다시 볼 것`);
    }

    // 계약 1 — buildAllergens 가 「수집 여부」를 함께 낸다.
    assert.strictEqual(buildAllergens([]).collected, false, '0행인데 collected 가 false 가 아니다');
    assert.strictEqual(
      buildAllergens([{ allergen_name: '밀', evidence_level: 'contains' }]).collected, true);
    // 혼입만 있어도 「수집됨」이다 — flat 이 비는 것과 정보가 없는 것은 다르다.
    const onlyMay = buildAllergens([{ allergen_name: '대두', evidence_level: 'may_contain' }]);
    assert.deepStrictEqual(onlyMay.flat, [], '혼입은 flat 에 넣지 않는다');
    assert.strictEqual(onlyMay.collected, true, '혼입만 있어도 수집된 것이다');

    // ★ 세션47 3차 검증 경미2 — `collected` 는 **유효 이름 개수**여야 한다.
    //   `rows.length` 를 쓰면 공백 이름 1행짜리 제품이 「확인했고 알레르겐 없음」으로 나간다.
    assert.strictEqual(
      buildAllergens([{ allergen_name: '   ', evidence_level: 'contains' }]).collected, false,
      '이름이 전부 필터로 떨어졌는데 collected 가 true 다 — 「없음」으로 단정되어 나간다(과소경고)');
    assert.strictEqual(
      buildAllergens([{ allergen_name: null, evidence_level: 'contains' }]).collected, false);

    // 계약 2 — 응답 배선이 collected 를 실제로 게이트로 쓴다.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'productService.js'), 'utf8');
    assert.ok(!/allergens_available:\s*!!allergens\s*,/.test(src),
      'allergens_available 이 「쿼리 성공 여부」로 되돌아갔다 — 미수집이 「없음」으로 나간다');
    assert.ok(/allergens_available:\s*!!\(allergens && allergens\.collected\)/.test(src),
      'allergens_available 이 collected 를 보지 않는다');
    for (const key of ['allergens', 'allergens_v2']) {
      assert.ok(new RegExp(`${key}:\\s*allergens && allergens\\.collected \\?`).test(src),
        `${key} 가 미수집일 때 null 로 나가지 않는다 — 빈 배열은 「확인했고 없다」로 읽힌다`);
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // §10 세션47 3차 검증 중대1 — 「혼입만 있는 제품」이 「알레르기 없음」으로 나가지 않는다
  // ════════════════════════════════════════════════════════════════════════
  await t('★★★ 중대1 — flat 이 비었는데 available=true 인 상태를 클라이언트가 구분할 수 있다', async () => {
    // 세션46 §3-7 은 **0행(미수집)** 만 고쳤다. 행이 있는데 전부 `may_contain` 이면
    //   allergens: []  +  allergens_available: true  ← 짜왕 사고와 문자 그대로 같은 응답이다.
    //   실측: 전사 68건 중 8건(12%)이 이 클래스다. 세션46 배포로 **도달 가능해졌다.**
    // flat 에 혼입을 넣는 것은 세션44·45 가 옳게 거부했으므로(구버전이 붉게 표시한다)
    //   대신 **「flat 이 전부인가」를 명시 신호로** 낸다.
    // ★★★ 세션54 — 여기 있던 **소스 문자열 정규식 두 줄을 실호출 검사로 교체했다.**
    //   지웠던 것:
    //     /^\s*allergens_flat_complete:/m
    //     /^\s*allergens_flat_complete:[\s\S]{0,200}mayContain\.length === 0/m
    //   왜 지웠나 —
    //     ① 무엇이 나오는지를 보지 않는다. 이 파일 맨 위(§0)와 test_allergen_contract.js 가
    //        기록한 대로, `true || …mayContain.length === 0` 같은 뮤테이션이 이 정규식을 통과했다.
    //     ② 구현 개선을 막는 족쇄였다. 키와 `mayContain.length === 0` 사이가 200자를 넘거나
    //        판정을 헬퍼로 빼면 **동작이 옳아도** 빨개진다. 세션54 A2 가 그 판정에
    //        `&& dropped === 0` 을 더할 때 실제로 걸릴 뻔했다.
    //   무엇으로 바꿨나 — pglite 에 행을 심고 `getProductWithTrafficLight` 를 **실제로 불러**
    //     같은 키가 상황에 따라 false 와 true 를 **둘 다** 내는지 본다.
    //     ★ 두 방향을 함께 보는 것이 핵심이다. 한 방향만 보면 상수 반환 뮤테이션
    //       (항상 true / 항상 false)이 절반은 통과한다.
    //   ⚠ 「건너뜀」은 「통과」가 아니다. pglite 가 없으면 실패시킨다.
    assert.ok(withPgliteDb,
      'pglite 가 없어 응답 계약을 실행 검증할 수 없다 (npm i -D @electric-sql/pglite)');
    const h = await withPgliteDb();
    try {
      const ins = (name, level) => h.db.query(
        `INSERT INTO product_allergens (product_id, allergen_name, status, detected_via, evidence_level)
         VALUES (1, $1, 'confirmed', 'haccp_api', $2)`, [name, level]);
      await h.db.query(
        `UPDATE products SET barcode = 'EVL0001', food_type = '과자' WHERE product_id = 1`);

      // ① 혼입만 있는 제품 — flat 은 비지만 「알레르기 없음」이 아니다.
      await ins('대두', 'may_contain');
      const onlyMayRes = await h.svc.getProductWithTrafficLight('EVL0001');
      assert.strictEqual(onlyMayRes.allergens_available, true,
        '혼입 정보를 가진 제품이 「정보 없음」으로 나간다 — 경고가 통째로 사라진다');
      assert.deepStrictEqual(onlyMayRes.allergens, [],
        'flat 에 혼입이 섞였다 — 등급을 모르는 구버전 앱이 「직접 함유」로 붉게 표시한다');
      assert.deepStrictEqual(onlyMayRes.allergens_v2.mayContain, ['대두']);
      assert.strictEqual(onlyMayRes.allergens_flat_complete, false,
        'flat 이 빈 채로 available=true 인데 flat_complete 가 false 가 아니다 — '
        + '응답이 mayContain 을 보지 않는다. 클라이언트가 「알레르기 없음」이라고 쓴다(짜왕 사고)');

      // ② 직접 함유만 있는 제품 — 같은 키가 true 도 낼 수 있어야 한다.
      await h.db.query(`DELETE FROM product_allergens WHERE product_id = 1`);
      await ins('밀', 'contains');
      const containsRes = await h.svc.getProductWithTrafficLight('EVL0001');
      assert.deepStrictEqual(containsRes.allergens, ['밀']);
      assert.deepStrictEqual(containsRes.allergens_v2.mayContain, []);
      assert.strictEqual(containsRes.allergens_flat_complete, true,
        '혼입이 하나도 없는데 flat_complete 가 true 가 아니다 — 신호가 항상 false 라 무의미해진다');
    } finally { h.restore(); }   // ★ 인스턴스는 공유 — 닫지 않는다

    // 동작 계약 — 세 상태가 서로 구분된다.
    const onlyMay = buildAllergens([{ allergen_name: '대두', evidence_level: 'may_contain' }]);
    const hasOne = buildAllergens([{ allergen_name: '밀', evidence_level: 'contains' }]);
    const none = buildAllergens([]);
    assert.strictEqual(onlyMay.v2.mayContain.length > 0 && onlyMay.flat.length === 0, true,
      '혼입만 있는 제품은 flat 이 비고 v2 에만 남는다 — 이 상태를 응답이 구분해야 한다');
    assert.strictEqual(hasOne.flat.length, 1);
    assert.strictEqual(none.collected, false);
  });

  // ════════════════════════════════════════════════════════════════════════
  // §11 세션47 3차 검증 중대3 — 컬럼 판정을 트랜잭션 안에서 하지 않는다
  // ════════════════════════════════════════════════════════════════════════
  await t('★★★ 중대3 — mergeService 가 트랜잭션을 쥔 채 두 번째 커넥션을 잡지 않는다', async () => {
    // 스키마 판정 함수는 내부에서 `db.query`(= pool.query)를 쓴다.
    //   트랜잭션 client 를 쥔 채 부르면 merge 1건이 커넥션 2개를 점유하고,
    //   DB_POOL_MAX 만큼 동시 merge 가 열리면 전원이 connectionTimeout 으로 동시에 실패한다.
    //   그 실패는 crowdsourceService 가 삼켜서 `saved:true` 로 나간다(치명1 과 같은 침묵).
    // ★★ 세션66 C6 — **검사 대상 함수가 바뀌었다.** 병합이 `product_allergens` 에 쓰지 않으므로
    //   `hasEvidenceLevelColumn()` 은 더 이상 없고, 그 자리를 024 배포순서 방어인
    //   `hasContributionReviewTable()` 이 대신한다. **지키는 규칙은 한 글자도 안 바뀌었다.**
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'mergeService.js'), 'utf8');
    const txStart = src.indexOf('await db.transaction(');
    assert.ok(txStart > 0, 'db.transaction 을 찾지 못했다 — 이 검사의 전제가 깨졌다');
    const decl = src.indexOf('const canQueueReview = await hasContributionReviewTable();');
    assert.ok(decl > 0, 'canQueueReview 판정을 찾지 못했다');
    assert.ok(decl < txStart,
      'hasContributionReviewTable() 이 트랜잭션 **안**에서 호출된다 — 풀에서 두 번째 커넥션을 잡는다');
    assert.strictEqual(
      (src.match(/await hasContributionReviewTable\(\)/g) || []).length, 1,
      '판정 호출이 2곳 이상이다 — 트랜잭션 안쪽에 다시 생겼을 수 있다');
    // ★ 옛 축도 되살아나지 않았는지 본다(다른 판정 함수를 트랜잭션 안에서 부르면 같은 사고다).
    const txBody = src.slice(txStart);
    assert.ok(!/await\s+has[A-Z]\w*\(/.test(txBody),
      '트랜잭션 «안»에서 스키마 판정 함수를 부른다 — 커넥션 중첩 획득(세션47 중대3)');
  });

  // ════════════════════════════════════════════════════════════════════════
  await closeAllDbs();   // ★ 세션47 — 공유 인스턴스는 여기서 한 번에 닫는다

  console.log(`\n${'═'.repeat(62)}`);
  console.log(`📊 세션45 알레르기 근거 등급: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})`);
  if (fail > 0) {
    console.log('\n실패 상세:');
    for (const f of failures) console.log(`  - ${f.name}\n    ${f.message}`);
    process.exit(1);
  }
  console.log('✅ 전체 통과');
}

main().catch((e) => { console.error('예상 못 한 예외:', e); process.exit(1); });
