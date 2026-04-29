/**
 * Step 2: C005 + C002 + I1250 병합 (품목보고번호 기반)
 *
 * 처리 흐름:
 * 1. I1250 → products 보강 (품목유형, 유통기한, 단종 여부 등)
 *    - staging_product_report는 prdlst_report_no, prdlst_nm, bssh_nm,
 *      prdlst_dcnm, prms_dt, lcns_no, raw_data 컬럼만 보유
 *    - pog_daycnt, production, hieng_lntrt_dvs_nm 등은 raw_data JSONB에서 추출
 * 2. C002 → product_ingredients 등록 (다중행 통합 → 원재료 텍스트)
 *    - staging_ingredients는 prdlst_report_no, prdlst_nm, rawmtrl_nm,
 *      bssh_nm, prms_dt, raw_data 컬럼만 보유
 *    - rawmtrl_ordno는 raw_data JSONB에서 추출
 *
 * 배치: 1,000건 단위 커밋
 * 사용법: node scripts/merge/02-merge-report-no.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'meokseon',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  statement_timeout: 60000,
});

const BATCH_SIZE = 1000;

function progress(current, total, label) {
  const pct = ((current / total) * 100).toFixed(1);
  process.stdout.write(`\r  ${label}: ${pct}% (${current.toLocaleString()}/${total.toLocaleString()})`);
}

async function mergeI1250() {
  console.log('\n── Step 2-A: I1250 → products 보강 ──');

  const mainClient = await pool.connect();
  try {
    // products에서 c005_report_no가 있고, 아직 I1250 보강 안 된 제품만
    const { rows: products } = await mainClient.query(`
      SELECT product_id, c005_report_no
      FROM products
      WHERE c005_report_no IS NOT NULL AND c005_report_no != ''
        AND pog_daycnt IS NULL AND prms_dt_i1250 IS NULL
    `);
    console.log(`  대상 제품: ${products.length.toLocaleString()}건 (미보강 제품만)`);

    let matched = 0, skipped = 0, errors = 0;
    const total = products.length;

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = products.slice(i, i + BATCH_SIZE);
      const batchClient = await pool.connect();

      try {
        await batchClient.query('BEGIN');

        for (const p of batch) {
          // raw_data JSONB에서 추가 필드 추출
          const { rows } = await batchClient.query(`
            SELECT
              prdlst_dcnm,
              prms_dt,
              lcns_no,
              raw_data->>'POG_DAYCNT' AS pog_daycnt,
              raw_data->>'HIENG_LNTRT_DVS_NM' AS hieng_lntrt_dvs_nm,
              raw_data->>'DISPOS' AS dispos,
              raw_data->>'FRMLC_MTRQLT' AS frmlc_mtrqlt,
              raw_data->>'PRODUCTION' AS production
            FROM staging_product_report
            WHERE prdlst_report_no = $1
            LIMIT 1
          `, [p.c005_report_no]);

          if (rows.length === 0) {
            skipped++;
            await batchClient.query(`
              INSERT INTO merge_log (step, status, source_table, target_product_id, reject_reason)
              VALUES ('step2_i1250', 'skipped', 'staging_product_report', $1, 'no_match')
            `, [p.product_id]);
            continue;
          }

          const r = rows[0];
          const isActive = r.production !== '아니오';

          await batchClient.query(`
            UPDATE products SET
              food_type = COALESCE(food_type, $2),
              pog_daycnt = $3,
              prms_dt_i1250 = $4,
              hieng_lntrt_dvs_nm = $5,
              dispos = $6,
              frmlc_mtrqlt = $7,
              is_active = $8,
              updated_at = NOW()
            WHERE product_id = $1
          `, [
            p.product_id,
            r.prdlst_dcnm,
            r.pog_daycnt,
            r.prms_dt,
            r.hieng_lntrt_dvs_nm,
            r.dispos,
            r.frmlc_mtrqlt,
            isActive,
          ]);

          await batchClient.query(`
            INSERT INTO merge_log (step, status, source_table, target_product_id, detail)
            VALUES ('step2_i1250', 'matched', 'staging_product_report', $1, $2)
          `, [p.product_id, JSON.stringify({ is_active: isActive, food_type: r.prdlst_dcnm })]);

          matched++;
        }

        await batchClient.query('COMMIT');
      } catch (err) {
        await batchClient.query('ROLLBACK');
        errors += batch.length;
        console.error(`\n  ❌ 배치 오류 (${i}~${i + batch.length}): ${err.message}`);
      } finally {
        batchClient.release();
      }

      progress(Math.min(i + BATCH_SIZE, total), total, 'I1250 보강');
    }

    console.log(`\n  결과: 매칭 ${matched.toLocaleString()} / 미매칭 ${skipped.toLocaleString()} / 오류 ${errors}`);
    return { matched, skipped, errors };
  } finally {
    mainClient.release();
  }
}

async function mergeC002() {
  console.log('\n── Step 2-B: C002 → product_ingredients 등록 ──');

  const mainClient = await pool.connect();
  try {
    const { rows: products } = await mainClient.query(`
      SELECT product_id, c005_report_no
      FROM products
      WHERE c005_report_no IS NOT NULL AND c005_report_no != ''
    `);
    console.log(`  대상 제품: ${products.length.toLocaleString()}건`);

    let matched = 0, skipped = 0, errors = 0;
    const total = products.length;

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = products.slice(i, i + BATCH_SIZE);
      const batchClient = await pool.connect();

      try {
        await batchClient.query('BEGIN');

        for (const p of batch) {
          // rawmtrl_nm 조회 (RAWMTRL_ORDNO는 쉼표 목록일 수 있어 id 순서로 정렬)
          const { rows: ingRows } = await batchClient.query(`
            SELECT rawmtrl_nm
            FROM staging_ingredients
            WHERE prdlst_report_no = $1
            ORDER BY id ASC
          `, [p.c005_report_no]);

          if (ingRows.length === 0) {
            skipped++;
            await batchClient.query(`
              INSERT INTO merge_log (step, status, source_table, target_product_id, reject_reason)
              VALUES ('step2_c002', 'skipped', 'staging_ingredients', $1, 'no_match')
            `, [p.product_id]);
            continue;
          }

          // 다중행 원재료 텍스트 통합
          const combinedRaw = ingRows
            .map(r => r.rawmtrl_nm)
            .filter(Boolean)
            .join(', ');

          if (!combinedRaw.trim()) {
            skipped++;
            continue;
          }

          // 이미 등록된 원재료가 있으면 건너뛰기
          const { rows: existing } = await batchClient.query(`
            SELECT id FROM product_ingredients
            WHERE product_id = $1 AND source = 'c002'
            LIMIT 1
          `, [p.product_id]);

          if (existing.length > 0) {
            skipped++;
            continue;
          }

          await batchClient.query(`
            INSERT INTO product_ingredients (product_id, raw_text, prdlst_report_no, source)
            VALUES ($1, $2, $3, 'c002')
          `, [p.product_id, combinedRaw, p.c005_report_no]);

          await batchClient.query(`
            INSERT INTO merge_log (step, status, source_table, target_product_id, detail)
            VALUES ('step2_c002', 'matched', 'staging_ingredients', $1, $2)
          `, [p.product_id, JSON.stringify({ rows_merged: ingRows.length, text_length: combinedRaw.length })]);

          matched++;
        }

        await batchClient.query('COMMIT');
      } catch (err) {
        await batchClient.query('ROLLBACK');
        errors += batch.length;
        console.error(`\n  ❌ 배치 오류 (${i}~${i + batch.length}): ${err.message}`);
      } finally {
        batchClient.release();
      }

      progress(Math.min(i + BATCH_SIZE, total), total, 'C002 등록');
    }

    console.log(`\n  결과: 매칭 ${matched.toLocaleString()} / 미매칭 ${skipped.toLocaleString()} / 오류 ${errors}`);
    return { matched, skipped, errors };
  } finally {
    mainClient.release();
  }
}

async function main() {
  console.log('========================================');
  console.log('  Step 2: 품목보고번호 기반 병합');
  console.log('========================================');

  const startTime = Date.now();

  const i1250Result = await mergeI1250();
  const c002Result = await mergeC002();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const client = await pool.connect();
  try {
    const { rows: [{ count: inactiveCount }] } = await client.query(
      `SELECT count(*) FROM products WHERE is_active = false`
    );

    console.log('\n========================================');
    console.log('  Step 2 완료 요약');
    console.log('========================================');
    console.log(`  I1250 보강: ${i1250Result.matched.toLocaleString()}건 매칭`);
    console.log(`  C002 등록:  ${c002Result.matched.toLocaleString()}건 매칭`);
    console.log(`  단종 제품:  ${parseInt(inactiveCount).toLocaleString()}건 (is_active=false)`);
    console.log(`  소요 시간:  ${elapsed}초`);
    console.log('\n  다음: node scripts/merge/03-fuzzy-nutrition.js');
    console.log('========================================');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
