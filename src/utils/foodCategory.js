/**
 * 식품유형 → context category 매핑 + 카테고리별 맥락 안내 메시지
 *
 * 스펙: docs/API_SPEC_MFRAS.md §2.2 + 부록 A
 * 영양 신호등 v1.3 §4 (한국 식문화 보정) 기반
 *
 * food_type 값(C005 식품유형명)을 13개 카테고리 중 하나로 분류하고,
 * 해당 카테고리에 맞는 맥락 안내 메시지를 함께 반환한다.
 */

// 13개 카테고리 정의
const CATEGORIES = {
  general:           { label: '일반 가공식품',  excluded: false },
  beverage:          { label: '음료',           excluded: false },
  fermented:         { label: '발효식품',       excluded: false },
  dried:             { label: '건조·농축식품',  excluded: false },
  nuts:              { label: '견과류',         excluded: false },
  dairy:             { label: '유제품',         excluded: false },
  juice:             { label: '과일주스',       excluded: false },
  whole_grain:       { label: '통곡물',         excluded: false },
  sauce:             { label: '소스·양념류',    excluded: false },
  soup:              { label: '국·찌개',        excluded: false },
  alcohol:           { label: '주류',           excluded: true,  excludeReason: 'alcohol' },
  health_functional: { label: '건강기능식품',   excluded: true,  excludeReason: 'health_functional' },
  raw_ingredient:    { label: '원료식품',       excluded: true,  excludeReason: 'raw_ingredient' },
};

// 키워드 → 카테고리 매핑 (우선순위 순서대로 매칭)
// food_type 안에 키워드가 포함되면 해당 카테고리로 분류
const KEYWORD_RULES = [
  // 평가 대상 외 (가장 먼저 매칭)
  { keywords: ['주류', '맥주', '소주', '청주', '와인', '위스키', '막걸리', '탁주', '발효주', '리큐르', '증류주'],
    category: 'alcohol' },
  { keywords: ['건강기능식품', '영양보충용', '비타민제', '무기질제'],
    category: 'health_functional' },
  { keywords: ['원료', '농산물', '축산물', '수산물', '생식', '신선식품'],
    category: 'raw_ingredient' },

  // 발효식품 (한국 식문화)
  { keywords: ['김치', '깍두기', '장류', '된장', '고추장', '간장', '청국장', '쌈장', '젓갈', '식초', '발효유', '요거트', '낫토', '치즈'],
    category: 'fermented' },

  // 음료
  { keywords: ['음료', '탄산음료', '주스', '두유', '차', '커피', '워터', '음용수', '액상차', '식혜', '식이음료', '에너지음료', '이온음료'],
    category: 'beverage' },

  // 건조·농축
  { keywords: ['건조', '건과', '말린', '분말', '가루', '동결건조', '농축', '진액', '엑기스', '김 ', '김(', '미역', '다시마', '육포', '북어', '건어물'],
    category: 'dried' },

  // 견과류
  { keywords: ['견과', '땅콩', '아몬드', '호두', '캐슈너트', '피스타치오', '잣', '해바라기씨', '호박씨'],
    category: 'nuts' },

  // 유제품 (발효유 제외 — 발효유는 위 fermented 에서 잡힘)
  { keywords: ['우유', '유제품', '아이스크림', '연유', '분유'],
    category: 'dairy' },

  // 과일주스 (음료 중 천연과즙 — 일반 음료보다 우선되어야 하지만 키워드가 모호하면 음료로 처리됨)
  { keywords: ['과·채주스', '과채주스', '천연과즙', '100%주스'],
    category: 'juice' },

  // 통곡물
  { keywords: ['통밀', '현미', '귀리', '오트밀', '잡곡', '통곡'],
    category: 'whole_grain' },

  // 소스·양념
  { keywords: ['소스', '드레싱', '마요네즈', '케첩', '머스타드', '카레', '양념', '복합조미식품', '향신료'],
    category: 'sauce' },

  // 국·찌개
  { keywords: ['국', '찌개', '탕', '죽', '스프', '수프'],
    category: 'soup' },
];

