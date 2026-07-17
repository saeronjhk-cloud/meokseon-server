/**
 * probe_nutrition_report_no_join.js — 식약처 통합영양 DB ↔ C005 **정확 조인** 가능성 실측
 *
 * ★ 왜 (2026-07-17, 영양공식 세션31 발견):
 *   인수인계 2026-07-09 §16 은 이렇게 적었다:
 *     "C005(바코드↔report_no↔이름, 영양 없음) vs 식약처 영양DB(이름/food_cd↔영양,
 *      **report_no·barcode 없음**). 유일 조인=이름(퍼지·대표값)."
 *   그래서 Step 5 를 **이름브릿지**(일치 13.8%, 대표값 다수)로 계획했고, 대표값이라
 *   **신호등을 껐다**(정책 lock: "식약처 대표값 = 신호등 자동판정 전면 배제").
 *
 *   그런데 `전국통합식품영양성분정보_가공식품_표준데이터.csv` (D:\서박사의 영양공식\
 *   backends\NutriLens\ 에 있었다 — 먹선이 본 적 없는 **다른 식약처 데이터셋**) 에는
 *   **품목제조보고번호가 94% 채워져 있다.** 50,000행 · 나트륨 100% · 기준량 100g/100ml.
 *   키가 C005 의 PRDLST_REPORT_NO 와 **같은 식약처 품목제조보고번호**다.
 *
 *   → 이름 퍼지가 아니라 **report_no 정확 조인**이면 그 값은 대표값이 아니라
 *     그 품목의 신고 영양이다. **신호등을 끈 이유가 사라진다.**
 *   → 그리고 먹선은 배관을 이미 깔아놨다("같은 c005 면 아무 바코드나 같은 per-100 영양",
 *     엔티티 41,042 · 바코드 그룹 승인 113,028). 파이프는 완성됐고 영양 행이 없어 굶었다.
 *
 *   **이 스크립트는 겹침만 잰다. 아무것도 바꾸지 않는다.**
 *   겹침이 크면 Step 5 의 방향 자체가 바뀐다(이름브릿지 → 정확 조인).
 *   겹침이 작으면 이 발견은 접고 기존 계획대로 간다. 둘 다 답이다.
 *
 * 실행:
 *   node scripts/staging/domestic/probe_nutrition_report_no_join.js --selftest
 *   node scripts/staging/domestic/probe_nutrition_report_no_join.js [CSV경로]
 *   기본 CSV: ../../../../.tmp/식약처_영양_by_report_no.csv (영양공식 세션31 산출, UTF-8)
 */
