/**
 * OCR 텍스트 파서
 * 원재료명 파싱, 첨가물 식별, 영양정보 추출, 알레르기 탐지
 * Python 09_google_vision_ocr.py에서 포팅
 */

// ============================================================
// 1. 원재료명 섹션 추출
// ============================================================

/**
 * 전체 OCR 텍스트에서 원재료명 섹션만 추출합니다.
 * @param {string} text - 교정된 OCR 텍스트
 * @returns {string|null}
 */
function extractIngredientSection(text) {
  // 특수문자 bullet 제거
  const cleaned = text.replace(/[●▶■□◆◇▷▸•·|]/g, ' ');

  // 종료 키워드
  const endKeywords = '(?=영양(?:정보|성분)|유통기한|보관방법|내용량|포장재질|' +
    '품목보고|※|주의사항|직사광선|부정\\s*[·.]|반품|고객상담|' +
    '업소명|제조원|판매원|\\d{10,})';

  const patterns = [
    new RegExp(`원재료명\\s*(?:및\\s*)?(?:함량)?\\s*[:\\s]\\s*(.+?)${endKeywords}`, 's'),
    new RegExp(`원재료명\\s*(.+?)${endKeywords}`, 's'),
    new RegExp(`원재료\\s*[:\\s]\\s*(.+?)${endKeywords}`, 's'),
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match && match[1].trim().length >= 10) {
      return match[1].trim();
    }
  }

  // 라면류 특수 케이스
  const ramenPattern = new RegExp(`\\*?면\\s*[:]\\s*(.+?)${endKeywords}`, 's');
  const ramenMatch = cleaned.match(ramenPattern);
  if (ramenMatch && ramenMatch[1].trim().length >= 10) {
    return ramenMatch[1].trim();
  }

  return null;
}

// ============================================================
// 2. 개별 성분 파싱
// ============================================================

/**
 * 원재료명 텍스트에서 개별 성분을 파싱합니다.
 * 한국 식품 라벨의 복잡한 괄호 구조를 처리합니다.
 * @param {string} ingredientText
 * @returns {Array<Object>}
 */
