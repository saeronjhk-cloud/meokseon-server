/**
 * context 조립 — 카테고리 라벨 + 맥락 안내 메시지
 *
 * ★★★ 세션51 D5 해소 (2026-08-06) — **여기는 더 이상 식품유형을 분류하지 않는다.**
 *
 * ── 무엇이 문제였나 ────────────────────────────────────────────────────────
 * 종전 이 파일은 `food_type` 문자열을 자체 키워드 규칙으로 **13분류**했다.
 * 그런데 신호등 엔진(`nutritionTrafficLight.detectFoodCategory`)도 같은 입력을 **6분류**한다.
 * 같은 응답이 서로 다른 답을 실어 나갔다(세션50 D5 로 등록, 실측):
 *     조미김·김자반  엔진 dried      / 여기 general
 *     간장(2종)      엔진 beverage   / 여기 fermented
 * → 사용자는 「건조식품 예외를 적용했습니다」와 「일반 가공식품」을 **한 화면에서** 보게 된다.
 *
 * 실모집단으로 재면 규모가 더 컸다: HACCP 덤프 14,682건 중 **2,235건(15.2%)** 불일치.
 * 그리고 사용자에게 «보이는» 모순이 두 종류 있었다:
 *   ① 「주류는 평가 대상이 아닙니다」 안내와 «색이 칠해진 신호등»이 함께 나감 — 15종
 *      (청주·막걸리·증류주는 여기만 주류로 봤고, `기타 수산물가공품` 은 여기만 원료식품으로 봤다)
 *   ② 「100mL 기준으로 평가됩니다」 안내와 실제 사용 기준이 어긋남 — ml 포장 88건 · g 포장 10건
 *
 * ── 왜 A안(엔진 어휘로 접기)인가 ──────────────────────────────────────────
 * 세 안을 실측 비교했다(`IP/세션51_측정보고서_2026-08-03.md` §3-2).
 *   A 엔진 6분류로 접는다        색 변화 0 · 안내 문구 14~17종 소멸 · 되돌리기 쉬움
 *   B 엔진을 13분류로 확장한다   ⚠ `juice` 를 음료로 잡으면 당류 임계가 5g→2.5g 로 «색이 바뀐다».
 *                               `raw_ingredient` 는 신호등이 통째로 사라진다. ENUM 확장은 사실상 편도
 *   C 명시적 매핑표             엔진 6 → 표시 13 은 1:다라 복원 불가. 복원하려면 판정기가 다시 2벌 = D5 재발
 *
 * A안의 유일한 비용은 「안내 문구 14~17종이 사라진다」였는데,
 * **2026-08-06 실측에서 클라이언트가 `context.*` 를 한 곳도 읽지 않는 것이 확인됐다**
 * (`web/src/lib/meokseon.ts` 의 응답 타입에 `context?: unknown` 으로 선언만 돼 있고 소비 0곳).
 * → 그 비용이 사용자에게 보이지 않는다. A안을 택한다.
 *
 * ── 지금 이 파일이 하는 일 ────────────────────────────────────────────────
 * 판정은 **엔진 한 곳**에서만 한다. 여기서는 그 결과에 «라벨과 안내 문구»를 붙이기만 한다.
 *   ⚠ `detectFoodCategory` 를 여기서 호출하는 방식은 **쓰지 않는다.** 읽기 경계에 판정 호출이
 *     하나 더 생기면 「같은 의미를 여러 경로에서 재해석」이 그대로 재발한다(세션48 근본원인).
 *
 * ⚠ 남은 것: `sauce`·`soup`·`nuts`·`dairy`·`whole_grain` 안내 문구가 사라졌다.
 *   이 문구들은 임계값을 바꾸지 않는 «면책성 안내»였다(「양념류는 1회 사용량이 적으므로…」).
 *   필요해지면 엔진에 분류를 추가하는 게 아니라, **표시 전용 축을 별도 키로** 두어야 한다
 *   (측정보고서 §3-2 의 D안). 지금은 소비자가 없으므로 만들지 않는다.
 *
 * 스펙: docs/API_SPEC_MFRAS.md §2.2 + 부록 A
 */

/**
 * 엔진(`nutritionTrafficLight.detectFoodCategory`)이 낼 수 있는 값은 정확히 이 6종이다.
 * 소스에서 `return '…'` 을 전수 확인했다(2026-08-06):
 *   alcohol · supplement · fermented · beverage · dried · general
 * ⚠ `raw_ingredient` 는 엔진의 `excludedCategories` 목록에는 있지만 `detectFoodCategory` 가
 *   **낼 수 없다**(죽은 원소). 그래서 여기에도 두지 않는다.
 */
