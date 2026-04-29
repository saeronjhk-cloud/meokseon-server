/**
 * Step 9: 영양DB 매칭률 개선 (Gemini 피드백 반영)
 *
 * 기존 03-fuzzy-nutrition.js 결과(2,311건)를 보존하면서,
 * 아직 영양정보가 없는 제품에 대해 추가 매칭을 시도합니다.
 *
 * 개선 사항:
 * 1. 정규화 고도화 — 용량/단위/포장형태/수식어 제거
 * 2. I1250 공식 제품명을 브릿지로 활용한 2차 매칭
 * 3. 제조사 없이 제품명만으로 3차 매칭 (높은 임계값 0.85)
 *
 * 배치: 500건 단위
 * 사용법: node scripts/merge/09-enhanced-nutrition-match.js
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

// ── 노이즈 제거 정규화 (Gemini 제안 1번) ──
function deepNormalize(name) {
  if (!name) return '';
  let s = name;

  // 1. 괄호 안 내용 제거 (용량, 부가 설명)
  s = s.replace(/\([^)]*\)/g, '');
  s = s.replace(/（[^）]*）/g, '');
  s = s.replace(/\[[^\]]*\]/g, '');
  s = s.replace(/【[^】]*】/g, '');

  // 2. 용량/단위 제거: 숫자+단위 패턴
  s = s.replace(/\d+[\.,]?\d*\s*(ml|mL|ML|l|L|g|G|kg|KG|oz|OZ|리터|밀리리터|그램|킬로그램)/gi, '');
  // 순수 숫자+단위 (끝부분)
  s = s.replace(/\s+\d+[\.,]?\d*\s*$/g, '');

  // 3. 포장 형태 키워드 제거
  const packagingWords = [
    '페트', '캔', '파우치', '컵', '병', '봉', '봉지', '팩',
    '번들', '기획', '증정', '리필', '대용량', '미니', '소용량',
    '멀티팩', '세트', '묶음', '박스', '입', '개입',
    'PET', 'CAN',
  ];
  const packagingRegex = new RegExp(`\\b(${packagingWords.join('|')})\\b`, 'gi');
  s = s.replace(packagingRegex, '');

  // 4. 특수문자, 공백 제거 + 소문자
  s = s.replace(/[\s()（）\[\]【】,，·•\-_×x*+&\/]+/g, '');
  s = s.toLowerCase();

  return s;
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

function progress(current, total, label) {
  const pct = ((current / total) * 100).toFixed(1);
  process.stdout.write(`\r  ${label}: ${pct}% (${current.toLocaleString()}/${total.toLocaleString()})`);
}

async function main() {
  const client = await pool.connect();

  try {
    console.log('========================================');
    console.log('  Step 9: 영양DB 매칭률 개선');
    console.log('  (정규화 고도화 + I1250 브릿지)');
    console.log('========================================');

    const startTime = Date.now();

    // ── 0. 고도화 정규화 함수 등록 (PostgreSQL) ──
    await client.query(`
      CREATE OR REPLACE FUNCTION deep_normalize(name TEXT)
      RETURNS TEXT AS $$
      BEGIN
        RETURN lower(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(
                    COALESCE(name, ''),
                    '\\([^)]*\\)', '', 'g'
                  ),
                  '\\d+[\\.,]?\\d*\\s*(ml|mL|ML|l|L|g|G|kg|KG|oz|OZ|리터|밀리리터|그램|킬로그램)', '', 'gi'
                ),
                '(페트|캔|파우치|컵|병|봉|봉지|팩|번들|기획|증정|리필|대용량|미니|멀티팩|세트|묶음|박스)', '', 'gi'
              ),
              '\\d+\\s*$', '', 'g'
            ),
            '[\\s()（）\\[\\]【】,，·•\\-_×x*+&/]+', '', 'g'
          )
        );
      END;
      $$ LANGUAGE plpgsql IMMUTABLE;
    `);
    console.log('  ✅ deep_normalize() 함수 등록');

    // ── 1. 이미 영양정보가 있는 product_id ──
    const { rows: existingNut } = await client.query('SELECT product_id FROM nutrition_data');
    const hasNutrition = new Set(existingNut.map(r => r.product_id));
    console.log(`  기존 영양정보 보유 제품: ${hasNutrition.size.toLocaleString()}건`);

    // ── 2. 아직 영양정보가 없는 제품 조회 ──
    const { rows: targetProducts } = await client.query(`
      SELECT p.product_id, p.product_name, p.manufacturer, p.normalized_name,
             p.normalized_maker, p.c005_report_no
      FROM products p
      WHERE NOT EXISTS (SELECT 1 FROM nutrition_data n WHERE n.product_id = p.product_id)
      ORDER BY p.product_id
    `);
    console.log(`  매칭 대상 제품: ${targetProducts.length.toLocaleString()}건`);

    // ── 3. I1250 제품명 매핑 로드 (브릿지용) ──
    const { rows: i1250Rows } = await client.query(`
      SELECT prdlst_report_no, prdlst_nm
      FROM staging_product_report
    `);
    const i1250NameMap = new Map();
    for (const r of i1250Rows) {
      if (r.prdlst_report_no && r.prdlst_nm) {
        i1250NameMap.set(r.prdlst_report_no, r.prdlst_nm);
      }
    }
    console.log(`  I1250 브릿지 매핑: ${i1250NameMap.size.toLocaleString()}건 로드`);

    let matchedDeepNorm = 0;
    let matchedI1250 = 0;
    let matchedLoose = 0;
    let rejected = 0;
    let errors = 0;
    const total = targetProducts.length;

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = targetProducts.slice(i, i + BATCH_SIZE);
      const batchClient = await pool.connect();

      try {
        await batchClient.query('BEGIN');

        for (const prod of batch) {
          if (hasNutrition.has(prod.product_id)) continue;

          let matched = false;

          // ── Pass 1: 고도화 정규화 + 제조사 필터 ──
          const deepName = deepNormalize(prod.product_name);
          if (deepName && deepName.length >= 2) {
            const threshold = deepName.length <= 5 ? 0.8 : 0.7;

            let query, params;
            if (prod.normalized_maker && prod.normalized_maker.length > 1) {
              query = `
                SELECT sn.id, sn.food_nm_kr, sn.maker_nm,
                       sn.calories, sn.protein, sn.total_fat, sn.total_carbs, sn.total_sugars,
                       sn.sodium, sn.cholesterol, sn.saturated_fat, sn.trans_fat,
                       sn.dietary_fiber, sn.serving_size,
                       similarity(deep_normalize(sn.food_nm_kr), $1) AS sim_score
                FROM staging_nutrition sn
                WHERE strip_corp_indicator(sn.maker_nm) = $2
                  AND similarity(deep_normalize(sn.food_nm_kr), $1) >= $3
                  AND (sn.db_class_nm IS NULL OR sn.db_class_nm NOT IN (
                    '농산물','수산물','축산물','임산물','쌀','보리','밀','옥수수',
                    '돼지고기','소고기','닭고기','채소류','과일류','버섯류','해조류',
                    '수·특용작물류','기타 농산물'
                  ))
                ORDER BY sim_score DESC
                LIMIT 3
              `;
              params = [deepName, prod.normalized_maker, threshold];
            } else {
              query = `
                SELECT sn.id, sn.food_nm_kr, sn.maker_nm,
                       sn.calories, sn.protein, sn.total_fat, sn.total_carbs, sn.total_sugars,
                       sn.sodium, sn.cholesterol, sn.saturated_fat, sn.trans_fat,
                       sn.dietary_fiber, sn.serving_size,
                       similarity(deep_normalize(sn.food_nm_kr), $1) AS sim_score
                FROM staging_nutrition sn
                WHERE similarity(deep_normalize(sn.food_nm_kr), $1) >= $2
                  AND (sn.db_class_nm IS NULL OR sn.db_class_nm NOT IN (
                    '농산물','수산물','축산물','임산물','쌀','보리','밀','옥수수',
                    '돼지고기','소고기','닭고기','채소류','과일류','버섯류','해조류',
                    '수·특용작물류','기타 농산물'
                  ))
                ORDER BY sim_score DESC
                LIMIT 3
              `;
              params = [deepName, threshold];
            }

            const { rows: candidates } = await batchClient.query(query, params);

            for (const cand of candidates) {
              const nutUnit = extractVolumeUnit(cand.food_nm_kr);
              const prodUnit = extractVolumeUnit(prod.product_name);
              if (nutUnit && prodUnit && nutUnit !== prodUnit) {
                rejected++;
                continue;
              }

              await insertNutrition(batchClient, prod.product_id, cand, 'enhanced_deep_norm', cand.sim_score);
              hasNutrition.add(prod.product_id);
              matchedDeepNorm++;
              matched = true;
              break;
            }
          }

          if (matched) continue;

          // ── Pass 2: I1250 공식 제품명으로 2차 매칭 ──
          if (prod.c005_report_no && i1250NameMap.has(prod.c005_report_no)) {
            const i1250Name = i1250NameMap.get(prod.c005_report_no);
            const deepI1250 = deepNormalize(i1250Name);

            if (deepI1250 && deepI1250.length >= 2 && deepI1250 !== deepName) {
              const threshold = deepI1250.length <= 5 ? 0.8 : 0.7;

              const { rows: candidates } = await batchClient.query(`
                SELECT sn.id, sn.food_nm_kr, sn.maker_nm,
                       sn.calories, sn.protein, sn.total_fat, sn.total_carbs, sn.total_sugars,
                       sn.sodium, sn.cholesterol, sn.saturated_fat, sn.trans_fat,
                       sn.dietary_fiber, sn.serving_size,
                       similarity(deep_normalize(sn.food_nm_kr), $1) AS sim_score
                FROM staging_nutrition sn
                WHERE similarity(deep_normalize(sn.food_nm_kr), $1) >= $2
                  AND (sn.db_class_nm IS NULL OR sn.db_class_nm NOT IN (
                    '농산물','수산물','축산물','임산물','쌀','보리','밀','옥수수',
                    '돼지고기','소고기','닭고기','채소류','과일류','버섯류','해조류',
                    '수·특용작물류','기타 농산물'
                  ))
                ORDER BY sim_score DESC
                LIMIT 3
              `, [deepI1250, threshold]);

              for (const cand of candidates) {
                const nutUnit = extractVolumeUnit(cand.food_nm_kr);
                const prodUnit = extractVolumeUnit(prod.product_name);
                if (nutUnit && prodUnit && nutUnit !== prodUnit) {
                  rejected++;
                  continue;
                }

                await insertNutrition(batchClient, prod.product_id, cand, 'enhanced_i1250_bridge', cand.sim_score);
                hasNutrition.add(prod.product_id);
                matchedI1250++;
                matched = true;
                break;
              }
            }
          }

          if (matched) continue;

          // ── Pass 3: 제조사 무시 + 높은 임계값 (0.85) ──
          if (deepName && deepName.length >= 3) {
            const { rows: candidates } = await batchClient.query(`
              SELECT sn.id, sn.food_nm_kr, sn.maker_nm,
                     sn.calories, sn.protein, sn.total_fat, sn.total_carbs, sn.total_sugars,
                     sn.sodium, sn.cholesterol, sn.saturated_fat, sn.trans_fat,
                     sn.dietary_fiber, sn.serving_size,
                     similarity(deep_normalize(sn.food_nm_kr), $1) AS sim_score
              FROM staging_nutrition sn
              WHERE similarity(deep_normalize(sn.food_nm_kr), $1) >= 0.85
                AND (sn.db_class_nm IS NULL OR sn.db_class_nm NOT IN (
                  '농산물','수산물','축산물','임산물','쌀','보리','밀','옥수수',
                  '돼지고기','소고기','닭고기','채소류','과일류','버섯류','해조류',
                  '수·특용작물류','기타 농산물'
                ))
              ORDER BY sim_score DESC
              LIMIT 1
            `, [deepName]);

            if (candidates.length > 0) {
              const cand = candidates[0];
              const nutUnit = extractVolumeUnit(cand.food_nm_kr);
              const prodUnit = extractVolumeUnit(prod.product_name);
              if (nutUnit && prodUnit && nutUnit !== prodUnit) {
                rejected++;
              } else {
                await insertNutrition(batchClient, prod.product_id, cand, 'enhanced_loose_match', cand.sim_score);
                hasNutrition.add(prod.product_id);
                matchedLoose++;
              }
            }
          }
        }

        await batchClient.query('COMMIT');
      } catch (err) {
        await batchClient.query('ROLLBACK');
        errors += batch.length;
        console.error(`\n  ❌ 배치 오류 (${i}~${i + batch.length}): ${err.message}`);
      } finally {
        batchClient.release();
      }

      progress(Math.min(i + BATCH_SIZE, total), total, '향상 매칭');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalNew = matchedDeepNorm + matchedI1250 + matchedLoose;

    const { rows: [{ count: nutCount }] } = await client.query('SELECT count(*) FROM nutrition_data');

    console.log('\n\n========================================');
    console.log('  Step 9 완료 요약');
    console.log('========================================');
    console.log(`  [신규 매칭]`);
    console.log(`    Pass 1 (정규화 고도화):  ${matchedDeepNorm.toLocaleString()}건`);
    console.log(`    Pass 2 (I1250 브릿지):   ${matchedI1250.toLocaleString()}건`);
    console.log(`    Pass 3 (느슨 매칭 0.85): ${matchedLoose.toLocaleString()}건`);
    console.log(`    소계:                    ${totalNew.toLocaleString()}건`);
    console.log(`  [거절]: ${rejected}건 / [오류]: ${errors}건`);
    console.log(`  [소요 시간]: ${elapsed}초`);
    console.log(`\n  nutrition_data 총: ${parseInt(nutCount).toLocaleString()}건`);
    console.log(`    기존: ${existingNut.length.toLocaleString()}건`);
    console.log(`    신규: ${totalNew.toLocaleString()}건`);
    console.log(`    매칭률: ${(parseInt(nutCount) / targetProducts.length * 100 + (existingNut.length / targetProducts.length * 100)).toFixed(1)}% → ${(parseInt(nutCount) / (targetProducts.length + existingNut.length) * 100).toFixed(1)}%`);
    console.log('\n========================================');

  } finally {
    client.release();
    await pool.end();
  }
}

async function insertNutrition(client, productId, nut, source, simScore) {
  try {
    await client.query(`
      INSERT INTO nutrition_data
        (product_id, calories, total_fat, saturated_fat, trans_fat,
         cholesterol, sodium, total_carbs, total_sugars,
         dietary_fiber, protein, data_source, serving_size)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'public_nutrition',$12)
      ON CONFLICT (product_id) DO NOTHING
    `, [
      productId,
      nut.calories, nut.total_fat, nut.saturated_fat, nut.trans_fat,
      nut.cholesterol, nut.sodium, nut.total_carbs, nut.total_sugars,
      nut.dietary_fiber, nut.protein, nut.serving_size,
    ]);
  } catch (insertErr) {
    if (insertErr.code === '42703') {
      // serving_size 컬럼 없으면 없이 삽입
      await client.query(`
        INSERT INTO nutrition_data
          (product_id, calories, total_fat, saturated_fat, trans_fat,
           cholesterol, sodium, total_carbs, total_sugars,
           dietary_fiber, protein, data_source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'public_nutrition')
        ON CONFLICT (product_id) DO NOTHING
      `, [
        productId,
        nut.calories, nut.total_fat, nut.saturated_fat, nut.trans_fat,
        nut.cholesterol, nut.sodium, nut.total_carbs, nut.total_sugars,
        nut.dietary_fiber, nut.protein,
      ]);
    } else {
      throw insertErr;
    }
  }

  await client.query(`
    INSERT INTO merge_log (step, status, source_id, source_table, target_product_id, similarity_score, detail)
    VALUES ('step9_enhanced', 'matched', $1, 'staging_nutrition', $2, $3, $4)
  `, [
    nut.id, productId, simScore,
    JSON.stringify({ source, nutrition_name: nut.food_nm_kr }),
  ]);
}

main().catch(err => { console.error(err); process.exit(1); });
