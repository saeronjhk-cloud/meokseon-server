/**
 * test_path_parity.js — 세션48 경로 동등성 회귀 (바코드 조회 ↔ OCR)
 * ==========================================================================
 * ★★★ 이 파일이 왜 있는가 — 4차 검증이 실측한 것
 *
 *   기존 검사는 **소스 문자열 정규식**이었다.
 *     /^\s*allergens_flat_complete:[\s\S]{0,200}mayContain/m   ← 이런 것
 *   그래서 아래 뮤테이션이 **전부 12개 파일 59/0 초록**을 통과했다:
 *     · allergens_flat_complete 를 항상 true 로
 *     · 피연산자 순서 교환 (실제 응답은 TypeError → 전건 500)
 *     · productService 의 getRaccPolicy 인자 통째로 제거
 *   그리고 `tests/` 전체에서 `getProductWithTrafficLight` 를 **호출하는 줄이 0개**,
 *   `judgeNutrition`(OCR 라우터)을 호출하는 테스트도 **0개**였다.
 *
 *   → 이 파일은 **소스 문자열을 한 글자도 읽지 않는다.**
 *     두 경로의 함수를 **실제로 호출해 나온 응답 객체**만 단정한다.
 *
 * ── 무엇을 고정하나 ────────────────────────────────────────────────────────
 *   ① 같은 canonical 제품이 **바코드 경로**와 **OCR 경로**에서 같은 판정을 받는다.
 *      비교 대상: 영양소별 color · basis · pct_dv · per_100,
 *                is_excluded · is_withheld · is_dried_exception · food_category,
 *                sanity_warnings(엔진 것 · 응답에 실리는 것 둘 다),
 *                알레르기 키 집합.
 *   ② 바코드 경로의 판정값 자체(GOLDEN_BAR). 두 경로가 **같은 방향으로 함께 망가지면**
 *      동등성만으로는 못 잡는다. 그래서 절대값도 함께 못 박는다.
 *      (뮤테이션 M3 = getRaccPolicy 인자 제거 는 이 골든이 잡는다.)
 *   ③ **알려진 불일치 목록**(KNOWN_DIFF). 이 목록은 「아직 안 고친 결함」의 대장이다.
 *      · 목록에 없는 새 불일치      → 실패 (회귀)
 *      · 목록에 있는데 이제 일치함  → 실패 (고쳐졌으니 목록에서 빼고 골든을 갱신하라)
 *      · 목록에 있고 값도 그대로    → 「미해결 결함」으로 보고 (기본 실행에서는 EXIT 0)
 *
 * ── 실행 ──────────────────────────────────────────────────────────────────
 *   NODE_ENV=test node tests/test_path_parity.js
 *      → 알려진 불일치는 ⚠ 로 보고하고 EXIT 0 (npm test 를 막지 않는다)
 *   NODE_ENV=test PARITY_STRICT=1 node tests/test_path_parity.js
 *      → 알려진 불일치도 실패로 센다. **결함을 고친 뒤 이 모드가 초록이어야 한다.**
 *   NODE_ENV=test PARITY_DUMP=1 node tests/test_path_parity.js
 *      → 두 경로의 전체 레코드를 JSON 으로 찍는다(골든 갱신·조사용).
 *
 * ⚠ 이 파일은 운영 DB 에 접속하지 않는다. pglite(진짜 Postgres/wasm) 인스턴스 **1개**를
 *   띄워 `scripts/migrations/000_baseline.sql` 정본을 그대로 적용한다.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ══════════════════════════════════════════════════════════════════════════
// 0. 출력 (기존 테스트 파일들과 같은 형식)
// ══════════════════════════════════════════════════════════════════════════
let pass = 0;
let fail = 0;
let expected = 0;                 // 알려진 불일치(미해결 결함)
const failures = [];
const expectedIssues = [];

async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, message: e.message });
    console.log(`  ❌ ${name}\n     → ${e.message}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

function known(fixtureId, field, detail) {
  expected += 1;
  expectedIssues.push({ fixtureId, field, detail });
}

// ══════════════════════════════════════════════════════════════════════════
// 1. 픽스처 — 같은 canonical 제품을 두 경로에 넣는다
// ══════════════════════════════════════════════════════════════════════════
/**
 * ★ serving_size 를 NULL 로 두는 것이 핵심이다.
 *   실제 DB 의 products.serving_size 는 대부분 NULL 이다(식약처 C005 에 1회 제공량이 없다).
 *   바코드 경로는 그 NULL 을 그대로 신호등에 넘겨 RACC 가 1회량을 정하게 두지만,
 *   OCR 라우터는 `nutrition.serving_size || productInfo?.serving_size || 100`(ocrRoutes.js:262·447)
 *   으로 **항상 100 을 채워 넣는다.** RACC 는 4~15 g 이라 `100 >= 0.5*racc` 가 언제나 참이 되어
 *   RACC 1회량이 **전부 덮인다.** 이것이 아래 불일치의 단일 원인이다.
 *
 * ★ basis 는 per_100g/per_100ml 이다. 식약처 C005·수입식품 데이터가 그 형식이고,
 *   `deriveBasis(nutrition_data.serving_size)` 가 '100g'/'100ml' 문자열로 그것을 판정한다.
 */
const FIXTURES = [
  {
    id: 'sesame_oil',
    label: '참기름 (RACC oil 5g · 지방 가드)',
    barcode: 'PARITY0001',
    product_name: '오뚜기 참기름',
    food_type: '참기름',
    content_unit: 'ml',
    total_content: 320,
    serving_size: null,
    nd_serving: '100g',
    nutrition: {
      calories: 900, sodium: 0, total_sugars: 0, saturated_fat: 15, total_fat: 100,
      cholesterol: 0, protein: 0, dietary_fiber: 0, trans_fat: 0,
    },
  },
  {
    id: 'soy_sauce',
    label: '간장 (RACC sodium 5ml)',
    barcode: 'PARITY0002',
    product_name: '샘표 진간장',
    food_type: '간장',
    content_unit: 'ml',
    total_content: 500,
    serving_size: null,
    nd_serving: '100ml',
    nutrition: {
      calories: 60, sodium: 5900, total_sugars: 4, saturated_fat: 0, total_fat: 0,
      cholesterol: 0, protein: 8, dietary_fiber: 0, trans_fat: 0,
    },
  },
  {
    id: 'seasoned_laver',
    label: '조미김 (RACC sodium 4g + 건조식품)',
    barcode: 'PARITY0003',
    product_name: '광천 조미김',
    food_type: '조미김',
    content_unit: 'g',
    total_content: 20,
    serving_size: null,
    nd_serving: '100g',
    nutrition: {
      calories: 550, sodium: 1200, total_sugars: 1, saturated_fat: 4, total_fat: 40,
      cholesterol: 0, protein: 30, dietary_fiber: 30, trans_fat: 0,
    },
  },
  {
    id: 'laver_jaban_outlier',
    label: '김자반 (건조 + 100g당 1,100 kcal 이상치)',
    barcode: 'PARITY0004',
    product_name: '바다 김자반',
    food_type: '김자반',
    content_unit: 'g',
    total_content: 60,
    serving_size: null,
    nd_serving: '100g',
    // ★ 1,100 kcal/100g 은 실물 김자반 값이 아니다. **일부러** sanity 상한(900)을 넘긴다.
    //   sanityCheck 는 바로 이런 이상치를 잡으라고 있는 장치이고,
    //   `isDried` 를 하드코딩 false 로 넘기는 라우터에서만 경고가 뜨는 것을 재현한다.
    nutrition: {
      calories: 1100, sodium: 2500, total_sugars: 10, saturated_fat: 6, total_fat: 60,
      cholesterol: 0, protein: 25, dietary_fiber: 20, trans_fat: 0,
    },
  },
  {
    id: 'beef_jerky_control',
    label: '육포 (건조식품 · RACC 무관) — 대조군 A',
    barcode: 'PARITY0005',
    product_name: '오래장 육포',
    food_type: '육포',
    content_unit: 'g',
    total_content: 40,
    serving_size: null,
    nd_serving: '100g',
    // ★ 대조군 — RACC 가 없으면 바코드 경로도 `serving_size || 100` 로 100 을 쓴다.
    //   즉 두 경로가 **같은 1회량**을 쓰게 되고 전 항목이 일치해야 한다.
    //   여기서 불일치가 나면 원인은 serving_size 가 아니라 **다른 데** 있다는 뜻이다.
    nutrition: {
      calories: 410, sodium: 1600, total_sugars: 20, saturated_fat: 3, total_fat: 8,
      cholesterol: 60, protein: 50, dietary_fiber: 1, trans_fat: 0,
    },
  },
  {
    id: 'snack_control',
    label: '일반 과자 (RACC 무관 · per_100g) — 대조군 B',
    barcode: 'PARITY0006',
    product_name: '오리온 초코파이',
    food_type: '과자',
    content_unit: 'g',
    total_content: 420,
    serving_size: null,
    nd_serving: '100g',
    nutrition: {
      calories: 430, sodium: 250, total_sugars: 33, saturated_fat: 7, total_fat: 13,
      cholesterol: 5, protein: 4, dietary_fiber: 2, trans_fat: 0,
    },
  },
  {
    id: 'per_serving_control',
    label: '일반 과자 (1회 제공량 라벨 · per_serving) — 대조군 C',
    barcode: 'PARITY0007',
    product_name: '크래커 30g',
    food_type: '과자',
    content_unit: 'g',
    total_content: 300,
    serving_size: 30,          // ★ products.serving_size 가 있는 경우
    nd_serving: '30',          // deriveBasis → per_serving
    nutrition: {
      calories: 150, sodium: 180, total_sugars: 5, saturated_fat: 2, total_fat: 6,
      cholesterol: 0, protein: 3, dietary_fiber: 1, trans_fat: 0,
    },
  },
  // ══════════════════════════════════════════════════════════════════════════
  // ★★★ 세션49 추가 — 치명A(식품유형 정규화)를 고정하는 픽스처
  // ══════════════════════════════════════════════════════════════════════════
  // 왜 필요한가: 세션49 가 치명A 를 고친 뒤 뮤테이션을 돌려 보니
  //   「getRaccPolicy 를 정확 일치로 되돌린다」가 **27단정을 전부 통과**했다.
  //   원인은 위 7개 픽스처의 food_type 이 전부 정확 일치형('참기름'·'조미김')이라
  //   정규화 계층을 **한 번도 지나지 않기** 때문이었다. 고쳤는데 아무도 지키지 않는 상태다.
  //   → 실물 형태(캡처 006·027)를 픽스처로 넣는다.
  //
  // ★ 영양값을 기존 픽스처와 **똑같이** 둔 것은 의도다. 그러면 골든이
  //   「괄호형이 정확일치형과 완전히 같은 판정을 낸다」는 뜻이 되어, 값을 새로 계산해
  //   옮겨 적는(=테스트를 통과시키려고 골든을 맞추는) 일이 원천적으로 생기지 않는다.
  {
    id: 'laver_paren_l4',
    label: '조미김 — 실물 표기 「가공김(조미김)」 (L4 괄호 안 정규화)',
    barcode: 'PARITY0008',
    product_name: '대천김 곱창김',
    food_type: '가공김(조미김)',   // ← 캡처 006 실물. 정확 일치로는 매칭되지 않는다.
    content_unit: 'g',
    total_content: 20,
    serving_size: null,
    nd_serving: '100g',
    nutrition: {
      calories: 550, sodium: 1200, total_sugars: 1, saturated_fat: 4, total_fat: 40,
      cholesterol: 0, protein: 30, dietary_fiber: 30, trans_fat: 0,
    },
  },
  {
    id: 'soy_sauce_paren_l3',
    label: '간장 — 실물 표기 「간장(양조간장)」 (L3 괄호 밖 정규화)',
    barcode: 'PARITY0009',
    product_name: '샘표 양조간장',
    food_type: '간장(양조간장)',   // ← 괄호 밖이 주된 유형. 정확 일치로는 매칭되지 않는다.
    content_unit: 'ml',
    total_content: 500,
    serving_size: null,
    nd_serving: '100ml',
    nutrition: {
      calories: 60, sodium: 5900, total_sugars: 4, saturated_fat: 0, total_fat: 0,
      cholesterol: 0, protein: 8, dietary_fiber: 0, trans_fat: 0,
    },
  },
];

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 세션50 D2 — 파생 픽스처 F1 · F2
// ══════════════════════════════════════════════════════════════════════════
/**
 * 왜 필요한가 (세션50 조사 `.tmp/s50/d2/FINDINGS.md` §A-6):
 *   위 9개 픽스처로는 뮤테이션 **M3**(`sanityCheck` 3번째 인자를 `true` 로 고정 = 면제를 항상 적용)를
 *   잡을 수 없다. 「비건조 + 100 g 상한 초과」가 **한 건도 없기** 때문이다
 *   (참기름 지방 100 은 `>100` 이 아니고, 과자 430 kcal 은 900 미만이다).
 *   반대로 「엔진 sanity 를 그냥 `[]` 로 만드는」 과잉 억제 뮤테이션도 잡히지 않는다.
 *
 * ★★ **골든을 새로 계산해 옮겨 적지 않기 위한 설계** —
 *   기존 픽스처의 영양값을 그대로 쓰고 **열량 한 칸만** 바꾼다.
 *   `calories` 는 GOLDEN_BAR 가 비교하는 8영양소(NUTRIENTS)에 **들어 있지 않다.**
 *   따라서 색·%DV·basis·per_100 골든은 원본 픽스처의 것을 **그대로 참조**할 수 있고,
 *   달라지는 것은 이 픽스처가 존재하는 이유인 **sanity 키 하나뿐**이다.
 *   (세션49 의 `get laver_paren_l4()` 와 같은 패턴이다 — 값을 풀어 적지 말 것.)
 */
