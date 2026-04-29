/**
 * 공공데이터포털 식품영양성분DB → PostgreSQL 매칭 적재
 * 기존 C005 제품과 제품명 매칭하여 영양정보를 채웁니다.
 *
 * 사용법: node scripts/load-nutrition.js [--pages 500]
 */

require('dotenv').config();
const https = require('https');
const { Pool } = require('pg');

// ============================================================
// 설정
// ============================================================

const SERVICE_KEY = '3ab67d3d7766c40a4f2a9e40cbdcc87befaa901d33126c63748ae2e3b6724c2b';
const BASE_URL = 'https://apis.data.go.kr/1471000/FoodNtrCpntDbInfo02/getFoodNtrCpntDbInq02';
const PAGE_SIZE = 100;

const args = process.argv.slice(2);
const getArg = (name, defaultVal) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? parseInt(args[idx + 1]) : defaultVal;
};

const TOTAL_PAGES = getArg('pages', 500); // 기본 500페이지 = 50,000건

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'meokseon',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

// ============================================================
// API 호출
// ============================================================

function fetchAPI(pageNo) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}?serviceKey=${SERVICE_KEY}&pageNo=${pageNo}&numOfRows=${PAGE_SIZE}&type=json`;

    https.get(url, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`JSON 파싱 실패 (page ${pageNo})`));
        }
      });
    }).on('error', reject)
      .on('timeout', function() { this.destroy(); reject(new Error('타임아웃')); });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseNum(val) {
  if (!val || val === '' || val === 'N/A') return null;
  const num = parseFloat(val);
  return isNaN(num) ? null : num;
}

// ============================================================
// 메인 실행
// ============================================================

async function main() {
  const client = await pool.connect();

  try {
    console.log('========================================');
    console.log('  영양성분DB 매칭 적재');
    console.log('========================================');

    const beforeNut = await client.query('SELECT count(*) FROM nutrition_data');
    const totalProducts = await client.query('SELECT count(*) FROM products');
    console.log(`  전체 제품: ${totalProducts.rows[0].count}`);
    console.log(`  기존 영양정보: ${beforeNut.rows[0].count}`);
    console.log(`  페이지: ${TOTAL_PAGES} (${TOTAL_PAGES * PAGE_SIZE}건 목표)\n`);

    let matched = 0;
    let newProducts = 0;
    let skipped = 0;
    let errors = 0;
    let apiDone = false;

    for (let page = 1; page <= TOTAL_PAGES; page++) {
      if (apiDone) break;

      try {
        const json = await fetchAPI(page);
        const body = json?.body;

        if (!body || !body.items || body.items.length === 0) {
          console.log(`\n  [${page}] 데이터 끝 도달`);
          apiDone = true;
          break;
        }

        const items = body.items;

        for (const item of items) {
          const foodName = item.FOOD_NM_KR?.trim();
          if (!foodName) continue;

          const calories = parseNum(item.AMT_NUM1);     // 에너지(kcal)
          const protein = parseNum(item.AMT_NUM3);      // 단백질
          const totalFat = parseNum(item.AMT_NUM4);     // 지방
          const totalCarbs = parseNum(item.AMT_NUM7);   // 탄수화물
          const totalSugars = parseNum(item.AMT_NUM8);  // 총당류
          const sodium = parseNum(item.AMT_NUM13);      // 나트륨
          const cholesterol = parseNum(item.AMT_NUM14); // 콜레스테롤
          const saturatedFat = parseNum(item.AMT_NUM25);// 포화지방산
          const transFat = parseNum(item.AMT_NUM26);    // 트랜스지방산
          const dietaryFiber = parseNum(item.AMT_NUM9); // 식이섬유
          const servingSize = item.SERVING_SIZE?.replace(/[^0-9.]/g, '') || null;
          const foodCd = item.FOOD_CD || null;

          // 의미 있는 영양 데이터가 있는지 확인
          if (calories === null && sodium === null && protein === null) {
            skipped++;
            continue;
          }

          // 기존 제품과 매칭 시도 (영양정보 없는 제품만)
          const productResult = await client.query(
            `SELECT product_id FROM products
             WHERE product_name ILIKE $1
             AND NOT EXISTS (SELECT 1 FROM nutrition_data WHERE product_id = products.product_id)
             LIMIT 1`,
            [`%${foodName}%`]
          );

          let productId;

          if (productResult.rows.length > 0) {
            // 기존 제품에 매칭
            productId = productResult.rows[0].product_id;
            matched++;
          } else {
            // 매칭 안 되면 새 제품으로 등록
            try {
              const insertResult = await client.query(
                `INSERT INTO products (product_name, food_type, food_category, data_source, public_food_cd, serving_size)
                 VALUES ($1, $2, 'general', 'public_nutrition', $3, $4)
                 RETURNING product_id`,
                [foodName, item.DB_CLASS_NM || null, foodCd, parseNum(servingSize)]
              );
              productId = insertResult.rows[0].product_id;
              newProducts++;
            } catch {
              skipped++;
              continue;
            }
          }

          // 영양정보 삽입
          try {
            await client.query(
              `INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat,
                cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'public_nutrition')
               ON CONFLICT (product_id) DO NOTHING`,
              [productId, calories, totalFat, saturatedFat, transFat, cholesterol, sodium, totalCarbs, totalSugars, dietaryFiber, protein]
            );
          } catch {
            errors++;
          }
        }

        const progress = (page / TOTAL_PAGES * 100).toFixed(1);
        process.stdout.write(`\r  [영양DB] ${progress}% | 페이지 ${page} | 매칭: ${matched} | 신규: ${newProducts} | 건너뜀: ${skipped}`);

        // Rate Limit 방지 (개발계정 10,000건/일)
        await sleep(300);

      } catch (err) {
        console.log(`\n  [${page}] API 오류: ${err.message}`);
        errors++;
        await sleep(1000);
      }
    }

    // 결과
    const afterNut = await client.query('SELECT count(*) FROM nutrition_data');
    const afterProd = await client.query('SELECT count(*) FROM products');

    console.log('\n\n========================================');
    console.log('  적재 결과');
    console.log('========================================');
    console.log(`  전체 제품: ${afterProd.rows[0].count}`);
    console.log(`  영양정보: ${afterNut.rows[0].count} (+${afterNut.rows[0].count - beforeNut.rows[0].count})`);
    console.log(`  매칭: ${matched} | 신규 제품: ${newProducts} | 건너뜀: ${skipped} | 에러: ${errors}`);
    console.log('========================================\n');

  } catch (err) {
    console.error('\n오류:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
