/**
 * test_schema_constraints.js — 「제약이 살아 있는가」를 **실제 실행**으로 못 박는다 (세션48 신설)
 * ============================================================================
 * 실행:  NODE_ENV=test node tests/test_schema_constraints.js
 *        NODE_ENV=test SCHEMA_STRICT=1 node tests/test_schema_constraints.js
 *
 * ★★★ 이 파일이 왜 있는가 — 4차 검증이 실측한 것
 *
 *   `scripts/77-verify-fresh-schema.js` 의 §C 는 `EXPLAIN (GENERIC_PLAN)` 으로 SQL 을 검증한다.
 *   그런데 플래너는 **실행 시점 제약을 원리적으로 보지 못한다.** 실측표(agentE p2):
 *
 *     축                 EXPLAIN(GENERIC_PLAN)   실제 실행
 *     NOT NULL 위반      통과(못 잡음)            거부
 *     CHECK 위반         통과(못 잡음)            거부
 *     FK 위반            통과(못 잡음)            거부
 *     ENUM/VARCHAR/타입  거부 — **리터럴일 때만**  거부
 *
 *   ★ 그리고 `src/` 는 값을 전부 `$1…$n` **파라미터**로 넘긴다.
 *     `GENERIC_PLAN` 은 파라미터 값을 모른다 → 「거부」인 축조차 `src/` 에 대해서는 사각지대다.
 *   ⇒ 그래서 이 파일은 **트랜잭션 안에서 일부러 위반시키고 ROLLBACK** 한다.
 *     스키마가 「이름만 있는 껍데기」가 되는 것을 여기서 잡는다.
 *
 *   실측으로 확인된 구체적 사고 하나:
 *     `pulse_consents.user_agent` 는 `VARCHAR(500)` 인데
 *     `src/routes/userRoutes.js` 가 `req.headers['user-agent']` 를 **자르지 않고** 넣는다.
 *     501자 UA 를 보내면 `[22001] value too long` 이 나고,
 *     그 INSERT 가 회원가입과 **같은 트랜잭션**이라 `POST /api/users/me` 가 통째로 실패한다.
 *     → 「제약이 살아 있다」와 「코드가 그것을 방어한다」는 **다른 문제**다. 둘 다 여기서 본다.
 *
 * ── 무엇을 고정하나 ──────────────────────────────────────────────────────────
 *   §1 NOT NULL     : null 삽입이 실패해야 한다
 *   §2 CHECK        : 범위 밖 값이 실패해야 한다 (product_allergens.evidence_level)
 *   §3 FK           : 없는 부모키가 실패해야 한다 + ON DELETE CASCADE 가 실제로 지운다
 *   §4 VARCHAR 길이 : 초과 문자열이 실패해야 한다 (pulse_consents.user_agent(500)·consent_version(20))
 *   §5 DEFAULT      : 컬럼 생략 시 기대값이 들어와야 한다 (product_allergens.evidence_level='contains')
 *   §6 부분 UNIQUE  : predicate 안에서는 중복 실패, 밖(NULL)에서는 허용
 *   §7 ENUM         : 없는 라벨이 실패해야 한다 / 정의된 라벨은 전부 들어가야 한다
 *   §8 src/ 의 실제 INSERT/UPDATE 8종을 더미 값으로 **실행**한다
 *      (4차 검증 실측: 8종 전건 성공. 회귀로 고정한다 — 하나라도 깨지면 여기서 빨강이 된다.)
 *   §9 ★ 실제 서비스 함수·실제 라우트를 501자 UA 로 호출한다 → 22001 을 **실패 케이스로 고정**
 *
 * ── 알려진 결함 대장(KNOWN_DEFECTS) ─────────────────────────────────────────
 *   `tests/test_path_parity.js` 의 KNOWN_DIFF 와 **같은 규약**이다.
 *     · 대장에 **없는** 위반        → 실패 (새 회귀)
 *     · 대장에 **있고 그대로 재현**  → ⚠ 미해결 결함으로 보고, 기본 실행은 EXIT 0
 *     · 대장에 **있는데 이제 안 남** → 실패 (**고쳐졌으니 대장에서 지우고 단정으로 바꿔라**)
 *     · `SCHEMA_STRICT=1`           → 미해결 결함도 실패로 센다
 *   ★ 소스를 고치지 않는다. 결함을 **등록**해 다음 세션이 「몰라서 못 본」 상태가 되지 않게 한다.
 *
 * ⚠ 운영 DB 에 접속하지 않는다. pglite(진짜 Postgres/wasm) 인스턴스 **1개**를 띄워
 *   `scripts/migrations/000_baseline.sql` + `000b_seed_config.sql` 정본을 그대로 적용한다.
 */
'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIG = path.join(ROOT, 'scripts', 'migrations');

// ══════════════════════════════════════════════════════════════════════════
// 0. 출력 (기존 테스트 파일들과 같은 형식)
// ══════════════════════════════════════════════════════════════════════════
let pass = 0;
let fail = 0;
const failures = [];
const expectedIssues = [];
const STRICT = process.env.SCHEMA_STRICT === '1';

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
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