const _fx = (id) => FIXTURES.find((f) => f.id === id);

FIXTURES.push(
  {
    // F1 — 비건조 + 100 g 상한 초과. 건조 면제가 **모든 제품에 적용되면** 여기서만 경고가 사라진다.
    id: 'calorie_outlier_general',
    label: 'F1 · 일반식품(비건조) + 100g당 1,100 kcal 이상치 — 면제가 새어 나가면 여기서 잡힌다',
    barcode: 'PARITY0010',
    product_name: '오리온 초코파이 라지',   // ⚠ 건조·발효·음료 키워드가 없어야 한다(detectFoodCategory 3단계)
    food_type: '과자',
    content_unit: 'g',
    total_content: 420,
    serving_size: null,
    nd_serving: '100g',
    nutrition: { ..._fx('snack_control').nutrition, calories: 1100 },
  },
  {
    // F2 — 건조 + **1회 상한** 초과. 건조식품이어도 면제되지 않는 검사가 살아 있음을 고정한다.
    //   100 g 상한(900 kcal)은 건조 면제로 안 걸리지만, 1회 상한(2,000 kcal)은 걸려야 한다.
    id: 'laver_jaban_serving_outlier',
    label: 'F2 · 건조식품 + 1회 상한(2,000 kcal) 초과 — 건조여도 면제되지 않는 검사',
    barcode: 'PARITY0011',
    product_name: '바다 김자반 대용량',
    food_type: '김자반',
    content_unit: 'g',
    total_content: 60,
    serving_size: null,
    nd_serving: '100g',
    nutrition: { ..._fx('laver_jaban_outlier').nutrition, calories: 2500 },
  },
);

// ══════════════════════════════════════════════════════════════════════════
// 2. ★★★ 알려진 불일치 대장 (KNOWN_DIFF)
// ══════════════════════════════════════════════════════════════════════════
/**
 * 키: `<fixtureId>::<필드경로>`
 * 값: { bar, ocr, defect, why }
 *
 * ★ 규칙 (이 세 줄이 이 파일의 전부다)
 *   · 목록에 **없는** 불일치가 나오면 → 실패. 새 회귀다.
 *   · 목록에 **있는데 값이 다르면** → 실패. 결함의 크기가 바뀌었다(부분 수정·부작용).
 *   · 목록에 **있는데 이제 일치하면** → 실패. **고쳐진 것이니 이 줄을 지우고 골든을 갱신하라.**
 *
 * ── 결함 대장 ─────────────────────────────────────────────────────────────
 *   D1  ✅ **세션49 해결.** (기록 보존 — 왜 이 골든이 이 값인지의 근거다)
 *       결함: ocrRoutes.js `serving_size: nutrition.serving_size || productInfo?.serving_size || 100`
 *       RACC 1회량(4~15 g)을 항상 100 이 덮었다. `100 >= 0.5*racc` 가 언제나 참이기 때문이다.
 *       → 소량식품(기름·장류·조미김)의 색이 OCR 경로에서만 빨강으로 뒤집혔다(31건).
 *       수정: 두 엔드포인트가 `explicitServingSize`(근거 없으면 null)를 그대로 넘긴다.
 *             1회량 선택과 그 **출처**는 엔진 한 곳(nutritionTrafficLight)에서만 정하고,
 *             결과를 `traffic_light.serving_basis.source`('label'|'racc'|'default_100')로 노출한다.
 *       ★ 함께 고쳐야 했던 것(치명A): `getRaccPolicy` 가 정확 일치만 해서 **매칭률 0** 이었다.
 *         정규화를 src/services/foodTypeMatch.js 로 모아 raccTable 과 공유하게 했다.
 *         둘 중 하나만 고치면 이 31건은 그대로 남는다 — 그래서 원자적으로 고쳤다.
 *
 *   D2  ✅ **세션50 해결.** (기록 보존 — 왜 §4·§7~§10 이 이 형태인지의 근거다)
 *       결함: `sanityCheck(…, false, …)` — 3번째 인자 `isDried` 가 **세 소비자에서 하드코딩 false**
 *         였다(ocrRoutes.js:216 · productRoutes.js:94 · crowdsourceService.js:165).
 *         엔진은 `detectFoodCategory(product) === 'dried'` 를 넘긴다.
 *         → 같은 김자반이 바코드에선 경고 0건, OCR 응답(data.sanity_warnings)에선 1건.
 *         더 나쁜 것: OCR 응답이 `traffic_light.sanity_warnings`(엔진)와
 *         `data.sanity_warnings`(라우터)를 **동시에** 실어 자기모순 상태로 나갔고,
 *         화면(public/ocr-test.html:465)은 하필 라우터 쪽 = 틀린 쪽을 읽었다.
 *         crowdsource 쪽은 읽기가 아니라 **쓰기 게이트**라, 건조식품 제보가 부당하게 반려됐다.
 *       수정: 판정·계산을 **엔진 한 곳**으로 모았다. `sanityCheck` 의 기본값 `= false` 를 제거하고
 *         (인자 누락이 조용히 「건조 아님」이 되던 것을 막는다), 소비자 3곳을 **동시에**
 *         `evaluateNutrition(...).sanity_warnings` 수신으로 바꿨다. 한 곳만 고치면 결함이
 *         자리만 옮긴다(`/analyze` 는 0건인데 `/evaluate` 는 1건).
 *         `data.sanity_warnings` 는 지우지 않고 **같은 배열 참조**로 대입했다 —
 *         값이 두 번 계산될 수 없으므로 모순이 **구조적으로 불가능**해진다.
 *         `getContext`(두 번째 판정기)도 건조·제외 판정을 그만두고 엔진 값을 받아 쓴다.
 *
 *   D5  ✅ **세션51 해결.** (기록 보존)
 *       결함: `src/utils/foodCategory.js` 가 `food_type` 을 자체 13분류(KEYWORD_RULES)했고,
 *       엔진 `detectFoodCategory` 는 6분류였다. 같은 응답이 서로 다른 답을 실었다.
 *         실측: 조미김·김자반 → context 'general' / 엔진 'dried'
 *               간장(2종)    → context 'fermented' / 엔진 'beverage'
 *         픽스처 5건 · 실모집단(HACCP 덤프 14,682) **2,235건(15.2%)**.
 *       사용자에게 보이던 모순 2종:
 *         ① 「주류는 평가 대상이 아닙니다」 안내 + 색이 칠해진 신호등 — 15종
 *         ② 「100mL 기준으로 평가됩니다」 안내 ↔ 실제 사용 기준 — ml 포장 88건 · g 포장 10건
 *       수정(A안): `getContext` 가 분류를 그만두고 `trafficLight.food_category` 를 그대로 쓴다.
 *         카테고리 어휘를 엔진 6종(general·beverage·fermented·dried·alcohol·supplement)으로 접었다.
 *         비용: sauce·soup·nuts·dairy·whole_grain 안내 문구 소멸(14~17종).
 *         근거: **클라이언트가 `context.*` 를 한 곳도 읽지 않는다**(2026-08-06 `web/` 실측) —
 *               사용자에게 보이지 않는 비용이다.
 *         ⚠ B안(엔진을 13분류로 확장)은 기각했다 — `juice` 를 음료로 잡으면 당류 임계가
 *           5g→2.5g 로 **색이 바뀌고**, `raw_ingredient` 는 신호등이 통째로 사라진다.
 *         ⚠ `getContext` 안에서 `detectFoodCategory` 를 부르는 방식은 여전히 금지 — 읽기 경계에
 *           판정이 또 생기면 세션48 근본원인 진단(「여러 경로에서 재해석」)이 그대로 재발한다.
 *
 *   D3  ✅ **세션49 해결.** (기록 보존)
 *       결함: 조회 경로가 pg NUMERIC 을 **문자열 그대로** 엔진에 넘겼다.
 *       node-postgres 는 NUMERIC 을 정밀도 보존을 위해 string 으로 준다(pglite 도 동일).
 *       그래서 sanityCheck 의 `sat_fat > total_fat` 가 **사전식 비교**가 됐다:
 *       '7' > '13' → true, '15' > '100' → true → 정상 제품에 거짓 경고(바코드 경로만).
 *       수정: `src/models/productModel.js` 의 **읽기 경계 한 곳**에서 숫자로 좁힌다.
 *             `toNumericOrNull` — null/''/파싱불가는 **null 로 남긴다**(Number() 는 0 이 되어
 *             「데이터 없음」이 「0」이 되고 신호등이 초록을 칠한다. 이것이 가장 위험한 오답이다).
 *             sanityCheck 안에서 방어하지 않았다 — 같은 규칙이 두 곳에 생기면 세션48 외부 검증이
 *             근본 원인으로 지목한 「여러 경로에서 재해석」이 그대로 재발한다.
 *       ⚠ 함께 밝혀진 사실 2가지 (세션49 실측, 대장 D3 설명의 정정):
 *         · mass_balance 는 「NaN 이라 무동작」이 아니라 `'60'+'20'+'25'='602025' > 33` 이 true 라
 *           분기에 **들어간 뒤** `macroSum.toFixed()` 에서 TypeError → **바코드 조회 전건 500** 이었다.
 *         · 그런데 mass_balance 가 실제로 안 도는 진짜 이유는 D3 가 아니다.
 *           productService·ocrRoutes **양쪽**이 엔진 입력에 `total_carbs` 를 넣지 않는다.
 *           → §8-3 의 미해결 항목. 배선하려면 두 경로를 **동시에** 고쳐야 한다.
 *
 *   D4  응답 키 집합이 다르다. 바코드 경로는 알레르기 4키를 내는데
 *       OCR 경로는 `allergens` · `allergens_v2` 2키뿐이다
 *       (`allergens_available` · `allergens_flat_complete` 없음).
 *       → 같은 「혼입만 있는 제품」이 OCR 화면에서는 「알레르기 없음」으로 읽힌다(과소경고).
 *       상세 계약은 tests/test_allergen_contract.js 가 본다. 여기서는 **키 집합**만 본다.
 */
