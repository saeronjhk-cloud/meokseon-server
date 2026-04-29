/**
 * 먹선 대량 데이터 적재 스크립트
 * 식품안전나라 C005(바코드연계제품) + I2790(영양성분DB) API에서
 * 대량 제품 데이터를 다운로드하여 PostgreSQL에 적재합니다.
 *
 * 사용법: node scripts/bulk-load.js [--pages 100] [--start 1]
 */

require('dotenv').config();
const https = require('https');
const http = require('http');
const { Pool } = require('pg');
const { detectFoodCategory } = require('../src/services/nutritionTrafficLight');

// ============================================================
// 설정
// ============================================================

const API_KEY = '7b06c3b0101f4e86b2e5';
const BASE_URL = 'http://openapi.foodsafetykorea.go.kr/api';
const PAGE_SIZE = 100; // API 한 번에 최대 100건

// CLI 인자 파싱
const args = process.argv.slice(2);
const getArg = (name, defaultVal) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? parseInt(args[idx + 1]) : defaultVal;
};

const TOTAL_PAGES = getArg('pages', 200);  // 기본 200페이지 = 20,000건
const START_PAGE = getArg('start', 1);

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'meokseon',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

// ============================================================
// API 호출 헬퍼
// ============================================================

function fetchAPI(service, startIdx, endIdx) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}/${API_KEY}/${service}/json/${startIdx}/${endIdx}`;

    http.get(url, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch {
          reject(new Error('JSON 파싱 실패'));
        }
      });
    }).on('error', reject)
      .on('timeout', function() { this.destroy(); reject(new Error('타임아웃')); });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// C005 데이터 로드 (바코드 + 제품명 + 제조사 + 식품유형)
// ============================================================

async function loadC005(client, startPage, totalPages) {
  console.log(`\n[C005] 바코드연계제품정보 로드 시작`);
  console.log(`  페이지: ${startPage} ~ ${startPage + totalPages - 1} (${totalPages * PAGE_SIZE}건 목표)\n`);

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (let page = startPage; page < startPage + totalPages; page++) {
    const startIdx = (page - 1) * PAGE_SIZE + 1;
    const endIdx = page * PAGE_SIZE;

    try {
      const json = await fetchAPI('C005', startIdx, endIdx);
      const result = json?.C005;

      if (!result || !result.row) {
        // 데이터 끝
        if (result?.RESULT?.CODE === 'INFO-300') {
          console.log(`  [${page}] 데이터 끝 도달`);
          break;
        }
        console.log(`  [${page}] 빈 응답, 건너뜀`);
        errors++;
        continue;
      }

      const rows = result.row;

      for (const row of rows) {
        const barcode = row.BAR_CD?.trim();
        const productName = row.PRDLST_NM?.trim();

        if (!productName) continue;

        const manufacturer = row.BSSH_NM?.trim() || null;
        const foodType = row.PRDLST_DCNM?.trim() || null;
        const reportNo = row.PRDLST_REPORT_NO?.trim() || null;

        // 카테고리 자동 판별
        const category = detectFoodCategory({
          product_name: productName,
          food_type: foodType,
          content_unit: 'g',
        });

        try {
          await client.query(
            `INSERT INTO products (barcode, product_name, manufacturer, food_type, food_category, data_source, c005_report_no)
             VALUES ($1, $2, $3, $4, $5, 'public_c005', $6)
             ON CONFLICT (barcode) WHERE barcode IS NOT NULL DO UPDATE SET
               product_name = EXCLUDED.product_name,
               manufacturer = EXCLUDED.manufacturer,
               food_type = EXCLUDED.food_type,
               food_category = EXCLUDED.food_category,
               c005_report_no = EXCLUDED.c005_report_no,
               updated_at = NOW()`,
            [barcode || null, productName, manufacturer, foodType, category, reportNo]
          );
          inserted++;
        } catch (err) {
          // 바코드 없는 제품은 중복 무시
          if (err.code === '23505') {
            skipped++;
          } else {
            errors++;
          }
        }
      }

      // 진행률 표시
      const progress = ((page - startPage + 1) / totalPages * 100).toFixed(1);
      process.stdout.write(`\r  [C005] ${progress}% | 페이지 ${page} | 적재: ${inserted} | 건너뜀: ${skipped} | 에러: ${errors}`);

      // API Rate Limit 방지
      await sleep(200);

    } catch (err) {
      console.log(`\n  [${page}] API 오류: ${err.message}`);
      errors++;
      await sleep(1000);
    }
  }

  console.log(`\n  [C005] 완료! 적재: ${inserted} | 건너뜀: ${skipped} | 에러: ${errors}\n`);
  return inserted;
}

// ============================================================
// I2790 데이터 로드 (영양성분)
// ============================================================

async function loadI2790(client, totalPages) {
  console.log(`[I2790] 영양성분DB 로드 시작`);
  console.log(`  페이지: 1 ~ ${totalPages} (${totalPages * PAGE_SIZE}건 목표)\n`);

  let matched = 0;
  let unmatched = 0;
  let errors = 0;

  for (let page = 1; page <= totalPages; page++) {
    const startIdx = (page - 1) * PAGE_SIZE + 1;
    const endIdx = page * PAGE_SIZE;

    try {
      const json = await fetchAPI('I2790', startIdx, endIdx);
      const result = json?.I2790;

      if (!result || !result.row) {
        if (result?.RESULT?.CODE === 'INFO-300') {
          console.log(`  [${page}] 데이터 끝 도달`);
          break;
        }
        continue;
      }

      for (const row of result.row) {
        const foodName = row.FOOD_NM_KR?.trim();
        if (!foodName) continue;

        const foodCd = row.FOOD_CD?.trim() || null;
        const calories = parseFloat(row.AMT_NUM1) || null;      // 열량
        const protein = parseFloat(row.AMT_NUM3) || null;       // 단백질
        const totalFat = parseFloat(row.AMT_NUM4) || null;      // 지방
        const totalCarbs = parseFloat(row.AMT_NUM7) || null;    // 탄수화물
        const totalSugars = parseFloat(row.AMT_NUM8) || null;   // 당류
        const sodium = parseFloat(row.AMT_NUM13) || null;       // 나트륨
        const cholesterol = parseFloat(row.AMT_NUM24) || null;  // 콜레스테롤
        const saturatedFat = parseFloat(row.AMT_NUM25) || null; // 포화지방
        const transFat = parseFloat(row.AMT_NUM26) || null;     // 트랜스지방
        const dietaryFiber = parseFloat(row.AMT_NUM9) || null;  // 식이섬유

        // 제품명으로 매칭 시도
        const productResult = await client.query(
          `SELECT product_id FROM products
           WHERE product_name ILIKE $1
           AND NOT EXISTS (SELECT 1 FROM nutrition_data WHERE product_id = products.product_id)
           LIMIT 1`,
          [`%${foodName}%`]
        );

        if (productResult.rows.length > 0) {
          const productId = productResult.rows[0].product_id;
          try {
            await client.query(
              `INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat,
                cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'public_nutrition')
               ON CONFLICT (product_id) DO NOTHING`,
              [productId, calories, totalFat, saturatedFat, transFat, cholesterol, sodium, totalCarbs, totalSugars, dietaryFiber, protein]
            );
            matched++;
          } catch {
            errors++;
          }
        } else {
          unmatched++;
        }
      }

      const progress = (page / totalPages * 100).toFixed(1);
      process.stdout.write(`\r  [I2790] ${progress}% | 페이지 ${page} | 매칭: ${matched} | 미매칭: ${unmatched}`);

      await sleep(200);

    } catch (err) {
      console.log(`\n  [${page}] API 오류: ${err.message}`);
      errors++;
      await sleep(1000);
    }
  }

  console.log(`\n  [I2790] 완료! 매칭: ${matched} | 미매칭: ${unmatched} | 에러: ${errors}\n`);
  return matched;
}

// ============================================================
// 메인 실행
// ============================================================

async function main() {
  const client = await pool.connect();

  try {
    console.log('========================================');
    console.log('  먹선 대량 데이터 적재');
    console.log('========================================');
    console.log(`  DB: ${process.env.DB_NAME || 'meokseon'}`);
    console.log(`  C005 페이지: ${TOTAL_PAGES} (${TOTAL_PAGES * PAGE_SIZE}건 목표)`);
    console.log(`  시작 페이지: ${START_PAGE}`);

    // 기존 데이터 수 확인
    const before = await client.query('SELECT count(*) FROM products');
    console.log(`  기존 제품 수: ${before.rows[0].count}\n`);

    // C005 로드
    const c005Count = await loadC005(client, START_PAGE, TOTAL_PAGES);

    // I2790 영양성분 매칭 (C005 대비 50페이지)
    const nutritionPages = Math.min(Math.ceil(TOTAL_PAGES / 4), 100);
    const nutritionCount = await loadI2790(client, nutritionPages);

    // 결과 확인
    const after = await client.query('SELECT count(*) FROM products');
    const nutCount = await client.query('SELECT count(*) FROM nutrition_data');
    const catCount = await client.query('SELECT food_category, count(*) FROM products GROUP BY food_category ORDER BY count DESC');

    console.log('========================================');
    console.log('  적재 결과');
    console.log('========================================');
    console.log(`  전체 제품: ${after.rows[0].count} (+${after.rows[0].count - before.rows[0].count})`);
    console.log(`  영양정보: ${nutCount.rows[0].count}`);
    console.log('\n  카테고리 분포:');
    for (const row of catCount.rows) {
      console.log(`    ${row.food_category}: ${row.count}`);
    }
    console.log('\n========================================');
    console.log('  대량 적재 완료!');
    console.log('========================================');

  } catch (err) {
    console.error('\n오류:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
