/**
 * OCR 텍스트 파서
 * 원재료명 파싱, 첨가물 식별, 영양정보 추출, 알레르기 탐지
 * Python 09_google_vision_ocr.py에서 포팅
 *
 * ⚠️ IP SOURCES (수정 시 OneDrive 원본 먼저 수정):
 *   - OneDrive/MeokSeon/IP/korean_label_ocr_rules.md  (파싱 정규식 패턴)
 *   - OneDrive/MeokSeon/IP/additive_keywords_dictionary.json  (ADDITIVE_KEYWORDS)
 *   - OneDrive/MeokSeon/IP/allergens_19_korea.json  (알레르기 19종 + 후처리)
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

  // 종료 키워드 — 한국 식품 라벨에서 원재료 다음에 자주 등장하는 섹션 시작어
  // ♥/⚠/★ 같은 알레르기 표기 마커도 포함 (\"♥ 우유, 밀, 쇠고기 함유 ♥\" 가 원재료에 섞여 들어가는 것 차단)
  // \"함유\", \"알레르기\" 도 알레르기 표기 시작이므로 종료
  const endKeywords = '(?=영양(?:정보|성분)|유통기한|보관방법|내용량|포장재질|' +
    '품목보고|※|주의사항|직사광선|부정\\s*[·.]|반품|고객상담|' +
    '업소명|제조원|판매원|유통전문판매원|소분원|소비자상담|' +
    '함유|알레르기|[♥⚠★◆■▲]|\\d{10,})';

  const patterns = [
    new RegExp(`원재료명\\s*(?:및\\s*)?(?:함량)?\\s*[:\\s]\\s*(.+?)${endKeywords}`, 's'),
    new RegExp(`원재료명\\s*(.+?)${endKeywords}`, 's'),
    new RegExp(`원재료\\s*[:\\s]\\s*(.+?)${endKeywords}`, 's'),
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    // 임계값 10 → 3 으로 완화: OCR이 짧게 잘라도 \"밀가루\" 같은 한 단어라도 받음
    if (match && match[1].trim().length >= 3) {
      return _stripAllergenSuffix(match[1].trim());
    }
  }

  // 라면류 특수 케이스
  const ramenPattern = new RegExp(`\\*?면\\s*[:]\\s*(.+?)${endKeywords}`, 's');
  const ramenMatch = cleaned.match(ramenPattern);
  if (ramenMatch && ramenMatch[1].trim().length >= 3) {
    return _stripAllergenSuffix(ramenMatch[1].trim());
  }

  // 종료 키워드가 텍스트에 전혀 없는 경우 — \"원재료명\" 시작 후 끝까지 추출
  const fallbackPatterns = [
    /원재료명\s*(?:및\s*)?(?:함량)?\s*[:\s]\s*(.+)/s,
    /원재료\s*[:\s]\s*(.+)/s,
  ];
  for (const pattern of fallbackPatterns) {
    const match = cleaned.match(pattern);
    if (match && match[1].trim().length >= 3) {
      const result = match[1].trim().substring(0, 2000);
      return _stripAllergenSuffix(result);
    }
  }

  return null;
}

/**
 * 원재료 텍스트 끝부분에서 알레르기 표기 부분을 잘라낸다.
 * extractIngredientSection 의 종료 키워드가 OCR 오인식·표기 변형으로 못 잡은 경우
 * 사후 정리로 \"X, Y, Z 함유\" 패턴을 제거.
 *
 * 예:
 *  \"밀가루, 정제소금, 비타민B1염산염, 우유, 밀, 쇠고기 함유\"
 *    → \"밀가루, 정제소금, 비타민B1염산염\"
 *
 *  \"밀가루, 정제소금 알레르기 유발물질: 우유, 밀, 쇠고기\"
 *    → \"밀가루, 정제소금\"
 */