const KNOWN_DIFF = {
  // ── D1 (31건) — ✅ 세션49 에 고쳐져 **대장에서 제거**했다. 아래 §2 가 이제 동등성을 강제한다.
  // ── D3 (4건)  — ✅ 세션49 에 고쳐져 **대장에서 제거**했다. GOLDEN_BAR 의 sanity 도 '' 로 갱신했다.
  // ── D2 (2건)  — ✅ 세션50 에 고쳐져 **대장에서 제거**했다.
  //      ① 'laver_jaban_outlier::exposed_sanity' (바코드 "" ↔ OCR "calories:per_100g_exceeded")
  //      ② §4 의 「OCR 응답 내부 모순」 전용 단정
  //      아래 §4·§7·§8·§9 가 이제 **참조 동일성**으로 재발을 막는다(값이 우연히 같아진 것과 구별된다).
  // ── D5 — 두 경로 비교가 아니라 **한 응답 안의 모순**이라 이 표에 넣을 수 없다. §10 이 known() 으로 센다.
};

// ══════════════════════════════════════════════════════════════════════════
// 3. 골든 — 바코드 경로의 절대값
// ══════════════════════════════════════════════════════════════════════════
/**
 * ★ 왜 절대값도 못 박는가 —
 *   두 경로가 **같은 방향으로 함께** 망가지면 동등성 비교는 전부 초록이다.
 *   4차 검증의 뮤테이션 M3(`getRaccPolicy` 인자 제거)이 정확히 그런 형태였다.
 *   아래 골든은 「참기름 포화지방 = 노랑 5%(RACC 5g 기준)」처럼 **정책이 뜻하는 값**이다.
 *   RACC 배선이 끊기면 basis 가 `racc_oil_guard` → `pct_dv` 로 바뀌어 여기서 잡힌다.
 *
 * ⚠ 골든을 고칠 때는 반드시 **정책 문서(IP/racc_policy_v1.md)와 대조**하고 이유를 적을 것.
 *   테스트를 통과시키려고 값을 옮겨 적으면 이 파일은 그 순간 무의미해진다.
 */
const GOLDEN_BAR = {
  // ★ 값의 형식: [color, pct_dv, basis, per_100]
  //   `per_100` 은 **절대량 컷오프를 실제로 계산한 경우에만** 채워진다.
  //   건조식품(면제)·양성 영양소(단백질/식이섬유)·콜레스테롤은 null 이 정상이다.
  sesame_oil: {
    // RACC 5 g 기준. 포화지방 0.75 g = 5%DV → 노랑(oil 가드가 초록을 금지한다).
    food_category: 'general', is_excluded: false, exclude_reason: null,
    is_dried_exception: false, is_withheld: false, withhold_reason: null,
    'nutrients.sodium': ['green', 0, 'pct_dv_racc', 0],
    'nutrients.sugars': ['green', 0, 'pct_dv_racc', 0],
    'nutrients.sat_fat': ['yellow', 5, 'racc_oil_guard', 15],
    'nutrients.total_fat': ['yellow', 9.3, 'racc_oil_guard', 100],
    'nutrients.cholesterol': ['green', 0, 'pct_dv_racc', null],
    'nutrients.protein': ['gray', 0, 'pct_dv', null],
    'nutrients.fiber': ['gray', 0, 'pct_dv', null],
    'nutrients.trans_fat': ['green', null, 'absolute', null],
    // ★ 세션49 D3 해결 — 종전 골든은 'sat_fat:exceeds_total_fat' 였고 그것은 **거짓 경고**였다
    //   ('15' > '100' 사전식 비교). 참기름은 포화 15 g / 총지방 100 g 이라 경고가 없는 것이 옳다.
    //   실측으로 확인: 읽기 경계에서 숫자로 좁힌 뒤 두 경로 모두 '' 다.
    engine_sanity: '',
    exposed_sanity: '',
  },
  soy_sauce: {
    // RACC 5 ml 기준. 나트륨 295 mg = 14.8%DV → 노랑(sodium 가드가 초록을 금지한다).
    // ⚠ food_category 가 'beverage' 인 것은 content_unit='ml' 때문이다(detectFoodCategory 2단계).
    //   간장을 음료로 보는 것은 별개의 논점이지만 **두 경로가 똑같이** 그렇게 보므로 동등성은 성립한다.
    food_category: 'beverage', is_excluded: false, exclude_reason: null,
    is_dried_exception: false, is_withheld: false, withhold_reason: null,
    'nutrients.sodium': ['yellow', 14.8, 'racc_sodium_guard', 5900],
    'nutrients.sugars': ['green', 0.2, 'pct_dv_racc', 4],
    'nutrients.sat_fat': ['green', 0, 'pct_dv_racc', 0],
    'nutrients.total_fat': ['green', 0, 'pct_dv_racc', 0],
    'nutrients.cholesterol': ['green', 0, 'pct_dv_racc', null],
    'nutrients.protein': ['gray', 0.7, 'pct_dv', null],
    'nutrients.fiber': ['gray', 0, 'pct_dv', null],
    'nutrients.trans_fat': ['green', null, 'absolute', null],
    // 100 ml 당 5,900 mg 은 1회 상한(5,000 mg)을 넘는다 — 이 경고는 옳다(두 경로 모두 낸다).
    engine_sanity: 'sodium:per_serving_exceeded',
    exposed_sanity: 'sodium:per_serving_exceeded',
  },
  seasoned_laver: {
    food_category: 'dried', is_excluded: false, exclude_reason: null,
    is_dried_exception: true, is_withheld: false, withhold_reason: null,
    'nutrients.sodium': ['yellow', 2.4, 'racc_sodium_guard', null],
    'nutrients.sugars': ['green', 0, 'pct_dv_racc', null],
    'nutrients.sat_fat': ['green', 1.1, 'pct_dv_racc', null],
    'nutrients.total_fat': ['green', 3, 'pct_dv_racc', null],
    'nutrients.cholesterol': ['green', 0, 'pct_dv_racc', null],
    'nutrients.protein': ['gray', 2.2, 'pct_dv', null],
    'nutrients.fiber': ['gray', 4.8, 'pct_dv', null],
    'nutrients.trans_fat': ['green', null, 'absolute', null],
    engine_sanity: '',
    exposed_sanity: '',
  },
  laver_jaban_outlier: {
    food_category: 'dried', is_excluded: false, exclude_reason: null,
    is_dried_exception: true, is_withheld: false, withhold_reason: null,
    'nutrients.sodium': ['yellow', 6.3, 'racc_sodium_guard', null],
    'nutrients.sugars': ['green', 0.5, 'pct_dv_racc', null],
    'nutrients.sat_fat': ['green', 2, 'pct_dv_racc', null],
    'nutrients.total_fat': ['green', 5.6, 'pct_dv_racc', null],
    'nutrients.cholesterol': ['green', 0, 'pct_dv_racc', null],
    'nutrients.protein': ['gray', 2.3, 'pct_dv', null],
    'nutrients.fiber': ['gray', 4, 'pct_dv', null],
    'nutrients.trans_fat': ['green', null, 'absolute', null],
    // ★ 건조식품이므로 100g당 상한(900 kcal) 검사를 **면제**한다 = 경고 0건이 맞다.
    //   OCR 라우터는 isDried 를 하드코딩 false 로 넘겨 여기서만 경고 1건을 낸다(D2).
    engine_sanity: '',
    exposed_sanity: '',
  },
  beef_jerky_control: {
    food_category: 'dried', is_excluded: false, exclude_reason: null,
    is_dried_exception: true, is_withheld: false, withhold_reason: null,
    'nutrients.sodium': ['red', 80, 'pct_dv', null],
    'nutrients.sugars': ['yellow', 20, 'pct_dv', null],
    'nutrients.sat_fat': ['yellow', 20, 'pct_dv', null],
    'nutrients.total_fat': ['yellow', 14.8, 'pct_dv', null],
    'nutrients.cholesterol': ['yellow', 20, 'pct_dv', null],
    'nutrients.protein': ['green', 90.9, 'pct_dv', null],
    'nutrients.fiber': ['gray', 4, 'pct_dv', null],
    'nutrients.trans_fat': ['green', null, 'absolute', null],
    engine_sanity: '',
    exposed_sanity: '',
  },
  snack_control: {
    food_category: 'general', is_excluded: false, exclude_reason: null,
    is_dried_exception: false, is_withheld: false, withhold_reason: null,
    'nutrients.sodium': ['yellow', 12.5, 'pct_dv', 250],
    'nutrients.sugars': ['red', 33, 'pct_dv', 33],
    'nutrients.sat_fat': ['red', 46.7, 'pct_dv', 7],
    'nutrients.total_fat': ['yellow', 24.1, 'pct_dv', 13],
    'nutrients.cholesterol': ['green', 1.7, 'pct_dv', null],
    'nutrients.protein': ['yellow', 7.3, 'pct_dv', null],
    'nutrients.fiber': ['yellow', 8, 'pct_dv', null],
    'nutrients.trans_fat': ['green', null, 'absolute', null],
    // ★ 세션49 D3 해결 — 종전 골든은 'sat_fat:exceeds_total_fat' 였고 **거짓 경고**였다
    //   ('7' > '13' 사전식 비교). 포화지방 7 g < 총지방 13 g 이므로 경고가 없는 것이 옳다.
    engine_sanity: '',
    exposed_sanity: '',
  },
  per_serving_control: {
    // ★ 여기서 basis 가 'per_100g' 인 것은 **입력 표기 기준**이 아니라
    //   worse-of 이중기준에서 「100g당 절대량」 쪽이 이겼다는 뜻이다(입력은 per_serving).
    food_category: 'general', is_excluded: false, exclude_reason: null,
    is_dried_exception: false, is_withheld: false, withhold_reason: null,
    'nutrients.sodium': ['yellow', 9, 'per_100g', 600],
    'nutrients.sugars': ['red', 5, 'per_100g', 16.7],
    'nutrients.sat_fat': ['red', 13.3, 'per_100g', 6.7],
    'nutrients.total_fat': ['red', 11.1, 'per_100g', 20],
    'nutrients.cholesterol': ['green', 0, 'pct_dv', null],
    'nutrients.protein': ['yellow', 5.5, 'pct_dv', null],
    'nutrients.fiber': ['gray', 4, 'pct_dv', null],
    'nutrients.trans_fat': ['green', null, 'absolute', null],
    engine_sanity: '',
    exposed_sanity: '',
  },
  // ★★★ 세션49 — 치명A 픽스처의 골든.
  //   **값을 새로 계산해 적지 않았다.** 정확일치형 골든을 그대로 참조한다.
  //   그래서 이 두 줄의 뜻은 「괄호형 표기가 정확일치형과 **완전히 같은 판정**을 낸다」이고,
  //   정규화가 깨지면 basis 가 racc_* → pct_dv 로 떨어지며 여기서 즉시 빨강이 된다.
  //   ⚠ 이 참조를 풀어서 값을 옮겨 적지 말 것. 그 순간 두 골든이 따로 흐를 수 있게 된다.
  get laver_paren_l4() { return GOLDEN_BAR.seasoned_laver; },
  get soy_sauce_paren_l3() { return GOLDEN_BAR.soy_sauce; },

  // ★★★ 세션50 F1 · F2 의 골든 — **값을 새로 계산해 적지 않았다.**
  //   원본 픽스처의 골든을 그대로 펼치고, 이 픽스처가 존재하는 이유인 **sanity 키만** 바꾼다.
  //   (픽스처 정의도 원본의 nutrition 을 그대로 쓰고 `calories` 한 칸만 바꿨다.
  //    calories 는 NUTRIENTS 8종에 없으므로 색·%DV·basis·per_100 은 원본과 같아야 **한다**.)
  //   ⚠ 이 참조를 풀어서 값을 옮겨 적지 말 것. 그 순간 두 골든이 따로 흐를 수 있게 된다.
  get calorie_outlier_general() {
    // 비건조 1,100 kcal/100g → 100 g 상한(900)에 걸린다. 1회 상한(2,000)에는 안 걸린다.
    return {
      ...GOLDEN_BAR.snack_control,
      engine_sanity: 'calories:per_100g_exceeded',
      exposed_sanity: 'calories:per_100g_exceeded',
    };
  },
  get laver_jaban_serving_outlier() {
    // 건조 2,500 kcal/100g → 100 g 상한은 **면제**, 1회 상한(2,000)은 **면제되지 않는다.**
    return {
      ...GOLDEN_BAR.laver_jaban_outlier,
      engine_sanity: 'calories:per_serving_exceeded',
      exposed_sanity: 'calories:per_serving_exceeded',
    };
  },
};

