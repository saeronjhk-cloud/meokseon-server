/**
 * 71-probe-category.js — 갭 품목 식품유형·제품명 실측 (읽기 전용)  2026-07-29 세션42
 * ============================================================================
 * 왜 이 스크립트가 필요한가 — 세션41 이 남긴 두 개의 **추정**을 실측으로 바꾼다.
 *
 *   ① 건강기능식품 OEM 오염 규모  (세션41 §4-4)
 *      제조사명으로 "비오팜·코스맥스엔비티·노바렉스 …" 11곳 ≈ 4,950 품목을 건기식으로 **추정**했다.
 *      추정으로 캡처 대상을 빼면, 틀렸을 때 멀쩡한 제품을 통째로 버린다.
 *      → food_type 분포를 직접 세고, raccTable.isSupplement 로 판정한다.
 *
 *   ② 제품명 보유율 — 리스트업의 **하드 필터**
 *      제품명이 비면 제이가 쿠팡에서 검색할 방법이 없다. 캡처 리스트에 넣을 수 없다.
 *      갭 128,000 건 중 실제로 "찍을 수 있는" 모수가 몇인지 여기서 정해진다.
 *      바코드·신고일은 변별력이 없다고 이미 판명났다(세션41 §4-3). 남은 축은 이것이다.
 *
 *   ③ RACC 매칭률 — per_total 환산이 실제로 몇 %에서 작동하는가
 *      세션42 에서 신호등에 per_total → RACC 환산을 배선했다(§1-1).
 *      RACC 가 매칭 안 되면 "총량 = 1회분" 으로 떨어진다(제이 확정 §3-1).
 *      그 fallback 이 몇 %에 적용될지 모르면 배선의 실효성을 알 수 없다.
 *
 * ★ 안전 설계 — 70-probe 와 동일 패턴을 그대로 복제했다 (세션40 §3-3 교훈)
 *   - 읽기 전용을 **스타트업 파라미터**로 건다 (connect 핸들러 SET 은 경합한다)
 *   - 건 뒤 `SHOW` 로 **엔진에 직접** 확인, on 이 아니면 즉시 중단
 *   - information_schema 로 실제 컬럼 확인 후 없는 컬럼은 건너뜀 (001_init_schema.sql 은 낡았다)
 *   - `--self-test` 로 DB 없이 순수 함수 검증
 *
 * 실행 (제이 PC — 샌드박스는 Railway Postgres 미접속)
 *   cd "D:\서박사의 영양공식\backends\먹선\meokseon-server"
 *   node scripts/71-probe-category.js --self-test     # DB 없이 로직만 검증 (먼저 이것부터)
 *   node scripts/71-probe-category.js                 # 실제 진단
 *   node scripts/71-probe-category.js --top 60        # 식품유형 상위 N (기본 40)
 *
 * 출력은 전부 콘솔이다. DB 를 한 글자도 바꾸지 않는다.
 */
'use strict';

try { require('dotenv').config(); } catch (_) { /* 환경변수 직접 사용 */ }

const SELF_TEST = process.argv.includes('--self-test');
const TOP_N = (() => {
  const i = process.argv.indexOf('--top');
  const v = i >= 0 ? parseInt(process.argv[i + 1], 10) : NaN;
  return Number.isFinite(v) && v > 0 && v <= 300 ? v : 40;
})();

// ────────────────────────────────────────────────────────────────────────────
// 순수 함수 (self-test 대상) — DB 없이 검증 가능한 로직만 분리
// ────────────────────────────────────────────────────────────────────────────

/**
 * 제품명이 쿠팡 검색에 쓸 수 있는 형태인가.
 * ★ 이게 리스트업의 하드 필터다. 여기서 false 면 캡처 리스트에 못 넣는다.
 * 실측으로 확인된 쓰레기 패턴:
 *   - 빈 값 / 공백만
 *   - '(없음)' '미상' '-' 같은 자리표시자
 *   - 한글·영문 글자가 하나도 없는 값(숫자·기호만) → 검색 불가
 *   - 2글자 미만
 */
const NAME_PLACEHOLDERS = new Set(['(없음)', '없음', '미상', '-', '.', 'null', 'NULL', 'N/A', 'n/a', '?']);

function isSearchableName(name) {
  if (name == null) return false;
  const t = String(name).trim();
  if (t.length < 2) return false;
  if (NAME_PLACEHOLDERS.has(t)) return false;
  if (!/[가-힣a-zA-Z]/.test(t)) return false;   // 글자가 없으면 검색어가 못 된다
  return true;
}