'use strict';
try { require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') }); } catch (_) {}
const fs = require('fs');
const path = require('path');

const CSV_NAME = '식약처_영양_by_report_no.csv';

/**
 * CSV 를 찾는다. ★ 상대경로를 손으로 세지 않는다 — 세션31 에 실제로 한 칸 틀려서
 *   D:\서박사의 영양공식\backends\.tmp\ 를 봤다(루트까지 6단계인데 5단계만 올라감).
 *   게다가 이 스크립트는 D:\먹선\meokseon-server(SSOT)에서 돌 수도 있어 상대깊이가 달라진다.
 *   → **위로 탐색**한다. 어디서 돌리든 찾는다. 못 찾으면 알려진 절대경로를 시도한다.
 */
function findCsv() {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const c = path.join(dir, '.tmp', CSV_NAME);
    if (fs.existsSync(c)) return c;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const abs of [
    path.join('D:', String.fromCharCode(92), '서박사의 영양공식', '.tmp', CSV_NAME),
    'D:\\서박사의 영양공식\\.tmp\\' + CSV_NAME,
  ]) {
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

/** 최소 CSV 파서 — 따옴표·콤마 처리. 의존성 추가 없이. */
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function selftest() {
  const r = parseCsv('a,b\n1,"x,y"\n2,"he said ""hi"""\n');
  const ok = r.length === 3 && r[1][1] === 'x,y' && r[2][1] === 'he said "hi"';
  console.log(ok ? 'SELFTEST OK' : 'SELFTEST FAIL ' + JSON.stringify(r));
  process.exit(ok ? 0 : 1);
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const argPath = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  const csvPath = argPath || findCsv();
  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error(`[중단] CSV 를 못 찾았습니다${argPath ? ': ' + argPath : ' (위로 탐색 + 절대경로 모두 실패)'}`);
    console.error('  이 파일은 영양공식 세션31 산출물입니다:');
    console.error('    D:\\서박사의 영양공식\\.tmp\\' + CSV_NAME);
    console.error('  없으면 영양공식 쪽에서 재생성하거나, 경로를 인자로 주세요:');
    console.error('    node ' + path.basename(__filename) + ' "D:\\...\\' + CSV_NAME + '"');
    process.exit(1);
  }
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const head = rows.shift();
  const iRep = head.indexOf('report_no'), iNa = head.indexOf('sodium_mg');
  if (iRep < 0) { console.error('[중단] report_no 컬럼 없음. 헤더: ' + head.join(',')); process.exit(1); }
  const reps = new Set();
  for (const r of rows) { const v = (r[iRep] || '').trim(); if (v) reps.add(v); }
  const arr = [...reps];
  console.log(`[CSV] ${csvPath}`);
  console.log(`  행 ${rows.length.toLocaleString()} · distinct report_no ${arr.length.toLocaleString()} · 나트륨 컬럼 ${iNa >= 0 ? 'O' : 'X'}`);

  const db = require('../../../src/config/database');
  const client = await db.pool.connect();
  try {
    const q = async (sql, p) => (await client.query(sql, p)).rows;

    console.log('\n[A] 먹선 C005 현황 (실 테이블 무접촉 · 읽기만)');
    const a = (await q(`
      SELECT count(*)::int total,
             count(*) FILTER (WHERE c005_report_no IS NOT NULL)::int with_rep,
             count(DISTINCT c005_report_no)::int distinct_rep
        FROM products WHERE is_active`))[0];
    console.log(`  활성 제품 ${a.total.toLocaleString()} · c005_report_no 있음 ${a.with_rep.toLocaleString()} · distinct ${a.distinct_rep.toLocaleString()}`);

    console.log('\n[B] ★ 겹침 — 이 숫자가 Step 5 의 방향을 정한다');
    const b = (await q(`
      WITH n AS (SELECT DISTINCT unnest($1::text[]) AS report_no)
      SELECT
        (SELECT count(*)::int FROM n)                                                     AS sik_distinct,
        (SELECT count(DISTINCT p.c005_report_no)::int
           FROM products p JOIN n ON n.report_no = p.c005_report_no
          WHERE p.is_active)                                                              AS overlap_rep,
        (SELECT count(*)::int
           FROM products p JOIN n ON n.report_no = p.c005_report_no
          WHERE p.is_active)                                                              AS products_gain,
        (SELECT count(*)::int
           FROM products p JOIN n ON n.report_no = p.c005_report_no
          WHERE p.is_active
            AND NOT EXISTS (SELECT 1 FROM nutrition_data nd
                             WHERE nd.product_id = p.product_id AND nd.calories IS NOT NULL))
                                                                                          AS new_coverage
      `, [arr]))[0];
    const pct = (x, y) => (y ? ((x / y) * 100).toFixed(1) + '%' : '-');
    console.log(`  식약처 distinct report_no        : ${b.sik_distinct.toLocaleString()}`);
    console.log(`  ★ 겹치는 report_no              : ${b.overlap_rep.toLocaleString()}  (먹선 distinct 대비 ${pct(b.overlap_rep, a.distinct_rep)})`);
    console.log(`  ★ 영양을 얻는 활성 제품          : ${b.products_gain.toLocaleString()}  (활성 대비 ${pct(b.products_gain, a.total)})`);
    console.log(`  ★★ own 없던 제품 중 새로 얻는 것 : ${b.new_coverage.toLocaleString()}  (활성 대비 ${pct(b.new_coverage, a.total)})`);

    console.log('\n[C] 기존 own 커버리지와 비교');
    const c = (await q(`
      SELECT count(*)::int own FROM products p WHERE p.is_active
        AND EXISTS (SELECT 1 FROM nutrition_data nd WHERE nd.product_id=p.product_id AND nd.calories IS NOT NULL)`))[0];
    console.log(`  현재 own 영양 보유 : ${c.own.toLocaleString()}  (${pct(c.own, a.total)})`);
    console.log(`  정확 조인 후 예상  : ${(c.own + b.new_coverage).toLocaleString()}  (${pct(c.own + b.new_coverage, a.total)})`);
    console.log(`  ※ 엔티티 공유(같은 c005 → 형제 바코드 상속)는 **여기 미포함**이다.`);
    console.log(`    먹선은 이미 바코드 그룹 113,028 을 승인해뒀으므로 실제 효과는 이보다 클 수 있다.`);

    console.log('\n[D] 판정 재료');
    if (b.overlap_rep === 0) {
      console.log('  ★ 겹침 0 — report_no 체계가 다르거나 이 데이터셋이 무관하다.');
      console.log('    → 이 발견은 접는다. 기존 Step 5(이름브릿지) 유지.');
    } else if (b.new_coverage < a.total * 0.05) {
      console.log('  겹침은 있으나 신규 커버리지가 5% 미만 — 레버가 작다. 우선순위 판단 필요.');
    } else {
      console.log('  ★★ 신규 커버리지가 유의미하다. **이름브릿지가 아니라 정확 조인이다.**');
      console.log('     → 이 값은 대표값이 아니라 그 품목의 신고 영양이다.');
      console.log('       "식약처 대표값 = 신호등 자동판정 전면 배제" 정책의 전제가 이 경로엔 해당하지 않는다.');
      console.log('       ⚠️ 단, **신호등을 켤지는 제이·자문 결정**이다. 이 스크립트는 재기만 한다.');
    }
    console.log('\n[E] 이 측정이 말하지 않는 것');
    console.log('  · CSV 가 정확히 50,000행 = 다운로드 상한일 수 있다. 원본이 더 크면 이 숫자는 하한이다.');
    console.log('  · 영양 값의 정확성은 안 봤다. 겹치는 report_no 의 값이 옳은지는 별도 검증.');
    console.log('  · 기준량(100g/100ml) 정합·RACC 는 안 봤다. 기존 3단계 로직이 처리할 영역.');
  } finally {
    client.release();
    await db.pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