// 카테고리별 맥락 안내 메시지 (스펙 부록 A)
const CONTEXT_MESSAGES = {
  beverage: { id: 'beverage_per_100ml', icon: '🥤', title: '음료 안내',
    body: '100mL 기준으로 평가됩니다.', severity: 'info' },
  fermented: { id: 'fermented_sodium_context', icon: '🥬', title: '발효식품 맥락',
    body: '발효식품은 나트륨이 높으나 유산균과 식이섬유가 풍부합니다.', severity: 'info' },
  dried: { id: 'dried_per_serving_only', icon: '🍂', title: '건조식품 안내',
    body: '건조식품으로 100g당 수치가 높게 표시됩니다. 1회 제공량 기준만 적용했습니다.', severity: 'info' },
  nuts: { id: 'nuts_healthy_fat', icon: '🥜', title: '견과류 맥락',
    body: '지방이 높지만 불포화지방산이 풍부한 건강한 지방입니다.', severity: 'info' },
  dairy: { id: 'dairy_calcium', icon: '🥛', title: '유제품 맥락',
    body: '포화지방이 있으나 칼슘과 단백질의 주요 공급원입니다.', severity: 'info' },
  juice: { id: 'juice_natural_sugar', icon: '🍹', title: '과일주스 맥락',
    body: '천연 과당이 포함되어 당류가 높게 표시됩니다. 첨가당과 구분하세요.', severity: 'info' },
  whole_grain: { id: 'whole_grain_fiber', icon: '🌾', title: '통곡물 맥락',
    body: '탄수화물이 높지만 식이섬유와 미네랄이 풍부합니다.', severity: 'info' },
  sauce: { id: 'sauce_small_serving', icon: '🥫', title: '양념류 안내',
    body: '양념류는 1회 사용량이 적으므로 실제 섭취 나트륨은 표시보다 낮을 수 있습니다.', severity: 'info' },
  soup: { id: 'soup_broth_amount', icon: '🍜', title: '국물류 안내',
    body: '표시 나트륨은 국물 전량 기준입니다. 국물을 적게 드시면 줄일 수 있습니다.', severity: 'info' },
  alcohol: { id: 'alcohol_excluded', icon: '🍺', title: '평가 대상 외',
    body: '주류는 영양 신호등 평가 대상이 아닙니다.', severity: 'info' },
  health_functional: { id: 'health_functional_excluded', icon: '💊', title: '평가 대상 외',
    body: '건강기능식품은 별도 기준이 적용됩니다.', severity: 'info' },
  raw_ingredient: { id: 'raw_excluded', icon: '🥩', title: '평가 대상 외',
    body: '미가공 원료식품은 영양 신호등을 적용하지 않습니다.', severity: 'info' },
};

/**
 * food_type 문자열 → context 객체 (스펙 §2.2 형태)
 * @param {string|null} foodType - C005 식품유형명 (예: '스낵과자류', '김치류')
 * @returns {Object} context — { category, category_label, is_excluded, exclude_reason, is_dried_exception, is_beverage, detection_method, messages[] }
 */
function getContext(foodType) {
  const ft = (foodType || '').trim();
  let category = 'general';
  let detectionMethod = 'silent_fallback';

  if (ft) {
    detectionMethod = 'c005_food_type';
    for (const rule of KEYWORD_RULES) {
      if (rule.keywords.some((kw) => ft.includes(kw))) {
        category = rule.category;
        break;
      }
    }
  }

  const meta = CATEGORIES[category];
  const messages = [];
  const msg = CONTEXT_MESSAGES[category];
  if (msg) messages.push(msg);

  return {
    category,
    category_label: meta.label,
    is_excluded: !!meta.excluded,
    exclude_reason: meta.excludeReason || null,
    is_dried_exception: category === 'dried',
    is_beverage: category === 'beverage' || category === 'juice',
    detection_method: detectionMethod,
    messages,
  };
}

module.exports = { getContext, CATEGORIES, CONTEXT_MESSAGES };
