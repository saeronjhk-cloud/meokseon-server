/**
 * 인기 가공식품 100개 — 실사용 커버리지 테스트 v2
 *
 * Step 9b 이후 업데이트된 DB 상태를 반영:
 * - products 테이블 존재 여부
 * - nutrition_data 매칭 여부 (JOIN)
 * - product_ingredients 원재료 보유 여부
 * - product_additives 첨가물 분석 여부
 *
 * 사용법: node scripts/check-popular-products-v2.js
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

// 한국인이 실제로 많이 소비하는 가공식품 100개
const POPULAR_PRODUCTS = [
  // ── 라면 (10) ──
  { name: '신라면', category: '라면' },
  { name: '진라면', category: '라면' },
  { name: '너구리', category: '라면' },
  { name: '안성탕면', category: '라면' },
  { name: '짜파게티', category: '라면' },
  { name: '불닭볶음면', category: '라면' },
  { name: '삼양라면', category: '라면' },
  { name: '팔도비빔면', category: '라면' },
  { name: '참깨라면', category: '라면' },
  { name: '육개장', category: '라면' },

  // ── 과자/스낵 (10) ──
  { name: '새우깡', category: '과자' },
  { name: '포카칩', category: '과자' },
  { name: '꼬깔콘', category: '과자' },
  { name: '칙촉', category: '과자' },
  { name: '오레오', category: '과자' },
  { name: '빼빼로', category: '과자' },
  { name: '초코파이', category: '과자' },
  { name: '에이스', category: '과자' },
  { name: '홈런볼', category: '과자' },
  { name: '감자깡', category: '과자' },

  // ── 음료 (10) ──
  { name: '코카콜라', category: '음료' },
  { name: '펩시', category: '음료' },
  { name: '환타', category: '음료' },
  { name: '스프라이트', category: '음료' },
  { name: '밀키스', category: '음료' },
  { name: '포카리스웨트', category: '음료' },
  { name: '게토레이', category: '음료' },
  { name: '2%부족할때', category: '음료' },
  { name: '비타500', category: '음료' },
  { name: '박카스', category: '음료' },

  // ── 유제품 (10) ──
  { name: '서울우유', category: '유제품' },
  { name: '남양우유', category: '유제품' },
  { name: '매일우유', category: '유제품' },
  { name: '바나나맛우유', category: '유제품' },
  { name: '떠먹는요구르트', category: '유제품' },
  { name: '야쿠르트', category: '유제품' },
  { name: '비요뜨', category: '유제품' },
  { name: '덴마크우유', category: '유제품' },
  { name: '앙팡우유', category: '유제품' },
  { name: '불가리스', category: '유제품' },

  // ── 커피/차 (10) ──
  { name: '맥심모카골드', category: '커피' },
  { name: '카누', category: '커피' },
  { name: '프렌치카페', category: '커피' },
  { name: '보리차', category: '차' },
  { name: '립톤', category: '차' },
  { name: '레쓰비', category: '커피' },
  { name: '조지아', category: '커피' },
  { name: '칸타타', category: '커피' },
  { name: '맥심화이트골드', category: '커피' },
  { name: '핫초코', category: '차' },

  // ── 빵/시리얼 (8) ──
  { name: '호빵', category: '빵' },
  { name: '포켓몬빵', category: '빵' },
  { name: '첵스초코', category: '시리얼' },
  { name: '콘푸로스트', category: '시리얼' },
  { name: '프링글스', category: '과자' },
  { name: '오감자', category: '과자' },
  { name: '카스타드', category: '빵' },
  { name: '몽쉘', category: '빵' },

  // ── 냉동식품 (8) ──
  { name: '비비고만두', category: '냉동' },
  { name: '풀무원만두', category: '냉동' },
  { name: '오뚜기볶음밥', category: '냉동' },
  { name: '햇반', category: '냉동' },
  { name: '비비고왕교자', category: '냉동' },
  { name: '교촌치킨너겟', category: '냉동' },
  { name: '피자', category: '냉동' },
  { name: '냉동만두', category: '냉동' },

  // ── 소스/조미료 (8) ──
  { name: '진간장', category: '소스' },
  { name: '고추장', category: '소스' },
  { name: '된장', category: '소스' },
  { name: '케찹', category: '소스' },
  { name: '마요네즈', category: '소스' },
  { name: '참기름', category: '소스' },
  { name: '굴소스', category: '소스' },
  { name: '쌈장', category: '소스' },

  // ── 통조림/가공육 (8) ──
  { name: '스팸', category: '가공육' },
  { name: '참치캔', category: '통조림' },
  { name: '비엔나소시지', category: '가공육' },
  { name: '프랑크소시지', category: '가공육' },
  { name: '런천미트', category: '가공육' },
  { name: '맛살', category: '가공육' },
  { name: '어묵', category: '가공육' },
  { name: '햄', category: '가공육' },

  // ── 주류 (5) ──
  { name: '참이슬', category: '주류' },
  { name: '처음처럼', category: '주류' },
  { name: '카스', category: '주류' },
  { name: '하이트', category: '주류' },
  { name: '테라', category: '주류' },

  // ── 아이스크림 (5) ──
  { name: '메로나', category: '아이스크림' },
  { name: '월드콘', category: '아이스크림' },
  { name: '비비빅', category: '아이스크림' },
  { name: '죠스바', category: '아이스크림' },
  { name: '수박바', category: '아이스크림' },
];

async function main() {
  const client = await pool.connect();

  try {
    console.log('========================================');
    console.log('  인기 가공식품 100개 — 실사용 커버리지 v2');
    console.log('  (Step 9b 이후 DB 상태 반영)');
    console.log('========================================\n');

    const results = [];

    for (const item of POPULAR_PRODUCTS) {
      // products + nutrition_data + product_ingredients + product_additives JOIN
      const { rows } = await client.query(`
        SELECT p.product_id, p.product_name, p.barcode, p.manufacturer, p.is_active,
               n.calories, n.sodium, n.total_sugars, n.saturated_fat,
               pi.raw_text IS NOT NULL AS has_ingredients,
               (SELECT count(*) FROM product_additives pa WHERE pa.product_id = p.product_id) AS additive_count
        FROM products p
        LEFT JOIN nutrition_data n ON p.product_id = n.product_id
        LEFT JOIN product_ingredients pi ON p.product_id = pi.product_id
        WHERE p.product_name ILIKE '%' || $1 || '%'
          AND p.is_active = true
        ORDER BY
          CASE WHEN n.calories IS NOT NULL THEN 0 ELSE 1 END,
          length(p.product_name) ASC
        LIMIT 1
      `, [item.name]);

      // 비활성 제품도 확인
      let row = rows[0] || null;
      if (!row) {
        const { rows: inactiveRows } = await client.query(`
          SELECT p.product_id, p.product_name, p.barcode, p.manufacturer, p.is_active,
                 n.calories, n.sodium, n.total_sugars, n.saturated_fat,
                 pi.raw_text IS NOT NULL AS has_ingredients,
                 (SELECT count(*) FROM product_additives pa WHERE pa.product_id = p.product_id) AS additive_count
          FROM products p
          LEFT JOIN nutrition_data n ON p.product_id = n.product_id
          LEFT JOIN product_ingredients pi ON p.product_id = pi.product_id
          WHERE p.product_name ILIKE '%' || $1 || '%'
          ORDER BY
            CASE WHEN n.calories IS NOT NULL THEN 0 ELSE 1 END,
            length(p.product_name) ASC
          LIMIT 1
        `, [item.name]);
        row = inactiveRows[0] || null;
      }

      results.push({
        search: item.name,
        category: item.category,
        found: !!row,
        active: row?.is_active ?? false,
        barcode: row?.barcode || null,
        productName: row?.product_name || null,
        manufacturer: row?.manufacturer || null,
        hasNutrition: row?.calories !== null && row?.calories !== undefined,
        hasIngredients: row?.has_ingredients || false,
        additiveCount: parseInt(row?.additive_count) || 0,
        calories: row?.calories || null,
        sodium: row?.sodium || null,
      });
    }

    // ── 카테고리별 집계 ──
    const categories = [...new Set(POPULAR_PRODUCTS.map(p => p.category))];

    console.log('── 개별 결과 ──\n');
    for (const cat of categories) {
      const catResults = results.filter(r => r.category === cat);
      console.log(`📦 ${cat}`);
      for (const r of catResults) {
        const status = [];
        if (!r.found) { status.push('❌ 미등록'); }
        else {
          status.push(r.active ? '✅ 활성' : '⚪ 단종');
          status.push(r.barcode ? '📊바코드' : '🚫바코드없음');
          status.push(r.hasNutrition ? `🟢영양(${r.calories}kcal)` : '🔴영양없음');
          status.push(r.hasIngredients ? '🟢원재료' : '🔴원재료없음');
          status.push(r.additiveCount > 0 ? `🟢첨가물(${r.additiveCount})` : '⚪첨가물없음');
        }
        const matched = r.productName ? ` → ${r.productName}` : '';
        console.log(`  ${r.search}${matched} | ${status.join(' ')}`);
      }
      console.log('');
    }

    // ── 종합 통계 ──
    const found = results.filter(r => r.found);
    const active = results.filter(r => r.active);
    const withBarcode = results.filter(r => r.barcode);
    const withNutrition = results.filter(r => r.hasNutrition);
    const withIngredients = results.filter(r => r.hasIngredients);
    const withAdditives = results.filter(r => r.additiveCount > 0);
    const fullCoverage = results.filter(r => r.found && r.hasNutrition && r.hasIngredients);

    console.log('========================================');
    console.log('  종합 커버리지 결과');
    console.log('========================================');
    console.log(`  총 검색:              ${results.length}개`);
    console.log(`  DB 등록:              ${found.length}개 (${(found.length/results.length*100).toFixed(0)}%)`);
    console.log(`  활성 제품:            ${active.length}개 (${(active.length/results.length*100).toFixed(0)}%)`);
    console.log(`  바코드 보유:          ${withBarcode.length}개 (${(withBarcode.length/results.length*100).toFixed(0)}%)`);
    console.log(`  영양정보 보유:        ${withNutrition.length}개 (${(withNutrition.length/results.length*100).toFixed(0)}%)`);
    console.log(`  원재료 보유:          ${withIngredients.length}개 (${(withIngredients.length/results.length*100).toFixed(0)}%)`);
    console.log(`  첨가물 분석:          ${withAdditives.length}개 (${(withAdditives.length/results.length*100).toFixed(0)}%)`);
    console.log(`  완전 커버리지:        ${fullCoverage.length}개 (${(fullCoverage.length/results.length*100).toFixed(0)}%) ← 영양+원재료 모두`);

    // 카테고리별
    console.log('\n── 카테고리별 커버리지 ──');
    for (const cat of categories) {
      const catResults = results.filter(r => r.category === cat);
      const catFound = catResults.filter(r => r.found).length;
      const catNut = catResults.filter(r => r.hasNutrition).length;
      const catFull = catResults.filter(r => r.found && r.hasNutrition && r.hasIngredients).length;
      console.log(`  ${cat.padEnd(8)} | 등록: ${catFound}/${catResults.length} | 영양: ${catNut}/${catResults.length} | 완전: ${catFull}/${catResults.length}`);
    }

    console.log('\n========================================');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
