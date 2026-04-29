/**
 * Step 1: 병합 전 마이그레이션
 * - normalized_name / normalized_maker 컬럼 추가
 * - 법인 지시어 제거 함수 생성
 * - GIN 인덱스 생성
 * - unmatched_nutrition_pool 테이블 생성
 * - merge_log 테이블 생성
 * - products 테이블에 pog_daycnt 등 I1250 보강 컬럼 추가
 * - product_ingredients 테이블 생성
 *
 * 사용법: node scripts/merge/01-migration.js
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

/**
 * 컬럼이 존재하는지 확인
 */
async function columnExists(client, tableName, columnName) {
  const { rows } = await client.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = $1 AND column_name = $2
  `, [tableName, columnName]);
  return rows.length > 0;
}

/**
 * 안전하게 컬럼 추가 (존재하면 스킵)
 */
async function safeAddColumn(client, table, colName, colDef) {
  const exists = await columnExists(client, table, colName);
  if (exists) {
    console.log(`  ⏭️  ${table}.${colName} 이미 존재`);
    return false;
  }
  await client.query(`ALTER TABLE ${table} ADD COLUMN ${colName} ${colDef}`);
  console.log(`  ✅ ${table}.${colName} 컬럼 추가`);
  return true;
}

async function migrate() {
  const client = await pool.connect();

  try {
    console.log('========================================');
    console.log('  Step 1: 병합 전 마이그레이션');
    console.log('========================================\n');

    // ── 1. pg_trgm 확장 확인 ──
    await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    console.log('  ✅ pg_trgm 확장 확인');

    // ── 2. 법인 지시어 제거 SQL 함수 ──
    await client.query(`
      CREATE OR REPLACE FUNCTION strip_corp_indicator(name TEXT)
      RETURNS TEXT AS $$
      BEGIN
        RETURN regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(
                    COALESCE(name, ''),
                    '\\(주\\)', '', 'gi'
                  ),
                  '주식회사', '', 'gi'
                ),
                '유한회사', '', 'gi'
              ),
              '유한책임회사', '', 'gi'
            ),
            '㈜', '', 'gi'
          ),
          '\\s+', '', 'g'
        );
      END;
      $$ LANGUAGE plpgsql IMMUTABLE;
    `);
    console.log('  ✅ strip_corp_indicator() 함수 생성');

    // ── 3. 정규화 이름 함수 ──
    await client.query(`
      CREATE OR REPLACE FUNCTION normalize_product_name(name TEXT)
      RETURNS TEXT AS $$
      BEGIN
        RETURN lower(
          regexp_replace(
            COALESCE(name, ''),
            '[\\s()（）\\[\\]【】,，·•\\-_]+', '', 'g'
          )
        );
      END;
      $$ LANGUAGE plpgsql IMMUTABLE;
    `);
    console.log('  ✅ normalize_product_name() 함수 생성');

    // ── 4. products 테이블에 병합용 컬럼 추가 (트랜잭션 없이 개별 실행) ──
    await safeAddColumn(client, 'products', 'normalized_name',
      "TEXT GENERATED ALWAYS AS (normalize_product_name(product_name)) STORED");
    await safeAddColumn(client, 'products', 'normalized_maker',
      "TEXT GENERATED ALWAYS AS (strip_corp_indicator(manufacturer)) STORED");
    await safeAddColumn(client, 'products', 'pog_daycnt', "VARCHAR(100) DEFAULT NULL");
    await safeAddColumn(client, 'products', 'prms_dt_i1250', "VARCHAR(20) DEFAULT NULL");
    await safeAddColumn(client, 'products', 'hieng_lntrt_dvs_nm', "VARCHAR(50) DEFAULT NULL");
    await safeAddColumn(client, 'products', 'dispos', "VARCHAR(200) DEFAULT NULL");
    await safeAddColumn(client, 'products', 'frmlc_mtrqlt', "VARCHAR(200) DEFAULT NULL");

    // ── 5. staging_nutrition에 정규화 컬럼 추가 ──
    await safeAddColumn(client, 'staging_nutrition', 'normalized_name',
      "TEXT GENERATED ALWAYS AS (normalize_product_name(food_nm_kr)) STORED");
    await safeAddColumn(client, 'staging_nutrition', 'normalized_maker',
      "TEXT GENERATED ALWAYS AS (strip_corp_indicator(maker_nm)) STORED");

    // ── 6. GIN 인덱스 생성 ──
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_products_normalized_name ON products USING gin(normalized_name gin_trgm_ops)',
      'CREATE INDEX IF NOT EXISTS idx_products_normalized_maker ON products(normalized_maker)',
      'CREATE INDEX IF NOT EXISTS idx_products_report_no ON products(c005_report_no)',
      'CREATE INDEX IF NOT EXISTS idx_staging_nutrition_normalized ON staging_nutrition USING gin(normalized_name gin_trgm_ops)',
      'CREATE INDEX IF NOT EXISTS idx_staging_nutrition_maker ON staging_nutrition(normalized_maker)',
      'CREATE INDEX IF NOT EXISTS idx_staging_nutrition_dbclass ON staging_nutrition(db_class_nm)',
      'CREATE INDEX IF NOT EXISTS idx_staging_ingredients_report ON staging_ingredients(prdlst_report_no)',
    ];

    for (const idx of indexes) {
      await client.query(idx);
    }
    console.log('  ✅ GIN 인덱스 생성 완료');

    // ── 7. product_ingredients 테이블 생성 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_ingredients (
        id BIGSERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(product_id) ON DELETE CASCADE,
        raw_text TEXT NOT NULL,
        parsed_ingredients JSONB,
        prdlst_report_no VARCHAR(50),
        source VARCHAR(20) DEFAULT 'c002',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_product_ingredients_pid ON product_ingredients(product_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_product_ingredients_report ON product_ingredients(prdlst_report_no)`);
    console.log('  ✅ product_ingredients 테이블 생성');

    // ── 8. unmatched_nutrition_pool 테이블 생성 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS unmatched_nutrition_pool (
        id BIGSERIAL PRIMARY KEY,
        staging_nutrition_id BIGINT,
        food_cd VARCHAR(30),
        food_nm_kr VARCHAR(500),
        normalized_name TEXT,
        maker_nm VARCHAR(200),
        normalized_maker TEXT,
        db_class_nm VARCHAR(100),
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
        promoted_to_product_id INTEGER DEFAULT NULL,
        promoted_at TIMESTAMPTZ DEFAULT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_unmatched_pool_name ON unmatched_nutrition_pool USING gin(normalized_name gin_trgm_ops)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_unmatched_pool_maker ON unmatched_nutrition_pool(normalized_maker)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_unmatched_pool_promoted ON unmatched_nutrition_pool(promoted_to_product_id) WHERE promoted_to_product_id IS NULL`);
    console.log('  ✅ unmatched_nutrition_pool 테이블 생성');

    // ── 9. merge_log 테이블 생성 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS merge_log (
        id BIGSERIAL PRIMARY KEY,
        step VARCHAR(30) NOT NULL,
        status VARCHAR(20) NOT NULL,
        source_id BIGINT,
        source_table VARCHAR(50),
        target_product_id INTEGER,
        similarity_score DECIMAL(5,4),
        reject_reason VARCHAR(100),
        detail JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_merge_log_step ON merge_log(step)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_merge_log_status ON merge_log(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_merge_log_product ON merge_log(target_product_id)`);
    console.log('  ✅ merge_log 테이블 생성');

    // ── 결과 요약 ──
    console.log('\n========================================');
    console.log('  마이그레이션 완료 요약');
    console.log('========================================');

    const tables = ['products', 'staging_nutrition', 'staging_ingredients', 'staging_product_report',
                    'product_ingredients', 'unmatched_nutrition_pool', 'merge_log'];
    for (const t of tables) {
      try {
        const r = await client.query(`SELECT count(*) FROM ${t}`);
        console.log(`  ${t}: ${r.rows[0].count}건`);
      } catch {
        console.log(`  ${t}: (테이블 없음)`);
      }
    }

    console.log('\n========================================');
    console.log('  ✅ Step 1 마이그레이션 완료!');
    console.log('  다음: node scripts/merge/02-merge-report-no.js');
    console.log('========================================');

  } catch (err) {
    console.error('❌ 마이그레이션 실패:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
