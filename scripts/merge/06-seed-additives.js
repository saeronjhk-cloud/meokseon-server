/**
 * Step 6: additives 시드 데이터 로딩
 *
 * MFRAS v2.0 additive_risk_db_v2.0.json (994개)을
 * additives 테이블에 적재합니다.
 *
 * 매핑:
 *   original_color → risk_color (GREEN/YELLOW/ORANGE/RED → green/yellow/orange/red)
 *   original_grade → risk_grade (1~4)
 *   adi_value → max_daily_intake (텍스트)
 *
 * 사용법: node scripts/merge/06-seed-additives.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'meokseon',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function main() {
  const client = await pool.connect();

  try {
    console.log('========================================');
    console.log('  Step 6: additives 시드 데이터 로딩');
    console.log('========================================\n');

    // JSON 파일 로드
    const jsonPath = path.resolve(__dirname, '../../..', 'week1_pipeline/additive_risk_db_v2.0.json');
    if (!fs.existsSync(jsonPath)) {
      console.error(`  ❌ 파일을 찾을 수 없습니다: ${jsonPath}`);
      process.exit(1);
    }

    const rawData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const entries = Object.values(rawData);
    console.log(`  MFRAS v2.0 첨가물: ${entries.length}건 로드`);

    // 기존 데이터 확인
    const { rows: [{ count: existingCount }] } = await client.query('SELECT count(*) FROM additives');
    console.log(`  기존 additives: ${parseInt(existingCount)}건`);

    // risk_color 컬럼 타입 확인 (ENUM일 수 있음)
    let allowedColors = null;
    try {
      const { rows: colInfo } = await client.query(`
        SELECT data_type, udt_name FROM information_schema.columns
        WHERE table_name = 'additives' AND column_name = 'risk_color'
      `);
      if (colInfo.length > 0 && colInfo[0].data_type === 'USER-DEFINED') {
        const { rows: enumVals } = await client.query(`
          SELECT e.enumlabel FROM pg_enum e
          JOIN pg_type t ON e.enumtypid = t.oid
          WHERE t.typname = $1
        `, [colInfo[0].udt_name]);
        allowedColors = new Set(enumVals.map(r => r.enumlabel));
        console.log(`  risk_color ENUM 허용값: ${[...allowedColors].join(', ')}`);
      } else {
        console.log(`  risk_color 타입: ${colInfo[0]?.data_type || 'unknown'} (제약 없음)`);
      }
    } catch (e) {
      console.log(`  ⚠️ risk_color 타입 확인 실패: ${e.message}`);
    }

    let inserted = 0, skipped = 0, errors = 0;
    let firstError = null;

    // 트랜잭션 없이 개별 INSERT (트랜잭션 중독 방지)
    for (const item of entries) {
      const nameKo = item.name_kr || '';
      const nameEn = item.name_en || '';

      if (!nameKo && !nameEn) {
        skipped++;
        continue;
      }

      // risk_color 매핑 (대문자 → 소문자)
      let riskColor = (item.original_color || 'gray').toLowerCase();
      // ENUM 제약이 있으면 허용값으로 변환 (orange → yellow 대체)
      if (allowedColors && !allowedColors.has(riskColor)) {
        if (riskColor === 'orange') riskColor = 'yellow'; // orange → yellow 대체
        else riskColor = 'gray'; // 알 수 없는 값 → gray
      }

      // risk_grade 매핑 (original_grade 그대로, 없으면 0)
      const riskGrade = item.original_grade || 0;

      // max_daily_intake: ADI 값 정리
      let maxDailyIntake = null;
      if (item.adi_type === 'numeric' && item.adi_value !== null) {
        maxDailyIntake = `${item.adi_value} mg/kg bw/day`;
      } else if (item.adi_type === 'not_specified') {
        maxDailyIntake = 'ADI not specified (safe)';
      } else if (item.adi_type === 'group') {
        maxDailyIntake = item.adi_value ? `Group ADI: ${item.adi_value} mg/kg bw/day` : 'Group ADI';
      }

      // description 구성
      const descParts = [];
      if (item.category) descParts.push(`분류: ${item.category}`);
      if (item.regulatory_status) descParts.push(`규제: ${item.regulatory_status}`);
      if (item.genotox_status) descParts.push(`유전독성: ${item.genotox_status}`);
      if (item.iarc_group) descParts.push(`IARC: ${item.iarc_group}`);
      if (item.data_sufficiency) descParts.push(`데이터: ${item.data_sufficiency}`);
      const description = descParts.join(' | ');

      try {
        await client.query(`
          INSERT INTO additives (name_ko, name_en, e_number, cas_number, risk_grade, risk_color, category, description, max_daily_intake)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT DO NOTHING
        `, [
          nameKo, nameEn,
          item.e_number || null,
          item.cas_no || null,
          riskGrade,
          riskColor,
          item.category || null,
          description || null,
          maxDailyIntake,
        ]);
        inserted++;
      } catch (err) {
        errors++;
        if (!firstError) {
          firstError = `${nameKo}: ${err.message}`;
          console.error(`\n  ❌ 첫 오류: ${firstError}`);
        }
      }
    }

    const { rows: [{ count: finalCount }] } = await client.query('SELECT count(*) FROM additives');

    console.log('\n========================================');
    console.log('  Step 6 완료 요약');
    console.log('========================================');
    console.log(`  삽입 성공: ${inserted}건 / 스킵: ${skipped}건 / 오류: ${errors}건`);
    console.log(`  additives 테이블 총: ${parseInt(finalCount)}건`);
    if (firstError) console.log(`  첫 오류 상세: ${firstError}`);

    // 색상별 분포
    const { rows: colorDist } = await client.query(`
      SELECT risk_color, count(*) as cnt
      FROM additives
      GROUP BY risk_color
      ORDER BY cnt DESC
    `);
    console.log('\n  색상 분포:');
    for (const r of colorDist) {
      console.log(`    ${r.risk_color}: ${r.cnt}건`);
    }

    console.log('\n  다음: node scripts/merge/07-rematch-additives.js');
    console.log('========================================');

  } catch (err) {
    console.error('❌ 시드 실패:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