function _stripAllergenSuffix(text) {
  if (!text) return text;
  let result = text;

  // 식약처 의무 표시 알레르기 19종 + 흔한 변형
  // 끝부분에 콤마로 구분된 단독 항목으로 나오면 알레르기 표기로 간주하고 제거
  const ALLERGEN_KEYWORDS = new Set([
    '우유', '메밀', '땅콩', '대두', '밀', '고등어', '게', '새우', '돼지고기',
    '복숭아', '토마토', '아황산류', '호두', '닭고기', '쇠고기', '오징어',
    '조개류', '잣', '난류', '난백', '난황', '달걀', '계란', '연어', '전복', '홍합',
  ]);

  // 1) "♥…함유♥" 또는 "X, Y, Z 함유" 끝부분 제거 (함유 키워드가 살아있는 경우)
  //    extractIngredientSection 의 endKeywords 가 "함유" 앞에서 잘랐다면 이 단계는
  //    매치 안 함 → 4단계가 처리.
  result = result.replace(
    /[♥⚠★◆■▲▼☆◎●○]?\s*[가-힣A-Za-z\s,()·\.0-9]+?\s*함유\s*[♥⚠★◆■▲▼☆◎●○]?\s*\.?\s*$/g,
    '',
  );

  // 2) "알레르기 유발물질: …" 끝부분 제거
  result = result.replace(
    /(?:알레르기|알러지)\s*(?:유발\s*물질)?\s*[:：]?\s*[가-힣\s,()·\.]+$/g,
    '',
  );

  // 3) 끝부분 정리 (콤마·공백·점)
  result = result.replace(/[\s,.\-/·]+$/, '').trim();

  // 4) 알레르기 19종 키워드가 끝부분에 콤마로 단독 항목으로 연속해 나오면 제거
  //    핵심 케이스: extractIngredientSection 이 endKeywords 의 "함유" 앞에서 잘랐기 때문에
  //    "함유" 키워드는 사라지고 "우유, 밀, 쇠고기" 같은 알레르기 나열만 남는 경우.
  //
  //    예) "밀가루, 정제소금, 비타민B1염산염, 우유, 밀, 쇠고기"
  //         → "밀가루, 정제소금, 비타민B1염산염" (마지막 3개가 알레르기 키워드라서 제거)
  //
  //    안전장치: 콤마(,) 앞에 있을 때만 검사 → 첫 항목 "밀가루" 같은 단어는 보호.
  //              5자 이하 정확 매칭만 → "밀가루"는 ALLERGEN_KEYWORDS 에 없으므로 안전.
  let prev = '';
  while (prev !== result) {
    prev = result;
    // 구분자: 콤마(,) · 가운데점(·) · 슬래시(/) · 공백(\s) · 닫는괄호()) 모두 허용
    // OCR이 콤마를 빠뜨리고 공백만 남기는 경우, 또는 "(국내산) 밀, 우유" 처럼
    // 괄호 직후 알레르기가 나열되는 경우까지 잡음
    const lastItemMatch = result.match(/[,·\/\s)]+\s*([가-힣]{1,5})\s*\.?\s*$/);
    if (lastItemMatch && ALLERGEN_KEYWORDS.has(lastItemMatch[1].trim())) {
      result = result.substring(0, lastItemMatch.index).trim();
    } else {
      break;
    }
  }

  // 5) 마무리 정리
  result = result.replace(/[\s,.\-/·]+$/, '').trim();

  return result;
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
  '합성향료': '향료', '천연향료': '향료', '바닐린': '향료', '에틸바닐린': '향료',
  '강황추출액': '착색료/향신료', '강황색소': '착색료',
  '혼합제제': '복합첨가물',
  '덱스트린': '부형제', '텍스트린': '부형제',
  '말토덱스트린': '부형제', '사이클로덱스트린': '부형제',

  // 비타민·미네랄 (영양강화제) — 한국 가공식품에 매우 자주 등장
  // 라벨 표기: 비타민B1, 비타민B1염산염, 티아민(B1), 리보플라빈(B2) 등 다양
  '비타민A': '영양강화제/비타민', '레티놀': '영양강화제/비타민',
  '베타카로틴': '영양강화제/비타민/착색료',
  '비타민B1': '영양강화제/비타민', '비타민B1염산염': '영양강화제/비타민',
  '티아민': '영양강화제/비타민', '티아민염산염': '영양강화제/비타민',
  '비타민B2': '영양강화제/비타민', '리보플라빈': '영양강화제/비타민',
  '리보플라빈인산에스테르나트륨': '영양강화제/비타민',
  '비타민B6': '영양강화제/비타민', '피리독신': '영양강화제/비타민',
  '피리독신염산염': '영양강화제/비타민',
  '비타민B12': '영양강화제/비타민', '시아노코발라민': '영양강화제/비타민',
  '나이아신': '영양강화제/비타민', '니코틴산아미드': '영양강화제/비타민',
  '판토텐산칼슘': '영양강화제/비타민', '판토텐산': '영양강화제/비타민',
  '엽산': '영양강화제/비타민', '폴산': '영양강화제/비타민',
  '비오틴': '영양강화제/비타민',
  '비타민D': '영양강화제/비타민', '비타민D3': '영양강화제/비타민',
  '콜레칼시페롤': '영양강화제/비타민',
  '비타민E': '영양강화제/비타민', 'd-α-토코페롤': '영양강화제/비타민',
  '비타민K': '영양강화제/비타민', '비타민K1': '영양강화제/비타민',
  '메나퀴논': '영양강화제/비타민',
  '구연산제일철': '영양강화제/미네랄', '환원철': '영양강화제/미네랄',
  '글루콘산아연': '영양강화제/미네랄', '황산아연': '영양강화제/미네랄',
  '탄산칼슘': '영양강화제/미네랄', '제삼인산칼슘': '영양강화제/미네랄',
  '산화마그네슘': '영양강화제/미네랄', '글루콘산구리': '영양강화제/미네랄',
  '산화칼슘': '영양강화제/미네랄', '요오드화칼륨': '영양강화제/미네랄',

  // 카테고리 표기 (라벨에 \"팽창제\", \"영양강화제\" 같은 분류명만 적힌 경우)
  // 한국 식품 라벨에 흔히 등장
  '팽창제': '팽창제', '영양강화제': '영양강화제', '효소제': '효소제',
  '제빵효소제': '효소제',
  // 효모(Saccharomyces cerevisiae) 자체는 식약처 분류상 식품 원료(식품)이지 첨가물이 아니므로
  // 첨가물 사전에서 제외. 효모 추출물·자가분해효모추출물(향미증진제)은 별도 키워드로 잡힘.
  '식물성유지': '식물성유지', '동물성유지': '동물성유지',
  '면류첨가알칼리제': '산도조절제', '주정': '용제',

  // OCR 오인식 폴백 — 작은 라벨에서 \"비타민B1염산염\" → \"비타민B\" 로 잘리는 등
  // 위의 \"비타민B1\", \"비타민B2\" 가 우선 매칭되고, 그게 안 되면 이걸로 폴백
  '비타민B': '영양강화제/비타민',
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

