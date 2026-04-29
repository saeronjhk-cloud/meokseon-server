/**
 * Step 8: additives 핫픽스
 *
 * 1. cas_number VARCHAR(20) → VARCHAR(50) 확장
 * 2. 누락된 소르비탄지방산에스테르 1건 재삽입
 *
 * 사용법: node scripts/merge/08-hotfix-additives.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
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
    console.log('  Step 8: additives 핫픽스');
    console.log('========================================\n');

    // 1. cas_number 컬럼 확장
    await client.query(`ALTER TABLE additives ALTER COLUMN cas_number TYPE VARCHAR(50)`);
    console.log('  ✅ cas_number → VARCHAR(50) 확장');

    // 2. 누락된 소르비탄지방산에스테르 재삽입
    const jsonPath = path.resolve(__dirname, '../../..', 'week1_pipeline/additive_risk_db_v2.0.json');
    const rawData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const item = rawData['소르비탄지방산에스테르'];

    if (item) {
      const riskColor = (item.original_color || 'gray').toLowerCase();
      const riskGrade = item.original_grade || 0;

      const descParts = [];
      if (item.category) descParts.push(`분류: ${item.category}`);
      if (item.regulatory_status) descParts.push(`규제: ${item.regulatory_status}`);
      if (item.genotox_status) descParts.push(`유전독성: ${item.genotox_status}`);
      if (item.data_sufficiency) descParts.push(`데이터: ${item.data_sufficiency}`);

      await client.query(`
        INSERT INTO additives (name_ko, name_en, e_number, cas_number, risk_grade, risk_color, category, description, max_daily_intake)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT DO NOTHING
      `, [
        item.name_kr, item.name_en, item.e_number, item.cas_no,
        riskGrade, riskColor, item.category,
        descParts.join(' | '),
        item.adi_value ? `${item.adi_value} mg/kg bw/day` : 'Group ADI',
      ]);
      console.log(`  ✅ 소르비탄지방산에스테르 재삽입 (cas: ${item.cas_no})`);
    }

    // 3. 최종 확인
    const { rows: [{ count }] } = await client.query('SELECT count(*) FROM additives');
    console.log(`\n  additives 테이블 총: ${count}건`);

    console.log('\n========================================');
    console.log('  ✅ 핫픽스 완료!');
    console.log('========================================');

  } catch (err) {
    console.error('❌ 핫픽스 실패:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