function parseIngredients(ingredientText) {
  if (!ingredientText) return [];

  let text = ingredientText.replace(/\s+/g, ' ').trim();

  // 함유 표시 제거
  text = text.replace(/[,，\s]*(함유|포함|사용)\s*$/, '');
  // 알레르기 표시 제거
  text = text.replace(/\[?알레르기\s*유발물질\s*[:]\s*[^\]]*\]?/g, '');
  // 중괄호 → 소괄호 통일
  text = text.replace(/\{/g, '(').replace(/\}/g, ')');

  // 최상위 레벨에서 쉼표로 분리 (괄호 내부 쉼표는 무시)
  const ingredients = [];
  let current = '';
  let depth = 0;

  for (const char of text) {
    if ('(（['.includes(char)) {
      depth++;
      current += char;
    } else if (')）]'.includes(char)) {
      depth = Math.max(0, depth - 1);
      current += char;
    } else if (char === ',' && depth === 0) {
      if (current.trim()) ingredients.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) ingredients.push(current.trim());

  // 각 성분 구조화
  return ingredients
    .filter(ing => ing.length >= 1)
    .map(ing => {
      // 함량 비율
      const pctMatch = ing.match(/(\d+[.,]?\d*)\s*%/);
      const percentage = pctMatch ? parseFloat(pctMatch[1].replace(',', '.')) : null;

      // 원산지
      const originMatch = ing.match(/[(（]([^)）]*산)[)）]/);
      const origin = originMatch ? originMatch[1] : null;

      // 메인 성분명
      const nameMatch = ing.match(/^([^(（[\d%]+)/);
      const name = nameMatch ? nameMatch[1].trim() : ing.trim();

      // 세부 성분 (최외곽 괄호/대괄호 안 — 가장 긴 매칭 사용)
      let detail = '';
      const bracketStart = ing.search(/[(（\[]/);
      if (bracketStart !== -1) {
        // 괄호 깊이 추적으로 매칭되는 닫힘 괄호까지 추출
        let d = 0;
        let detailEnd = -1;
        for (let i = bracketStart; i < ing.length; i++) {
          if ('(（['.includes(ing[i])) d++;
          else if (')）]'.includes(ing[i])) { d--; if (d === 0) { detailEnd = i; break; } }
        }
        if (detailEnd > bracketStart) {
          detail = ing.substring(bracketStart + 1, detailEnd);
        }
      }

      // 서브 성분 추출
      const subIngredients = [];
      if (detail && detail.includes(',')) {
        for (const sub of detail.split(',')) {
          const subName = sub.trim().match(/^([^(（[\d%:]+)/);
          if (subName) {
            const sn = subName[1].trim();
            if (sn.length >= 2 && !/.*산$/.test(sn)) {
              subIngredients.push(sn);
            }
          }
        }
      }

      return { name, detail, origin, percentage, raw: ing, sub_ingredients: subIngredients };
    });
}

// ============================================================
// 3. 식품첨가물 식별
// ============================================================

const ADDITIVE_KEYWORDS = {
  // 보존료
  '안식향산나트륨': '보존료', '안식향산': '보존료',
  '소르빈산칼륨': '보존료', '소르빈산': '보존료',
  '프로피온산나트륨': '보존료', '프로피온산칼슘': '보존료',
  '아질산나트륨': '발색제/보존료', '질산나트륨': '발색제', '질산칼륨': '발색제',
  // 산화방지제
  'BHA': '산화방지제', 'BHT': '산화방지제', 'TBHQ': '산화방지제',
  '에리소르빈산나트륨': '산화방지제', '부틸히드록시아니솔': '산화방지제',
  '디부틸히드록시톨루엔': '산화방지제',
  'L-아스코르브산': '산화방지제/비타민', '아스코르브산': '산화방지제/비타민',
  '비타민C': '산화방지제/비타민', '토코페롤': '산화방지제/비타민',
  // 감미료
  '아스파탐': '감미료', '아세설팜칼륨': '감미료', '수크랄로스': '감미료',
  '삭카린나트륨': '감미료', '스테비아': '감미료', '자일리톨': '감미료',
  '소르비톨': '감미료', '에리스리톨': '감미료',
  // 착색료
  '타르색소': '착색료', '적색제2호': '착색료', '적색2호': '착색료',
  '적색제3호': '착색료', '적색3호': '착색료',
  '적색제40호': '착색료', '적색40호': '착색료',
  '황색제4호': '착색료', '황색4호': '착색료',
  '황색제5호': '착색료', '황색5호': '착색료',
  '청색제1호': '착색료', '청색1호': '착색료',
  '청색제2호': '착색료', '청색2호': '착색료',
  '카라멜색소': '착색료', '이산화티타늄': '착색료',
  '코치닐추출색소': '착색료', '카민': '착색료',
  '베타카로틴': '착색료/비타민', '파프리카추출색소': '착색료', '안나토색소': '착색료',
  // 향미증진제
  'L-글루타민산나트륨': '향미증진제', '글루타민산나트륨': '향미증진제',
  "5'-리보뉴클레오티드이나트륨": '향미증진제',
  '이노신산나트륨': '향미증진제', '구아닐산나트륨': '향미증진제',
  // 팽창제
  '탄산수소나트륨': '팽창제', '탄산나트륨': '팽창제',
  '산성피로인산나트륨': '팽창제', '제일인산칼슘': '팽창제',
  '황산알루미늄칼륨': '팽창제',
  // 유화제
  '레시틴': '유화제', '대두레시틴': '유화제',
  '글리세린지방산에스테르': '유화제', '자당지방산에스테르': '유화제',
  '폴리소르베이트': '유화제', '폴리소르베이트60': '유화제', '폴리소르베이트80': '유화제',
  '카르복시메틸셀룰로스': '유화제/증점제', 'CMC': '유화제/증점제',
  // 증점제/안정제
  '잔탄검': '증점제', '구아검': '증점제', '카라기난': '증점제', '젤란검': '증점제',
  '펙틴': '증점제', '한천': '증점제', '알긴산나트륨': '증점제',
  '셀룰로스검': '증점제', '셀룰로오스검': '증점제',
  '변성전분': '증점제', '아라비아검': '증점제',
  '메틸셀룰로스': '증점제', '히드록시프로필메틸셀룰로스': '증점제', '로커스트콩검': '증점제',
  // 산도조절제
  '구연산': '산도조절제', '구연산나트륨': '산도조절제', '구연산삼나트륨': '산도조절제',
  '젖산': '산도조절제', '젖산칼슘': '산도조절제',
  '주석산': '산도조절제', '푸마르산': '산도조절제',
  '인산': '산도조절제', '빙초산': '산도조절제',
  '글루코노델타락톤': '산도조절제', '글루콘산': '산도조절제',
  '면류첨가알칼리제': '산도조절제', '탄산칼륨': '산도조절제',
  // 인산염류 (품질개량제)
  '폴리인산나트륨': '품질개량제', '메타인산나트륨': '품질개량제',
  '메타인산칼륨': '품질개량제', '피로인산나트륨': '품질개량제',
  '피로인산사나트륨': '품질개량제', '제삼인산칼슘': '품질개량제',
  '인산나트륨': '품질개량제', '인산칼슘': '품질개량제',
  // 기타
  '이산화규소': '고결방지제', '규소수지': '소포제',
  '카르나우바왁스': '피막제', '셸락': '피막제',
  '프로필렌글리콜': '습윤제', '글리세린': '습윤제',
  '합성향료': '향료', '바닐린': '향료', '에틸바닐린': '향료',
  '강황추출액': '착색료/향신료', '강황색소': '착색료',
  '혼합제제': '복합첨가물',
  '덱스트린': '부형제', '텍스트린': '부형제',
  '말토덱스트린': '부형제', '사이클로덱스트린': '부형제',
};

/**
 * 파싱된 원재료 목록에서 식품첨가물을 식별합니다.
 * @param {Array} ingredients - parseIngredients() 결과
 * @returns {Array<Object>}
 */
function identifyAdditives(ingredients) {
  const found = [];
  const seen = new Set();

  function checkName(name, raw, source) {
    name = name.trim();
    if (name.length < 2 || seen.has(name)) return;

    // 정확 매칭
    if (ADDITIVE_KEYWORDS[name]) {
      seen.add(name);
      found.push({
        name,
        category: ADDITIVE_KEYWORDS[name],
        raw,
        match_type: `exact(${source})`,
      });
      return;
    }

    // 부분 매칭 (키워드가 성분명에 포함)
    for (const [keyword, category] of Object.entries(ADDITIVE_KEYWORDS)) {
      if (name.includes(keyword) && !seen.has(keyword)) {
        seen.add(keyword);
        found.push({
          name: keyword,
          category,
          raw,
          match_type: `partial(${source})`,
        });
        return;
      }
    }
  }

  for (const ing of ingredients) {
    checkName(ing.name, ing.raw, 'main');

    for (const sub of ing.sub_ingredients || []) {
      checkName(sub, ing.raw, 'sub');
    }

    // detail 텍스트 키워드 직접 검색
    const detail = ing.detail || '';
    if (detail) {
      for (const [keyword, category] of Object.entries(ADDITIVE_KEYWORDS)) {
        if (detail.includes(keyword) && !seen.has(keyword)) {
          seen.add(keyword);
          found.push({
            name: keyword,
            category,
            raw: ing.raw,
            match_type: 'detail_scan',
          });
        }
      }
    }
  }

  return found;
}

// ============================================================
// 4. 영양정보 파싱
// ============================================================

const NUTRIENT_PATTERNS = {
  calories:      /열량[:\s]*(\d+[.,]?\d*)\s*(kcal|킬로칼로리|Kcal)/,
  total_carbs:   /탄수화물[:\s]*(\d+[.,]?\d*)\s*g/,
  total_sugars:  /당류[:\s]*(\d+[.,]?\d*)\s*g/,
  protein:       /단백질[:\s]*(\d+[.,]?\d*)\s*g/,
  total_fat:     /(?<!포화)(?<!트랜스)지방[:\s]*(\d+[.,]?\d*)\s*g/,
  saturated_fat: /포화지방(?:산)?[:\s]*(\d+[.,]?\d*)\s*g/,
  trans_fat:     /트랜스지방(?:산)?[:\s]*(\d+[.,]?\d*)\s*g/,
  cholesterol:   /콜레스테롤[:\s]*(\d+[.,]?\d*)\s*m?g/,
  sodium:        /나트륨[:\s]*(\d+[.,]?\d*)\s*m?g/,
  dietary_fiber: /식이섬유[:\s]*(\d+[.,]?\d*)\s*g/,
};

/**
 * OCR 텍스트에서 영양정보를 추출합니다.
 * @param {string} text
 * @returns {Object}
 */
function parseNutrition(text) {
  const nutrition = {};

  for (const [nutrient, pattern] of Object.entries(NUTRIENT_PATTERNS)) {
    const match = text.match(pattern);
    if (match) {
      const value = match[1].replace(',', '.');
      nutrition[nutrient] = parseFloat(value);
    }
  }

  // 1회 제공량 / 총 내용량
  const servingMatch = text.match(
    /(?:1회\s*제공량|총\s*내용량)[:\s]*(\d+[.,]?\d*)\s*(g|ml|mL|kg|L)/
  );
  if (servingMatch) {
    nutrition.serving_size = parseFloat(servingMatch[1].replace(',', '.'));
    nutrition.serving_unit = servingMatch[2].toLowerCase();
  }

  return nutrition;
}

// ============================================================
// 5. 알레르기 유발물질 탐지
// ============================================================

const ALLERGEN_KEYWORDS = {
  '난류': ['계란', '달걀', '난백', '난황', '마요네즈', '리소자임'],
  '우유': ['우유', '탈지분유', '유청', '카제인', '락토스', '버터', '치즈', '크림', '유단백'],
  '밀': ['밀가루', '소맥분', '글루텐'],
  '대두': ['대두', '두부', '간장', '된장', '콩기름', '레시틴'],
  '땅콩': ['땅콩', '피넛'],
  '메밀': ['메밀', '소바'],
  '게': ['게살', '크래미', '꽃게'],
  '새우': ['새우', '건새우', '새우젓'],
  '돼지고기': ['돼지고기', '베이컨', '돈지'],
  '복숭아': ['복숭아', '황도'],
  '토마토': ['토마토', '케첩'],
  '호두': ['호두'],
  '닭고기': ['닭고기', '닭가슴살', '치킨'],
  '쇠고기': ['쇠고기', '소고기', '젤라틴', '쇠고기엑기스'],
  '오징어': ['오징어'],
  '조개류': ['굴', '홍합', '전복', '조개', '바지락'],
  '아황산류': ['아황산', '이산화황'],
};

/**
 * 텍스트에서 알레르기 유발물질을 탐지합니다.
 * @param {string} text
 * @returns {string[]}
 */
function detectAllergens(text) {
  const detected = new Set();
  for (const [allergen, keywords] of Object.entries(ALLERGEN_KEYWORDS)) {
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        detected.add(allergen);
        break;
      }
    }
  }
  return [...detected].sort();
}

// ============================================================
// 6. 통합 분석 파이프라인
// ============================================================

/**
 * 교정된 OCR 텍스트를 완전 분석합니다.
 * @param {string} correctedText - 교정된 텍스트
 * @returns {Object} 분석 결과
 */
function analyzeText(correctedText) {
  // 원재료명 파싱
  const ingredientSection = extractIngredientSection(correctedText);
  const ingredients = ingredientSection ? parseIngredients(ingredientSection) : [];

  // 첨가물 식별
  const additives = identifyAdditives(ingredients);

  // 영양정보
  const nutrition = parseNutrition(correctedText);

  // 알레르기
  const allergens = detectAllergens(correctedText);

  return {
    ingredient_section: ingredientSection,
    ingredients: ingredients.map(i => ({
      name: i.name,
      origin: i.origin,
      percentage: i.percentage,
      sub_ingredients: i.sub_ingredients,
    })),
    ingredient_count: ingredients.length,
    additives,
    additive_count: additives.length,
    nutrition,
    allergens,
  };
}

module.exports = {
  extractIngredientSection,
  parseIngredients,
  identifyAdditives,
  parseNutrition,
  detectAllergens,
  analyzeText,
  ADDITIVE_KEYWORDS,
  ALLERGEN_KEYWORDS,
};
