/**
 * 스테이징 테이블 중복 제거
 * 원본 데이터를 보존하면서 중복을 제거한 깨끗한 원본을 만듭니다.
 *
 * 사용법: node scripts/staging/deduplicate-staging.js
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

async function main() {
  const client = await pool.connect();

  try {
    console.log('========================================');
    console.log('  스테이징 테이블 중복 제거');
    console.log('========================================\n');

    // ── 1. staging_nutrition 중복 제거 ──
    const beforeNut = await client.query('SELECT count(*) FROM staging_nutrition');
    console.log(`  [영양성분DB] 현재: ${beforeNut.rows[0].count}건`);

    // food_cd 기준 중복 확인
    const dupNut = await client.query(`
      SELECT count(*) AS total,
             count(DISTINCT food_cd) AS unique_food_cd,
             count(DISTINCT food_nm_kr) AS unique_names
      FROM staging_nutrition
      WHERE food_cd IS NOT NULL
    `);
    console.log(`    고유 food_cd: ${dupNut.rows[0].unique_food_cd}`);
    console.log(`    고유 식품명: ${dupNut.rows[0].unique_names}`);

    // 중복 제거: food_cd 기준으로 가장 최근 데이터만 남김
    const deleteNut = await client.query(`
      DELETE FROM staging_nutrition a
      USING staging_nutrition b
      WHERE a.food_cd = b.food_cd
        AND a.food_cd IS NOT NULL
        AND a.id < b.id
    `);
    console.log(`    중복 삭제: ${deleteNut.rowCount}건`);

    // food_cd가 NULL인 경우 food_nm_kr 기준 중복 제거
    const deleteNutNull = await client.query(`
      DELETE FROM staging_nutrition a
      USING staging_nutrition b
      WHERE a.food_cd IS NULL
        AND b.food_cd IS NULL
        AND a.food_nm_kr = b.food_nm_kr
        AND a.id < b.id
    `);
    console.log(`    NULL food_cd 중복 삭제: ${deleteNutNull.rowCount}건`);

    const afterNut = await client.query('SELECT count(*) FROM staging_nutrition');
    console.log(`    결과: ${afterNut.rows[0].count}건 (${beforeNut.rows[0].count - afterNut.rows[0].count}건 제거)\n`);

    // ── 2. staging_ingredients 중복 제거 ──
    const beforeIng = await client.query('SELECT count(*) FROM staging_ingredients');
    console.log(`  [원재료(C002)] 현재: ${beforeIng.rows[0].count}건`);

    const dupIng = await client.query(`
      SELECT count(*) AS total,
             count(DISTINCT prdlst_report_no) AS unique_reports
      FROM staging_ingredients
      WHERE prdlst_report_no IS NOT NULL
    `);
    console.log(`    고유 품목보고번호: ${dupIng.rows[0].unique_reports}`);

    // prdlst_report_no + rawmtrl_ordno 조합으로 중복 제거
    const deleteIng = await client.query(`
      DELETE FROM staging_ingredients a
      USING staging_ingredients b
      WHERE a.prdlst_report_no = b.prdlst_report_no
        AND a.prdlst_report_no IS NOT NULL
        AND a.rawmtrl_nm = b.rawmtrl_nm
        AND a.id < b.id
    `);
    console.log(`    중복 삭제: ${deleteIng.rowCount}건`);

    const afterIng = await client.query('SELECT count(*) FROM staging_ingredients');
    console.log(`    결과: ${afterIng.rows[0].count}건 (${beforeIng.rows[0].count - afterIng.rows[0].count}건 제거)\n`);

    // ── 3. staging_product_report 중복 제거 ──
    const beforePr = await client.query(`
      SELECT count(*) FROM information_schema.tables
      WHERE table_name = 'staging_product_report'
    `);

    if (parseInt(beforePr.rows[0].count) > 0) {
      const beforePrCount = await client.query('SELECT count(*) FROM staging_product_report');
      console.log(`  [품목제조보고(I1250)] 현재: ${beforePrCount.rows[0].count}건`);

      const dupPr = await client.query(`
        SELECT count(DISTINCT prdlst_report_no) AS unique_reports
        FROM staging_product_report
        WHERE prdlst_report_no IS NOT NULL
      `);
      console.log(`    고유 품목보고번호: ${dupPr.rows[0].unique_reports}`);

      const deletePr = await client.query(`
        DELETE FROM staging_product_report a
        USING staging_product_report b
        WHERE a.prdlst_report_no = b.prdlst_report_no
          AND a.prdlst_report_no IS NOT NULL
          AND a.id < b.id
      `);
      console.log(`    중복 삭제: ${deletePr.rowCount}건`);

      const afterPr = await client.query('SELECT count(*) FROM staging_product_report');
      console.log(`    결과: ${afterPr.rows[0].count}건 (${beforePrCount.rows[0].count - afterPr.rows[0].count}건 제거)\n`);
    }

    // ── 4. 최종 현황 ──
    console.log('========================================');
    console.log('  중복 제거 후 원본 DB 현황');
    console.log('========================================');

    const tables = [
      { name: 'staging_c005', label: 'C005 (바코드)' },
      { name: 'staging_nutrition', label: '영양성분DB' },
      { name: 'staging_ingredients', label: 'C002 (원재료)' },
      { name: 'staging_product_report', label: 'I1250 (품목제조보고)' },
    ];

    for (const t of tables) {
      try {
        const result = await client.query(`SELECT count(*) FROM ${t.name}`);
        console.log(`  ${t.label}: ${result.rows[0].count}건`);
      } catch {
        console.log(`  ${t.label}: 테이블 없음`);
      }
    }

    console.log('\n========================================');
    console.log('  원본 DB 정리 완료!');
    console.log('========================================');

  } catch (err) {
    console.error('오류:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