// ══════════════════════════════════════════════════════════════════════════
// 1. 알려진 결함 대장
// ══════════════════════════════════════════════════════════════════════════
/**
 * 키 : 결함 id
 * 값 : { where, what, why, fix }
 *
 * ★ 규칙 (이 세 줄이 이 절의 전부다)
 *   · 대장에 **없는** 위반이 나오면 → 실패. 새 회귀다.
 *   · 대장에 **있는데 이제 재현되지 않으면** → 실패. **고쳐졌으니 이 줄을 지우고 단정으로 바꿔라.**
 *   · 대장에 **있고 그대로 재현되면** → 「미해결 결함」으로 보고 (기본 실행에서는 EXIT 0)
 */
const KNOWN_DEFECTS = {
  PC1: {
    where: 'src/routes/userRoutes.js:63 · 177 · 215 → pulseConsentService.recordGrant',
    what: "req.headers['user-agent'] 를 자르지 않고 pulse_consents.user_agent VARCHAR(500) 에 넣는다",
    why: '501자 이상 UA 를 보내는 클라이언트(구형 웹뷰·크롤러·일부 안드로이드 웹뷰)가 오면 '
      + '[22001] value too long 이 나고, 그 INSERT 가 회원가입과 **같은 트랜잭션**이라 '
      + 'POST /api/users/me 가 통째로 실패한다 — 즉 가입 자체가 안 된다.',
    fix: "라우트에서 `(req.headers['user-agent'] || '').slice(0, 500) || null` 로 자르거나, "
      + '서비스가 방어적으로 자를 것. 고친 뒤 이 항목을 지우고 §9 를 「500자로 잘려 저장된다」 단정으로 바꿀 것.',
  },
  PC2: {
    where: 'src/routes/userRoutes.js:38 → recordGrant(client, userId, pulse_consent_version, …)',
    what: 'req.body 의 pulse_consent_version 을 길이 검증 없이 consent_version VARCHAR(20) 에 넣는다',
    why: '21자 이상 버전 문자열을 보내면 [22001] 로 가입 트랜잭션이 실패한다. '
      + '외부 입력이 그대로 DB 제약에 부딪히는 구조라 클라이언트가 400 이 아니라 500 을 받는다.',
    fix: '라우트에서 허용 버전 화이트리스트(또는 길이 검증)로 400 을 돌려줄 것.',
  },
};
function known(id, detail) {
  if (!KNOWN_DEFECTS[id]) throw new Error(`대장에 없는 결함 id: ${id}`);
  expectedIssues.push({ id, detail });
}
function knownSeen(id) { return expectedIssues.some((e) => e.id === id); }

// ══════════════════════════════════════════════════════════════════════════
// 2. 위반/성공 헬퍼 — 전부 트랜잭션 안에서 하고 ROLLBACK 한다
//    ★ 그래야 한 인스턴스(부팅 2.5초가 가장 비싸다)를 끝까지 재사용할 수 있다.
// ══════════════════════════════════════════════════════════════════════════
let db = null;

