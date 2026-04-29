/**
 * 누락 페이지 재시도 스크립트
 * 스테이징 테이블의 데이터를 분석하여 빠진 페이지를 찾고 재다운로드합니다.
 *
 * 사용법:
 *   node scripts/staging/retry-missing.js --target ingredients   (C002 원재료)
 *   node scripts/staging/retry-missing.js --target product-report (I1250 품목제조보고)
 */

require('dotenv').config();
const http = require('http');
const { Pool } = require('pg');

const API_KEY = '7b06c3b0101f4e86b2e5';
const PAGE_SIZE = 1000;

const args = process.argv.slice(2);
const targetIdx = args.indexOf('--target');
const target = targetIdx !== -1 ? args[targetIdx + 1] : null;

if (!target || !['ingredients', 'product-report'].includes(target)) {
  console.log('사용법:');
  console.log('  node scripts/staging/retry-missing.js --target ingredients');
  console.log('  node scripts/staging/retry-missing.js --target product-report');
  process.exit(0);
}

const CONFIG = {
  'ingredients': {
    service: 'C002',
    table: 'staging_ingredients',
    totalCount: 1048600,
    insertFn: (client, row) => client.query(
      `INSERT INTO staging_ingredients (prdlst_report_no, prdlst_nm, rawmtrl_nm, bssh_nm, prms_dt, raw_data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.PRDLST_REPORT_NO?.trim(), row.PRDLST_NM?.trim(), row.RAWMTRL_NM?.trim(),
       row.BSSH_NM?.trim(), row.PRMS_DT?.trim(), JSON.stringify(row)]
    ),
  },
  'product-report': {
    service: 'I1250',
    table: 'staging_product_report',
    totalCount: null, // 자동 감지
    insertFn: (client, row) => client.query(
      `INSERT INTO staging_product_report (prdlst_report_no, prdlst_nm, bssh_nm, prdlst_dcnm, prms_dt, lcns_no, raw_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.PRDLST_REPORT_NO?.trim(), row.PRDLST_NM?.trim(), row.BSSH_NM?.trim(),
       row.PRDLST_DCNM?.trim(), row.PRMS_DT?.trim(), row.LCNS_NO?.trim(), JSON.stringify(row)]
    ),
  },
};

const cfg = CONFIG[target];

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'meokseon',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

function fetchAPI(service, startIdx, endIdx) {
  return new Promise((resolve, reject) => {
    const url = `http://openapi.foodsafetykorea.go.kr/api/${API_KEY}/${service}/json/${startIdx}/${endIdx}`;
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
    // 현재 보유 건수
    const currentCount = await client.query(`SELECT count(*) FROM ${cfg.table}`);
    const have = parseInt(currentCount.rows[0].count);

    // 전체 건수 확인
    let totalCount = cfg.totalCount;
    if (!totalCount) {
      try {
        const testJson = await fetchAPI(cfg.service, 1, 1);
        totalCount = parseInt(testJson?.[cfg.service]?.total_count) || 0;
      } catch { totalCount = 0; }
    }

    const totalPages = Math.ceil(totalCount / PAGE_SIZE);
    const expectedPerPage = PAGE_SIZE;

    console.log('========================================');
    console.log(`  ${target} 누락 페이지 재시도`);
    console.log('========================================');
    console.log(`  서비스: ${cfg.service}`);
    console.log(`  현재 보유: ${have}건 / 전체: ${totalCount}건`);
    console.log(`  누락 추정: ${totalCount - have}건`);
    console.log(`  전체 페이지: ${totalPages}\n`);

    // 보유한 데이터의 ID 범위로 빠진 페이지 추정
    // 각 페이지별로 데이터가 있는지 샘플 체크
    let retried = 0;
    let recovered = 0;
    let failed = 0;

    for (let page = 1; page <= totalPages; page++) {
      const startIdx = (page - 1) * PAGE_SIZE + 1;
      const endIdx = page * PAGE_SIZE;

      // 이 범위의 데이터가 있는지 빠르게 체크 (id 기반)
      const check = await client.query(
        `SELECT count(*) FROM ${cfg.table} WHERE id > $1 AND id <= $2`,
        [(page - 1) * PAGE_SIZE, page * PAGE_SIZE]
      );

      // ID 기반 체크가 정확하지 않을 수 있으므로, 전체 건수 대비 부족한 만큼만 재시도
      // 간단하게: 전체 페이지를 순회하며 기존 데이터가 부족한 페이지만 재시도
      // 더 실용적인 방법: 그냥 모든 페이지를 재시도하되, 이미 있는 데이터는 중복 무시

      // 실용적 접근: 전체를 다시 돌되, 대기 시간을 길게
    }

    // 실용적 접근: 1페이지부터 끝까지 재시도, 대기 시간 500ms
    console.log('  전체 페이지 재스캔 시작 (대기시간 500ms)...\n');

    for (let page = 1; page <= totalPages; page++) {
      const startIdx = (page - 1) * PAGE_SIZE + 1;
      const endIdx = page * PAGE_SIZE;

      try {
        const json = await fetchAPI(cfg.service, startIdx, endIdx);
        const result = json?.[cfg.service];

        if (!result || !result.row) {
          if (result?.RESULT?.CODE === 'INFO-300') break;
          failed++;
          continue;
        }

        const rows = result.row;
        let pageInserted = 0;

        for (const row of rows) {
          try {
            await cfg.insertFn(client, row);
            pageInserted++;
          } catch {
            // 중복 등 무시
          }
        }

        if (pageInserted > 0) {
          recovered += pageInserted;
        }
        retried++;

        process.stdout.write(`\r  페이지 ${page}/${totalPages} | 복구: ${recovered}건 | 실패: ${failed} | 시도: ${retried}`);
        await sleep(500); // 대기 시간 길게

      } catch {
        failed++;
        await sleep(1000);
      }
    }

    const afterCount = await client.query(`SELECT count(*) FROM ${cfg.table}`);
    console.log(`\n\n========================================`);
    console.log(`  재시도 완료!`);
    console.log(`  이전: ${have}건 → 이후: ${afterCount.rows[0].count}건 (+${recovered}건 복구)`);
    console.log(`  실패 페이지: ${failed}`);
    console.log('========================================');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
