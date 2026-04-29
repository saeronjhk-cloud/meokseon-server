/**
 * 먹선(吃選) 인기 제품 블라인드 테스트 v1.0
 *
 * 한국 편의점/마트 매출 상위 제품 200개를 DB에서 검색하여
 * 동일한 5가지 검증을 수행합니다.
 *
 * 제품 목록 출처: 닐슨코리아 POS 매출 순위, 편의점 트렌드 리포트 등
 *
 * 사용법:
 *   node scripts/staging/blind-test-popular.js [--csv]
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

const SAVE_CSV = process.argv.includes('--csv');

// ═══════════════════════════════════════
// 한국 편의점/마트 인기 제품 200개 (카테고리별)
// ═══════════════════════════════════════
const POPULAR_PRODUCTS = [
  // ── 라면 (20개) ──
  { keyword: '신라면', category: '라면' },
  { keyword: '짜파게티', category: '라면' },
  { keyword: '진라면', category: '라면' },
  { keyword: '불닭볶음면', category: '라면' },
  { keyword: '안성탕면', category: '라면' },
  { keyword: '삼양라면', category: '라면' },
  { keyword: '너구리', category: '라면' },
  { keyword: '육개장', category: '라면' },
  { keyword: '짜왕', category: '라면' },
  { keyword: '참깨라면', category: '라면' },
  { keyword: '비빔면', category: '라면' },
  { keyword: '신라면블랙', category: '라면' },
  { keyword: '열라면', category: '라면' },
  { keyword: '사리곰탕', category: '라면' },
  { keyword: '김치라면', category: '라면' },
  { keyword: '오뚜기컵누들', category: '라면' },
  { keyword: '왕뚜껑', category: '라면' },
  { keyword: '튀김우동', category: '라면' },
  { keyword: '나가사끼', category: '라면' },
  { keyword: '무파마', category: '라면' },

  // ── 과자/스낵 (20개) ──
  { keyword: '새우깡', category: '과자' },
  { keyword: '포카칩', category: '과자' },
  { keyword: '꼬깔콘', category: '과자' },
  { keyword: '오징어땅콩', category: '과자' },
  { keyword: '초코파이', category: '과자' },
  { keyword: '빈츠', category: '과자' },
  { keyword: '칸쵸', category: '과자' },
  { keyword: '고래밥', category: '과자' },
  { keyword: '양파링', category: '과자' },
  { keyword: '꿀꽈배기', category: '과자' },
  { keyword: '홈런볼', category: '과자' },
  { keyword: '오레오', category: '과자' },
  { keyword: '빠다코코넛', category: '과자' },
  { keyword: '감자깡', category: '과자' },
  { keyword: '콘칩', category: '과자' },
  { keyword: '프링글스', category: '과자' },
  { keyword: '허니버터칩', category: '과자' },
  { keyword: '꼬북칩', category: '과자' },
  { keyword: '에이스', category: '과자' },
  { keyword: '오사쯔', category: '과자' },

  // ── 음료 (20개) ──
  { keyword: '바나나맛우유', category: '음료' },
  { keyword: '코카콜라', category: '음료' },
  { keyword: '포카리스웨트', category: '음료' },
  { keyword: '밀키스', category: '음료' },
  { keyword: '레쓰비', category: '음료' },
  { keyword: '실론티', category: '음료' },
  { keyword: '게토레이', category: '음료' },
  { keyword: '초록매실', category: '음료' },
  { keyword: '웰치스', category: '음료' },
  { keyword: '델몬트', category: '음료' },
  { keyword: '칠성사이다', category: '음료' },
  { keyword: '펩시', category: '음료' },
  { keyword: '환타', category: '음료' },
  { keyword: '아이시스', category: '음료' },
  { keyword: '제주삼다수', category: '음료' },
  { keyword: '토레타', category: '음료' },
  { keyword: '비타500', category: '음료' },
  { keyword: '핫식스', category: '음료' },
  { keyword: '맥콜', category: '음료' },
  { keyword: '써니텐', category: '음료' },

  // ── 유제품 (10개) ──
  { keyword: '서울우유', category: '유제품' },
  { keyword: '매일우유', category: '유제품' },
  { keyword: '남양우유', category: '유제품' },
  { keyword: '요플레', category: '유제품' },
  { keyword: '떠먹는불가리스', category: '유제품' },
  { keyword: '비요뜨', category: '유제품' },
  { keyword: '딸기우유', category: '유제품' },
  { keyword: '초코우유', category: '유제품' },
  { keyword: '야쿠르트', category: '유제품' },
  { keyword: '덴마크우유', category: '유제품' },

  // ── 간편식/가공식품 (15개) ──
  { keyword: '비비고만두', category: '간편식' },
  { keyword: '햇반', category: '간편식' },
  { keyword: '스팸', category: '간편식' },
  { keyword: '오뚜기카레', category: '간편식' },
  { keyword: '오뚜기3분', category: '간편식' },
  { keyword: '비비고왕교자', category: '간편식' },
  { keyword: '풀무원두부', category: '간편식' },
  { keyword: '종가집김치', category: '간편식' },
  { keyword: '동원참치', category: '간편식' },
  { keyword: '오뚜기케찹', category: '간편식' },
  { keyword: '청정원고추장', category: '간편식' },
  { keyword: '사조참치', category: '간편식' },
  { keyword: '맛있는오뚜기밥', category: '간편식' },
  { keyword: '풀무원생면', category: '간편식' },
  { keyword: '진라면컵', category: '간편식' },

  // ── 빵/디저트 (8개) ──
  { keyword: '몽쉘', category: '빵' },
  { keyword: '카스타드', category: '빵' },
  { keyword: '브라우니', category: '빵' },
  { keyword: '포켓몬빵', category: '빵' },
  { keyword: '삼립호빵', category: '빵' },
  { keyword: '로아커', category: '빵' },
  { keyword: '빅파이', category: '빵' },
  { keyword: '크라운산도', category: '빵' },

  // ── 아이스크림 (7개) ──
  { keyword: '메로나', category: '아이스크림' },
  { keyword: '비비빅', category: '아이스크림' },
  { keyword: '월드콘', category: '아이스크림' },
  { keyword: '죠스바', category: '아이스크림' },
  { keyword: '빠삐코', category: '아이스크림' },
  { keyword: '투게더', category: '아이스크림' },
  { keyword: '수박바', category: '아이스크림' },

  // ═══════════════════════════════════════
  // 추가 100개 (v2.0 확장)
  // ═══════════════════════════════════════

  // ── 라면 추가 (10개) ──
  { keyword: '팔도비빔면', category: '라면' },
  { keyword: '틈새라면', category: '라면' },
  { keyword: '오징어짬뽕', category: '라면' },
  { keyword: '감자면', category: '라면' },
  { keyword: '짜파게티범벅', category: '라면' },
  { keyword: '라면사리', category: '라면' },
  { keyword: '꼬꼬면', category: '라면' },
  { keyword: '맛있는라면', category: '라면' },
  { keyword: '콩국수', category: '라면' },
  { keyword: '칼국수', category: '라면' },

  // ── 과자 추가 (15개) ──
  { keyword: '칙촉', category: '과자' },
  { keyword: '마가렛트', category: '과자' },
  { keyword: '다이제', category: '과자' },
  { keyword: '버터링', category: '과자' },
  { keyword: '썬칩', category: '과자' },
  { keyword: '눈을감자', category: '과자' },
  { keyword: '맛동산', category: '과자' },
  { keyword: '쌀로별', category: '과자' },
  { keyword: '자갈치', category: '과자' },
  { keyword: '조리퐁', category: '과자' },
  { keyword: '카라멜콘', category: '과자' },
  { keyword: '오징어칩', category: '과자' },
  { keyword: '바나나킥', category: '과자' },
  { keyword: '부셔먹는라면', category: '과자' },
  { keyword: '빅사이즈칩', category: '과자' },

  // ── 음료 추가 (15개) ──
  { keyword: '파워에이드', category: '음료' },
  { keyword: '레드불', category: '음료' },
  { keyword: '몬스터에너지', category: '음료' },
  { keyword: '스프라이트', category: '음료' },
  { keyword: '닥터페퍼', category: '음료' },
  { keyword: '립톤', category: '음료' },
  { keyword: '오란씨', category: '음료' },
  { keyword: '헛개수', category: '음료' },
  { keyword: '솔의눈', category: '음료' },
  { keyword: '2%부족할때', category: '음료' },
  { keyword: '미닛메이드', category: '음료' },
  { keyword: '데미소다', category: '음료' },
  { keyword: '트레비', category: '음료' },
  { keyword: '백산수', category: '음료' },
  { keyword: '캔커피', category: '음료' },

  // ── 유제품 추가 (10개) ──
  { keyword: '액티비아', category: '유제품' },
  { keyword: '그릭요거트', category: '유제품' },
  { keyword: '스트링치즈', category: '유제품' },
  { keyword: '서울우유초코', category: '유제품' },
  { keyword: '남양맛있는우유', category: '유제품' },
  { keyword: '흰우유', category: '유제품' },
  { keyword: '두유', category: '유제품' },
  { keyword: '연세우유', category: '유제품' },
  { keyword: '파스퇴르', category: '유제품' },
  { keyword: '불가리스', category: '유제품' },

  // ── 간편식 추가 (15개) ──
  { keyword: '오뚜기밥', category: '간편식' },
  { keyword: '비비고국', category: '간편식' },
  { keyword: '하림닭가슴살', category: '간편식' },
  { keyword: '풀무원김치', category: '간편식' },
  { keyword: '백설', category: '간편식' },
  { keyword: '청정원', category: '간편식' },
  { keyword: '오뚜기간장', category: '간편식' },
  { keyword: '동원', category: '간편식' },
  { keyword: '진미채', category: '간편식' },
  { keyword: '떡볶이', category: '간편식' },
  { keyword: '만두', category: '간편식' },
  { keyword: '비비고죽', category: '간편식' },
  { keyword: '컵밥', category: '간편식' },
  { keyword: '냉동피자', category: '간편식' },
  { keyword: '햄버거패티', category: '간편식' },

  // ── 빵/디저트 추가 (10개) ──
  { keyword: '오예스', category: '빵' },
  { keyword: '빵또아', category: '빵' },
  { keyword: '마들렌', category: '빵' },
  { keyword: '찰떡파이', category: '빵' },
  { keyword: '쿠크다스', category: '빵' },
  { keyword: '에이스케이크', category: '빵' },
  { keyword: '치즈케이크', category: '빵' },
  { keyword: '파운드케이크', category: '빵' },
  { keyword: '롤케이크', category: '빵' },
  { keyword: '호두과자', category: '빵' },

  // ── 아이스크림 추가 (8개) ──
  { keyword: '탱크보이', category: '아이스크림' },
  { keyword: '부라보콘', category: '아이스크림' },
  { keyword: '구구콘', category: '아이스크림' },
  { keyword: '셀렉션', category: '아이스크림' },
  { keyword: '바밤바', category: '아이스크림' },
  { keyword: '폴라포', category: '아이스크림' },
  { keyword: '설레임', category: '아이스크림' },
  { keyword: '더위사냥', category: '아이스크림' },

  // ── 초콜릿/캔디 (10개) ──
  { keyword: '가나초콜릿', category: '초콜릿' },
  { keyword: '페레로로쉐', category: '초콜릿' },
  { keyword: '킨더', category: '초콜릿' },
  { keyword: '자일리톨껌', category: '초콜릿' },
  { keyword: '허쉬', category: '초콜릿' },
  { keyword: '롯데껌', category: '초콜릿' },
  { keyword: '마이쮸', category: '초콜릿' },
  { keyword: '새콤달콤', category: '초콜릿' },
  { keyword: '알프스', category: '초콜릿' },
  { keyword: '자일리톨', category: '초콜릿' },

  // ── 조미료/소스 (7개) ──
  { keyword: '다시다', category: '조미료' },
  { keyword: '미원', category: '조미료' },
  { keyword: '참기름', category: '조미료' },
  { keyword: '들기름', category: '조미료' },
  { keyword: '식초', category: '조미료' },
  { keyword: '마요네즈', category: '조미료' },
  { keyword: '머스타드', category: '조미료' },
];

// ═══════════════════════════════════════
// 영양 신호등 재계산 로직 (동일)
// ═══════════════════════════════════════
const DV = {
  calories: 2000, total_fat: 54, sat_fat: 15, cholesterol: 300,
  sodium: 2000, sugars: 100, fiber: 25, protein: 55,
};
const NEG_PCT = { green_max: 10, yellow_max: 25 };
const PER_100G = {
  sodium: { green_max: 120, yellow_max: 600 },
  sugars: { green_max: 5, yellow_max: 15 },
  sat_fat: { green_max: 1.5, yellow_max: 5 },
  total_fat: { green_max: 3, yellow_max: 17.5 },
};
const PER_100ML = {
  sodium: { green_max: 50, yellow_max: 250 },
  sugars: { green_max: 2.5, yellow_max: 6.3 },
  sat_fat: { green_max: 0.75, yellow_max: 2.5 },
  total_fat: { green_max: 1.5, yellow_max: 8.75 },
};
const TRANS = { green_max: 0, yellow_max: 0.5 };

function judgeNeg(pctDV) {
  if (pctDV == null) return null;
  if (pctDV <= NEG_PCT.green_max) return 'green';
  if (pctDV <= NEG_PCT.yellow_max) return 'yellow';
  return 'red';
}
function judgePer100(val, cutoffs) {
  if (val == null || !cutoffs) return null;
  if (val <= cutoffs.green_max) return 'green';
  if (val <= cutoffs.yellow_max) return 'yellow';
  return 'red';
}
function judgePos(pctDV) {
  if (pctDV == null) return null;
  if (pctDV < 5) return 'gray';
  if (pctDV >= 15) return 'green';
  return 'yellow';
}
function worse(a, b) {
  const rank = { red: 3, yellow: 2, green: 1, gray: 0 };
  if (!a) return b; if (!b) return a;
  return (rank[a] || 0) >= (rank[b] || 0) ? a : b;
}

function detectCategory(product) {
  const beverageTypes = ['음료류', '탄산음료', '과·채주스', '두유류', '커피', '차류', '혼합음료', '과채음료'];
  const driedTypes = ['육포', '건포류', '건과류', '김류', '장류'];
  const alcoholTypes = ['주류', '맥주', '소주', '와인', '위스키', '탁주'];
  const supplementTypes = ['건강기능식품', '영양보충용식품'];
  const nonBeverageTypes = ['유지류', '식용유지', '올리브유', '참기름', '들기름', '식초', '소스류', '드레싱', '액상차'];
  const fermentedTypes = ['김치류', '장류', '발효유류', '발효식품'];

  if (product.food_type) {
    if (alcoholTypes.some(t => product.food_type.includes(t))) return 'alcohol';
    if (supplementTypes.some(t => product.food_type.includes(t))) return 'supplement';
    if (fermentedTypes.some(t => product.food_type.includes(t))) return 'fermented';
    if (beverageTypes.some(t => product.food_type.includes(t))) return 'beverage';
    if (driedTypes.some(t => product.food_type.includes(t))) return 'dried';
  }
  if (product.content_unit) {
    const unit = product.content_unit.toLowerCase();
    if (unit === 'ml' || unit === 'l') {
      const isNonBev = product.food_type && nonBeverageTypes.some(t => product.food_type.includes(t));
      if (!isNonBev) return 'beverage';
    }
  }
  if (product.product_name) {
    const name = product.product_name;
    if (['김치', '된장', '간장', '젓갈', '청국장', '고추장'].some(k => name.includes(k))) return 'fermented';
    if (['음료', '주스', '워터', '우유', '두유', '커피', '콜라', '사이다', '에이드'].some(k => name.includes(k))) return 'beverage';
    if (['육포', '말린', '건조', '분말', '가루', '건과', '누룽지', '미역', '다시마'].some(k => name.includes(k))) return 'dried';
  }
  return 'general';
}

function recalcTrafficLight(nutrition, product) {
  const category = detectCategory(product);
  if (category === 'alcohol' || category === 'supplement') return { excluded: true, category };

  const serving = parseFloat(nutrition.serving_size) || parseFloat(product.serving_size) || 0;
  const isBeverage = category === 'beverage';
  const isDried = category === 'dried';
  const per100ref = isBeverage ? PER_100ML : PER_100G;

  const result = {};
  for (const n of ['sodium', 'sugars', 'sat_fat', 'total_fat', 'cholesterol']) {
    const val = parseFloat(nutrition[n === 'sugars' ? 'total_sugars' : n]);
    if (val == null || isNaN(val)) { result[n] = null; continue; }
    const pctDV = (val / DV[n]) * 100;
    const dvColor = judgeNeg(pctDV);
    if (isDried || !per100ref[n]) { result[n] = dvColor; }
    else {
      const per100val = serving > 0 ? (val / serving) * 100 : null;
      result[n] = worse(dvColor, judgePer100(per100val, per100ref[n]));
    }
  }
  const tf = parseFloat(nutrition.trans_fat);
  if (tf != null && !isNaN(tf)) {
    result.trans_fat = tf <= TRANS.green_max ? 'green' : tf <= TRANS.yellow_max ? 'yellow' : 'red';
  } else { result.trans_fat = null; }
  for (const n of ['protein', 'fiber']) {
    const col = n === 'fiber' ? 'dietary_fiber' : n;
    const val = parseFloat(nutrition[col]);
    if (val == null || isNaN(val)) { result[n] = null; continue; }
    result[n] = judgePos((val / DV[n]) * 100);
  }
  result.excluded = false; result.category = category;
  return result;
}

// ═══════════════════════════════════════
// 메인
// ═══════════════════════════════════════
async function main() {
  const client = await pool.connect();

  try {
    console.log('╔═══════════════════════════════════════════════════╗');
    console.log('║   먹선 인기 제품 블라인드 테스트 v1.0             ║');
    console.log('╚═══════════════════════════════════════════════════╝\n');

    // 1. 인기 제품을 DB에서 검색
    console.log(`  ⏳ 인기 제품 ${POPULAR_PRODUCTS.length}개 DB 검색 중...\n`);

    const matched = [];
    const notFound = [];

    for (const pop of POPULAR_PRODUCTS) {
      // 제품명에 키워드가 포함된 제품 중 바코드 있는 것 우선, 1건만
      const { rows } = await client.query(`
        SELECT product_id, product_name, brand, manufacturer,
               food_type, food_category, barcode,
               serving_size, serving_unit, content_unit,
               total_content, c005_report_no
        FROM products
        WHERE product_name ILIKE $1
          AND is_active = true
        ORDER BY
          CASE WHEN barcode IS NOT NULL AND barcode != '' THEN 0 ELSE 1 END,
          product_id
        LIMIT 1
      `, [`%${pop.keyword}%`]);

      if (rows.length > 0) {
        matched.push({ ...rows[0], pop_keyword: pop.keyword, pop_category: pop.category });
      } else {
        notFound.push(pop);
      }
    }

    console.log(`  DB 매칭: ${matched.length}개 / ${POPULAR_PRODUCTS.length}개`);
    if (notFound.length > 0) {
      console.log(`  미발견: ${notFound.length}개`);
      console.log(`    ${notFound.map(n => n.keyword).join(', ')}\n`);
    }

    if (matched.length === 0) {
      console.log('  ❌ 매칭된 제품이 없습니다.');
      return;
    }

    // 2. 검증 수행
    console.log(`\n  ⏳ ${matched.length}개 제품 검증 중...\n`);

    const results = [];
    let stats = {
      total: matched.length,
      hasIngredients: 0, noIngredients: 0, ingredientC002Match: 0, ingredientC002Mismatch: 0,
      hasAdditives: 0, noAdditives: 0, additiveCorrect: 0, additiveNotInText: 0,
      hasNutrition: 0, noNutrition: 0, nutritionAnomalies: 0,
      trafficLightMatch: 0, trafficLightMismatch: 0, trafficLightExcluded: 0,
      categoryMatch: 0, categoryMismatch: 0,
    };

    for (let i = 0; i < matched.length; i++) {
      const p = matched[i];
      const r = {
        product_id: p.product_id,
        product_name: p.product_name,
        pop_keyword: p.pop_keyword,
        pop_category: p.pop_category,
        brand: p.brand || '',
        manufacturer: p.manufacturer || '',
        barcode: p.barcode || '',
        issues: [],
        checks: { ingredients: '?', additives: '?', nutrition: '?', trafficLight: '?', category: '?' },
      };

      // ── 검증 1: 원재료 ──
      const { rows: ingredients } = await client.query(
        `SELECT raw_text FROM product_ingredients WHERE product_id = $1`, [p.product_id]
      );
      if (ingredients.length > 0) {
        stats.hasIngredients++;
        r.checks.ingredients = 'O';
        if (p.c005_report_no) {
          const { rows: c002 } = await client.query(
            `SELECT rawmtrl_nm FROM staging_ingredients WHERE prdlst_report_no = $1 LIMIT 1`,
            [p.c005_report_no]
          );
          if (c002.length > 0) {
            const dbText = (ingredients[0].raw_text || '').substring(0, 50).trim();
            const c002Text = (c002[0].rawmtrl_nm || '').substring(0, 50).trim();
            if (dbText && c002Text && dbText === c002Text) stats.ingredientC002Match++;
            else if (dbText && c002Text) {
              stats.ingredientC002Mismatch++;
              r.issues.push(`C002 불일치`);
            }
          }
        }
      } else {
        stats.noIngredients++;
        r.checks.ingredients = 'X';
        r.issues.push('원재료 없음');
      }

      // ── 검증 2: 첨가물 ──
      const { rows: additives } = await client.query(
        `SELECT a.name_ko FROM product_additives pa JOIN additives a ON pa.additive_id = a.additive_id WHERE pa.product_id = $1`,
        [p.product_id]
      );
      if (additives.length > 0) {
        stats.hasAdditives++;
        r.checks.additives = 'O';
        const rawText = ingredients.length > 0 ? (ingredients[0].raw_text || '') : '';
        // 전각→반각 + 공백제거 + 소문자 정규화 (식품 라벨의 다양한 표기 대응)
        const normalize = (s) => s
          .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))  // 전각→반각
          .replace(/\s+/g, '')
          .toLowerCase();
        const rawTextNorm = normalize(rawText);
        let correct = 0, notInText = 0;
        const missed = [];
        for (const add of additives) {
          const nameKoNorm = normalize(add.name_ko || '');
          if (rawTextNorm && nameKoNorm && rawTextNorm.includes(nameKoNorm)) correct++;
          else if (rawTextNorm && nameKoNorm) { notInText++; missed.push(add.name_ko); }
        }
        stats.additiveCorrect += correct;
        stats.additiveNotInText += notInText;
        if (notInText > 0) {
          r.issues.push(`첨가물 ${notInText}건 미확인: ${missed.slice(0,3).join(', ')}`);
          r.checks.additives = '△';
        }
      } else {
        stats.noAdditives++;
        r.checks.additives = '-';
      }

      // ── 검증 3: 영양정보 ──
      const { rows: nutrition } = await client.query(
        `SELECT * FROM nutrition_data WHERE product_id = $1 LIMIT 1`, [p.product_id]
      );
      if (nutrition.length > 0) {
        stats.hasNutrition++;
        r.checks.nutrition = 'O';
        const n = nutrition[0];
        const anomalies = [];
        if (n.sodium != null && parseFloat(n.sodium) > 10000) anomalies.push(`나트륨 ${n.sodium}mg`);
        if (n.calories != null && parseFloat(n.calories) <= 0) anomalies.push(`칼로리 0이하`);
        if (n.calories != null && parseFloat(n.calories) > 2000) anomalies.push(`칼로리 ${n.calories}kcal`);
        const serving = parseFloat(n.serving_size || p.serving_size) || 0;
        if (serving > 0) {
          const mass = (parseFloat(n.total_fat)||0) + (parseFloat(n.total_carbs)||0) + (parseFloat(n.protein)||0);
          if (mass > serving * 1.1 && mass > 10) anomalies.push(`질량초과(${mass.toFixed(0)}g>${serving}g)`);
        }
        if (anomalies.length > 0) {
          stats.nutritionAnomalies++;
          r.issues.push('이상치: ' + anomalies.join('; '));
          r.checks.nutrition = '△';
        }

        // ── 검증 4: 신호등 ──
        const recalc = recalcTrafficLight(n, p);
        if (recalc.excluded) { stats.trafficLightExcluded++; r.checks.trafficLight = '-'; }
        else {
          const judgments = Object.entries(recalc).filter(([k,v]) => k !== 'excluded' && k !== 'category' && v !== null);
          if (judgments.length > 0) { stats.trafficLightMatch++; r.checks.trafficLight = 'O'; }
          else { stats.trafficLightMismatch++; r.checks.trafficLight = '?'; }
          r.trafficLight = recalc;
        }
      } else {
        stats.noNutrition++;
        r.checks.nutrition = 'X';
        r.checks.trafficLight = '-';
        r.issues.push('영양정보 없음');
      }

      // ── 검증 5: 카테고리 ──
      const detected = detectCategory(p);
      const dbCat = p.food_category || 'general';
      if (detected === dbCat) { stats.categoryMatch++; r.checks.category = 'O'; }
      else {
        if (dbCat === 'general' && detected !== 'general') {
          r.checks.category = '△';
          r.issues.push(`분류: DB(${dbCat}) vs 탐지(${detected})`);
          stats.categoryMatch++;
        } else {
          stats.categoryMismatch++;
          r.checks.category = 'X';
          r.issues.push(`분류 불일치: DB(${dbCat}) vs 탐지(${detected})`);
        }
      }

      results.push(r);
      process.stdout.write(`\r  검증: ${i + 1}/${matched.length}`);
    }

    // ═══════════════════════════════════════
    // 결과 출력
    // ═══════════════════════════════════════
    console.log('\n\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  인기 제품 블라인드 테스트 결과');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log(`  검증 대상: ${stats.total}개 인기 제품 (${POPULAR_PRODUCTS.length}개 중 DB 매칭)\n`);

    // 카테고리별 커버리지
    const catStats = {};
    for (const r of results) {
      if (!catStats[r.pop_category]) catStats[r.pop_category] = { total: 0, hasIng: 0, hasNut: 0 };
      catStats[r.pop_category].total++;
      if (r.checks.ingredients === 'O') catStats[r.pop_category].hasIng++;
      if (r.checks.nutrition === 'O' || r.checks.nutrition === '△') catStats[r.pop_category].hasNut++;
    }

    console.log('  ┌─ 카테고리별 데이터 보유율 ──────────────────────────────┐');
    for (const [cat, s] of Object.entries(catStats).sort((a,b) => b[1].total - a[1].total)) {
      const ingPct = (s.hasIng / s.total * 100).toFixed(0);
      const nutPct = (s.hasNut / s.total * 100).toFixed(0);
      console.log(`  │  ${cat.padEnd(10)} ${String(s.total).padStart(3)}개 | 원재료 ${ingPct.padStart(3)}% | 영양 ${nutPct.padStart(3)}%`);
    }
    console.log('  └──────────────────────────────────────────────────────────┘\n');

    console.log('  ┌─ 1. 원재료 커버리지 ──────────────────────────┐');
    console.log(`  │  보유:  ${stats.hasIngredients}건 (${(stats.hasIngredients/stats.total*100).toFixed(1)}%)`);
    console.log(`  │  미보유: ${stats.noIngredients}건 (${(stats.noIngredients/stats.total*100).toFixed(1)}%)`);
    if (stats.ingredientC002Match + stats.ingredientC002Mismatch > 0) {
      console.log(`  │  C002 일치: ${stats.ingredientC002Match} | 불일치: ${stats.ingredientC002Mismatch}`);
    }
    console.log('  └──────────────────────────────────────────────┘\n');

    console.log('  ┌─ 2. 첨가물 탐지 ────────────────────────────┐');
    console.log(`  │  보유: ${stats.hasAdditives}건 | 없음: ${stats.noAdditives}건`);
    console.log(`  │  확인: ${stats.additiveCorrect}건 | 미확인: ${stats.additiveNotInText}건`);
    if (stats.additiveCorrect + stats.additiveNotInText > 0) {
      console.log(`  │  정확도: ${(stats.additiveCorrect/(stats.additiveCorrect+stats.additiveNotInText)*100).toFixed(1)}%`);
    }
    console.log('  └──────────────────────────────────────────────┘\n');

    console.log('  ┌─ 3. 영양정보 ───────────────────────────────┐');
    console.log(`  │  보유: ${stats.hasNutrition}건 (${(stats.hasNutrition/stats.total*100).toFixed(1)}%) | 미보유: ${stats.noNutrition}건`);
    console.log(`  │  이상치: ${stats.nutritionAnomalies}건`);
    console.log('  └──────────────────────────────────────────────┘\n');

    console.log('  ┌─ 4. 신호등 판정 ────────────────────────────┐');
    console.log(`  │  판정: ${stats.trafficLightMatch}건 | 불가: ${stats.trafficLightMismatch}건 | 제외: ${stats.trafficLightExcluded}건`);
    console.log('  └──────────────────────────────────────────────┘\n');

    console.log('  ┌─ 5. 카테고리 분류 ──────────────────────────┐');
    console.log(`  │  일치: ${stats.categoryMatch}건 | 불일치: ${stats.categoryMismatch}건`);
    console.log('  └──────────────────────────────────────────────┘\n');

    // 이슈 제품
    const issueProducts = results.filter(r => r.issues.length > 0);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  이슈 제품: ${issueProducts.length}건 / ${stats.total}건`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    for (const r of issueProducts.slice(0, 40)) {
      const checks = `[원:${r.checks.ingredients} 첨:${r.checks.additives} 영:${r.checks.nutrition} 등:${r.checks.trafficLight} 분:${r.checks.category}]`;
      console.log(`  [${r.pop_category}] ${r.product_name} (${r.pop_keyword})`);
      console.log(`    ${checks}`);
      for (const issue of r.issues) console.log(`    → ${issue}`);
      console.log('');
    }
    if (issueProducts.length > 40) console.log(`  ... 외 ${issueProducts.length - 40}건\n`);

    // 정상 제품 (이슈 없는 것)
    const cleanProducts = results.filter(r => r.issues.length === 0);
    if (cleanProducts.length > 0) {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`  무결점 제품 (${cleanProducts.length}건)`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      for (const r of cleanProducts) {
        console.log(`  [${r.pop_category}] ${r.product_name} (${r.pop_keyword}) — 모든 데이터 보유`);
      }
    }

    // 종합
    const score = (cleanProducts.length / stats.total * 100).toFixed(1);
    const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D';
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  종합 무결점 비율: ${cleanProducts.length}/${stats.total} (${score}%)`);
    console.log(`  등급: ${grade}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // CSV
    if (SAVE_CSV) {
      const csvPath = path.join(__dirname, 'blind-test-popular-results.csv');
      const lines = ['pop_keyword,pop_category,product_name,barcode,ingredients,additives,nutrition,traffic_light,category,issues'];
      for (const r of results) {
        const issues = r.issues.join(' | ').replace(/"/g, "'");
        lines.push(`"${r.pop_keyword}","${r.pop_category}","${r.product_name}","${r.barcode}",${r.checks.ingredients},${r.checks.additives},${r.checks.nutrition},${r.checks.trafficLight},${r.checks.category},"${issues}"`);
      }
      // 미발견 제품도 추가
      for (const nf of notFound) {
        lines.push(`"${nf.keyword}","${nf.category}","[DB 미발견]","",X,X,X,X,X,"DB에서 제품을 찾을 수 없음"`);
      }
      fs.writeFileSync(csvPath, '﻿' + lines.join('\n'), 'utf-8');
      console.log(`  📄 CSV: ${csvPath}`);
    }

    const jsonPath = path.join(__dirname, 'blind-test-popular-results.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ stats, results, notFound, timestamp: new Date().toISOString() }, null, 2), 'utf-8');
    console.log(`  📄 JSON: ${jsonPath}`);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
