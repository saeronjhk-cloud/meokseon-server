/**
 * Step 7: 첨가물 재매칭
 *
 * Step 4에서 파싱은 완료됐지만 additives 테이블이 비어있어서
 * 매칭이 0건이었던 문제를 해결합니다.
 *
 * 처리 흐름:
 * 1. additives 사전 로드
 * 2. product_ingredients의 parsed_ingredients JSONB 읽기
 * 3. 각 원재료명을 additives DB와 대조
 * 4. product_additives에 등록
 *
 * 배치: 1,000건 단위
 * 사용법: node scripts/merge/07-rematch-additives.js
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

/**
 * 파싱된 원재료에서 모든 개별 성분명 추출 (하위 포함)
 */
function extractAllNames(parsed) {
  const names = [];
  if (!Array.isArray(parsed)) return names;
  for (const item of parsed) {
    if (item.name) names.push(item.name);
    if (item.sub_ingredients && Array.isArray(item.sub_ingredients)) {
      for (const sub of item.sub_ingredients) {
        if (sub.name) names.push(sub.name);
      }
    }
  }
  return names;
}

async function main() {
  const client = await pool.connect();

  try {
    console.log('========================================');
    console.log('  Step 7: 첨가물 재매칭');
    console.log('========================================');

    const startTime = Date.now();

    // ── 첨가물 사전 로드 ──
    const { rows: additiveRows } = await client.query(`
      SELECT additive_id, name_ko, name_en, risk_grade, risk_color, category
      FROM additives
    `);

    if (additiveRows.length === 0) {
      console.error('  ❌ additives 테이블이 비어있습니다. 먼저 06-seed-additives.js를 실행하세요.');
      process.exit(1);
    }

    // 이름 → additive 매핑 (정규화된 이름으로)
    const additiveMap = new Map();
    for (const a of additiveRows) {
      const normalizedKo = (a.name_ko || '').replace(/\s+/g, '').toLowerCase();
      if (normalizedKo) additiveMap.set(normalizedKo, a);

      const normalizedEn = (a.name_en || '').replace(/\s+/g, '').toLowerCase();
      if (normalizedEn) additiveMap.set(normalizedEn, a);
    }
    console.log(`  첨가물 사전: ${additiveRows.length}건 로드 (${additiveMap.size}개 키)`);

    // ── 기존 product_additives 초기화 ──
    const { rows: [{ count: existingPA }] } = await client.query('SELECT count(*) FROM product_additives');
    console.log(`  기존 product_additives: ${parseInt(existingPA)}건`);

    // ── 매칭 대상 조회 ──
    const { rows: ingredients } = await client.query(`
      SELECT id, product_id, parsed_ingredients
      FROM product_ingredients
      WHERE parsed_ingredients IS NOT NULL
      ORDER BY id
    `);

    console.log(`  매칭 대상: ${ingredients.length.toLocaleString()}건`);

    let productsWithAdditives = 0;
    let totalAdditiveLinks = 0;
    let errors = 0;
    const total = ingredients.length;

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = ingredients.slice(i, i + BATCH_SIZE);
      const batchClient = await pool.connect();

      try {
        await batchClient.query('BEGIN');

        for (const ing of batch) {
          let parsed = ing.parsed_ingredients;
          // JSONB는 이미 객체로 올 수도 있고 문자열일 수도 있음
          if (typeof parsed === 'string') {
            try { parsed = JSON.parse(parsed); } catch { continue; }
          }

          const allNames = extractAllNames(parsed);
          let foundInProduct = false;

          for (const name of allNames) {
            const normalized = name.replace(/\s+/g, '').toLowerCase();
            const additive = additiveMap.get(normalized);

            if (additive) {
              await batchClient.query(`
                INSERT INTO product_additives (product_id, additive_id)
                VALUES ($1, $2)
                ON CONFLICT DO NOTHING
              `, [ing.product_id, additive.additive_id]);

              totalAdditiveLinks++;
              foundInProduct = true;
            }
          }

          if (foundInProduct) productsWithAdditives++;
        }

        await batchClient.query('COMMIT');
      } catch (err) {
        await batchClient.query('ROLLBACK');
        errors += batch.length;
        console.error(`\n  ❌ 배치 오류 (${i}~${i + batch.length}): ${err.message}`);
      } finally {
        batchClient.release();
      }

      progress(Math.min(i + BATCH_SIZE, total), total, '첨가물 재매칭');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // 최종 통계
    const { rows: [{ count: finalPA }] } = await client.query('SELECT count(*) FROM product_additives');
    const { rows: [{ count: distinctProducts }] } = await client.query('SELECT count(DISTINCT product_id) FROM product_additives');

    console.log('\n\n========================================');
    console.log('  Step 7 완료 요약');
    console.log('========================================');
    console.log(`  첨가물 링크 생성:     ${totalAdditiveLinks.toLocaleString()}건`);
    console.log(`  첨가물 보유 제품:     ${parseInt(distinctProducts).toLocaleString()}건`);
    console.log(`  product_additives 총: ${parseInt(finalPA).toLocaleString()}건`);
    console.log(`  오류:                 ${errors}건`);
    console.log(`  소요 시간:            ${elapsed}초`);

    // 위해 등급별 분포
    const { rows: gradeDist } = await client.query(`
      SELECT a.risk_color, count(*) as cnt
      FROM product_additives pa
      JOIN additives a ON pa.additive_id = a.additive_id
      GROUP BY a.risk_color
      ORDER BY cnt DESC
    `);
    console.log('\n  제품-첨가물 링크 색상 분포:');
    for (const r of gradeDist) {
      console.log(`    ${r.risk_color}: ${parseInt(r.cnt).toLocaleString()}건`);
    }

    // 가장 많이 사용된 첨가물 TOP 10
    const { rows: topAdditives } = await client.query(`
      SELECT a.name_ko, a.risk_color, count(*) as cnt
      FROM product_additives pa
      JOIN additives a ON pa.additive_id = a.additive_id
      GROUP BY a.name_ko, a.risk_color
      ORDER BY cnt DESC
      LIMIT 10
    `);
    console.log('\n  가장 많이 사용된 첨가물 TOP 10:');
    for (const r of topAdditives) {
      console.log(`    ${r.name_ko} (${r.risk_color}): ${parseInt(r.cnt).toLocaleString()}개 제품`);
    }

    console.log('\n========================================');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
