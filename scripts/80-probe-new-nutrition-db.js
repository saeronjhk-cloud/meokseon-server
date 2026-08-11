/**
 * 80 — 식약처 **K-FIND** 가공식품DB(2026-07-28, 306,307건)의 «통합 가치» 프로브. 읽기 전용.
 *
 * 출처: 식품의약품안전처 K-FIND 식품영양성분 데이터베이스
 *       (Korea Food and Nutrition INformation Database · various.foodsafetykorea.go.kr/nutrient)
 *       플랫폼 누적 32.7만건 중 «가공식품 편». ⚠ **분기별 갱신**된다 —
 *       이 프로브도, 뒤이을 적재도 **재실행 가능**해야 한다.
 *
 * 무엇을 묻는가
 *   ① 품목제조보고번호가 기존 `products.c005_report_no` 와 «붙는가» (교집합)
 *   ② 붙어서 «무엇을 얻는가» — 영양이 없는 활성 제품 중 몇 개가 새로 채워지는가 (= 순증)
 *   ③ 국내형(숫자)과 수입형(영숫자)이 각각 어떻게 다른가
 *
 * 왜 이 프로브가 필요한가
 *   `IP/nutrition_gap_decision_2026-07-23.md` §0-1 이 「정확조인은 레버 아님 — 확정, 종결」이라
 *   판정했다. 그러나 그 판정의 근거는 **data.go.kr 그리드 5만 건 상한 표본 2회**였고,
 *   같은 문서가 원본 고유 식품코드를 **≈61,000** 으로 추정했다.
 *   ⚠ 새 파일은 **306,307건 전량**이고 전부 고유 식품코드다. **추정이 5배 빗나갔다.**
 *   ⇒ 「종결」의 전제가 흔들린다. 전량으로 한 번은 다시 재야 한다. 이 스크립트가 그것이다.
 *
 * ⚠⚠ 이 스크립트는 **아무것도 쓰지 않는다.**
 *   · `SET default_transaction_read_only = on` 을 먼저 건다
 *   · INSERT/UPDATE/DELETE/CREATE 문이 하나도 없다
 *   · 임시 테이블도 만들지 않는다 (read-only 에서 막히므로 `= ANY($1)` 배치 조회를 쓴다)
 *
 * 입력: .tmp/s59/db/new_report_no_domestic.txt · new_report_no_import.txt
 *       (세션59 가 xlsx 에서 뽑아 둔 distinct 목록. 각 줄 하나씩)
 *
 * 사용: node scripts/80-probe-new-nutrition-db.js
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DIR = path.resolve(__dirname, '../.tmp/s59/db');
const CHUNK = 5000;

// ── ★★★ 합격선 — 실측 «전»에 고정했다 (원칙 4 Eval-First · 제이 결정 2026-08-10) ──────
//
//  기준은 「신호등을 켤 수 있는 제품 수」가 «아니라» **「영양 카드가 새로 뜨는 제품 수」**다.
//    근거: `web/src/pages/Scan.tsx` 의 영양성분 카드는 `{result.nutrition && ...}` 조건이라
//    `traffic_light` 와 완전히 독립이다. 신호등이 null 이어도 영양 표는 그대로 뜬다.
//    (제이 지시 2026-08-10 · 세션59 실측)
//
//  대조군: 2026-07-23 판정은 순증 **15건 · 24건**으로 「레버 아님 — 종결」이었다.
//    10,000 은 그 400배 이상이다. 이 선을 넘으면 「전제가 무너졌다」가 «숫자로» 증명된다.
//
//  ⚠⚠ 이 숫자를 실측 «후»에 고치지 말 것. 고쳐야 한다면 인수인계에
//     **「기준을 옮겼다」**고 명시할 것. 「느낌으로 더 좋다」 금지.
const DECISION = {
  ADOPT_GAIN: 10000,   // 순증 >= 10,000 -> 채택. 분기 갱신 파이프라인을 지을 값어치가 있다
  REJECT_GAIN: 1000,   // 순증 <  1,000  -> 기각. 2026-07-23 판정이 규모만 커졌을 뿐 옳았던 것
                       // 그 사이 -> 보류. ⚠ 이 상태로 적재에 들어가지 «말 것»
};

function readList(f) {
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) {
    console.error(`FATAL: ${p} 가 없다. 세션59 가 만든 파일이다.`);
    process.exit(2);
  }
  return fs.readFileSync(p, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
}

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
  const c = await pool.connect();
  await c.query('SET default_transaction_read_only = on');
  const ro = await c.query('SHOW default_transaction_read_only');
  console.log('읽기 전용 확인: default_transaction_read_only =', ro.rows[0].default_transaction_read_only);

  // ── 0-b. 인덱스 확인 (세션60 추가) ────────────────────────────────────────
  //   아래 `= ANY($1)` 를 60청크 × 4쿼리 = 240회 돈다.
  //   `c005_report_no` 에 인덱스가 없으면 240회 seq scan 이라 «몇 분»이 «몇십 분»이 된다.
  //   `000_baseline.sql:225` 에 `idx_products_report_no` 선언이 있으나
  //   **선언과 운영 DB 의 실제 상태는 다를 수 있다.** 그래서 실물을 본다.
  const idx = await c.query(`
    SELECT indexname FROM pg_indexes
     WHERE tablename = 'products' AND indexdef ILIKE '%c005_report_no%'`);
  if (idx.rows.length) {
    console.log('인덱스 확인      : ' + idx.rows.map(r => r.indexname).join(', ') + ' ✅');
  } else {
    console.log('⚠ 인덱스 없음    : products.c005_report_no 에 인덱스가 «없다».');
    console.log('  이 프로브는 끝나긴 하지만 오래 걸린다. 느리다고 중간에 끄지 말 것 —');
    console.log('  읽기 전용이라 DB 를 망가뜨리지는 않는다.');
  }

  // ── 0. 기준선 ────────────────────────────────────────────────────────────
  const base = await c.query(`
    SELECT
      count(*)::int                                   AS active,
      count(c005_report_no)::int                      AS with_rep,
      count(DISTINCT c005_report_no)::int             AS distinct_rep,
      count(barcode)::int                             AS with_barcode
    FROM products WHERE is_active`);
  // ★ 「영양 카드가 뜨는가」가 기준이다 — 신호등이 아니다.
  //   앱(`web/src/pages/Scan.tsx`)의 영양성분 카드는 `{result.nutrition && ...}` 조건이라
  //   `traffic_light` 와 **완전히 독립**이다. 신호등이 null 이어도 영양 표는 그대로 뜬다.
  //   그러므로 이 프로브가 세는 것은 「신호등 켤 수 있는 제품」이 아니라
  //   **「영양 숫자를 보여줄 수 있는 제품」**이다. (제이 지시 2026-08-10)
  const nut = await c.query(`
    SELECT
      count(DISTINCT p.product_id)::int AS with_row,
      count(DISTINCT p.product_id) FILTER (
        WHERE n.calories IS NOT NULL OR n.sodium IS NOT NULL
           OR n.protein IS NOT NULL  OR n.total_fat IS NOT NULL
      )::int AS with_value
    FROM products p JOIN nutrition_data n ON n.product_id = p.product_id
    WHERE p.is_active`);
  const b = base.rows[0];
  const withRow = nut.rows[0].with_row;
  const withValue = nut.rows[0].with_value;
  console.log('\n===== 0. 기준선 (오늘 실측) =====');
  console.log(`활성 제품              : ${b.active.toLocaleString()}`);
  console.log(`  바코드 보유          : ${b.with_barcode.toLocaleString()} (${(b.with_barcode / b.active * 100).toFixed(1)}%)  <-- 스캔 도달 가능 상한`);
  console.log(`  보고번호 보유        : ${b.with_rep.toLocaleString()} (${(b.with_rep / b.active * 100).toFixed(1)}%)`);
  console.log(`  distinct 보고번호    : ${b.distinct_rep.toLocaleString()}`);
  console.log(`nutrition_data 행 보유 : ${withRow.toLocaleString()} (${(withRow / b.active * 100).toFixed(1)}%)`);
  console.log(`★ 실제 값이 있는 제품  : ${withValue.toLocaleString()} (${(withValue / b.active * 100).toFixed(1)}%)  <-- 영양 카드가 뜨는 제품`);
  console.log(`★ 영양 카드가 «안» 뜨는 활성 제품 : ${(b.active - withValue).toLocaleString()}  <-- 공략 대상`);
  if (withRow !== withValue) {
    console.log(`  ⚠ 행은 있는데 값이 전부 NULL 인 제품 : ${(withRow - withValue).toLocaleString()} — 이것도 채울 수 있다`);
  }

  // 기존 보고번호 형식 분포 — 새 파일과 체계가 같은지 본다
  const fmt = await c.query(`
    SELECT
      count(*) FILTER (WHERE c005_report_no ~ '^[0-9]+$')::int AS numeric_only,
      count(*) FILTER (WHERE c005_report_no !~ '^[0-9]+$' AND c005_report_no IS NOT NULL)::int AS alnum,
      min(length(c005_report_no))::int AS min_len,
      max(length(c005_report_no))::int AS max_len
    FROM products WHERE is_active AND c005_report_no IS NOT NULL`);
  const f = fmt.rows[0];
  console.log(`\n기존 보고번호 형식    : 숫자만 ${f.numeric_only.toLocaleString()} / 영숫자 ${f.alnum.toLocaleString()} / 길이 ${f.min_len}~${f.max_len}`);

  // ── 1~2. 축별 교집합 + 순증 ──────────────────────────────────────────────
  async function probe(label, list) {
    console.log(`\n===== ${label} — 새 파일 distinct ${list.length.toLocaleString()}건 =====`);
    const cs = chunks(list, CHUNK);
    const hitRep = new Set();
    let matchedProducts = 0;
    let gainProducts = 0;      // 영양 카드가 «안 뜨던» 제품 중 붙는 것 = 순증
    let gainWithBarcode = 0;   // 그중 바코드 보유 = 스캔으로 실제 도달
    const sample = [];

    // 「영양 카드가 뜨지 않는다」의 정의 — 행이 없거나, 행은 있는데 값이 전부 NULL.
    const NO_CARD = `NOT EXISTS (
      SELECT 1 FROM nutrition_data n
       WHERE n.product_id = p.product_id
         AND (n.calories IS NOT NULL OR n.sodium IS NOT NULL
           OR n.protein IS NOT NULL  OR n.total_fat IS NOT NULL))`;

    for (let i = 0; i < cs.length; i++) {
      // ① 붙는 보고번호
      const r1 = await c.query(
        `SELECT DISTINCT c005_report_no FROM products
          WHERE is_active AND c005_report_no = ANY($1::text[])`, [cs[i]]);
      r1.rows.forEach(x => hitRep.add(x.c005_report_no));

      // ② 붙는 활성 제품 수
      const r2 = await c.query(
        `SELECT count(*)::int n FROM products
          WHERE is_active AND c005_report_no = ANY($1::text[])`, [cs[i]]);
      matchedProducts += r2.rows[0].n;

      // ③ ★ 순증 — 붙으면서 «영양 카드가 안 뜨던» 활성 제품 (+ 그중 바코드 보유)
      const r3 = await c.query(
        `SELECT count(*)::int n,
                count(*) FILTER (WHERE p.barcode IS NOT NULL)::int nb
           FROM products p
          WHERE p.is_active AND p.c005_report_no = ANY($1::text[]) AND ${NO_CARD}`, [cs[i]]);
      gainProducts += r3.rows[0].n;
      gainWithBarcode += r3.rows[0].nb;

      if (sample.length < 10) {
        const r4 = await c.query(
          `SELECT p.barcode, p.product_name, p.manufacturer, p.c005_report_no FROM products p
            WHERE p.is_active AND p.c005_report_no = ANY($1::text[]) AND ${NO_CARD}
            LIMIT 10`, [cs[i]]);
        r4.rows.forEach(x => { if (sample.length < 10) sample.push(x); });
      }
      if ((i + 1) % 10 === 0 || i === cs.length - 1) {
        process.stdout.write(`\r  진행 ${i + 1}/${cs.length} 청크 · 교집합 ${hitRep.size.toLocaleString()} · 순증 ${gainProducts.toLocaleString()}   `);
      }
    }
    console.log('');
    console.log(`  교집합 보고번호        : ${hitRep.size.toLocaleString()} (새 파일의 ${(hitRep.size / list.length * 100).toFixed(2)}%)`);
    console.log(`  붙는 활성 제품         : ${matchedProducts.toLocaleString()}`);
    console.log(`  ★ 순증(영양 카드 신규) : ${gainProducts.toLocaleString()}`);
    console.log(`     그중 바코드 보유    : ${gainWithBarcode.toLocaleString()}  <-- 스캔으로 실제 도달하는 수`);
    if (sample.length) {
      console.log('  순증 표본 10건:');
      sample.forEach(s => console.log(`    ${s.barcode || '(바코드없음)'} | ${String(s.product_name).slice(0, 34)} | ${String(s.manufacturer || '').slice(0, 16)} | ${s.c005_report_no}`));
    }
    return { hit: hitRep.size, matched: matchedProducts, gain: gainProducts, gainBc: gainWithBarcode, listN: list.length };
  }

  const domList = readList('new_report_no_domestic.txt');
  const impList = readList('new_report_no_import.txt');
  const dom = await probe('1. 국내형 보고번호 (숫자)', domList);

  // ══════════════════════════════════════════════════════════════════════════
  // ⚠⚠⚠ 세션61 정정 — 아래 「2. 수입형」 은 **설계가 틀렸다. 결과를 믿지 말 것.**
  //
  //   무엇이 틀렸나
  //     `probe()` 는 `products.c005_report_no` 에 댄다. 그런데 그 컬럼은 **국내 C005
  //     레지스트리 전용**이고, `products` 에는 수입형 보고번호를 담는 컬럼이 «아예 없다».
  //     근거 — `scripts/migrations/000_baseline.sql:130-218` 의 products 정의에
  //     report_no 계열은 `c005_report_no` 단 하나뿐이다.
  //
  //   ★ 그리고 이건 «새로 알게 된 것»이 아니다. 저장소가 이미 적어 두고 있었다:
  //     `scripts/migrations/015_import_nutrition_bridge.sql:27`
  //       item_report_no TEXT,  -- ITEM_REPORT_NO (DNSP/수입코드계 — C005 조인 불가, 감사용)
  //     `scripts/staging/off/imports_bridge_diag.js:69`
  //       「join_exact_domestic > 0 이고 join_exact_import = 0
  //         → 수입식품이 C005(바코드레지스트리)에 부재(**포맷문제 아님**)」
  //     ⇒ 교집합 0 은 발견이 아니라 **예측된 결과**였다. 프로브가 이미 답이 적힌 질문을 했다.
  //
  //   ⇒ ❌ 「수입 K-FIND 는 가치 없다」로 세지 말 것. **측정되지 않았다.**
  //
  //   수입 축의 «올바른» 질문은 보고번호가 아니라 **이름 브릿지**다
  //     `build_import_bridge.js:61-68` — 수입 제품 조인은 v1 에서 **100% 제품명 기반**이다
  //       (name_raw exact → name_norm). 바코드 경로는 `import_bridge_lib.js:59` 에서
  //       「barcode_exact v1 비활성 → review」로 꺼져 있고 호출부가 `barcode: null` 고정.
  //     `016_import_collapse_conflict.sql:44` — match_method CHECK 가 `('name_raw','name_norm')`
  //       뿐이다. **보고번호 계열 키는 화이트리스트에 없다.**
  //   ⇒ 재측정 설계는 `IP/수입축_재측정_설계_2026-08-11_세션61.md` 에 있다.
  //     ⚠ 실행하려면 K-FIND xlsx 에서 수입형의 «제품명»을 다시 뽑아야 한다
  //       (`.tmp/s59/db/` 에는 보고번호 txt 만 있고 제품명이 없다). 제이가 파일을 다시 올려야 한다.
  //
  //   그래서 왜 안 지웠나 — 지우면 다음 세션이 「수입은 왜 안 쟀지?」로 다시 판다.
  //   틀린 채로 «틀렸다고 적어» 두는 것이 재작업을 막는다.
  // ══════════════════════════════════════════════════════════════════════════
  const imp = await probe('2. 수입형 보고번호 (영숫자) ⚠ 세션61: 설계 오류 — 결과 무효', impList);

  // ── 2-b. ★★★ 형식 진단 (세션60 추가) — 「안 붙는다」를 오독하지 않기 위한 대조 ────
  //
  //  위 ①~③ 은 «정확 일치»(`= ANY`)다. 교집합이 작게 나왔을 때 원인이 둘인데
  //  정확 일치만으로는 **구분할 수 없다**:
  //    ⓐ 진짜로 우리 DB 에 없는 제품이다
  //    ⓑ 있는데 «표기 형식»이 달라서 못 붙는다 (선행 0, 하이픈·공백, 대소문자)
  //
  //  ⚠ 이 구분이 이 프로브의 존재 이유와 직결된다. 2026-07-23 의 「종결」 판정이
  //    ⓑ 였다면 그건 「레버가 아니다」가 아니라 **「키를 잘못 맞췄다」**였던 것이다.
  //    표본이 5배 빗나갔던 문서다 — 같은 종류의 실수를 한 번 더 의심할 값어치가 있다.
  //
  //  방법: DB 의 distinct 보고번호를 «한 번»에 받아 Node 메모리에서 비교한다.
  //    - 정규화 컬럼을 SQL 로 만들면 인덱스를 못 타서 240회가 전부 seq scan 이 된다.
  //    - distinct 는 14만 규모라 메모리에 올려도 무해하다.
  //  ⚠ 이 절은 «진단»이다. 정규화 매칭으로 적재하라는 뜻이 «아니다» —
  //    실제 적재 키를 바꾸는 것은 별개 결정이고 오매칭 위험이 따로 있다.
  console.log('\n===== 2-b. 형식 진단 — 「안 붙는다」가 진짜인가, 표기 차이인가 =====');
  const norm = s => String(s).toUpperCase().replace(/[^0-9A-Z]/g, '');
  const dbRows = await c.query(
    `SELECT DISTINCT c005_report_no FROM products
      WHERE is_active AND c005_report_no IS NOT NULL`);
  const dbExact = new Set(dbRows.rows.map(r => r.c005_report_no));
  const dbNorm = new Map();                       // 정규화 -> 원본(대표 1개)
  for (const v of dbExact) if (!dbNorm.has(norm(v))) dbNorm.set(norm(v), v);
  console.log(`DB distinct 보고번호      : ${dbExact.size.toLocaleString()}  (정규화 후 ${dbNorm.size.toLocaleString()})`);
  if (dbNorm.size !== dbExact.size) {
    console.log(`  ⚠ DB «내부»에도 표기 흔들림이 있다 — 정규화하면 ${(dbExact.size - dbNorm.size).toLocaleString()}건이 합쳐진다`);
  }

  for (const [label, list] of [['국내형', domList], ['수입형', impList]]) {
    let exact = 0, normOnly = 0;
    const ex = [];
    for (const v of list) {
      if (dbExact.has(v)) { exact++; continue; }
      const n = norm(v);
      if (dbNorm.has(n)) { normOnly++; if (ex.length < 5) ex.push(`${v}  ->  ${dbNorm.get(n)}`); }
    }
    console.log(`\n  ${label} ${list.length.toLocaleString()}건`);
    console.log(`    정확 일치            : ${exact.toLocaleString()}`);
    console.log(`    ★ 정규화해야 붙는 것 : ${normOnly.toLocaleString()}`);
    if (normOnly > 0) {
      console.log('      예시:');
      ex.forEach(e => console.log(`        ${e}`));
      console.log('      ⇒ 정확 일치 숫자만 보고 「안 붙는다」고 결론내면 «틀린다».');
    } else {
      console.log('      ⇒ 표기 차이로 놓치는 건 없다. 정확 일치 숫자를 그대로 믿어도 된다.');
    }
  }

  // ── 3. 판정 근거 요약 ────────────────────────────────────────────────────
  const totalGain = dom.gain + imp.gain;
  const totalGainBc = dom.gainBc + imp.gainBc;
  const totalHit = dom.hit + imp.hit;
  const noCard = b.active - withValue;
  console.log('\n===== 3. 요약 — 기준은 «영양 카드가 뜨는 제품 수» 다 =====');
  console.log(`총 순증(영양 카드 신규)          : ${totalGain.toLocaleString()}`);
  console.log(`  그중 바코드 보유(스캔 도달)    : ${totalGainBc.toLocaleString()}`);
  console.log(`  영양 카드 없던 제품 대비        : ${(totalGain / noCard * 100).toFixed(2)}%`);
  console.log(`  전체 활성 제품 대비 증가        : ${(totalGain / b.active * 100).toFixed(2)}%p`);
  console.log(`  적용 후 영양 표시율 예상        : ${((withValue + totalGain) / b.active * 100).toFixed(1)}% (현재 ${(withValue / b.active * 100).toFixed(1)}%)`);
  console.log(`\n새 파일 쪽 — 안 붙는 보고번호    : ${(299393 - totalHit).toLocaleString()} / 299,393`);
  console.log('  ⚠ 이건 «우리 DB 에 없는 제품»이다. 넣으려면 바코드가 없어 스캔 도달이 안 되고,');
  console.log('    검색·이름 매칭 경로로만 닿는다. 별개 결정이다 — 이 프로브의 판단 범위 밖.');
  console.log('\n대조 — 과거 실측 (IP/nutrition_gap_decision_2026-07-23.md §0-1)');
  console.log('  세션31 (그리드 5만 표본) : 겹침 2,564 · 순증 15');
  console.log('  세션36 (그리드 5만 표본) : 겹침 1,544 · 순증 24');
  console.log('  그 문서의 판정          : 「정확조인은 레버 아님 — 확정, 종결」');
  console.log('  ⚠ 그 판정은 5만 표본 기준이고, 「커버리지 %」= 신호등 관점이었다.');
  console.log('    제이 지시(2026-08-10): 신호등을 못 켜도 «영양성분은 제공할 수 있다».');
  console.log('    그러므로 판단 기준은 위의 «영양 카드 신규» 수다.');
  console.log('\n출처: 식약처 K-FIND 식품영양성분 DB · 데이터기준일자 2026-07-28 · 분기 갱신');
  console.log('  ⚠ 적재한다면 이 «판(版)»을 레코드에 남길 것. 기존 적재분은 그 기록이 없어 diff 가 불가능하다.');
  console.log('\n★ 이 데이터는 «대표값»이 아니다 (세션59 실측):');
  console.log('   식품명 == 대표식품명 = 882건(0.29%) · 데이터생성방법 «수집» 99.8%');
  console.log('   품목제조보고번호가 붙은 «개별 품목 신고값»이다.');
  console.log('   ⇒ 「식약처 대표값 = 신호등 배제」 정책의 대상인지 «다시 판단»해야 한다 — 제이 결정 사항.');
  console.log('\n⚠ 이 수치만으로 적재를 결정하지 말 것. IP/nutrition_field_mapping_v1.md 의');
  console.log('   검증 게이트(콤마 truncation · 결측 0 금지 · 골든셋 회귀 · basis)가 먼저다.');

  // ── 4. ★★★ 판정 — 합격선은 실측 «전»에 고정돼 있다 (세션60 추가) ─────────────
  console.log('\n' + '='.repeat(70));
  let verdict;
  if (totalGain >= DECISION.ADOPT_GAIN) {
    verdict = '채택 — 2026-07-23 「종결」의 전제가 무너졌다. 적재 파이프라인 설계로 넘어간다';
  } else if (totalGain < DECISION.REJECT_GAIN) {
    verdict = '기각 — 규모만 5배였을 뿐 2026-07-23 판정이 옳았다. 이 축을 다시 열지 말 것';
  } else {
    verdict = '보류 — 합격선에 못 미친다. ⚠ 이 상태로 적재에 들어가지 «말 것»';
  }
  console.log(` 판정: ${verdict}`);
  console.log(`   순증 ${totalGain.toLocaleString()} (채택 >=${DECISION.ADOPT_GAIN.toLocaleString()} / 기각 <${DECISION.REJECT_GAIN.toLocaleString()})`);
  console.log(`   대조: 2026-07-23 실측은 15건 · 24건이었다`);
  console.log('='.repeat(70));
  console.log('⚠ 이 합격선은 «숫자를 보기 전»에 고정한 것이다 (제이 결정 2026-08-10).');
  console.log('  결과가 마음에 안 든다고 선을 옮기지 말 것. 옮긴다면 인수인계에 그 사실을 적을 것.');
  console.log('⚠ 위 「2-b 형식 진단」에서 «정규화해야 붙는 것»이 많이 나왔다면');
  console.log('  이 판정은 «하한»이다 — 키를 제대로 맞추면 순증이 더 늘어난다.');

  c.release();
  await pool.end();
})().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
