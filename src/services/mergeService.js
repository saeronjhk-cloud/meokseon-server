/**
 * 크라우드소싱 merge 서비스
 *
 * ⚠️ IP SOURCE: OneDrive/MeokSeon/IP/merge_policy_v1.md
 * 이 파일은 사본. 알고리즘 정책·임계값을 수정하려면 OneDrive 의 원본 먼저 수정 후 여기 반영.
 *
 * 같은 제품에 대한 여러 사용자의 OCR 등록(contributions) 을 필드별 알고리즘으로
 * 병합해 **판정**을 낸다.
 *
 * ★★★★★ 세션66 C6 (2026-08-30) — **더 이상 마스터 테이블에 반영하지 않는다.**
 *   종전: 병합 결과를 `nutrition_data`·`product_ingredients`·`product_additives`·
 *         `product_allergens` 에 **자동 반영**했다(기기 3대면 사람 없이).
 *   지금: 병합 «판정»만 하고 그 결과를 `contribution_review` 에 `candidate` 로 넣는다.
 *         공식 테이블에 옮기는 일은 관리자가 승인할 때
 *         `contributionApply.applyApprovedContribution` «한 곳»이 한다.
 *   근거: 설계 §3-2 · 제이 확인 2026-08-30 — **전량 수동에 예외가 없다.**
 *   ⇒ `U65-6`(공공데이터 보호가 1회용) 원천 소멸. `products.verification` 갱신만 남았고
 *      그것은 계약 §7-C 가 `U66-1` 로 «보류»한 별개 축이다.
 *
 * 핵심 정책:
 *   - 같은 제품 식별: barcode 우선, 없으면 같은 product_id (saveOcrContribution 이 이미 매칭)
 *   - 자동 verified 임계값: 다른 device_id 3건 이상
 *   - 영양성분 (수치): median — 이상치(outlier)에 강함
 *   - 텍스트 (제품명·브랜드·제조사·식품유형): 다수결 + 동률시 가장 긴 것
 *   - 원재료명: 다수결 (3건 중 2건 이상에 등장하면 채택)
 *   - 알레르기: union + source_count 기록 — 안전 우선
 *   - 첨가물: union — 자동 매칭이라 일관성 높음
 *   - 이상치 감지: median 대비 ±50% 이탈한 contribution 이 있으면 disputed 마킹
 *
 * ⛔ 이 파일이 «하지 않는» 것 (세션66 C6)
 *   · `nutrition_data` · `product_ingredients` · `product_allergens` · `product_additives`
 *     에 **한 줄도 쓰지 않는다.** 쓰려는 사람에게: 그 규칙 본문은 `contributionApply.js` 다.
 *   · `product_allergens` 를 **지우지 않는다.** 종전의
 *     `DELETE ... detected_via='crowdsource_merge'` 는 사라졌다(경고 순감 경로 하나가 닫혔다).
 */

const db = require('../config/database');
const logger = require('../config/logger');
// ★★★ 세션55 — 쓰기 경로 정규화. 아래 `canonicalizeAllergenName` 주석에 근거를 적었다.
const { normalizeAllergenNames } = require('./allergenName');

// ════════════════════════════════════════════════════════════════════════════
// 0. ★★★★★ 세션66 C6 — 제보는 «공식 테이블에 쓰지 않는다» (설계 §3-2 · 계약 §7)
// ════════════════════════════════════════════════════════════════════════════
// 왜 여기에 있나 —
//   경로 ①(`crowdsourceService`)과 경로 ②(이 파일)가 **똑같이** candidate 를 만든다.
//   규칙을 두 곳에 적으면 다음 수정 때 한쪽만 고친다(이 저장소가 4세션 연속 겪은 사고).
//   ⚠ 새 `src/` 파일을 만들지 않은 이유: 의존 방향이 이미 `crowdsourceService → mergeService`
//     한쪽이라 여기에 두면 순환이 생기지 않는다. 반대로 두면 순환이다.
//
// ★ 「제보 → 공식 테이블」 사이에 사람이 서는 것이 이 세션의 전부다.
//   실제로 옮기는 일은 `contributionApply.applyApprovedContribution` «한 곳»만 한다.
//   이 파일도, `crowdsourceService` 도, 이제 `nutrition_data`·`product_ingredients`·
//   `product_allergens`·`product_additives` 에 **한 줄도 쓰지 않는다.**
// ════════════════════════════════════════════════════════════════════════════

/** `contribution_review.axis` CHECK 어휘와 «같아야» 한다(024). */
const REVIEW_AXES = ['nutrition', 'ingredients', 'allergens', 'additives'];

// ★★ 024 배포순서 방어. `hasEvidenceLevelColumn`·`hasAdditiveDetectedCountColumn` 과
//   **같은 규칙**을 쓴다 — 규칙을 새로 발명하지 않는다:
//     · 성공만 캐싱한다(실패는 null 로 두어 다음 요청에 재판정).
//     · 테이블이 없으면 candidate 를 만들지 않는다. **제보 자체는 그대로 저장된다.**
//   ⚠ 여기서 throw 하면 024 미적용 DB 에서 **제보 전건이 반려**된다. 그것이
//     세션45 치명1(쓰기 경로에 컬럼 가드가 없어 트랜잭션 전체가 롤백)과 같은 형태의 사고다.
let _hasContributionReview = null;