/**
 * 제조사명 정규화 — 공장·지점 토큰을 지운다.
 * scripts/lib/official_source.js 와 **같은 규칙**이다(세션41). 순서가 중요하다:
 * 공백을 지우기 전에 공장 토큰을 지워야 한다. 공백이 토큰 경계 정보이기 때문.
 *   '(주)신세계푸드 음성공장' → '신세계푸드'   (공백 먼저 지우면 '신세계푸드음성' 이 된다)
 */
function normalizeMaker(s) {
  if (!s) return '';
  let t = String(s).trim();
  t = t.replace(/\((주|유|사|재)\)/g, ' ');
  t = t.replace(/주식회사|유한회사|합자회사/g, ' ');
  t = t.replace(/\s+\S*(공장|지점|사업장|본부|센터|영업소)\s*$/g, ' ');
  t = t.replace(/\s*\d*\s*(공장|지점|사업장)\s*$/g, ' ');
  return t.replace(/\s+/g, '');
}

/** 갭 유형 라벨 — 70-probe 와 동일 규약(용어를 갈라놓으면 두 진단을 대조할 수 없다) */
function gapKey(hasIng, hasNut) {
  if (hasIng && hasNut) return 'both';
  if (hasNut) return 'nut_only';
  if (hasIng) return 'ing_only';
  return 'neither';
}

// ────────────────────────────────────────────────────────────────────────────
// self-test
// ────────────────────────────────────────────────────────────────────────────
if (SELF_TEST) {
  let pass = 0; let fail = 0;
  const eq = (name, got, exp) => {
    const ok = JSON.stringify(got) === JSON.stringify(exp);
    if (ok) pass += 1;
    else { fail += 1; console.log(`  ✗ ${name}: ${JSON.stringify(got)} ≠ ${JSON.stringify(exp)}`); }
  };

  // ── 제품명 하드 필터 ──
  eq('제품명 정상',        isSearchableName('신라면컵'),        true);
  eq('제품명 영문',        isSearchableName('Coke Zero'),      true);
  eq('제품명 숫자혼합',    isSearchableName('농심 신라면 120g'), true);
  eq('제품명 null',        isSearchableName(null),             false);
  eq('제품명 빈문자',      isSearchableName(''),               false);
  eq('제품명 공백만',      isSearchableName('   '),            false);
  eq('제품명 한글자',      isSearchableName('면'),              false);
  eq('제품명 자리표시자',  isSearchableName('(없음)'),          false);
  eq('제품명 미상',        isSearchableName('미상'),            false);
  eq('제품명 숫자만',      isSearchableName('8801043032667'),  false);
  eq('제품명 기호만',      isSearchableName('---'),            false);
  eq('제품명 앞뒤공백',    isSearchableName('  콩기름  '),      true);

  // ── 제조사 정규화 (official_source.js 와 같은 결과여야 한다) ──
  eq('제조사 공장제거',    normalizeMaker('(주)신세계푸드 음성공장'), '신세계푸드');
  eq('제조사 주식회사',    normalizeMaker('주식회사 노바렉스'),       '노바렉스');
  eq('제조사 괄호주',      normalizeMaker('(주)빙그레'),              '빙그레');
  eq('제조사 2공장',       normalizeMaker('광동헬스바이오(주) 2공장'), '광동헬스바이오');
  eq('제조사 접미주',      normalizeMaker('롯데웰푸드(주)'),          '롯데웰푸드');
  eq('제조사 null',        normalizeMaker(null),                     '');

  // ── 갭 키 (70-probe 와 동일해야 대조가 된다) ──
  eq('갭 both',     gapKey(true, true),   'both');
  eq('갭 nut_only', gapKey(false, true),  'nut_only');
  eq('갭 ing_only', gapKey(true, false),  'ing_only');
  eq('갭 neither',  gapKey(false, false), 'neither');

  // ── RACC 표 연동 (정본 로딩 자체를 여기서 검증한다) ──
  const raccTable = require('../src/services/raccTable');
  eq('RACC 로딩됨',        raccTable.isLoaded(),                       true);
  eq('RACC L0 유탕면',     raccTable.lookupRacc('유탕면').racc,         120);
  eq('RACC L3 괄호밖',     raccTable.lookupRacc('프레스햄(살균제품)').key, '프레스햄');
  eq('RACC L4 괄호안',     raccTable.lookupRacc('가공김(조미김)').key,   '조미김');
  eq('RACC 미매핑',        raccTable.lookupRacc('듣도보도못한유형').matched, false);
  eq('건기식 홍삼',        raccTable.isSupplement('홍삼'),              true);
  eq('건기식 아님',        raccTable.isSupplement('유탕면'),            false);

  console.log(`\n[self-test] 통과 ${pass} / 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}

// ────────────────────────────────────────────────────────────────────────────
// DB 진단
// ────────────────────────────────────────────────────────────────────────────
const { Pool } = require('pg');
const raccTable = require('../src/services/raccTable');

const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT, 10) || 5432,
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
const pct = (a, b) => (b ? `${((Number(a) / Number(b)) * 100).toFixed(1)}%` : '-');

async function assertReadOnly() {
  const r = await pool.query('SHOW default_transaction_read_only');
  const v = r.rows[0].default_transaction_read_only;
  if (v !== 'on') {
    throw new Error(`읽기 전용이 걸리지 않았다 (SHOW=${v}). 중단한다 — 진단 스크립트가 DB 를 건드릴 수 없어야 한다.`);
  }
  console.log(`[안전] default_transaction_read_only = ${v}  (엔진 확인됨)`);
}

async function productColumns() {
  const r = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products'
  `);
  return new Set(r.rows.map((x) => x.column_name));
}

