/**
 * 70-probe-gap-priority.js — 캡처 우선순위 축 실측 (읽기 전용)  2026-07-29 세션41
 * ============================================================================
 * 왜 이 스크립트가 필요한가
 *   갭 품목이 약 128,000 건이다(IP/nutrition_gap_decision_2026-07-23.md §4).
 *   전량 공략은 불가능하고, 웹검색으로 건별 생존 확인도 불가능하다.
 *   → 실제 병목은 "무엇을 **먼저** 찍을 것인가" 다.
 *   이 스크립트는 그 우선순위를 **추측이 아니라 실측으로** 정하기 위한 진단이다.
 *
 * 답하는 질문
 *   Q1. 갭 유형 분해 — 원재료만 / 영양만 / 둘 다 없음  (재확인 + 바코드 유무 교차)
 *   Q2. 바코드가 있는가 — 없으면 앱 스캔으로 도달 불가하니 캡처 가치가 낮다
 *   Q3. 품목제조신고일(연도)별 분포 — 신고일이 최근일수록 현재 판매 확률이 높다
 *   Q4. 제조사별 갭 집중도 — 대형 제조사일수록 쿠팡 취급 확률이 높다
 *   Q5. 저비용 승격 후보 규모 — "영양 有 · 원재료 無" 는 캡처 1장이면 완성된다
 *
 * ★ 안전 설계 (세션40 §3-3 교훈 반영)
 *   - 읽기 전용을 **스타트업 파라미터**로 건다. connect 핸들러에서 SET 을 던지면
 *     pool 이 이미 시작한 쿼리와 경합해서 적용이 보장되지 않는다.
 *   - 건 뒤에 `SHOW` 로 **엔진에 직접 물어보고** on 이 아니면 즉시 중단한다.
 *     "걸었다고 생각한다" 와 "걸렸다" 는 다르다.
 *   - products 실제 컬럼을 information_schema 로 먼저 확인하고, 없는 컬럼은 건너뛴다.
 *     001_init_schema.sql 은 낡았다(세션40 §3-4). 하드코딩 금지.
 *
 * 실행 (제이 PC — 샌드박스는 Railway Postgres 미접속)
 *   cd "D:\서박사의 영양공식\backends\먹선\meokseon-server"
 *   node scripts/70-probe-gap-priority.js
 *   node scripts/70-probe-gap-priority.js --self-test    # DB 없이 로직만 검증
 */
'use strict';

try { require('dotenv').config(); } catch (_) { /* 환경변수 직접 사용 */ }

const SELF_TEST = process.argv.includes('--self-test');

// ────────────────────────────────────────────────────────────────────────────
// 순수 함수 (self-test 대상) — DB 없이 검증 가능한 로직만 분리
// ────────────────────────────────────────────────────────────────────────────

/** 갭 유형 라벨. has_ing/has_nut 조합 → 사람이 읽는 이름 + 필요한 캡처 장수 */
function gapLabel(hasIng, hasNut) {
  if (hasIng && hasNut) return { key: 'both', label: '완성(원재료+영양)', shots: 0 };
  if (hasNut && !hasIng) return { key: 'nut_only', label: '영양만 有 → 원재료 필요', shots: 1 };
  if (hasIng && !hasNut) return { key: 'ing_only', label: '원재료만 有 → 영양 필요', shots: 1 };
  return { key: 'neither', label: '둘 다 없음', shots: 2 };
}

/**
 * 제이가 캡처 시 쓸 파일명 규칙 (세션40 워크리스트 규약 계승 + 이번 확장)
 *   둘 다 필요 → `<번호>.jpg`            (한 장에 둘 다 담긴 경우)
 *   원재료만   → `<번호>_원재료.jpg`
 *   영양만     → `<번호>_영양.jpg`
 * 세션40 캡처는 `_원재료` 접미사를 썼다. `_영양` 을 이번에 추가한다.
 */
function captureFilenames(gapKey, seq) {
  const n = String(seq).padStart(3, '0');
  if (gapKey === 'nut_only') return [`${n}_원재료.jpg`];
  if (gapKey === 'ing_only') return [`${n}_영양.jpg`];
  if (gapKey === 'neither') return [`${n}.jpg`, `${n}_원재료.jpg`, `${n}_영양.jpg`];
  return [];
}

/** 국내 유통 바코드 판별. 880 = 대한민국 GS1 국가코드. 13자리 EAN-13 기준. */
function isDomesticRetailBarcode(bc) {
  if (!bc) return false;
  const t = String(bc).trim();
  if (!/^\d{8,14}$/.test(t)) return false;
  return t.length === 13 && t.startsWith('880');
}

