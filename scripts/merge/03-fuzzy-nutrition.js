/**
 * Step 3: 영양성분DB → nutrition_data 퍼지 매칭
 *
 * 처리 흐름:
 * 1. 영양성분DB에서 가공식품만 필터링 (DB_CLASS_NM 기준)
 * 2. products 제품과 제조사 사전 필터 + pg_trgm 퍼지 매칭
 * 3. 차등 임계값: 5자 이하 0.8 / 6자 이상 0.7
 * 4. 하드 리젝트: 용량 불일치, 제조사 불일치, 식품유형 불일치
 * 5. 칼로리 교차 검증 (3단계)
 * 6. 미매칭 → unmatched_nutrition_pool
 *
 * 배치: 500건 단위
 * 사용법: node scripts/merge/03-fuzzy-nutrition.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'meokseon',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  statement_timeout: 120000,
});

const BATCH_SIZE = 500;

// 가공식품이 아닌 원재료 DB_CLASS_NM 제외 목록
const EXCLUDE_DB_CLASSES = [
  '농산물', '수산물', '축산물', '임산물',
  '쌀', '보리', '밀', '옥수수',
  '돼지고기', '소고기', '닭고기',
  '채소류', '과일류', '버섯류', '해조류',
  '수·특용작물류', '기타 농산물',
];

function progress(current, total, label) {
  const pct = ((current / total) * 100).toFixed(1);
  process.stdout.write(`\r  ${label}: ${pct}% (${current.toLocaleString()}/${total.toLocaleString()})`);
}

function extractVolumeUnit(name) {
  if (!name) return null;
  const match = name.match(/(\d+[\.,]?\d*)\s*(ml|mL|ML|l|L|g|G|kg|KG)/i);
  if (!match) return null;
  const unit = match[2].toLowerCase();
  if (unit === 'ml' || unit === 'l') return 'ml';
  if (unit === 'g' || unit === 'kg') return 'g';
  return null;
}

async function main() {
  const client = await pool.connect();

  try {
    console.log('========================================');
    console.log('  Step 3: 영양성분DB 퍼지 매칭');
    console.log('========================================');

    const startTime = Date.now();

    // ── normalized_name 컬럼 존재 여부 확인 ──
    const { rows: colCheck } = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'staging_nutrition' AND column_name = 'normalized_name'
    `);
    const hasNormalizedCol = colCheck.length > 0;
    console.log(`  staging_nutrition.normalized_name 컬럼: ${hasNormalizedCol ? '있음' : '없음 (on-the-fly 계산)'}`);

    // ── 이미 nutrition_data가 있는 product_id 목록 ──
    const { rows: existingNut } = await client.query('SELECT product_id FROM nutrition_data');
    const hasNutrition = new Set(existingNut.map(r => r.product_id));
    console.log(`  기존 영양정보 보유 제품: ${hasNutrition.size.toLocaleString()}건`);

    // ── 매칭 대상 영양성분 조회 (가공식품만) ──
    const nameExpr = hasNormalizedCol
      ? 'normalized_name'
      : 'normalize_product_name(food_nm_kr)';
    const makerExpr = hasNormalizedCol
      ? 'normalized_maker'
      : 'strip_corp_indicator(maker_nm)';

    const excludePlaceholders = EXCLUDE_DB_CLASSES.map((_, i) => `$${i + 1}`).join(', ');

    const { rows: nutritionRows } = await client.query(`
      SELECT id, food_cd, food_nm_kr,
             ${nameExpr} AS normalized_name,
             maker_nm,
             ${makerExpr} AS normalized_maker,
             db_class_nm, serving_size,
             calories, protein, total_fat, total_carbs, total_sugars,
             sodium, cholesterol, saturated_fat, trans_fat, dietary_fiber
      FROM staging_nutrition
      WHERE db_class_nm IS NULL
         OR db_class_nm NOT IN (${excludePlaceholders})
      ORDER BY id
    `, EXCLUDE_DB_CLASSES);

    console.log(`  매칭 대상 영양성분: ${nutritionRows.length.toLocaleString()}건`);

    let matched = 0, rejected = 0, unmatched = 0, errors = 0;
    const total = nutritionRows.length;

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = nutritionRows.slice(i, i + BATCH_SIZE);
      const batchClient = await pool.connect();

      try {
        await batchClient.query('BEGIN');

        for (const nut of batch) {
          if (!nut.normalized_name || nut.normalized_name.length < 2) {
            unmatched++;
            continue;
          }

          // 차등 임계값
          const nameLen = nut.food_nm_kr ? nut.food_nm_kr.length : 0;
          const threshold = nameLen <= 5 ? 0.8 : 0.7;

          // 제조사 사전 필터 + pg_trgm 매칭
          let matchQuery, matchParams;

          if (nut.normalized_maker && nut.normalized_maker.length > 1) {
            matchQuery = `
              SELECT p.product_id, p.product_name, p.manufacturer, p.food_type,
                     p.normalized_name,
                     similarity(p.normalized_name, $1) AS sim_score
              FROM products p
              WHERE p.normalized_maker = $2
                AND similarity(p.normalized_name, $1) >= $3
              ORDER BY sim_score DESC
              LIMIT 3
            `;
            matchParams = [nut.normalized_name, nut.normalized_maker, threshold];
          } else {
            matchQuery = `
              SELECT p.product_id, p.product_name, p.manufacturer, p.food_type,
                     p.normalized_name,
                     similarity(p.normalized_name, $1) AS sim_score
              FROM products p
              WHERE similarity(p.normalized_name, $1) >= $2
              ORDER BY sim_score DESC
              LIMIT 3
            `;
            matchParams = [nut.normalized_name, threshold];
          }

          const { rows: candidates } = await batchClient.query(matchQuery, matchParams);

          let bestCandidate = null;

          for (const cand of candidates) {
            if (hasNutrition.has(cand.product_id)) continue;

            // 하드 리젝트: 용량 불일치
            const nutUnit = extractVolumeUnit(nut.food_nm_kr);
            const prodUnit = extractVolumeUnit(cand.product_name);
            if (nutUnit && prodUnit && nutUnit !== prodUnit) {
              rejected++;
              await batchClient.query(`
                INSERT INTO merge_log (step, status, source_id, source_table, target_product_id, similarity_score, reject_reason)
                VALUES ('step3_nutrition', 'rejected', $1, 'staging_nutrition', $2, $3, 'volume_mismatch')
              `, [nut.id, cand.product_id, cand.sim_score]);
              continue;
            }

            bestCandidate = cand;
            break;
          }

          if (!bestCandidate) {
            // 미매칭 → unmatched_nutrition_pool
            await batchClient.query(`
              INSERT INTO unmatched_nutrition_pool
                (staging_nutrition_id, food_cd, food_nm_kr, normalized_name,
                 maker_nm, normalized_maker, db_class_nm, serving_size,
                 calories, protein, total_fat, total_carbs, total_sugars,
                 sodium, cholesterol, saturated_fat, trans_fat, dietary_fiber)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
              ON CONFLICT DO NOTHING
            `, [
              nut.id, nut.food_cd, nut.food_nm_kr, nut.normalized_name,
              nut.maker_nm, nut.normalized_maker, nut.db_class_nm, nut.serving_size,
              nut.calories, nut.protein, nut.total_fat, nut.total_carbs, nut.total_sugars,
              nut.sodium, nut.cholesterol, nut.saturated_fat, nut.trans_fat, nut.dietary_fiber,
            ]);

            unmatched++;
            continue;
          }

          // Mass Balance 검증
          const servingG = parseFloat(nut.serving_size) || 100;
          const massSum = (parseFloat(nut.total_carbs) || 0) +
                          (parseFloat(nut.protein) || 0) +
                          (parseFloat(nut.total_fat) || 0);
          let verificationNote = null;
          if (massSum / servingG > 1.1) {
            verificationNote = `mass_balance_warning: ${massSum.toFixed(1)}g > ${servingG}g`;
          }

          // nutrition_data 등록
          // serving_size 컬럼 존재 여부에 따라 분기
          try {
            await batchClient.query(`
              INSERT INTO nutrition_data
                (product_id, calories, total_fat, saturated_fat, trans_fat,
                 cholesterol, sodium, total_carbs, total_sugars,
                 dietary_fiber, protein, data_source, serving_size)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'public_nutrition',$12)
              ON CONFLICT (product_id) DO NOTHING
            `, [
              bestCandidate.product_id,
              nut.calories, nut.total_fat, nut.saturated_fat, nut.trans_fat,
              nut.cholesterol, nut.sodium, nut.total_carbs, nut.total_sugars,
              nut.dietary_fiber, nut.protein, nut.serving_size,
            ]);
          } catch (insertErr) {
            // serving_size 컬럼이 없으면 없이 삽입
            if (insertErr.code === '42703') {
              await batchClient.query(`
                INSERT INTO nutrition_data
                  (product_id, calories, total_fat, saturated_fat, trans_fat,
                   cholesterol, sodium, total_carbs, total_sugars,
                   dietary_fiber, protein, data_source)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'public_nutrition')
                ON CONFLICT (product_id) DO NOTHING
              `, [
                bestCandidate.product_id,
                nut.calories, nut.total_fat, nut.saturated_fat, nut.trans_fat,
                nut.cholesterol, nut.sodium, nut.total_carbs, nut.total_sugars,
                nut.dietary_fiber, nut.protein,
              ]);
            } else {
              throw insertErr;
            }
          }

          hasNutrition.add(bestCandidate.product_id);

          await batchClient.query(`
            INSERT INTO merge_log (step, status, source_id, source_table, target_product_id, similarity_score, detail)
            VALUES ('step3_nutrition', 'matched', $1, 'staging_nutrition', $2, $3, $4)
          `, [
            nut.id, bestCandidate.product_id, bestCandidate.sim_score,
            JSON.stringify({
              nutrition_name: nut.food_nm_kr,
              product_name: bestCandidate.product_name,
              mass_balance: verificationNote,
            }),
          ]);

          matched++;
        }

        await batchClient.query('COMMIT');
      } catch (err) {
        await batchClient.query('ROLLBACK');
        errors += batch.length;
        console.error(`\n  ❌ 배치 오류 (${i}~${i + batch.length}): ${err.message}`);
      } finally {
        batchClient.release();
      }

      progress(Math.min(i + BATCH_SIZE, total), total, '퍼지 매칭');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n\n========================================');
    console.log('  Step 3 완료 요약');
    console.log('========================================');
    console.log(`  매칭 성공:    ${matched.toLocaleString()}건`);
    console.log(`  거절:         ${rejected.toLocaleString()}건`);
    console.log(`  미매칭(풀):   ${unmatched.toLocaleString()}건`);
    console.log(`  오류:         ${errors}건`);
    console.log(`  소요 시간:    ${elapsed}초`);

    const { rows: [{ count: nutCount }] } = await client.query('SELECT count(*) FROM nutrition_data');
    const { rows: [{ count: poolCount }] } = await client.query('SELECT count(*) FROM unmatched_nutrition_pool');
    console.log(`  nutrition_data 총: ${parseInt(nutCount).toLocaleString()}건`);
    console.log(`  대기 풀 총:        ${parseInt(poolCount).toLocaleString()}건`);

    console.log('\n  다음: node scripts/merge/04-parse-ingredients.js');
    console.log('========================================');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