/** 실행하고 에러를 돌려준다(성공하면 null). 항상 ROLLBACK. */
async function attempt(sql, params = []) {
  await db.query('BEGIN');
  let err = null;
  try { await db.query(sql, params); } catch (e) { err = e; }
  try { await db.query('ROLLBACK'); } catch (e) { /* 이미 정리됨 */ }
  return err;
}
/** 위반이 **거부되어야 한다**. 거부되지 않으면 제약이 죽은 것이다. */
async function mustReject(sql, params, expectCode, hint) {
  const err = await attempt(sql, params);
  assert.ok(err, `거부되지 않았다 — 제약이 죽었다. ${hint || ''}\n       SQL: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
  if (expectCode) {
    assert.strictEqual(err.code, expectCode,
      `거부되긴 했지만 이유가 다르다 — 기대 SQLSTATE=${expectCode} 실제=${err.code} (${err.message.split('\n')[0]})`);
  }
  return err;
}
/** 정상 입력은 **통과해야 한다**(거짓 빨강 방지 — 제약이 과하게 걸린 것도 결함이다). */
async function mustAccept(sql, params, hint) {
  const err = await attempt(sql, params);
  assert.ok(!err, `정상 입력인데 거부됐다. ${hint || ''}\n       → [${err && err.code}] ${err && err.message.split('\n')[0]}`);
}

/** 트랜잭션 안에서 여러 문장을 돌리고 마지막에 값을 확인한 뒤 ROLLBACK. */
async function inTx(fn) {
  await db.query('BEGIN');
  try { return await fn(); } finally {
    try { await db.query('ROLLBACK'); } catch (e) { /* 이미 정리됨 */ }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 3. 픽스처 — 부모 행을 미리 커밋해 둔다 (FK 테스트가 쓸 앵커)
// ══════════════════════════════════════════════════════════════════════════
let PID = null;      // products.product_id
let UID = null;      // users.user_id

async function main() {
  console.log('먹선 — 스키마 제약 실행 검증 (tests/test_schema_constraints.js)');
  console.log(`실행: ${new Date().toISOString()}${STRICT ? '  [SCHEMA_STRICT=1]' : ''}`);

  const { PGlite } = require('@electric-sql/pglite');
  const t0 = Date.now();
  db = new PGlite();
  await db.query('SELECT 1');
  await db.exec(fs.readFileSync(path.join(MIG, '000_baseline.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(MIG, '000b_seed_config.sql'), 'utf8'));
  console.log(`pglite 부팅 + baseline 적용 ${Date.now() - t0}ms`);

  PID = (await db.query(
    `INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category,
                           serving_size, total_content, content_unit, data_source, image_url)
     VALUES ('8801111111111','앵커제품','브','제조','과자','general',30,90,'g','public_c005','http://x/i.png')
     RETURNING product_id`)).rows[0].product_id;
  UID = (await db.query(
    `INSERT INTO users (firebase_uid, email, display_name) VALUES ('anchor-uid','a@b.c','앵커')
     RETURNING user_id`)).rows[0].user_id;

  // ══════════════════════════════════════════════════════════════════════
  section('§1. NOT NULL — null 삽입이 실패해야 한다');
  // ══════════════════════════════════════════════════════════════════════
  // ★ EXPLAIN(GENERIC_PLAN) 은 이 축을 **통과**시킨다(실측). 실행만이 본다.
  await t('products.product_name NOT NULL — 이름 없는 제품은 들어갈 수 없다', async () => {
    await mustReject(`INSERT INTO products (barcode, data_source) VALUES ($1, 'public_c005')`,
      ['8802222222222'], '23502', 'product_name 이 NOT NULL 이 아니게 되면 「이름 없는 제품」이 조회 화면에 뜬다');
  });
  await t('products.data_source NOT NULL — 출처 없는 제품은 들어갈 수 없다', async () => {
    await mustReject(`INSERT INTO products (product_name) VALUES ('무출처')`, [], '23502',
      '출처가 없으면 신뢰도 표시(공적/크라우드)가 무너진다');
  });
  await t('product_allergens.allergen_name NOT NULL', async () => {
    await mustReject(`INSERT INTO product_allergens (product_id, allergen_name) VALUES ($1, NULL)`,
      [PID], '23502', '이름 없는 알레르기 행은 화면에서 빈 칩이 된다');
  });
  await t('product_allergens.evidence_level NOT NULL (020)', async () => {
    await mustReject(`INSERT INTO product_allergens (product_id, allergen_name, evidence_level)
                      VALUES ($1, '우유', NULL)`, [PID], '23502',
    'evidence_level 이 null 이면 「직접함유/혼입」 구분이 사라진다');
  });
  await t('pulse_consents.consent_version NOT NULL', async () => {
    await mustReject(`INSERT INTO pulse_consents (user_id, consent_version, consent_scope, event_type)
                      VALUES ($1, NULL, 'b2b_aggregate_insights', 'grant')`, [UID], '23502');
  });
  await t('scan_history.user_id / product_id NOT NULL', async () => {
    await mustReject(`INSERT INTO scan_history (user_id, product_id, scan_type) VALUES (NULL, $1, 'barcode')`,
      [PID], '23502');
    await mustReject(`INSERT INTO scan_history (user_id, product_id, scan_type) VALUES ($1, NULL, 'barcode')`,
      [UID], '23502');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§2. CHECK — 범위 밖 값이 실패해야 한다');
  // ══════════════════════════════════════════════════════════════════════
  await t("product_allergens.evidence_level CHECK — 'BOGUS' 는 거부된다", async () => {
    await mustReject(`INSERT INTO product_allergens (product_id, allergen_name, evidence_level)
                      VALUES ($1, '대두', 'BOGUS')`, [PID], '23514',
    'CHECK 가 사라지면 오타 등급이 들어가 알레르기 필터가 그 행을 통째로 놓친다');
  });
  await t("product_allergens.evidence_level CHECK — 허용 3종(contains·inferred·may_contain)은 통과한다", async () => {
    for (const lv of ['contains', 'inferred', 'may_contain']) {
      await mustAccept(`INSERT INTO product_allergens (product_id, allergen_name, evidence_level)
                        VALUES ($1, $2, $3)`, [PID, `알러젠-${lv}`, lv], `등급 ${lv} 이 거부됐다`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§3. FK — 없는 부모키가 실패해야 한다 + ON DELETE CASCADE');
  // ══════════════════════════════════════════════════════════════════════
  await t('nutrition_data.product_id FK — 없는 제품에 영양을 붙일 수 없다', async () => {
    await mustReject(`INSERT INTO nutrition_data (product_id, calories) VALUES (999999999, 100)`, [], '23503',
      'FK 가 없으면 고아 영양행이 쌓이고, 삭제된 제품의 영양이 계속 남는다');
  });
  await t('product_allergens.product_id FK', async () => {
    await mustReject(`INSERT INTO product_allergens (product_id, allergen_name) VALUES (999999999, '우유')`,
      [], '23503');
  });
  await t('pulse_consents.user_id FK', async () => {
    await mustReject(`INSERT INTO pulse_consents (user_id, consent_version, consent_scope, event_type)
                      VALUES (999999999, 'v2', 'b2b_aggregate_insights', 'grant')`, [], '23503');
  });
  await t('★ ON DELETE CASCADE 가 실제로 자식 행을 지운다 (제품 삭제 → 영양·알레르기·원재료)', async () => {
    await inTx(async () => {
      const pid = (await db.query(
        `INSERT INTO products (product_name, data_source) VALUES ('삭제테스트','public_c005') RETURNING product_id`
      )).rows[0].product_id;
      await db.query(`INSERT INTO nutrition_data (product_id, calories) VALUES ($1, 100)`, [pid]);
      await db.query(`INSERT INTO product_allergens (product_id, allergen_name) VALUES ($1, '우유')`, [pid]);
      await db.query(`INSERT INTO product_ingredients (product_id, raw_text, source) VALUES ($1, '밀', 'c002')`, [pid]);
      await db.query(`DELETE FROM products WHERE product_id = $1`, [pid]);
      for (const tbl of ['nutrition_data', 'product_allergens', 'product_ingredients']) {
        const n = (await db.query(`SELECT count(*)::int AS n FROM ${tbl} WHERE product_id = $1`, [pid])).rows[0].n;
        assert.strictEqual(n, 0,
          `${tbl} 에 고아 행 ${n}개가 남았다 — ON DELETE CASCADE 가 사라졌다`);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§4. VARCHAR 길이 — 초과 문자열이 실패해야 한다');
  // ══════════════════════════════════════════════════════════════════════
  // ★ 이 축이 왜 중요한가: 길이 제한은 **운영 덤프에 안 실린다**(75-dump 가 information_schema
  //   의 data_type 만 찍는다). 그래서 77 의 덤프 대조로는 「pulse_consents 계열」을 볼 수 없다.
  //   여기서 실행으로 못 박는다.
  await t('pulse_consents.user_agent VARCHAR(500) — 500자는 통과, 501자는 거부', async () => {
    await mustAccept(`INSERT INTO pulse_consents (user_id, consent_version, consent_scope, event_type, user_agent)
                      VALUES ($1, 'v2', 'b2b_aggregate_insights', 'grant', $2)`,
    [UID, 'M'.repeat(500)], '500자가 거부되면 제한이 더 좁아진 것이다');
    await mustReject(`INSERT INTO pulse_consents (user_id, consent_version, consent_scope, event_type, user_agent)
                      VALUES ($1, 'v2', 'b2b_aggregate_insights', 'grant', $2)`,
    [UID, 'M'.repeat(501)], '22001', '길이 제한이 사라지면 §9 의 결함이 조용히 「고쳐진 것처럼」 보인다');
  });
  await t('pulse_consents.consent_version VARCHAR(20) — 20자는 통과, 21자는 거부', async () => {
    await mustAccept(`INSERT INTO pulse_consents (user_id, consent_version, consent_scope, event_type)
                      VALUES ($1, $2, 'b2b_aggregate_insights', 'grant')`, [UID, 'v'.repeat(20)]);
    await mustReject(`INSERT INTO pulse_consents (user_id, consent_version, consent_scope, event_type)
                      VALUES ($1, $2, 'b2b_aggregate_insights', 'grant')`, [UID, 'v'.repeat(21)], '22001');
  });
  await t('scan_history.scan_type VARCHAR(20) — 21자는 거부', async () => {
    await mustReject(`INSERT INTO scan_history (user_id, product_id, scan_type) VALUES ($1, $2, $3)`,
      [UID, PID, 's'.repeat(21)], '22001');
  });
  await t('products.product_name 은 길이 무제한이다 (운영 덤프 기준 — 좁히면 긴 제품명이 잘린다)', async () => {
    await mustAccept(`INSERT INTO products (product_name, data_source) VALUES ($1, 'public_c005')`,
      ['긴'.repeat(600)], 'product_name 에 길이가 생기면 공공데이터 원본 제품명이 22001 로 튕긴다');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§5. DEFAULT — 컬럼을 생략하면 기대값이 들어와야 한다');
  // ══════════════════════════════════════════════════════════════════════
  const DEFAULTS = [
    // [테이블, 생략한 채로 넣는 INSERT, 확인할 컬럼, 기대값, 왜 중요한가]
    ['product_allergens', 'evidence_level', 'contains',
      '020 이전 행의 의미가 「직접 함유」다. DEFAULT 가 사라지면 NOT NULL 위반으로 모든 알레르기 저장이 실패한다'],
  ];
  for (const [tbl, col, want, why] of DEFAULTS) {
    await t(`${tbl}.${col} DEFAULT = '${want}'`, async () => {
      await inTx(async () => {
        const r = await db.query(
          `INSERT INTO product_allergens (product_id, allergen_name) VALUES ($1, '기본값테스트')
           RETURNING ${col}`, [PID]);
        assert.strictEqual(r.rows[0][col], want, `기대 '${want}' 인데 '${r.rows[0][col]}' 이다 — ${why}`);
      });
    });
  }
  await t('products 의 기본값 4종 (food_category=general · verification=unverified · verify_count=0 · is_active=true)', async () => {
    await inTx(async () => {
      const r = await db.query(
        `INSERT INTO products (product_name, data_source) VALUES ('기본값제품','public_c005')
         RETURNING food_category, verification, verify_count, is_active, serving_unit, content_unit`);
      const row = r.rows[0];
      assert.strictEqual(row.food_category, 'general', 'food_category DEFAULT 가 사라졌다 — 신호등 카테고리 분기가 전부 null 로 간다');
      assert.strictEqual(row.verification, 'unverified', 'verification DEFAULT 가 사라졌다');
      assert.strictEqual(Number(row.verify_count), 0, 'verify_count DEFAULT 0 이 사라졌다');
      assert.strictEqual(row.is_active, true, 'is_active DEFAULT true 가 사라졌다 — 새 제품이 전부 비활성으로 들어간다');
      assert.strictEqual(row.serving_unit, 'g', "serving_unit DEFAULT 'g' 가 사라졌다");
      assert.strictEqual(row.content_unit, 'g', "content_unit DEFAULT 'g' 가 사라졌다");
    });
  });
  await t('nutrition_data.data_source DEFAULT = public_nutrition', async () => {
    await inTx(async () => {
      const r = await db.query(
        `INSERT INTO nutrition_data (product_id, calories) VALUES ($1, 1) RETURNING data_source`, [PID]);
      assert.strictEqual(r.rows[0].data_source, 'public_nutrition');
    });
  });
  await t('scan_history.pulse_eligible DEFAULT = false (007 — 동의 없는 스캔이 집계에 섞이면 안 된다)', async () => {
    await inTx(async () => {
      const r = await db.query(
        `INSERT INTO scan_history (user_id, product_id, scan_type) VALUES ($1,$2,'barcode')
         RETURNING pulse_eligible`, [UID, PID]);
      assert.strictEqual(r.rows[0].pulse_eligible, false,
        'DEFAULT 가 true 로 바뀌면 **동의하지 않은 사용자의 스캔이 B2B 집계에 들어간다**');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§6. 부분 UNIQUE — predicate 안에서는 중복 실패, 밖에서는 허용');
  // ══════════════════════════════════════════════════════════════════════
  // idx_products_barcode_unique ON products (barcode) WHERE barcode IS NOT NULL
  await t('같은 바코드 2건은 거부된다 (predicate 안)', async () => {
    await mustReject(`INSERT INTO products (barcode, product_name, data_source)
                      VALUES ('8801111111111','중복바코드','public_c005')`, [], '23505',
    '부분 UNIQUE 가 사라지면 같은 바코드 제품이 여러 개 생겨 스캔 결과가 비결정적이 된다');
  });
  await t('barcode = NULL 은 여러 건 허용된다 (predicate 밖 — 바코드 없는 공공데이터 제품)', async () => {
    await inTx(async () => {
      await db.query(`INSERT INTO products (barcode, product_name, data_source) VALUES (NULL,'무바코드1','public_c005')`);
      await db.query(`INSERT INTO products (barcode, product_name, data_source) VALUES (NULL,'무바코드2','public_c005')`);
      const n = (await db.query(`SELECT count(*)::int AS n FROM products WHERE barcode IS NULL`)).rows[0].n;
      assert.ok(n >= 2,
        '전체 UNIQUE 로 바뀌면 바코드 없는 제품이 **1건만** 들어간다 — 공공데이터 대량 적재가 통째로 막힌다');
    });
  });
  await t('★ ON CONFLICT (barcode) 는 부분 UNIQUE 를 중재자로 못 쓴다 (술어를 함께 써야 한다)', async () => {
    const err = await attempt(
      `INSERT INTO products (barcode, product_name, data_source)
       VALUES ('8801111111111','x','public_c005') ON CONFLICT (barcode) DO NOTHING`);
    assert.ok(err && err.code === '42P10',
      '술어 없는 ON CONFLICT (barcode) 가 성립한다 — 인덱스가 전체 UNIQUE 로 바뀐 것이다'
      + `  (실제: ${err ? `[${err.code}] ${err.message.split('\n')[0]}` : '성공'})`);
    await mustAccept(
      `INSERT INTO products (barcode, product_name, data_source)
       VALUES ('8801111111111','x','public_c005')
       ON CONFLICT (barcode) WHERE barcode IS NOT NULL DO NOTHING`, [],
      '술어를 함께 쓴 형태마저 실패하면 인덱스가 사라진 것이다');
  });
  await t('nutrition_data(product_id) 는 전체 UNIQUE 다 (제품당 영양 1건)', async () => {
    await inTx(async () => {
      await db.query(`INSERT INTO nutrition_data (product_id, calories) VALUES ($1, 1)`, [PID]);
      let err = null;
      try { await db.query(`INSERT INTO nutrition_data (product_id, calories) VALUES ($1, 2)`, [PID]); }
      catch (e) { err = e; }
      assert.ok(err && err.code === '23505',
        'nutrition_data(product_id) UNIQUE 가 사라졌다 — mergeService 의 ON CONFLICT 가 42P10 으로 전부 실패한다');
    });
  });
  await t('product_allergens(product_id, allergen_name) UNIQUE — allergenUpsert 의 DO UPDATE 가 이것을 요구한다', async () => {
    await inTx(async () => {
      await db.query(`INSERT INTO product_allergens (product_id, allergen_name) VALUES ($1,'중복알러젠')`, [PID]);
      let err = null;
      try { await db.query(`INSERT INTO product_allergens (product_id, allergen_name) VALUES ($1,'중복알러젠')`, [PID]); }
      catch (e) { err = e; }
      assert.ok(err && err.code === '23505',
        'UNIQUE 가 사라지면 scripts/lib/allergenUpsert.js 의 ON CONFLICT … DO UPDATE 가 42P10 으로 통째로 실패한다');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§7. ENUM — 없는 라벨은 거부, 정의된 라벨은 전부 통과');
  // ══════════════════════════════════════════════════════════════════════
  await t('data_source_type — 없는 라벨은 거부된다', async () => {
    await mustReject(`INSERT INTO products (product_name, data_source) VALUES ('x','NO_SUCH_LABEL')`, [], '22P02');
  });
  await t('data_source_type — 코드가 쓰는 라벨 5종이 전부 살아 있다', async () => {
    // ★ 라벨이 하나라도 빠지면 그 경로의 INSERT 가 전건 실패한다.
    //   특히 'ocr_crowdsource' 는 OCR 기여 경로 전체가 여기에 걸린다.
    for (const lb of ['public_c005', 'public_nutrition', 'ocr_crowdsource', 'open_food_facts', 'manual_seed']) {
      await mustAccept(`INSERT INTO products (product_name, data_source) VALUES ($1, $2)`, [`x-${lb}`, lb],
        `data_source_type 에 '${lb}' 라벨이 없다`);
    }
  });
  await t('food_category — 신호등이 쓰는 12종이 전부 살아 있다', async () => {
    for (const lb of ['general', 'beverage', 'dried', 'fermented', 'sauce', 'nuts',
      'dairy', 'juice', 'whole_grain', 'alcohol', 'supplement', 'raw_ingredient']) {
      await mustAccept(`INSERT INTO products (product_name, data_source, food_category) VALUES ($1,'public_c005',$2)`,
        [`c-${lb}`, lb], `food_category 에 '${lb}' 라벨이 없다 — 그 카테고리 판정이 전건 실패한다`);
    }
  });
  await t('traffic_light_color — green/yellow/red/gray 4종', async () => {
    for (const lb of ['green', 'yellow', 'red', 'gray']) {
      await mustAccept(`INSERT INTO nutrition_traffic_light (product_id, sodium_color) VALUES ($1, $2)`,
        [PID, lb], `traffic_light_color 에 '${lb}' 가 없다`);
    }
  });
  await t('user_profile_type — 7종 (프로필별 기준 분기)', async () => {
    for (const lb of ['adult', 'pregnant', 'infant', 'child', 'hypertension', 'diabetes', 'kidney']) {
      await mustAccept(`INSERT INTO users (firebase_uid, profile_type) VALUES ($1, $2)`, [`u-${lb}`, lb],
        `user_profile_type 에 '${lb}' 가 없다`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§8. src/ 의 실제 INSERT/UPDATE 를 더미 값으로 실행한다 (회귀 고정)');
  // ══════════════════════════════════════════════════════════════════════
  // ★ 4차 검증 실측: 아래 8종은 **전건 성공**이었다. 그 사실을 회귀로 못 박는다.
  //   EXPLAIN 은 이 문장들을 「계획은 선다」로만 확인했다. NOT NULL·DEFAULT 부재·타입은
  //   실제로 실행해야만 드러난다.
  const DML = [
    ['userRoutes:36 users upsert',
      `INSERT INTO users (firebase_uid, email, display_name, profile_type)
       VALUES ('dml-uid','a@b.c','n','adult') ON CONFLICT (firebase_uid) DO NOTHING RETURNING user_id`, []],
    ['crowdsourceService:263 products insert',
      `INSERT INTO products (barcode, product_name, manufacturer, brand, food_type, serving_size, serving_unit,
                             total_content, content_unit, servings_per_container, data_source, verification, verify_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ocr_crowdsource','unverified',0) RETURNING product_id`,
      ['8809999999999', 'OCR제품', '제조', '브', '과자', 30, 'g', 90, 'g', 3]],
    ['crowdsourceService:301 nutrition upsert',
      `INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium,
                                   total_carbs, total_sugars, dietary_fiber, protein, ocr_confidence, data_source)
       VALUES ($1,1,2,3,4,5,6,7,8,9,10,88,'ocr_crowdsource') ON CONFLICT (product_id) DO NOTHING`, ['@PID']],
    ['crowdsourceService:387 contributions',
      `INSERT INTO contributions (user_id, product_id, contribution_type, data, status, device_id)
       VALUES ($1,$2,'ocr_nutrition','{}'::jsonb,'pending','dev1')`, ['@UID', '@PID']],
    ['mergeService:552 allergens upsert (evidence_level)',
      `INSERT INTO product_allergens (product_id, allergen_name, source_count, status, detected_via, evidence_level)
       VALUES ($1,'대두',2,'candidate','crowdsource_merge','may_contain')
       ON CONFLICT (product_id, allergen_name) DO UPDATE SET source_count = EXCLUDED.source_count`, ['@PID']],
    ['scanRoutes scan_history',
      `INSERT INTO scan_history (user_id, product_id, scan_type) VALUES ($1,$2,'barcode')`, ['@UID', '@PID']],
    ['pulseConsentService:53 pulse_consents',
      `INSERT INTO pulse_consents (user_id, consent_version, consent_scope, event_type)
       VALUES ($1,'v2','b2b_aggregate_insights','grant')`, ['@UID']],
    ['productModel:340 traffic_light upsert',
      `INSERT INTO nutrition_traffic_light (product_id, food_category, sodium_color, sodium_pct_dv, sodium_basis,
         sugars_color, sugars_pct_dv, sugars_basis, sat_fat_color, sat_fat_pct_dv, sat_fat_basis,
         total_fat_color, total_fat_pct_dv, total_fat_basis, cholesterol_color, cholesterol_pct_dv,
         protein_color, protein_pct_dv, fiber_color, fiber_pct_dv, trans_fat_color,
         is_dried_exception, context_messages, multi_serving_count, evaluated_at)
       VALUES ($1,'general','green',5,'per_serving','green',2,'per_serving','yellow',12,'per_serving',
               'green',9,'per_serving','green',3,'green',4,'green',2,'green',FALSE,'[]'::jsonb,1,NOW())
       ON CONFLICT (product_id) DO UPDATE SET sodium_color = EXCLUDED.sodium_color`, ['@PID']],
  ];
  for (const [name, sql, rawParams] of DML) {
    await t(`실행 성공: ${name}`, async () => {
      const params = rawParams.map((v) => (v === '@PID' ? PID : v === '@UID' ? UID : v));
      const err = await attempt(sql, params);
      assert.ok(!err,
        `4차 검증에서는 성공했던 문장이 실패한다 — [${err && err.code}] ${err && err.message.split('\n')[0]}`);
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§9. ★ 실제 서비스·실제 라우트를 501자 UA 로 호출한다 (제약 ≠ 방어)');
  // ══════════════════════════════════════════════════════════════════════
  // ★ 여기서부터는 SQL 문자열이 아니라 **애플리케이션 코드**를 호출한다.
  //   「제약이 살아 있다」(§4)와 「코드가 그것을 방어한다」는 다른 문제이기 때문이다.
  //   소스는 고치지 않는다 — 결함을 대장(KNOWN_DEFECTS)에 등록해 다음 세션이 모르고 지나가지 않게 한다.

  // src/config/database.js 를 pglite 로 갈아끼운다 (파일은 건드리지 않는다).
  const dbPath = require.resolve(path.join(ROOT, 'src', 'config', 'database.js'));
  const shim = {
    pool: {
      totalCount: 1, idleCount: 1, waitingCount: 0, options: { max: 1 },
      connect: async () => ({ query: (q, p) => db.query(q, p), release() {} }),
      query: (q, p) => db.query(q, p),
      on() {},
    },
    query: (q, p) => db.query(q, p),
    async transaction(cb) {
      await db.query('BEGIN');
      try { const r = await cb({ query: (q, p) => db.query(q, p) }); await db.query('COMMIT'); return r; }
      catch (e) { await db.query('ROLLBACK'); throw e; }
    },
    healthCheck: async () => ({ status: 'healthy' }),
  };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };

  const pulseConsentService = require(path.join(ROOT, 'src', 'services', 'pulseConsentService.js'));

  await t('[PC1] 서비스 함수 recordGrant 를 501자 UA 로 호출하면 22001 이 난다 (대장 등록)', async () => {
    await db.query('BEGIN');
    let err = null;
    try {
      await pulseConsentService.recordGrant({ query: (q, p) => db.query(q, p) }, UID, 'v2',
        { user_agent: 'M'.repeat(501) });
    } catch (e) { err = e; }
    try { await db.query('ROLLBACK'); } catch (e) { /* ignore */ }

    if (!err) {
      throw new Error('[PC1 고쳐졌다] 501자 UA 가 이제 통과한다 — 라우트/서비스가 자르기 시작했거나 제약이 사라졌다.\n'
        + '       고쳐진 것이라면 KNOWN_DEFECTS.PC1 을 지우고 「500자로 잘려 저장된다」 단정으로 바꿀 것.\n'
        + '       제약이 사라진 것이라면 §4 가 먼저 빨강이어야 한다 — §4 가 초록인데 여기만 통과하면 그쪽을 의심할 것.');
    }
    assert.strictEqual(err.code, '22001',
      `기대한 실패는 22001(value too long) 인데 [${err.code}] 다: ${err.message.split('\n')[0]}`);
    known('PC1', `recordGrant(501자 UA) → [22001] ${err.message.split('\n')[0]}`);
  });

  await t('[PC1] 정상 길이(500자) UA 는 통과한다 (거짓 빨강 방지)', async () => {
    await db.query('BEGIN');
    let err = null;
    try {
      await pulseConsentService.recordGrant({ query: (q, p) => db.query(q, p) }, UID, 'v2',
        { user_agent: 'M'.repeat(500) });
    } catch (e) { err = e; }
    try { await db.query('ROLLBACK'); } catch (e) { /* ignore */ }
    assert.ok(!err, `500자 UA 마저 실패한다 — [${err && err.code}] ${err && err.message.split('\n')[0]}`);
  });

  await t('[PC2] recordGrant 를 21자 버전으로 호출하면 22001 이 난다 (외부 입력 무검증 · 대장 등록)', async () => {
    await db.query('BEGIN');
    let err = null;
    try {
      await pulseConsentService.recordGrant({ query: (q, p) => db.query(q, p) }, UID, 'v'.repeat(21), {});
    } catch (e) { err = e; }
    try { await db.query('ROLLBACK'); } catch (e) { /* ignore */ }
    if (!err) {
      throw new Error('[PC2 고쳐졌다] 21자 consent_version 이 이제 통과한다 — KNOWN_DEFECTS.PC2 를 지우고 '
        + '라우트가 400 을 돌려주는지 확인하는 단정으로 바꿀 것.');
    }
    assert.strictEqual(err.code, '22001', `기대 22001, 실제 [${err.code}]`);
    known('PC2', `recordGrant(21자 consent_version) → [22001] ${err.message.split('\n')[0]}`);
  });

  // ── 라우트 수준 — 「가입 자체가 실패한다」를 응답으로 확인한다 ─────────────
  // ★ §9 의 핵심. pulse_consents INSERT 가 회원가입과 **같은 트랜잭션** 안에 있어서
  //   UA 하나 때문에 POST /api/users/me 가 2xx 를 못 준다는 것을 응답으로 못 박는다.
  await t('[PC1] POST /api/users/me 를 501자 User-Agent 로 호출하면 가입이 통째로 실패한다', async () => {
    const admin = require('firebase-admin');
    Object.defineProperty(admin, 'auth', {
      value: () => ({ verifyIdToken: async () => ({ uid: 'ua-test-uid', email: 'ua@t.c', name: 'UA' }) }),
      writable: true,
      configurable: true,
    });
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      || JSON.stringify({ type: 'service_account', project_id: 'test' });
    require(path.join(ROOT, 'src', 'config', 'firebase')).initFirebase();

    const app = require(path.join(ROOT, 'src', 'app.js'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    const post = (body, ua) => new Promise((resolve) => {
      const payload = JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port, path: '/api/users/me', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: 'Bearer faketoken',
          'User-Agent': ua,
        },
      }, (res) => {
        let b = ''; res.on('data', (c) => { b += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', (e) => resolve({ status: 0, body: String(e) }));
      req.end(payload);
    });

    try {
      const long = await post({ pulse_consent_version: 'v2' }, 'M'.repeat(501));
      if (long.status >= 200 && long.status < 300) {
        throw new Error('[PC1 고쳐졌다] 501자 UA 로도 가입이 성공한다 — 라우트가 자르기 시작했다. '
          + 'KNOWN_DEFECTS.PC1 을 지우고 「잘려서 저장된다」 단정으로 바꿀 것.');
      }
      known('PC1', `POST /api/users/me (UA 501자) → HTTP ${long.status} — 가입 자체가 실패한다`);

      // 대조군: 짧은 UA 면 가입이 된다 (즉 원인이 UA 길이임을 증명한다)
      const short = await post({ pulse_consent_version: 'v2' }, 'Mozilla/5.0 (short)');
      assert.ok(short.status >= 200 && short.status < 300,
        `짧은 UA 로도 가입이 실패한다 — 원인이 UA 길이가 아니다. HTTP ${short.status}: ${short.body.slice(0, 200)}`);
    } finally {
      server.close();
    }
  });

  await db.close();

  // ══════════════════════════════════════════════════════════════════════
  // 결과 보고
  // ══════════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`📊 세션48 스키마 제약 실행 검증: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})`);

  if (expectedIssues.length > 0) {
    console.log(`\n⚠  미해결 결함(대장 등록) ${expectedIssues.length}건 — 값이 대장과 같다:`);
    const byId = {};
    for (const e of expectedIssues) (byId[e.id] = byId[e.id] || []).push(e.detail);
    for (const [id, list] of Object.entries(byId)) {
      const d = KNOWN_DEFECTS[id];
      console.log(`   ${id}  ${d.where}`);
      console.log(`        무엇: ${d.what}`);
      console.log(`        왜:   ${d.why}`);
      console.log(`        고칠 때: ${d.fix}`);
      for (const detail of list) console.log(`        · ${detail}`);
    }
    console.log('   ★ 이것들은 아직 고쳐지지 않았다. 고친 뒤 SCHEMA_STRICT=1 이 초록이어야 한다.');
  }

  // 대장에 있는데 이번에 한 번도 재현되지 않은 결함 → 실패 (고쳐졌다는 뜻이다)
  for (const id of Object.keys(KNOWN_DEFECTS)) {
    if (!knownSeen(id)) {
      fail += 1;
      failures.push({
        name: `[${id} 고쳐졌다]`,
        message: `대장의 결함이 이번 실행에서 한 번도 재현되지 않았다 — ${KNOWN_DEFECTS[id].what}\n`
          + '    ⇒ KNOWN_DEFECTS 에서 이 줄을 지우고 단정으로 바꾼 뒤 인수인계에 적을 것',
      });
    }
  }

  if (fail > 0) {
    console.log('\n실패 상세:');
    for (const f of failures) console.log(`  - ${f.name}\n    ${f.message}`);
    process.exit(1);
  }

  if (STRICT && expectedIssues.length > 0) {
    console.log(`\n❌ SCHEMA_STRICT=1 — 미해결 결함 ${expectedIssues.length}건을 실패로 센다.`);
    process.exit(1);
  }

  console.log('✅ 새 위반 없음 (알려진 결함은 위에 나열). 제약은 살아 있다.');
  process.exit(0);
}

main().catch((e) => { console.error('예상 못 한 예외:', e); process.exit(1); });
