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

/**
 * 알레르기 union — 한 명이라도 등록했으면 채택 (안전 우선).
 * source_count 함께 반환해서 candidate / confirmed 구분 가능.
 */
function unionAllergens(listOfLists) {
  const counts = new Map();
  for (const list of listOfLists) {
    if (!Array.isArray(list)) continue;
    const seen = new Set();
    for (const a of list) {
      if (typeof a !== 'string') continue;
      const v = a.trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      counts.set(v, (counts.get(v) || 0) + 1);
    }
  }
  return [...counts.entries()].map(([name, count]) => ({
    name,
    source_count: count,
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

  return {
    contributionId: contribution.contribution_id,
    deviceId: data.device_id || contribution.device_id || null,
    avgConfidence: data.avg_confidence || 0,
    meta,
    nutrition: nutritionVals,
    ingredients,
    allergens,
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

  // ── 알레르기: union + source_count ──
  const mergedAllergens = unionAllergens(candidates.map((c) => c.allergens));

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
    // 기존 admin_verified 항목은 그대로 두고, 나머지는 merge 결과로 덮어씀.
    await client.query(
      `DELETE FROM product_allergens
       WHERE product_id = $1 AND status != 'admin_verified'`,
      [productId],
    );
    for (const a of allergens) {
      const status = a.source_count >= AUTO_VERIFY_DISTINCT_DEVICES ? 'confirmed' : 'candidate';
      await client.query(
        `INSERT INTO product_allergens (product_id, allergen_name, source_count, status, detected_via)
         VALUES ($1, $2, $3, $4, 'crowdsource_merge')
         ON CONFLICT (product_id, allergen_name) DO UPDATE SET
           source_count = EXCLUDED.source_count,
           status = EXCLUDED.status,
           updated_at = NOW()`,
        [productId, a.name, a.source_count, status],
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

  // 상수
  AUTO_VERIFY_DISTINCT_DEVICES,
  NUTRIENT_FIELDS,
  META_FIELDS,
};
