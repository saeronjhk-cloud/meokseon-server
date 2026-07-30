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

  // ★★★ 세션44 서브에이전트 검증 — 여기가 이 파일에서 가장 느린 ReDoS 였다(치명, 선재 결함).
  //   실측(수정 전): 9,900자 입력에 `extractIngredientSection` 단독 **369 ms**.
  //   원인은 extractByLabels 와 같은 3중 구조다:
  //     ① `s` 플래그 하 `(.+?)` = 개행까지 먹는 **무제한 lazy**
  //     ② 그 앞 `\s*[:\s]\s*` 가 같은 공백을 세 수량자로 나눠 먹는다
  //     ③ 뒤가 20개 대안 lookahead → 실패마다 전량 되돌림, 그것을 패턴 3개 × 시작위치마다 반복
  //   → 값에 2,000자 상한을 준다.
  //   ★★ 세션44 2차 검증(경미H) 정정 — 초판 주석은 "아래 fallback 이 이미 `substring(0, 2000)` 으로
  //     자르므로 **동작을 바꾸지 않는다**" 고 적었다. **그건 사실이 아니다.**
  //     `substring(0, 2000)` 은 종료 키워드가 아예 없는 **fallback 분기에만** 있다.
  //     정상 경로는 상한이 없었으므로 이 변경은 **동작을 바꾼다**:
  //       원재료명 3,000자 → s43 2,498자 / s44 1,998자 · 5,000자 → 4,168자 / 1,998자
  //     절단분은 `parseIngredients`·`identifyAdditives`·v2 원재료 추론에서 빠진다.
  //     ★ 68건 실물 최장은 644자(077.txt)이고 상위 5개가 644·526·455·454·449 — 영향 0건이다.
  //       그래도 "동작을 바꾸지 않는다" 고 적은 것은 잘못이었다. 상한은 **의식적인 트레이드오프**다:
  //       2,000자 넘는 원재료명을 잃는 것보다 무인증 DoS 를 막는 것이 우선이다.
  //     구분자 3중 수량자는 단일 문자클래스로 합친다.
  const patterns = [
    new RegExp(`원재료명\\s{0,4}(?:및\\s{0,4})?(?:함량)?[:\\s]{1,8}(.{1,2000}?)${endKeywords}`, 's'),
    new RegExp(`원재료명\\s{0,4}(.{1,2000}?)${endKeywords}`, 's'),
    new RegExp(`원재료[:\\s]{1,8}(.{1,2000}?)${endKeywords}`, 's'),
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    // 임계값 10 → 3 으로 완화: OCR이 짧게 잘라도 \"밀가루\" 같은 한 단어라도 받음
    if (match && match[1].trim().length >= 3) {
      return _stripAllergenSuffix(match[1].trim());
    }
  }

  // 라면류 특수 케이스
  const ramenPattern = new RegExp(`\\*?면\\s{0,4}[:]\\s{0,4}(.{1,2000}?)${endKeywords}`, 's');   // 세션44: 상한(ReDoS)
  const ramenMatch = cleaned.match(ramenPattern);
  if (ramenMatch && ramenMatch[1].trim().length >= 3) {
    return _stripAllergenSuffix(ramenMatch[1].trim());
  }

  // 종료 키워드가 텍스트에 전혀 없는 경우 — \"원재료명\" 시작 후 끝까지 추출
  const fallbackPatterns = [
    // ★ 세션44: 구분자 3중 수량자 합침(ReDoS). `(.+)` 는 greedy·상한 뒤 substring(0,2000) 이므로 유지.
    /원재료명\s{0,4}(?:및\s{0,4})?(?:함량)?[:\s]{1,8}(.+)/s,
    /원재료[:\s]{1,8}(.+)/s,
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
  // ★★★ 세션44 서브에이전트 검증 — 여기가 ReDoS 였다(치명, 선재 결함).
  //   세션43 은 `detectAllergens` 안의 **같은 형태 정규식 2개**를 고쳤다고 기록했지만
  //   같은 파일 이 줄은 보지 않았다. 세션43 이 스스로 문서화한 결함 유형과 정확히 같다:
  //   「lazy 문자클래스에 `\s` 가 있고 바로 앞·뒤 `\s*` 도 공백을 먹는다」
  //   실측(수정 전): `밀가루` + 공백 104자 65 ms / 204자 202 ms / 404자 **3,156 ms** / 804자 **>39초**
  //   → 앞뒤 `\s*` 를 없앤다(문자클래스가 이미 `\s` 를 포함하므로 의미는 같고 모호성만 사라진다).
  //     lazy 수량자에 상한 200 을 준다 — 알레르기 표기 줄이 200자를 넘지 않는다.
  result = result.replace(
    /[♥⚠★◆■▲▼☆◎●○]?[가-힣A-Za-z\s,()·\.0-9]{1,200}?함유\s{0,4}[♥⚠★◆■▲▼☆◎●○]?\s{0,4}\.?\s{0,4}$/g,
    '',
  );

  // 2) "알레르기 유발물질: …" 끝부분 제거
  // ★★★ 세션44 2차 검증 — **여기가 이 파일에서 마지막까지 남아 있던 ReDoS 였다(치명).**
  //   1차 수정에서 "패턴 2곳을 고쳤다" 고 적었지만 실제로 고친 것은 패턴1과 패턴4 였고
  //   그 사이의 이 줄은 손대지 않았다. 커밋 주석이 사실과 달랐다.
  //   상한 없는 `\s*` 가 **3개** + 뒤에 `[가-힣\s,()·\.]+$`(공백 포함 클래스, 끝 앵커).
  //   같은 공백을 4개 수량자가 나눠 먹는다.
  //   실측(수정 전, `원재료명: 알레르기` + 공백 N + `x` → analyzeText):
  //     111 B 82 ms / 211 B 1,146 ms / 311 B 5,604 ms / **411 B 18,055 ms**
  //   ★ 411바이트다. `MAX_OCR_TEXT_LENGTH`(10,000) 절단은 방어가 전혀 되지 않는다.
  //     Vision OCR 을 거치지 않는 `ingredients_text` 경로라 공격 비용이 0이다.
  //   ★ 1차 검증의 적대적 배터리 20종에 `알레르기`+공백 형태가 하나도 없어서 테스트가 초록이었다.
  //     → 교훈: 배터리는 **정규식의 리터럴 접두어**에서 역으로 만들어야 한다. 상상으로 고르면 빈다.
  //   → 앞뒤 `\s*` 를 문자클래스 하나로 합치고, 꼬리 수량자에 상한을 준다.
  result = result.replace(
    /(?:알레르기|알러지)\s{0,4}(?:유발\s{0,4}물질)?[:：\s]{0,8}[가-힣\s,()·\.]{1,200}$/g,
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
    // ★★ 세션44 — 여기도 ReDoS 였다. `[,·\/\s)]+` 와 뒤의 `\s*` 가 **같은 공백을 나눠 먹는다.**
    //   게다가 이 match 는 while 루프 안이라 비용이 반복 곱해진다.
    //   실측(수정 전): 1,200자 입력 하나에 **816 ms**. 9,900자면 분 단위다.
    //   → 문자클래스에 이미 `\s` 가 있으므로 뒤 `\s*` 를 없애고 상한을 준다.
    //     구분자가 20자를 넘는 라벨은 없다.
    const lastItemMatch = result.match(/[,·\/\s)]{1,20}([가-힣]{1,5})\s{0,4}\.?\s{0,4}$/);
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
  text = text.replace(/[,，\s]{0,8}(함유|포함|사용)\s{0,4}$/, '');   // 세션44: 상한(ReDoS)
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
      // ★★ 세션44 — `\d+[.,]?\d*` 는 숫자런에서 모호하다(`\d+` 와 `\d*` 가 같은 숫자를 나눠 먹는다).
      //   실측(수정 전): 숫자 1,200자 **620 ms**. → 소수부는 구분자를 **필수**로 묶어 모호성을 없앤다.
      const pctMatch = ing.match(/(\d{1,12}(?:[.,]\d{1,6})?)\s{0,4}%/);
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
// ★ 세션40 발견 / 세션42 역이식 — `용기`.
//   캡처 019(신라면컵) 라벨이 "1용기(65 g)당" 인데 어휘 목록에 없어서 basis 가 unknown 으로 떨어졌다.
//   **라벨에 답이 적혀 있는데 어휘가 없어 못 읽은 것.** 하마터면 RACC 추정으로 넘어갈 뻔했다.
//   어휘 확장이 1차, 추정은 최후다. 그릇/팩/매/줄/판/알/쪽/덩이는 실물에서 흔한 단위어(예방적).
const BASIS_SERVING = /1\s{0,4}(?:회\s{0,4}제공량|회분|회|봉지|봉|개입|개|포|스틱|컵|캔|병|조각|장|인분|용기|그릇|팩|매|줄|판|알|쪽|덩이)\s{0,4}\(?\s{0,4}(\d[\d,.]{0,12})\s{0,4}(g|㎖|ml|mL|kg|L)\s{0,4}\)?\s{0,4}당/;
// ★ 세션40 발견 / 세션42 역이식 — 앞에 "1+단위어" 가 없는 단독 표기.
//   캡처 027(쇠고기볶음고추장) 실물 "60 g 당 140 kcal".
//   BASIS_PER100 을 **먼저** 검사하므로 "100 g 당" 이 여기로 새지 않는다. 순서가 안전장치다.
//   ★★ 세션42 검증에서 잡힌 치명 결함 — `당` 뒤에 경계가 없으면 **한국 표준 영양성분표를 오독한다.**
//     탄수화물 250 g
//     당류 0 g
//   → `250 g` + `\s*`(개행) + `당`(당류의 첫 글자) 이 매칭돼 **basis=per_serving, serving=250** 이 된다.
//   그러면 per_total 환산이 통째로 우회되고, 고치려던 032 떡국떡 거짓 빨강이 그대로 재발한다.
//   (`당류`·`당알코올`·`당분` 전부 해당. serving_size 에 탄수화물 그램수가 들어가는 2차 피해까지 있었다.)
//   → `당` 뒤에 한글이 오면 매칭하지 않는다. "60 g 당 140 kcal" 는 뒤가 공백이라 통과한다.
//   ⚠ scripts/lib/capture_label_parser.js RE_SERVING_BARE 도 같은 결함이 있었다. 함께 고쳤다.
const BASIS_SERVING_BARE = /(?:^|[\s\n(])(\d[\d,.]*)\s*(g|㎖|ml|mL|kg|L)\s*당(?![가-힣])/;
// "총 내용량 당" · "총 내용량 500 g당" — 둘 다 총량 기준이다.
// ★ BASIS_SERVING_BARE 보다 **먼저** 검사한다. 안 그러면 "총 내용량 500 g당" 이 1회분 500g 이 된다.
// ★★★ 세션44 서브에이전트 검증 — 두 가지를 함께 고쳤다.
//   ① ReDoS: 상한 없는 수량자가 4개(`\s*` `[:\s]*` `[\d,.]*` `\s*`)였다.
//      실측 `detectNutritionBasis` 에서 O(n³) — 1,605자 1,065 ms / 3,200자 7,746 ms.
//      9,900자면 250초 추정. 무인증 `POST /api/ocr/analyze` 로 도달한다.
//   ② `당` 경계 누락 — 세션42 치명(BASIS_SERVING_BARE 의 `당류` 오독)과 **완전히 같은 결함**이
//      이 정규식에는 남아 있었다. `총 내용량 180 g` + 다음 줄 `당류 11 g` 에서
//      「당류」의 첫 글자를 기준 표기로 읽어 **per_total** 이 된다.
//      per_total 은 RACC 로 한 번 더 나누므로 방향은 **거짓 초록**이다.
//      → `(?![가-힣])`. "총 내용량 당 (1일…)" 은 뒤가 공백이라 통과한다.
//   ⚠ scripts/lib/capture_label_parser.js RE_TOTAL_BASIS 와 **문자 단위로 같아야 한다**
//     (tests/test_parser_parity.js 가 검사한다).
const BASIS_TOTAL = /총\s{0,4}내용량\s{0,4}(?:[:\s]{0,4}[\d,.]{0,12}\s{0,4}(?:g|㎖|ml|mL|kg|L)\s{0,4})?당(?![가-힣])/;
// 라벨에 1회 제공량이 따로 적혀 있으면 "총 내용량 X" 단독 규칙을 억제한다(세션42 검증 중대5).
//   "총 내용량 500g  1회 제공량 100g" 을 per_total 로 보면 RACC 로 **한 번 더** 나눠 거짓 초록이 된다.
const HAS_SERVING_DECLARED = /1\s*회\s*(?:제공량|분|섭취량)|1회\s*제공\s*기준/;
// ★ 세션40 발견 / 세션42 역이식 — "총 내용량 X" 만 있고 기준 문구가 없는 유형.
//   캡처 68건 중 28건으로 **최대 집단**이다. 단품 포장은 1회분 = 총 내용량이라
//   라벨에 "당" 을 쓰지 않는다(예: "총 내용량 62 g" / 다음 줄 "315 kcal").
//   이건 추정이 아니다. 라벨이 "이 표는 총 내용량 기준" 이라고 말하고 있는 것이다.
//   ※ 168 g 과자를 한 번에 먹지 않는다는 건 별개 문제다 — basis 가 아니라 **1회 섭취량**이고
//     식약처 RACC 가 담당한다(servingResolver + nutritionTrafficLight per_total 환산, 세션42).
const BASIS_TOTAL_AMOUNT = /총\s*내용량[:\s]{0,20}(\d[\d,.]*)\s*(g|㎖|ml|mL|kg|L)/;

// ★ 세션44 — OCR 이 라벨 핵심어를 글자 단위로 쪼개는 경우를 입구에서 되붙인다.
//   `내 용 량` → `내용량` (캡처 096 "총 내용 량 당"). 다른 낱말과 충돌할 여지가 없는 조합만 다룬다.
//   ⚠ 이 함수는 **앱·정본 두 파서가 문자 단위로 같아야 한다**(tests/test_parser_parity.js 가 검사).
// ★ 공백 위치를 가정하지 않는다 — 096 실물은 「내용 량」 이었다(내·용 사이가 아니라 용·량 사이).
//   `{1,3}` 로 첫 공백을 강제했다가 실제 케이스를 못 잡았다. 둘 다 0회 허용(그 경우 무변화 치환).
// ★★ 세션44 서브에이전트 검증(경미10) — 초판은 앞 경계가 없어 무관한 낱말도 바꿨다:
//   `국내 용량`→`국내용량` · `안내 용량` · `체내 용량` · `사내 용량제`.
//   실害는 0건이었지만 주석은 "충돌 여지가 없다" 고 단정했고 그건 사실이 아니었다.
//   → `내` 앞에 구분자(또는 문자열 시작)를 요구한다. `국내`·`안내`·`체내` 는 앞이 한글이라 제외된다.
const RE_SPLIT_CONTENT_WORD = /(^|[\s:：(,.\n])내\s{0,3}용\s{0,3}량/g;
function normalizeLabelSpacing(text) {
  return String(text ?? '').replace(RE_SPLIT_CONTENT_WORD, '$1내용량');
}

function detectNutritionBasis(text) {
  // ★★ 세션44 서브에이전트 검증(중대8) — 정규화가 `parseNutrition` 입구에만 있었다.
  //   그래서 같은 모듈의 두 export 가 **같은 텍스트에 다른 답**을 냈다:
  //     parseNutrition(096)._basis = per_total  /  detectNutritionBasis(096) = unknown
  //   `ocrRoutes.judgeNutrition` 의 basis 폴백이 쓰는 경로가 후자다.
  //   `/multi-photo` 에서 기준 문구가 라벨 사진 쪽에 찍히면 basis 가 unknown 으로 떨어져
  //   신호등이 per_serving 으로 강등한다 → 총량을 1회분으로 판정(거짓 빨강).
  //   → 이 함수도 입구에서 정규화한다. 치환은 멱등이라 두 번 돌아도 안전하다.
  text = normalizeLabelSpacing(text);
  const m100 = text.match(BASIS_PER100);
  if (m100) {
    const u = m100[1].toLowerCase();
    return { basis: (u === 'ml' || u === '㎖') ? 'per_100ml' : 'per_100g', amount: 100, unit: u };
  }
  const ms = text.match(BASIS_SERVING);
  if (ms) return { basis: 'per_serving', amount: parseNum(ms[1]), unit: ms[2].toLowerCase() };
  // ★ 순서: 총 내용량 명시 기준("총 내용량 당" / "총 내용량 500 g당")을 bare 보다 먼저 본다.
  if (BASIS_TOTAL.test(text)) return { basis: 'per_total', amount: null, unit: null };
  const mb = text.match(BASIS_SERVING_BARE);
  if (mb) return { basis: 'per_serving', amount: parseNum(mb[1]), unit: mb[2].toLowerCase(), bare: true };
  const mt = text.match(BASIS_TOTAL_AMOUNT);
  if (mt && !HAS_SERVING_DECLARED.test(text)) {
    return { basis: 'per_total', amount: null, unit: mt[2].toLowerCase(), from_total_only: true };
  }
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
/**
 * ★★ 세션42 수정 — 기존 gap 인 `\D{0,40}?` 는 **다음 영양소 줄까지 건너뛴다.**
 * 캡처 019 실물(단일 컬럼 라벨)에서 재현:
 *     탄수화물 49 g
 *     당류 3 g
 *   → `탄수화물 49 g` + gap `\n당류 ` + `3 g` 가 dual 로 매칭돼
 *     nutrition._total.total_carbs = **3** (당류 값)이 들어간다.
 *   1회분 값(group1)은 맞아서 신호등은 무사했지만, `_total` 은 클라이언트가
 *   "라벨 명시 총량" 으로 신뢰하는 값이다. 오염된 채 나가고 있었다.
 *
 * 수정: gap 에서 **다른 영양소 레이블을 만나면 중단**한다(tempered dot).
 *   진짜 dual-column 라벨의 gap 은 "미만"·공백·%·괄호뿐이라 영향이 없다.
 *   ("0.5 g 미만    1 g 미만" 같은 실물 표기는 그대로 통과한다.)
 */
const DUAL_STOP_WORDS = [
  '열량', '칼로리', '탄수화물', '당류', '당알코올', '단백질', '포화지방', '트랜스지방',
  '지방', '콜레스테롤', '나트륨', '식이섬유', '칼슘', '칼륨', '마그네슘', '아연', '비타민',
  '내용량', '제공량',
];
/** 영양소 레이블을 만나기 전까지만 건너뛰는 gap */
function dualGap(max) {
  return `(?:(?!${DUAL_STOP_WORDS.join('|')})\\D){0,${max}}?`;
}
const _G30 = dualGap(30);
const _G40 = dualGap(40);

const NUTRIENT_PATTERNS_DUAL = {
  calories:      new RegExp(`열량[:\\s\\n]*(\\d+[.,]?\\d*)\\s*(?:kcal|Kcal|킬로칼로리)${_G30}(\\d+[.,]?\\d*)\\s*(?:kcal|Kcal|킬로칼로리)`, 'i'),
  total_carbs:   new RegExp(`탄수화물[:\\s\\n]*(\\d+[.,]?\\d*)\\s*g${_G40}(\\d+[.,]?\\d*)\\s*g`),
  total_sugars:  new RegExp(`당류[:\\s\\n]*(\\d+[.,]?\\d*)\\s*g${_G40}(\\d+[.,]?\\d*)\\s*g`),
  protein:       new RegExp(`단백질[:\\s\\n]*(\\d+[.,]?\\d*)\\s*g${_G40}(\\d+[.,]?\\d*)\\s*g`),
  total_fat:     new RegExp(`(?<!포화)(?<!트랜스)지방[:\\s\\n]*(\\d+[.,]?\\d*)\\s*g${_G40}(\\d+[.,]?\\d*)\\s*g`),
  saturated_fat: new RegExp(`포화지방(?:산)?[:\\s\\n]*(\\d+[.,]?\\d*)\\s*g${_G40}(\\d+[.,]?\\d*)\\s*g`),
  trans_fat:     new RegExp(`트랜스지방(?:산)?[:\\s\\n]*(\\d+[.,]?\\d*)\\s*g${_G40}(\\d+[.,]?\\d*)\\s*g`),
  cholesterol:   new RegExp(`콜레스테롤[:\\s\\n]*(\\d+[.,]?\\d*)\\s*m?g${_G40}(\\d+[.,]?\\d*)\\s*m?g`),
  sodium:        new RegExp(`나트륨[:\\s\\n]*(\\d+[.,]?\\d*)\\s*m?g${_G40}(\\d+[.,]?\\d*)\\s*m?g`),
  dietary_fiber: new RegExp(`식이섬유[:\\s\\n]*(\\d+[.,]?\\d*)\\s*g${_G40}(\\d+[.,]?\\d*)\\s*g`),
};

/**
 * OCR 텍스트에서 영양정보를 추출합니다.
 * @param {string} text
 * @returns {Object}
 */
/**
 * ★★ 세션40 발견 / 세션42 역이식 — 배수 표기 kcal 은 **총량**이다.
 * 캡처 019(신라면컵) 실물 전사:
 *     중량:390 g(65 g×6입)
 *     열량:1,800 kcal(300 kcal×6입)     ← 오답
 *     총 내용량 390 g(65 g×6공기)
 *     1용기(65 g)당 300 kcal            ← 정답
 *
 * 이 줄을 지우지 않으면 NUTRIENT_PATTERNS_DUAL.calories 가 먼저 돌면서
 *   group1=1,800 → nutrition.calories (1회분으로)
 *   group2=300   → nutrition._total.calories (총량으로)
 * 로 **1회분과 총량이 정확히 뒤집힌 채** 들어간다. 단순 6배 오집이 아니다.
 * 결과는 열량 6배 과대 = 신호등 **거짓 빨강**. 멀쩡한 라면이 위험 식품이 된다.
 * (세션39 거짓 초록의 반대 방향이지만 같은 등급의 결함이다.)
 *
 * → 그래서 이 제거는 1a(dual) **이전**에 돌아야 한다. 순서가 곧 수정 내용이다.
 *
 * ★ 왜 kcal 로만 한정하나 — 캡처 68건 전수 grep 결과 `X kcal(Y kcal×N)` 형태는 019 단 1건,
 *   mg·g 배수표기는 **0건**이다. 나머지 배수표기는 전부 중량("600 g (120 g×5봉지)")이라
 *   영양소 패턴에 걸리지 않는다. 근거 없이 나트륨 등으로 일반화하지 않는다.
 *
 * ★ 괄호 안 개당값(Y)은 버리지 않고 최후 후보로 보존한다.
 *   "당" 표기가 아예 없는 라벨에서는 Y 가 유일한 정답이 되기 때문.
 *
 * 정답본: scripts/lib/capture_label_parser.js extractCalories (63-eval 123/123 검증)
 */
// ⚠ 이 정규식은 `g` 플래그다. `.test()` / `.exec()` 로 쓰면 lastIndex 가 남아 결과가 흔들린다.
//   **`String.replace` 로만 쓸 것.**(replace 는 호출 전후로 lastIndex 를 0 으로 리셋한다)
// ★★ 세션42 검증 — 초판은 `[:\s]{0,20}` 였다. 두 수량자가 공백을 **양쪽 다** 먹어
//   공백이 길게 이어진 입력에서 백트래킹이 폭발했다(3 KB 입력 5.2초, 4 KB 40초 초과).
//   ocrRoutes 가 `analyze` 에서 사용자 입력 `ingredients_text` 를 그대로 analyzeText 에 넣으므로
//   **인증 없이 요청 1건으로 이벤트 루프를 정지**시킬 수 있었다. → `[:\s]*` 하나로 축약.
// ★★ 세션43 실측 — 세션42 의 `[:\s]*` 축약으로도 아직 느렸다.
//   `([\d,.]+)` 두 개가 상한이 없어서, 숫자·콤마가 길게 이어지고 뒤에 `kcal` 이 없는 입력에서
//   시작 위치마다 전체를 훑는다. `총 내용량 1,1,1,…(8 KB) g (500 kcal)` 실측 **82 ms**.
//   MAX_OCR_TEXT_LENGTH 가 10,000 이므로 이 입력은 **절단되지 않고 그대로 통과**한다.
//   요청 1건이 이벤트 루프를 82 ms 잡는다 — 치명2와 같은 종류의 결함이고, 정도만 작다.
//   → 라벨의 숫자는 12자를 넘지 않는다. 전부 상한을 준다(실측 82 ms → 0.3 ms).
// ★★★ 세션43 검증 추가 — 숫자에 상한을 줘도 **아직 느렸다**(9,900자 공백 실측 73 ms, 탭 혼합 105 ms).
//   남은 원인은 `[:\s]*` 다. 상한이 없어서 시작 위치마다 공백 전체를 greedy 로 삼켰다가 되돌린다.
//   → O(n²). 라벨의 `열량:` 과 값 사이는 8자를 넘지 않는다. 상한을 준다.
//   교훈: "수량자 하나를 고쳤다" 로 끝내면 안 된다. **정규식의 모든 수량자에 상한이 있는지** 본다.
const RE_KCAL_MULTIPLIER =
  /(?:열량|칼로리)?[:\s]{0,20}([\d,.]{1,12})\s{0,4}kcal\s{0,4}[(（]\s{0,4}([\d,.]{1,12})\s{0,4}kcal\s{0,4}[×xX*]\s{0,4}\d{1,4}[^)）]{0,20}[)）]/gi;

function stripCalorieMultiplier(text) {
  const removed = [];
  let perUnit = null;
  const cleaned = String(text ?? '').replace(RE_KCAL_MULTIPLIER, (s, outer, per) => {
    const o = parseNum(outer);
    const p = parseNum(per);
    // ★ 세션42 검증 — 순서 가정을 검사한다.
    //   정상형(019): "1,800 kcal(300 kcal×6입)" → 바깥이 총량, 괄호 안이 개당. 바깥 > 안.
    //   역순형:      "300 kcal(1,800 kcal×6입)" → 이걸 지우면 **정답 300 을 버리고 1,800 을 남긴다.**
    //   바깥이 더 작으면 배수 표기가 아니라고 보고 **건드리지 않는다.**
    if (o != null && p != null && o < p) return s;
    removed.push(s.trim());
    if (perUnit == null) perUnit = p;
    return ' ';
  });
  return { cleaned, removed, perUnit };
}

/**
 * ★★ 세션43 — 괄호 총열량 (`026`·`082`·`006` 형). 세션41 §5-1 이월 과제.
 *
 * 배수표기(`X kcal(Y kcal×N)`)와 **다른 유형**이다. 괄호 안에 kcal 이 하나뿐이고 배수가 없다.
 *   026 코피코캔디: `내 용 량: 384 g (32 g x 12개) (1,740 kcal)`  ← 총 384 g 의 열량
 *                   `1개입(32 g)당 145 kcal`                      ← 정답(1회분)
 *   082 국산콩두부: `600 g(300 g x 2) (490 kcal)`                 ← 내용량 레이블조차 없다
 *                   `1 개 (300 g) 당 245 kcal`                    ← 정답
 *   006 대천김:     `총 내용량 30g(155 Kcal)`                      ← 총량=1회분이라 이게 정답
 *
 * ★ 무엇이 위험한가 — 이 값은 **문서에서 가장 먼저 등장하는 kcal** 이다.
 *   최후 fallback `/(\d+)\s*kcal/` 는 "가장 먼저 나온 것" 을 집는다.
 *   `당` 표기가 OCR 에서 한 글자라도 깨지면 026 은 1,740(12배) · 082 는 490(2배) 이 1회분으로 들어간다.
 *   방향은 019 배수표기와 같다 — **거짓 빨강**. 019 는 6배였고 026 은 12배다.
 *
 * ★ 그런데 006 은 이 값이 **유일한 정답**이다. 그래서 지우기만 하면 안 된다.
 *   → 후보 풀에서는 빼고(1회분으로 절대 집히지 않게), 값은 총량으로 보존한다.
 *     1회분 후보가 전부 실패했고 기준이 총량일 때만 이 값을 쓴다(step 2b).
 *
 * ★ 왜 두 패턴인가 — 082 는 `내용량` 이라는 글자가 없다. 앞의 중량 표기에만 붙어 있다.
 *   A: 내용량 레이블 기반   B: 중량(g/ml) + 괄호 kcal 구조 기반
 *   B 는 `1회 제공량 30 g (150 kcal)` 처럼 **1회분 선언**이 같은 줄에 있으면 적용하지 않는다.
 *   그 경우 괄호 안은 총량이 아니라 1회분 열량이므로, 지우면 정답을 버린다.
 *
 * ⚠ 두 정규식 모두 `g` 플래그 — `String.replace` 로만 쓸 것(RE_KCAL_MULTIPLIER 와 같은 주의).
 * ⚠ ReDoS(세션42 치명2) 재발 방지: 간격은 전부 **상한이 있는** 수량자다(`{0,60}` 등).
 *   공백을 양쪽에서 먹는 수량자 중복(`[:\s]{0,20}`)을 만들지 않았다.
 */
// ★ 앞부분(prefix)을 별도 그룹으로 잡는다 — **괄호만** 지우고 중량 표기는 남긴다.
//   초판은 매치 전체를 지웠고, 그러면 006 의 `총 내용량 30g(155 Kcal)` 에서
//   `총 내용량 30g` 까지 함께 사라져 total_content 와 basis(per_total) 가 통째로 날아간다.
//   지워야 하는 것은 "1회분 후보로 오해될 kcal" 뿐이다.
const RE_CONTENT_TOTAL_KCAL_LABELED =
  /((?:총\s*)?내\s*용\s*량[^\n]{0,60}?)[(（]\s*(\d[\d,.]{0,12})\s*k?cal\s*[)）]/gi;
const RE_CONTENT_TOTAL_KCAL_BARE =
  /(\d[\d,.]{0,12}\s*(?:g|kg|ml|mL|L|㎖|㎏)[^\n]{0,40}?)[(（]\s*(\d[\d,.]{0,12})\s*k?cal\s*[)）]/gi;

// 괄호 앞에 이것이 있으면 괄호 안 kcal 은 총량이 아니라 **1회분**이다 → 건드리지 않는다.
// 예: `1회 제공량 30 g (150 kcal)` — 여기서 150 은 1회분 열량이고, 지우면 정답을 버린다.
//
// ★★ 세션43 검증에서 잡힌 결함 — 초판은 `당[\s:]` 였다.
//   `당` + 공백은 **원재료명에 흔하다**: `포도당 5%`, `정백당 ,`, `설탕 ` …
//   표가 한 줄로 평탄화된 라벨(캡처 048·065 형)에서 원재료와 총열량이 같은 줄에 오면
//   총열량 제거가 통째로 억제되고, `당` 표기가 깨지면 1,740(12배)이 그대로 1회분으로 들어갔다.
//   → `숫자+단위+당` 형태로 좁힌다. `포도당`·`설탕`·`당류` 는 앞이 한글이라 걸리지 않는다.
//
// ★★ 그리고 **괄호보다 앞에 있을 때만** 억제한다(위치 검사).
//   `총 내용량 400 g (1,600 kcal) 1회 제공량 100 g` 처럼 1회분 선언이 **뒤에** 오면
//   괄호는 앞의 총 내용량에 붙은 것이므로 제거해야 한다. 초판은 줄 전체를 봐서 이것도 억제했다.
const RE_SERVING_DECLARED_INLINE =
  /1\s{0,4}회\s{0,4}(?:제공량|분(?![야])|섭취량|섭취참고량)|\d\s{0,4}(?:g|kg|ml|mL|L|㎖|㎏|개입|개|봉지|봉|포|스틱|컵|캔|병|조각|장|매|줄|판|알|쪽|인분|용기|그릇|팩)\s{0,4}\)?\s{0,4}당(?![가-힣])/;

/**
 * offset 이 속한 줄에서 **offset 앞부분만** 잘라낸다.
 * 1회분 선언이 괄호보다 앞에 있을 때만 "이 괄호는 1회분 열량" 이라고 볼 수 있다.
 * 뒤에 있으면 그 선언은 다른 값에 붙은 것이다.
 * ⚠ CRLF: `\r` 은 남지만 검사 정규식에 영향이 없다(`\s` 에 포함).
 */
function linePrefixBefore(text, offset) {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  return text.slice(start, offset);
}

function stripContentLineTotalCalories(text) {
  const removed = [];
  let totalCalories = null;

  // ★★ 검사 대상은 매치 문자열이 아니라 **매치가 놓인 줄의 앞부분** 이다.
  //   ① 매치만 검사하면 안 된다 — BARE 매치는 `30 g (150 kcal)` 에서 시작하므로
  //      `1회 제공량 30 g (150 kcal)` 에서 `1회 제공량` 이 매치 밖에 있고,
  //      그 결과 **1회분 열량 150 을 총열량으로 오인**해 지워 버렸다.
  //   ② 줄 전체를 검사해도 안 된다 — `총 내용량 400 g (1,600 kcal) 1회 제공량 100 g` 처럼
  //      선언이 괄호 **뒤에** 오면 그 괄호는 총량이므로 제거해야 하는데 억제됐다.
  //   → 괄호 시작 위치까지의 앞부분만 본다.
  const take = (raw, kcalStr, offset, whole) => {
    const v = parseNum(kcalStr);
    if (v == null) return false;
    const rel = Math.max(raw.lastIndexOf('('), raw.lastIndexOf('（'));   // kcal 을 감싼 괄호
    const prefix = linePrefixBefore(whole, rel >= 0 ? offset + rel : offset);
    if (RE_SERVING_DECLARED_INLINE.test(prefix)) return false;
    removed.push(raw.trim());
    if (totalCalories == null) totalCalories = v;
    return true;
  };

  const src = String(text ?? '');
  let cleaned = src.replace(
    RE_CONTENT_TOTAL_KCAL_LABELED,
    (s, prefix, kcal, offset, whole) => (take(s, kcal, offset, whole) ? `${prefix} ` : s)
  );
  cleaned = cleaned.replace(
    RE_CONTENT_TOTAL_KCAL_BARE,
    (s, prefix, kcal, offset, whole) => (take(s, kcal, offset, whole) ? `${prefix} ` : s)
  );
  return { cleaned, removed, totalCalories };
}

function parseNutrition(text) {
  const nutrition = {};
  const nutritionTotal = {}; // 라벨에 명시된 전량 컬럼 값

  // 1y) ★ 세션44 — OCR 이 「내용량」을 「내 용 량」 으로 쪼개는 사례.
  //   캡처 096 실물: "※ 총 내용 량 당 (1일 영양성분 기준치에 대한 비율)"
  //   `총\s*내용량` 은 내용량이 붙어 있어야 하므로 이 라벨은 basis=unknown 으로 떨어졌고,
  //   신호등은 unknown 을 per_serving 으로 취급한다 — **총량이 1회분으로 판정**된다.
  //   라벨에 답("총 내용량 당")이 적혀 있는데 띄어쓰기 때문에 못 읽은 것이다.
  //   ★ 규칙을 여러 정규식에 흩뿌리지 않고 **입구에서 한 번** 정규화한다.
  //     정규식마다 `내\s*용\s*량` 을 넣으면 앱·정본 양쪽 6곳을 동기화해야 한다(갈라질 지점이 6개).
  //   상한을 둔다(세션43 교훈) — 라벨의 글자 사이 공백은 3자를 넘지 않는다.
  //   ⚠ scripts/lib/capture_label_parser.js parseLabel 에 **같은 정규화**가 있다.
  text = normalizeLabelSpacing(text);

  // 1z) ★ 배수 표기 kcal 제거 — dual/single 어떤 패턴보다 먼저여야 한다 (세션42)
  const _mult = stripCalorieMultiplier(text);
  text = _mult.cleaned;

  // 1z-2) ★ 괄호 총열량 제거 — 배수표기 제거 **뒤**여야 한다 (세션43)
  //   순서가 안전장치다. 019 의 `1,800 kcal(300 kcal×6입)` 는 배수 규칙이 먼저 소화해야 한다.
  //   먼저 이 규칙이 돌면 `(300 kcal×6입)` 은 닫는 괄호 앞에 `×6입` 이 있어 매칭되지 않지만,
  //   순서를 뒤집을 이유도 없다. 규칙은 좁은 것부터.
  const _ctk = stripContentLineTotalCalories(text);
  text = _ctk.cleaned;

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
      // ★ 세션43: `[\d,]+` 상한 없음 → 8 KB 입력 실측 77 ms. 라벨 숫자는 12자를 넘지 않는다.
      .replace(/[\d,]{1,12}\s*kcal\s*기준[^\n]*/g, ' ')
      .replace(/총\s*[\d,.]{1,12}\s*kcal[^\n]*/g, ' ');
    // ★ 세션43: `총?\s*내용량` 의 `총?` 이 빈 문자열로 통과하고 `\s*` 가 상한이 없어서,
    //   공백 9,900자 입력에서 시작 위치마다 공백 전체를 삼켰다 되돌린다 → O(n²), 실측 96 ms.
    //   `1회[\s(]*` · `[\s)]*` 도 같다. 라벨 표기에서 이 간격은 4자를 넘지 않는다.
    const altCalorie = cleaned.match(
      /(?:1회[\s(]{0,4}\d{1,6}\s{0,4}g?[\s)]{0,4}당|1회\s{0,4}제공량\s{0,4}당|총?\s{0,4}내용량\s{0,4}당)\s{0,4}(\d+(?:[.,]\d+)?)\s{0,4}kcal/i
    )
      // "1봉지(120g)당 500 kcal" · "1개(12g)당 50 kcal" — '1회' 가 아닌 실제 표기(세션39 실물)
      || cleaned.match(/당\s{0,4}(\d[\d,.]{0,12})\s{0,4}kcal/i)
      // ★ 세션43: 여기에 `i` 가 없어서 캡처 006 `총 내용량 30g(155 Kcal)` 의 열량이
      //   통째로 누락되고 있었다(대문자 K). 정본 capture_label_parser 는 처음부터 `i` 였다.
      // ★ 세션44: 상한 추가(ReDoS — 수정 전 숫자 2,400자에서 16 ms, O(n²)).
      //   ★ 형태를 정본 `capture_label_parser.js` 최후 fallback 과 **동일하게** 맞췄다.
      //     `\d{1,12}(?:[.,]\d{1,6})?` 로 쓰면 `12,345,678 kcal` 처럼 콤마가 2개인 값에서
      //     정본과 다른 답을 낼 수 있다. 두 파서가 갈라지는 것이 이 프로젝트의 반복 사고다.
      || cleaned.match(/(\d[\d,.]{0,12})\s{0,4}kcal/i);
    if (altCalorie) {
      nutrition.calories = parseNum(altCalorie[1]);
    } else if (_mult.perUnit != null) {
      // 라벨에 "…당 N kcal" 이 아예 없는 경우에만 배수표기 괄호 안 개당값을 쓴다.
      // 라벨 명시값 우선 — 여기까지 왔다는 건 명시값이 없다는 뜻이다.
      nutrition.calories = _mult.perUnit;
    }
  }

  // 3) 1회 제공량 — \"1회 30g\" / \"1회(30g)\" / \"1회 제공량 30g\" / \"1회분 30g\"
  // 기존 정규식이 \"1회 제공량\" 과 \"총 내용량\" 을 둘 다 매칭해 혼동되던 문제 수정
  const servingMatch = text.match(
    // ★★★ 세션44 서브에이전트 검증 — 여기가 ReDoS 였다(치명, 선재 결함).
    //   공백을 먹는 수량자가 **4개 연속**이다: `\s*` `[(\[]?` `\s*` `(?:…)?` `\s*` `[:\s(]*`
    //   `[:\s(]*` 도 공백을 먹으므로 같은 공백을 나눠 먹는 조합이 폭발한다.
    //   실측(수정 전): `1회` + 공백 402자 → **16,974 ms**. 9,900자면 사실상 무한.
    //   도달 경로: `POST /api/ocr/analyze`(무인증) → `ingredients_text` → `parseNutrition`.
    //   ★ `MAX_OCR_TEXT_LENGTH`(10,000) 절단은 방어가 아니다 — 그 안에서 이미 폭발한다.
    //   → 모든 수량자에 상한을 준다. 라벨 표기에서 이 간격은 4자를 넘지 않는다.
    /1회\s{0,4}[(\[]?\s{0,4}(?:제공량|분|당)?[:\s(]{0,6}(\d+(?:[.,]\d+)?)\s{0,4}(g|ml|mL|kg|L)/
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
    /총\s*내용량[:\s]{0,20}(\d[\d,.]*)\s*(g|㎖|ml|mL|kg|L)/
  ) || text.match(
    /(?:^|[\s,.\n])내용량[:\s]{0,20}(\d+(?:[.,]\d+)?)\s*(g|ml|mL|kg|L)/
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

  // 4c) 세션42: 배수 표기 kcal 을 제거했다면 근거를 남긴다(감사·디버깅용).
  if (_mult.removed.length) {
    nutrition._calorie_noise_removed = _mult.removed;
    nutrition._calorie_per_unit_from_multiplier = _mult.perUnit;
  }

  // ── 2b) ★★ 세션43: 괄호 총열량 확정 — basis 를 알아야 판단할 수 있으므로 여기서 한다.
  //   step 2(칼로리 후보 탐색)에서는 이 값을 **후보로 쓰지 않았다.** 1회분으로 오해되면 12배 과대다.
  //   그러나 006 처럼 총량=1회분인 라벨에서는 이것이 유일한 정답이므로 버려서도 안 된다.
  //
  //   ★ 판단 기준은 "1회분 기준이 따로 선언되어 있는가" 다.
  //     - basis 가 per_total  → 총량이 곧 판정 기준이다 → 쓴다 (006: 155)
  //     - 1회분 선언이 없다(serving_size·per_serving 근거 없음) → 총량밖에 없다 → 쓴다
  //     - basis 가 per_serving / per_100g / per_100ml → **쓰지 않는다.**
  //       기준이 1회분인데 총량 값을 넣으면 026 은 1,740(12배) · 082 는 490(2배) 거짓 빨강이 된다.
  //       열량이 비는 것(데이터 없음)이 12배 과대보다 낫다 — `null = 판정 없음 ≠ 안전` 과 같은 원칙.
  if (_ctk.totalCalories != null) {
    nutrition._calorie_total_from_content = _ctk.totalCalories;
    nutrition._calorie_noise_removed = [
      ...(nutrition._calorie_noise_removed || []), ..._ctk.removed,
    ];

    // 라벨이 명시한 총열량이다. `_total` 은 "라벨 명시 총량" 을 담는 자리이므로 여기 기록한다.
    // 단 1회분 값보다 작으면 총량일 수 없다 → 구조를 잘못 읽은 것이므로 기록하지 않는다.
    if (nutritionTotal.calories === undefined
        && (nutrition.calories === undefined || _ctk.totalCalories >= nutrition.calories)) {
      nutritionTotal.calories = _ctk.totalCalories;
    }

    // ★★ 세션43 검증 추가 — basis 만 보면 부족하다.
    //   `총 내용량 400 g (1,600 kcal) 1회 제공량 100 g` 은 basis 가 unknown 으로 떨어지는데
    //   (중대5 가드가 TOTAL_AMOUNT 를 억제한다) 1회 제공량은 명시돼 있다.
    //   그 상태에서 총열량 1,600 을 넣으면 신호등이 basis 를 1회분으로 취급해 **4배 거짓 빨강**이다.
    //   → 1회 제공량이 선언돼 있으면 총열량을 쓰지 않는다. 열량 공백이 4배 과대보다 낫다.
    const perServingBasis = basisInfo.basis === 'per_serving'
      || basisInfo.basis === 'per_100g' || basisInfo.basis === 'per_100ml';
    const servingDeclared = nutrition.serving_size !== undefined;
    if (nutrition.calories === undefined && !perServingBasis && !servingDeclared) {
      nutrition.calories = _ctk.totalCalories;
      nutrition._calorie_source = 'content_line_total';
    }
  }

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
  // ★★★ 세션43 검증에서 나온 치명 결함 — 여기 있던 두 정규식은 ReDoS 였다.
  //   ① `([가-힣()·,\s]+?)(?:\s*함유)`
  //      lazy 그룹의 문자클래스에 `\s` 가 있고 바로 뒤 `\s*` 도 공백을 먹는다.
  //      **같은 공백을 두 수량자가 나눠 먹는 조합이 지수적으로 늘어난다.**
  //      세션42 치명2(`[:\s]{0,20}`)와 같은 유형이고, 정도는 훨씬 심하다.
  //      실측: 공백 2,000자 1.8초 / 4,000자 14.2초 / 5,000자 25초 초과.
  //      도달 경로: `POST /api/ocr/analyze` (무인증) → `ingredients_text` → `analyzeText`.
  //      `MAX_OCR_TEXT_LENGTH`(10,000) 절단이 있어도 **그 안에서 이미 폭발**하므로 방어가 안 됐다.
  //      → 뒤의 `\s*` 를 없앤다. 앞 클래스가 이미 공백을 포함하므로 의미는 같고 모호성만 사라진다.
  //   ② `[♥⚠⭐][^♥⚠⭐]*?([가-힣()·,\s]+?)함유…`
  //      두 lazy 수량자가 **인접**해 같은 구간을 나눠 먹는다. 역시 지수적이다.
  //      → 하나로 합친다. 뒤쪽 텍스트는 `blob.includes(keyword)` 로만 쓰이므로 한글만 남길 필요가 없다.
  //   ★ 상한 200 은 아래 `m[1].length < 200` 게이트와 같은 값이다. 200자를 넘으면 어차피 버린다.
  const explicitPatterns = [
    // "알레르기 유발물질: 우유, 밀, 쇠고기"
    /알레르기\s*유발\s*물질\s*[:：]\s*([^.\n]{1,200})/,
    // "우유·밀·쇠고기 함유" / "우유, 밀, 쇠고기 함유"
    // ★ 세션44 2차 검증 — 문자클래스에 `ㆍ`(U+318D)·`、`·`／`·전각 괄호·`및` 이 없어서
    //   `밀ㆍ대두 함유` · `밀、대두 함유` · `우유및밀함유` 에서 blob 이 잘려 밀을 놓쳤다.
    //   실물 라벨은 가운뎃점을 `·`(U+00B7) 외에 `ㆍ`·`‧`·`∙` 로도 쓴다.
    /([가-힣()（）·ㆍ‧∙、，,／/＊*※•\s및와과]{1,200}?)함유/,
    // "♥ 우유, 밀, 쇠고기 함유 ♥" 같이 ♥/⚠/⭐ 마커로 감싸진 부분
    /[♥⚠⭐]([^♥⚠⭐]{0,200}?)함유[^♥⚠⭐]{0,200}[♥⚠⭐]/,
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
    // ★★★ 세션44 — 여기가 ALLERGEN_KEYWORDS(원재료 형태)만 보고 있었다.
    //   법정 알레르기 표시는 `밀`·`대두`·`잣`·`고등어` 처럼 **단독 명칭으로 인쇄**되는데
    //   ALLERGEN_KEYWORDS.밀 = ['밀가루','소맥분','글루텐'] — `밀` 자체가 없었다.
    //   `고등어`·`잣` 은 표 전체에 아예 없었다 (법정 19종 중 2종 누락).
    //   실측(캡처 68건 전사): `밀` 32건 누락 · `게` 1건 누락.
    //     "♥ 우유, 밀, 쇠고기 함유 ♥" → ['쇠고기','우유']   ← 밀이 사라진다
    //     "알레르기 유발물질: 대두, 밀" → ['대두']
    //   → 이미 있는 ALLERGEN_NAMES(공식 19종 이름)를 함께 본다. 표를 새로 만들지 않는다.
    //
    // ★★★ 세션44 서브에이전트 검증 — 초판은 두 표를 **합본**해 `_matchSet` 에 넣었다. 둘 다 틀렸다.
    //   ① 치명 — `_matchSet` 은 긴 키워드를 먼저 **소비·제거**한다. 합본에는
    //      `밀가루`(3자) > `메밀`(2자), `콩기름`(3자) > `땅콩`(2자) 이 함께 들어온다.
    //      `메밀가루 함유` → `밀가루` 가 먼저 먹어 남는 건 `메` → **메밀이 삭제**됐다.
    //      `땅콩기름 함유` → `콩기름` 이 먼저 먹어 **땅콩이 삭제**됐다.
    //      메밀·땅콩은 국내 아나필락시스 유발 상위다. 라벨에 인쇄된 표기를 서버가 지운 것이다.
    //   ② 중대 — 1글자 이름(`밀`·`게`·`잣`)이 부분문자열로 걸렸다.
    //      실물 096: `합성향료(초콜릿향, 밀크향) 우유 함유` → **밀** (밀크향)
    //      `칼슘을 풍부하게 함유` → **게** (하게)
    //
    //   → 표를 합치지 않고 **두 단계로 나눈다.** 성격이 다른 두 문제이므로 규칙도 달라야 한다.
    //     1단계 원재료 형태(`밀가루`·`계란`·`레시틴`) : 세션43과 동일한 단순 포함 검사.
    //        긴 낱말 안에 짧은 낱말이 들어 있어도 **둘 다 알레르겐**이므로 소비·제거를 하면 안 된다.
    //     2단계 공식 19종 단독 명칭(`밀`·`게`·`잣`) : **구분자 경계**를 요구한다.
    //        법정 표기는 `우유, 밀, 쇠고기` 처럼 쉼표·가운뎃점·공백으로 나열된다.
    //        `밀크향` 의 `밀` 은 뒤가 `크` 라서 걸리지 않는다. `하게` 의 `게` 도 앞이 `하` 라서 걸리지 않는다.
    // ★ 세션44 2차 검증 — 1글자 원재료 키워드(`굴`)도 경계를 요구한다.
    //   `얼굴 보습 성분 함유` → `굴` 이 걸려 **조개류**가 나왔다(2차 검증에서 확인).
    const blob = explicitText.join(' ');
    const detected = new Set();
    for (const [allergen, keywords] of Object.entries(ALLERGEN_KEYWORDS)) {
      for (const keyword of keywords) {
        const hit = keyword.length === 1 ? _boundedNameRe(keyword).test(blob) : blob.includes(keyword);
        if (hit) { detected.add(allergen); break; }
      }
    }
    for (const [allergen, re] of ALLERGEN_NAME_BOUNDED) {
      if (re.test(blob)) detected.add(allergen);
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

// ★★ 세션44 — 「라벨에 명시된 알레르기 표기」에서 **공식 19종 단독 명칭**을 읽을 때 쓰는 경계 규칙.
//   법정 알레르기 표시는 `우유, 밀, 쇠고기` 처럼 **구분자로 나열**된다. 그 구조를 그대로 요구한다.
//   앞: 문자열 시작 또는 구분자.
//   뒤: 문자열 끝, 구분자, 또는 조사/접속어(`밀을 함유`·`밀과 대두`·`대두 및 밀`).
//   이렇게 하면 1글자 이름이 낱말 속에 섞여 들어오는 것을 막는다:
//     `밀크향`  → 뒤가 `크`  → 불일치 ✅
//     `하게`    → 앞이 `하`  → 불일치 ✅
//     `비밀`    → 앞이 `비`  → 불일치 ✅
//     `우유·밀 함유` → 앞 `·` 뒤 ` ` → 일치 ✅
//   ⚠ 수량자가 없다(전부 1글자 문자클래스) — ReDoS 표면이 아니다.
//   ⚠ 정규식은 모듈 로드 시 한 번만 만든다. 매 호출마다 new RegExp 를 하면 느려진다.
//   ★★ 세션44 2차 검증 — 구분자 목록에 빠진 것이 있었다(flat 이 `밀ㆍ대두 함유`·`밀、대두`·전각·`및` 을 놓쳤다).
//     `ㆍ`(U+318D)·`、`·`／`·전각 괄호/쉼표/콜론, 그리고 `및`·`와`·`과` 를 **앞쪽 구분자에도** 넣는다.
//     `및` 은 초판에서 뒤쪽(조사)에만 있어서 `대두 및 밀 함유` 의 `밀` 앞 경계가 성립하지 않았다.
const ALLERGEN_DELIM = '\\s,，、·ㆍ‧∙／/()（）\\[\\]:：;；.。、\\-~≥＊*※•및와과';
//   ★★ 세션44 2차 검증 — 초판 조사 목록에 `도`·`이`·`가`·`은`·`는`·`만` 이 있어 새 오탐이 생겼다:
//     `분말의 밀도를 높이는 성분 함유` → 밀(밀+**도**)  ·  `비타민 게이지 함유` → 게(게+**이**)
//     → 실제 법정 선언에 쓰이는 조사·접속어만 남긴다: 을/를/와/과/및/등.
//     ⚠ `유산균을 풍부하 게 함유` (OCR 이 「하게」를 띄어 쓴 경우)는 이 규칙으로 막을 수 없다.
//       앞뒤가 모두 공백이라 구분자 조건을 만족한다. 68건 실물에는 0건 — 이월 과제로 남긴다.
const ALLERGEN_TRAIL_PARTICLE = '을를와과및등';
/** 구분자 경계를 요구하는 명칭 매칭 정규식. 1글자 명칭에도 안전하다. 캐시한다.
 *  ⚠ 선언 순서 주의 — `ALLERGEN_NAME_BOUNDED` 가 모듈 로드 시 이 함수를 호출하므로
 *    캐시(`const`)가 그보다 **위**에 있어야 한다(TDZ). 아래로 내리면 로드가 실패한다. */
const _boundedNameCache = new Map();
function _boundedNameRe(name) {
  let re = _boundedNameCache.get(name);
  if (!re) {
    re = new RegExp(`(?:^|[${ALLERGEN_DELIM}])${name}(?:$|[${ALLERGEN_DELIM}]|[${ALLERGEN_TRAIL_PARTICLE}])`);
    _boundedNameCache.set(name, re);
  }
  return re;
}

const ALLERGEN_NAME_BOUNDED = Object.entries(ALLERGEN_NAMES).flatMap(([allergen, names]) =>
  names.map((name) => [allergen, _boundedNameRe(name)]));

// compact: NFKC + 공백/구두점 제거 (OCR 띄어쓰기 붕괴 방어)
function _compact(s) {
  return (s || '').normalize('NFKC').replace(/\s+/g, '').replace(/[·ㆍ,，.。:：;；]/g, '');
}

// 혼입(교차오염) 신호 — compact 기준.
const MAY_CONTAIN_SIGNALS = [
  /같은제조시설/, /동일제조시설/, /같은시설/, /같은제조라인/, /같은라인/, /동일라인/,
  /사용한제품과/, /사용제품과/, /제품과같은/, /혼입가능/, /혼입될수/, /혼입/, /교차오염/,
  // ★ 세션44 — 캡처 030(다향훈제오리)에서 실제로 쓰인 형태가 위 신호에 하나도 안 걸렸다.
  //   "…아황산류, 잣을 사용한 제조시설에서 **같이** 제조하고 있습니다"
  //   기존 신호는 전부 「같**은**」 을 전제한다. 「같이」 는 잡히지 않았다.
  //   그 결과 이 문장이 mayContain 이 아니라 contains 로 분류되어
  //   **법정 19종 전부가 「직접 함유」로 표시**됐다(030 실측: contains 19종).
  /시설에서같이/, /시설에서함께/, /라인에서같이/, /라인에서함께/,
  /사용한제조시설/, /사용하는제조시설/, /사용한시설/,
];
// ★ 세션44 — 여기 있던 bare `/포함/` 가 위 030 오탐의 공범이었다.
//   법정 표기 "조개류(굴, 전복, 홍합 **포함**)" 는 조개류의 **정의**이지 함유 선언이 아니다.
//   compact 후 "홍합포함" 이 되어 `/포함/` 에 걸리면서 그 문장 전체가 contains 로 승격됐다.
//   → 조사(을/를/이/가)를 요구해 "우유**를** 포함" 같은 실제 선언만 남긴다.
//     "홍합포함" 은 앞 글자가 조사가 아니므로 걸리지 않는다.
//   ★★ 세션44 서브에이전트 검증(경미9) — 조사를 요구하니 `밀 포함` 같은 **조사 없는 선언**을 놓쳤다.
//     → `포함` 으로 **끝나는** 세그먼트를 추가로 허용한다(compact 기준).
//       `밀 포함` → compact `밀포함` → 끝이 `포함` → 일치 ✅
//       `조개류(굴, 전복, 홍합 포함)` → compact 끝이 `)` → 불일치 ✅ (030 오탐 재발 안 함)
//     ※ 68건 실물에 조사 없는 `포함` 선언은 0건이다. 예방적 보강이다.
//   ★★ 세션44 2차 검증(경미I) — `/포함$/` 만으로는 부족했다. 좁힌 결과 아래가 통째로 배제됐다:
//     `대두 포함되어 있음` · `우유 포함된 제품` · `대두 포함하고 있습니다`
//     → s43 은 contains 로 잡았는데 초판은 세그먼트가 `'other'` 로 분류돼 **완전 배제**됐다(강등도 아니고 소실).
//     → 용언형 `포함되/포함된/포함하/포함한/포함합/포함함` 을 함께 허용한다.
//       `조개류(굴, 전복, 홍합 포함)` 는 `포함` 뒤가 `)` 이므로 여전히 걸리지 않는다(030 오탐 재발 없음).
const EXPLICIT_MARKERS = [
  /함유/, /[을를이가]포함/, /포함$/, /포함(?:되|된|하|한|합|함)/,
  /알레르기유발물질/, /알레르기유발성분/, /알레르기정보/, /알러지/,
];
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
  // ★★★ 세션44 2차 검증(중대C) — 이 최장-우선-소비만으로는 1글자 명칭을 못 막는다.
  //   `ALLERGEN_NAMES` 에는 `밀`·`게`·`잣`·`굴` 이 1글자로 들어 있고 `work.includes(kw)` 는 경계가 없다.
  //   1차 수정은 경계 규칙(`ALLERGEN_NAME_BOUNDED`)을 **`detectAllergens`(flat) 에만** 걸었고,
  //   **화면이 실제로 쓰는 `detectAllergensV2` 는 여기를 통과**하므로 오탐이 그대로 남아 있었다.
  //   실측(수정 전 v2):
  //     캡처 096 `합성향료(초콜릿향, 밀크향) 우유 함유` → contains ["밀","우유"]  ← 밀크향
  //     `칼슘을 풍부하게 함유`  → ["게"]   ← 하「게」
  //     `비밀 레시피 함유`      → ["밀"]
  //     `밀폐용기에 보관, 우유 함유` → ["밀","우유"]
  //   → **1글자 키워드는 구분자 경계를 요구한다.** 2글자 이상은 종전대로 소비·제거 방식을 쓴다
  //     (그쪽은 `밀가루`→`밀` 처럼 부분 포함이 정답인 경우가 많다).
  const pairs = [];
  for (const [allergen, kws] of Object.entries(table)) for (const kw of kws) pairs.push([allergen, kw]);
  pairs.sort((a, b) => b[1].length - a[1].length);
  let work = segment;
  const detected = new Set();
  for (const [allergen, kw] of pairs) {
    if (!kw) continue;
    if (kw.length === 1) {
      if (_boundedNameRe(kw).test(work)) { detected.add(allergen); work = work.split(kw).join(' '); }
      continue;
    }
    if (work.includes(kw)) { detected.add(allergen); work = work.split(kw).join(' '); }
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
 * ★★ 세션44 (서브에이전트 검증 중대5) — 한 세그먼트에 **함유 선언과 혼입 문구가 같이** 있으면
 *   `_classifySegment` 가 혼입을 먼저 보고 세그먼트 전체를 mayContain 으로 강등한다.
 *   → 실제로 함유된 알레르겐이 화면에서 「직접 들어 있다는 뜻은 아니지만」 문구로 감싸진다.
 *     경고를 약화시키는 방향이므로 안전 문제다.
 *
 *   실측 반례: `밀, 대두, 우유 함유 메밀, 땅콩을 사용한 제조시설에서 같이 제조하고 있습니다`
 *     (OCR 이 마침표를 놓치면 이렇게 한 세그먼트가 된다. 흔한 일이다.)
 *     수정 전 → contains=[] / mayContain=5종 전부
 *
 *   → 혼입 신호 **앞부분**에 함유 선언이 있으면 그 지점에서 한 번 더 자른다.
 *     `함유` 는 선언의 **끝**에 오므로(`X, Y 함유`), `함유` 직후를 경계로 삼으면
 *     앞 = 직접 함유 선언, 뒤 = 혼입 문구로 정확히 갈린다.
 *   ⚠ compact 문자열이 아니라 원문에서 자른다 — 뒤에서 _matchSet 이 원문을 쓴다.
 */
// ★ 자를 지점은 `함유` 다. 단 **선언으로서의 `함유`** 여야 한다.
//   `함유한 제품과` · `함유된 제품과` · `함유하는 시설` 의 `함유` 는 **혼입 문장의 일부**다.
//   세션43 C6(`새우를 함유한 제품과 같은 제조시설에서 제조`)이 정확히 그 경우이고,
//   그것까지 자르면 혼입을 직접 함유로 승격시켜 **거짓 경고**가 된다(반대 방향의 사고).
//   → `함유` 뒤에 `한·된·하·할·함` 이 오면 자르지 않는다.
// ★★★ 세션44 2차 검증 — 초판 규칙 `함유(?![한된하할함])` 는 **양방향으로 틀렸다.**
//
//   ① 중대D 승격 오탐 — `메밀 함유 제품과 같은 제조시설에서 제조` 는 **혼입 문구**인데
//      `함유` 뒤가 공백이라 통과해 `head = "메밀 함유"` 가 되고 contains 로 승격됐다.
//      s43: mayContain=["메밀"] → 초판: contains=["메밀"]. **거짓 「직접 함유」**.
//      3분리의 존재 이유(직접 함유 ↔ 혼입 구분)를 반대로 만든다. 안전한 제품을 회피하게 만든다.
//   ② 중대E 강등 잔존 — 반대로 `밀, 대두를 함유하며 …같이 제조` 는 **선언**인데
//      `함유하`가 제외 목록에 걸려 자르지 못했고 세그먼트 전체가 mayContain 으로 떨어졌다.
//      s43: contains=4종 → 초판: contains=[] . **s43보다 나빠졌다.**
//      「함유하고 있습니다」·「함유하며」·「함유함」 은 가장 흔한 선언 어형이다.
//
//   → 판단 기준을 `함유` **뒤에 오는 말**로 바꾼다. 어미가 아니라 **무엇을 수식하는가**를 본다.
//     혼입 문구의 `함유` 는 항상 뒤에 **명사(제품/시설/라인/설비)** 가 온다: `함유 제품과`·`함유한 제품과`.
//     선언의 `함유` 는 문장이 거기서 끝나거나(`함유`·`함유함`) 종결어미가 이어진다(`함유하고 있습니다`).
//     ⇒ `함유` 다음에 `(용언어미)? + 제품|시설|설비|라인|공장` 이 오면 **혼입의 일부이므로 자르지 않는다.**
const RE_CROSS_OBJECT_AFTER = /^\s{0,4}(?:한|된|하는|하고있는|하고\s{0,4}있는)?\s{0,4}(?:제품|시설|설비|라인|공장|제조)/;
const RE_DECLARE_TOKEN = /함유/g;
function _splitDeclarationFromCrossContam(seg) {
  // 혼입 신호가 없으면 나눌 이유가 없다.
  if (!MAY_CONTAIN_SIGNALS.some((re) => re.test(_compact(seg)))) return null;
  // ★ **마지막** 선언형 `함유` 에서 자른다.
  //   첫 매치를 쓰면 `알레르기 유발물질: 우유, 대두 함유 잣을 …` 에서
  //   레이블 직후가 잘려 앞부분에 알레르겐이 하나도 안 남는다(실측 확인).
  RE_DECLARE_TOKEN.lastIndex = 0;
  let cut = -1;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = RE_DECLARE_TOKEN.exec(seg)) !== null) {
    const after = seg.slice(m.index + m[0].length);
    if (RE_CROSS_OBJECT_AFTER.test(after)) continue;   // 혼입 문구의 일부 → 자르지 않는다
    cut = m.index + m[0].length;
  }
  if (cut < 0) return null;
  const head = seg.slice(0, cut);
  const tail = seg.slice(cut);
  // 앞부분이 이미 혼입 문구를 품고 있으면 나누면 안 된다 — 전체가 혼입 문장이다.
  if (MAY_CONTAIN_SIGNALS.some((re) => re.test(_compact(head)))) return null;
  if (head.trim().length < 2 || tail.trim().length < 2) return null;
  return [head, tail];
}

/**
 * @returns {{contains:string[], mayContain:string[], inferred:string[], evidence:object[]}}
 */
// ★ 세션44 — 상한 2개. 정규식 ReDoS 는 아니지만 **입력 크기에 비례해 무제한**이었다.
//   · 세그먼트: `밀 함유\n` × 1,414 (9,900자) 에서 25 ms. 라벨 한 장의 문장 수는 400을 넘지 않는다.
//   · evidence: 상한이 없어 1,400항목 / JSON 75 KB 응답이 나왔다(서브에이전트 경미11).
//     evidence 는 사람이 근거를 확인하는 용도다. 50개를 넘으면 확인 불가이므로 의미가 없다.
//   ★★ 세션44 2차 검증(경미L) — 초판 400 은 너무 낮았다. 상한에 걸려 잘려 나간 세그먼트에
//     함유 선언이 있으면 「직접 함유」가 「원재료 추정」으로 강등된다(reconcile 이 flat 에서 살리지만 등급이 낮아진다).
//     68건 실물 최대 세그먼트는 66개(059.txt)지만, 주의사항이 긴 건기식 라벨은 400을 넘을 수 있다.
//     1,200 에서도 실측 18 ms 이므로 여유를 크게 둔다. 상한의 목적은 **무제한 방지**이고
//     실사용 라벨을 잘라내는 것이 아니다.
const V2_MAX_SEGMENTS = 1200;
const V2_MAX_EVIDENCE = 50;

function detectAllergensV2(text) {
  // ★ 세션44 중대5 — 함유 선언과 혼입 문구가 한 세그먼트에 뭉쳐 있으면 한 번 더 자른다.
  // ★★ 세션44 2차 검증(경미L) — 초판은 `slice` 를 **분할 앞**에 뒀다.
  //   그러면 분할로 세그먼트가 늘어나 실효 상한이 800 이 됐다(주석은 400 이라고 적혀 있었다).
  //   상한은 **최종 개수**에 걸어야 의미가 있다.
  const raw = _splitSegments(text || '');
  const segs = [];
  for (const s of raw) {
    if (segs.length >= V2_MAX_SEGMENTS) break;
    const pair = _splitDeclarationFromCrossContam(s);
    if (pair) segs.push(pair[0], pair[1]);
    else segs.push(s);
  }
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
    for (const a of found) {
      bucket.add(a);
      if (evidence.length < V2_MAX_EVIDENCE) evidence.push({ allergen: a, level, textSpan: seg.slice(0, 60) });
    }
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

/**
 * ★★★ 세션44 — flat `allergens` 와 3분리 `allergens_v2` 가 어긋나지 않게 맞춘다.
 *
 * 왜 필요한가 (서브에이전트 검증 치명3)
 *   클라이언트는 `allergens_v2` 가 비어 있지 않으면 flat `allergens` 를 **쓰지 않는다.**
 *   그래서 둘이 어긋나면 **flat 에만 있는 알레르기가 화면에서 통째로 사라진다.**
 *   실제 재현: 사진 분석으로 flat·v2 둘 다 11종을 얻은 뒤,
 *   사용자가 `ingredients_text`(원재료만)를 보내면 v2 만 재계산되어 `inferred:['밀']` 이 되고
 *   화면에는 「원재료 추정: 밀」 하나만 남았다 — 게·난류·닭고기·새우·쇠고기·오징어·우유·조개류·토마토·대두 10종 소실.
 *   응답 JSON 에는 11종이 들어 있는데 사용자는 1종만 본다. 세션43 `context_messages` 와 같은 유형이다.
 *
 * 규칙 — **경고는 잃지 않는다(union). 등급은 올리지 않는다.**
 *   flat 에만 있는 항목은 `inferred`(원재료 추정)에 넣는다.
 *   flat 은 근거 등급 정보가 없으므로 「직접 함유」로 승격하면 거짓 단정이 된다.
 *   이미 contains/mayContain 에 있는 항목은 건드리지 않는다.
 *
 * @param {string[]} flat  detectAllergens 결과
 * @param {object|null} v2 detectAllergensV2 결과
 * @returns {object|null}  flat 을 모두 포함하는 v2 (v2 가 없으면 null 그대로 — 클라이언트가 flat 폴백)
 */
/**
 * ★★★ 세션44 2차 검증(치명B) — 두 개의 3분리 결과를 **합집합**으로 병합한다.
 *
 * 왜 `a || b` 로는 안 되는가
 *   `analyzeText` 는 `allergens_v2` 를 **항상 객체로** 반환한다. 전부 빈 배열이어도 truthy 다.
 *   그래서 `labelV2 || nutritionV2` 는 라벨 사진이 알레르기를 못 잡았을 때도 라벨 쪽을 택하고,
 *   영양표 사진에서 읽은 선언을 **통째로 버린다.** 실측 8종 → 1종.
 *
 * 등급 우선순위: contains > inferred(원재료에 실제 존재) > mayContain(혼입).
 *   같은 알레르겐이 두 사진에서 다른 등급으로 나오면 **높은 등급을 남긴다.**
 *   (한쪽이 "직접 함유" 라고 읽었으면 그게 근거다. 혼입으로 낮추면 경고가 약해진다.)
 */
function mergeAllergensV2(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const arr = (x) => (Array.isArray(x) ? x : []);
  const uni = (x, y) => [...new Set([...arr(x), ...arr(y)])].sort();
  const contains = uni(a.contains, b.contains);
  const inferred = uni(a.inferred, b.inferred).filter((x) => !contains.includes(x));
  const mayContain = uni(a.mayContain, b.mayContain)
    .filter((x) => !contains.includes(x) && !inferred.includes(x));
  return {
    contains,
    mayContain,
    inferred,
    evidence: [...arr(a.evidence), ...arr(b.evidence)].slice(0, V2_MAX_EVIDENCE),
  };
}

function reconcileAllergens(flat, v2) {
  if (!v2) return null;
  const arr = (x) => (Array.isArray(x) ? x : []);
  const out = {
    contains: arr(v2.contains).slice(),
    mayContain: arr(v2.mayContain).slice(),
    inferred: arr(v2.inferred).slice(),
    evidence: arr(v2.evidence).slice(),
  };
  const known = new Set([...out.contains, ...out.mayContain, ...out.inferred]);
  for (const a of arr(flat)) {
    if (typeof a !== 'string' || known.has(a)) continue;
    out.inferred.push(a);
    known.add(a);
    if (out.evidence.length < V2_MAX_EVIDENCE) {
      out.evidence.push({ allergen: a, level: 'inferred', textSpan: '(flat 목록에서 병합)' });
    }
  }
  out.inferred.sort();
  return out;
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
    // ★★★ 세션44 — 여기가 ReDoS 였다(치명, 선재 결함). 실측: 9,900자 입력에 **339 ms**,
    //   `extractProductMeta` 가 라벨 후보를 순회하므로 이 비용이 26회 곱해진다.
    //   원인 3개가 겹쳐 있었다:
    //     ① `s` 플래그 하에서 `(.+?)` 는 개행까지 먹는 **무제한 lazy** 다.
    //     ② 그 앞뒤 `\s*` 가 `.` 과 같은 공백을 나눠 먹는다(세션42 치명2와 같은 형태).
    //     ③ 뒤가 26개 대안 lookahead 라서 실패 시 되돌림이 매 위치마다 반복된다.
    //   → 값 길이에 상한을 준다. 라벨 값(제품명·식품유형·주소)이 200자를 넘는 경우는 없다.
    //     뒤쪽 `\s*` 는 제거한다 — 아래에서 어차피 꼬리 공백을 잘라낸다(중복이자 모호성).
    //     `\s*[:\/\-]?\s*` 도 단일 문자클래스로 합친다.
    const labelEsc = label.replace(/\s/g, '\\s{0,4}');
    const re = new RegExp(`${labelEsc}[:\\/\\-\\s]{0,8}(.{1,200}?)${META_END_LOOKAHEAD}`, 's');
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

  // ★★ 세션44 서브에이전트 검증(중대8) — 여기도 정규화가 없었다.
  //   실물 캡처 027 `내 용 량: 60 g×3개입` → total_content 를 못 읽었다.
  //   이 값은 크라우드소싱 경로로 `products.total_content` · `servings_per_container` 에
  //   **영구 저장**된다. 세션40이 "세션39가 이 함수를 놓쳤다" 고 적어 둔 자리를 또 놓친 것이다.
  text = normalizeLabelSpacing(text);

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
    /총\s{0,4}내용량[:\/\-\s]{0,8}(\d[\d,.]{0,12})\s{0,4}(g|ml|mL|kg|L|개|정|포)/
  ) || text.match(
    /(?:^|[\s,.\n])내용량[:\/\-\s]{0,8}(\d[\d,.]{0,12})\s{0,4}(g|ml|mL|kg|L|개|정|포)/
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
  detectNutritionBasis,   // 세션42: 2장 분리 촬영 시 라우터가 합친 텍스트로 재판정한다
  detectAllergens,
  detectAllergensV2,
  reconcileAllergens,   // ★ 세션44: flat ↔ 3분리 어긋남 방지(치명3)
  mergeAllergensV2,     // ★ 세션44: 두 사진 3분리 합집합(치명B)
  extractProductMeta,
  analyzeText,
  ADDITIVE_KEYWORDS,
  ALLERGEN_KEYWORDS,
};
