/**
 * C002 누락 3페이지(24, 394, 913)만 직접 다운로드
 *
 * 사용법: node scripts/staging/download-missing-3pages.js
 */

require('dotenv').config();
const http = require('http');
const { Pool } = require('pg');

const API_KEY = '7b06c3b0101f4e86b2e5';
const SERVICE = 'C002';
const PAGE_SIZE = 1000;
const MISSING_PAGES = [24, 394, 913];

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
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('타임아웃')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const client = await pool.connect();

  try {
    console.log('========================================');
    console.log('  C002 누락 3페이지 직접 다운로드');
    console.log(`  대상: 페이지 ${MISSING_PAGES.join(', ')}`);
    console.log('========================================\n');

    const { rows: [{ count: before }] } = await client.query('SELECT count(*) FROM staging_ingredients');
    console.log(`  현재 DB: ${parseInt(before).toLocaleString()}건\n`);

    let totalInserted = 0;

    for (const page of MISSING_PAGES) {
      const startIdx = (page - 1) * PAGE_SIZE + 1;
      const endIdx = page * PAGE_SIZE;

      console.log(`  ⏳ 페이지 ${page} 다운로드 중... (${startIdx}~${endIdx})`);

      try {
        const json = await fetchAPI(startIdx, endIdx);
        const rows = json?.[SERVICE]?.row;

        if (!rows || rows.length === 0) {
          console.log(`  [페이지 ${page}] 데이터 없음\n`);
          continue;
        }

        let inserted = 0, dups = 0;

        for (const row of rows) {
          const reportNo = row.PRDLST_REPORT_NO?.trim() || null;
          const rawmtrl = row.RAWMTRL_NM?.trim() || null;
          const prdlstNm = row.PRDLST_NM?.trim() || null;
          const bsshNm = row.BSSH_NM?.trim() || null;
          const prmsDt = row.PRMS_DT?.trim() || null;

          const { rows: exists } = await client.query(
            `SELECT 1 FROM staging_ingredients
             WHERE prdlst_report_no = $1 AND rawmtrl_nm = $2
             LIMIT 1`,
            [reportNo, rawmtrl]
          );

          if (exists.length === 0) {
            await client.query(
              `INSERT INTO staging_ingredients (prdlst_report_no, prdlst_nm, rawmtrl_nm, bssh_nm, prms_dt, raw_data)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [reportNo, prdlstNm, rawmtrl, bsshNm, prmsDt, JSON.stringify(row)]
            );
            inserted++;
          } else {
            dups++;
          }
        }

        totalInserted += inserted;
        console.log(`  ✅ 페이지 ${page}: ${rows.length}건 중 ${inserted}건 신규, ${dups}건 기존\n`);
        await sleep(500);

      } catch (err) {
        console.log(`  ❌ 페이지 ${page} 오류: ${err.message}\n`);
      }
    }

    const { rows: [{ count: after }] } = await client.query('SELECT count(*) FROM staging_ingredients');

    console.log('========================================');
    console.log('  완료!');
    console.log(`  신규 삽입: ${totalInserted.toLocaleString()}건`);
    console.log(`  DB: ${parseInt(before).toLocaleString()} → ${parseInt(after).toLocaleString()}건`);
    console.log('========================================');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
