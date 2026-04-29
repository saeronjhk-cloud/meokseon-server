/**
 * 제조사명 동의어 사전 구축을 위한 분석 스크립트
 *
 * products 테이블과 staging_ingredients 테이블의 제조사명을 비교하여
 * 동의어 후보를 자동으로 추출합니다.
 *
 * 출력:
 *   1. 상위 100개 제조사 (products 기준)
 *   2. 정규화 후에도 매칭되지 않는 제조사 쌍 (동의어 후보)
 *   3. CSV 파일로 저장 (scripts/staging/manufacturer-analysis.csv)
 *
 * 사용법:
 *   node scripts/staging/analyze-manufacturers.js
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

// 현재 정규화 로직 (10-c002-name-match.js와 동일)
function normalizeMaker(name) {
  if (!name) return '';
  return name
    .replace(/\s*\(주\)\s*/g, '')
    .replace(/주식회사/g, '')
    .replace(/㈜/g, '')
    .replace(/(주)/g, '')
    .replace(/유한회사/g, '')
    .replace(/유한공사/g, '')
    .replace(/합자회사/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

async function main() {
  const client = await pool.connect();

  try {
    console.log('========================================');
    console.log('  제조사명 동의어 분석');
    console.log('========================================\n');

    // 1. products 테이블의 상위 제조사 (매칭 안 된 제품 기준)
    console.log('  ⏳ 1단계: 원재료 미보유 제품의 제조사 분석...');
    const { rows: unmatchedMakers } = await client.query(`
      SELECT p.manufacturer, count(*) AS cnt
      FROM products p
      WHERE p.manufacturer IS NOT NULL
        AND p.manufacturer != ''
        AND NOT EXISTS (
          SELECT 1 FROM product_ingredients pi WHERE pi.product_id = p.product_id
        )
      GROUP BY p.manufacturer
      ORDER BY cnt DESC
      LIMIT 100
    `);

    console.log(`\n  === 원재료 미보유 제품 상위 제조사 (products) ===`);
    console.log(`  ${'순위'.padEnd(6)} ${'제조사'.padEnd(30)} ${'미보유 건수'.padEnd(12)} ${'정규화'}`);
    console.log('  ' + '-'.repeat(70));
    unmatchedMakers.forEach((r, i) => {
      console.log(`  ${String(i + 1).padEnd(6)} ${r.manufacturer.padEnd(30)} ${String(r.cnt).padEnd(12)} ${normalizeMaker(r.manufacturer)}`);
    });

    // 2. staging_ingredients의 상위 제조사
    console.log('\n  ⏳ 2단계: staging_ingredients 상위 제조사...');
    const { rows: c002Makers } = await client.query(`
      SELECT bssh_nm, count(DISTINCT prdlst_report_no) AS cnt
      FROM staging_ingredients
      WHERE bssh_nm IS NOT NULL AND bssh_nm != ''
      GROUP BY bssh_nm
      ORDER BY cnt DESC
      LIMIT 100
    `);

    console.log(`\n  === staging_ingredients 상위 제조사 (C002) ===`);
    console.log(`  ${'순위'.padEnd(6)} ${'제조사'.padEnd(30)} ${'품목수'.padEnd(12)} ${'정규화'}`);
    console.log('  ' + '-'.repeat(70));
    c002Makers.forEach((r, i) => {
      console.log(`  ${String(i + 1).padEnd(6)} ${r.bssh_nm.padEnd(30)} ${String(r.cnt).padEnd(12)} ${normalizeMaker(r.bssh_nm)}`);
    });

    // 3. 동의어 후보 탐지: products 제조사를 정규화한 것과 C002 제조사를 정규화한 것이
    //    서로 포함관계가 아닌 경우, 유사한 것끼리 묶기
    console.log('\n  ⏳ 3단계: 동의어 후보 탐지 (pg_trgm 유사도)...');

    // 원재료 미보유 상위 50개 제조사에 대해 C002에서 유사한 제조사 찾기
    const synonymCandidates = [];

    for (const pm of unmatchedMakers.slice(0, 50)) {
      const normP = normalizeMaker(pm.manufacturer);
      if (!normP || normP.length < 2) continue;

      // 현재 로직(includes)으로는 매칭되지 않는 C002 제조사 중 유사한 것 찾기
      const { rows: similar } = await client.query(`
        SELECT DISTINCT bssh_nm,
               similarity($1, bssh_nm) AS sim
        FROM staging_ingredients
        WHERE bssh_nm % $1
          AND similarity($1, bssh_nm) >= 0.3
        ORDER BY sim DESC
        LIMIT 10
      `, [pm.manufacturer]);

      for (const s of similar) {
        const normC = normalizeMaker(s.bssh_nm);
        // 현재 정규화 후 includes로 이미 매칭되는지 확인
        const alreadyMatches = normC && normP && (normC.includes(normP) || normP.includes(normC));
        if (!alreadyMatches) {
          synonymCandidates.push({
            products_maker: pm.manufacturer,
            products_norm: normP,
            c002_maker: s.bssh_nm,
            c002_norm: normC,
            similarity: s.sim.toFixed(3),
            unmatched_count: pm.cnt,
          });
        }
      }
    }

    console.log(`\n  === 동의어 후보 (현재 로직으로 매칭 안 되는 유사 제조사) ===`);
    console.log(`  ${'products 제조사'.padEnd(25)} ${'C002 제조사'.padEnd(25)} ${'유사도'.padEnd(8)} ${'미보유건수'}`);
    console.log('  ' + '-'.repeat(80));
    synonymCandidates.forEach(c => {
      console.log(`  ${c.products_maker.padEnd(25)} ${c.c002_maker.padEnd(25)} ${c.similarity.padEnd(8)} ${c.unmatched_count}`);
    });

    // 4. 같은 정규화 결과를 가진 다른 원본명 묶기
    console.log('\n  ⏳ 4단계: 동일 정규화 → 다른 원본명 그룹...');
    const { rows: normGroups } = await client.query(`
      WITH all_makers AS (
        SELECT manufacturer AS name, 'products' AS source FROM products WHERE manufacturer IS NOT NULL
        UNION ALL
        SELECT DISTINCT bssh_nm AS name, 'c002' AS source FROM staging_ingredients WHERE bssh_nm IS NOT NULL
      )
      SELECT name, source
      FROM all_makers
      ORDER BY name
    `);

    // JS에서 정규화 후 그룹핑
    const normMap = new Map();
    for (const r of normGroups) {
      const norm = normalizeMaker(r.name);
      if (!norm || norm.length < 2) continue;
      if (!normMap.has(norm)) normMap.set(norm, new Set());
      normMap.get(norm).add(`${r.name} [${r.source}]`);
    }

    // 2개 이상의 다른 원본명을 가진 그룹만 출력
    const multiGroups = [...normMap.entries()]
      .filter(([, names]) => names.size > 1)
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, 50);

    console.log(`\n  === 동일 정규화 결과를 가진 다른 이름들 (상위 50) ===`);
    for (const [norm, names] of multiGroups) {
      console.log(`\n  [${norm}]`);
      for (const n of names) {
        console.log(`    - ${n}`);
      }
    }

    // 5. CSV 저장
    const csvPath = path.join(__dirname, 'manufacturer-analysis.csv');
    const csvLines = ['products_maker,c002_maker,similarity,unmatched_count'];
    for (const c of synonymCandidates) {
      csvLines.push(`"${c.products_maker}","${c.c002_maker}",${c.similarity},${c.unmatched_count}`);
    }
    fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf-8');
    console.log(`\n\n  📄 CSV 저장: ${csvPath}`);
    console.log(`  동의어 후보: ${synonymCandidates.length}쌍`);

    // 6. 요약
    console.log('\n========================================');
    console.log('  분석 완료!');
    console.log(`  - 원재료 미보유 상위 제조사: ${unmatchedMakers.length}개`);
    console.log(`  - C002 상위 제조사: ${c002Makers.length}개`);
    console.log(`  - 동의어 후보: ${synonymCandidates.length}쌍`);
    console.log(`  - 동일 정규화 그룹: ${multiGroups.length}개`);
    console.log('========================================');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
