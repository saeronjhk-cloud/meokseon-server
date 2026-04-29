/**
 * 공공데이터포털 식품영양성분DB 전량 다운로드 → staging_nutrition
 * 원본 데이터를 가공 없이 그대로 저장합니다.
 *
 * 사용법: node scripts/staging/download-nutrition.js [--start 1] [--max-pages 0]
 *
 * 주의: 개발계정 일일 트래픽 10,000건 제한
 */

require('dotenv').config();
const https = require('https');
const { Pool } = require('pg');

const SERVICE_KEY = '3ab67d3d7766c40a4f2a9e40cbdcc87befaa901d33126c63748ae2e3b6724c2b';
const BASE_URL = 'https://apis.data.go.kr/1471000/FoodNtrCpntDbInfo02/getFoodNtrCpntDbInq02';
const PAGE_SIZE = 100;

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? parseInt(args[idx + 1]) : def;
};

const START_PAGE = getArg('start', 1);
const MAX_PAGES = getArg('max-pages', 0);

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'meokseon',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

function fetchAPI(pageNo) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}?serviceKey=${SERVICE_KEY}&pageNo=${pageNo}&numOfRows=${PAGE_SIZE}&type=json`;
    https.get(url, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`JSON 파싱 실패 (page ${pageNo})`)); }
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('타임아웃')); });
  });
}

function parseNum(val) {
  if (!val || val === '' || val === 'N/A' || val === '-') return null;
  const num = parseFloat(val);
  return isNaN(num) ? null : num;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const client = await pool.connect();

  try {
    const before = await client.query('SELECT count(*) FROM staging_nutrition');
    console.log('========================================');
    console.log('  영양성분DB 전량 다운로드 → staging_nutrition');
    console.log('========================================');
    console.log(`  기존 데이터: ${before.rows[0].count}건`);
    console.log(`  시작 페이지: ${START_PAGE} (페이지당 ${PAGE_SIZE}건)`);
    console.log(`  ⚠️ 일일 트래픽 제한: 10,000건\n`);

    let page = START_PAGE;
    let totalInserted = 0;
    let done = false;
    let errors = 0;

    while (!done) {
      if (MAX_PAGES > 0 && page - START_PAGE >= MAX_PAGES) break;

      try {
        const json = await fetchAPI(page);
        const body = json?.body;

        if (!body || !body.items || body.items.length === 0) {
          if (body?.totalCount && totalInserted >= parseInt(body.totalCount)) {
            done = true;
            console.log(`\n  데이터 끝 도달 (총 ${body.totalCount}건)`);
          } else {
            console.log(`\n  [${page}] 빈 응답`);
            errors++;
            if (errors > 5) { done = true; break; }
          }
          page++;
          await sleep(500);
          continue;
        }

        const items = body.items;
        errors = 0; // 성공하면 에러 카운트 리셋

        for (const item of items) {
          await client.query(
            `INSERT INTO staging_nutrition
             (food_cd, food_nm_kr, db_class_nm, food_or_nm, maker_nm, serving_size,
              calories, protein, total_fat, total_carbs, total_sugars,
              sodium, cholesterol, saturated_fat, trans_fat, dietary_fiber, raw_data)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [
              item.FOOD_CD || null,
              item.FOOD_NM_KR?.trim() || null,
              item.DB_CLASS_NM?.trim() || null,
              item.FOOD_OR_NM?.trim() || null,
              item.MAKER_NM?.trim() || null,
              item.SERVING_SIZE || null,
              parseNum(item.AMT_NUM1),   // 에너지
              parseNum(item.AMT_NUM3),   // 단백질
              parseNum(item.AMT_NUM4),   // 지방
              parseNum(item.AMT_NUM7),   // 탄수화물
              parseNum(item.AMT_NUM8),   // 총당류
              parseNum(item.AMT_NUM13),  // 나트륨
              parseNum(item.AMT_NUM14),  // 콜레스테롤
              parseNum(item.AMT_NUM25),  // 포화지방산
              parseNum(item.AMT_NUM26),  // 트랜스지방산
              parseNum(item.AMT_NUM9),   // 식이섬유
              JSON.stringify(item),
            ]
          );
          totalInserted++;
        }

        // 총 건수 표시 (첫 응답에서)
        const totalCount = body.totalCount || '?';
        process.stdout.write(`\r  페이지 ${page} | 이번: ${items.length}건 | 누적: ${totalInserted}건 / 전체: ${totalCount}건`);

        page++;
        await sleep(300); // Rate limit 방지

      } catch (err) {
        console.log(`\n  [${page}] 오류: ${err.message}`);
        errors++;
        if (errors > 10) { console.log('\n  연속 에러 10회 — 중단'); done = true; break; }
        await sleep(2000);
        page++;
      }
    }

    const after = await client.query('SELECT count(*) FROM staging_nutrition');
    console.log(`\n\n========================================`);
    console.log(`  영양성분DB 다운로드 완료!`);
    console.log(`  총 적재: ${after.rows[0].count}건 (+${totalInserted}건)`);
    console.log('========================================');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