// ══════════════════════════════════════════════════════════════════════════
// 4. 두 경로를 부르는 하네스
// ══════════════════════════════════════════════════════════════════════════
const SRV = path.join(__dirname, '..');
const BASELINE = path.join(SRV, 'scripts', 'migrations', '000_baseline.sql');

const NUTRIENTS = ['sodium', 'sugars', 'sat_fat', 'total_fat', 'cholesterol', 'protein', 'fiber', 'trans_fat'];

function round1(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/** sanity 경고 목록 → 정렬된 문자열(비교·출력용). 값은 부동소수라 넣지 않는다. */
function sanityKeys(list) {
  if (!Array.isArray(list)) return '';
  return list.map((w) => `${w.nutrient}:${w.type}`).sort().join(',');
}

/** 신호등 결과 + 응답에 실제로 실린 sanity → 비교 레코드(평평한 객체) */
function toRecord(tl, exposedSanity) {
  const rec = {
    food_category: tl ? tl.food_category : null,
    is_excluded: !!(tl && tl.is_excluded),
    exclude_reason: (tl && tl.exclude_reason) || null,
    is_dried_exception: !!(tl && tl.is_dried_exception),
    is_withheld: !!(tl && tl.is_withheld),
    withhold_reason: (tl && tl.withhold_reason) || null,
    engine_sanity: sanityKeys(tl && tl.sanity_warnings),
    exposed_sanity: sanityKeys(exposedSanity),
    // ★★ 세션50 — 세션49 가 만든 `serving_basis` 를 여기 넣는다.
    //   §6 마지막 단정(`dump[id].bar.serving_basis` 비교)이 **양쪽 다 undefined** 를 비교하고 있었다
    //   = 언제나 통과하는 빈 단정이었다. 레코드에 실어야 그 단정이 실제로 무언가를 지킨다.
    //   (골든은 이 키를 갖지 않는다 — §1① 은 골든의 키만 훑으므로 갱신이 필요 없다.)
    serving_basis: (tl && tl.serving_basis) || null,
  };
  for (const k of NUTRIENTS) {
    const x = (tl && tl.nutrients && tl.nutrients[k]) || {};
    rec[`nutrients.${k}.color`] = x.color === undefined ? null : x.color;
    rec[`nutrients.${k}.pct_dv`] = round1(x.pct_dv);
    rec[`nutrients.${k}.basis`] = x.basis === undefined ? null : x.basis;
    rec[`nutrients.${k}.per_100`] = round1(x.per_100);
  }
  return rec;
}

/** GOLDEN_BAR 항목 → toRecord 와 같은 평평한 형태 */
function goldenToRecord(g) {
  const rec = {
    food_category: g.food_category,
    is_excluded: g.is_excluded,
    exclude_reason: g.exclude_reason,
    is_dried_exception: g.is_dried_exception,
    is_withheld: g.is_withheld,
    withhold_reason: g.withhold_reason,
    engine_sanity: g.engine_sanity,
    exposed_sanity: g.exposed_sanity,
  };
  for (const k of NUTRIENTS) {
    const [color, pct, basis, per100] = g[`nutrients.${k}`];
    rec[`nutrients.${k}.color`] = color;
    rec[`nutrients.${k}.pct_dv`] = pct;
    rec[`nutrients.${k}.basis`] = basis;
    rec[`nutrients.${k}.per_100`] = per100;
  }
  return rec;
}

async function main() {
  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (_) {
    console.log('⏭  pglite 미설치 — 경로 동등성 검증을 수행할 수 없다 (npm i -D @electric-sql/pglite)');
    console.log('   ★ 이 테스트의 목적상 「건너뜀」은 「통과」가 아니다. EXIT=1 로 남긴다.');
    process.exit(1);
  }

  // ── pglite 인스턴스 1개. 부팅이 이 파일 전체 시간의 대부분이므로 절대 재생성하지 않는다.
  const db = new PGlite();
  try {
    await db.exec(fs.readFileSync(BASELINE, 'utf8'));
  } catch (e) {
    console.error(`000_baseline.sql 적용 실패 — 픽스처가 아니라 정본 SQL 문제다: ${e.message}`);
    process.exit(1);
  }

  // ── src/config/database 를 pglite 로 갈아끼운다(정본 함수를 그대로 호출하기 위함).
  const shim = {
    pool: null,
    query: (text, params) => db.query(text, params || []),
    transaction: async (cb) => {
      await db.exec('BEGIN');
      try {
        const r = await cb({ query: (tx, p) => db.query(tx, p || []) });
        await db.exec('COMMIT');
        return r;
      } catch (e) { await db.exec('ROLLBACK'); throw e; }
    },
    healthCheck: async () => ({ status: 'healthy' }),
  };
  const dbPath = require.resolve('../src/config/database');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };

  // ── Google Vision 을 부르지 않도록 ocrService 를 스텁으로 갈아끼운다.
  //   ★ 파서를 스텁하지 않는다. 라우터가 실제로 하는 일(파싱·병합·판정 배선)을 그대로 통과시킨다.
  let LABEL_TEXT = '';
  const ocrSvcPath = require.resolve('../src/services/ocrService');
  require.cache[ocrSvcPath] = {
    id: ocrSvcPath, filename: ocrSvcPath, loaded: true,
    exports: {
      callVisionAPI: async () => ({
        full_text: LABEL_TEXT, avg_confidence: 0.95, block_count: 3, elapsed_ms: 1,
      }),
      correctOcrText: (txt) => ({ corrected: txt, corrections: [] }),
    },
  };

  const productService = require('../src/services/productService');
  const ocrRoutes = require('../src/routes/ocrRoutes');
  const { getRaccPolicy } = require('../src/services/raccPolicy');

  // ── OCR 경로 호출기 —
  //   ★ `judgeNutrition` 만 부르면 **결함이 있는 줄을 통과하지 않는다.**
  //     `serving_size ... || 100`(D1)과 `sanityCheck(..., false, ...)`(D2)는
  //     judgeNutrition 의 **바깥**(라우터 핸들러 본문)에 있다.
  //     그래서 `/analyze` 핸들러 자체를 부른다. multer 는 multipart 가 아니면 next() 로 지나간다.
  const analyzeLayer = ocrRoutes.stack.find((l) => l.route && l.route.path === '/analyze');

  async function callAnalyze(body) {
    const req = { body, headers: {}, method: 'POST', url: '/analyze' };
    let out = null;
    const res = { json: (o) => { out = o; return res; }, status: () => res, set: () => res };
    for (const s of analyzeLayer.route.stack) {
      await new Promise((resolve, reject) => {
        let done = false;
        const next = (e) => { if (done) return; done = true; e ? reject(e) : resolve(); };
        try {
          const r = s.handle(req, res, next);
          if (r && typeof r.then === 'function') r.then(() => { if (!done) { done = true; resolve(); } }, next);
        } catch (e) { next(e); }
      });
      if (out) break;
    }
    if (!out) throw new Error('/analyze 핸들러가 응답을 만들지 않았다');
    return out;
  }

  // ── 픽스처 적재
  for (const f of FIXTURES) {
    const r = await db.query(
      `INSERT INTO products (barcode, product_name, food_type, content_unit, total_content, serving_size, data_source)
       VALUES ($1,$2,$3,$4,$5,$6,'manual_seed') RETURNING product_id`,
      [f.barcode, f.product_name, f.food_type, f.content_unit, f.total_content, f.serving_size],
    );
    const pid = r.rows[0].product_id;
    const n = f.nutrition;
    await db.query(
      `INSERT INTO nutrition_data (product_id, calories, sodium, total_sugars, saturated_fat, total_fat,
         cholesterol, protein, dietary_fiber, trans_fat, serving_size, data_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'public_nutrition')`,
      [pid, n.calories, n.sodium, n.total_sugars, n.saturated_fat, n.total_fat,
        n.cholesterol, n.protein, n.dietary_fiber, n.trans_fat, f.nd_serving],
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§0. 도달 가능성 — 두 경로를 실제로 부를 수 있는가');

  await t('★ ocrRoutes 가 judgeNutrition 을 export 한다 (없으면 복사본 검사로 퇴화한다)', () => {
    assert.strictEqual(typeof ocrRoutes.judgeNutrition, 'function',
      'judgeNutrition 이 export 되지 않았다 — 소스를 고쳐 export 하지 말고 이 사실을 보고할 것');
  });

  await t('★ /analyze 라우트 핸들러에 도달할 수 있다 (D1·D2 는 이 핸들러 본문에 있다)', () => {
    assert.ok(analyzeLayer, 'POST /analyze 레이어를 찾지 못했다');
    assert.ok(analyzeLayer.route.stack.length >= 1);
  });

  await t('★ getProductWithTrafficLight 가 pglite 로 실제 동작한다', async () => {
    const r = await productService.getProductWithTrafficLight('PARITY0001');
    assert.ok(r && r.traffic_light, '신호등이 만들어지지 않았다 — 픽스처 적재가 실패했다');
    assert.strictEqual(r.product.product_name, '오뚜기 참기름');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§1. 픽스처별 경로 동등성');

  const dump = {};
  // ★ 세션50 — 응답 **객체 자체**를 보관한다. §4·§10 은 값이 아니라
  //   「같은 배열인가(참조 동일성)」·「한 응답 안에서 두 키가 같은 말을 하는가」를 본다.
  //   평평한 레코드(dump)만으로는 「같은 값을 두 번 계산한 것」과 구별할 수 없다(뮤테이션 M4).
  const raw = {};

  for (const f of FIXTURES) {
    // ── 경로 A: 바코드 조회
    const bcRes = await productService.getProductWithTrafficLight(f.barcode);
    // 바코드 응답에는 별도 sanity 키가 없다. 화면에 실리는 것 = traffic_light.sanity_warnings.
    const barRec = toRecord(bcRes.traffic_light, bcRes.traffic_light && bcRes.traffic_light.sanity_warnings);

    // ── 경로 B: OCR (`/analyze` 핸들러 본문 전체)
    //   ★ 라벨 텍스트는 파서가 영양값을 **덮어쓰지 않도록** 최소로 둔다.
    //     영양값은 product_info.nutrition 으로 canonical fixture 를 그대로 주입한다
    //     (라우터가 `analysis.nutrition = {...analysis.nutrition, ...productInfo.nutrition}` 로 병합한다).
    //     이렇게 해야 「두 경로에 **같은 값**을 넣었을 때 다른 답이 나오는가」만 남는다.
    LABEL_TEXT = `${f.product_name}\n식품유형 ${f.food_type}\n영양성분`;
    const basis = f.nd_serving === '100ml' ? 'per_100ml'
      : f.nd_serving === '100g' ? 'per_100g' : 'per_serving';
    const ocrRes = await callAnalyze({
      image: 'x'.repeat(400),
      product_info: {
        product_name: f.product_name,
        food_type: f.food_type,
        content_unit: f.content_unit,
        total_content: f.total_content,
        serving_size: f.serving_size,          // ★ null 인 픽스처는 라우터가 100 으로 채운다(D1)
        nutrition: { ...f.nutrition, _basis: basis },
      },
    });
    const ocrTl = ocrRes.data.traffic_light;
    const ocrRec = toRecord(ocrTl, ocrRes.data.sanity_warnings);

    dump[f.id] = { bar: barRec, ocr: ocrRec };
    raw[f.id] = { bar: bcRes, ocr: ocrRes.data };

    // ── ① 바코드 경로 골든 (절대값)
    await t(`[${f.id}] 바코드 경로가 골든과 같다 — ${f.label}`, () => {
      const g = goldenToRecord(GOLDEN_BAR[f.id]);
      const bad = [];
      for (const k of Object.keys(g)) {
        if (JSON.stringify(barRec[k]) !== JSON.stringify(g[k])) {
          bad.push(`    ${k}: 골든=${JSON.stringify(g[k])}  실제=${JSON.stringify(barRec[k])}`);
        }
      }
      assert.strictEqual(bad.length, 0,
        `바코드 경로 판정이 골든과 다르다 (RACC 배선이 끊겼거나 판정 규칙이 바뀌었다):\n${bad.join('\n')}`);
    });

    // ── ② 두 경로 차이 → KNOWN_DIFF 대장과 대조
    await t(`[${f.id}] OCR 경로와의 차이가 대장(KNOWN_DIFF)과 정확히 일치한다`, () => {
      const problems = [];
      const seen = new Set();

      for (const k of Object.keys(barRec)) {
        const key = `${f.id}::${k}`;
        const same = JSON.stringify(barRec[k]) === JSON.stringify(ocrRec[k]);
        const entry = KNOWN_DIFF[key];

        if (!same && !entry) {
          problems.push(
            `    [새 불일치] ${k}\n`
            + `      바코드=${JSON.stringify(barRec[k])}  OCR=${JSON.stringify(ocrRec[k])}\n`
            + '      → 같은 제품이 조회 경로에 따라 다른 답을 낸다. 대장에 없는 회귀다.');
        } else if (!same && entry) {
          seen.add(key);
          const okBar = JSON.stringify(barRec[k]) === JSON.stringify(entry.bar);
          const okOcr = JSON.stringify(ocrRec[k]) === JSON.stringify(entry.ocr);
          if (!okBar || !okOcr) {
            problems.push(
              `    [대장과 값이 다름] ${k} (${entry.defect})\n`
              + `      대장: 바코드=${JSON.stringify(entry.bar)} OCR=${JSON.stringify(entry.ocr)}\n`
              + `      실제: 바코드=${JSON.stringify(barRec[k])} OCR=${JSON.stringify(ocrRec[k])}\n`
              + '      → 결함의 크기가 바뀌었다(부분 수정이거나 다른 결함이 겹쳤다). 원인을 밝히고 대장을 갱신할 것.');
          } else {
            known(f.id, k, `${entry.defect} · 바코드=${JSON.stringify(entry.bar)} OCR=${JSON.stringify(entry.ocr)}`);
          }
        } else if (same && entry) {
          problems.push(
            `    [고쳐졌다] ${k} (${entry.defect})\n`
            + `      두 경로가 이제 ${JSON.stringify(barRec[k])} 로 일치한다.\n`
            + '      → KNOWN_DIFF 에서 이 줄을 지우고 GOLDEN_BAR 를 갱신할 것. 남겨 두면 다음 회귀를 못 잡는다.');
        }
      }

      // 대장에 있는데 이번 실행에서 아예 등장하지 않은 키(필드명 오타·리팩터링)
      for (const key of Object.keys(KNOWN_DIFF)) {
        if (!key.startsWith(`${f.id}::`)) continue;
        const field = key.slice(f.id.length + 2);
        if (!(field in barRec)) {
          problems.push(`    [대장의 필드가 사라짐] ${field} — 레코드에 그런 필드가 없다. 대장을 정리할 것.`);
        }
      }

      assert.strictEqual(problems.length, 0, `\n${problems.join('\n')}`);
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§2. RACC 배선 — 두 경로 모두 실제로 정책을 쓴다');

  // ★ 뮤테이션 M3(productService 의 getRaccPolicy 인자 제거)·같은 형태의 ocrRoutes 뮤테이션을
  //   잡기 위한 **독립** 검사다. §1 의 골든과 겹치지만, 겹치는 것이 목적이다 —
  //   골든 한 줄을 누가 "테스트가 빨개서" 옮겨 적으면 이쪽이 남아서 잡는다.
  await t('★★ RACC 정책이 실제로 판정을 바꾸는 픽스처가 있다 (전제 확인)', () => {
    for (const id of ['sesame_oil', 'soy_sauce', 'seasoned_laver', 'laver_jaban_outlier']) {
      const f = FIXTURES.find((x) => x.id === id);
      const p = getRaccPolicy(f.food_type);
      assert.ok(p && p.racc > 0, `${id}: getRaccPolicy('${f.food_type}') 가 null 이다 — RACC_MAP 이 바뀌었다`);
      assert.ok(p.racc < 50, `${id}: RACC 가 ${p.racc} 로 커져 100 과의 차이가 사라졌다 — 이 픽스처는 더 이상 유효하지 않다`);
    }
  });

  await t('★★★ 바코드 경로: RACC 소량식품의 basis 가 racc_* 다 (인자를 안 넘기면 pct_dv 로 떨어진다)', () => {
    const bad = [];
    const wantRaccBasis = {
      sesame_oil: ['sat_fat', 'total_fat'],       // oil 가드
      soy_sauce: ['sodium'],                      // sodium 가드
      seasoned_laver: ['sodium'],
      laver_jaban_outlier: ['sodium'],
    };
    for (const [id, keys] of Object.entries(wantRaccBasis)) {
      for (const k of keys) {
        const got = dump[id].bar[`nutrients.${k}.basis`];
        if (!/^racc_/.test(String(got))) {
          bad.push(`${id}.${k}: basis=${got} (racc_* 가 아니다 → getRaccPolicy 배선이 끊겼다)`);
        }
      }
    }
    assert.strictEqual(bad.length, 0, `\n    ${bad.join('\n    ')}`);
  });

  await t('★★★ OCR 경로: RACC 소량식품의 basis 도 racc_* 다 (세션47 이 배선한 것이 살아 있는가)', () => {
    const bad = [];
    const wantRaccBasis = {
      sesame_oil: ['sat_fat', 'total_fat'],
      soy_sauce: ['sodium'],
      seasoned_laver: ['sodium'],
      laver_jaban_outlier: ['sodium'],
    };
    for (const [id, keys] of Object.entries(wantRaccBasis)) {
      for (const k of keys) {
        const got = dump[id].ocr[`nutrients.${k}.basis`];
        if (!/^racc_/.test(String(got))) {
          bad.push(`${id}.${k}: basis=${got} — ocrRoutes 의 getRaccPolicy(productData.food_type) 인자가 사라졌다`);
        }
      }
    }
    assert.strictEqual(bad.length, 0, `\n    ${bad.join('\n    ')}`);
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§3. 1회 제공량 해상 — RACC 를 100 이 덮지 않는가 (D1 의 본체)');

  await t('★★★ RACC 제품의 1회량이 100 이 아니다 (바코드 경로)', () => {
    // %DV = (per100 × serving / 100) / DV × 100 이므로 serving 을 역산할 수 있다.
    //   serving = pct_dv × DV / per_100
    // 참기름 포화지방: DV=15g, per_100=15g, pct_dv=5 → serving = 5×15/15/... → 5 g
    const bar = dump.sesame_oil.bar;
    const serving = (bar['nutrients.sat_fat.pct_dv'] / 100) * 15 / (bar['nutrients.sat_fat.per_100'] / 100);
    assert.ok(Math.abs(serving - 5) < 0.2,
      `참기름의 1회량이 ${serving.toFixed(2)} g 로 해상됐다 — RACC 5 g 이어야 한다`);
  });

  await t('★ 대조군: RACC 가 없는 제품은 두 경로가 같은 1회량(100)을 쓴다', () => {
    // RACC 가 없으면 바코드 경로도 `serving_size || 100` 이므로 두 경로가 만나야 한다.
    // 이 대조군이 깨지면 원인은 serving_size 가 아니라 **다른 곳**이다.
    for (const id of ['beef_jerky_control', 'snack_control']) {
      for (const k of NUTRIENTS) {
        assert.strictEqual(
          dump[id].bar[`nutrients.${k}.pct_dv`], dump[id].ocr[`nutrients.${k}.pct_dv`],
          `${id}.${k}: RACC 무관 제품인데 %DV 가 갈렸다 (bar=${dump[id].bar[`nutrients.${k}.pct_dv`]} ocr=${dump[id].ocr[`nutrients.${k}.pct_dv`]})`);
      }
    }
  });

  await t('★ 대조군: products.serving_size 가 있으면 두 경로가 완전히 일치한다', () => {
    const b = dump.per_serving_control.bar;
    const o = dump.per_serving_control.ocr;
    const bad = Object.keys(b).filter((k) => JSON.stringify(b[k]) !== JSON.stringify(o[k]));
    assert.strictEqual(bad.length, 0,
      `1회 제공량이 라벨에 있는 제품마저 갈렸다: ${bad.map((k) => `${k}(bar=${JSON.stringify(b[k])} ocr=${JSON.stringify(o[k])})`).join(', ')}`);
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§4. sanity_warnings — 이중 노출이 구조적으로 불가능한가 (D2 · 세션50 해결)');

  // ★★★ 여기가 D2 수정의 **핵심 단정**이다.
  //   종전에는 「OCR 응답에 sanity 가 두 번 실리고 값이 반대다」를 결함으로 **기록만** 했다.
  //   지금은 두 키가 **같은 배열 객체**여야 한다고 못 박는다.
  //   ⚠ 값 비교(`deepStrictEqual`)로는 부족하다 — 라우터가 같은 값을 **다시 계산**해도 통과한다
  //     (뮤테이션 M4). 계산이 두 벌이면 다음 세션의 정책 변경 한 번에 다시 갈라진다.
  await t('★★★ D2 — OCR 응답의 data.sanity_warnings 가 traffic_light.sanity_warnings 와 **같은 배열**이다', () => {
    const bad = [];
    for (const f of FIXTURES) {
      const d = raw[f.id].ocr;
      if (!d.traffic_light) { bad.push(`${f.id}: traffic_light 가 없다(픽스처 문제)`); continue; }
      if (d.sanity_warnings !== d.traffic_light.sanity_warnings) {
        bad.push(
          `${f.id}: 두 키가 다른 객체다 — 라우터가 sanity 를 **다시 계산**하고 있다.\n`
          + `        traffic_light.sanity_warnings=${JSON.stringify(sanityKeys(d.traffic_light.sanity_warnings))}`
          + `  data.sanity_warnings=${JSON.stringify(sanityKeys(d.sanity_warnings))}`);
      }
    }
    assert.strictEqual(bad.length, 0,
      `\n    ${bad.join('\n    ')}\n    → 한 응답에 sanity 가 두 벌 실린다. 값이 지금 같아도 D2 가 되돌아온 것이다.`);
  });

  await t('★★★ D2 — 건조식품 이상치가 두 경로 모두 경고 0건이다 (100g 상한 면제가 살아 있다)', () => {
    // 김자반 1,100 kcal/100g 은 **일부러** 상한(900)을 넘긴 값이다. 건조식품이므로 면제가 맞다.
    // 라우터가 isDried=false 로 되돌아가면(뮤테이션 M1) 여기서 즉시 빨강이 된다.
    for (const id of ['laver_jaban_outlier', 'seasoned_laver', 'laver_paren_l4']) {
      assert.strictEqual(dump[id].bar.exposed_sanity, '', `${id}: 바코드 경로에 경고가 생겼다`);
      assert.strictEqual(dump[id].ocr.exposed_sanity, '', `${id}: OCR 응답에 경고가 생겼다 — isDried 하드코딩이 돌아왔다`);
    }
  });

  await t('★★★ F1 — 비건조 이상치는 두 경로 모두 경고 1건이다 (면제가 새어 나가지 않는다)', () => {
    // ⚠ 대조군이 없으면 「건조 면제를 모든 제품에 적용」(뮤테이션 M3)이 위 단정을 그대로 통과한다.
    const want = 'calories:per_100g_exceeded';
    for (const side of ['bar', 'ocr']) {
      assert.strictEqual(dump.calorie_outlier_general[side].exposed_sanity, want,
        `calorie_outlier_general(${side}): 비건조 제품인데 100g 상한 경고가 없다 — 건조 면제가 전 제품에 걸렸다`);
    }
  });

  await t('★★★ F2 — 건조식품이어도 1회 상한 검사는 살아 있다 (면제 범위가 넓어지지 않았다)', () => {
    const want = 'calories:per_serving_exceeded';
    for (const side of ['bar', 'ocr']) {
      assert.strictEqual(dump.laver_jaban_serving_outlier[side].exposed_sanity, want,
        `laver_jaban_serving_outlier(${side}): 건조식품의 1회 상한 초과가 사라졌다 — sanity 를 통째로 억제했다`);
    }
  });

  await t('★ 건조식품 판정 자체는 두 경로가 일치한다 (엔진은 양쪽 다 옳게 본다)', () => {
    for (const id of ['seasoned_laver', 'laver_jaban_outlier', 'beef_jerky_control']) {
      assert.strictEqual(dump[id].bar.is_dried_exception, true, `${id}: 바코드 경로가 건조식품으로 안 본다`);
      assert.strictEqual(dump[id].ocr.is_dried_exception, true, `${id}: OCR 경로가 건조식품으로 안 본다`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§5. 알레르기 — 응답 키 집합만 (상세 계약은 test_allergen_contract.js)');

  // ★★★ 세션54 — D4 해소. 종전에는 이 검사가 「다르다」를 `known()` 으로 «기록»만 했다.
  //   이제 **같아야 한다**를 단정한다. 되돌아가면 여기가 빨개진다.
  const ALLERGEN_KEYS = ['allergens', 'allergens_v2', 'allergens_available', 'allergens_flat_complete'];

  await t('★★ 두 경로의 알레르기 키 집합이 같다 (구 D4 · 세션54 해소)', async () => {
    const bc = await productService.getProductWithTrafficLight('PARITY0001');
    LABEL_TEXT = '오뚜기 참기름\n원재료명: 참깨(수입산)\n영양성분';
    const ocr = await callAnalyze({ image: 'x'.repeat(400), product_info: { product_name: '오뚜기 참기름' } });

    const barKeys = ALLERGEN_KEYS.filter((k) => k in bc);
    const ocrKeys = ALLERGEN_KEYS.filter((k) => k in ocr.data.analysis);

    assert.deepStrictEqual(barKeys, ALLERGEN_KEYS,
      '바코드 경로의 알레르기 4키가 줄었다 — 「정보 없음」과 「없음」의 구분이 사라진다');
    assert.deepStrictEqual(ocrKeys, ALLERGEN_KEYS,
      'OCR 경로의 알레르기 4키가 줄었다 — 「혼입만 있는 제품」이 「알레르기 없음」으로 읽힌다(과소경고)');
  });

  await t('★★ OCR 경로도 「혼입만 있는 제품」을 flat_complete=false 로 구분한다 (구 D4 의 «목적»)', async () => {
    // ⚠ 키가 «있는지» 만 보면 값이 항상 true 인 구현도 통과한다. 그 구현은 D4 를 안 고친 것이다.
    //   그래서 키 집합과 별도로, 이 키가 실제로 두 상태를 «가르는지» 를 본다.
    LABEL_TEXT = '초코과자\n원재료명: 설탕, 정제소금\n'
      + '이 제품은 대두를 사용한 제품과 같은 제조시설에서 제조하고 있습니다.';
    const may = (await callAnalyze({ image: 'x'.repeat(400), product_info: {} })).data.analysis;
    assert.deepStrictEqual(may.allergens, [], '혼입은 flat 에 넣지 않는다(구버전 앱이 붉게 표시한다)');
    assert.ok(may.allergens_v2.mayContain.includes('대두'), '혼입을 못 읽었다 — 이 케이스가 성립하지 않는다');
    assert.strictEqual(may.allergens_flat_complete, false,
      '★ flat 이 비었는데 flat_complete=true 다 — 화면이 「알레르기 없음」이라고 쓴다(짜왕 사고의 OCR 판)');

    // ★★★ 세션56 1단계 — 대조군 텍스트에 **법정 선언란을 넣었다.**
    //   종전 텍스트는 `원재료명: 밀가루, 설탕` 뿐이었다. 그 라벨에는 알레르기 표시란이 «없다».
    //   `allergens_available` 이 「선언란을 봤는가」로 재정의되면서 이 입력은 `available:false`
    //   → `flat_complete:null`(판정 없음)이 된다. **그것이 새 계약의 정답이다.**
    //   ⚠ 그러므로 이 실패는 회귀가 아니라 «질문이 바뀐 것»이다.
    //     이 검사의 질문(「flat_complete 가 혼입 유무를 실제로 가르는가」)을 유지하려면
    //     대조군도 **선언란이 있는** 라벨이어야 한다. 그래야 두 입력이 혼입 유무 «하나»만 다르다.
    LABEL_TEXT = '초코과자\n원재료명: 밀가루, 설탕\n밀 함유';
    const plain = (await callAnalyze({ image: 'x'.repeat(400), product_info: {} })).data.analysis;
    assert.strictEqual(plain.allergens_available, true,
      '선언란이 있는 라벨인데 available=false 다 — 대조군이 성립하지 않는다');
    assert.strictEqual(plain.allergens_flat_complete, true,
      '혼입이 없는데 flat_complete 가 false 다 — 항상 false 를 내면 신호가 무의미해진다');
  });

  await t('★ OCR 경로 flat 에 혼입이 섞이지 않는다 (구버전 앱이 붉게 표시한다)', async () => {
    LABEL_TEXT = '초코과자\n원재료명: 밀가루, 설탕\n'
      + '이 제품은 대두를 사용한 제품과 같은 제조시설에서 제조하고 있습니다.';
    const ocr = await callAnalyze({ image: 'x'.repeat(400), product_info: { product_name: '초코과자' } });
    const a = ocr.data.analysis;
    assert.ok(a.allergens_v2, 'allergens_v2 가 응답에 없다');
    for (const n of a.allergens_v2.mayContain || []) {
      assert.ok(!a.allergens.includes(n),
        `혼입 「${n}」 이 flat 에 있다 — 구버전 앱이 「직접 함유」로 붉게 표시한다`);
    }
    for (const n of [...(a.allergens_v2.contains || []), ...(a.allergens_v2.inferred || [])]) {
      assert.ok(a.allergens.includes(n), `직접함유/추정 「${n}」 이 flat 에서 빠졌다 — 경고 소실`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§6. ★★★ 세션49 — 1회량의 출처(provenance) · 식품유형 정규화 · 모호성');
  // 왜 이 절이 생겼는가:
  //   세션49 가 치명A·B 를 고친 뒤 뮤테이션을 돌려 보니 **4종이 통과**했다.
  //     · getRaccPolicy 를 정확 일치로 되돌리기      (치명A 원상복구)
  //     · L3 만 죽이기 / L4 만 죽이기
  //     · 엔진이 라벨값을 무조건 우선하게 만들기       (RACC 를 영원히 안 쓰게)
  //   전부 「고친 것을 되돌리는」 변경인데 27단정이 초록이었다. 즉 **검사가 무력했다.**
  //   위 픽스처 2종이 앞의 3개를 잡고, 이 절이 나머지와 계약 자체를 잡는다.
  {
    const { evaluateNutrition } = require('../src/services/nutritionTrafficLight');
    const { getRaccPolicy } = require('../src/services/raccPolicy');
    // per_100g 고정 입력 — 1회량 선택만 변수로 남긴다
    const N = { basis: 'per_100g', sodium: 1000, sugars: 0, sat_fat: 1, total_fat: 5, cholesterol: 0, protein: 0, fiber: 0, trans_fat: 0 };

    await t('★★★ 치명A — 괄호형 식품유형이 정규화로 매칭된다 (L3 · L4)', () => {
      const l4 = getRaccPolicy('가공김(조미김)');       // 캡처 006 실물
      const l3 = getRaccPolicy('혼합장(살균제품)');      // 캡처 027 실물
      assert.ok(l4, 'L4 미매칭 — "가공김(조미김)" 이 null 이다. 정확 일치로 퇴화했다');
      assert.strictEqual(l4.matchedKey, '조미김');
      assert.strictEqual(l4.matchLevel, 'L4');
      assert.ok(l3, 'L3 미매칭 — "혼합장(살균제품)" 이 null 이다');
      assert.strictEqual(l3.matchedKey, '혼합장');
      assert.strictEqual(l3.matchLevel, 'L3');
    });

    await t('★★ 부분 문자열로 매칭하지 않는다 (근거 없는 면제를 만들지 않는다)', () => {
      // 정규화 후에도 **전체가 같아야** 매칭이다. 여기가 뚫리면 엉뚱한 제품이 소량식품 면제를 받는다.
      for (const ft of ['초고추장', '양조간장류', '조미김스낵', '고추장아찌']) {
        assert.strictEqual(getRaccPolicy(ft), null,
          `"${ft}" 가 매칭됐다 — 부분 문자열 매칭이 들어갔다. 근거 없는 소량섭취 면제가 된다`);
      }
    });

    await t('★★ 모호성 — L3·L4 가 서로 다른 키에 걸리면 보고한다 (조용히 고르지 않는다)', () => {
      // '소시지(조미김)' : 괄호 밖 '소시지'(RACC_MAP 에 없음) · 괄호 안 '조미김'(있음) → L4 로 걸린다.
      // '고추장(조미김)' : 둘 다 RACC_MAP 에 있다 → L3 우선 + 모호 보고.
      const amb = getRaccPolicy('고추장(조미김)');
      assert.ok(amb, '둘 다 표에 있는데 미매칭이다');
      assert.strictEqual(amb.matchedKey, '고추장', 'L3(괄호 밖) 우선 규칙이 깨졌다');
      assert.ok(amb.ambiguousWith, '모호한데 ambiguousWith 가 null 이다 — 조용히 한쪽을 골랐다');
      assert.strictEqual(amb.ambiguousWith.key, '조미김');
      // 대조군: 모호하지 않으면 null 이어야 한다(아무 때나 모호하다고 하면 신호가 죽는다)
      assert.strictEqual(getRaccPolicy('가공김(조미김)').ambiguousWith, null);
    });

    await t('★★★ 치명B — 1회량의 출처가 응답에 실린다 (label / racc / default_100)', () => {
      const racc = getRaccPolicy('참기름');           // racc 5 g
      // ① 라벨값이 0.5×RACC 미만 → RACC 가 이긴다
      const a = evaluateNutrition({ product_name: 'x', food_type: '참기름', content_unit: 'g', serving_size: 1 }, N, undefined, racc);
      assert.strictEqual(a.serving_basis.source, 'racc', '라벨 1 g(<0.5×5)인데 라벨이 이겼다');
      assert.strictEqual(a.serving_basis.serving, 5);
      assert.strictEqual(a.serving_basis.label_serving, 1, '라벨값 원본이 보존되지 않았다');
      // ② 라벨값이 0.5×RACC 이상 → 라벨이 이긴다 (대조군 — 과잉 적용 방지)
      const b = evaluateNutrition({ product_name: 'x', food_type: '참기름', content_unit: 'g', serving_size: 3 }, N, undefined, racc);
      assert.strictEqual(b.serving_basis.source, 'label', '라벨 3 g(≥0.5×5)인데 RACC 가 이겼다');
      assert.strictEqual(b.serving_basis.serving, 3);
      // ③ RACC 없음 + 라벨 없음 → 근거 없는 기본값임을 이름으로 밝힌다
      const c = evaluateNutrition({ product_name: 'x', food_type: '과자', content_unit: 'g', serving_size: null }, N, undefined, null);
      assert.strictEqual(c.serving_basis.source, 'default_100');
      assert.strictEqual(c.serving_basis.serving, 100, '기본값을 다른 상수로 바꿨다 — 근거 없는 값은 100(=100g 기준 관례) 뿐이다');
      assert.strictEqual(c.serving_basis.label_serving, null, '라벨이 없는데 label_serving 이 채워졌다 (치명B 재발)');
    });

    await t('★★ 매칭 근거(키·레벨)가 판정 결과까지 흐른다', () => {
      const p = getRaccPolicy('가공김(조미김)');
      const r = evaluateNutrition({ product_name: 'x', food_type: '가공김(조미김)', content_unit: 'g', serving_size: null }, N, undefined, p);
      assert.strictEqual(r.serving_basis.racc_matched_key, '조미김');
      assert.strictEqual(r.serving_basis.racc_match_level, 'L4');
      assert.strictEqual(r.serving_basis.source, 'racc');
      assert.ok(r.traffic_light_policy_version, '정책 버전이 응답에 없다');
    });

    await t('★ 바코드·OCR 두 경로가 같은 serving_basis 를 낸다', () => {
      for (const id of ['sesame_oil', 'soy_sauce', 'seasoned_laver', 'laver_paren_l4', 'soy_sauce_paren_l3', 'snack_control']) {
        assert.deepStrictEqual(dump[id].bar.serving_basis, dump[id].ocr.serving_basis,
          `${id}: 두 경로의 1회량 출처가 다르다 — 치명B 가 재발했다`);
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§7. ★★★ 세션50 F3 — 분기를 지운 수정이 기존 동작을 바꾸지 않았는가');
  // 왜 이 절이 생겼는가:
  //   D2 수정은 `ocrRoutes.js:214` 의 3분기(`per_total || unknown || is_withheld` 일 때만 엔진 결과)를
  //   **통째로 지웠다**(항상 엔진 결과). 지운 분기가 실제로 항등이었는지 증명하지 않으면
  //   「고쳤는데 보류 제품의 경고가 사라졌다」 같은 퇴행이 조용히 들어온다.
  //   ⚠ 현재 파리티 픽스처에는 per_total·unknown 이 **0건**이다(바코드 경로의 `deriveBasis` 는
  //     '100g'/'100ml'/'100unknown'/per_serving 만 낸다). 그래서 두 경로 비교가 아니라
  //     라우터 함수(`judgeNutrition`)를 **직접** 부른다.
  {
    const jn = ocrRoutes.judgeNutrition;
    const NUT = {
      calories: 500, sodium: 300, total_sugars: 5, saturated_fat: 1,
      total_fat: 3, cholesterol: 0, protein: 2, dietary_fiber: 1, trans_fat: 0,
    };

    await t('★★★ M4 — judgeNutrition 이 엔진 배열을 **그대로** 돌려준다 (복사·재계산이 아니다)', () => {
      const r = jn({
        productData: { product_name: '바다 김자반', food_type: '김자반', content_unit: 'g', serving_size: null, total_content: 60 },
        nutrition: { ...NUT, calories: 1100, _basis: 'per_100g' },
        labelText: '바다 김자반',
        explicitServingSize: null,
      });
      assert.ok(r.trafficLight, '신호등이 만들어지지 않았다');
      assert.strictEqual(r.sanityWarnings, r.trafficLight.sanity_warnings,
        '라우터가 sanity 를 다시 만들었다 — 값이 같아도 계산이 두 벌이면 D2 가 되돌아온 것이다');
      assert.strictEqual(sanityKeys(r.sanityWarnings), '', '건조식품인데 100g 상한 경고가 생겼다');
    });

    await t('★★ F3 — basis=unknown 은 판정 보류이고 sanity 는 빈 배열이다 (보류는 보류로 끝낸다)', () => {
      const r = jn({
        productData: { product_name: '테스트 과자', food_type: '과자', content_unit: 'g', serving_size: null, total_content: null },
        nutrition: { ...NUT, calories: 5000 },      // ★ _basis 없음 → unknown
        labelText: '테스트 과자',                   // ★ 기준 문구를 넣지 않는다(라벨 재판정 방지)
        explicitServingSize: null,
      });
      assert.strictEqual(r.trafficLight.is_withheld, true, 'basis unknown 인데 보류가 아니다');
      assert.strictEqual(r.trafficLight.withhold_reason, 'basis_unknown');
      assert.strictEqual(r.sanityWarnings, r.trafficLight.sanity_warnings, '보류인데 sanity 가 따로 만들어졌다');
      assert.strictEqual(sanityKeys(r.sanityWarnings), '',
        '판정을 보류한 제품에 "값이 이상하다"고 단정하고 있다 — 지운 분기의 동작이 바뀌었다');
    });

    await t('★★ F3 — basis=per_total 도 엔진이 환산 후 낸 결과를 그대로 쓴다', () => {
      const r = jn({
        productData: { product_name: '떡국떡', food_type: '떡류', content_unit: 'g', serving_size: 100, total_content: 500 },
        nutrition: { ...NUT, sodium: 1530, _basis: 'per_total', total_content: 500 },
        labelText: '총 내용량 500g\n1회 제공량 100g',
        explicitServingSize: 100,
      });
      assert.ok(r.trafficLight, '신호등이 만들어지지 않았다');
      assert.strictEqual(r.sanityWarnings, r.trafficLight.sanity_warnings,
        'per_total 인데 라우터가 sanity 를 따로 만들었다');
      // ★ 총량 그대로 1회분 상한에 재면 나트륨 1,530 mg 이 오탐이 되지는 않지만(상한 5,000),
      //   환산이 죽으면 per_100 쪽이 흔들린다. 여기서는 「엔진이 계산했다」만 고정한다.
      assert.ok(Array.isArray(r.sanityWarnings), 'sanity 가 배열이 아니다');
    });

    await t('★ 영양정보가 없으면 data.sanity_warnings 는 [] 가 아니라 null 이다 (검사 못 함 ≠ 이상 없음)', async () => {
      LABEL_TEXT = '초코과자\n원재료명: 밀가루, 설탕';
      const ocr = await callAnalyze({ image: 'x'.repeat(400), product_info: { product_name: '초코과자' } });
      assert.strictEqual(ocr.data.traffic_light, null, '영양값이 없는데 신호등이 만들어졌다(픽스처 전제가 깨졌다)');
      assert.strictEqual(ocr.data.sanity_warnings, null,
        '검사하지 못한 것을 빈 배열(=이상 없음)로 냈다 — `null = 판정 없음 ≠ 안전` 위배');
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§8. ★★★ 세션50 F4 — 세 번째 노출 경로 POST /api/products/evaluate');
  // 왜: `productRoutes.js:94` 도 `sanityCheck(..., false, ...)` 였는데
  //   **파리티 테스트가 이 경로를 한 번도 부르지 않았다.** ocrRoutes 만 고치면 같은 김자반이
  //   `/api/ocr/analyze` 에서는 경고 0건, `/api/products/evaluate` 에서는 1건 —
  //   결함이 사라지는 게 아니라 **자리만 옮긴다.** 그래서 이 경로를 대장 비교 대상에 넣는다.
  {
    const productRoutes = require('../src/routes/productRoutes');
    const evalLayer = productRoutes.stack.find((l) => l.route && l.route.path === '/evaluate');

    async function callEvaluate(body) {
      const req = { body, headers: {}, method: 'POST', url: '/evaluate' };
      let out = null;
      const res = { json: (o) => { out = o; return res; }, status: () => res, set: () => res };
      for (const s of evalLayer.route.stack) {
        await new Promise((resolve, reject) => {
          let done = false;
          const next = (e) => { if (done) return; done = true; e ? reject(e) : resolve(); };
          try {
            const r = s.handle(req, res, next);
            if (r && typeof r.then === 'function') r.then(() => { if (!done) { done = true; resolve(); } }, next);
          } catch (e) { next(e); }
        });
        if (out) break;
      }
      if (!out) throw new Error('/evaluate 핸들러가 응답을 만들지 않았다');
      return out;
    }

    // ★ `/evaluate` 는 serving_size > 0 을 강제한다(productRoutes.js:81). 그래서 30 을 준다.
    //   영양값은 F1/F2 와 같은 1,100 kcal/100g 이상치다 — **건조 여부만 다른 두 요청**이다.
    const NUT100 = {
      calories: 1100, sodium: 250, sugars: 33, sat_fat: 7, total_fat: 13,
      cholesterol: 5, protein: 4, fiber: 2, trans_fat: 0, basis: 'per_100g',
    };

    await t('★★★ M5 — /evaluate 의 sanity_warnings 가 evaluation.sanity_warnings 와 **같은 배열**이다', async () => {
      const r = await callEvaluate({
        product: { product_name: '바다 김자반', food_type: '김자반', content_unit: 'g', serving_size: 30, total_content: 60 },
        nutrition: { ...NUT100 },
      });
      assert.strictEqual(r.data.sanity_warnings, r.data.evaluation.sanity_warnings,
        '/evaluate 가 sanity 를 다시 계산한다 — ocrRoutes 만 고치고 여기를 놓쳤다(D2 가 자리를 옮겼다)');
    });

    await t('★★★ M5 — /evaluate 도 건조식품 100g 상한을 면제한다 (세 경로가 같은 답)', async () => {
      const dried = await callEvaluate({
        product: { product_name: '바다 김자반', food_type: '김자반', content_unit: 'g', serving_size: 30, total_content: 60 },
        nutrition: { ...NUT100 },
      });
      assert.strictEqual(dried.data.evaluation.is_dried_exception, true, '김자반이 건조식품으로 안 잡힌다(픽스처 전제)');
      assert.strictEqual(sanityKeys(dried.data.sanity_warnings), '',
        '/evaluate 에서만 건조식품에 100g 상한 경고가 뜬다 — isDried 하드코딩이 여기 남아 있다');
    });

    await t('★★★ 대조군 — /evaluate 의 비건조 동일 수치는 경고 1건이다 (면제가 전 제품에 걸리지 않았다)', async () => {
      const general = await callEvaluate({
        product: { product_name: '오리온 초코파이', food_type: '과자', content_unit: 'g', serving_size: 30, total_content: 420 },
        nutrition: { ...NUT100 },
      });
      assert.strictEqual(general.data.evaluation.is_dried_exception, false, '과자가 건조식품으로 잡혔다(픽스처 전제)');
      assert.strictEqual(sanityKeys(general.data.sanity_warnings), 'calories:per_100g_exceeded',
        '비건조 제품인데 100g 상한 경고가 없다 — 건조 면제가 모든 제품에 적용됐다');
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§9. ★★★ 세션50 F5 — crowdsource 저장 게이트 (읽기가 아니라 쓰기다)');
  // 왜: `crowdsourceService.js:165` 의 하드코딩 false 는 **화면이 아니라 DB 저장 관문**이었다.
  //   건조식품(김·김자반·육포)은 100 g 당 열량이 자연히 높은데, 신호등은 면제하고 저장만 거부했다.
  //   = 「화면은 통과 · 등록은 반려」. tests/ 어디에도 이 서비스를 부르는 줄이 없어 회귀망 밖이었다.
  //   ⚠ 이 절이 고정하는 것은 **방향**이다. 건조식품은 통과하고, 비건조 이상치는 그대로 반려된다.
  //
  // ★★★ 세션64b — 「반려」의 «단위»가 바뀌었다. 방향은 그대로다.
  //   외부 검토 2명 결론: **저장 ≠ 표시 ≠ 검증**. 영양 이상치 때문에 같은 사진의
  //   원재료·알레르기 원증거까지 버리는 것은 손해가 크다(알레르기는 안전 직결 축이다).
  //   → 이제 이상치는 `saved:false`(제보 전체 반려)가 아니라
  //     `nutrition_status:'incomplete'`(영양만 반려)다.
  //   ⚠ **게이트가 헐거워진 것이 아니다.** 아래 단정이 그것을 증명한다:
  //     이상치 영양값은 `nutrition_data` 에 **행이 생기지 않고**, `verification` 도
  //     `partial` 로 올라가지 않는다. 즉 소비자가 보는 것은 종전과 **완전히 같다.**
  //     달라진 것은 버려지던 원재료·알레르기가 살아남는다는 것뿐이다.
  {
    const crowdsource = require('../src/services/crowdsourceService');
    const gateNutrition = {
      calories: 1100, sodium: 2500, total_sugars: 10, saturated_fat: 6, total_fat: 60,
      cholesterol: 0, protein: 25, dietary_fiber: 20, trans_fat: 0, _basis: 'per_100g',
    };
    const gateParams = (foodType, productName) => ({
      barcode: null,
      productInfo: { product_name: productName, food_type: foodType, content_unit: 'g', total_content: 60 },
      ocrResult: { corrected_text: `${productName}\n영양성분` },
      analysis: { nutrition: { ...gateNutrition }, ingredients: [], allergens: [], allergens_v2: null, product_meta: {} },
      avgConfidence: 0.95,
    });

    await t('★★★ 대조군 — 비건조 이상치의 «영양»은 여전히 반려된다 (게이트가 헐거워지지 않았다)', async () => {
      const r = await crowdsource.saveOcrContribution(gateParams('과자', '오리온 초코파이'));
      assert.strictEqual(r.nutrition_status, 'incomplete',
        '1,100 kcal/100g 비건조 제품의 영양이 저장됐다 — 게이트가 죽었다');
      assert.strictEqual(r.nutrition_reject_code, 'SANITY_OUTLIER',
        `영양 반려 사유가 sanity 가 아니다: ${r.nutrition_reject_code} / ${r.nutrition_reject_reason}`);
      assert.ok(/이상치/.test(r.nutrition_reject_reason || ''),
        `사용자에게 보여줄 사유가 sanity 얘기가 아니다: ${r.nutrition_reject_reason}`);

      // ★★★ 「소비자가 보는 것은 종전과 같다」를 **DB 로** 단정한다.
      //   응답 키만 보면 서비스가 문자열만 바꿔도 초록이 된다(세션48 4차 검증의 교훈).
      const nut = await db.query(
        'SELECT nutrition_id FROM nutrition_data WHERE product_id = $1', [r.productId]);
      assert.strictEqual(nut.rows.length, 0,
        '이상치 영양값이 nutrition_data 에 박혔다 — 그 바코드를 조회하는 전원이 거짓 판정을 받는다');
      assert.strictEqual(r.verification, 'unverified',
        '영양을 하나도 확보 못 했는데 partial(부분 확인됨)로 승격됐다');
    });

    await t('★★★ M6 — 건조식품 이상치는 부당하게 반려되지 않는다 (화면과 저장이 같은 답)', async () => {
      const r = await crowdsource.saveOcrContribution(gateParams('김자반', '바다 김자반'));
      assert.strictEqual(r.nutrition_status, 'ok',
        `건조식품이 sanity 로 반려됐다: ${r.nutrition_reject_code} / ${r.nutrition_reject_reason}\n`
        + '      → crowdsourceService 의 isDried 하드코딩 false 가 살아 있다. '
        + '신호등은 면제하는데 등록만 거부하는 상태다.');
      assert.strictEqual(r.saved, true, `건조식품 제보가 저장되지 않았다: ${r.rejectReason}`);
      const nut = await db.query(
        'SELECT calories FROM nutrition_data WHERE product_id = $1', [r.productId]);
      assert.strictEqual(nut.rows.length, 1, '건조식품 영양이 저장되지 않았다');
      assert.strictEqual(Number(nut.rows[0].calories), 1100);
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§10. ★★★ 세션50 F6 — 바코드 응답 내부 정합성 (context ↔ traffic_light)');
  // 왜: `toRecord()` 는 `traffic_light` 와 노출 sanity 만 읽어서 **`context` 를 아예 안 봤다.**
  //   그 사각지대에서 같은 응답이 `traffic_light.is_dried_exception = true` 와
  //   `context.is_dried_exception = false` 를 동시에 싣고 있었다(조미김·김자반 실측).
  //   ⚠ `toRecord` 안에 넣지 않은 이유: OCR 응답에는 `context` 키가 **아예 없다**(D4 와 같은 키 집합 결함).
  //     넣으면 「경로 간 값 불일치」로 오진된다. 이것은 두 경로 비교가 아니라 **한 응답 안의 모순**이다.
  {
    await t('★★★ M7 — context.is_dried_exception 이 traffic_light 와 같다 (판정기 2벌이 하나가 됐다)', () => {
      const bad = [];
      for (const f of FIXTURES) {
        const b = raw[f.id].bar;
        if (!b.context) { bad.push(`${f.id}: context 가 응답에 없다`); continue; }
        if (b.context.is_dried_exception !== !!(b.traffic_light && b.traffic_light.is_dried_exception)) {
          bad.push(`${f.id}: traffic_light=${b.traffic_light && b.traffic_light.is_dried_exception}`
            + ` ≠ context=${b.context.is_dried_exception}`);
        }
        if (b.context.is_excluded !== !!(b.traffic_light && b.traffic_light.is_excluded)) {
          bad.push(`${f.id}[is_excluded]: traffic_light=${b.traffic_light && b.traffic_light.is_excluded}`
            + ` ≠ context=${b.context.is_excluded}`);
        }
      }
      assert.strictEqual(bad.length, 0,
        `\n    ${bad.join('\n    ')}\n`
        + '    → 같은 응답이 서로 반대되는 말을 한다. utils/foodCategory.js 가 다시 판정하기 시작했다.');
    });

    await t('★ 판정이 없으면 context 의 3키는 false 가 아니라 null 이다 (없는 근거로 단정하지 않는다)', () => {
      const { getContext } = require('../src/utils/foodCategory');
      const c = getContext('김자반', null);       // 영양정보가 없어 신호등을 못 만든 제품
      assert.strictEqual(c.is_dried_exception, null,
        '신호등이 없는데 「건조식품이 아니다」로 단정했다 — 세션49 D3 와 같은 종류의 오답이다');
      assert.strictEqual(c.is_excluded, null);
      assert.strictEqual(c.exclude_reason, null);
      // 대조군: 신호등이 있으면 그 값을 그대로 옮긴다(무조건 null 로 만드는 퇴행 방지).
      const c2 = getContext('김자반', { is_dried_exception: true, is_excluded: false, exclude_reason: null });
      assert.strictEqual(c2.is_dried_exception, true);
      assert.strictEqual(c2.is_excluded, false);
    });

    // ── D5 해소 (세션51) — 대장에서 내리고 «지키는» 단정으로 바꿨다 ──────────────
    //   종전: context 가 food_type 을 자체 13분류 → 엔진 6분류와 갈렸다.
    //         조미김·김자반 general↔dried · 간장 fermented↔beverage (픽스처 5건, 실모집단 2,235건)
    //   지금: utils/foodCategory.js 가 분류를 그만두고 엔진 값을 받아 쓴다(A안).
    await t('★★★ D5 — context.category 가 traffic_light.food_category 와 «항상» 같다', () => {
      const diffs = [];
      for (const f of FIXTURES) {
        const b = raw[f.id].bar;
        if (!b.context || !b.traffic_light) continue;
        if (b.context.category !== b.traffic_light.food_category) {
          diffs.push(`${f.id}(${f.food_type}): context=${b.context.category} ≠ engine=${b.traffic_light.food_category}`);
        }
      }
      assert.strictEqual(diffs.length, 0,
        `\n    ${diffs.join('\n    ')}\n`
        + '    → utils/foodCategory.js 가 다시 자체 분류를 시작했다. 엔진 값을 그대로 옮겨야 한다.');
    });

    await t('★★ D5 — is_beverage 도 엔진 카테고리에서 파생된다 (ml 포장 88건이 갈리던 축)', () => {
      const bad = [];
      for (const f of FIXTURES) {
        const b = raw[f.id].bar;
        if (!b.context || !b.traffic_light) continue;
        const expectBev = b.traffic_light.food_category === 'beverage';
        if (b.context.is_beverage !== expectBev) {
          bad.push(`${f.id}: context.is_beverage=${b.context.is_beverage} ≠ (engine==='beverage')=${expectBev}`);
        }
      }
      assert.strictEqual(bad.length, 0,
        `\n    ${bad.join('\n    ')}\n`
        + '    → 「100mL 기준으로 평가됩니다」 안내와 실제 사용 기준이 어긋난다.');
    });

    await t('★ D5 — 판정이 없으면 category 도 null 이다 (없는 근거로 「일반 가공식품」이라 하지 않는다)', () => {
      const { getContext } = require('../src/utils/foodCategory');
      const c = getContext('김자반', null);
      assert.strictEqual(c.category, null, '신호등이 없는데 카테고리를 단정했다');
      assert.strictEqual(c.category_label, null);
      assert.strictEqual(c.is_beverage, null, 'null 이어야 한다 — false 는 「음료가 아니다」라는 단정이다');
      assert.deepStrictEqual(c.messages, [], '근거 없는 맥락 안내를 붙이지 않는다');
    });

    await t('★ D5 — 엔진이 모르는 카테고리를 내면 조용히 general 로 접지 않는다', () => {
      const { getContext } = require('../src/utils/foodCategory');
      const c = getContext('무엇', { food_category: 'nuts', is_excluded: false, is_dried_exception: false });
      assert.strictEqual(c.category, null, '어휘가 갈라진 것을 general 로 덮으면 D5 가 조용히 재발한다');
      assert.strictEqual(c.detection_method, 'engine_unknown_category',
        '모르는 값을 받았다는 사실이 응답에 남아야 한다');
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  if (process.env.PARITY_DUMP) {
    console.log('\n── PARITY_DUMP ────────────────────────────────────────────');
    console.log(JSON.stringify(dump, null, 2));
  }

  await db.close();

  // ── 결과 보고 ────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`📊 세션48 경로 동등성: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})`);

  if (expectedIssues.length > 0) {
    console.log(`\n⚠  미해결 결함(알려진 불일치) ${expectedIssues.length}건 — 대장과 값이 일치한다:`);
    const byDefect = {};
    for (const e of expectedIssues) {
      const m = /^(D\d)/.exec(e.detail);
      const d = m ? m[1] : 'D?';
      (byDefect[d] = byDefect[d] || []).push(`${e.fixtureId}.${e.field}`);
    }
    for (const [d, list] of Object.entries(byDefect)) {
      console.log(`   ${d}: ${list.length}건 — ${list.slice(0, 4).join(', ')}${list.length > 4 ? ` 외 ${list.length - 4}건` : ''}`);
    }
    console.log('   ★ 이것들은 아직 고쳐지지 않았다. 고친 뒤 PARITY_STRICT=1 이 초록이어야 한다.');
  }

  if (fail > 0) {
    console.log('\n실패 상세:');
    for (const f of failures) console.log(`  - ${f.name}\n    ${f.message}`);
    process.exit(1);
  }

  if (process.env.PARITY_STRICT === '1' && expectedIssues.length > 0) {
    console.log(`\n❌ PARITY_STRICT=1 — 미해결 결함 ${expectedIssues.length}건을 실패로 센다.`);
    process.exit(1);
  }

  console.log('✅ 새 불일치 없음 (알려진 결함은 위에 나열)');
}

main().catch((e) => { console.error('예상 못 한 예외:', e); process.exit(1); });