const CATEGORIES = {
  general:    { label: '일반 가공식품' },
  beverage:   { label: '음료' },
  fermented:  { label: '발효식품' },
  dried:      { label: '건조·농축식품' },
  alcohol:    { label: '주류' },
  supplement: { label: '건강기능식품' },
};

/** 카테고리별 맥락 안내 (스펙 부록 A). 엔진 어휘와 1:1. */
const CONTEXT_MESSAGES = {
  beverage: { id: 'beverage_per_100ml', icon: '🥤', title: '음료 안내',
    body: '100mL 기준으로 평가됩니다.', severity: 'info' },
  fermented: { id: 'fermented_sodium_context', icon: '🥬', title: '발효식품 맥락',
    body: '발효식품은 나트륨이 높으나 유산균과 식이섬유가 풍부합니다.', severity: 'info' },
  dried: { id: 'dried_per_serving_only', icon: '🍂', title: '건조식품 안내',
    body: '건조식품으로 100g당 수치가 높게 표시됩니다. 1회 제공량 기준만 적용했습니다.', severity: 'info' },
  alcohol: { id: 'alcohol_excluded', icon: '🍺', title: '평가 대상 외',
    body: '주류는 영양 신호등 평가 대상이 아닙니다.', severity: 'info' },
  supplement: { id: 'supplement_excluded', icon: '💊', title: '평가 대상 외',
    body: '건강기능식품은 별도 기준이 적용됩니다.', severity: 'info' },
};

/**
 * 신호등 결과 → context 객체 (스펙 §2.2 형태)
 *
 * @param {string|null} foodType - C005 식품유형명. ⚠ 이제 **분류에 쓰지 않는다.**
 *   응답의 `detection_method` 를 정하는 데만 참고한다(원본 입력이 있었는지 여부).
 * @param {Object|null} [trafficLight] - `evaluateNutrition` 결과. 영양정보가 없어 판정을 못 했으면 null.
 * @returns {Object} context
 *
 * ★ 전 필드가 **3-상태**다: 값 = 엔진이 판정했다 · **`null` = 판정 자체가 없다.**
 *   `false`/`'general'` 로 채우면 「건조식품이 아니다」·「일반 가공식품이다」라고
 *   **없는 근거로 단정**하는 것이 된다. 신호등이 없으면 카테고리도 없다.
 */
function getContext(foodType, trafficLight = null) {
  // ★ 카테고리는 엔진이 정한 것을 «그대로» 쓴다. 여기서 다시 분류하지 않는다.
  const raw = trafficLight && trafficLight.food_category;
  const category = (raw && CATEGORIES[raw]) ? raw : null;

  // ⚠ 엔진이 우리가 모르는 값을 낸 경우 — 조용히 general 로 접지 않는다.
  //   어휘가 갈라진 것을 «모르는 채» 넘기는 것이 D5 를 만든 방식이었다.
  const unknownCategory = !!raw && !CATEGORIES[raw];

  const messages = [];
  if (category && CONTEXT_MESSAGES[category]) messages.push(CONTEXT_MESSAGES[category]);

  return {
    category,
    category_label: category ? CATEGORIES[category].label : null,
    // ── 아래 키는 전부 엔진 결과를 그대로 옮긴다. 여기서 판정하지 않는다(세션50 D2 · 세션51 D5).
    is_excluded: trafficLight ? !!trafficLight.is_excluded : null,
    exclude_reason: trafficLight ? (trafficLight.exclude_reason || null) : null,
    is_dried_exception: trafficLight ? !!trafficLight.is_dried_exception : null,
    // ★ 세션51 — 종전에는 여기서 `category === 'beverage' || category === 'juice'` 로 «따로» 정했고
    //   그래서 엔진과 갈렸다(간장: 엔진 beverage · 여기 fermented. ml 포장 88건 불일치).
    is_beverage: category ? category === 'beverage' : null,
    detection_method: trafficLight
      ? (unknownCategory ? 'engine_unknown_category' : 'engine_food_category')
      : (foodType ? 'no_evaluation' : 'no_evaluation_no_food_type'),
    messages,
  };
}

module.exports = { getContext, CATEGORIES, CONTEXT_MESSAGES };
