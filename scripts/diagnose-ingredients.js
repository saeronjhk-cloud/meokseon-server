/**
 * 원재료 커버리지 진단 스크립트
 *
 * 인기 제품 기준으로 원재료 연결이 안 되는 원인을 단계별로 분석:
 * 1. products에 c005_report_no가 있는가?
 * 2. staging_ingredients에 해당 report_no가 있는가?
 * 3. product_ingredients에 실제 등록되었는가?
 * 4. product_additives에 첨가물 매칭이 되었는가?
 *
 * 사용법: node scripts/diagnose-ingredients.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'meokseon',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

const TEST_PRODUCTS = [
  '신라면', '진라면', '짜파게티', '불닭볶음면', '새우깡',
  '포카칩', '초코파이', '코카콜라', '바나나맛우유', '서울우유',
  '스팸', '비비고왕교자', '참이슬', '메로나', '맥심모카골드',
  '진간장', '고추장', '케찹', '햇반', '비엔나소시지',
];

async function main() {
  const client = await pool.connect();

  try {
    console.log('========================================');
    console.log('  원재료 커버리지 진단');
    console.log('========================================\n');

    // ── 1. 전체 통계 ──
    console.log('── 전체 DB 통계 ──');

    const { rows: [{ count: totalProducts }] } = await client.query('SELECT count(*) FROM products');
    const { rows: [{ count: withReportNo }] } = await client.query(`SELECT count(*) FROM products WHERE c005_report_no IS NOT NULL AND c005_report_no != ''`);
    const { rows: [{ count: withIngredients }] } = await client.query('SELECT count(DISTINCT product_id) FROM product_ingredients');
    const { rows: [{ count: withAdditives }] } = await client.query('SELECT count(DISTINCT product_id) FROM product_additives');
    const { rows: [{ count: totalStagingIng }] } = await client.query('SELECT count(*) FROM staging_ingredients');
    const { rows: [{ count: uniqueReportInStaging }] } = await client.query('SELECT count(DISTINCT prdlst_report_no) FROM staging_ingredients');

    console.log(`  products 총:                ${parseInt(totalProducts).toLocaleString()}건`);
    console.log(`  c005_report_no 보유:         ${parseInt(withReportNo).toLocaleString()}건 (${(withReportNo/totalProducts*100).toFixed(1)}%)`);
    console.log(`  product_ingredients 등록:    ${parseInt(withIngredients).toLocaleString()}건 (${(withIngredients/totalProducts*100).toFixed(1)}%)`);
    console.log(`  product_additives 등록:      ${parseInt(withAdditives).toLocaleString()}건 (${(withAdditives/totalProducts*100).toFixed(1)}%)`);
    console.log(`  staging_ingredients 총:      ${parseInt(totalStagingIng).toLocaleString()}건`);
    console.log(`  staging 고유 report_no:      ${parseInt(uniqueReportInStaging).toLocaleString()}건`);

    // ── 2. 병목 분석 ──
    console.log('\n── 병목 분석 ──');

    // c005_report_no가 있지만 product_ingredients가 없는 제품
    const { rows: [{ count: hasReportNoIngredients }] } = await client.query(`
      SELECT count(*) FROM products p
      WHERE c005_report_no IS NOT NULL AND c005_report_no != ''
        AND EXISTS (SELECT 1 FROM product_ingredients pi WHERE pi.product_id = p.product_id)
    `);

    // c005_report_no가 있고 staging_ingredients에 데이터도 있지만 product_ingredients에 없는 경우
    const { rows: [{ count: hasReportAndStaging }] } = await client.query(`
      SELECT count(*) FROM products p
      WHERE c005_report_no IS NOT NULL AND c005_report_no != ''
        AND EXISTS (SELECT 1 FROM staging_ingredients si WHERE si.prdlst_report_no = p.c005_report_no)
    `);

    const { rows: [{ count: hasReportButNoStaging }] } = await client.query(`
      SELECT count(*) FROM products p
      WHERE c005_report_no IS NOT NULL AND c005_report_no != ''
        AND NOT EXISTS (SELECT 1 FROM staging_ingredients si WHERE si.prdlst_report_no = p.c005_report_no)
    `);

    console.log(`  report_no 보유 → staging에 존재:    ${parseInt(hasReportAndStaging).toLocaleString()}건`);
    console.log(`  report_no 보유 → staging에 없음:    ${parseInt(hasReportButNoStaging).toLocaleString()}건 ← 🔴 여기가 문제`);
    console.log(`  report_no 보유 → ingredients 등록:  ${parseInt(hasReportNoIngredients).toLocaleString()}건`);

    // report_no 없는 제품
    const noReportNo = totalProducts - withReportNo;
    console.log(`  report_no 없음 (연결 불가):         ${parseInt(noReportNo).toLocaleString()}건`);

    // ── 3. 파이프라인 흐름도 ──
    console.log('\n── 파이프라인 흐름도 ──');
    console.log(`  products ${parseInt(totalProducts).toLocaleString()}건`);
    console.log(`    ├─ report_no 있음: ${parseInt(withReportNo).toLocaleString()}건`);
    console.log(`    │    ├─ C002에 존재: ${parseInt(hasReportAndStaging).toLocaleString()}건`);
    console.log(`    │    │    ├─ ingredients 등록: ${parseInt(hasReportNoIngredients).toLocaleString()}건`);
    console.log(`    │    │    └─ ingredients 미등록: ${parseInt(hasReportAndStaging) - parseInt(hasReportNoIngredients)}건 ← 🟡 파싱 누락?`);
    console.log(`    │    └─ C002에 없음: ${parseInt(hasReportButNoStaging).toLocaleString()}건 ← 🔴 C002 미수록`);
    console.log(`    └─ report_no 없음: ${parseInt(noReportNo).toLocaleString()}건 ← 🔴 연결 키 부재`);

    // ── 4. 인기 제품 개별 진단 ──
    console.log('\n── 인기 제품 개별 진단 ──\n');

    for (const name of TEST_PRODUCTS) {
      const { rows } = await client.query(`
        SELECT p.product_id, p.product_name, p.c005_report_no, p.is_active,
               pi.raw_text IS NOT NULL AS has_pi,
               (SELECT count(*) FROM product_additives pa WHERE pa.product_id = p.product_id) AS add_cnt
        FROM products p
        LEFT JOIN product_ingredients pi ON p.product_id = pi.product_id
        WHERE p.product_name ILIKE '%' || $1 || '%'
        ORDER BY CASE WHEN pi.raw_text IS NOT NULL THEN 0 ELSE 1 END, length(p.product_name) ASC
        LIMIT 1
      `, [name]);

      if (rows.length === 0) {
        console.log(`  ${name.padEnd(12)} | ❌ products에 없음`);
        continue;
      }

      const p = rows[0];
      const reportNo = p.c005_report_no || '없음';
      let stagingStatus = '-';

      if (p.c005_report_no) {
        const { rows: si } = await client.query(
          `SELECT count(*) AS cnt, string_agg(LEFT(rawmtrl_nm, 40), ' | ') AS preview
           FROM staging_ingredients
           WHERE prdlst_report_no = $1`,
          [p.c005_report_no]
        );
        if (parseInt(si[0].cnt) > 0) {
          stagingStatus = `✅ ${si[0].cnt}행 (${si[0].preview || ''})`;
        } else {
          stagingStatus = '❌ staging에 없음';
        }
      }

      const piStatus = p.has_pi ? '✅' : '❌';
      const addStatus = parseInt(p.add_cnt) > 0 ? `✅(${p.add_cnt})` : '❌';

      console.log(`  ${name.padEnd(12)} | report: ${reportNo.padEnd(20)} | staging: ${stagingStatus}`);
      console.log(`  ${''.padEnd(12)} | ingredients: ${piStatus}  additives: ${addStatus}`);
      console.log('');
    }

    // ── 5. report_no 패턴 분석 ──
    console.log('── report_no 형식 분석 ──');
    const { rows: reportPatterns } = await client.query(`
      SELECT
        CASE
          WHEN c005_report_no ~ '^[0-9]+$' THEN '숫자만'
          WHEN c005_report_no ~ '^[0-9]+-[0-9]+$' THEN '숫자-숫자'
          WHEN c005_report_no IS NULL OR c005_report_no = '' THEN 'NULL/빈값'
          ELSE '기타: ' || LEFT(c005_report_no, 20)
        END AS pattern,
        count(*) AS cnt
      FROM products
      GROUP BY 1
      ORDER BY cnt DESC
      LIMIT 10
    `);
    for (const r of reportPatterns) {
      console.log(`  ${r.pattern}: ${parseInt(r.cnt).toLocaleString()}건`);
    }

    // ── 6. staging_ingredients의 report_no와 products의 report_no 교집합 ──
    console.log('\n── report_no 교집합 분석 ──');
    const { rows: [{ count: intersection }] } = await client.query(`
      SELECT count(DISTINCT p.product_id)
      FROM products p
      INNER JOIN staging_ingredients si ON si.prdlst_report_no = p.c005_report_no
      WHERE p.c005_report_no IS NOT NULL AND p.c005_report_no != ''
    `);
    console.log(`  products ∩ staging_ingredients: ${parseInt(intersection).toLocaleString()}건`);
    console.log(`  products 전체 대비:             ${(intersection/totalProducts*100).toFixed(1)}%`);

    console.log('\n========================================');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
