/**
 * Step 9b: 신규 영양강화제 15종 → 기존 제품 원재료 재매칭
 *
 * Step 9에서 추가한 영양강화제가 기존 원재료 텍스트에 포함된 경우
 * product_additives에 새로 연결합니다.
 *
 * 기존 매칭은 건드리지 않고, 신규 추가분만 INSERT합니다.
 *
 * 사용법: node scripts/merge/09b-rematch-new-fortifiers.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'meokseon',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

const BATCH_SIZE = 1000;

async function main() {
  const client = await pool.connect();

  try {
    console.log('═══════════════════════════════════════════════════');
    console.log('  Step 9b: 신규 영양강화제 → 기존 제품 재매칭');
    console.log('═══════════════════════════════════════════════════\n');

    // ── 1. 신규 등록된 영양강화제 로드 ──
    const { rows: newFortifiers } = await client.query(
      `SELECT additive_id, name_ko, name_en FROM additives WHERE category = '영양강화제'`
    );
    console.log(`  영양강화제 사전: ${newFortifiers.length}건 로드`);

    // 정규화된 이름 → additive 매핑
    const fortifierMap = new Map();
    for (const f of newFortifiers) {
      const normKo = (f.name_ko || '').replace(/\s+/g, '').toLowerCase();
      if (normKo) fortifierMap.set(normKo, f);
      const normEn = (f.name_en || '').replace(/\s+/g, '').toLowerCase();
      if (normEn) fortifierMap.set(normEn, f);
    }
    console.log(`  매칭 키: ${fortifierMap.size}개\n`);

    // ── 2. 원재료 텍스트 보유 제품 조회 ──
    const { rows: [{ count: totalCount }] } = await client.query(
      `SELECT count(*) FROM product_ingredients WHERE raw_text IS NOT NULL AND raw_text != ''`
    );
    console.log(`  원재료 보유 제품: ${totalCount}건 — 재매칭 시작...\n`);

    let totalMatched = 0;
    let totalInserted = 0;
    let processed = 0;
    const matchedProducts = [];

    // 배치 처리
    let offset = 0;
    while (true) {
      const { rows: batch } = await client.query(
        `SELECT product_id, raw_text FROM product_ingredients
         WHERE raw_text IS NOT NULL AND raw_text != ''
         ORDER BY product_id
         LIMIT $1 OFFSET $2`,
        [BATCH_SIZE, offset]
      );

      if (batch.length === 0) break;

      for (const row of batch) {
        const rawNorm = row.raw_text.replace(/\s+/g, '').toLowerCase();

        // 모든 영양강화제 이름으로 검색
        for (const [normName, additive] of fortifierMap) {
          if (rawNorm.includes(normName)) {
            // 이미 연결되어 있는지 확인 후 INSERT
            try {
              const { rowCount } = await client.query(
                `INSERT INTO product_additives (product_id, additive_id)
                 VALUES ($1, $2)
                 ON CONFLICT (product_id, additive_id) DO NOTHING`,
                [row.product_id, additive.additive_id]
              );
              if (rowCount > 0) {
                totalInserted++;
                matchedProducts.push({
                  product_id: row.product_id,
                  additive: additive.name_ko,
                });
              }
              totalMatched++;
            } catch (e) {
              // 무시 (중복 등)
            }
          }
        }

        processed++;
        if (processed % 5000 === 0) {
          process.stdout.write(`\r  진행: ${processed}/${totalCount} (신규 매칭: ${totalInserted}건)`);
        }
      }

      offset += BATCH_SIZE;
    }

    console.log(`\r  진행: ${processed}/${totalCount} — 완료!                    \n`);

    // ── 3. 결과 요약 ──
    console.log('═══════════════════════════════════════════════════');
    console.log(`  ✅ 재매칭 완료!`);
    console.log(`  검사 제품: ${processed}건`);
    console.log(`  총 매칭 횟수: ${totalMatched}건 (기존 포함)`);
    console.log(`  신규 INSERT: ${totalInserted}건`);
    console.log('═══════════════════════════════════════════════════\n');

    // 신규 매칭 상세 (첨가물별 집계)
    if (totalInserted > 0) {
      const byAdditive = {};
      for (const m of matchedProducts) {
        byAdditive[m.additive] = (byAdditive[m.additive] || 0) + 1;
      }
      console.log('  신규 매칭 첨가물별 집계:');
      const sorted = Object.entries(byAdditive).sort((a, b) => b[1] - a[1]);
      for (const [name, count] of sorted) {
        console.log(`    ${name}: ${count}건`);
      }
    } else {
      console.log('  → 신규 매칭 없음 (이미 모두 연결되어 있거나 해당 성분이 원재료에 없음)');
    }

    // 최종 product_additives 현황
    const { rows: [{ count: paCount }] } = await client.query('SELECT count(*) FROM product_additives');
    console.log(`\n  product_additives 총: ${paCount}건`);

  } catch (err) {
    console.error('❌ 오류:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