/**
 * 공통 CTE — 품목보고번호 단위로 접는다.
 * 70-probe 와 **같은 모수**를 쓴다(active · c005_report_no 보유).
 * 모수가 다르면 두 진단을 나란히 놓고 비교할 수 없다.
 */
const BASE_CTE = (cols) => {
  const hasBarcode = cols.has('barcode');
  const nameCol = cols.has('product_name') ? 'product_name' : null;
  const typeCol = cols.has('food_type') ? 'food_type' : null;
  const makerCol = cols.has('manufacturer') ? 'manufacturer' : (cols.has('maker') ? 'maker' : null);
  return {
    hasBarcode, nameCol, typeCol, makerCol,
    sql: `
    WITH g AS (
      SELECT p.c005_report_no                                   AS report_no,
             ${typeCol ? `MAX(NULLIF(btrim(p.${typeCol}), ''))` : `NULL::text`}   AS food_type,
             ${nameCol ? `MAX(NULLIF(btrim(p.${nameCol}), ''))` : `NULL::text`}   AS product_name,
             ${makerCol ? `MAX(NULLIF(btrim(p.${makerCol}), ''))` : `NULL::text`} AS maker,
             ${hasBarcode ? `BOOL_OR(p.barcode ~ '^880[0-9]{10}$')` : `FALSE`}    AS has_kr_bc,
             BOOL_OR(pi.product_id IS NOT NULL)                 AS has_ing,
             BOOL_OR(nd.product_id IS NOT NULL)                 AS has_nut
      FROM products p
      LEFT JOIN (
        SELECT DISTINCT product_id FROM product_ingredients
        WHERE raw_text IS NOT NULL AND btrim(raw_text) <> ''
      ) pi ON pi.product_id = p.product_id
      LEFT JOIN (SELECT DISTINCT product_id FROM nutrition_data) nd ON nd.product_id = p.product_id
      WHERE p.c005_report_no IS NOT NULL AND p.c005_report_no <> '' AND p.is_active
      GROUP BY p.c005_report_no
    ),
    gap AS (SELECT * FROM g WHERE NOT (has_ing AND has_nut))
  `,
  };
};

/** Q1. 갭 품목 식품유형 분포 상위 N */
async function q1_foodTypes(base, topN) {
  const r = await pool.query(`
    ${base.sql}
    SELECT COALESCE(food_type, '(없음)')                              AS food_type,
           COUNT(*)::bigint                                           AS n,
           COUNT(*) FILTER (WHERE has_kr_bc)::bigint                  AS n_bc,
           COUNT(*) FILTER (WHERE has_ing AND NOT has_nut)::bigint    AS n_ing_only,
           COUNT(*) FILTER (WHERE has_nut AND NOT has_ing)::bigint    AS n_nut_only,
           COUNT(*) FILTER (WHERE NOT has_ing AND NOT has_nut)::bigint AS n_neither
    FROM gap GROUP BY 1 ORDER BY 2 DESC LIMIT ${Number(topN)}
  `);
  return r.rows;
}

