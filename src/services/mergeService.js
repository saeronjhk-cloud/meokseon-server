/**
 * 크라우드소싱 merge 서비스
 *
 * ⚠️ IP SOURCE: OneDrive/MeokSeon/IP/merge_policy_v1.md
 * 이 파일은 사본. 알고리즘 정책·임계값을 수정하려면 OneDrive 의 원본 먼저 수정 후 여기 반영.
 *
 * 같은 제품에 대한 여러 사용자의 OCR 등록(contributions) 을 필드별 알고리즘으로
 * 병합하여 마스터 products / nutrition_data / product_ingredients / product_allergens
 * 테이블에 반영한다.
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
 */

const db = require('../config/database');
const logger = require('../config/logger');
// ★ 세션46 치명1 — 쓰기 경로에도 컬럼 가드가 필요하다. 판정 로직을 두 곳에 적지 않는다.
const { hasEvidenceLevelColumn } = require('../models/productModel');

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
    const names = new Set();
    if (Array.isArray(list)) {
      for (const a of list) {
        if (typeof a !== 'string') continue;
        const v = a.trim();
        if (v) names.add(v);
      }
    }
    for (const n of v2Levels.keys()) names.add(n);
    if (names.size === 0) continue;

    for (const v of names) {
      counts.set(v, (counts.get(v) || 0) + 1);
      levels.set(v, strongerLevel(levels.get(v), v2Levels.get(v) || ALLERGEN_LEVEL_DEFAULT));
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

  // verification 결정
  let verification = 'unverified';
  if (distinctDeviceCount >= AUTO_VERIFY_DISTINCT_DEVICES) {
    verification = outliers.length > 0 ? 'disputed' : 'verified';
  } else if (distinctDeviceCount >= 2) {
    verification = 'partial';
  }

  // ★★★ 세션47 3차 검증 중대3 — 이 판정은 **반드시 트랜잭션 밖**이어야 한다.
  //   `hasEvidenceLevelColumn()` 은 내부에서 `db.query`(= `pool.query`)를 쓴다.
  //   트랜잭션 client 를 쥔 채 부르면 merge 1건이 순간적으로 **커넥션 2개**를 점유한다.
  //   DB_POOL_MAX 만큼 동시 merge 가 열리면 전원이 두 번째 커넥션을 기다리다
  //   connectionTimeoutMillis 로 **동시에 실패**하고, 그 실패는 crowdsourceService 가
  //   삼켜서 `saved: true` 로 나간다(치명1 과 똑같은 침묵 형태).
  //   ★ 자기증폭이 위험하다 — 판정이 계속 실패하면 성공만 캐싱하므로(중대2 수정)
  //     캐시가 영원히 안 차고 **매 merge 마다** 중첩 획득이 일어난다.
  //     그 상황(풀 고갈·콜드 스타트)이 정확히 세션46 이 대비하려던 상황이다.
  //   pglite 실측: 트랜잭션 보유 중 pool 커넥션 별도 획득 1건 · pg.Pool 모델에서 교착 재현.
  const canWriteLevel = await hasEvidenceLevelColumn();
  if (!canWriteLevel) {
    logger.error('020 미적용 DB — evidence_level 없이 알레르기를 적재한다', { productId });
  }

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

    // ── 2) nutrition_data 갱신 (UPSERT) ──
    // 기존 nutrition_data 가 ocr_crowdsource 출처면 덮어쓰기, public_ 이면 보존.
    const existingNut = await client.query(
      `SELECT data_source FROM nutrition_data WHERE product_id = $1`,
      [productId],
    );
    const canOverwriteNutrition = existingNut.rows.length === 0
      || !String(existingNut.rows[0].data_source || '').startsWith('public_');

    if (canOverwriteNutrition) {
      // production 스키마 정렬:
      // - per_serving 컬럼 없음 (TRUE 만 INSERT 라 무의미)
      // - data_source enum 에 'ocr_crowdsource_merged' 값 없음 → 'ocr_crowdsource' 로 통일.
      //   merge 적용 여부는 products.merged_at IS NOT NULL / merge_sources_count 로 판정.
      // - production nutrition_data 에 updated_at 컬럼 없음 → ON CONFLICT 절에서 제거.
      await client.query(
        `INSERT INTO nutrition_data (
           product_id, calories, total_fat, saturated_fat, trans_fat,
           cholesterol, sodium, total_carbs, total_sugars, dietary_fiber, protein,
           data_source
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ocr_crowdsource')
         ON CONFLICT (product_id) DO UPDATE SET
           calories = EXCLUDED.calories,
           total_fat = EXCLUDED.total_fat,
           saturated_fat = EXCLUDED.saturated_fat,
           trans_fat = EXCLUDED.trans_fat,
           cholesterol = EXCLUDED.cholesterol,
           sodium = EXCLUDED.sodium,
           total_carbs = EXCLUDED.total_carbs,
           total_sugars = EXCLUDED.total_sugars,
           dietary_fiber = EXCLUDED.dietary_fiber,
           protein = EXCLUDED.protein,
           data_source = 'ocr_crowdsource'`,
        [
          productId,
          nutrition.calories, nutrition.total_fat, nutrition.saturated_fat, nutrition.trans_fat,
          nutrition.cholesterol, nutrition.sodium, nutrition.total_carbs, nutrition.total_sugars,
          nutrition.dietary_fiber, nutrition.protein,
        ],
      );
    }

    // ── 3) product_ingredients 갱신 ──
    // production 스키마 정렬:
    // - 컬럼명이 source (data_source 아님). varchar 라 'ocr_crowdsource' 그대로 OK.
    // - parsed_ingredients 가 jsonb 라 JSON.stringify 명시.
    if (ingredients.length > 0) {
      const ingredientNames = ingredients.map((i) => i.name);
      await client.query(
        `INSERT INTO product_ingredients (product_id, raw_text, parsed_ingredients, source)
         VALUES ($1, $2, $3, 'ocr_crowdsource')`,
        [productId, ingredientNames.join(', '), JSON.stringify(ingredientNames)],
      );
    }

    // ── 4) product_additives 자동 매칭 ──
    // production additives 에 is_active 없음 → 조건 제거.
    // detected_name·confidence 는 006 마이그레이션으로 추가됨.
    if (ingredients.length > 0) {
      const ingredientNames = ingredients.map((i) => i.name);
      const matchResult = await client.query(
        `SELECT additive_id, name_ko FROM additives
         WHERE name_ko = ANY($1::text[])`,
        [ingredientNames],
      );
      for (const row of matchResult.rows) {
        await client.query(
          `INSERT INTO product_additives (product_id, additive_id, detected_name, confidence)
           VALUES ($1, $2, $3, 100)
           ON CONFLICT (product_id, additive_id) DO NOTHING`,
          [productId, row.additive_id, row.name_ko],
        );
      }
    }

    // ── 5) product_allergens 갱신 ──
    //
    // ★★★ 세션45 1차 검증 치명2 — 이 DELETE 가 **아래 UPSERT 의 등급 보호를 통째로 우회**하고 있었다.
    //   원래 코드: `DELETE ... WHERE product_id = $1 AND status != 'admin_verified'`
    //
    //   무엇이 문제였나 (pglite 로 mergeAndApply 를 실제 실행해 재현) —
    //     ① `product_allergens.status = 'admin_verified'` 를 **세팅하는 코드가 저장소에 없다.**
    //        `grep -rn "admin_verified" src/` 의 쓰기 구문은 전부 `products.verification` 이다.
    //        즉 이 조건은 사실상 **무조건 전삭제**였다.
    //     ② 전삭제 후 INSERT 하므로 `ON CONFLICT` 가 걸릴 행이 없다.
    //        세션45 가 신중히 짠 승격/유지 CASE 는 **한 번도 실행되지 않는 죽은 코드**였다.
    //     ③ 실측: 식약처(HACCP) 적재분 `대두·밀·우유`(직접 함유) 가 있는 제품에
    //        사용자가 「대두 혼입」 사진 1장을 올리면 —
    //          이전: contains 3종  →  이후: contains 0종 / mayContain 대두 1종
    //        밀·우유는 **DB 에서 삭제**되고 대두는 강등된다. 경고 총량 순감이다.
    //
    //   → 이번 merge 가 만든 행(`detected_via = 'crowdsource_merge'`)만 정리한다.
    //     ★ 식약처·명시표기 등 **다른 출처의 행은 절대 지우지 않는다.** 크라우드소싱 1건이
    //       공적 출처를 덮어쓸 권한은 없다. 남겨두면 아래 UPSERT 가 등급을 올리기만 한다.
    //     ★ 그리고 admin_verified 는 여전히 보호한다(향후 그 값을 쓰게 되더라도 안전하도록).
    await client.query(
      `DELETE FROM product_allergens
       WHERE product_id = $1
         AND status != 'admin_verified'
         AND detected_via = 'crowdsource_merge'`,
      [productId],
    );
    // ★★★ 세션46 2차 검증 치명1 — 세션45 는 **조회 경로에만** 컬럼 가드를 넣었다.
    //   쓰기 경로(`INSERT ... evidence_level`)에는 없어서, 020 미적용 DB 에서
    //   이 INSERT 가 던지는 예외로 **트랜잭션 전체가 롤백**된다.
    //   알레르기만이 아니라 영양·메타·원재료·첨가물이 **하나도 반영되지 않는다.**
    //
    //   실측(정본 마이그레이션 001/004/005/006 만 적용한 pglite):
    //     column "evidence_level" of relation "product_allergens" does not exist
    //     → products.merged_at = null · nutrition_data = [] · product_allergens = []
    //
    //   ★ 이론이 아니다 — `package.json` 의 `migrate` 체인에 020 이 없다(`migrate:020` 단독 수동).
    //     즉 `npm run migrate` 로 만든 DB 에는 020 이 영원히 없다.
    //   ★ 그리고 조용하다 — `crowdsourceService` 가 이 예외를 catch 해서 로그만 남기고
    //     API 는 `saved: true` 를 반환한다. `/api/health` 도 정상이다.
    //   → 등급을 못 적더라도 **알레르기 행 자체는 남긴다.** 등급이 없는 경고와
    //     경고가 없는 것은 심각도가 다르다(후자는 경고가 사라지는 방향이다).
    //   ★ `canWriteLevel` 은 위(트랜잭션 **밖**)에서 이미 판정했다 — 세션47 중대3 참조.
    //     여기서 부르면 트랜잭션을 쥔 채 풀에서 두 번째 커넥션을 잡는다.
    for (const a of allergens) {
      const status = a.source_count >= AUTO_VERIFY_DISTINCT_DEVICES ? 'confirmed' : 'candidate';
      const level = ALLERGEN_LEVEL_RANK[a.evidence_level] ? a.evidence_level : ALLERGEN_LEVEL_DEFAULT;
      if (!canWriteLevel) {
        await client.query(
          `INSERT INTO product_allergens
             (product_id, allergen_name, source_count, status, detected_via)
           VALUES ($1, $2, $3, $4, 'crowdsource_merge')
           ON CONFLICT (product_id, allergen_name) DO UPDATE SET
             source_count = EXCLUDED.source_count,
             status = CASE
               WHEN product_allergens.status = 'admin_verified' THEN 'admin_verified'
               ELSE EXCLUDED.status
             END,
             updated_at = NOW()`,
          [productId, a.name, a.source_count, status],
        );
        continue;
      }
      await client.query(
        // ★★ 세션45: evidence_level 은 **올리기만 한다.**
        //   `EXCLUDED.evidence_level` 을 그대로 대입하면 이번 merge 가 혼입만 읽었을 때
        //   기존 admin_verified 가 아닌 「직접 함유」 행이 「혼입 가능」으로 **강등**된다.
        //   화면에서 붉은 태그가 점선으로 바뀌는 것 = 경고를 지우는 방향의 변경이다.
        //   CASE 로 서열을 비교해 강한 쪽을 남긴다(SQL 안에서 끝낸다 — 읽고-쓰기 경합을 만들지 않는다).
        `INSERT INTO product_allergens
           (product_id, allergen_name, source_count, status, detected_via, evidence_level)
         VALUES ($1, $2, $3, $4, 'crowdsource_merge', $5)
         ON CONFLICT (product_id, allergen_name) DO UPDATE SET
           source_count = EXCLUDED.source_count,
           -- ★★ 1차 검증 치명2-B: status 에 EXCLUDED.status 를 그대로 대입하면 admin_verified 를
           --   candidate 로 **깎아버린다.** 그러면 다음 merge 의 DELETE 대상이 되어
           --   관리자 검증 결과가 merge 2회 만에 사라진다(실측 재현됨).
           --   등급 보호가 1회용이 되지 않도록 status 도 함께 지킨다.
           status = CASE
             WHEN product_allergens.status = 'admin_verified' THEN 'admin_verified'
             ELSE EXCLUDED.status
           END,
           -- ★ detected_via 는 **아예 갱신하지 않는다**(SET 목록에서 뺐다).
           --   세션45 는 COALESCE(product_allergens.detected_via, EXCLUDED.detected_via) 였는데,
           --   세션46 2차 검증에서 이것이 **NULL 을 세탁한다**는 것이 실측됐다:
           --     merge1: 게(detected_via=NULL) → 'crowdsource_merge' 로 바뀜
           --     merge2: 위 DELETE 의 대상이 되어 **삭제됨**
           --   19-apply-haccp.js 의 컬럼 부재 폴백이 detected_via 없이 INSERT 하므로
           --   NULL 행은 실제로 존재한다. 갱신하지 않으면 NULL 로 남아 DELETE 를 타지 않는다.
           --   (경고가 사라지는 방향의 결함이므로 남기는 쪽을 택한다.)
           evidence_level = CASE
             WHEN COALESCE(product_allergens.evidence_level, 'contains') = 'contains' THEN 'contains'
             WHEN EXCLUDED.evidence_level = 'contains' THEN 'contains'
             WHEN COALESCE(product_allergens.evidence_level, 'contains') = 'inferred'
               OR EXCLUDED.evidence_level = 'inferred' THEN 'inferred'
             ELSE 'may_contain'
           END,
           updated_at = NOW()`,
        [productId, a.name, a.source_count, status, level],
      );
    }
  });

  logger.info('mergeAndApply 완료', {
    productId, sourceCount, distinctDeviceCount, verification,
    outlierCount: outliers.length,
  });

  return {
    applied: true,
    sourceCount,
    distinctDeviceCount,
    verification,
    outliers,
    merged: { meta, nutrition, ingredients, allergens },
  };
}

module.exports = {
  // 메인 진입점
  mergeContributions,
  mergeAndApply,

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

  // 상수
  AUTO_VERIFY_DISTINCT_DEVICES,
  NUTRIENT_FIELDS,
  META_FIELDS,
  ALLERGEN_LEVEL_RANK,
  ALLERGEN_LEVEL_DEFAULT,
};
