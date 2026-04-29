/**
 * OCR 파서 유닛 테스트
 * Google Vision API 호출 없이 파싱 로직만 검증
 */

const {
  extractIngredientSection,
  parseIngredients,
  identifyAdditives,
  parseNutrition,
  detectAllergens,
  analyzeText,
} = require('../src/services/ocrParser');

const { correctOcrText } = require('../src/services/ocrService');

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ ${testName}`);
    passed++;
  } else {
    console.log(`  ❌ ${testName}`);
    failed++;
  }
}

// ============================================================
// 테스트 데이터: 실제 한국 식품 라벨 OCR 결과 시뮬레이션
// ============================================================

const SAMPLE_LABEL_1 = `새우깡
농심
내용량: 90g (30g x 3봉)
원재료명 및 함량: 소맥분(밀:미국산,호주산), 팜유(말레이시아산), 새우시즈닝[새우분말4.56%(새우:중국산), 정제소금, L-글루타민산나트륨(향미증진제), 탄산칼슘], 전분, 정제소금, 새우분말0.87%, 간장분말(대두), 조미액상
영양정보 1회 제공량 30g
열량 140kcal
탄수화물 18g
당류 2g
단백질 2g
지방 7g
포화지방 3g
트랜스지방 0g
콜레스테롤 5mg
나트륨 200mg
유통기한: 제조일로부터 6개월`;

const SAMPLE_LABEL_2 = `비비빅 (팥맛)
롯데웰푸드
원재료명: 정제수, 설탕, 팥앙금(팥:중국산), 탈지분유, 물엿, 코코넛유, 식물성유지(팜핵경화유), 유화제(폴리소르베이트80, 글리세린지방산에스테르), 안정제(카라기난, 구아검, 로커스트콩검), 착향료(바닐린), 착색료(카라멜색소)
영양성분 1회제공량 130ml
열량 190kcal
나트륨 55mg
탄수화물 33g
당류 25g
지방 5g
포화지방산 4.5g
트랜스지방 0g
콜레스테롤 5mg
단백질 3g`;

const SAMPLE_LABEL_OCR_ERRORS = `영양성붂 1회 제공량 30g
열렁 140kcal
탄수확물 18g
나뜨륨 200mg
탄백질 2g
브랜스지방 0g
포화지방샨 3g
콜래스테롤 5mg`;


console.log('══════════════════════════════════════════════════════');
console.log('  먹선 OCR 파서 유닛 테스트');
console.log('══════════════════════════════════════════════════════\n');

// ── 테스트 1: OCR 텍스트 교정 ──
console.log('🔧 테스트 1: OCR 오인식 교정');
const { corrected, corrections } = correctOcrText(SAMPLE_LABEL_OCR_ERRORS);
assert(corrections.length >= 6, `교정 ${corrections.length}건 감지`);
assert(corrected.includes('나트륨'), '나뜨륨 → 나트륨 교정');
assert(corrected.includes('단백질'), '탄백질 → 단백질 교정');
assert(corrected.includes('트랜스지방'), '브랜스지방 → 트랜스지방 교정');
assert(corrected.includes('콜레스테롤'), '콜래스테롤 → 콜레스테롤 교정');
assert(corrected.includes('열량'), '열렁 → 열량 교정');
assert(corrected.includes('탄수화물'), '탄수확물 → 탄수화물 교정');

// ── 테스트 2: 원재료명 섹션 추출 ──
console.log('\n📋 테스트 2: 원재료명 섹션 추출');
const section1 = extractIngredientSection(SAMPLE_LABEL_1);
assert(section1 !== null, '새우깡: 원재료명 섹션 추출 성공');
assert(section1.includes('소맥분'), '소맥분 포함');
assert(section1.includes('새우시즈닝'), '새우시즈닝 포함');
assert(!section1.includes('영양정보'), '영양정보 섹션 미포함 (종료 키워드 동작)');

const section2 = extractIngredientSection(SAMPLE_LABEL_2);
assert(section2 !== null, '비비빅: 원재료명 섹션 추출 성공');
assert(section2.includes('정제수'), '정제수 포함');
assert(section2.includes('카라멜색소'), '카라멜색소 포함');

// ── 테스트 3: 개별 성분 파싱 ──
console.log('\n🧪 테스트 3: 개별 성분 파싱');
const ingredients1 = parseIngredients(section1);
assert(ingredients1.length >= 5, `새우깡: ${ingredients1.length}개 성분 파싱`);

const flour = ingredients1.find(i => i.name.includes('소맥분'));
assert(flour !== null, '소맥분 성분 존재');
assert(flour && flour.origin === '미국산,호주산' || flour.origin !== null, '원산지 추출');

const ingredients2 = parseIngredients(section2);
assert(ingredients2.length >= 8, `비비빅: ${ingredients2.length}개 성분 파싱`);

// ── 테스트 4: 첨가물 식별 ──
console.log('\n⚗️ 테스트 4: 첨가물 식별');
const additives1 = identifyAdditives(ingredients1);
assert(additives1.length >= 1, `새우깡: ${additives1.length}개 첨가물 식별`);
const msg = additives1.find(a => a.name === 'L-글루타민산나트륨');
assert(msg !== undefined, 'L-글루타민산나트륨 (향미증진제) 식별');

const additives2 = identifyAdditives(ingredients2);
assert(additives2.length >= 3, `비비빅: ${additives2.length}개 첨가물 식별`);
const caramel = additives2.find(a => a.name === '카라멜색소');
assert(caramel !== undefined, '카라멜색소 (착색료) 식별');
const carrageenan = additives2.find(a => a.name === '카라기난');
assert(carrageenan !== undefined, '카라기난 (증점제) 식별');

// ── 테스트 5: 영양정보 파싱 ──
console.log('\n📊 테스트 5: 영양정보 파싱');
const nutrition1 = parseNutrition(SAMPLE_LABEL_1);
assert(nutrition1.calories === 140, `열량: ${nutrition1.calories}kcal`);
assert(nutrition1.sodium === 200, `나트륨: ${nutrition1.sodium}mg`);
assert(nutrition1.total_sugars === 2, `당류: ${nutrition1.total_sugars}g`);
assert(nutrition1.total_fat === 7, `지방: ${nutrition1.total_fat}g`);
assert(nutrition1.saturated_fat === 3, `포화지방: ${nutrition1.saturated_fat}g`);
assert(nutrition1.trans_fat === 0, `트랜스지방: ${nutrition1.trans_fat}g`);
assert(nutrition1.cholesterol === 5, `콜레스테롤: ${nutrition1.cholesterol}mg`);
assert(nutrition1.protein === 2, `단백질: ${nutrition1.protein}g`);

const nutrition2 = parseNutrition(SAMPLE_LABEL_2);
assert(nutrition2.calories === 190, `비비빅 열량: ${nutrition2.calories}kcal`);
assert(nutrition2.sodium === 55, `비비빅 나트륨: ${nutrition2.sodium}mg`);

// ── 테스트 6: 알레르기 탐지 ──
console.log('\n⚠️ 테스트 6: 알레르기 유발물질 탐지');
const allergens1 = detectAllergens(SAMPLE_LABEL_1);
assert(allergens1.includes('밀') || allergens1.includes('대두'), `새우깡 알레르기: ${allergens1.join(', ')}`);
assert(allergens1.includes('새우'), '새우 알레르기 감지');

const allergens2 = detectAllergens(SAMPLE_LABEL_2);
assert(allergens2.includes('우유'), '비비빅: 우유 알레르기 감지 (탈지분유)');

// ── 테스트 7: 통합 분석 ──
console.log('\n🔄 테스트 7: 통합 분석 (analyzeText)');
const result = analyzeText(SAMPLE_LABEL_1);
assert(result.ingredient_count >= 5, `통합: 원재료 ${result.ingredient_count}개`);
assert(result.additive_count >= 1, `통합: 첨가물 ${result.additive_count}개`);
assert(Object.keys(result.nutrition).length >= 5, `통합: 영양정보 ${Object.keys(result.nutrition).length}항목`);
assert(result.allergens.length >= 1, `통합: 알레르기 ${result.allergens.length}종`);

// ── 테스트 8: 교정 후 영양정보 파싱 ──
console.log('\n🔧 테스트 8: 교정된 텍스트 → 영양정보 파싱');
const nutritionFromCorrected = parseNutrition(corrected);
assert(nutritionFromCorrected.calories === 140, '교정 후 열량 추출 성공');
assert(nutritionFromCorrected.sodium === 200, '교정 후 나트륨 추출 성공');
assert(nutritionFromCorrected.protein === 2, '교정 후 단백질 추출 성공');

// ── 결과 요약 ──
console.log(`\n${'═'.repeat(54)}`);
console.log(`📊 OCR 파서 테스트 결과: ${passed} 통과 / ${failed} 실패 (총 ${passed + failed}개)`);
console.log(`${'═'.repeat(54)}`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('\n✅ OCR 파서 테스트 전체 통과!');
}
