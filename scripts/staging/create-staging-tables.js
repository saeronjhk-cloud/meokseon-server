/**
 * 스테이징 테이블 생성
 * 원본 데이터를 가공 없이 그대로 저장하는 임시 테이블입니다.
 * 병합은 모든 데이터가 수집된 후 별도 스크립트로 실행합니다.
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

async function createStagingTables() {
  const client = await pool.connect();

  try {
    console.log('========================================');
    console.log('  스테이징 테이블 생성');
    console.log('========================================\n');

    // 1. C005 스테이징 (바코드연계제품정보)
    await client.query(`
      CREATE TABLE IF NOT EXISTS staging_c005 (
        id BIGSERIAL PRIMARY KEY,
        bar_cd VARCHAR(20),
        prdlst_nm VARCHAR(500),
        bssh_nm VARCHAR(200),
        prdlst_dcnm VARCHAR(100),
        prdlst_report_no VARCHAR(50),
        raw_data JSONB,
        loaded_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_staging_c005_barcode ON staging_c005(bar_cd)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_staging_c005_name ON staging_c005 USING gin(prdlst_nm gin_trgm_ops)`);
    console.log('  ✅ staging_c005 생성 완료');

    // 2. 영양성분DB 스테이징
    await client.query(`
      CREATE TABLE IF NOT EXISTS staging_nutrition (
        id BIGSERIAL PRIMARY KEY,
        food_cd VARCHAR(30),
        food_nm_kr VARCHAR(500),
        db_class_nm VARCHAR(100),
        food_or_nm VARCHAR(200),
        maker_nm VARCHAR(200),
        serving_size VARCHAR(50),
        calories DECIMAL(10,2),
        protein DECIMAL(10,2),
        total_fat DECIMAL(10,2),
        total_carbs DECIMAL(10,2),
        total_sugars DECIMAL(10,2),
        sodium DECIMAL(10,2),
        cholesterol DECIMAL(10,2),
        saturated_fat DECIMAL(10,2),
        trans_fat DECIMAL(10,2),
        dietary_fiber DECIMAL(10,2),
        raw_data JSONB,
        loaded_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_staging_nutrition_name ON staging_nutrition USING gin(food_nm_kr gin_trgm_ops)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_staging_nutrition_foodcd ON staging_nutrition(food_cd)`);
    console.log('  ✅ staging_nutrition 생성 완료');

    // 3. 품목제조보고(원재료) 스테이징
    await client.query(`
      CREATE TABLE IF NOT EXISTS staging_ingredients (
        id BIGSERIAL PRIMARY KEY,
        prdlst_report_no VARCHAR(50),
        prdlst_nm VARCHAR(500),
        rawmtrl_nm TEXT,
        bssh_nm VARCHAR(200),
        prms_dt VARCHAR(20),
        raw_data JSONB,
        loaded_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_staging_ingredients_report ON staging_ingredients(prdlst_report_no)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_staging_ingredients_name ON staging_ingredients USING gin(prdlst_nm gin_trgm_ops)`);
    console.log('  ✅ staging_ingredients 생성 완료');

    // 현황 확인
    const tables = ['staging_c005', 'staging_nutrition', 'staging_ingredients'];
    console.log('\n  현재 데이터 건수:');
    for (const table of tables) {
      const result = await client.query(`SELECT count(*) FROM ${table}`);
      console.log(`    ${table}: ${result.rows[0].count}건`);
    }

    console.log('\n========================================');
    console.log('  스테이징 테이블 준비 완료!');
    console.log('========================================');

  } catch (err) {
    console.error('오류:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

createStagingTables();
