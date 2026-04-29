/**
 * Step 9: 영양강화제 추가 등록 + 블라인드 테스트 미확인 원인 진단
 *
 * 1. 블라인드 테스트에서 미확인된 4건의 실제 원인 진단
 * 2. 식품 라벨에 자주 등장하는 영양강화제 별칭 추가 등록
 * 3. 미네랄류 영양강화제 추가 등록
 *
 * 사용법: node scripts/merge/09-add-nutritional-fortifiers.js
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

// ═══════════════════════════════════════
// 추가할 영양강화제 목록
// ═══════════════════════════════════════
const FORTIFIERS = [
  // ── 비타민 별칭 (식품 라벨에 자주 등장하는 이름) ──
  { name_ko: '리보플라빈', name_en: 'Riboflavin', category: '영양강화제', description: '비타민B2의 화학명. 식품 라벨에서 자주 사용.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '티아민', name_en: 'Thiamine', category: '영양강화제', description: '비타민B1의 화학명.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '티아민염산염', name_en: 'Thiamine Hydrochloride', category: '영양강화제', description: '비타민B1 형태. 식품 라벨에서 자주 사용.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '아스코르빈산', name_en: 'Ascorbic Acid', category: '영양강화제', description: '비타민C의 화학명. 항산화제로도 사용.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '아스코르빈산나트륨', name_en: 'Sodium Ascorbate', category: '영양강화제', description: '비타민C 나트륨 염.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '니코틴산아미드', name_en: 'Nicotinamide', category: '영양강화제', description: '니아신(비타민B3)의 아미드 형태.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '니아신', name_en: 'Niacin', category: '영양강화제', description: '비타민B3. 니코틴산이라고도 함.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '니아신아미드', name_en: 'Niacinamide', category: '영양강화제', description: '니코틴산아미드의 다른 이름.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '나이아신', name_en: 'Niacin', category: '영양강화제', description: '니아신의 다른 표기법.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '피리독신염산염', name_en: 'Pyridoxine Hydrochloride', category: '영양강화제', description: '비타민B6 형태. 식품 라벨에서 자주 사용.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '피리독신', name_en: 'Pyridoxine', category: '영양강화제', description: '비타민B6의 화학명.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '시아노코발라민', name_en: 'Cyanocobalamin', category: '영양강화제', description: '비타민B12의 화학명.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '레티놀', name_en: 'Retinol', category: '영양강화제', description: '비타민A의 화학명.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '레티닐아세테이트', name_en: 'Retinyl Acetate', category: '영양강화제', description: '비타민A 에스테르 형태.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '레티닐팔미테이트', name_en: 'Retinyl Palmitate', category: '영양강화제', description: '비타민A 팔미테이트.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '에르고칼시페롤', name_en: 'Ergocalciferol', category: '영양강화제', description: '비타민D2의 화학명.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '베타카로틴', name_en: 'Beta-Carotene', category: '영양강화제', description: '비타민A 전구체. 착색료로도 사용.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '알파토코페롤', name_en: 'Alpha-Tocopherol', category: '영양강화제', description: '비타민E의 가장 활성적 형태.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '비타민B1', name_en: 'Vitamin B1', category: '영양강화제', description: '티아민. 접미사 없이 단독으로 표기되기도 함.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '비타민B6', name_en: 'Vitamin B6', category: '영양강화제', description: '피리독신. 접미사 없이 단독으로 표기되기도 함.', risk_color: 'green', risk_grade: 0 },

  // ── 미네랄류 영양강화제 ──
  { name_ko: '황산제일철', name_en: 'Ferrous Sulfate', category: '영양강화제', description: '철분 보충제. 영아용·건강기능식품에 사용.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '글루콘산철', name_en: 'Ferrous Gluconate', category: '영양강화제', description: '철분 보충제.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '구연산철', name_en: 'Ferric Citrate', category: '영양강화제', description: '철분 보충제.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '피로인산철', name_en: 'Ferric Pyrophosphate', category: '영양강화제', description: '철분 보충제.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '산화아연', name_en: 'Zinc Oxide', category: '영양강화제', description: '아연 보충제.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '글루콘산아연', name_en: 'Zinc Gluconate', category: '영양강화제', description: '아연 보충제.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '황산아연', name_en: 'Zinc Sulfate', category: '영양강화제', description: '아연 보충제.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '탄산칼슘', name_en: 'Calcium Carbonate', category: '영양강화제', description: '칼슘 보충제. 식품에 가장 널리 사용되는 칼슘원.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '구연산칼슘', name_en: 'Calcium Citrate', category: '영양강화제', description: '칼슘 보충제.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '인산칼슘', name_en: 'Calcium Phosphate', category: '영양강화제', description: '칼슘·인 보충제.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '글루콘산칼슘', name_en: 'Calcium Gluconate', category: '영양강화제', description: '칼슘 보충제.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '젖산칼슘', name_en: 'Calcium Lactate', category: '영양강화제', description: '칼슘 보충제.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '산화마그네슘', name_en: 'Magnesium Oxide', category: '영양강화제', description: '마그네슘 보충제.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '셀레늄', name_en: 'Selenium', category: '영양강화제', description: '필수 미량 미네랄.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '셀렌산나트륨', name_en: 'Sodium Selenate', category: '영양강화제', description: '셀레늄 보충제.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '요오드칼륨', name_en: 'Potassium Iodide', category: '영양강화제', description: '요오드 보충제.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '황산망간', name_en: 'Manganese Sulfate', category: '영양강화제', description: '망간 보충제.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '황산구리', name_en: 'Copper Sulfate', category: '영양강화제', description: '구리 보충제.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '염화칼륨', name_en: 'Potassium Chloride', category: '영양강화제', description: '칼륨 보충제. 저나트륨 소금 대체제로도 사용.', risk_color: 'green', risk_grade: 0 },

  // ── 기타 영양 성분 ──
  { name_ko: '타우린', name_en: 'Taurine', category: '영양강화제', description: '아미노산 유도체. 에너지 음료에 사용.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '이노시톨', name_en: 'Inositol', category: '영양강화제', description: '비타민B군 유사 영양소.', risk_color: 'green', risk_grade: 0 },
  { name_ko: 'L-카르니틴', name_en: 'L-Carnitine', category: '영양강화제', description: '아미노산 유도체. 에너지 대사 관여.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '콜린', name_en: 'Choline', category: '영양강화제', description: '필수 영양소. 간 기능 관여.', risk_color: 'green', risk_grade: 0 },
  { name_ko: '카제인나트륨', name_en: 'Sodium Caseinate', category: '영양강화제', description: '유단백 영양강화제.', risk_color: 'green', risk_grade: 0 },
];


async function main() {
  const client = await pool.connect();

  try {
    console.log('═══════════════════════════════════════════════════');
    console.log('  Step 9: 영양강화제 추가 등록');
    console.log('═══════════════════════════════════════════════════\n');

    // ── 1. 현재 DB 상태 확인 ──
    const { rows: existing } = await client.query(
      `SELECT name_ko, name_en, category FROM additives ORDER BY name_ko`
    );
    const existingSet = new Set(existing.map(r => r.name_ko.replace(/\s+/g, '').toLowerCase()));
    console.log(`  현재 additives 테이블: ${existing.length}건\n`);

    // 영양강화제 카테고리 현황
    const vitaminCount = existing.filter(r => /비타민|vitamin|엽산|니아신|리보플라빈|티아민|판토텐|비오틴|토코페롤|아스코르빈산|칼시페롤|영양강화/i.test(r.name_ko || r.category || '')).length;
    console.log(`  기존 비타민/영양강화제 관련: ${vitaminCount}건\n`);

    // ── 2. 블라인드 테스트 미확인 4건 원인 진단 ──
    console.log('─── 블라인드 테스트 미확인 4건 진단 ───\n');

    const diagTargets = [
      { product: '신라면', additiveName: '비타민B2', productId: '12' },
      { product: '무파마탕면', additiveName: '비타민B2', productId: '451' },
      { product: '에이스', additiveName: '비타민B1염산염', productId: '90' },
      { product: '핫식스', additiveName: '비타민C', productId: '24225' },
    ];

    for (const t of diagTargets) {
      // 원재료 텍스트 확인
      const { rows: ingr } = await client.query(
        `SELECT raw_text FROM product_ingredients WHERE product_id = $1 LIMIT 1`,
        [t.productId]
      );
      const rawText = ingr.length > 0 ? ingr[0].raw_text : '(없음)';

      // additive DB에 있는지 확인
      const { rows: addCheck } = await client.query(
        `SELECT additive_id, name_ko FROM additives WHERE LOWER(REPLACE(name_ko, ' ', '')) = LOWER(REPLACE($1, ' ', ''))`,
        [t.additiveName]
      );

      // product_additives에 연결되어 있는지 확인
      const { rows: paCheck } = await client.query(
        `SELECT pa.additive_id, a.name_ko FROM product_additives pa JOIN additives a ON pa.additive_id = a.additive_id WHERE pa.product_id = $1`,
        [t.productId]
      );

      const inDB = addCheck.length > 0 ? '✅ 등록됨' : '❌ 미등록';
      const inPA = paCheck.find(p => p.name_ko.replace(/\s+/g, '').toLowerCase() === t.additiveName.replace(/\s+/g, '').toLowerCase())
        ? '✅ 연결됨' : '❌ 미연결';

      // 원문에서 매칭 테스트
      const normalized = t.additiveName.replace(/\s+/g, '').toLowerCase();
      const rawLower = (rawText || '').toLowerCase();
      const rawNormalized = rawLower.replace(/\s+/g, '');
      const simpleMatch = rawLower.includes(normalized) ? '✅' : '❌';
      const normalizedMatch = rawNormalized.includes(normalized) ? '✅' : '❌';

      console.log(`  [${t.product}] "${t.additiveName}"`);
      console.log(`    사전 등록: ${inDB} | product_additives: ${inPA}`);
      console.log(`    단순매칭(.includes): ${simpleMatch} | 정규화매칭(공백제거): ${normalizedMatch}`);
      if (rawText !== '(없음)') {
        // 해당 첨가물 이름이 원문에서 어떤 형태로 나오는지 찾기
        const searchTerms = [t.additiveName, t.additiveName.replace(/B/gi, 'b'), t.additiveName.replace(/\d/g, '')];
        for (const term of searchTerms) {
          const idx = rawLower.indexOf(term.toLowerCase());
          if (idx >= 0) {
            const context = rawText.substring(Math.max(0, idx - 10), idx + term.length + 10);
            console.log(`    원문 발견: "...${context}..."`);
            break;
          }
        }
      }
      console.log('');
    }

    // ── 3. 신규 영양강화제 등록 ──
    console.log('─── 영양강화제 신규 등록 ───\n');

    let added = 0, skipped = 0;
    const addedList = [];
    const skippedList = [];

    for (const f of FORTIFIERS) {
      const normalizedName = f.name_ko.replace(/\s+/g, '').toLowerCase();

      if (existingSet.has(normalizedName)) {
        skipped++;
        skippedList.push(f.name_ko);
        continue;
      }

      await client.query(`
        INSERT INTO additives (name_ko, name_en, risk_grade, risk_color, category, description)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT DO NOTHING
      `, [f.name_ko, f.name_en, f.risk_grade, f.risk_color, f.category, f.description]);

      added++;
      addedList.push(f.name_ko);
      existingSet.add(normalizedName);
    }

    console.log(`  추가 등록: ${added}건`);
    if (addedList.length > 0) {
      console.log(`  등록된 항목:`);
      for (const name of addedList) {
        console.log(`    ✅ ${name}`);
      }
    }
    console.log(`\n  이미 존재 (스킵): ${skipped}건`);
    if (skippedList.length > 0) {
      console.log(`  스킵된 항목: ${skippedList.join(', ')}`);
    }

    // ── 4. 최종 현황 ──
    const { rows: [{ count: finalCount }] } = await client.query('SELECT count(*) FROM additives');
    const { rows: [{ count: fortifierCount }] } = await client.query(
      `SELECT count(*) FROM additives WHERE category = '영양강화제'`
    );

    console.log('\n═══════════════════════════════════════════════════');
    console.log(`  ✅ 완료!`);
    console.log(`  additives 전체: ${finalCount}건`);
    console.log(`  영양강화제 카테고리: ${fortifierCount}건`);
    console.log('═══════════════════════════════════════════════════');

    // ── 5. Step 4 재파싱 필요 여부 안내 ──
    if (added > 0) {
      console.log('\n  ⚠️ 참고: 신규 등록된 영양강화제를 기존 제품에 매칭하려면');
      console.log('  Step 4 (원재료 파싱)를 재실행해야 합니다:');
      console.log('    node scripts/merge/04-parse-ingredients.js');
      console.log('  (원재료 텍스트가 있는 제품만 대상, 기존 매칭은 유지됨)');
    }

  } catch (err) {
    console.error('❌ 오류:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
