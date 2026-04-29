/**
 * 먹선(吃選) 공공데이터 병합 파이프라인
 *
 * Layer 1: C005 바코드연계제품정보 + 식약처 영양성분 DB 병합
 *
 * 처리 흐름:
 * 1. C005 엑셀 로드 → 제품 기본정보 (바코드, 제품명, 제조사, 식품유형)
 * 2. 영양성분 DB 엑셀 로드 → 영양정보 (칼로리, 나트륨, 당류 등)
 * 3. 제품명+제조사 퍼지 매칭으로 두 DB 병합
 * 4. 자체 DB 형식으로 변환 및 저장
 *
 * 사용법:
 *   node scripts/data-pipeline/mergePublicData.js \
 *     --c005 ./data/c005_barcode.xlsx \
 *     --nutrition ./data/nutrition_db.xlsx \
 *     --output ./data/merged_products.json
 */

const fs = require('fs');
const path = require('path');

// ============================================================
// 1. 텍스트 정규화 (퍼지 매칭 전처리)
// ============================================================

/**
 * 제품명 정규화: 매칭 정확도를 높이기 위한 전처리
 */
function normalizeName(name) {
  if (!name) return '';
  return name
    .trim()
    .replace(/\s+/g, ' ')              // 다중 공백 → 단일 공백
    .replace(/[()（）\[\]【】]/g, '')     // 괄호 제거
    .replace(/[,，·•]/g, ' ')           // 구분자 → 공백
    .replace(/\d+\s*[gG][rR]?/g, '')     // 중량 제거 (100g, 250 G 등)
    .replace(/\d+\s*[mM][lL]/g, '')     // 용량 제거 (250ml, 500 mL 등)
    .replace(/\d+\s*[kK][gG]/g, '')     // kg 제거
    .replace(/\d+\s*[lL]/g, '')         // L 제거
    .replace(/\s+/g, ' ')              // 다시 정규화
    .trim()
    .toLowerCase();
}

/**
 * 제조사명 정규화
 */
