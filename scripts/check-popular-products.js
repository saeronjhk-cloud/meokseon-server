/**
 * 한국인이 많이 소비하는 가공식품 100개 — C005 + 영양성분DB 교차 매칭
 * 사용법: node scripts/check-popular-products.js
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
  '신라면', '진라면', '너구리', '안성탕면', '짜파게티',
  '불닭볶음면', '삼양라면', '팔도비빔면', '참깨라면', '육개장',

  // ── 과자/스낵 (10) ──
  '새우깡', '포카칩', '꼬깔콘', '칙촉', '오레오',
  '빼빼로', '초코파이', '에이스', '홈런볼', '감자깡',

  // ── 음료 (10) ──
  '코카콜라', '펩시', '환타', '스프라이트', '밀키스',
  '포카리스웨트', '게토레이', '2%부족할때', '비타500', '박카스',

  // ── 유제품 (10) ──
  '서울우유', '남양우유', '매일우유', '바나나맛우유',
  '떠먹는요구르트', '야쿠르트', '비요뜨', '덴마크우유',
  '앙팡우유', '남양불가리스',

  // ── 커피/차 (10) ──
  '맥심모카골드', '카누', '프렌치카페', '동서보리차',
  '립톤아이스티', '레쓰비', '조지아커피', '칸타타',
  '맥심화이트골드', '핫초코',

  // ── 빵/시리얼 (8) ──
  '삼립호빵', '샤니버터빵', '포켓몬빵', '브레드이발소',
  '첵스초코', '콘푸로스트', '프링글스', '오감자',

  // ── 냉동식품 (8) ──
  '비비고만두', '풀무원만두', '오뚜기볶음밥', '햇반',
  '피코크김밥', '냉동피자', '교촌치킨너겟', '비비고왕교자',

  // ── 소스/조미료 (8) ──
  '진간장', '맛간장', '고추장', '된장',
  '케찹', '마요네즈', '참기름', '굴소스',

  // ── 통조림/가공육 (8) ──
  '스팸', '참치캔', '꽁치캔', '비엔나소시지',
  '프랑크소시지', '런천미트', '맛살', '어묵',

  // ── 주류 (5) ──
  '참이슬', '처음처럼', '카스', '하이트', '테라',

  // ── 아이스크림 (5) ──
  '메로나', '월드콘', '비비빅', '죠스바', '수박바',

  // ── 과일주스/두유 (4) ──
  '미닛메이드', '썬키스트', '베지밀', '삼육두유',

  // ── 건강식품/기타 (4) ──
  '홍삼정', '비타민C', '프로틴바', '에너지바',
];

async function main() {
  const client = await pool.connect();

  try {
    console.log('========================================');
    console.log('  인기 가공식품 100개 — C005 + 영양성분DB 교차 매칭');
    console.log('========================================\n');

    const results = [];

    for (const name of POPULAR_PRODUCTS) {
      // ① C005 (products 테이블) 검색
      const c005 = await client.query(
        `SELECT product_name, barcode, manufacturer
         FROM products
         WHERE product_name ILIKE '%' || $1 || '%'
         ORDER BY length(product_name) ASC
         LIMIT 1`,
        [name]
      );

      // ② 영양성분DB (staging_nutrition) 검색
      const nutrition = await client.query(
        `SELECT food_nm_kr, maker_nm, calories, protein, total_fat, total_carbs, sodium
         FROM staging_nutrition
         WHERE food_nm_kr ILIKE '%' || $1 || '%'
         ORDER BY length(food_nm_kr) ASC
         LIMIT 1`,
        [name]
      );

      const c005Match = c005.rows[0] || null;
      const nutMatch = nutrition.rows[0] || null;

      results.push({
        search: name,
        c005: c005Match ? {
          name: c005Match.product_name,
          barcode: c005Match.barcode || null,
          manufacturer: c005Match.manufacturer || '',
        } : null,
        nutrition: nutMatch ? {
          name: nutMatch.food_nm_kr,
          maker: nutMatch.maker_nm || '',
          calories: nutMatch.calories,
          protein: nutMatch.protein,
          fat: nutMatch.total_fat,
          carbs: nutMatch.total_carbs,
          sodium: nutMatch.sodium,
        } : null,
      });
    }

    // ── 결과 집계 ──
    const bothFound = results.filter(r => r.c005 && r.nutrition);
    const c005Only = results.filter(r => r.c005 && !r.nutrition);
    const nutOnly = results.filter(r => !r.c005 && r.nutrition);
    const neither = results.filter(r => !r.c005 && !r.nutrition);
    const withBarcode = results.filter(r => r.c005?.barcode);

    // ── 출력 ──
    console.log('── ✅ C005 + 영양DB 모두 매칭 ──');
    for (const r of bothFound) {
      const bc = r.c005.barcode ? `[${r.c005.barcode}]` : '[바코드없음]';
      console.log(`  ${r.search} → ${r.c005.name} ${bc} | 영양: ${r.nutrition.calories}kcal`);
    }

    console.log(`\n── 🔵 C005만 매칭 (영양정보 없음) ──`);
    for (const r of c005Only) {
      const bc = r.c005.barcode ? `[${r.c005.barcode}]` : '[바코드없음]';
      console.log(`  ${r.search} → ${r.c005.name} ${bc}`);
    }

    console.log(`\n── 🟡 영양DB만 매칭 (바코드 없음) ──`);
    for (const r of nutOnly) {
      console.log(`  ${r.search} → ${r.nutrition.name} (${r.nutrition.maker}) | ${r.nutrition.calories}kcal`);
    }

    console.log(`\n── ❌ 둘 다 미발견 ──`);
    for (const r of neither) {
      console.log(`  ${r.search}`);
    }

    console.log('\n========================================');
    console.log('  종합 결과');
    console.log('========================================');
    console.log(`  총 검색:          ${results.length}개`);
    console.log(`  C005+영양 모두:   ${bothFound.length}개 (${(bothFound.length/results.length*100).toFixed(1)}%)`);
    console.log(`  C005만:           ${c005Only.length}개`);
    console.log(`  영양DB만:         ${nutOnly.length}개`);
    console.log(`  둘 다 없음:       ${neither.length}개`);
    console.log(`  바코드 보유:      ${withBarcode.length}개`);
    console.log(`  어느 하나라도:    ${results.length - neither.length}개 (${((results.length - neither.length)/results.length*100).toFixed(1)}%)`);
    console.log('========================================');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
