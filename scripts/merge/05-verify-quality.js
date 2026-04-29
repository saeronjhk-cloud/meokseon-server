/**
 * Step 5: 병합 품질 검증
 *
 * 검증 항목:
 * 1. 통계적 이상치 탐지 (나트륨 10,000mg↑, Mass Balance 초과 등)
 * 2. Null Rate (결측치) 모니터링
 * 3. merge_log 기반 통계 리포트
 * 4. 품목유형별 매칭률 분석
 * 5. 전체 커버리지 요약
 *
 * 사용법: node scripts/merge/05-verify-quality.js
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
    console.log('╔════════════════════════════════════════════╗');
    console.log('║   먹선 데이터 병합 품질 검증 리포트        ║');
    console.log('╚════════════════════════════════════════════╝\n');

    // ═══════════════════════════════════════
    // 1. 전체 커버리지 요약
    // ═══════════════════════════════════════
    console.log('━━━ 1. 전체 커버리지 ━━━');

    const { rows: [prodCount] } = await client.query('SELECT count(*) as cnt FROM products');
    const { rows: [nutCount] } = await client.query('SELECT count(*) as cnt FROM nutrition_data');
    const { rows: [ingCount] } = await client.query('SELECT count(*) as cnt FROM product_ingredients');
    const { rows: [addCount] } = await client.query('SELECT count(DISTINCT product_id) as cnt FROM product_additives');
    const { rows: [poolCount] } = await client.query('SELECT count(*) as cnt FROM unmatched_nutrition_pool');
    const { rows: [activeCount] } = await client.query("SELECT count(*) as cnt FROM products WHERE is_active = true");
    const { rows: [inactiveCount] } = await client.query("SELECT count(*) as cnt FROM products WHERE is_active = false");
    const { rows: [barcodeCount] } = await client.query("SELECT count(*) as cnt FROM products WHERE barcode IS NOT NULL AND barcode != ''");

    const totalProducts = parseInt(prodCount.cnt);
    const totalNutrition = parseInt(nutCount.cnt);
    const totalIngredients = parseInt(ingCount.cnt);

    console.log(`  총 제품 수:           ${totalProducts.toLocaleString()}건`);
    console.log(`  바코드 보유:          ${parseInt(barcodeCount.cnt).toLocaleString()}건`);
    console.log(`  활성 제품:            ${parseInt(activeCount.cnt).toLocaleString()}건`);
    console.log(`  단종 제품:            ${parseInt(inactiveCount.cnt).toLocaleString()}건`);
    console.log(`  영양정보 보유:        ${totalNutrition.toLocaleString()}건 (${(totalNutrition/totalProducts*100).toFixed(1)}%)`);
    console.log(`  원재료 보유:          ${totalIngredients.toLocaleString()}건 (${(totalIngredients/totalProducts*100).toFixed(1)}%)`);
    console.log(`  첨가물 분석 완료:     ${parseInt(addCount.cnt).toLocaleString()}건`);
    console.log(`  미매칭 영양 대기풀:   ${parseInt(poolCount.cnt).toLocaleString()}건`);

    // ═══════════════════════════════════════
    // 2. merge_log 기반 단계별 통계
    // ═══════════════════════════════════════
    console.log('\n━━━ 2. 단계별 병합 통계 ━━━');

    const { rows: logStats } = await client.query(`
      SELECT step, status, count(*) as cnt
      FROM merge_log
      GROUP BY step, status
      ORDER BY step, status
    `);

    let currentStep = '';
    for (const row of logStats) {
      if (row.step !== currentStep) {
        currentStep = row.step;
        console.log(`\n  [${currentStep}]`);
      }
      console.log(`    ${row.status}: ${parseInt(row.cnt).toLocaleString()}건`);
    }

    // ═══════════════════════════════════════
    // 3. 이상치 탐지
    // ═══════════════════════════════════════
    console.log('\n━━━ 3. 이상치 탐지 ━━━');

    // 3-1. 나트륨 10,000mg 이상
    const { rows: highSodium } = await client.query(`
      SELECT n.product_id, p.product_name, n.sodium
      FROM nutrition_data n
      JOIN products p ON n.product_id = p.product_id
      WHERE n.sodium > 10000
      ORDER BY n.sodium DESC
      LIMIT 10
    `);
    console.log(`\n  나트륨 > 10,000mg: ${highSodium.length}건`);
    for (const r of highSodium) {
      console.log(`    ${r.product_name}: ${r.sodium}mg`);
    }

    // 3-2. 칼로리 0 이하 (비정상)
    const { rows: [zeroCal] } = await client.query(`
      SELECT count(*) as cnt FROM nutrition_data WHERE calories <= 0 OR calories IS NULL
    `);
    console.log(`  칼로리 0 이하/NULL:  ${parseInt(zeroCal.cnt).toLocaleString()}건`);

    // 3-3. Mass Balance 초과 (탄+단+지 > serving_size * 1.1)
    let massViolations = [];
    try {
      const { rows } = await client.query(`
        SELECT n.product_id, p.product_name,
               n.total_carbs, n.protein, n.total_fat,
               n.serving_size,
               (COALESCE(n.total_carbs,0) + COALESCE(n.protein,0) + COALESCE(n.total_fat,0)) as macro_sum
        FROM nutrition_data n
        JOIN products p ON n.product_id = p.product_id
        WHERE n.serving_size IS NOT NULL
          AND n.serving_size ~ '^[0-9]+(\\.[0-9]+)?$'
          AND CAST(n.serving_size AS DECIMAL) > 0
          AND (COALESCE(n.total_carbs,0) + COALESCE(n.protein,0) + COALESCE(n.total_fat,0))
              > CAST(n.serving_size AS DECIMAL) * 1.1
        ORDER BY macro_sum DESC
        LIMIT 10
      `);
      massViolations = rows;
    } catch (e) {
      console.log(`  ⚠️ Mass Balance 쿼리 실패: ${e.message}`);
    }
    console.log(`\n  Mass Balance 초과:   ${massViolations.length}건 (상위 10개)`);
    for (const r of massViolations) {
      console.log(`    ${r.product_name}: 매크로합 ${parseFloat(r.macro_sum).toFixed(1)}g > 기준량 ${r.serving_size}`);
    }

    // ═══════════════════════════════════════
    // 4. Null Rate (결측치) 모니터링
    // ═══════════════════════════════════════
    console.log('\n━━━ 4. Null Rate 모니터링 ━━━');

    const nutritionCols = ['calories', 'protein', 'total_fat', 'total_carbs', 'sodium',
                           'total_sugars', 'saturated_fat', 'trans_fat', 'cholesterol', 'dietary_fiber'];

    if (totalNutrition > 0) {
      for (const col of nutritionCols) {
        const { rows: [{ cnt }] } = await client.query(
          `SELECT count(*) as cnt FROM nutrition_data WHERE ${col} IS NULL`
        );
        const nullRate = (parseInt(cnt) / totalNutrition * 100).toFixed(1);
        const bar = nullRate > 10 ? '⚠️' : '✅';
        console.log(`  ${bar} ${col}: ${nullRate}% NULL (${parseInt(cnt).toLocaleString()}건)`);
      }
    }

    // ═══════════════════════════════════════
    // 5. 품목유형별 매칭률
    // ═══════════════════════════════════════
    console.log('\n━━━ 5. 품목유형별 커버리지 (상위 15개) ━━━');

    const { rows: foodTypeStats } = await client.query(`
      SELECT
        p.food_type,
        count(*) as total,
        count(n.product_id) as with_nutrition,
        count(pi.product_id) as with_ingredients,
        ROUND(count(n.product_id)::DECIMAL / count(*) * 100, 1) as nut_rate,
        ROUND(count(pi.product_id)::DECIMAL / count(*) * 100, 1) as ing_rate
      FROM products p
      LEFT JOIN nutrition_data n ON p.product_id = n.product_id
      LEFT JOIN product_ingredients pi ON p.product_id = pi.product_id
      WHERE p.food_type IS NOT NULL AND p.food_type != ''
      GROUP BY p.food_type
      HAVING count(*) >= 10
      ORDER BY count(*) DESC
      LIMIT 15
    `);

    console.log(`  ${'품목유형'.padEnd(20)} ${'총'.padStart(7)} ${'영양'.padStart(7)} ${'원재료'.padStart(7)} ${'영양%'.padStart(7)} ${'원재료%'.padStart(7)}`);
    console.log('  ' + '─'.repeat(62));
    for (const r of foodTypeStats) {
      const ft = (r.food_type || '').substring(0, 18).padEnd(20);
      console.log(`  ${ft} ${String(r.total).padStart(7)} ${String(r.with_nutrition).padStart(7)} ${String(r.with_ingredients).padStart(7)} ${String(r.nut_rate + '%').padStart(7)} ${String(r.ing_rate + '%').padStart(7)}`);
    }

    // ═══════════════════════════════════════
    // 6. 거절 사유 분석
    // ═══════════════════════════════════════
    console.log('\n━━━ 6. 거절 사유 분석 ━━━');

    const { rows: rejectStats } = await client.query(`
      SELECT reject_reason, count(*) as cnt
      FROM merge_log
      WHERE status = 'rejected'
      GROUP BY reject_reason
      ORDER BY count(*) DESC
    `);

    if (rejectStats.length > 0) {
      for (const r of rejectStats) {
        console.log(`  ${r.reject_reason}: ${parseInt(r.cnt).toLocaleString()}건`);
      }
    } else {
      console.log('  거절 건 없음');
    }

    console.log('\n╔════════════════════════════════════════════╗');
    console.log('║   품질 검증 완료                            ║');
    console.log('╚════════════════════════════════════════════╝');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