function normalizeManufacturer(name) {
  if (!name) return '';
  return name
    .trim()
    .replace(/\(주\)/g, '')
    .replace(/주식회사/g, '')
    .replace(/㈜/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

// ============================================================
// 2. 유사도 계산 (Trigram 기반)
// ============================================================

/**
 * 두 문자열의 trigram 집합을 구한다.
 */
function getTrigrams(str) {
  const padded = `  ${str} `;
  const trigrams = new Set();
  for (let i = 0; i < padded.length - 2; i++) {
    trigrams.add(padded.substring(i, i + 3));
  }
  return trigrams;
}

/**
 * Trigram 기반 유사도 계산 (0~1)
 */
function trigramSimilarity(a, b) {
  if (!a || !b) return 0;
  const triA = getTrigrams(a);
  const triB = getTrigrams(b);

  let intersection = 0;
  for (const tri of triA) {
    if (triB.has(tri)) intersection++;
  }

  const union = triA.size + triB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 제품명에서 용량 정보를 추출합니다 (Gemini 피드백: 하드 리젝트)
 * @returns {string|null} 정규화된 용량 문자열 (예: "355ml", "1500ml", "500g")
 */
function extractVolume(name) {
  if (!name) return null;
  const match = name.match(/(\d+[\.,]?\d*)\s*(ml|mL|ML|l|L|g|G|kg|KG)/i);
  if (!match) return null;

  let value = parseFloat(match[1].replace(',', '.'));
  let unit = match[2].toLowerCase();

  // 단위 통일 (L→ml, kg→g)
  if (unit === 'l') { value *= 1000; unit = 'ml'; }
  if (unit === 'kg') { value *= 1000; unit = 'g'; }

  return `${value}${unit}`;
}

/**
 * 복합 유사도: 제품명 70% + 제조사 30%
 * + 용량/제조사 하드 리젝트 (Gemini 피드백)
 */
function compositeSimilarity(c005Product, nutritionProduct) {
  const nameSim = trigramSimilarity(
    normalizeName(c005Product.product_name),
    normalizeName(nutritionProduct.product_name)
  );

  const mfgSim = trigramSimilarity(
    normalizeManufacturer(c005Product.manufacturer),
    normalizeManufacturer(nutritionProduct.manufacturer)
  );

  const score = nameSim * 0.7 + mfgSim * 0.3;

  // ── 하드 리젝트: 용량 불일치 (Gemini 피드백) ──
  const vol1 = extractVolume(c005Product.product_name);
  const vol2 = extractVolume(nutritionProduct.product_name);
  if (vol1 && vol2 && vol1 !== vol2) {
    return 0; // 용량이 다르면 유사도 0 반환 (매칭 거부)
  }

  // ── 하드 리젝트: 제조사 불일치 (Gemini 피드백) ──
  const mfg1 = normalizeManufacturer(c005Product.manufacturer);
  const mfg2 = normalizeManufacturer(nutritionProduct.manufacturer);
  if (mfg1 && mfg2 && mfg1.length > 1 && mfg2.length > 1 && mfgSim < 0.3) {
    return 0; // 제조사가 명확히 다르면 매칭 거부
  }

  return score;
}

// ============================================================
// 3. C005 데이터 파서
// ============================================================

/**
 * C005 바코드연계제품정보 레코드를 표준 형식으로 변환
 */
function parseC005Record(row) {
  return {
    barcode: row['유통바코드'] || row['BRCD_NO'] || null,
    product_name: row['제품명'] || row['PRDLST_NM'] || '',
    manufacturer: row['제조사명'] || row['BSSH_NM'] || '',
    food_type: row['식품유형'] || row['PRDLST_DCNM'] || '',
    report_no: row['품목보고번호'] || row['PRDLST_REPORT_NO'] || '',
    serving_size: parseFloat(row['1회제공량']) || null,
    total_content: parseFloat(row['내용량']) || null,
    content_unit: row['내용량단위'] || 'g',
  };
}

// ============================================================
// 4. 영양성분 DB 파서
// ============================================================

/**
 * 식약처 영양성분 DB 레코드를 표준 형식으로 변환
 */
function parseNutritionRecord(row) {
  return {
    food_cd: row['식품코드'] || row['FOOD_CD'] || '',
    product_name: row['식품명'] || row['FOOD_NM_KR'] || '',
    manufacturer: row['제조사명'] || row['MAKER_NM'] || '',
    food_type: row['식품대분류'] || '',
    serving_size: parseFloat(row['1회제공량']) || parseFloat(row['SERVING_SIZE']) || 100,
    nutrition: {
      calories: parseFloat(row['에너지(kcal)'] || row['AMT_NUM1']) || null,
      protein: parseFloat(row['단백질(g)'] || row['AMT_NUM3']) || null,
      total_fat: parseFloat(row['지방(g)'] || row['AMT_NUM4']) || null,
      total_carbs: parseFloat(row['탄수화물(g)'] || row['AMT_NUM6']) || null,
      total_sugars: parseFloat(row['당류(g)'] || row['AMT_NUM7']) || null,
      sodium: parseFloat(row['나트륨(mg)'] || row['AMT_NUM13']) || null,
      cholesterol: parseFloat(row['콜레스테롤(mg)'] || row['AMT_NUM10']) || null,
      saturated_fat: parseFloat(row['포화지방산(g)'] || row['AMT_NUM11']) || null,
      trans_fat: parseFloat(row['트랜스지방(g)'] || row['AMT_NUM12']) || null,
      dietary_fiber: parseFloat(row['식이섬유(g)'] || row['AMT_NUM8']) || null,
    },
  };
}

// ============================================================
// 5. 병합 엔진
// ============================================================

/**
 * C005 데이터와 영양성분 DB를 퍼지 매칭으로 병합한다.
 *
 * @param {Array} c005Data - C005 레코드 배열
 * @param {Array} nutritionData - 영양성분 DB 레코드 배열
 * @param {Object} options - { minSimilarity: 0.6 }
 * @returns {Object} { matched, c005Only, nutritionOnly, stats }
 */
function mergeDatasets(c005Data, nutritionData, options = {}) {
  const minSimilarity = options.minSimilarity || 0.6;

  const matched = [];
  const c005Only = [];
  const matchedNutritionIndices = new Set();

  console.log(`\n🔄 병합 시작: C005 ${c005Data.length}건 × 영양DB ${nutritionData.length}건`);
  console.log(`   최소 유사도: ${minSimilarity}`);

  // 진행률 표시
  let processed = 0;
  const total = c005Data.length;
  const logInterval = Math.max(1, Math.floor(total / 20));

  for (let i = 0; i < c005Data.length; i++) {
    const c005 = c005Data[i];
    let bestMatch = null;
    let bestScore = 0;
    let bestIndex = -1;

    for (let j = 0; j < nutritionData.length; j++) {
      if (matchedNutritionIndices.has(j)) continue;

      const score = compositeSimilarity(c005, nutritionData[j]);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = nutritionData[j];
        bestIndex = j;
      }
    }

    if (bestScore >= minSimilarity && bestMatch) {
      matchedNutritionIndices.add(bestIndex);
      matched.push({
        // 제품 기본정보 (C005)
        barcode: c005.barcode,
        product_name: c005.product_name,
        manufacturer: c005.manufacturer,
        food_type: c005.food_type,
        report_no: c005.report_no,
        serving_size: c005.serving_size || bestMatch.serving_size,
        total_content: c005.total_content,
        content_unit: c005.content_unit,
        // 영양정보 (영양성분 DB)
        nutrition: bestMatch.nutrition,
        public_food_cd: bestMatch.food_cd,
        // 매칭 메타데이터
        data_source: 'public_merged',
        match_score: Math.round(bestScore * 1000) / 1000,
        match_nutrition_name: bestMatch.product_name,
      });
    } else {
      c005Only.push({
        barcode: c005.barcode,
        product_name: c005.product_name,
        manufacturer: c005.manufacturer,
        food_type: c005.food_type,
        report_no: c005.report_no,
        serving_size: c005.serving_size,
        total_content: c005.total_content,
        content_unit: c005.content_unit,
        data_source: 'public_c005',
        nutrition: null,
      });
    }

    processed++;
    if (processed % logInterval === 0) {
      const pct = Math.round((processed / total) * 100);
      process.stdout.write(`\r   진행: ${pct}% (${processed}/${total})`);
    }
  }

  // 영양DB에만 있는 제품
  const nutritionOnly = nutritionData
    .filter((_, idx) => !matchedNutritionIndices.has(idx))
    .map(n => ({
      barcode: null,
      product_name: n.product_name,
      manufacturer: n.manufacturer,
      food_type: n.food_type,
      serving_size: n.serving_size,
      nutrition: n.nutrition,
      public_food_cd: n.food_cd,
      data_source: 'public_nutrition',
    }));

  const stats = {
    total_c005: c005Data.length,
    total_nutrition: nutritionData.length,
    matched: matched.length,
    c005_only: c005Only.length,
    nutrition_only: nutritionOnly.length,
    match_rate_c005: `${Math.round((matched.length / c005Data.length) * 100)}%`,
    avg_match_score: matched.length > 0
      ? Math.round(matched.reduce((sum, m) => sum + m.match_score, 0) / matched.length * 1000) / 1000
      : 0,
  };

  console.log('\n\n📊 병합 결과:');
  console.log(`   매칭 성공: ${stats.matched}건 (${stats.match_rate_c005})`);
  console.log(`   C005만: ${stats.c005_only}건 (영양정보 없음)`);
  console.log(`   영양DB만: ${stats.nutrition_only}건 (바코드 없음)`);
  console.log(`   평균 매칭 점수: ${stats.avg_match_score}`);

  return { matched, c005Only, nutritionOnly, stats };
}

// ============================================================
// 6. SQL INSERT 생성기
// ============================================================

/**
 * 병합 결과를 PostgreSQL INSERT 문으로 변환한다.
 */
function generateInsertSQL(mergedProducts) {
  const { detectFoodCategory } = require('../../src/services/nutritionTrafficLight');

  const lines = [];
  lines.push('-- 자동 생성된 공공데이터 INSERT문');
  lines.push(`-- 생성일: ${new Date().toISOString()}`);
  lines.push('');

  for (const p of mergedProducts) {
    const escapeSql = (v) => v ? `'${String(v).replace(/'/g, "''")}'` : 'NULL';
    const numOrNull = (v) => (v !== null && v !== undefined && !isNaN(v)) ? v : 'NULL';

    // 카테고리 자동 감지
    const category = detectFoodCategory({
      product_name: p.product_name,
      food_type: p.food_type,
      content_unit: p.content_unit,
    });

    // products 테이블
    lines.push(`INSERT INTO products (barcode, product_name, brand, manufacturer, food_type, food_category, serving_size, total_content, content_unit, data_source, c005_report_no, public_food_cd)`);
    lines.push(`VALUES (${escapeSql(p.barcode)}, ${escapeSql(p.product_name)}, NULL, ${escapeSql(p.manufacturer)}, ${escapeSql(p.food_type)}, '${category}', ${numOrNull(p.serving_size)}, ${numOrNull(p.total_content)}, ${escapeSql(p.content_unit)}, '${p.data_source === 'public_merged' ? 'public_c005' : p.data_source}', ${escapeSql(p.report_no)}, ${escapeSql(p.public_food_cd)})`);
    lines.push(`ON CONFLICT (barcode) DO UPDATE SET updated_at = NOW();`);

    // nutrition_data 테이블 (영양정보가 있는 경우)
    if (p.nutrition) {
      const n = p.nutrition;
      lines.push(`INSERT INTO nutrition_data (product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein, data_source)`);
      lines.push(`VALUES (currval('products_product_id_seq'), ${numOrNull(n.calories)}, ${numOrNull(n.total_fat)}, ${numOrNull(n.saturated_fat)}, ${numOrNull(n.trans_fat)}, ${numOrNull(n.cholesterol)}, ${numOrNull(n.sodium)}, ${numOrNull(n.total_carbs)}, ${numOrNull(n.total_sugars)}, ${numOrNull(n.dietary_fiber)}, ${numOrNull(n.protein)}, '${p.data_source === 'public_merged' ? 'public_nutrition' : p.data_source}');`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================
// 7. 데모: 샘플 데이터로 파이프라인 테스트
// ============================================================

function runDemo() {
  console.log('═══════════════════════════════════════');
  console.log('  먹선 공공데이터 병합 파이프라인 데모');
  console.log('═══════════════════════════════════════');

  // 샘플 C005 데이터
  const sampleC005 = [
    { product_name: '새우깡', manufacturer: '(주)농심', food_type: '과자', barcode: '8801043012607', report_no: 'R001', serving_size: 30, total_content: 90, content_unit: 'g' },
    { product_name: '신라면', manufacturer: '(주)농심', food_type: '유탕면류', barcode: '8801043032704', report_no: 'R002', serving_size: 120, total_content: 120, content_unit: 'g' },
    { product_name: '코카콜라 제로', manufacturer: '한국코카콜라(주)', food_type: '탄산음료', barcode: '8806007045052', report_no: 'R003', serving_size: 250, total_content: 500, content_unit: 'ml' },
    { product_name: '서울우유 1급A', manufacturer: '서울우유협동조합', food_type: '우유류', barcode: '8801115112006', report_no: 'R004', serving_size: 200, total_content: 1000, content_unit: 'ml' },
    { product_name: '풀무원 두부', manufacturer: '(주)풀무원', food_type: '두부류', barcode: '8801069123456', report_no: 'R005', serving_size: 100, total_content: 300, content_unit: 'g' },
    { product_name: '비비고 왕교자', manufacturer: 'CJ제일제당(주)', food_type: '만두류', barcode: '8801007654321', report_no: 'R006', serving_size: 120, total_content: 350, content_unit: 'g' },
  ];

  // 샘플 영양성분 DB
  const sampleNutrition = [
    { product_name: '새우깡(스낵)', manufacturer: '농심', food_cd: 'N001', serving_size: 30,
      nutrition: { calories: 140, protein: 2, total_fat: 7, total_carbs: 18, total_sugars: 2, sodium: 200, cholesterol: 5, saturated_fat: 1.5, trans_fat: 0, dietary_fiber: 0.5 }},
    { product_name: '신라면(유탕면)', manufacturer: '농심', food_cd: 'N002', serving_size: 120,
      nutrition: { calories: 500, protein: 10, total_fat: 16, total_carbs: 78, total_sugars: 4, sodium: 1790, cholesterol: 0, saturated_fat: 7, trans_fat: 0, dietary_fiber: 3 }},
    { product_name: '코카콜라제로 500mL', manufacturer: '코카콜라', food_cd: 'N003', serving_size: 250,
      nutrition: { calories: 0, protein: 0, total_fat: 0, total_carbs: 0, total_sugars: 0, sodium: 25, cholesterol: 0, saturated_fat: 0, trans_fat: 0, dietary_fiber: 0 }},
    { product_name: '서울우유', manufacturer: '서울우유', food_cd: 'N004', serving_size: 200,
      nutrition: { calories: 130, protein: 6, total_fat: 7, total_carbs: 10, total_sugars: 9, sodium: 100, cholesterol: 25, saturated_fat: 4.5, trans_fat: 0.2, dietary_fiber: 0 }},
    { product_name: '한모 두부', manufacturer: '풀무원', food_cd: 'N005', serving_size: 100,
      nutrition: { calories: 84, protein: 9, total_fat: 4.5, total_carbs: 2, total_sugars: 0.5, sodium: 5, cholesterol: 0, saturated_fat: 0.7, trans_fat: 0, dietary_fiber: 0.3 }},
    { product_name: '비비고왕교자만두', manufacturer: 'CJ제일제당', food_cd: 'N006', serving_size: 120,
      nutrition: { calories: 240, protein: 9, total_fat: 8, total_carbs: 32, total_sugars: 3, sodium: 480, cholesterol: 20, saturated_fat: 2.5, trans_fat: 0, dietary_fiber: 2 }},
    // 영양DB에만 있는 제품
    { product_name: '참치캔(동원)', manufacturer: '동원F&B', food_cd: 'N007', serving_size: 100,
      nutrition: { calories: 180, protein: 22, total_fat: 10, total_carbs: 0, total_sugars: 0, sodium: 400, cholesterol: 45, saturated_fat: 2, trans_fat: 0, dietary_fiber: 0 }},
  ];

  // 병합 실행
  const result = mergeDatasets(sampleC005, sampleNutrition, { minSimilarity: 0.4 });

  // 매칭 상세 결과
  console.log('\n📋 매칭 상세:');
  for (const m of result.matched) {
    console.log(`   ${m.product_name} ↔ ${m.match_nutrition_name} (점수: ${m.match_score})`);
  }

  // SQL 생성
  const allProducts = [...result.matched, ...result.c005Only, ...result.nutritionOnly];
  const sql = generateInsertSQL(allProducts);

  // 파일 저장
  const outputDir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  fs.writeFileSync(path.join(outputDir, 'merged_products.json'), JSON.stringify(allProducts, null, 2));
  fs.writeFileSync(path.join(outputDir, 'merged_insert.sql'), sql);

  console.log(`\n💾 저장 완료:`);
  console.log(`   JSON: data/merged_products.json`);
  console.log(`   SQL:  data/merged_insert.sql`);

  // 영양 신호등 판정 시연
  console.log('\n\n═══════════════════════════════════════');
  console.log('  매칭된 제품 영양 신호등 판정 시연');
  console.log('═══════════════════════════════════════');

  const { evaluateNutrition, formatResult } = require('../../src/services/nutritionTrafficLight');

  for (const product of result.matched.slice(0, 4)) {
    const evalResult = evaluateNutrition(
      {
        product_name: product.product_name,
        food_type: product.food_type,
        content_unit: product.content_unit,
        serving_size: product.serving_size,
        total_content: product.total_content,
      },
      {
        calories: product.nutrition.calories,
        sodium: product.nutrition.sodium,
        sugars: product.nutrition.total_sugars,
        sat_fat: product.nutrition.saturated_fat,
        total_fat: product.nutrition.total_fat,
        cholesterol: product.nutrition.cholesterol,
        protein: product.nutrition.protein,
        fiber: product.nutrition.dietary_fiber,
        trans_fat: product.nutrition.trans_fat,
      }
    );
    console.log(formatResult(evalResult));
  }

  return result.stats;
}

// ============================================================
// Exports & CLI
// ============================================================

module.exports = {
  normalizeName,
  normalizeManufacturer,
  trigramSimilarity,
  compositeSimilarity,
  mergeDatasets,
  generateInsertSQL,
  parseC005Record,
  parseNutritionRecord,
};

// CLI 실행
if (require.main === module) {
  runDemo();
}
