/**
 * C002 제품명 기반 fuzzy matching 가능성 테스트
 * - report_no로 매칭 안 되는 제품들을 prdlst_nm(제품명)으로 시도
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

const TEST_NAMES = ['신라면', '진라면', '짜파게티', '불닭볶음면', '코카콜라', 
                    '바나나맛우유', '서울우유', '스팸', '참이슬', '케찹',
                    '포카칩', '새우깡', '초코파이', '메로나', '맥심모카골드'];

async function main() {
  const client = await pool.connect();
  try {
    // 1. staging_ingredients에 GIN trgm 인덱스 확인
    const { rows: indexes } = await client.query(`
      SELECT indexname, indexdef FROM pg_indexes 
      WHERE tablename = 'staging_ingredients' AND indexdef LIKE '%trgm%'
    `);
    console.log('=== GIN trgm 인덱스 ===');
    indexes.forEach(i => console.log(`  ${i.indexname}`));
    if (indexes.length === 0) console.log('  없음 — 인덱스 생성 필요');

    // 2. staging_ingredients 총 건수 및 고유 제품명 수
    const { rows: [stats] } = await client.query(`
      SELECT count(*) as total, 
             count(DISTINCT prdlst_nm) as unique_names,
             count(DISTINCT bssh_nm) as unique_makers
      FROM staging_ingredients
    `);
    console.log(`\n=== staging_ingredients 통계 ===`);
    console.log(`  총 행: ${parseInt(stats.total).toLocaleString()}`);
    console.log(`  고유 제품명: ${parseInt(stats.unique_names).toLocaleString()}`);
    console.log(`  고유 제조사: ${parseInt(stats.unique_makers).toLocaleString()}`);

    // 3. 인기 제품 제품명 fuzzy 검색 테스트
    console.log(`\n=== 인기 제품 C002 제품명 fuzzy 검색 ===\n`);

    for (const name of TEST_NAMES) {
      // 먼저 ILIKE 검색
      const { rows: ilikeResults } = await client.query(`
        SELECT DISTINCT prdlst_nm, bssh_nm, prdlst_report_no
        FROM staging_ingredients
        WHERE prdlst_nm ILIKE '%' || $1 || '%'
        ORDER BY length(prdlst_nm) ASC
        LIMIT 5
      `, [name]);

      if (ilikeResults.length > 0) {
        console.log(`✅ ${name} → ${ilikeResults.length}건 (ILIKE)`);
        for (const r of ilikeResults.slice(0, 3)) {
          console.log(`     "${r.prdlst_nm}" [${r.bssh_nm}] report: ${r.prdlst_report_no}`);
        }
      } else {
        console.log(`❌ ${name} → ILIKE 결과 없음`);
      }
    }

    // 4. C002 미수록 제품 중 제품명 fuzzy로 복구 가능한 비율 추정 (샘플)
    console.log(`\n=== 복구 가능 비율 추정 (100건 샘플) ===`);
    const { rows: unmatchedSample } = await client.query(`
      SELECT p.product_id, p.product_name, p.c005_report_no
      FROM products p
      WHERE p.c005_report_no IS NOT NULL AND p.c005_report_no != ''
        AND NOT EXISTS (SELECT 1 FROM staging_ingredients si WHERE si.prdlst_report_no = p.c005_report_no)
        AND NOT EXISTS (SELECT 1 FROM product_ingredients pi WHERE pi.product_id = p.product_id)
      ORDER BY random()
      LIMIT 100
    `);

    let recovered = 0;
    for (const p of unmatchedSample) {
      // 짧은 이름은 정확도가 떨어지므로 3글자 이상만
      const searchName = p.product_name.replace(/\([^)]*\)/g, '').trim();
      if (searchName.length < 3) continue;

      const { rows: matches } = await client.query(`
        SELECT prdlst_nm, prdlst_report_no
        FROM staging_ingredients
        WHERE prdlst_nm ILIKE '%' || $1 || '%'
        LIMIT 1
      `, [searchName.substring(0, Math.min(searchName.length, 15))]);

      if (matches.length > 0) {
        recovered++;
      }
    }
    console.log(`  샘플 100건 중 ILIKE 매칭 가능: ${recovered}건 (${recovered}%)`);

  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(err => { console.error(err); process.exit(1); });