async function hasContributionReviewTable() {
  if (_hasContributionReview !== null) return _hasContributionReview;
  try {
    const r = await db.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_name = 'contribution_review' LIMIT 1`,
    );
    _hasContributionReview = r.rows.length > 0;   // ★ 성공했을 때만 캐싱한다
    return _hasContributionReview;
  } catch (_) {
    return false;   // ★ 실패는 캐싱하지 않는다. 이번 요청만 보수적으로 "없다".
  }
}

/** 테스트에서 캐시를 비운다(024 전/후를 한 프로세스에서 검사하기 위함). */
function _resetContributionReviewCache() { _hasContributionReview = null; }

/**
 * 검토 큐에 candidate 1행을 만든다. **이것이 제보가 남기는 «유일한» 판정 자리다.**
 *
 * ⚠ `status` 를 인자로 받지 않는다. 코드가 `'approved'` 를 만들 수 있으면
 *   `cr_approve_human_chk`(DB 가 강제하는 `DS-1` 전량 수동)를 우회할 궁리가 생긴다.
 *   **여기서 만들 수 있는 것은 `candidate` 뿐이다.**
 *
 * @param {{query: Function}} client - 트랜잭션 client (BEGIN 은 호출부가 한다)
 * @returns {Promise<number>} review_id
 */
async function insertReviewCandidate(client, { contributionId, productId, axis, evidence }) {
  if (!REVIEW_AXES.includes(axis)) {
    throw new Error(`알 수 없는 검토 축입니다: ${axis}`);
  }
  const r = await client.query(
    `INSERT INTO contribution_review (contribution_id, product_id, axis, status, evidence)
     VALUES ($1, $2, $3, 'candidate', $4::jsonb)
     RETURNING review_id`,
    [contributionId, productId, axis, JSON.stringify(evidence || {})],
  );
  return Number(r.rows[0].review_id);
}

/**
 * ★ 병합 전용 — 같은 (제품, 축)에 **병합이 만든 candidate 는 1건만** 둔다.
 *
 * 왜 갱신인가 — 병합은 기여가 하나 늘 때마다 다시 돈다(3대·4대·5대…).
 * 매번 INSERT 하면 같은 제품의 같은 축이 검토 큐에 수십 줄로 쌓인다.
 * 판정 내용(median·이상치·기기 수)은 **가장 최근 것이 정답**이므로 갱신이 맞다.
 * ⚠ 경로 ①(개별 제보)은 갱신하지 않는다 — 제보 1건 = 판정 1건이 그쪽의 계약이다.
 * ⚠ `status='candidate'` 인 것만 갱신한다. 이미 사람이 approved/rejected 한 것은 건드리지 않는다.
 */
async function upsertMergeCandidate(client, { contributionId, productId, axis, evidence }) {
  const existing = await client.query(
    `SELECT review_id FROM contribution_review
      WHERE product_id = $1 AND axis = $2 AND status = 'candidate'
        AND evidence->>'origin' = 'merge'
      ORDER BY review_id
      LIMIT 1`,
    [productId, axis],
  );
  if (existing.rows.length > 0) {
    const reviewId = Number(existing.rows[0].review_id);
    await client.query(
      `UPDATE contribution_review
          SET contribution_id = $2, evidence = $3::jsonb
        WHERE review_id = $1`,
      [reviewId, contributionId, JSON.stringify(evidence || {})],
    );
    return reviewId;
  }
  return insertReviewCandidate(client, { contributionId, productId, axis, evidence });
}

// ====================================================================
// 1. 필드별 병합 알고리즘 (순수 함수 — 테스트 가능)
// ====================================================================

/**
 * 숫자 배열의 median (중간값). 빈 배열이면 null.
 */
function median(values) {
  const xs = values.filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * 텍스트 배열의 다수결. 동률이면 가장 긴 것 (보통 더 정확함).
 * 빈/공백은 무시. 정규화: 양끝 공백 제거 + 연속 공백 단일화.
 */
function majorityText(values) {
  const counts = new Map();
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const v = raw.trim().replace(/\s+/g, ' ');
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  if (counts.size === 0) return null;
  const sorted = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || b[0].length - a[0].length,
  );
  return sorted[0][0];
}

/**
 * 원재료명 배열들의 다수결 union.
 * 각 contribution 의 원재료 리스트를 받아, "총 N건 중 minCount 건 이상에 등장한"
 * 원재료만 채택. minCount 는 디폴트 ceil(N/2) — 과반수.
 *
 * 단, N <= 2 면 union (보수적).
 */
function majorityIngredients(listOfLists, options = {}) {
  const lists = listOfLists.filter((l) => Array.isArray(l) && l.length > 0);
  if (lists.length === 0) return [];

  const N = lists.length;
  const minCount = options.minCount ?? (N <= 2 ? 1 : Math.ceil(N / 2));

  // 정규화: 양끝 공백 + 소문자 (한글이라 효과 없음, 안전장치)
  const normalize = (s) => String(s).trim().toLowerCase();

  // 각 ingredient 가 몇 개의 contribution 에서 등장했는지 카운트
  const occurrences = new Map();
  const originalCase = new Map();   // 원본 표기 보존 (가장 자주 나오는 표기)
  for (const list of lists) {
    const seen = new Set();          // 같은 contribution 안에 중복 있어도 1로 카운트
    for (const raw of list) {
      const norm = normalize(raw);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      occurrences.set(norm, (occurrences.get(norm) || 0) + 1);

      // 원본 표기 보존 — 가장 흔한 표기 선택
      const caseMap = originalCase.get(norm) || new Map();
      caseMap.set(raw, (caseMap.get(raw) || 0) + 1);
      originalCase.set(norm, caseMap);
    }
  }

  const accepted = [];
  for (const [norm, count] of occurrences) {
    if (count < minCount) continue;
    const caseMap = originalCase.get(norm);
    const bestCase = [...caseMap.entries()].sort((a, b) => b[1] - a[1])[0][0];
    accepted.push({ name: bestCase, source_count: count });
  }
  // 등장 횟수 내림차순
  accepted.sort((a, b) => b.source_count - a.source_count);
  return accepted;
}

// ────────────────────────────────────────────────────────────────────
// 알레르기 근거 등급 (세션45 · 마이그레이션 020)
// ────────────────────────────────────────────────────────────────────
/**
 * 등급 서열. 병합은 **큰 쪽으로만** 간다.
 * ★ 왜 낮추지 않는가 — 등급을 낮추는 병합은 경고를 지우는 방향이다.
 *   기여 A 가 「직접 함유: 대두」, 기여 B 가 OCR 실패로 「혼입 가능: 대두」 를 냈을 때
 *   B 를 채택하면 대두 알레르기 사용자에게 표시되던 붉은 경고가 점선으로 바뀐다.
 *   세션44 `mergeAllergensV2` 가 두 사진에 대해 세운 규칙과 동일하다.
 */
const ALLERGEN_LEVEL_RANK = { may_contain: 1, inferred: 2, contains: 3 };
const ALLERGEN_LEVEL_DEFAULT = 'contains';

/**
 * ★★★ 세션55 — 알레르겐 이름을 «DB 에 쓰기 전에» 19종 정본으로 바꾼다.
 *
 * 왜 필요했나 (2026-08-08 실측):
 *   `product_allergens.allergen_name` 에 쓰는 경로에 정규화가 **한 곳도 없었다.**
 *   `grep -a "normalizeAllergen" src/services/mergeService.js src/services/crowdsourceService.js` → 0건.
 *   정규화는 **읽기 시점**(`productModel.getAllergens`)에만 있었다. 그래서:
 *     ① 같은 알레르겐이 여러 표기로 저장됐다(2026-07-31 실측 5,649행 중 비정본 705행 = 12.5%).
 *     ② UNIQUE 인덱스가 `(product_id, allergen_name)` 이라(`000_baseline.sql:360`)
 *        `난류` 행과 `난류(가금류)` 행은 **다른 키**다. `ON CONFLICT` 가 안 걸려 중복 행이 쌓인다.
 *     ③ `scripts/76-normalize-allergen-names.js` 로 청소해도 **다음 제보에 재오염**된다.
 *        76 번은 청소일 뿐 원인 제거가 아니었다.
 *
 * ⚠ 정규화에 «붙지 않는» 이름은 **버리지 않고 원문 그대로 통과시킨다.**
 *   버리면 모르는 알레르겐 정보가 사라진다 — 과소경고다. 이 저장소가 세션44 이후 일관되게
 *   과잉경고보다 과소경고를 더 위험하게 다뤄 온 이유와 같다(`ocrRoutes.js:390` 도 같은 판단).
 *   오염의 실제 원인은 `난류` 같은 **별칭**이고, 별칭은 정규화가 붙는다.
 *
 * ⚠ 이 함수는 등급(level)을 만들지 않는다. 등급은 `levelsFromV2` 소관이다.
 */
function canonicalizeAllergenName(raw) {
  if (typeof raw !== 'string') return [];
  const v = raw.trim();
  if (!v) return [];
  let hits = [];
  try {
    hits = normalizeAllergenNames(v) || [];
  } catch (e) {
    // 정규화기가 죽어도 병합 전체를 죽이지 않는다 — 원문으로 진행한다.
    return [v];
  }
  const names = hits.map((h) => h && h.name).filter(Boolean);
  return names.length ? [...new Set(names)] : [v];
}

function strongerLevel(a, b) {
  const ra = ALLERGEN_LEVEL_RANK[a] || 0;
  const rb = ALLERGEN_LEVEL_RANK[b] || 0;
  return rb > ra ? b : (a || b);
}

/**
 * 한 기여의 `allergens_v2`(3분리) 를 `{이름 → 등급}` 으로 평탄화한다.
 * ★ v2 가 없으면(구 기여, 또는 사용자 덮어쓰기로 null) `{}` 를 돌려주고
 *   호출부가 flat 목록을 기본 등급 contains 로 취급하게 한다.
 *   여기서 v2 없는 것을 may_contain 으로 떨어뜨리면 **과거 기여 전량이 강등**된다.
 */
function levelsFromV2(v2) {
  const out = new Map();
  if (!v2 || typeof v2 !== 'object') return out;
  const put = (list, level) => {
    if (!Array.isArray(list)) return;
    for (const n of list) {
      if (typeof n !== 'string') continue;
      const v = n.trim();
      if (!v) continue;
      out.set(v, strongerLevel(out.get(v), level));
    }
  };
  // 강한 등급을 나중에 넣어도 strongerLevel 이 처리하지만, 순서 의존을 남기지 않는다.
  put(v2.mayContain, 'may_contain');
  put(v2.inferred, 'inferred');
  put(v2.contains, 'contains');
  return out;
}

/**
 * 알레르기 union — 한 명이라도 등록했으면 채택 (안전 우선).
 * source_count 함께 반환해서 candidate / confirmed 구분 가능.
 *
 * ★ 세션45: 등급(evidence_level)을 함께 병합한다.
 *   @param listOfLists  기여별 flat 이름 배열 (구 형식 호환 — 그대로 받는다)
 *   @param listOfV2     기여별 allergens_v2 객체 배열 (같은 인덱스로 짝을 맞춘다). 없으면 무시.
 *
 * ★ 인덱스 짝맞춤이 계약이다. 어긋나면 A 의 이름에 B 의 등급이 붙는다 —
 *   예외가 나지 않고 조용히 틀리는 종류의 결함이므로 테스트로 고정했다.
 */
function unionAllergens(listOfLists, listOfV2 = []) {
  const counts = new Map();
  const levels = new Map();
  for (let i = 0; i < listOfLists.length; i += 1) {
    const list = listOfLists[i];
    const v2Levels = levelsFromV2(listOfV2[i]);

    // v2 에만 있고 flat 에 없는 이름도 채택한다.
    // ★ 세션44 가 flat 에서 혼입 항목을 제거했으므로, 이 합집합이 없으면
    //   혼입 정보가 DB 에 영원히 도달하지 못한다(§6-2 가 풀려던 문제 그 자체).
    // ★★★ 세션55 — 여기서 «정본화» 한다. 이름 하나가 여러 정본으로 갈릴 수 있으므로 Map 이다.
    const names = new Map();   // 정본 이름 → 등급
    const put = (raw, level) => {
      for (const c of canonicalizeAllergenName(raw)) {
        names.set(c, strongerLevel(names.get(c), level));
      }
    };
    if (Array.isArray(list)) {
      for (const a of list) {
        if (typeof a !== 'string') continue;
        const v = a.trim();
        if (v) put(v, v2Levels.get(v) || ALLERGEN_LEVEL_DEFAULT);
      }
    }
    for (const [n, lv] of v2Levels) put(n, lv || ALLERGEN_LEVEL_DEFAULT);
    if (names.size === 0) continue;

    for (const [v, lv] of names) {
      counts.set(v, (counts.get(v) || 0) + 1);
      levels.set(v, strongerLevel(levels.get(v), lv));
    }
  }
  return [...counts.entries()].map(([name, count]) => ({
    name,
    source_count: count,
    evidence_level: levels.get(name) || ALLERGEN_LEVEL_DEFAULT,
  }));
}

/**
 * 이상치 감지 — median 대비 ±50% 이탈한 값이 있는지.
 * @returns {Array<{nutrient, value, median, deviation}>} 이상치 목록
 */
function detectOutliers(perNutrientValues) {
  const outliers = [];
  for (const [nutrient, values] of Object.entries(perNutrientValues)) {
    const m = median(values);
    if (m === null || m === 0) continue;
    for (const v of values) {
      if (v === null || v === undefined) continue;
      const deviation = Math.abs(v - m) / m;
      if (deviation > 0.5) {
        outliers.push({ nutrient, value: v, median: m, deviation });
      }
    }
  }
  return outliers;
}

// ====================================================================
// 2. Contributions → 필드별 후보값 추출
// ====================================================================

const NUTRIENT_FIELDS = [
  'calories', 'sodium', 'total_sugars', 'total_fat', 'saturated_fat', 'trans_fat',
  'cholesterol', 'protein', 'dietary_fiber', 'total_carbs',
];

const META_FIELDS = ['product_name', 'manufacturer', 'brand', 'food_type'];

/**
 * 한 contribution(JSONB data) 에서 병합용 후보값 추출.
 * data 구조는 saveOcrContribution 에서 INSERT 한 형태:
 *   { parsed_nutrition, parsed_ingredients, allergens, user_input, device_id, ... }
 */
function extractCandidatesFromContribution(contribution) {
  const data = typeof contribution.data === 'string'
    ? JSON.parse(contribution.data)
    : (contribution.data || {});
  const userInput = data.user_input || {};
  const nutrition = data.parsed_nutrition || {};

  // 사용자가 화면에서 수정한 값이 있으면 그 값을 우선 (OCR 자동값보다 신뢰).
  // 메타: user_input 우선, 영양: 사용자가 수정한 nutrition 이 있다면 그것 (현재는 없음)
  const meta = {
    product_name: userInput.product_name || data.parsed_meta?.product_name || null,
    manufacturer: userInput.manufacturer || data.parsed_meta?.manufacturer || null,
    brand: userInput.brand || data.parsed_meta?.brand || null,
    food_type: userInput.food_type || data.parsed_meta?.food_type || null,
    serving_size: numOrNull(userInput.serving_size ?? nutrition.serving_size),
    total_content: numOrNull(userInput.total_content ?? data.parsed_meta?.total_content),
    content_unit: userInput.content_unit || 'g',
  };

  const nutritionVals = {};
  for (const f of NUTRIENT_FIELDS) {
    nutritionVals[f] = numOrNull(nutrition[f]);
  }

  // 원재료: parsed_ingredients 배열의 name 만 추출 (객체 또는 문자열 모두 처리)
  const rawIngredients = Array.isArray(data.parsed_ingredients) ? data.parsed_ingredients : [];
  const ingredients = rawIngredients
    .map((i) => (typeof i === 'string' ? i : i?.name))
    .filter((s) => s && String(s).trim().length > 0);

  const allergens = Array.isArray(data.allergens) ? data.allergens : [];
  // ★ 세션45: 세션44 가 기여 레코드에 저장하기 시작한 3분리를 여기서 꺼낸다.
  //   꺼내지 않으면 저장은 되지만 **마스터 테이블까지 오지 못한다** — 세션44 중대F 의 나머지 절반이다.
  //   구 기여에는 없다(null). 그 경우 flat 목록이 기본 등급 contains 로 처리된다.
  const allergensV2 = (data.allergens_v2 && typeof data.allergens_v2 === 'object')
    ? data.allergens_v2 : null;

  return {
    contributionId: contribution.contribution_id,
    deviceId: data.device_id || contribution.device_id || null,
    avgConfidence: data.avg_confidence || 0,
    meta,
    nutrition: nutritionVals,
    ingredients,
    allergens,
    allergensV2,
  };
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ====================================================================
// 3. 메인 — mergeContributions / mergeAndApply
// ====================================================================

/**
 * 같은 product_id 의 contributions 배열을 받아 필드별 병합 후보값을 계산한다.
 * DB 변경 없음 — 순수 계산만. 테스트 가능.
 */
function mergeContributions(contributions) {
  const candidates = contributions.map(extractCandidatesFromContribution);

  // distinct device_id 카운트 (같은 device 가 여러 번 올렸어도 1로 카운트)
  const distinctDevices = new Set(
    candidates.map((c) => c.deviceId).filter(Boolean),
  );

  // ── 메타 필드: 다수결 ──
  const mergedMeta = {};
  for (const f of META_FIELDS) {
    mergedMeta[f] = majorityText(candidates.map((c) => c.meta[f]));
  }
  mergedMeta.serving_size = median(candidates.map((c) => c.meta.serving_size));
  mergedMeta.total_content = median(candidates.map((c) => c.meta.total_content));
  mergedMeta.content_unit = majorityText(candidates.map((c) => c.meta.content_unit)) || 'g';

  // ── 영양: median ──
  const mergedNutrition = {};
  const perNutrient = {};
  for (const f of NUTRIENT_FIELDS) {
    const vals = candidates.map((c) => c.nutrition[f]);
    perNutrient[f] = vals;
    mergedNutrition[f] = median(vals);
  }

  // ── 원재료: 다수결 ──
  const mergedIngredients = majorityIngredients(candidates.map((c) => c.ingredients));

  // ── 알레르기: union + source_count + 등급(세션45) ──
  // ★ 두 map 이 **같은 candidates 순서**여야 한다. 인덱스로 짝을 맞추기 때문이다.
  const mergedAllergens = unionAllergens(
    candidates.map((c) => c.allergens),
    candidates.map((c) => c.allergensV2),
  );

  // ── 이상치 감지 ──
  const outliers = detectOutliers(perNutrient);

  return {
    sourceCount: candidates.length,
    distinctDeviceCount: distinctDevices.size,
    meta: mergedMeta,
    nutrition: mergedNutrition,
    ingredients: mergedIngredients,
    allergens: mergedAllergens,
    outliers,
    hasSignificantOutliers: outliers.length > 0,
  };
}

// ====================================================================
// 4. DB 적용 (mergeAndApply) — 트랜잭션
// ====================================================================

/**
 * 자동 verified 임계값. 다른 device_id 가 이 수 이상 모이면 자동 verified.
 * 단, 이상치가 있으면 disputed 로 마킹.
 */
const AUTO_VERIFY_DISTINCT_DEVICES = 3;

/**
 * 같은 product 의 모든 contributions 를 fetch 해서 merge 후 마스터에 반영.
 *
 * @param {number} productId
 * @returns {Object} { applied, sourceCount, distinctDeviceCount, verification, outliers }
 */
async function mergeAndApply(productId) {
  // 같은 product 의 ocr_nutrition contributions 만 (오류 신고는 제외)
  const result = await db.query(
    `SELECT contribution_id, data, created_at
     FROM contributions
     WHERE product_id = $1
       AND contribution_type IN ('ocr_nutrition', 'new_product', 'verify')
     ORDER BY created_at ASC`,
    [productId],
  );

  if (result.rows.length === 0) {
    return { applied: false, reason: 'no contributions' };
  }

  const merged = mergeContributions(result.rows);
  const { sourceCount, distinctDeviceCount, meta, nutrition, ingredients, allergens, outliers } = merged;

  // ★★★ 세션64b — 「병합 결과에 영양값이 하나도 없으면」 판정. 종전에는 트랜잭션 «안»에서
  //   UPSERT 직전에 셌는데, 세션65 C3 이 이 값을 `verification` 결정에도 쓰므로
  //   **트랜잭션 밖으로 끌어올렸다.** (순수 계산이라 위치를 옮겨도 값이 같다.)
  const mergedNutrientCount = NUTRIENT_FIELDS
    .reduce((n, f) => n + (nutrition[f] === null || nutrition[f] === undefined ? 0 : 1), 0);

  // verification 결정
  //
  // ★★★ 세션65 C3 (`U64-12`) — **영양 0개로는 `verified` 에 못 간다.**
  //   종전: `distinctDeviceCount >= 3` 이면 이상치가 없는 한 무조건 `verified`.
  //   그런데 세션64b 부터 `crowdsourceService` 가 **영양 미확보 제보도 저장**한다.
  //   그런 기여의 `parsed_nutrition` 은 null 이라 병합 median 이 전 항목 null 이 되고,
  //   이상치도 당연히 0건이다(값이 없으니 이탈할 것도 없다).
  //   ⇒ **확인된 영양값이 하나도 없는 제품이 「검증됨」 배지를 단다.**
  //     사용자는 그 배지를 「영양정보가 맞다」로 읽는다. 세션64b 가 세운
  //     「확인한 것이 없다면 부분 확인도 아니다」의 병합판이다.
  //
  //   ⚠ 0개일 때 `unverified` 로 **떨어뜨리지 않는다.** 기기 2대면 이미 `partial` 인데
  //     3대에서 더 낮아지는 것은 앞뒤가 맞지 않는다. 기기 3대가 원재료·알레르기에
  //     동의한 것 자체는 「부분 확인」이 맞다. → `partial` 에서 멈춘다.
  //
  //   ★ 그리고 세션65 C3 에 따라 **`verified` 로 가는 문은 이 함수 하나뿐이다.**
  //     경로 ①(`crowdsourceService`)의 `partial AND verify_count>=1 → verified` 는 끊었다.
  //     여기만 `distinctDeviceCount`(= 서로 «다른» 기기 수)를 실제로 센다.
  let verification = 'unverified';
  if (distinctDeviceCount >= AUTO_VERIFY_DISTINCT_DEVICES) {
    if (outliers.length > 0) verification = 'disputed';
    else verification = mergedNutrientCount > 0 ? 'verified' : 'partial';
  } else if (distinctDeviceCount >= 2) {
    verification = 'partial';
  }

  // ★★★ 세션47 3차 검증 중대3 — 이 판정은 **반드시 트랜잭션 밖**이어야 한다.
  //   `hasContributionReviewTable()` 은 내부에서 `db.query`(= `pool.query`)를 쓴다.
  //   트랜잭션 client 를 쥔 채 부르면 merge 1건이 순간적으로 **커넥션 2개**를 점유한다.
  //   DB_POOL_MAX 만큼 동시 merge 가 열리면 전원이 두 번째 커넥션을 기다리다
  //   connectionTimeoutMillis 로 **동시에 실패**하고, 그 실패는 crowdsourceService 가
  //   삼켜서 `saved: true` 로 나간다(치명1 과 똑같은 침묵 형태).
  //   ★ 자기증폭이 위험하다 — 판정이 계속 실패하면 성공만 캐싱하므로(중대2 수정)
  //     캐시가 영원히 안 차고 **매 merge 마다** 중첩 획득이 일어난다.
  //     그 상황(풀 고갈·콜드 스타트)이 정확히 세션46 이 대비하려던 상황이다.
  //   pglite 실측: 트랜잭션 보유 중 pool 커넥션 별도 획득 1건 · pg.Pool 모델에서 교착 재현.
  const canQueueReview = await hasContributionReviewTable();
  if (!canQueueReview) {
    logger.error('024 미적용 DB — 병합 결과를 검토 큐에 넣지 못한다(제보 원본은 보존된다)',
      { productId });
  }

  // ★ 검토 큐 행이 매달릴 «원본 제보». 가장 최근 기여를 앵커로 쓴다
  //   (`contribution_review.contribution_id` 는 NOT NULL 이다).
  //   병합에 실제로 들어간 기여 전부는 `evidence.source_contribution_ids` 에 남긴다 —
  //   관리자가 「몇 건이 무엇을 말했나」를 되짚을 수 있어야 한다.
  const sourceContributionIds = result.rows
    .map((r) => Number(r.contribution_id))
    .filter((n) => Number.isFinite(n));
  const anchorContributionId = sourceContributionIds.length
    ? sourceContributionIds[sourceContributionIds.length - 1] : null;

  const reviewIds = {};

  // 트랜잭션으로 마스터 갱신
  await db.transaction(async (client) => {
    // ── 1) products 메타 갱신 ──
    await client.query(
      `UPDATE products SET
         product_name = COALESCE($2, product_name),
         manufacturer = COALESCE($3, manufacturer),
         brand        = COALESCE($4, brand),
         food_type    = COALESCE($5, food_type),
         serving_size = COALESCE($6, serving_size),
         total_content = COALESCE($7, total_content),
         content_unit  = COALESCE($8, content_unit),
         servings_per_container = CASE
           WHEN $7::numeric IS NOT NULL AND $6::numeric IS NOT NULL AND $6::numeric > 0
             THEN ROUND(($7::numeric / $6::numeric)::numeric, 1)
           ELSE servings_per_container
         END,
         verification = CASE
           WHEN verification = 'admin_verified' THEN 'admin_verified'::verification_status
           ELSE $9::verification_status
         END,
         merged_at = NOW(),
         merge_sources_count = $10,
         updated_at = NOW()
       WHERE product_id = $1`,
      [
        productId,
        meta.product_name, meta.manufacturer, meta.brand, meta.food_type,
        meta.serving_size, meta.total_content, meta.content_unit,
        verification, sourceCount,
      ],
    );

    // ══════════════════════════════════════════════════════════════════════
    // ── 2)~5) ★★★★★ 세션66 C6 — 공식 테이블 쓰기를 «전부» 검토 큐로 대체한다
    // ══════════════════════════════════════════════════════════════════════
    // 종전에는 여기서 네 곳에 직접 썼다:
    //   `nutrition_data` UPSERT · `product_ingredients` INSERT
    //   · `product_additives` 합집합 · `product_allergens` DELETE + UPSERT
    //
    // ⛔ 전부 지웠다. 설계 §3-2 · 제이 확인 2026-08-30: **전량 수동에 예외가 없다.**
    //   「기기 3대가 일치했다」는 강한 신호지만 **사람의 승인이 아니다.**
    //   3대가 같은 오독을 하는 라벨이 실재하고(같은 흐린 인쇄를 셋이 똑같이 읽는다),
    //   그때 자동 반영은 「셋이 확인했다」는 배지를 달고 마스터에 들어간다.
    //
    // ⇒ 이 변경으로 소멸하는 것:
    //   `U65-6` 공공데이터 보호가 1회용 — 제보가 `nutrition_data` 를 쓰는 경로 자체가 없어졌다.
    //       (종전 `canOverwriteNutrition` 게이트는 `data_source` 가 한 번 `ocr_crowdsource` 로
    //        덮이면 다음부터는 「공공이 아니다」가 되어 **영원히 열려 있었다.**)
    //   병합의 `DELETE FROM product_allergens ... detected_via='crowdsource_merge'` 도 사라졌다
    //       ⇒ 병합이 알레르기 «행을 지우는» 경로가 0 이 됐다(경고 순감 방향의 문 하나가 닫혔다).
    //
    // ★★ 그러나 «판정»(median·다수결·union·이상치·기기 수)은 **그대로 유지한다.**
    //   그 결과를 `contribution_review.evidence` 에 실어 관리자가
    //   「기기 3대가 무엇에 일치했는가」를 보고 판단할 수 있게 한다.
    //   ⛔ 판정을 지우면 관리자에게 남는 것이 사진 3장뿐이다 — 검토가 불가능해진다.
    //
    // ⚠ `products` 메타·`verification` 갱신(위 1번)은 **건드리지 않았다.**
    //   「미검토 제보가 `products` 를 건드리는가」는 계약 §7-C 가 `U66-1` 로 «보류»했다.
    //   섞으면 회귀 범위가 폭발한다.
    if (!canQueueReview || anchorContributionId === null) return;

    // 관리자가 보게 될 «공통» 판정 근거. 축마다 자기 몫을 덧붙인다.
    const baseEvidence = {
      origin: 'merge',
      merged_at: new Date().toISOString(),
      source_count: sourceCount,
      distinct_device_count: distinctDeviceCount,
      auto_verify_threshold: AUTO_VERIFY_DISTINCT_DEVICES,
      verification,
      outliers,
      has_significant_outliers: merged.hasSignificantOutliers,
      source_contribution_ids: sourceContributionIds,
    };

    // ── 2') 영양 — median 판정 결과를 candidate 로 ──
    //   ★ 「공공 영양이 이미 있는가」를 **읽어서 증거로만** 남긴다.
    //     종전에는 이 값이 «덮어쓸지 말지»를 정하는 게이트였다. 이제는 아무것도 정하지 않는다 —
    //     승인 시 `contributionApply` 가 그 행의 기준(basis)에 맞춰 환산할 뿐이고,
    //     값 자체는 뷰가 `COALESCE(공공, 제보)` 로 합치므로 **공공이 언제나 이긴다**(DS-8).
    const existingNut = await client.query(
      `SELECT data_source FROM nutrition_data WHERE product_id = $1`,
      [productId],
    );
    const publicNutritionSource = existingNut.rows.length
      ? (existingNut.rows[0].data_source || null) : null;

    if (mergedNutrientCount > 0) {
      reviewIds.nutrition = await upsertMergeCandidate(client, {
        contributionId: anchorContributionId,
        productId,
        axis: 'nutrition',
        evidence: {
          ...baseEvidence,
          nutrient_count: mergedNutrientCount,
          merged_nutrition: nutrition,
          per_nutrient_outliers: outliers,
          existing_public_nutrition_source: publicNutritionSource,
        },
      });
    }

    // ── 3') 원재료 — 다수결 결과를 candidate 로 ──
    if (ingredients.length > 0) {
      reviewIds.ingredients = await upsertMergeCandidate(client, {
        contributionId: anchorContributionId,
        productId,
        axis: 'ingredients',
        evidence: {
          ...baseEvidence,
          ingredient_count: ingredients.length,
          merged_ingredients: ingredients,
        },
      });

      // ── 4') 첨가물 — 원재료명이 있으면 검출할 «내용»이 있다 ──
      //   ⚠ 첨가물은 `additiveResolver` 가 「검출 ∪ (원재료명 ∩ 마스터)」로 정한다.
      //     검출이 0종이어도 원재료명 완전일치 축이 살아 있으므로, 원재료가 있으면 축에 내용이 있다.
      //   ⛔ 여기서 검출 SQL 을 새로 쓰지 않는다 — 규칙 본문은 `additiveResolver.js` 한 곳이고,
      //     승인 시 `contributionApply` 가 그 함수를 «호출»한다.
      reviewIds.additives = await upsertMergeCandidate(client, {
        contributionId: anchorContributionId,
        productId,
        axis: 'additives',
        evidence: {
          ...baseEvidence,
          ingredient_names: ingredients.map((i) => i.name),
          note: '첨가물 검출 규칙 본문은 additiveResolver.js 에 있다. 승인 시 그 함수가 돈다.',
        },
      });
    }

    // ── 5') 알레르기 — union + source_count + 등급을 candidate 로 ──
    //   ⚠ 등급(evidence_level)은 여기서 **내리지 않는다**(`unionAllergens` 가 올리기만 한다).
    //     실제 UPSERT 의 승격 CASE 는 `contributionApply.js` 로 옮겼다 — 규칙 본문은 한 곳이다.
    if (allergens.length > 0) {
      reviewIds.allergens = await upsertMergeCandidate(client, {
        contributionId: anchorContributionId,
        productId,
        axis: 'allergens',
        evidence: {
          ...baseEvidence,
          allergen_count: allergens.length,
          merged_allergens: allergens,
        },
      });
    }
  });

  logger.info('mergeAndApply 완료', {
    productId, sourceCount, distinctDeviceCount, verification,
    outlierCount: outliers.length,
    reviewCandidates: Object.keys(reviewIds),
    queued: canQueueReview,
  });

  return {
    applied: true,
    sourceCount,
    distinctDeviceCount,
    verification,
    outliers,
    merged: { meta, nutrition, ingredients, allergens },
    // ── 세션66 C6 신설 키 ─────────────────────────────────────────────────
    //   ⚠ 기존 키(`applied`·`sourceCount`·`distinctDeviceCount`·`verification`·
    //     `outliers`·`merged`)는 **한 글자도 바꾸지 않았다.** 호출부가 그것으로 판정한다.
    //   ★ `applied: true` 의 뜻이 바뀌었다 — 「병합 «판정»을 냈고 검토 큐에 넣었다」이지
    //     「공식 테이블에 반영했다」가 아니다. 반영은 사람이 승인할 때 일어난다.
    reviewIds,
    queuedForReview: canQueueReview,
  };
}

module.exports = {
  // 메인 진입점
  mergeContributions,
  mergeAndApply,

  // 세션66 C6: 검토 큐 — 경로 ①·②가 «같은 본문»을 쓴다
  hasContributionReviewTable,
  insertReviewCandidate,
  upsertMergeCandidate,
  REVIEW_AXES,
  _resetContributionReviewCache,

  // 내부 알고리즘 (테스트용 export)
  median,
  majorityText,
  majorityIngredients,
  unionAllergens,
  detectOutliers,
  extractCandidatesFromContribution,

  // 세션45: 알레르기 등급 (테스트가 서열 규칙을 직접 고정한다)
  levelsFromV2,
  strongerLevel,
  // 세션55: 쓰기 경로 정본화 (회귀가 이 함수를 «직접» 부른다 — 로직을 재현하지 않게)
  canonicalizeAllergenName,

  // 상수
  AUTO_VERIFY_DISTINCT_DEVICES,
  NUTRIENT_FIELDS,
  META_FIELDS,
  ALLERGEN_LEVEL_RANK,
  ALLERGEN_LEVEL_DEFAULT,
};