/**
 * ★★ 숫자 파싱 — 천단위 콤마와 소수점 콤마를 구분한다. (2026-07-28 세션39)
 *
 * 왜 생겼나: 기존 코드가 `.replace(',', '.')` 로 콤마를 소수점으로 바꿨다.
 * 한국 라벨의 나트륨은 "1,790 mg" 처럼 **천단위 콤마**를 쓴다.
 *   1,790 → "1.790" → parseFloat → **1.79**  (1000배 축소)
 * sanityCheck 는 상한만 보므로 1.79 는 그대로 통과하고 신호등이 초록으로 뒤집힌다.
 * = "거짓 초록". 캡처 001(신라면) 실물로 재현 확인.
 *
 * 규칙: `1,790` `2,500` `1,500` = 천단위 / `1,5` = OCR이 소수점을 콤마로 읽은 것.
 * 검증: eval_set/capture_label_eval_v1.jsonl (scripts/63-eval-capture-parser.js)
 */
function parseNum(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!/\d/.test(t)) return null;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return parseFloat(t.replace(/,/g, ''));  // 1,790 / 2,500
  if (/^\d+,\d{1,2}$/.test(t)) return parseFloat(t.replace(',', '.'));               // 1,5 → 1.5
  return parseFloat(t.replace(/,/g, ''));
}

/**
 * ★ 표기 기준 판정 (2026-07-28) — 무엇을 읽었는지 모르면 값이 무의미하다.
 * 실물 확인: 신라면 "1봉지(120g)당" · 맥심 "1개(12g)당" · 해표콩기름 "100g당".
 * 100g당 라벨을 1회분으로 취급하면 콩기름이 "한 번에 지방 100g" 이 된다.
 * 반환값은 nutritionTrafficLight.sanityCheck / evaluateNutrition 의 basis 인자와 같은 어휘.
 */
const BASIS_PER100 = /100\s*(g|㎖|ml|mL|㎎|mg)\s*당/;
const BASIS_SERVING = /1\s*(?:회\s*제공량|회분|회|봉지|봉|개입|개|포|스틱|컵|캔|병|조각|장|인분)\s*\(?\s*(\d[\d,.]*)\s*(g|㎖|ml|mL|kg|L)\s*\)?\s*당/;
const BASIS_TOTAL = /총\s*내용량\s*당/;

function detectNutritionBasis(text) {
  const m100 = text.match(BASIS_PER100);
  if (m100) {
    const u = m100[1].toLowerCase();
    return { basis: (u === 'ml' || u === '㎖') ? 'per_100ml' : 'per_100g', amount: 100, unit: u };
  }
  const ms = text.match(BASIS_SERVING);
  if (ms) return { basis: 'per_serving', amount: parseNum(ms[1]), unit: ms[2].toLowerCase() };
  if (BASIS_TOTAL.test(text)) return { basis: 'per_total', amount: null, unit: null };
  return { basis: 'unknown', amount: null, unit: null };
}

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
 * Dual-column 패턴 — 한국 라벨에 \"1회 30g당 | 총 73g당\" 두 컬럼이 모두 적힌 경우.
 * \"나트륨 170 mg 420 mg\" 또는 \"나트륨\\n170 mg\\n420 mg\" 같이 OCR이 두 숫자를 연속으로 읽음.
 * 첫 번째 매칭 = 1회분, 두 번째 매칭 = 전량.
 * \"미만\" 표기 (예: \"0.5g 미만\") 도 허용.
 */
