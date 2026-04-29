/**
 * 먹선 DB 데이터 적재 스크립트
 * Node.js로 직접 PostgreSQL에 데이터 삽입 (인코딩 문제 없음)
 */

require('dotenv').config();
const { Pool } = require('pg');
const { c005Data, nutritionData } = require('../tests/sample_100_products');
const { mergeDatasets } = require('./data-pipeline/mergePublicData');
const { detectFoodCategory } = require('../src/services/nutritionTrafficLight');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'meokseon',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function seedData() {
  const client = await pool.connect();

  try {
    console.log('========================================');
    console.log('  MeokSeon Data Seeding');
    console.log('========================================\n');

    // 스키마 재생성 (한국어 인코딩 문제 우회)
    console.log('[0] Rebuilding schema...');

    // ENUM types
    await client.query(`DO $$ BEGIN
      DROP TYPE IF EXISTS data_source_type CASCADE;
      DROP TYPE IF EXISTS verification_status CASCADE;
      DROP TYPE IF EXISTS food_category CASCADE;
      DROP TYPE IF EXISTS traffic_light_color CASCADE;
      DROP TYPE IF EXISTS mfras_grade CASCADE;
      DROP TYPE IF EXISTS user_profile_type CASCADE;
    END $$;`);

    await client.query(`CREATE TYPE data_source_type AS ENUM ('public_c005','public_nutrition','ocr_crowdsource','open_food_facts','manual_seed')`);
    await client.query(`CREATE TYPE verification_status AS ENUM ('unverified','partial','verified','admin_verified')`);
    await client.query(`CREATE TYPE food_category AS ENUM ('general','beverage','dried','fermented','sauce','nuts','dairy','juice','whole_grain','alcohol','supplement','raw_ingredient')`);
    await client.query(`CREATE TYPE traffic_light_color AS ENUM ('green','yellow','red','gray')`);
    await client.query(`CREATE TYPE mfras_grade AS ENUM ('green','yellow','orange','red')`);
    await client.query(`CREATE TYPE user_profile_type AS ENUM ('adult','pregnant','infant','child','hypertension','diabetes','kidney')`);
    console.log('  ENUM types created');

    // Drop existing tables
    await client.query(`DROP TABLE IF EXISTS contributions, scan_history, favorites, nutrition_traffic_light, product_additives, additives, product_ingredients, nutrition_data, nutrition_config, context_messages, ocr_sanity_limits, dried_food_keywords, users, products CASCADE`);

    // Products table
    await client.query(`CREATE TABLE products (
      product_id BIGSERIAL PRIMARY KEY,
      barcode VARCHAR(20),
      product_name VARCHAR(500) NOT NULL,
      brand VARCHAR(200),
      manufacturer VARCHAR(200),
      food_type VARCHAR(100),
      food_category food_category DEFAULT 'general',
      serving_size DECIMAL(10,2),
      serving_unit VARCHAR(10) DEFAULT 'g',
      total_content DECIMAL(10,2),
      content_unit VARCHAR(10) DEFAULT 'g',
      servings_per_container DECIMAL(5,1),
      image_url TEXT,
      image_front_url TEXT,
      image_label_url TEXT,
      data_source data_source_type NOT NULL,
      verification verification_status DEFAULT 'unverified',
      verify_count INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      c005_report_no VARCHAR(50),
      public_food_cd VARCHAR(20)
    )`);
    await client.query(`CREATE UNIQUE INDEX idx_products_barcode_unique ON products(barcode) WHERE barcode IS NOT NULL`);
    await client.query(`CREATE INDEX idx_products_name_trgm ON products USING gin(product_name gin_trgm_ops)`);
    await client.query(`CREATE INDEX idx_products_category ON products(food_category)`);
    console.log('  products table created');

    // Nutrition data table
    await client.query(`CREATE TABLE nutrition_data (
      nutrition_id BIGSERIAL PRIMARY KEY,
      product_id BIGINT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
      calories DECIMAL(8,2),
      total_fat DECIMAL(7,2),
      saturated_fat DECIMAL(7,2),
      trans_fat DECIMAL(7,2),
      cholesterol DECIMAL(7,2),
      sodium DECIMAL(8,2),
      total_carbs DECIMAL(7,2),
      total_sugars DECIMAL(7,2),
      added_sugars DECIMAL(7,2),
      dietary_fiber DECIMAL(7,2),
      protein DECIMAL(7,2),
      calcium DECIMAL(7,2),
      iron DECIMAL(7,2),
      vitamin_d DECIMAL(7,2),
      potassium DECIMAL(7,2),
      data_source data_source_type DEFAULT 'public_nutrition',
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(product_id)
    )`);
    console.log('  nutrition_data table created');

    // Additives table
    await client.query(`CREATE TABLE additives (
      additive_id BIGSERIAL PRIMARY KEY,
      name_ko VARCHAR(200) NOT NULL,
      name_en VARCHAR(200),
      e_number VARCHAR(10),
      cas_number VARCHAR(20),
      risk_grade INT DEFAULT 0,
      risk_color VARCHAR(10) DEFAULT 'gray',
      category VARCHAR(100),
      description TEXT,
      max_daily_intake VARCHAR(50),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    console.log('  additives table created');

    // Product additives junction
    await client.query(`CREATE TABLE product_additives (
      product_id BIGINT REFERENCES products(product_id) ON DELETE CASCADE,
      additive_id BIGINT REFERENCES additives(additive_id) ON DELETE CASCADE,
      amount DECIMAL(10,3),
      unit VARCHAR(20),
      PRIMARY KEY (product_id, additive_id)
    )`);
    console.log('  product_additives table created');

    // Traffic light cache
    await client.query(`CREATE TABLE nutrition_traffic_light (
      tl_id BIGSERIAL PRIMARY KEY,
      product_id BIGINT UNIQUE REFERENCES products(product_id) ON DELETE CASCADE,
      food_category food_category,
      sodium_color traffic_light_color,
      sodium_pct_dv DECIMAL(5,1),
      sodium_basis VARCHAR(20),
      sugars_color traffic_light_color,
      sugars_pct_dv DECIMAL(5,1),
      sugars_basis VARCHAR(20),
      sat_fat_color traffic_light_color,
      sat_fat_pct_dv DECIMAL(5,1),
      sat_fat_basis VARCHAR(20),
      total_fat_color traffic_light_color,
      total_fat_pct_dv DECIMAL(5,1),
      total_fat_basis VARCHAR(20),
      cholesterol_color traffic_light_color,
      cholesterol_pct_dv DECIMAL(5,1),
      protein_color traffic_light_color,
      protein_pct_dv DECIMAL(5,1),
      fiber_color traffic_light_color,
      fiber_pct_dv DECIMAL(5,1),
      trans_fat_color traffic_light_color,
      is_dried_exception BOOLEAN DEFAULT FALSE,
      context_messages JSONB DEFAULT '[]',
      multi_serving_count DECIMAL(5,1),
      evaluated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    console.log('  nutrition_traffic_light table created');

    // Nutrition config
    await client.query(`CREATE TABLE nutrition_config (
      config_id BIGSERIAL PRIMARY KEY,
      nutrient VARCHAR(50) NOT NULL,
      threshold VARCHAR(50) NOT NULL,
      basis VARCHAR(20) NOT NULL,
      value DECIMAL(10,3) NOT NULL,
      unit VARCHAR(10),
      profile user_profile_type DEFAULT 'adult',
      effective_from DATE DEFAULT CURRENT_DATE,
      effective_to DATE,
      source VARCHAR(200),
      notes TEXT
    )`);
    console.log('  nutrition_config table created');

    // Context messages
    await client.query(`CREATE TABLE context_messages (
      message_id BIGSERIAL PRIMARY KEY,
      food_category VARCHAR(50),
      nutrient VARCHAR(50),
      message_ko TEXT,
      display_type VARCHAR(20) DEFAULT 'tooltip'
    )`);
    console.log('  context_messages table created');

    // OCR sanity limits
    await client.query(`CREATE TABLE ocr_sanity_limits (
      limit_id BIGSERIAL PRIMARY KEY,
      nutrient VARCHAR(50) NOT NULL,
      per_serving_max DECIMAL(10,2),
      per_100g_max DECIMAL(10,2),
      unit VARCHAR(10),
      notes TEXT
    )`);
    console.log('  ocr_sanity_limits table created');

    // Dried food keywords
    await client.query(`CREATE TABLE dried_food_keywords (
      keyword_id BIGSERIAL PRIMARY KEY,
      keyword VARCHAR(50) NOT NULL,
      category_match VARCHAR(50),
      priority INT DEFAULT 1
    )`);
    console.log('  dried_food_keywords table created');

    // Users table
    await client.query(`CREATE TABLE users (
      user_id BIGSERIAL PRIMARY KEY,
      firebase_uid VARCHAR(128) UNIQUE,
      email VARCHAR(255),
      display_name VARCHAR(100),
      profile_type user_profile_type DEFAULT 'adult',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_login TIMESTAMPTZ
    )`);
    console.log('  users table created');

    // Scan history
    await client.query(`CREATE TABLE scan_history (
      scan_id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(user_id) ON DELETE CASCADE,
      product_id BIGINT REFERENCES products(product_id),
      scanned_at TIMESTAMPTZ DEFAULT NOW(),
      scan_type VARCHAR(20) DEFAULT 'barcode'
    )`);
    console.log('  scan_history table created');

    // Favorites
    await client.query(`CREATE TABLE favorites (
      user_id BIGINT REFERENCES users(user_id) ON DELETE CASCADE,
      product_id BIGINT REFERENCES products(product_id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, product_id)
    )`);
    console.log('  favorites table created');

    // Contributions
    await client.query(`CREATE TABLE contributions (
      contribution_id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(user_id),
      product_id BIGINT REFERENCES products(product_id),
      contribution_type VARCHAR(50),
      data JSONB,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    console.log('  contributions table created');

    // Updated_at trigger
    await client.query(`CREATE OR REPLACE FUNCTION update_updated_at()
      RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await client.query(`CREATE TRIGGER trg_products_updated BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION update_updated_at()`);
    console.log('  triggers created');

    console.log('  Schema rebuild complete!\n');

    // 병합 실행
    console.log('[1] Merging C005 + Nutrition DB...');
    const result = mergeDatasets(c005Data, nutritionData, { minSimilarity: 0.4 });
    const allProducts = [...result.matched, ...result.c005Only, ...result.nutritionOnly];
    console.log(`    Total: ${allProducts.length} products\n`);

    // 삽입
    console.log('[2] Inserting products...');
    let productCount = 0;
    let nutritionCount = 0;

    await client.query('BEGIN');

    for (const p of allProducts) {
      const category = detectFoodCategory({
        product_name: p.product_name,
        food_type: p.food_type,
        content_unit: p.content_unit,
      });

      const dataSource = p.data_source === 'public_merged' ? 'public_c005' : (p.data_source || 'public_c005');

      // products INSERT
      const prodResult = await client.query(
        `INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category,
         serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING product_id`,
        [
          p.barcode || `NO_BARCODE_${productCount}`,
          p.product_name,
          null,
          p.manufacturer,
          p.food_type,
          category,
          p.serving_size || null,
          p.total_content || null,
          p.content_unit || 'g',
          dataSource,
          p.report_no || null,
          p.public_food_cd || null,
        ]
      );

      const productId = prodResult.rows[0].product_id;
      productCount++;

      // nutrition_data INSERT
      if (p.nutrition) {
        const n = p.nutrition;
        await client.query(
          `INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat,
           cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            productId,
            n.calories ?? null,
            n.total_fat ?? null,
            n.saturated_fat ?? null,
            n.trans_fat ?? null,
            n.cholesterol ?? null,
            n.sodium ?? null,
            n.total_carbs ?? null,
            n.total_sugars ?? null,
            n.dietary_fiber ?? null,
            n.protein ?? null,
            p.data_source === 'public_merged' ? 'public_nutrition' : (p.data_source || 'public_nutrition'),
          ]
        );
        nutritionCount++;
      }
    }

    await client.query('COMMIT');

    console.log(`    Products:  ${productCount}`);
    console.log(`    Nutrition: ${nutritionCount}\n`);

    // 검증
    console.log('[3] Verifying...');
    const prodCheck = await client.query('SELECT count(*) FROM products');
    const nutCheck = await client.query('SELECT count(*) FROM nutrition_data');
    const catCheck = await client.query('SELECT food_category, count(*) FROM products GROUP BY food_category ORDER BY count DESC');

    console.log(`    Products in DB:  ${prodCheck.rows[0].count}`);
    console.log(`    Nutrition in DB: ${nutCheck.rows[0].count}`);
    console.log('\n    Category distribution:');
    for (const row of catCheck.rows) {
      console.log(`      ${row.food_category}: ${row.count}`);
    }

    // 바코드 조회 테스트
    console.log('\n[4] Barcode lookup test...');
    const testProduct = await client.query(
      `SELECT p.product_name, p.food_category, n.sodium, n.calories
       FROM products p
       LEFT JOIN nutrition_data n ON p.product_id = n.product_id
       WHERE p.barcode = '8801043012607'`
    );
    if (testProduct.rows.length > 0) {
      const t = testProduct.rows[0];
      console.log(`    Barcode 8801043012607 => ${t.product_name} (${t.food_category})`);
      console.log(`    Calories: ${t.calories}, Sodium: ${t.sodium}mg`);
    }

    console.log('\n========================================');
    console.log('  Data seeding complete!');
    console.log('========================================');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seedData();