/** Q2. 제품명 보유율 — 리스트업 하드 필터. 갭 유형별로 쪼갠다. */
async function q2_nameCoverage(base) {
  const r = await pool.query(`
    ${base.sql}
    SELECT CASE WHEN has_ing AND NOT has_nut THEN 'ing_only'
                WHEN has_nut AND NOT has_ing THEN 'nut_only'
                ELSE 'neither' END                                     AS gap,
           COUNT(*)::bigint                                            AS n,
           COUNT(*) FILTER (WHERE product_name IS NOT NULL)::bigint     AS n_named,
           COUNT(*) FILTER (WHERE product_name IS NOT NULL
                              AND product_name ~ '[가-힣A-Za-z]'
                              AND char_length(product_name) >= 2)::bigint AS n_searchable,
           COUNT(*) FILTER (WHERE product_name IS NOT NULL
                              AND product_name ~ '[가-힣A-Za-z]'
                              AND char_length(product_name) >= 2
                              AND has_kr_bc)::bigint                    AS n_searchable_bc
    FROM gap GROUP BY 1 ORDER BY 2 DESC
  `);
  return r.rows;
}

/** Q3. 대형사 샘플 제품명 — 제이가 실제로 쿠팡에서 찾을 수 있는 형태인지 눈으로 본다. */
async function q3_sampleNames(base, limit = 20) {
  if (!base.makerCol) return [];
  const r = await pool.query(`
    ${base.sql}
    , top_makers AS (
      SELECT maker FROM gap
      WHERE maker IS NOT NULL AND has_kr_bc
      GROUP BY maker ORDER BY COUNT(*) DESC LIMIT 8
    )
    SELECT g2.maker, g2.product_name, g2.food_type,
           CASE WHEN g2.has_ing AND NOT g2.has_nut THEN 'ing_only'
                WHEN g2.has_nut AND NOT g2.has_ing THEN 'nut_only'
                ELSE 'neither' END AS gap
    FROM gap g2 JOIN top_makers t ON t.maker = g2.maker
    WHERE g2.product_name IS NOT NULL AND g2.has_kr_bc
    ORDER BY g2.maker, g2.product_name
    LIMIT ${Number(limit)}
  `);
  return r.rows;
}

/** Q4. 제조사별 — 건기식 추정 11곳이 실제로 건기식인지 대조한다. */
async function q4_makerVsSupplement(base) {
  if (!base.makerCol) return [];
  const r = await pool.query(`
    ${base.sql}
    SELECT COALESCE(maker, '(없음)')                    AS maker,
           COUNT(*) FILTER (WHERE has_kr_bc)::bigint    AS n_gap_bc,
           ARRAY_AGG(DISTINCT COALESCE(food_type, '(없음)')) AS types
    FROM gap GROUP BY 1 ORDER BY 2 DESC LIMIT 30
  `);
  return r.rows;
}