const NUTRIENT_PATTERNS_DUAL = {
  calories:      /열량[:\s\n]*(\d+[.,]?\d*)\s*(?:kcal|Kcal|킬로칼로리)\D{0,30}?(\d+[.,]?\d*)\s*(?:kcal|Kcal|킬로칼로리)/i,
  total_carbs:   /탄수화물[:\s\n]*(\d+[.,]?\d*)\s*g\D{0,40}?(\d+[.,]?\d*)\s*g/,
  total_sugars:  /당류[:\s\n]*(\d+[.,]?\d*)\s*g\D{0,40}?(\d+[.,]?\d*)\s*g/,
  protein:       /단백질[:\s\n]*(\d+[.,]?\d*)\s*g\D{0,40}?(\d+[.,]?\d*)\s*g/,
  total_fat:     /(?<!포화)(?<!트랜스)지방[:\s\n]*(\d+[.,]?\d*)\s*g\D{0,40}?(\d+[.,]?\d*)\s*g/,
  saturated_fat: /포화지방(?:산)?[:\s\n]*(\d+[.,]?\d*)\s*g\D{0,40}?(\d+[.,]?\d*)\s*g/,
  trans_fat:     /트랜스지방(?:산)?[:\s\n]*(\d+[.,]?\d*)\s*g\D{0,40}?(\d+[.,]?\d*)\s*g/,
  cholesterol:   /콜레스테롤[:\s\n]*(\d+[.,]?\d*)\s*m?g\D{0,40}?(\d+[.,]?\d*)\s*m?g/,
  sodium:        /나트륨[:\s\n]*(\d+[.,]?\d*)\s*m?g\D{0,40}?(\d+[.,]?\d*)\s*m?g/,
  dietary_fiber: /식이섬유[:\s\n]*(\d+[.,]?\d*)\s*g\D{0,40}?(\d+[.,]?\d*)\s*g/,
};

/**
 * OCR 텍스트에서 영양정보를 추출합니다.
 * @param {string} text
 * @returns {Object}
 */
