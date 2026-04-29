/**
 * Step 1b: 핫픽스 마이그레이션
 * - dispos, frmlc_mtrqlt → TEXT 확장 (VARCHAR(200) 초과 데이터 대응)
 * - nutrition_data에 serving_size 컬럼 추가
 * - 실패한 데이터 정리 (C002 재실행 대비)
 *
 * 사용법: node scripts/merge/01b-hotfix.js
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

async function columnExists(client, table, col) {
  const { rows } = await client.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = $1 AND column_name = $2
  `, [table, col]);
  return rows.length > 0;
}

async function main() {
  const client = await pool.connect();

  try {
    console.log('========================================');
    console.log('  Step 1b: 핫픽스 마이그레이션');
    console.log('========================================\n');

    // 1. dispos, frmlc_mtrqlt → TEXT 확장
    await client.query(`ALTER TABLE products ALTER COLUMN dispos TYPE TEXT`);
    console.log('  ✅ products.dispos → TEXT 확장');

    await client.query(`ALTER TABLE products ALTER COLUMN frmlc_mtrqlt TYPE TEXT`);
    console.log('  ✅ products.frmlc_mtrqlt → TEXT 확장');

    // 2. nutrition_data에 serving_size 컬럼 추가
    const hasSS = await columnExists(client, 'nutrition_data', 'serving_size');
    if (!hasSS) {
      await client.query(`ALTER TABLE nutrition_data ADD COLUMN serving_size VARCHAR(50) DEFAULT NULL`);
      console.log('  ✅ nutrition_data.serving_size 컬럼 추가');
    } else {
      console.log('  ⏭️  nutrition_data.serving_size 이미 존재');
    }

    // 3. Step 2에서 실패한 데이터 정리 (재실행 대비)
    // I1250: 성공한 건은 유지, 실패한 1배치만 재처리되도록 merge_log에서 step2 에러 삭제
    // C002: 거의 다 실패했으므로 product_ingredients에 들어간 10건 + merge_log 정리
    const { rows: [{ count: piCount }] } = await client.query(
      `SELECT count(*) FROM product_ingredients WHERE source = 'c002'`
    );
    console.log(`\n  현재 product_ingredients (c002): ${piCount}건`);

    // product_ingredients 초기화 (10건뿐이므로)
    await client.query(`DELETE FROM product_ingredients WHERE source = 'c002'`);
    console.log('  ✅ product_ingredients (c002) 초기화');

    // C002 관련 merge_log 정리
    await client.query(`DELETE FROM merge_log WHERE step = 'step2_c002'`);
    console.log('  ✅ merge_log (step2_c002) 초기화');

    // I1250 에러 배치의 merge_log는 기록 안 됨 (롤백됨) → 별도 정리 불필요
    // I1250에서 매칭 안 된 제품만 재처리하도록 02 스크립트에서 처리

    console.log('\n========================================');
    console.log('  ✅ 핫픽스 완료!');
    console.log('  다음: node scripts/merge/02-merge-report-no.js');
    console.log('========================================');

  } catch (err) {
    console.error('❌ 핫픽스 실패:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
