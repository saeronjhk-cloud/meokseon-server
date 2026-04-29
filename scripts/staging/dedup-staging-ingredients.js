/**
 * staging_ingredients 중복 제거 (최적화 버전)
 *
 * C002 재다운로드로 발생한 중복 행을 제거합니다.
 * 전략: 임시 테이블에 유지할 id 목록을 만들고, 나머지를 배치 삭제
 *
 * 사용법:
 *   node scripts/staging/dedup-staging-ingredients.js --dry-run   # 건수만 확인
 *   node scripts/staging/dedup-staging-ingredients.js              # 실제 삭제
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'meokseon',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  statement_timeout: 0, // 타임아웃 해제 (대량 작업)
});

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const client = await pool.connect();

  try {
    // 세션 레벨 타임아웃 해제
    await client.query('SET statement_timeout = 0');

    console.log('========================================');
    console.log('  staging_ingredients 중복 제거');
    console.log(`  모드: ${DRY_RUN ? '🔍 DRY RUN' : '🗑️  실제 삭제'}`);
    console.log('========================================\n');

    // 1. 현재 상태
    const { rows: [{ count: totalBefore }] } = await client.query(
      'SELECT count(*) FROM staging_ingredients'
    );
    const { rows: [{ count: uniqueReports }] } = await client.query(
      'SELECT count(DISTINCT prdlst_report_no) FROM staging_ingredients'
    );
    console.log(`  현재 총 행:          ${parseInt(totalBefore).toLocaleString()}건`);
    console.log(`  고유 report_no:      ${parseInt(uniqueReports).toLocaleString()}건`);

    // 2. 유지할 id 목록을 임시 테이블로 생성
    console.log('\n  ⏳ 유지할 행 식별 중 (임시 테이블 생성)...');
    const start = Date.now();

    await client.query(`DROP TABLE IF EXISTS _dedup_keep_ids`);
    await client.query(`
      CREATE TEMP TABLE _dedup_keep_ids AS
      SELECT min(id) AS keep_id
      FROM staging_ingredients
      GROUP BY prdlst_report_no, rawmtrl_nm
    `);

    const { rows: [{ count: keepCount }] } = await client.query(
      'SELECT count(*) FROM _dedup_keep_ids'
    );
    const dupCount = parseInt(totalBefore) - parseInt(keepCount);

    console.log(`  유지할 행:           ${parseInt(keepCount).toLocaleString()}건`);
    console.log(`  중복 행 (삭제 대상): ${dupCount.toLocaleString()}건`);
    console.log(`  소요: ${((Date.now() - start) / 1000).toFixed(1)}초`);

    if (dupCount === 0) {
      console.log('\n  ✅ 중복 없음 — 작업 불필요');
      await client.query('DROP TABLE IF EXISTS _dedup_keep_ids');
      return;
    }

    if (DRY_RUN) {
      console.log('\n  🔍 DRY RUN 완료 — 실제 삭제하려면 --dry-run 없이 실행하세요.');
      await client.query('DROP TABLE IF EXISTS _dedup_keep_ids');
      return;
    }

    // 3. 인덱스 생성 (JOIN 성능 향상)
    console.log('\n  ⏳ 임시 인덱스 생성 중...');
    await client.query('CREATE INDEX ON _dedup_keep_ids (keep_id)');

    // 4. 중복 삭제 (배치)
    console.log('  ⏳ 중복 삭제 중...');
    const delStart = Date.now();

    const { rowCount } = await client.query(`
      DELETE FROM staging_ingredients si
      WHERE NOT EXISTS (
        SELECT 1 FROM _dedup_keep_ids k WHERE k.keep_id = si.id
      )
    `);

    const delElapsed = ((Date.now() - delStart) / 1000).toFixed(1);
    console.log(`  ✅ 삭제 완료: ${rowCount.toLocaleString()}건 (${delElapsed}초)`);

    // 5. 정리
    await client.query('DROP TABLE IF EXISTS _dedup_keep_ids');

    // 6. 결과 확인
    const { rows: [{ count: totalAfter }] } = await client.query(
      'SELECT count(*) FROM staging_ingredients'
    );
    const { rows: [{ count: uniqueReportsAfter }] } = await client.query(
      'SELECT count(DISTINCT prdlst_report_no) FROM staging_ingredients'
    );

    console.log(`\n  제거 후 총 행:       ${parseInt(totalAfter).toLocaleString()}건`);
    console.log(`  고유 report_no:      ${parseInt(uniqueReportsAfter).toLocaleString()}건`);

    // 기존 1,017,062건 대비 순증
    const originalCount = 1017062;
    const netNew = parseInt(totalAfter) - originalCount;
    if (netNew > 0) {
      console.log(`  기존 대비 순증:      +${netNew.toLocaleString()}건 (신규 C002 데이터)`);
    } else if (netNew === 0) {
      console.log(`  기존과 동일 — 신규 데이터 없음`);
    }

    console.log('\n========================================');
    console.log(`  총 소요 시간: ${((Date.now() - start) / 1000).toFixed(1)}초`);
    console.log('========================================');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