function parseNutrition(text) {
  const nutrition = {};
  const nutritionTotal = {}; // 라벨에 명시된 전량 컬럼 값

  // 1a) Dual-column 우선 시도 — 라벨에 \"1회분 | 전량\" 두 컬럼이 모두 있으면
  //     첫 번째 = 1회분, 두 번째 = 전량으로 추출. 추출되면 둘 다 저장.
  for (const [nutrient, pattern] of Object.entries(NUTRIENT_PATTERNS_DUAL)) {
    const match = text.match(pattern);
    if (match && match[1] && match[2]) {
      nutrition[nutrient] = parseNum(match[1]);        // ★ 천단위 콤마 방어(세션39)
      nutritionTotal[nutrient] = parseNum(match[2]);
    }
  }

  // 1b) Single-column — dual에서 못 잡은 영양소는 단일 패턴으로 보강
  for (const [nutrient, pattern] of Object.entries(NUTRIENT_PATTERNS)) {
    if (nutrition[nutrient] !== undefined) continue;
    const match = text.match(pattern);
    if (match) {
      nutrition[nutrient] = parseNum(match[1]);        // ★ 천단위 콤마 방어(세션39)
    }
  }

  // 2) 칼로리 — \"열량\" 라벨 없이 \"1회(30g)당 160 kcal\" 같은 형식 추가 매칭
  // 한국 라벨에 \"열량\" 없이 \"1회당 X kcal\" 만 적힌 경우가 흔함
  if (nutrition.calories === undefined) {
    // ★ 세션39: 한 라벨에 kcal 후보가 여럿이다.
    //   맥심 실물 = 정답 50 · 기준치 "2,000 kcal" · 총량 "총 2,500 kcal/50개".
    //   최후 fallback(/(\d+)\s*kcal/)이 무엇을 잡을지 텍스트 순서에 달려 있었다.
    //   → 기준치·총량 문구를 먼저 제거하고 찾는다.
    const cleaned = text
      .replace(/1\s*일\s*영양성분\s*기준치[^\n]*/g, ' ')
      .replace(/[\d,]+\s*kcal\s*기준[^\n]*/g, ' ')
      .replace(/총\s*[\d,.]+\s*kcal[^\n]*/g, ' ');
    const altCalorie = cleaned.match(
      /(?:1회[\s(]*\d+\s*g?[\s)]*당|1회\s*제공량\s*당|총?\s*내용량\s*당)\s*(\d+(?:[.,]\d+)?)\s*kcal/i
    )
      // "1봉지(120g)당 500 kcal" · "1개(12g)당 50 kcal" — '1회' 가 아닌 실제 표기(세션39 실물)
      || cleaned.match(/당\s*(\d[\d,.]*)\s*kcal/i)
      || cleaned.match(/(\d+(?:[.,]\d+)?)\s*kcal/);
    if (altCalorie) {
      nutrition.calories = parseNum(altCalorie[1]);
    }
  }

  // 3) 1회 제공량 — \"1회 30g\" / \"1회(30g)\" / \"1회 제공량 30g\" / \"1회분 30g\"
  // 기존 정규식이 \"1회 제공량\" 과 \"총 내용량\" 을 둘 다 매칭해 혼동되던 문제 수정
  const servingMatch = text.match(
    /1회\s*[(\[]?\s*(?:제공량|분|당)?\s*[:\s(]*(\d+(?:[.,]\d+)?)\s*(g|ml|mL|kg|L)/
  );
  if (servingMatch) {
    nutrition.serving_size = parseNum(servingMatch[1]);
    nutrition.serving_unit = servingMatch[2].toLowerCase();
  }

  // 3b) ★ 세션39: 실물 라벨은 "1회" 라고 안 쓴다. "1봉지(120g)당"·"1개(12g)당"·"1스틱(12g)당".
  //     위 정규식이 '1회' 를 요구해 serving 이 통째로 비었고, 환산 기준이 사라졌다.
  const basisInfo = detectNutritionBasis(text);
  if (nutrition.serving_size === undefined && basisInfo.basis === 'per_serving' && basisInfo.amount) {
    nutrition.serving_size = basisInfo.amount;
    nutrition.serving_unit = basisInfo.unit;
  }

  // 4) 총 내용량 — 별도 매칭. \"총 내용량 73g\" / \"내용량 73g\"
  // \"1회\" 가 앞에 안 붙은 경우만 매칭하여 1회 제공량과 충돌 방지
  // ★ 세션39: "총 내용량" 을 먼저 찾는다.
  //   해표 콩기름 실물은 위쪽에 "내용량 1.5L(25℃)", 아래 영양정보에 "총 내용량 1,500 mL" 가 있다.
  //   기존 정규식은 `총` 이 optional 이라 위쪽 1.5L 를 먼저 집어 단위가 L 로 들어갔다.
  const totalMatch = text.match(
    /총\s*내용량\s*[:\s]*(\d[\d,.]*)\s*(g|㎖|ml|mL|kg|L)/
  ) || text.match(
    /(?:^|[\s,.\n])내용량\s*[:\s]*(\d+(?:[.,]\d+)?)\s*(g|ml|mL|kg|L)/
  );
  if (totalMatch) {
    nutrition.total_content = parseNum(totalMatch[1]);   // ★ "1,500 mL" → 1500 (세션39)
    nutrition.content_unit = totalMatch[2].toLowerCase();
  }

  // 4b) ★ 표기 기준을 응답에 실어 보낸다 (세션39).
  //     sanityCheck / evaluateNutrition 은 basis 인자를 이미 받는데 호출부가 안 넘기고 있었다.
  //     per_100g 라벨을 per_serving 으로 판정하면 결과가 무의미해진다(해표 콩기름: 100g당 지방 100g).
  nutrition._basis = basisInfo.basis;                    // per_serving | per_100g | per_100ml | per_total | unknown
  if (basisInfo.amount != null) nutrition._basis_amount = basisInfo.amount;

  // 5) 라벨에서 추출된 전량 영양값들이 있으면 nutrition._total 형태로 함께 노출.
  //    클라이언트는 이 값을 \"라벨 명시\" 로 신뢰하고, 없는 영양소는 1회분 × 배수로 자동 계산.
  if (Object.keys(nutritionTotal).length > 0) {
    nutrition._total = nutritionTotal;
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
 *
 * 룰 (사용자 안전 우선):
 *  1단계: 라벨에 명시된 알레르기 표기를 1차로 신뢰
 *     - \"우유, 밀, 쇠고기 함유\"
 *     - \"알레르기 유발물질: 대두, 밀\"
 *     - \"♥ 우유, 밀, 쇠고기 함유 ♥\"
 *  2단계: 명시 표기가 발견되지 않을 때만 원재료 키워드 추론으로 보조
 *
 * 이렇게 분리하는 이유 — 원재료 키워드 자동 추론(\"레시틴 → 대두\", \"케첩 → 토마토\" 등)은
 * 위양성(false positive)이 흔하다. 알레르기는 사용자 안전과 직결되므로
 * 라벨에 명시된 것만 표시하는 것이 가장 안전.
 *
 * @param {string} text
 * @returns {string[]}
 */
function detectAllergens(text) {
  // 1단계: 명시적 알레르기 표기 추출
  // \"함유\" 또는 \"알레르기 유발물질\" 또는 ♥/⚠ 같은 강조 마커가 있는 줄 찾기
  const explicitPatterns = [
    // \"알레르기 유발물질: 우유, 밀, 쇠고기\"
    /알레르기\s*유발\s*물질\s*[:：]\s*([^\.\n]+)/,
    // \"우유·밀·쇠고기 함유\" / \"우유, 밀, 쇠고기 함유\"
    /([가-힣\(\)·,\s]+?)(?:\s*함유)/,
    // \"♥ 우유, 밀, 쇠고기 함유 ♥\" 같이 ♥/⚠/⭐ 마커 감싸진 부분
    /[♥⚠⭐][^♥⚠⭐]*?([가-힣\(\)·,\s]+?)함유[^♥⚠⭐]*[♥⚠⭐]/,
  ];

  const explicitText = [];
  for (const re of explicitPatterns) {
    const m = text.match(re);
    if (m && m[1] && m[1].length < 200) {
      explicitText.push(m[1]);
    }
  }

  if (explicitText.length > 0) {
    // 명시 표기가 있으면 그 안의 알레르기만 추출
    const detected = new Set();
    const blob = explicitText.join(' ');
    for (const [allergen, keywords] of Object.entries(ALLERGEN_KEYWORDS)) {
      for (const keyword of keywords) {
        if (blob.includes(keyword)) {
          detected.add(allergen);
          break;
        }
      }
    }
    if (detected.size > 0) {
      return [...detected].sort();
    }
    // 명시 표기 추출했지만 매칭된 알레르기가 0개면 — 텍스트가 \"함유\" 없는 일반 문장
    // → 2단계로 폴백
  }

  // 2단계 (보조): 원재료 키워드 추론
  // 명시 표기가 없는 경우에만 보조로 사용. 위양성 위험을 줄이기 위해
  // 키워드 매칭은 \"독립 단어 경계\" 를 강제 — 부분 문자열 매칭 방지
  const detected = new Set();
  for (const [allergen, keywords] of Object.entries(ALLERGEN_KEYWORDS)) {
    for (const keyword of keywords) {
      // \"대두레시틴\" 의 \"대두\" 같은 부분 문자열 매칭 방지를 위해
      // 한국어는 단어 경계가 모호하므로 키워드 길이 ≥ 2 일 때만 부분 매칭 허용
      if (keyword.length < 2) continue;
      if (text.includes(keyword)) {
        detected.add(allergen);
        break;
      }
    }
  }
  return [...detected].sort();
}

// ------------------------------------------------------------
// 5a. detectAllergensV2 — 직접함유/혼입가능/추정 3분리 (#114, 교차자문 반영)
// SOURCE: D:\먹선\IP\korean_label_ocr_rules.md §4 + 자문/알레르기_직접함유_혼입가능_분리_자문_2026-06-29.md
// 마스킹 파이프라인: mayContain 문장 먼저 분류(함유보다 우선) → 명시함유 → 원재료 추론.
// ------------------------------------------------------------

// 명시 표기·혼입 문장에서 쓰는 '공식 19종 이름' 매칭셋(원재료 형태 아님)
const ALLERGEN_NAMES = {
  '난류': ['난류', '계란', '달걀', '알류', '난백', '난황'],
  '우유': ['우유'],
  '메밀': ['메밀'],
  '땅콩': ['땅콩'],
  '대두': ['대두'],
  '밀': ['밀'],
  '고등어': ['고등어'],
  '게': ['게'],
  '새우': ['새우'],
  '돼지고기': ['돼지고기'],
  '복숭아': ['복숭아'],
  '토마토': ['토마토'],
  '아황산류': ['아황산', '이산화황'],
  '호두': ['호두'],
  '닭고기': ['닭고기'],
  '쇠고기': ['쇠고기', '소고기'],
  '오징어': ['오징어'],
  '조개류': ['조개', '굴', '홍합', '전복', '바지락'],
  '잣': ['잣'],
};

// compact: NFKC + 공백/구두점 제거 (OCR 띄어쓰기 붕괴 방어)
function _compact(s) {
  return (s || '').normalize('NFKC').replace(/\s+/g, '').replace(/[·ㆍ,，.。:：;；]/g, '');
}

// 혼입(교차오염) 신호 — compact 기준.
const MAY_CONTAIN_SIGNALS = [
  /같은제조시설/, /동일제조시설/, /같은시설/, /같은제조라인/, /같은라인/, /동일라인/,
  /사용한제품과/, /사용제품과/, /제품과같은/, /혼입가능/, /혼입될수/, /혼입/, /교차오염/,
];
const EXPLICIT_MARKERS = [/함유/, /포함/, /알레르기유발물질/, /알레르기유발성분/, /알레르기정보/, /알러지/];
const INGREDIENT_MARKERS = [/원재료명/, /원재료/, /성분명/, /배합비/];

function _splitSegments(text) {
  // 라벨 키워드 앞에 개행 삽입 → 문장부호·개행으로 분리
  const t = (text || '').replace(
    /(원재료명|원재료|성분명|알레르기\s*유발\s*물질|알레르기\s*유발\s*성분|알레르기\s*정보|영양정보|영양성분|제품명|내용량)/g,
    '\n$1');
  return t.split(/[\n.。!?]+/).map(s => s.trim()).filter(s => s.length >= 2);
}

function _matchSet(segment, table) {
  // 긴 키워드 먼저 매칭·제거 → 짧은 이름의 부분문자열 오탐 방지(예: '메밀'을 먼저 잡아 '밀' 오탐 차단)
  const pairs = [];
  for (const [allergen, kws] of Object.entries(table)) for (const kw of kws) pairs.push([allergen, kw]);
  pairs.sort((a, b) => b[1].length - a[1].length);
  let work = segment;
  const detected = new Set();
  for (const [allergen, kw] of pairs) {
    if (kw && work.includes(kw)) { detected.add(allergen); work = work.split(kw).join(' '); }
  }
  return detected;
}

function _classifySegment(seg) {
  const c = _compact(seg);
  if (MAY_CONTAIN_SIGNALS.some(re => re.test(c))) return 'mayContain';   // ★ 함유보다 먼저
  if (EXPLICIT_MARKERS.some(re => re.test(c))) return 'contains';
  if (INGREDIENT_MARKERS.some(re => re.test(c))) return 'ingredients';
  return 'other';
}

/**
 * @returns {{contains:string[], mayContain:string[], inferred:string[], evidence:object[]}}
 */
function detectAllergensV2(text) {
  const segs = _splitSegments(text || '');
  const contains = new Set(), mayContain = new Set(), inferred = new Set();
  const evidence = [];
  for (const seg of segs) {
    const kind = _classifySegment(seg);
    if (kind === 'other') continue;                 // 전체 텍스트 fallback contains 금지
    const table = kind === 'ingredients' ? ALLERGEN_KEYWORDS : ALLERGEN_NAMES;
    const found = _matchSet(seg, table);
    if (!found.size) continue;
    const bucket = kind === 'mayContain' ? mayContain : kind === 'contains' ? contains : inferred;
    const level = kind === 'ingredients' ? 'inferred' : kind;
    for (const a of found) { bucket.add(a); evidence.push({ allergen: a, level, textSpan: seg.slice(0, 60) }); }
  }
  // 병합 우선순위: contains > inferred(원재료 실제존재) > mayContain(혼입).
  // ★ 원재료에 있는(inferred) 알레르겐을 혼입경고로 강등 금지(누락 방지).
  for (const a of contains) { mayContain.delete(a); inferred.delete(a); }
  for (const a of inferred) { mayContain.delete(a); }
  return {
    contains: [...contains].sort(), mayContain: [...mayContain].sort(),
    inferred: [...inferred].sort(), evidence,
  };
}

// ============================================================
// 5b. 제품 메타정보 추출 (제품명·식품유형·판매원·제조원·내용량·품목보고번호)
// ============================================================

/**
 * 한국 식품 라벨에서 자주 나타나는 라벨-값 패턴.
 * 다음 키워드 중 하나가 등장하면 현재 값을 종료한다.
 */
const META_END_KEYWORDS = [
  '제품명', '상품명', '식품유형', '내용량', '총내용량',
  '유통전문판매원', '판매원', '소분원', '제조원', '제조사', '수입원',
  '품목보고번호', '품목제조번호', '소비기한', '유통기한',
  '보관방법', '포장재질', '반품', '교환', '주의사항',
  '원재료명', '원재료', '영양정보', '영양성분',
  '소재지', '주소', '고객상담', '소비자상담',
];

/**
 * "다음 라벨 키워드까지" 멈추는 lookahead 부분.
 */
const META_END_LOOKAHEAD = `(?=(?:${META_END_KEYWORDS.join('|')})|\\n|$)`;

/**
 * 라벨 ~ 다음 라벨 사이의 값을 잘라내는 헬퍼.
 * @param {string} text - OCR 텍스트
 * @param {string[]} labels - 매칭할 라벨 후보들 (예: ['제품명','상품명'])
 */
function extractByLabels(text, labels) {
  for (const label of labels) {
    // 라벨 + (콜론/슬래시/공백) + 값 + (다음 라벨 또는 줄바꿈)
    const labelEsc = label.replace(/\s/g, '\\s*');
    const re = new RegExp(`${labelEsc}\\s*[:\\/\\-]?\\s*(.+?)\\s*${META_END_LOOKAHEAD}`, 's');
    const m = text.match(re);
    if (m && m[1] && m[1].trim().length > 0) {
      // 트리밍 + 끝의 쉼표·공백·콜론 정리
      return m[1].replace(/[\s,:.\/\-]+$/, '').trim();
    }
  }
  return null;
}

/**
 * OCR 텍스트에서 제품 메타정보를 추출.
 * @param {string} text - 교정된 OCR 텍스트
 * @returns {Object} { product_name, food_type, brand, manufacturer, total_content, content_unit, report_no }
 */
function extractProductMeta(text) {
  const meta = {};

  // 제품명 (상품명) — 한국 라벨에서 일반적으로 가장 위에 위치
  const productName = extractByLabels(text, ['제품명', '상품명']);
  if (productName) meta.product_name = productName;

  // 식품유형 — 다양한 라벨 변형 대응
  // \"식품유형\", \"품목분류\", \"식품의 유형\" 등
  let foodType = extractByLabels(text, ['식품유형', '식품의 유형', '품목분류', '품목유형', '식품 유형']);
  if (!foodType) {
    // 폴백: \"과자(유처리제품)\" 같이 \"식품유형\" 라벨 없이 곧바로 분류명만 OCR에 잡힌 케이스
    // 알려진 한국 식품 분류 키워드를 직접 검색
    const knownTypes = [
      '스낵과자류', '캔디류', '초콜릿류', '빵류', '케이크류',
      '유탕면', '국수', '라면', '과자',
      '음료류', '탄산음료', '주스', '두유', '커피', '차류',
      '발효유', '치즈', '아이스크림류', '우유',
      '김치류', '장류', '젓갈류',
      '복합조미식품', '소스류', '드레싱', '카레',
      '유처리제품', '농축액', '건과류', '견과류',
    ];
    for (const t of knownTypes) {
      // \"식품유형\" 라벨 없이도 단어 하나로 등장하면 가능성 높음
      const re = new RegExp(`(?:^|[\\s,.\\n/])(${t}(?:\\([^)]+\\))?)(?:[\\s,.\\n/]|$)`);
      const m = text.match(re);
      if (m) {
        foodType = m[1].trim();
        break;
      }
    }
  }
  if (foodType) meta.food_type = foodType;

  // 유통전문판매원 (브랜드 소유자) — 사용자에게 의미 있는 식별자
  // \"유통전문판매원\" → \"판매원\" 순서로 시도 (긴 라벨 먼저)
  const brand = extractByLabels(text, [
    '유통전문판매원', '유통판매원', '판매원',
  ]);
  if (brand) meta.brand = brand;

  // 제조원 (실제 제조 공장)
  const manufacturer = extractByLabels(text, [
    '제조원', '제조사', '제조/소분원', '제조 / 소분원', '소분원', '수입원',
  ]);
  if (manufacturer) meta.manufacturer = manufacturer;

  // 내용량 (g, mL, kg, L, 개)
  // ★★ 세션40: 세션39가 parseNutrition(L564)만 고치고 **여기를 놓쳤다**.
  //   같은 결함 2개가 그대로 남아 있었다:
  //     ① `.replace(',', '.')` → "총 내용량 1,500 mL" 를 1.5 로 축소 (1000배 축소, §거짓 초록과 동일 원인)
  //     ② `총` optional → "내용량 1.5L(25℃)" 를 "총 내용량 1,500 mL" 보다 먼저 집음 (해표 콩기름 실물)
  //   이 값은 사장되지 않는다: ocrRoutes L295 → productInfo.total_content
  //     → crowdsourceService → products.total_content 및 servings_per_container(=총량/1회분)
  //   즉 **DB 영구 저장 경로**다. 1.5/120 = 0.0125 인분 같은 값이 들어간다.
  const contentMatch = text.match(
    /총\s*내용량\s*[:\/\-]?\s*(\d[\d,.]*)\s*(g|ml|mL|kg|L|개|정|포)/
  ) || text.match(
    /(?:^|[\s,.\n])내용량\s*[:\/\-]?\s*(\d[\d,.]*)\s*(g|ml|mL|kg|L|개|정|포)/
  );
  if (contentMatch) {
    meta.total_content = parseNum(contentMatch[1]);
    meta.content_unit = contentMatch[2].toLowerCase();
  }

  // 품목보고번호 (식약처 14자리 숫자)
  const reportMatch = text.match(
    /(?:품목\s*보고\s*번호|품목\s*제조\s*번호|품목제조보고번호)\s*[:\/\-]?\s*(\d{10,})/
  );
  if (reportMatch) meta.report_no = reportMatch[1];

  // 짧은 값 정리 — \"에이스\" 같이 1글자도 OK이나 빈 문자열 검증
  for (const k of ['product_name', 'food_type', 'brand', 'manufacturer']) {
    if (meta[k] && (meta[k].length < 1 || meta[k].length > 200)) {
      delete meta[k];
    }
  }

  return meta;
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

  // 알레르기 (기존 flat = 하위호환 유지) + v2 3분리(#114: 직접함유/혼입가능/추정)
  const allergens = detectAllergens(correctedText);
  const allergens_v2 = detectAllergensV2(correctedText);

  // 제품 메타정보 (제품명·식품유형·브랜드·제조원·내용량·품목보고번호)
  const product_meta = extractProductMeta(correctedText);

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
    allergens_v2,
    product_meta,
  };
}

module.exports = {
  extractIngredientSection,
  parseIngredients,
  identifyAdditives,
  parseNutrition,
  detectAllergens,
  detectAllergensV2,
  extractProductMeta,
  analyzeText,
  ADDITIVE_KEYWORDS,
  ALLERGEN_KEYWORDS,
};
