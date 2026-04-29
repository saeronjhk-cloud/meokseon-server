/**
 * 식품안전나라 품목제조보고(원재료) 다운로드 → staging_ingredients
 * 서비스명: 식품(첨가물)품목제조보고(원재료)
 *
 * 사용법: node scripts/staging/download-ingredients.js [--start 1] [--max-pages 0]
 */

require('dotenv').config();
const http = require('http');
const { Pool } = require('pg');

const API_KEY = '7b06c3b0101f4e86b2e5';
const SERVICE = 'C002'; // 품목제조보고(원재료) 서비스 코드
const PAGE_SIZE = 1000; // 1000건씩 (속도 10배 향상)

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

function fetchAPI(startIdx, endIdx) {
  return new Promise((resolve, reject) => {
    const url = `http://openapi.foodsafetykorea.go.kr/api/${API_KEY}/${SERVICE}/json/${startIdx}/${endIdx}`;
    http.get(url, { timeout: 60000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('JSON 파싱 실패')); }
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('타임아웃')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const client = await pool.connect();

  try {
    const before = await client.query('SELECT count(*) FROM staging_ingredients');
    console.log('========================================');
    console.log('  품목제조보고(원재료) 다운로드 → staging_ingredients');
    console.log('========================================');
    console.log(`  기존 데이터: ${before.rows[0].count}건`);
    console.log(`  시작 페이지: ${START_PAGE}\n`);

    let page = START_PAGE;
    let totalInserted = 0;
    let done = false;
    let errors = 0;

    while (!done) {
      if (MAX_PAGES > 0 && page - START_PAGE >= MAX_PAGES) break;

      const startIdx = (page - 1) * PAGE_SIZE + 1;
      const endIdx = page * PAGE_SIZE;

      try {
        const json = await fetchAPI(startIdx, endIdx);
        const result = json?.[SERVICE] || json?.I0490;

        if (!result || !result.row) {
          // API 키 미승인 또는 서비스 코드 오류 체크
          if (result?.RESULT?.CODE === 'INFO-300') {
            console.log(`\n  데이터 끝 도달`);
            done = true;
            break;
          }
          const msg = result?.RESULT?.MESSAGE || 'unknown';
          console.log(`\n  [${page}] 응답 없음: ${msg}`);
          errors++;
          if (errors > 5) { done = true; break; }
          page++;
          await sleep(500);
          continue;
        }

        const rows = result.row;
        errors = 0;

        for (const row of rows) {
          await client.query(
            `INSERT INTO staging_ingredients (prdlst_report_no, prdlst_nm, rawmtrl_nm, bssh_nm, prms_dt, raw_data)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              row.PRDLST_REPORT_NO?.trim() || null,
              row.PRDLST_NM?.trim() || null,
              row.RAWMTRL_NM?.trim() || null,
              row.BSSH_NM?.trim() || null,
              row.PRMS_DT?.trim() || null,
              JSON.stringify(row),
            ]
          );
          totalInserted++;
        }

        process.stdout.write(`\r  페이지 ${page} | 이번: ${rows.length}건 | 누적: ${totalInserted}건`);
        page++;
        await sleep(200);

      } catch (err) {
        console.log(`\n  [${page}] 오류: ${err.message}`);
        errors++;
        if (errors > 10) { done = true; break; }
        await sleep(2000);
        page++;
      }
    }

    const after = await client.query('SELECT count(*) FROM staging_ingredients');
    console.log(`\n\n========================================`);
    console.log(`  품목제조보고 다운로드 완료!`);
    console.log(`  총 적재: ${after.rows[0].count}건 (+${totalInserted}건)`);
    console.log('========================================');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