(async () => {
  console.log('=== 71. 갭 품목 식품유형·제품명 실측 (읽기 전용) ===');
  console.log(`실행: ${new Date().toISOString()}`);
  console.log(raccTable.isLoaded()
    ? `RACC 표: ${raccTable.tableSize()}유형 로딩됨 (${raccTable.loadedFrom()})\n`
    : `RACC 표: ★ 로딩 실패 — 매칭률이 전부 0 으로 나온다 (${raccTable.loadError()})\n`);

  await assertReadOnly();

  const cols = await productColumns();
  if (!cols.has('c005_report_no')) throw new Error('products.c005_report_no 없음 — 쿼리 전제가 깨졌다. 중단.');
  const base = BASE_CTE(cols);
  console.log(`[스키마] 제품명=${base.nameCol || '(없음)'} · 식품유형=${base.typeCol || '(없음)'} · 제조사=${base.makerCol || '(없음)'} · barcode=${base.hasBarcode}`);
  if (!base.typeCol) console.log('⚠ food_type 컬럼이 없다. Q1·Q4 는 의미가 없다.');

  // ── Q2 를 먼저 낸다. 이게 모수를 정하는 하드 필터이기 때문. ──
  console.log('\n── Q2. ★ 제품명 보유율 — 캡처 리스트업의 하드 필터 ──');
  console.log('   제품명이 없으면 쿠팡 검색 자체가 불가능하다. 리스트에 넣을 수 없다.');
  console.log('  갭유형        품목수     제품명有        검색가능        ★검색가능+국내바코드');
  const nameRows = await q2_nameCoverage(base);
  let sumGap = 0; let sumSearchableBc = 0;
  for (const r of nameRows) {
    sumGap += Number(r.n); sumSearchableBc += Number(r.n_searchable_bc);
    console.log(
      `  ${String(r.gap).padEnd(12)} ${fmt(r.n).padStart(9)} ${fmt(r.n_named).padStart(11)} (${pct(r.n_named, r.n).padStart(5)})`
      + ` ${fmt(r.n_searchable).padStart(11)} (${pct(r.n_searchable, r.n).padStart(5)})`
      + ` ${fmt(r.n_searchable_bc).padStart(14)}`
    );
  }
  console.log(`\n  ▶ 실제 캡처 가능 모수 = ${fmt(sumSearchableBc)} / 갭 ${fmt(sumGap)} (${pct(sumSearchableBc, sumGap)})`);
  console.log('    ★ 세션41 실측 정정: 1장이면 되는 최대 집단은 ing_only(영양성분표 필요) 다.');
  console.log('      ing_only 는 신호등이 아예 안 켜지는 집단이라 1장당 가치 상승폭이 가장 크다.');

  // ── Q1 ──
  if (base.typeCol) {
    console.log(`\n── Q1. 갭 품목 식품유형 상위 ${TOP_N} + RACC 매칭 ──`);
    console.log('   매칭레벨: L0 정확 / L1 공백 / L2 분리자 / L3 괄호밖 / L4 괄호안 / ✗ 미매핑');
    console.log('   RACC=null 은 [표3] 공란(12키) — 매칭은 됐지만 환산 기준이 없다. 미매핑과 다르다.');
    console.log('  식품유형                          갭품목   국내BC    ing_only  RACC       레벨 건기식');
    const typeRows = await q1_foodTypes(base, TOP_N);
    let matched = 0; let total = 0; let suppl = 0;
    for (const r of typeRows) {
      const rt = raccTable.lookupRacc(r.food_type);
      total += Number(r.n);
      if (rt.matched) matched += Number(r.n);
      if (rt.supplement) suppl += Number(r.n);
      const raccStr = rt.matched ? (rt.racc == null ? '(공란)' : `${rt.racc}${rt.unit || ''}`) : '-';
      console.log(
        `  ${String(r.food_type).slice(0, 28).padEnd(30)} ${fmt(r.n).padStart(8)} ${fmt(r.n_bc).padStart(8)}`
        + ` ${fmt(r.n_ing_only).padStart(9)}  ${raccStr.padEnd(9)} ${(rt.matched ? rt.matchLevel : '✗').padEnd(4)} ${rt.supplement ? '★건기식' : ''}`
      );
    }
    console.log(`\n  ▶ 상위 ${TOP_N} 유형 RACC 매칭률: ${fmt(matched)} / ${fmt(total)} (${pct(matched, total)})`);
    console.log(`  ▶ 상위 ${TOP_N} 중 건강기능식품(신호등 제외 대상): ${fmt(suppl)} (${pct(suppl, total)})`);
    console.log('    ※ 미매핑분은 per_total 라벨에서 "총량 = 1회분" fallback 으로 떨어진다(제이 확정 §3-1).');
  }

  // ── Q4 ──
  if (base.makerCol) {
    console.log('\n── Q4. 제조사 상위 30 × 대표 식품유형 — 세션41 “건기식 OEM 추정 11곳” 대조 ──');
    console.log('   ★ 세션41 은 제조사명으로 **추정**했다. 여기서 food_type 으로 확정한다.');
    for (const r of await q4_makerVsSupplement(base)) {
      const types = (r.types || []).filter(Boolean);
      const isSup = types.length > 0 && types.every((t) => raccTable.isSupplement(t));
      const anySup = types.some((t) => raccTable.isSupplement(t));
      const flag = isSup ? '★건기식(전부)' : (anySup ? '· 건기식 일부' : '');
      console.log(
        `  ${String(r.maker).slice(0, 30).padEnd(32)} ${fmt(r.n_gap_bc).padStart(8)}  ${flag}`
      );
      console.log(`      유형: ${types.slice(0, 5).join(' / ').slice(0, 110)}${types.length > 5 ? ` … 외 ${types.length - 5}` : ''}`);
    }
  }

  // ── Q3 ──
  if (base.makerCol && base.nameCol) {
    console.log('\n── Q3. 대형사 샘플 제품명 20건 — 쿠팡에서 찾을 수 있는 형태인가 ──');
    for (const r of await q3_sampleNames(base, 20)) {
      const ok = isSearchableName(r.product_name) ? '○' : '✗';
      console.log(`  ${ok} [${String(r.gap).padEnd(8)}] ${String(r.maker).slice(0, 16).padEnd(18)} ${String(r.product_name).slice(0, 40).padEnd(42)} ${r.food_type || ''}`);
    }
    console.log('   ○ = 검색어로 쓸 수 있는 형태 / ✗ = 리스트업 제외');
  }

  await pool.end();
  console.log('\nDONE (읽기 전용 — DB 변경 없음)');
})().catch(async (e) => {
  console.error('\n오류:', e.message || e);
  try { await pool.end(); } catch (_) { /* 이미 닫힘 */ }
  process.exit(1);
});
