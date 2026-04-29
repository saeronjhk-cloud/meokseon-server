/**
 * C005 바코드연계제품정보 전량 다운로드 → staging_c005
 * 원본 데이터를 가공 없이 그대로 저장합니다.
 *
 * 사용법: node scripts/staging/download-c005.js [--start 1] [--max-pages 0]
 *   --start: 시작 페이지 (기본 1)
 *   --max-pages: 최대 페이지 수 (0 = 끝까지, 기본 0)
 */

require('dotenv').config();
const http = require('http');
const { Pool } = require('pg');

const API_KEY = '7b06c3b0101f4e86b2e5';
const PAGE_SIZE = 1000; // C005는 최대 1000건까지 가능

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? parseInt(args[idx + 1]) : def;
};

const START_PAGE = getArg('start', 1);
const MAX_PAGES = getArg('max-pages', 0); // 0 = 무제한

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'meokseon',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

function fetchAPI(startIdx, endIdx) {
  return new Promise((resolve, reject) => {
    const url = `http://openapi.foodsafetykorea.go.kr/api/${API_KEY}/C005/json/${startIdx}/${endIdx}`;
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
    // 기존 건수
    const before = await client.query('SELECT count(*) FROM staging_c005');
    console.log('========================================');
    console.log('  C005 전량 다운로드 → staging_c005');
    console.log('========================================');
    console.log(`  기존 데이터: ${before.rows[0].count}건`);
    console.log(`  시작 페이지: ${START_PAGE} (페이지당 ${PAGE_SIZE}건)\n`);

    let page = START_PAGE;
    let totalInserted = 0;
    let done = false;

    while (!done) {
      if (MAX_PAGES > 0 && page - START_PAGE >= MAX_PAGES) break;

      const startIdx = (page - 1) * PAGE_SIZE + 1;
      const endIdx = page * PAGE_SIZE;

      try {
        const json = await fetchAPI(startIdx, endIdx);
        const result = json?.C005;

        if (!result || !result.row) {
          if (result?.RESULT?.CODE === 'INFO-300') {
            console.log(`\n  데이터 끝 도달 (페이지 ${page})`);
            done = true;
            break;
          }
          console.log(`  [${page}] 빈 응답, 건너뜀`);
          page++;
          await sleep(500);
          continue;
        }

        const rows = result.row;

        // 배치 INSERT
        for (const row of rows) {
          await client.query(
            `INSERT INTO staging_c005 (bar_cd, prdlst_nm, bssh_nm, prdlst_dcnm, prdlst_report_no, raw_data)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              row.BAR_CD?.trim() || null,
              row.PRDLST_NM?.trim() || null,
              row.BSSH_NM?.trim() || null,
              row.PRDLST_DCNM?.trim() || null,
              row.PRDLST_REPORT_NO?.trim() || null,
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
        await sleep(2000);
        page++; // 에러 시 다음 페이지로
      }
    }

    const after = await client.query('SELECT count(*) FROM staging_c005');
    console.log(`\n\n========================================`);
    console.log(`  C005 다운로드 완료!`);
    console.log(`  총 적재: ${after.rows[0].count}건 (+${totalInserted}건)`);
    console.log('========================================');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