/** 신고일 문자열 → 연도. 식약처 필드는 'YYYYMMDD' 또는 'YYYY-MM-DD' 로 섞여 들어온다. */
function reportYear(s) {
  if (!s) return null;
  const t = String(s).trim();
  const m = t.match(/^(\d{4})/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  if (y < 1990 || y > 2100) return null;   // 명백한 오염값 배제
  return y;
}

// ────────────────────────────────────────────────────────────────────────────
// self-test — DB 없이 위 순수 함수만 검증
// ────────────────────────────────────────────────────────────────────────────
if (SELF_TEST) {
  let pass = 0, fail = 0;
  const eq = (name, got, exp) => {
    const ok = JSON.stringify(got) === JSON.stringify(exp);
    if (ok) pass++; else { fail++; console.log(`  ✗ ${name}: ${JSON.stringify(got)} ≠ ${JSON.stringify(exp)}`); }
  };

  eq('gapLabel 완성',      gapLabel(true, true).key,   'both');
  eq('gapLabel 영양만',    gapLabel(false, true).key,  'nut_only');
  eq('gapLabel 원재료만',  gapLabel(true, false).key,  'ing_only');
  eq('gapLabel 둘다없음',  gapLabel(false, false).key, 'neither');
  eq('shots 영양만=1',     gapLabel(false, true).shots, 1);
  eq('shots 둘다없음=2',   gapLabel(false, false).shots, 2);

  eq('파일명 영양만',   captureFilenames('nut_only', 7),  ['007_원재료.jpg']);
  eq('파일명 원재료만', captureFilenames('ing_only', 12), ['012_영양.jpg']);
  eq('파일명 둘다',     captureFilenames('neither', 3),   ['003.jpg', '003_원재료.jpg', '003_영양.jpg']);
  eq('파일명 완성',     captureFilenames('both', 1),      []);

  eq('바코드 국내13',   isDomesticRetailBarcode('8801043032667'), true);
  eq('바코드 해외',     isDomesticRetailBarcode('4901234567894'), false);
  eq('바코드 8자리',    isDomesticRetailBarcode('88012345'),      false);
  eq('바코드 null',     isDomesticRetailBarcode(null),            false);
  eq('바코드 문자혼입', isDomesticRetailBarcode('880abc4567890'), false);
  eq('바코드 공백',     isDomesticRetailBarcode(' 8801043032667 '), true);

  eq('연도 YYYYMMDD',   reportYear('20240815'),   2024);
  eq('연도 하이픈',     reportYear('2019-03-02'), 2019);
  eq('연도 null',       reportYear(null),         null);
  eq('연도 오염',       reportYear('0001'),       null);
  eq('연도 빈문자',     reportYear(''),           null);
  eq('연도 문자',       reportYear('미상'),        null);

  console.log(`\n[self-test] 통과 ${pass} / 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}

// ────────────────────────────────────────────────────────────────────────────
// DB 진단
// ────────────────────────────────────────────────────────────────────────────
const { Pool } = require('pg');

const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'meokseon',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
    };
poolConfig.connectionTimeoutMillis = 25000;
poolConfig.statement_timeout = 600000;          // 14만 품목 그룹 집계 — 10분
poolConfig.keepAlive = true;
// ★ 읽기 전용을 스타트업 파라미터로. connect 핸들러 SET 은 경합한다(세션40 §3-3①).
poolConfig.options = '-c default_transaction_read_only=on';

const pool = new Pool(poolConfig);
const fmt = (n) => (n == null ? '?' : Number(n).toLocaleString());
const pct = (a, b) => (b ? ((Number(a) / Number(b)) * 100).toFixed(1) + '%' : '-');

async function assertReadOnly() {
  const r = await pool.query('SHOW default_transaction_read_only');
  const v = r.rows[0].default_transaction_read_only;
  if (v !== 'on') {
    throw new Error(`읽기 전용이 걸리지 않았다 (SHOW=${v}). 중단한다 — 진단 스크립트가 DB 를 건드릴 수 없어야 한다.`);
  }
  console.log(`[안전] default_transaction_read_only = ${v}  (엔진 확인됨)`);
}

/** products 실제 컬럼 목록 — 001_init_schema.sql 은 낡았다. 엔진에 물어본다. */
async function productColumns() {
  const r = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products'
  `);
  return new Set(r.rows.map((x) => x.column_name));
}

/** 신고일 후보 컬럼 중 실제로 존재하는 것을 고른다. */
function pickDateCol(cols) {
  for (const c of ['prms_dt_i1250', 'prms_dt', 'report_date', 'created_at']) {
    if (cols.has(c)) return c;
  }
  return null;
}

const GAP_CTE = (dateCol, hasBarcode) => `
  WITH g AS (
    SELECT p.c005_report_no                                          AS report_no,
           BOOL_OR(pi.product_id IS NOT NULL)                        AS has_ing,
           BOOL_OR(nd.product_id IS NOT NULL)                        AS has_nut,
           ${hasBarcode
             ? `BOOL_OR(p.barcode IS NOT NULL AND btrim(p.barcode) <> '') AS has_bc,
                BOOL_OR(p.barcode ~ '^880[0-9]{10}$')                     AS has_kr_bc,`
             : `FALSE AS has_bc, FALSE AS has_kr_bc,`}
           ${dateCol ? `MAX(NULLIF(regexp_replace(p.${dateCol}::text, '[^0-9]', '', 'g'), '')) AS dt` : `NULL::text AS dt`}
    FROM products p
    LEFT JOIN (
      SELECT DISTINCT product_id FROM product_ingredients
      WHERE raw_text IS NOT NULL AND btrim(raw_text) <> ''
    ) pi ON pi.product_id = p.product_id
    LEFT JOIN (SELECT DISTINCT product_id FROM nutrition_data) nd ON nd.product_id = p.product_id
    WHERE p.c005_report_no IS NOT NULL AND p.c005_report_no <> '' AND p.is_active
    GROUP BY p.c005_report_no
  )
`;

async function q1_gapByBarcode(dateCol, hasBarcode) {
  const r = await pool.query(`
    ${GAP_CTE(dateCol, hasBarcode)}
    SELECT
      CASE WHEN has_ing AND has_nut THEN 'both'
           WHEN has_nut THEN 'nut_only'
           WHEN has_ing THEN 'ing_only'
           ELSE 'neither' END                              AS gap,
      COUNT(*)::bigint                                     AS n,
      COUNT(*) FILTER (WHERE has_bc)::bigint               AS n_bc,
      COUNT(*) FILTER (WHERE has_kr_bc)::bigint            AS n_kr_bc
    FROM g GROUP BY 1 ORDER BY 2 DESC
  `);
  return r.rows;
}

async function q3_byYear(dateCol, hasBarcode) {
  if (!dateCol) return [];
  const r = await pool.query(`
    ${GAP_CTE(dateCol, hasBarcode)}
    SELECT COALESCE(substring(dt from 1 for 4), '(없음)')   AS yr,
           COUNT(*)::bigint                                 AS n,
           COUNT(*) FILTER (WHERE NOT (has_ing AND has_nut))::bigint AS n_gap,
           COUNT(*) FILTER (WHERE NOT (has_ing AND has_nut) AND has_kr_bc)::bigint AS n_gap_bc
    FROM g GROUP BY 1 ORDER BY 1 DESC LIMIT 20
  `);
  return r.rows;
}

async function q4_byMaker(dateCol, hasBarcode, makerCol) {
  const r = await pool.query(`
    WITH g AS (
      SELECT p.c005_report_no AS report_no,
             MAX(p.${makerCol}) AS maker,
             BOOL_OR(pi.product_id IS NOT NULL) AS has_ing,
             BOOL_OR(nd.product_id IS NOT NULL) AS has_nut,
             ${hasBarcode ? `BOOL_OR(p.barcode ~ '^880[0-9]{10}$') AS has_kr_bc` : `FALSE AS has_kr_bc`}
      FROM products p
      LEFT JOIN (
        SELECT DISTINCT product_id FROM product_ingredients
        WHERE raw_text IS NOT NULL AND btrim(raw_text) <> ''
      ) pi ON pi.product_id = p.product_id
      LEFT JOIN (SELECT DISTINCT product_id FROM nutrition_data) nd ON nd.product_id = p.product_id
      WHERE p.c005_report_no IS NOT NULL AND p.c005_report_no <> '' AND p.is_active
      GROUP BY p.c005_report_no
    )
    SELECT COALESCE(NULLIF(btrim(maker), ''), '(없음)') AS maker,
           COUNT(*)::bigint AS n_total,
           COUNT(*) FILTER (WHERE NOT (has_ing AND has_nut) AND has_kr_bc)::bigint AS n_gap_bc,
           COUNT(*) FILTER (WHERE has_nut AND NOT has_ing AND has_kr_bc)::bigint   AS n_cheap
    FROM g GROUP BY 1 ORDER BY 3 DESC LIMIT 30
  `);
  return r.rows;
}

(async () => {
  console.log('=== 70. 캡처 우선순위 축 실측 (읽기 전용) ===');
  console.log(`실행: ${new Date().toISOString()}\n`);

  await assertReadOnly();

  const cols = await productColumns();
  const hasBarcode = cols.has('barcode');
  const dateCol = pickDateCol(cols);
  const makerCol = cols.has('manufacturer') ? 'manufacturer' : (cols.has('maker') ? 'maker' : null);
  console.log(`[스키마] barcode=${hasBarcode} · 신고일컬럼=${dateCol || '(없음)'} · 제조사컬럼=${makerCol || '(없음)'}`);
  if (!cols.has('c005_report_no')) throw new Error('products.c005_report_no 없음 — 쿼리 전제가 깨졌다. 중단.');

  // ── Q1 ──
  console.log('\n── Q1·Q2·Q5. 갭 유형 × 바코드 (active · 품목보고번호 보유) ──');
  const rows = await q1_gapByBarcode(dateCol, hasBarcode);
  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  console.log(`  총 품목 ${fmt(total)}`);
  console.log('  유형                          품목수      바코드有      ★국내880 13자리');
  for (const r of rows) {
    const meta = gapLabel(r.gap === 'both' || r.gap === 'ing_only', r.gap === 'both' || r.gap === 'nut_only');
    console.log(
      `  ${meta.label.padEnd(24)} ${fmt(r.n).padStart(9)} (${pct(r.n, total).padStart(5)}) ` +
      `${fmt(r.n_bc).padStart(9)}  ${fmt(r.n_kr_bc).padStart(9)}   [캡처 ${meta.shots}장]`
    );
  }
  // ★★ 세션42 정정 — 세션41 실측이 프레이밍을 뒤집었다.
  //   IP/nutrition_gap_decision_2026-07-23.md §4 와 이 스크립트 초판은
  //   저비용 후보를 nut_only(영양 有·원재료 無)로 잡았다. 실측 결과:
  //     ing_only 42,728  vs  nut_only 9,892  →  **ing_only 가 4.3배 크다**
  //   그리고 ing_only 는 **영양신호등이 아예 안 켜지는** 집단이다.
  //   nut_only 는 원재료가 없을 뿐 신호등은 이미 켜져 있다.
  //   → 1장당 제품 가치 상승폭이 가장 큰 것은 **영양성분표 1장**이다.
  const cheapIng = rows.find((r) => r.gap === 'ing_only');
  const cheapNut = rows.find((r) => r.gap === 'nut_only');
  if (cheapIng) {
    console.log(`\n  ★ 최우선 캡처 대상(원재료 有·영양 無·국내바코드): ${fmt(cheapIng.n_kr_bc)} 품목`);
    console.log('     영양성분표 **1장**이면 완성으로 승격된다. 게다가 이 집단은 지금 신호등이 아예 안 켜진다.');
  }
  if (cheapNut) {
    console.log(`  · 차순위(영양 有·원재료 無·국내바코드): ${fmt(cheapNut.n_kr_bc)} 품목`);
    console.log('     원재료 1장이면 완성이지만, 신호등은 이미 켜져 있어 가치 상승폭이 작다.');
  }

  // ── Q3 ──
  if (dateCol) {
    console.log(`\n── Q3. 신고일(${dateCol}) 연도별 — 최근일수록 현재 판매 확률이 높다 ──`);
    console.log('  연도      품목수       갭품목      ★갭+국내바코드');
    for (const r of await q3_byYear(dateCol, hasBarcode)) {
      console.log(`  ${String(r.yr).padEnd(8)} ${fmt(r.n).padStart(9)} ${fmt(r.n_gap).padStart(11)} ${fmt(r.n_gap_bc).padStart(15)}`);
    }
  } else {
    console.log('\n── Q3. 건너뜀 — 신고일 컬럼이 products 에 없다 ──');
  }

  // ── Q4 ──
  if (makerCol) {
    console.log(`\n── Q4. 제조사별 갭 집중도 상위 30 (${makerCol}) ──`);
    console.log('  제조사                              전체      ★갭+바코드    저비용(원재료만필요)');
    for (const r of await q4_byMaker(dateCol, hasBarcode, makerCol)) {
      console.log(`  ${String(r.maker).slice(0, 32).padEnd(34)} ${fmt(r.n_total).padStart(7)} ${fmt(r.n_gap_bc).padStart(12)} ${fmt(r.n_cheap).padStart(16)}`);
    }
  } else {
    console.log('\n── Q4. 건너뜀 — 제조사 컬럼이 products 에 없다 ──');
  }

  await pool.end();
  console.log('\nDONE (읽기 전용 — DB 변경 없음)');
})().catch(async (e) => {
  console.error('\n오류:', e.message || e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
