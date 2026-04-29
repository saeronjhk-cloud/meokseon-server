/**
 * C002 누락 페이지 탐지 + 선별 다운로드
 *
 * 전체를 다시 받지 않고, 페이지별로 샘플 1건을 API에서 가져와
 * DB에 존재하는지 확인합니다. 없으면 해당 페이지를 누락으로 판정하고
 * 그 페이지만 다운로드합니다.
 *
 * 사용법:
 *   node scripts/staging/retry-missing-pages.js --probe      # 누락 페이지 탐지만
 *   node scripts/staging/retry-missing-pages.js               # 탐지 + 다운로드
 */

require('dotenv').config();
const http = require('http');
const { Pool } = require('pg');

const API_KEY = '7b06c3b0101f4e86b2e5';
const SERVICE = 'C002';
const PAGE_SIZE = 1000;

const PROBE_ONLY = process.argv.includes('--probe');

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
    console.log('  C002 누락 페이지 탐지 + 선별 다운로드');
    console.log(`  모드: ${PROBE_ONLY ? '🔍 탐지만 (--probe)' : '📥 탐지 + 다운로드'}`);
    console.log('========================================\n');

    // 1. 현재 DB 상태
    const { rows: [{ count }] } = await client.query('SELECT count(*) FROM staging_ingredients');
    console.log(`  현재 DB: ${parseInt(count).toLocaleString()}건\n`);

    // 2. API 총 건수 확인 (1건만 요청해서 total_count 추출)
    console.log('  ⏳ API 총 건수 확인 중...');
    const probe = await fetchAPI(1, 1);
    const totalCount = parseInt(probe?.[SERVICE]?.total_count || '0');
    const totalPages = Math.ceil(totalCount / PAGE_SIZE);
    console.log(`  API 총 건수: ${totalCount.toLocaleString()}건 (${totalPages}페이지)\n`);

    if (totalCount === 0) {
      console.log('  ❌ API 총 건수를 가져올 수 없습니다.');
      return;
    }

    // 3. 페이지별 샘플 프로빙 — 각 페이지의 첫 번째 레코드가 DB에 있는지 확인
    console.log('  ⏳ 페이지별 샘플 프로빙 중...');
    const missingPages = [];
    let probed = 0;

    for (let page = 1; page <= totalPages; page++) {
      const startIdx = (page - 1) * PAGE_SIZE + 1;

      try {
        const json = await fetchAPI(startIdx, startIdx); // 1건만 요청
        const rows = json?.[SERVICE]?.row;

        if (!rows || rows.length === 0) {
          // 데이터 끝이거나 빈 페이지
          probed++;
          process.stdout.write(`\r  프로빙: ${probed}/${totalPages} (누락: ${missingPages.length})`);
          await sleep(150);
          continue;
        }

        const sample = rows[0];
        const reportNo = sample.PRDLST_REPORT_NO?.trim() || null;
        const rawmtrl = sample.RAWMTRL_NM?.trim() || null;
        const prdlstNm = sample.PRDLST_NM?.trim() || null;

        // DB에서 해당 레코드 존재 여부 확인
        const { rows: existing } = await client.query(
          `SELECT 1 FROM staging_ingredients
           WHERE prdlst_report_no = $1 AND rawmtrl_nm = $2
           LIMIT 1`,
          [reportNo, rawmtrl]
        );

        if (existing.length === 0) {
          missingPages.push(page);
        }

      } catch (err) {
        // API 오류 시 해당 페이지를 누락 후보로 표시
        console.log(`\n  [페이지 ${page}] 프로빙 오류: ${err.message}`);
        missingPages.push(page);
      }

      probed++;
      process.stdout.write(`\r  프로빙: ${probed}/${totalPages} (누락: ${missingPages.length})`);
      await sleep(150); // API 부하 방지
    }

    console.log(`\n\n  ✅ 프로빙 완료!`);
    console.log(`  - 총 페이지: ${totalPages}`);
    console.log(`  - 누락 페이지: ${missingPages.length}개`);

    if (missingPages.length > 0) {
      console.log(`  - 누락 페이지 번호: [${missingPages.join(', ')}]`);
      console.log(`  - 예상 누락 건수: ~${(missingPages.length * PAGE_SIZE).toLocaleString()}건`);
    }

    if (missingPages.length === 0) {
      console.log('\n  🎉 누락 페이지 없음 — 추가 다운로드 불필요!');
      return;
    }

    if (PROBE_ONLY) {
      console.log('\n  🔍 PROBE 모드 — 다운로드하려면 --probe 없이 실행하세요.');
      return;
    }

    // 4. 누락 페이지만 다운로드
    console.log(`\n  ⏳ 누락 ${missingPages.length}개 페이지 다운로드 중...`);
    let totalInserted = 0;
    let pagesDone = 0;
    let failedPages = [];

    for (const page of missingPages) {
      const startIdx = (page - 1) * PAGE_SIZE + 1;
      const endIdx = page * PAGE_SIZE;

      try {
        const json = await fetchAPI(startIdx, endIdx);
        const rows = json?.[SERVICE]?.row;

        if (!rows || rows.length === 0) {
          console.log(`\n  [페이지 ${page}] 데이터 없음 (스킵)`);
          pagesDone++;
          continue;
        }

        let pageInserted = 0;
        let pageDups = 0;

        for (const row of rows) {
          const reportNo = row.PRDLST_REPORT_NO?.trim() || null;
          const rawmtrl = row.RAWMTRL_NM?.trim() || null;
          const prdlstNm = row.PRDLST_NM?.trim() || null;
          const bsshNm = row.BSSH_NM?.trim() || null;
          const prmsDt = row.PRMS_DT?.trim() || null;

          // 중복 확인 후 삽입
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
            pageInserted++;
          } else {
            pageDups++;
          }
        }

        totalInserted += pageInserted;
        pagesDone++;
        console.log(`  [페이지 ${page}] ${rows.length}건 중 ${pageInserted}건 신규 삽입, ${pageDups}건 기존 존재`);
        await sleep(300);

      } catch (err) {
        console.log(`  [페이지 ${page}] ❌ 오류: ${err.message}`);
        failedPages.push(page);
        await sleep(2000);
      }
    }

    // 5. 결과
    const { rows: [{ count: afterCount }] } = await client.query('SELECT count(*) FROM staging_ingredients');

    console.log('\n========================================');
    console.log('  선별 다운로드 완료!');
    console.log(`  - 대상: ${missingPages.length}개 페이지`);
    console.log(`  - 성공: ${pagesDone}개 페이지`);
    console.log(`  - 신규 삽입: ${totalInserted.toLocaleString()}건`);
    console.log(`  - DB 총 건수: ${parseInt(afterCount).toLocaleString()}건`);
    if (failedPages.length > 0) {
      console.log(`  - ❌ 실패: ${failedPages.length}개 페이지 [${failedPages.join(', ')}]`);
    }
    console.log('========================================');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
