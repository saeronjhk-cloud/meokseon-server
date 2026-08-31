'use strict';
/**
 * contributionApply.js — 「승인된 제보를 공식 데이터셋으로 옮기는 «유일한» 곳」
 * ============================================================================
 * ① 정체성 —
 *   `contribution_review.status = 'approved'` 인 행 하나를 받아, 그 제보가 담고 있는
 *   한 축(`nutrition`·`ingredients`·`allergens`·`additives`)을 공식 테이블에 «옮긴다».
 *   그리고 옮기기 «전/후» 상태를 `contribution_review.evidence` 에 박아
 *   `undoAppliedContribution` 이 그 제보가 넣은 것«만» 되돌릴 수 있게 한다.
 *
 * ② 왜 생겼나 (세션65 설계 §11-B · 세션66 계약 C5) —
 *   종전에는 제보가 **검토 없이** 공식 테이블에 바로 들어갔다. 그래서:
 *     · `U65-6` 공공데이터 보호가 **1회용**이었다 — 제보가 `nutrition_data.data_source` 를
 *       `ocr_crowdsource` 로 덮으면 다음 제보에는 「기존 공공데이터」가 더 이상 없다.
 *     · `U65-7` 반려가 `DELETE FROM nutrition_data` 라서, 공공 행까지 지웠다.
 *     · `U65-8` 미검토 제보가 **즉시 전원에게** 노출됐다.
 *     · `U63-6` 「알레르기를 확인했고 없었다」를 적을 곳이 없었다 —
 *       행이 없는 것이 「안 봤다」인지 「없었다」인지 구분이 안 됐다.
 *   ⇒ 쓰기 경로에서 공식 테이블 접근을 걷어내고(계약 C6), **이 파일 하나**만 남긴다.
 *
 * ③ 계약 —
 *   · `applyApprovedContribution(client, reviewId, opts)`
 *   · `undoAppliedContribution(client, reviewId, opts)`
 *   · 순수 함수 `resolveBasis` · `computeConvertFactor` · `scaleNutrition` (DB 없이 단정된다)
 *   · 실패는 **조용히 하지 않는다.** 던지는 Error 에 `.code` 가 반드시 붙는다:
 *     `REVIEW_NOT_FOUND` · `REVIEW_NOT_APPROVED` · `ALREADY_APPLIED` · `UNSUPPORTED_AXIS`
 *     · `BASIS_UNKNOWN` · `CONVERT_BASIS_UNKNOWN` · `NOTHING_TO_APPLY`
 *     (+ `undo` 전용 `UNDO_EVIDENCE_MISSING` — §아래 「판단」 참조)
 *
 *   ★★ `DS-9` 「환산해서 무조건 통합」의 **전제**:
 *     기준(basis)을 모르거나 환산 근거(총량·1회 제공량)가 없으면 **승인을 거부한다.**
 *     「무조건 통합」의 반대말은 「통합 안 함」이지 **「추측해서 통합」이 아니다.**
 *     근거 없는 환산 오차는 **신호등 색으로 곧장 넘어간다**
 *     (`IP/basis_unknown_decision_2026-07-30.md` 가 여러 세션 싸운 바로 그 축).
 *     ⇒ 거부는 **거절이 아니라 «보류»다.** 관리자가 총량을 채우면 그때 승인된다.
 *
 *   ★★ `before`/`after` 를 «반드시» 기록한다.
 *     `product_entity_audit.before_json` 은 의도만 하고 **한 번도 안 쓰였다.**
 *     이번엔 실제로 쓴다 — 안 쓰면 `undo` 가 원리적으로 불가능하다.
 *
 * ④ 왜 «한 파일»인가 —
 *   승인 반영은 관리자 라우터(`adminRoutes`)·재처리 스크립트·향후 검토 UI 가 모두 부른다.
 *   같은 규칙을 여러 곳에 적으면 다음 수정 때 한쪽만 고친다 — 이 저장소가 4세션 연속 겪은 사고다.
 *   `additiveResolver.js` 가 같은 이유로 만들어졌고, 이 파일은 그 패턴을 그대로 따른다.
 *   그래서 첨가물 축은 SQL 을 새로 쓰지 않고 **`additiveResolver.upsertProductAdditives` 를 부른다.**
 *
 * ⑤ 이 파일이 «하지 않는» 것 —
 *   ⛔ `BEGIN`/`COMMIT`/`ROLLBACK` 을 부르지 않는다. `db.transaction` 이 전담한다.
 *   ⛔ `require('../config/database')` 를 하지 않는다. `client` 를 인자로 받는다
 *      (그래야 pglite shim 으로 실제 SQL 을 검증할 수 있다).
 *   ⛔ 승인/반려 «판정»을 하지 않는다. `status` 는 사람이 정하고 DB 제약
 *      (`cr_approve_human_chk`)이 자동 승인을 원천 차단한다.
 *   ⛔ `products` 행의 수명주기(`verification`·`verify_count`·`additive_detected_count`·
 *      제품 행 생성)를 건드리지 않는다. 계약 §7-C 가 `U66-1` 로 «보류»했다 —
 *      섞으면 회귀 범위가 폭발한다.
 *   ⛔ 뷰(`product_nutrition_resolved`)를 모른다. 환산은 **저장 전에** 끝나고
 *      뷰는 단순 `COALESCE` 만 한다(설계 §11-B-3).
 *   ⛔ 알레르겐을 «원재료명으로 판단하지 않는다». 제보에 실려 온 제조사 표기만 옮긴다(`DS-6′`).
 */

// ⚠ 아래 셋 다 **DB 를 require 하지 않는 순수 모듈**이다. 이 파일의 테스트 가능성이 거기 달려 있다.
//   · deriveBasis            — `nutrition_data.serving_size` 의 basis 마커 문자열을 읽는 «유일한 본문»
//   · normalizeAllergenNames — 알레르겐 19종 정본 사전의 «유일한 본문»(세션55)
//   · strongerLevel          — 등급 서열. 「내리지 않는다」의 JS 쪽 본문
const { deriveBasis } = require('./nutritionTrafficLight');
const { normalizeAllergenNames, strongerLevel } = require('./allergenName');
const {
  upsertProductAdditives, detectFromIngredientNames, countDetected,
} = require('./additiveResolver');

// ============================================================================
// 0. 상수 — 어휘는 정본(계약 §2~§5)에서 그대로 가져왔다
// ============================================================================

/** `data_inspection.axis` · `contribution_review.axis` 의 CHECK 어휘와 «같아야» 한다. */
const AXES = ['nutrition', 'ingredients', 'allergens', 'additives'];

/**
 * `nutrition_data_crowd` 의 영양 컬럼 15개.
 * ⚠ `nutrition_data` 와 **이름·타입이 같아야** 한다 — 뷰가 `COALESCE(nd.X, ndc.X)` 로 합친다.
 *   (그 동일성 자체는 스키마 대조 테스트가 단정한다 — 계약 C6-§3.)
 * ⚠ `crowdsourceService.STORED_NUTRIENT_KEYS`(10개)의 **상위집합**이다.
 *   제보 객체에 `added_sugars`·`calcium` 등이 실려 오면 그것도 같이 환산해서 옮긴다.
 */
const CROWD_NUTRIENT_KEYS = [
  'calories', 'total_fat', 'saturated_fat', 'trans_fat', 'cholesterol',
  'sodium', 'total_carbs', 'total_sugars', 'added_sugars', 'dietary_fiber',
  'protein', 'calcium', 'iron', 'vitamin_d', 'potassium',
];

/**
 * 제보가 쓸 수 있는 기준 어휘.
 * ★ `crowdsourceService` 의 `BASIS_OK` 와 **같은 목록**이다. 제보를 만든 쪽이 그 넷만 쓴다.
 *   여기에 없는 값(`'unknown'` 포함)은 **기준을 모르는 것**이고 `BASIS_UNKNOWN` 이다.
 */
const CONTRIBUTION_BASIS_OK = ['per_serving', 'per_100g', 'per_100ml', 'per_total'];

/**
 * `basis_stored` → `nutrition_data_crowd.serving_size` 에 적을 **basis 마커 문자열**.
 *
 * ⚠⚠ 이 컬럼에 «숫자»를 적으면 안 된다. `deriveBasis()` 가 이 문자열로 판정하고,
 *   `productModel.js` 의 `NUM_NUTRITION` 주석이 「숫자로 바꾸면 전 제품 basis 가 무너진다」고
 *   못 박아 둔 그 컬럼이다. per_serving 은 **마커가 없는 것**이 그 자체로 per_serving 이다
 *   (`deriveBasis(null) === 'per_serving'`).
 */
const BASIS_MARKER = {
  per_100g: '100g',
  per_100ml: '100ml',
  per_100_unknown: '100unknown',
  per_serving: null,
};

/** `product_allergens` 등급 서열 — `mergeService.js` 와 같은 값. */
const ALLERGEN_LEVEL_RANK = { may_contain: 1, inferred: 2, contains: 3 };
const ALLERGEN_LEVEL_DEFAULT = 'contains';

/**
 * `product_allergens.detected_via` 에 적는 값.
 * ⚠⚠ **`'crowdsource_merge'` 를 쓰면 안 된다.** `mergeService` 가 다음 병합에서
 *   `DELETE ... WHERE detected_via = 'crowdsource_merge'` 로 자기 행을 청소하는데,
 *   같은 값을 쓰면 **사람이 승인한 알레르겐이 병합 1회에 삭제된다**(경고 순감).
 */
const ALLERGEN_DETECTED_VIA = 'contribution_apply';

/**
 * `product_ingredients.source`.
 * ★ 기존 어휘(`'ocr_crowdsource'`)를 **그대로 쓴다.** 새 값을 만들면 `19·26-apply-haccp`
 *   계열 스크립트와 관리자 화면이 모르는 값을 보게 된다. 되돌리기는 새 어휘가 아니라
 *   **INSERT 가 돌려준 `id`** 로 한다(아래 `after.inserted_id`).
 */
const INGREDIENTS_SOURCE = 'ocr_crowdsource';

// ============================================================================
// 1. 순수 함수 — DB 없이 테스트된다
// ============================================================================

function fail(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
}

/** JSONB 컬럼은 드라이버에 따라 객체이거나 문자열이다. 둘 다 받는다. */
function asObject(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (_) { return null; }
  }
  return null;
}

/**
 * 숫자로 «확실히» 읽히는 것만 숫자로. 아니면 null.
 * ⚠ `Number(null) === 0` · `Number('') === 0` — 「데이터 없음」이 「0」이 되면 게이트가 헛돈다.
 *   (`crowdsourceService.js` 의 `serving_size` 주석과 같은 이유.)
 */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 중량/부피 단위를 `'g' | 'ml'` 로 정규화한다. 모르면 null.
 * ⛔ 모르는 단위를 g 로 «가정»하지 않는다 — 그것이 바로 이 파일이 막으려는 추정이다.
 */
function normUnit(u) {
  if (typeof u !== 'string') return null;
  const s = u.trim().toLowerCase().replace(/\s/g, '');
  if (s === 'g' || s === 'gram' || s === '그램' || s === 'ｇ') return 'g';
  if (s === 'ml' || s === 'mℓ' || s === '밀리리터' || s === 'cc') return 'ml';
  return null;
}

/**
 * 제보의 «원본 기준»을 정한다. 모르면 `basis: null` — **추정하지 않는다.**
 *
 * ★ `productRow` 는 **기준을 «도출»하는 데 쓰지 않는다.** 오직
 *   「이 제품에 공공 영양 행이 있는가 · 있다면 그 행의 기준은 무엇인가」를 함께 돌려주기 위해서다.
 *   그것이 계약 §6-5 의 «목표 기준» 규칙이고, 호출부가 아니라 여기서 계산해야
 *   DB 없이 단정할 수 있다.
 *
 * ⛔ `data.rejected_nutrition` 은 **보지 않는다.** 그것은 저장 게이트가 「쓸 수 없다」고
 *   판정해 관측용으로만 남긴 값이다(`crowdsourceService` 주석). 여기서 되살리면
 *   게이트가 막은 값이 승인 경로로 우회 입장한다.
 *
 * @param {Object} contributionData - `contributions.data` (JSONB)
 * @param {Object} [productRow] - `{ has_public_nutrition:boolean, public_serving_marker:string|null }`
 * @returns {{basis: string|null, evidence: Object}}
 */
function resolveBasis(contributionData, productRow) {
  const data = (contributionData && typeof contributionData === 'object') ? contributionData : {};
  const pn = (data.parsed_nutrition && typeof data.parsed_nutrition === 'object')
    ? data.parsed_nutrition : null;
  const nu = (data.nutrition && typeof data.nutrition === 'object') ? data.nutrition : null;

  // 우선순위 = 「제보를 만든 쪽이 실제로 쓰는 자리」 순서.
  const candidates = [
    ['data.parsed_nutrition._basis', pn && pn._basis],
    ['data.nutrition._basis', nu && nu._basis],
    ['data._basis', data._basis],
    ['data.basis', data.basis],
  ];

  const considered = [];
  let basis = null;
  let from = null;
  let raw = null;
  for (const [label, value] of candidates) {
    if (value === undefined || value === null || value === '') continue;
    considered.push({ from: label, value });
    if (basis === null && CONTRIBUTION_BASIS_OK.includes(value)) {
      basis = value;
      from = label;
      raw = value;
    } else if (raw === null) {
      raw = value;   // 어휘 밖의 값이 있었다는 사실 자체를 남긴다(관리자 화면이 읽는다)
    }
  }

  const hasPublic = !!(productRow && productRow.has_public_nutrition);
  const productBasis = hasPublic
    ? deriveBasis(productRow.public_serving_marker)   // ← 마커 문자열 → basis 의 «유일한 본문»
    : null;

  return {
    basis,
    evidence: {
      from,
      raw,
      considered,
      has_public_nutrition: hasPublic,
      product_basis: productBasis,
    },
  };
}

/**
 * 한 기준이 「몇 g / 몇 ml 를 가리키는가」. 모르면 null.
 * ★ 이 한 함수가 환산의 전부다 — 기준을 전부 «양(amount)»으로 바꿔 놓으면
 *   환산은 `to.amount / from.amount` 나눗셈 하나로 끝난다. 기준 조합마다
 *   따로 식을 적으면 조합이 늘 때마다 한 곳을 빠뜨린다.
 */
function basisAmount(basis, ctx = {}) {
  switch (basis) {
    case 'per_100g': return { amount: 100, unit: 'g', source: 'basis_definition' };
    case 'per_100ml': return { amount: 100, unit: 'ml', source: 'basis_definition' };
    case 'per_serving': {
      const a = num(ctx.servingSize);
      const u = normUnit(ctx.servingUnit) || normUnit(ctx.contentUnit);
      if (a === null || a <= 0 || !u) return null;
      return { amount: a, unit: u, source: ctx.servingSizeSource || 'serving_size' };
    }
    case 'per_total': {
      const a = num(ctx.totalContent);
      const u = normUnit(ctx.contentUnit);
      if (a === null || a <= 0 || !u) return null;
      return { amount: a, unit: u, source: ctx.totalContentSource || 'total_content' };
    }
    default: return null;
  }
}

/**
 * 환산 계수를 구한다. **`저장값 = 원본값 × factor`.**
 *
 * ★ 「나눗셈」이 아니라 **곱셈 계수**인 이유 — `convert_factor = 1.0` 이 「환산 안 함」이라고
 *   설계·마이그레이션 026 이 못 박았다(`1.0` 을 INSERT 한다). 곱셈이어야 1.0 이 항등원이다.
 *
 * ⛔ 근거가 없으면 **던진다.** 절대 추정하지 않는다.
 *   · 총량·1회 제공량을 모른다        → `CONVERT_BASIS_UNKNOWN`
 *   · 단위가 g ↔ ml 로 어긋난다      → `CONVERT_BASIS_UNKNOWN` (밀도를 모르면 환산 불가)
 *
 * @param {string} fromBasis
 * @param {string} toBasis
 * @param {Object} ctx - `{servingSize, servingUnit, totalContent, contentUnit, *Source}`
 * @returns {{factor:number, note:string}}
 */
function computeConvertFactor(fromBasis, toBasis, ctx = {}) {
  if (!fromBasis || !CONTRIBUTION_BASIS_OK.includes(fromBasis)) {
    throw fail('BASIS_UNKNOWN',
      `제보의 표기 기준을 알 수 없어 환산할 수 없습니다(basis=${JSON.stringify(fromBasis)}).`);
  }
  if (fromBasis === toBasis) {
    return { factor: 1, note: `기준이 같다(${fromBasis}) — 환산하지 않았다. convert_factor = 1.0` };
  }

  const from = basisAmount(fromBasis, ctx);
  const to = basisAmount(toBasis, ctx);
  if (!from || !to) {
    const missing = !from ? fromBasis : toBasis;
    throw fail('CONVERT_BASIS_UNKNOWN',
      `${fromBasis} → ${toBasis} 환산 근거가 없습니다. `
      + `'${missing}' 기준의 양(총 내용량 또는 1회 제공량 + 단위)을 알 수 없습니다. `
      + '관리자 화면에서 총 내용량·1회 제공량을 채워 넣으면 승인할 수 있습니다.',
      { fromBasis, toBasis, ctx: { ...ctx } });
  }
  if (from.unit !== to.unit) {
    throw fail('CONVERT_BASIS_UNKNOWN',
      `${from.unit} ↔ ${to.unit} 환산은 밀도를 모르면 불가능합니다(${fromBasis} → ${toBasis}). `
      + '추정해서 환산하지 않습니다.',
      { fromBasis, toBasis, fromUnit: from.unit, toUnit: to.unit });
  }

  const factor = to.amount / from.amount;
  if (!Number.isFinite(factor) || factor <= 0) {
    throw fail('CONVERT_BASIS_UNKNOWN',
      `환산 계수가 유효하지 않습니다(${from.amount} → ${to.amount}).`, { fromBasis, toBasis });
  }
  return {
    factor,
    note: `${fromBasis}(${from.amount}${from.unit}, 근거=${from.source}) → `
      + `${toBasis}(${to.amount}${to.unit}, 근거=${to.source}): 값 × ${factor}`,
  };
}

/**
 * 영양값을 환산한다. **입력을 바꾸지 않고 새 객체를 돌려준다.**
 *
 * ★ 돌려주는 객체에는 영양 컬럼 15개 중 **입력에 있던 키만** 담긴다.
 *   `_basis` 같은 메타는 «일부러» 버린다 — 환산한 뒤에도 옛 `_basis` 가 따라다니면
 *   그 객체를 나중에 읽는 사람이 반드시 틀린 기준으로 읽는다.
 *   `null` 값은 `null` 로 남긴다(「있는데 모름」과 「키 자체가 없음」은 다른 뜻이다).
 *
 * ⚠ factor === 1 이면 **반올림도 하지 않는다.** `scaleStoredNutrition` 의
 *   `if (!divisor || divisor <= 1) return nutrition;` 과 같은 이유다 —
 *   0.0001 같은 미세값이 반올림에 삼켜지면 안 된다.
 */
function scaleNutrition(nutritionObj, factor) {
  const f = num(factor);
  if (f === null || f <= 0) {
    throw fail('CONVERT_BASIS_UNKNOWN',
      `환산 계수가 유효하지 않습니다: ${JSON.stringify(factor)}. 추정값을 저장하지 않습니다.`);
  }
  const src = (nutritionObj && typeof nutritionObj === 'object') ? nutritionObj : {};
  const out = {};
  for (const k of CROWD_NUTRIENT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    const v = num(src[k]);
    if (v === null) { out[k] = null; continue; }
    out[k] = (f === 1) ? v : Math.round(v * f * 1000) / 1000;
  }
  return out;
}

// ============================================================================
// 2. 내부 헬퍼 (DB 를 «만지지 않는» 것들)
// ============================================================================

/** `contributions.data` 에서 영양 객체를 꺼낸다. */
function pickNutritionObject(data) {
  if (data && typeof data.parsed_nutrition === 'object' && data.parsed_nutrition) return data.parsed_nutrition;
  if (data && typeof data.nutrition === 'object' && data.nutrition) return data.nutrition;
  return null;
}

/** `parsed_ingredients` → 이름 배열. `crowdsourceService` 의 추출과 같은 모양. */
function pickIngredientNames(data) {
  const list = data && data.parsed_ingredients;
  if (!Array.isArray(list)) return null;   // ★ null = 「원재료를 안 봤다」, [] = 「봤는데 없었다」
  return list
    .map((i) => (typeof i === 'string' ? i : (i && i.name)))
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim());
}

/**
 * 알레르겐 이름을 19종 정본으로 바꾼다.
 * ★ 규칙 본문은 `allergenName.normalizeAllergenNames` 한 곳에 있다.
 * ⚠ 정규화에 «붙지 않는» 이름은 **버리지 않고 원문 그대로** 통과시킨다 —
 *   버리면 모르는 알레르겐이 사라진다(과소경고). `mergeService` 와 같은 판단이다.
 */
function canonicalAllergenNames(raw) {
  if (typeof raw !== 'string') return [];
  const v = raw.trim();
  if (!v) return [];
  let hits = [];
  try {
    hits = normalizeAllergenNames(v) || [];
  } catch (_) {
    return [v];
  }
  const names = hits.map((h) => h && h.name).filter(Boolean);
  return names.length ? [...new Set(names)] : [v];
}

/**
 * 제보 하나의 알레르겐을 `{이름 → 등급}` 으로 만든다.
 * @returns {{inspected:boolean, list:Array<{name,evidence_level}>}}
 *   `inspected=false` = **「알레르기를 안 봤다」**. 이때만 `NOTHING_TO_APPLY` 다.
 *   `inspected=true, list=[]` = ★ **「봤는데 0종이었다」** — `U63-6` 의 전부다.
 */
function buildAllergenList(data) {
  const v2raw = data && data.allergens_v2;
  const v2 = (v2raw && typeof v2raw === 'object' && !Array.isArray(v2raw)) ? v2raw : null;
  const flat = Array.isArray(data && data.allergens) ? data.allergens : null;
  if (!v2 && !flat) return { inspected: false, list: [] };

  const levels = new Map();
  const put = (name, level) => {
    for (const c of canonicalAllergenNames(name)) {
      levels.set(c, strongerLevel(levels.get(c), level));
    }
  };
  if (v2) {
    // ★ 넣는 순서는 `mergeService.levelsFromV2` 와 같다(약한 등급 먼저).
    //   `strongerLevel` 이 순서를 흡수하지만 순서 의존을 남기지 않는다.
    for (const n of (Array.isArray(v2.mayContain) ? v2.mayContain : [])) put(n, 'may_contain');
    for (const n of (Array.isArray(v2.inferred) ? v2.inferred : [])) put(n, 'inferred');
    for (const n of (Array.isArray(v2.contains) ? v2.contains : [])) put(n, 'contains');
  }
  if (flat) {
    // flat 에만 있고 v2 에 없는 이름은 기본 등급(contains)이다 — `mergeService` 와 같다.
    for (const n of flat) if (typeof n === 'string') put(n, ALLERGEN_LEVEL_DEFAULT);
  }

  const list = [...levels.entries()].map(([name, lv]) => ({
    name,
    evidence_level: ALLERGEN_LEVEL_RANK[lv] ? lv : ALLERGEN_LEVEL_DEFAULT,
  }));
  return { inspected: true, list };
}

/** 제보 메타 + 제품 행에서 환산 근거를 모은다. 어디서 온 값인지 함께 남긴다. */
function buildConvertCtx(data, productRow) {
  const ui = (data && typeof data.user_input === 'object' && data.user_input) ? data.user_input : {};
  const pn = pickNutritionObject(data) || {};
  const p = productRow || {};

  // ★ 공식 값(products)을 먼저 본다. 제보가 스스로 신고한 값보다 «검토된» 값이 우선이다.
  const pickNum = (pairs) => {
    for (const [source, value] of pairs) {
      const n = num(value);
      if (n !== null && n > 0) return { value: n, source };
    }
    return { value: null, source: null };
  };
  const pickUnit = (pairs) => {
    for (const [source, value] of pairs) {
      const u = normUnit(value);
      if (u) return { value: u, source };
    }
    return { value: null, source: null };
  };

  const serving = pickNum([
    ['products.serving_size', p.serving_size],
    ['contribution.user_input.serving_size', ui.serving_size],
    ['contribution.parsed_nutrition.serving_size', pn.serving_size],
  ]);
  const total = pickNum([
    ['products.total_content', p.total_content],
    ['contribution.user_input.total_content', ui.total_content],
    ['contribution.parsed_nutrition.total_content', pn.total_content],
  ]);
  const contentUnit = pickUnit([
    ['products.content_unit', p.content_unit],
    ['contribution.user_input.content_unit', ui.content_unit],
    ['contribution.parsed_nutrition.content_unit', pn.content_unit],
  ]);
  const servingUnit = pickUnit([
    ['products.serving_unit', p.serving_unit],
    ['products.content_unit', p.content_unit],
    ['contribution.user_input.content_unit', ui.content_unit],
  ]);

  return {
    servingSize: serving.value,
    servingSizeSource: serving.source,
    servingUnit: servingUnit.value,
    servingUnitSource: servingUnit.source,
    totalContent: total.value,
    totalContentSource: total.source,
    contentUnit: contentUnit.value,
    contentUnitSource: contentUnit.source,
  };
}

/** `avg_confidence`(0~1) → `ocr_confidence`(0~100). `crowdsourceService` 와 같은 변환. */
function ocrConfidenceOf(data) {
  const c = num(data && data.avg_confidence);
  if (c === null) return null;
  return Math.round(c * 100);
}

// ============================================================================
// 3. 축별 적용 — 순서: ② before 읽기 → ③ 쓰기 → ④ after 읽기
// ============================================================================

async function readCrowdNutritionRow(client, productId) {
  const r = await client.query(
    `SELECT * FROM nutrition_data_crowd WHERE product_id = $1`, [productId]);
  return r.rows.length ? r.rows[0] : null;
}

async function applyNutritionAxis(client, ctxArgs) {
  const { productId, review, data, appliedBy } = ctxArgs;

  const parsed = pickNutritionObject(data);
  if (!parsed) {
    throw fail('NOTHING_TO_APPLY',
      '이 제보에는 옮길 영양정보가 없습니다(parsed_nutrition 이 비어 있습니다).');
  }

  const prow = await client.query(
    `SELECT p.product_id,
            p.serving_size, p.serving_unit, p.total_content, p.content_unit,
            (nd.product_id IS NOT NULL) AS has_public_nutrition,
            nd.serving_size AS public_serving_marker
       FROM products p
       LEFT JOIN nutrition_data nd ON nd.product_id = p.product_id
      WHERE p.product_id = $1`,
    [productId]);
  if (prow.rows.length === 0) {
    throw fail('NOTHING_TO_APPLY', `product_id=${productId} 인 제품 행이 없습니다.`);
  }
  const productRow = prow.rows[0];

  // ── ★ DS-9 ①: 기준을 «모르면» 저장하지 않는다 ──
  const resolved = resolveBasis(data, productRow);
  if (!resolved.basis) {
    throw fail('BASIS_UNKNOWN',
      '제보의 영양성분 표기 기준(1회 제공량당 / 100g당 / 100mL당 / 총 내용량당)을 '
      + '알 수 없습니다. 기준을 모르는 값을 저장하면 통합 결과가 거짓말을 합니다.',
      { evidence: resolved.evidence });
  }

  // ── 목표 기준 (계약 §6-5) ──
  //   공공 영양 행이 있으면 그 기준에 맞춘다(통합 대상이므로). 없으면 제보 기준 그대로.
  let targetBasis = resolved.evidence.product_basis || resolved.basis;
  const targetNote = [];
  if (resolved.evidence.product_basis) {
    targetNote.push(`목표 기준은 공공 영양 행의 기준(${resolved.evidence.product_basis})이다`);
  } else {
    targetNote.push('공공 영양 행이 없어 제보 기준을 그대로 쓴다');
  }
  // ★★ `per_total` 은 **저장 기준이 될 수 없다.** `nutrition_data(_crowd).serving_size` 에는
  //   per_total 을 나타내는 마커가 없고, 마커가 없으면 `deriveBasis` 가 `per_serving` 으로 읽는다.
  //   총량을 1회분으로 읽으면 신호등이 거짓 색을 낸다 — `crowdsourceService` 가 저장 «전»에
  //   per_total 을 1회분으로 환산하는 것과 같은 이유다. 환산 못 하면 아래에서 던진다.
  if (targetBasis === 'per_total') {
    targetBasis = 'per_serving';
    targetNote.push('per_total 은 저장 형식이 표현하지 못하므로 1회 제공량 기준으로 환산한다');
  }

  // ── ★ DS-9 ②: 환산 «근거»가 없으면 저장하지 않는다 ──
  const convCtx = buildConvertCtx(data, productRow);
  const conv = computeConvertFactor(resolved.basis, targetBasis, convCtx);

  const scaled = scaleNutrition(parsed, conv.factor);
  const foundCount = CROWD_NUTRIENT_KEYS.reduce(
    (acc, k) => acc + (num(scaled[k]) !== null ? 1 : 0), 0);
  if (foundCount === 0) {
    throw fail('NOTHING_TO_APPLY',
      '이 제보에서 읽힌 영양성분 값이 0개입니다. 값이 없는 행을 만들지 않습니다.');
  }

  const before = await readCrowdNutritionRow(client, productId);

  const params = [
    productId,
    ...CROWD_NUTRIENT_KEYS.map((k) => (num(scaled[k]) === null ? null : num(scaled[k]))),
    BASIS_MARKER[targetBasis] !== undefined ? BASIS_MARKER[targetBasis] : null,
    ocrConfidenceOf(data),
    review.contribution_id,
    review.review_id,
    resolved.basis,
    targetBasis,
    conv.factor,
    `${targetNote.join(' / ')} / ${conv.note}`,
    appliedBy,
  ];
  await client.query(
    `INSERT INTO nutrition_data_crowd (
       product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol,
       sodium, total_carbs, total_sugars, added_sugars, dietary_fiber, protein,
       calcium, iron, vitamin_d, potassium,
       serving_size, ocr_confidence,
       contribution_id, review_id,
       basis_original, basis_stored, convert_factor, convert_note,
       applied_at, applied_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             $17,$18,$19,$20,$21,$22,$23,$24, now(), $25)
     ON CONFLICT (product_id) DO UPDATE SET
       calories = EXCLUDED.calories,
       total_fat = EXCLUDED.total_fat,
       saturated_fat = EXCLUDED.saturated_fat,
       trans_fat = EXCLUDED.trans_fat,
       cholesterol = EXCLUDED.cholesterol,
       sodium = EXCLUDED.sodium,
       total_carbs = EXCLUDED.total_carbs,
       total_sugars = EXCLUDED.total_sugars,
       added_sugars = EXCLUDED.added_sugars,
       dietary_fiber = EXCLUDED.dietary_fiber,
       protein = EXCLUDED.protein,
       calcium = EXCLUDED.calcium,
       iron = EXCLUDED.iron,
       vitamin_d = EXCLUDED.vitamin_d,
       potassium = EXCLUDED.potassium,
       serving_size = EXCLUDED.serving_size,
       ocr_confidence = EXCLUDED.ocr_confidence,
       contribution_id = EXCLUDED.contribution_id,
       review_id = EXCLUDED.review_id,
       basis_original = EXCLUDED.basis_original,
       basis_stored = EXCLUDED.basis_stored,
       convert_factor = EXCLUDED.convert_factor,
       convert_note = EXCLUDED.convert_note,
       applied_at = now(),
       applied_by = EXCLUDED.applied_by`,
    params);

  const after = await readCrowdNutritionRow(client, productId);

  return {
    before: { crowd_row: before },
    after: { crowd_row: after },
    convert: {
      basis_original: resolved.basis,
      basis_stored: targetBasis,
      factor: conv.factor,
      note: `${targetNote.join(' / ')} / ${conv.note}`,
    },
    counts: {
      nutrients_stored: foundCount,
      converted: conv.factor !== 1,
      had_public_nutrition: !!resolved.evidence.has_public_nutrition,
    },
    foundCount,
    scopeNote: 'nutrition_facts_table',
  };
}

async function readIngredientRows(client, productId) {
  const r = await client.query(
    `SELECT id, raw_text, source, parsed_ingredients
       FROM product_ingredients WHERE product_id = $1 ORDER BY id`, [productId]);
  return r.rows;
}

async function applyIngredientsAxis(client, ctxArgs) {
  const { productId, data } = ctxArgs;

  const names = pickIngredientNames(data);
  if (names === null) {
    throw fail('NOTHING_TO_APPLY',
      '이 제보에는 원재료가 없습니다(parsed_ingredients 자체가 없습니다).');
  }
  const ui = (data && typeof data.user_input === 'object' && data.user_input) ? data.user_input : {};
  // ⚠ `product_ingredients.raw_text` 는 **NOT NULL** 이다. 원문이 없으면 이름을 이어 붙인다 —
  //   빈 문자열을 넣으면 「원재료를 봤는데 아무것도 없었다」와 구분이 안 된다.
  const rawText = (typeof ui.ingredients_text === 'string' && ui.ingredients_text.trim())
    || (typeof data.ocr_raw_text === 'string' && data.ocr_raw_text.trim())
    || (names.length ? names.join(', ') : null);
  if (!rawText) {
    throw fail('NOTHING_TO_APPLY', '이 제보에는 옮길 원재료 원문이 없습니다.');
  }

  const before = await readIngredientRows(client, productId);

  // ⚠ `product_ingredients` 에는 UNIQUE 가 **없다.** 중복 적재를 막는 가드를 코드가 진다.
  const dup = before.find((r) => r.source === INGREDIENTS_SOURCE && r.raw_text === rawText);
  let insertedId = null;
  if (!dup) {
    const ins = await client.query(
      `INSERT INTO product_ingredients (product_id, raw_text, parsed_ingredients, source)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [productId, rawText, JSON.stringify(names), INGREDIENTS_SOURCE]);
    // ⚠ BIGSERIAL 은 드라이버에 따라 «문자열»로 온다. JSONB 에 넣기 전에 숫자로 고정한다 —
    //   문자열로 저장되면 되돌리기의 `WHERE id = $1` 이 조용히 안 걸릴 수 있다.
    insertedId = Number(ins.rows[0].id);
  }

  const after = await readIngredientRows(client, productId);

  return {
    before: { rows: before },
    after: { rows: after, inserted_id: insertedId, pre_existing_id: dup ? Number(dup.id) : null },
    convert: null,
    counts: { ingredients: names.length, inserted: insertedId === null ? 0 : 1 },
    foundCount: names.length,
    scopeNote: 'ingredients_text_only',
  };
}

async function readAllergenRows(client, productId) {
  const r = await client.query(
    `SELECT allergen_name, source_count, status, detected_via, evidence_level
       FROM product_allergens WHERE product_id = $1 ORDER BY allergen_name`, [productId]);
  return r.rows;
}

async function applyAllergensAxis(client, ctxArgs) {
  const { productId, data } = ctxArgs;

  const { inspected, list } = buildAllergenList(data);
  if (!inspected) {
    throw fail('NOTHING_TO_APPLY',
      '이 제보에는 알레르기 정보가 없습니다(알레르기 항목 자체를 확인하지 않았습니다).');
  }

  const before = await readAllergenRows(client, productId);

  for (const a of list) {
    await client.query(
      // ★★ `evidence_level` 승격 CASE 는 `mergeService.js` 의 것을 **그대로** 옮겼다.
      //   등급은 **올리기만 한다.** 그대로 대입하면 이번 제보가 혼입만 읽었을 때
      //   기존 「직접 함유」 행이 「혼입 가능」으로 **강등**된다 — 경고를 지우는 방향이다.
      // ★ `status` 도 함께 지킨다. `admin_verified` 를 깎으면 관리자 검증이 사라진다.
      // ⚠ `source_count` 는 `mergeService` 와 달리 **GREATEST** 다. 승인 1건(=1)이
      //   기기 3대가 만든 3 을 덮으면 관측이 내려간다. 「내리지 않는다」가 이 저장소의 방향이다.
      // ⚠ `detected_via` 는 갱신하지 않는다(NULL 세탁 방지 — mergeService 와 같은 판단).
      `INSERT INTO product_allergens
         (product_id, allergen_name, source_count, status, detected_via, evidence_level)
       VALUES ($1, $2, 1, 'confirmed', $3, $4)
       ON CONFLICT (product_id, allergen_name) DO UPDATE SET
         source_count = GREATEST(COALESCE(product_allergens.source_count, 0), EXCLUDED.source_count),
         status = CASE
           WHEN product_allergens.status = 'admin_verified' THEN 'admin_verified'
           ELSE EXCLUDED.status
         END,
         evidence_level = CASE
           WHEN COALESCE(product_allergens.evidence_level, 'contains') = 'contains' THEN 'contains'
           WHEN EXCLUDED.evidence_level = 'contains' THEN 'contains'
           WHEN COALESCE(product_allergens.evidence_level, 'contains') = 'inferred'
             OR EXCLUDED.evidence_level = 'inferred' THEN 'inferred'
           ELSE 'may_contain'
         END,
         updated_at = NOW()`,
      [productId, a.name, ALLERGEN_DETECTED_VIA, a.evidence_level]);
  }

  const after = await readAllergenRows(client, productId);

  return {
    before: { rows: before },
    after: { rows: after, applied_names: list.map((a) => a.name) },
    convert: null,
    // ★★ `found_count = 0` 이 **「봤는데 없었다」**다. 행이 «없는» 것이 「안 봤다」다.
    //   `U63-6`(알레르기 「확인했고 없음」 상태 부재)의 전부가 이 한 줄이다.
    counts: { allergens: list.length },
    foundCount: list.length,
    scopeNote: 'ocr_label_contribution',
  };
}

async function readAdditiveIds(client, productId) {
  const r = await client.query(
    `SELECT additive_id FROM product_additives WHERE product_id = $1 ORDER BY additive_id`,
    [productId]);
  return r.rows.map((x) => Number(x.additive_id));
}

async function applyAdditivesAxis(client, ctxArgs) {
  const { productId, data } = ctxArgs;

  const names = pickIngredientNames(data);
  const explicit = Array.isArray(data && data.additives) ? data.additives : null;
  if (names === null && explicit === null) {
    throw fail('NOTHING_TO_APPLY',
      '이 제보에는 첨가물을 검출할 원재료가 없습니다(원재료 항목 자체를 확인하지 않았습니다).');
  }

  // ⚠ `contributions.data` 에는 `analysis.additives` 가 «저장되지 않는다»
  //   (`additiveResolver.js` 헤더가 그 비대칭을 명시했다). 그래서 이름으로 다시 검출한다.
  //   ★ 검출 규칙은 새로 쓰지 않는다 — `additiveResolver` 의 함수를 그대로 부른다.
  const detected = explicit || detectFromIngredientNames(names || []);
  const detectedTotal = countDetected(detected);

  const before = await readAdditiveIds(client, productId);
  const res = await upsertProductAdditives(client, productId, {
    detectedAdditives: detected,
    ingredientNames: names || [],
    confidence: ocrConfidenceOf(data),
  });
  const after = await readAdditiveIds(client, productId);

  const beforeSet = new Set(before);
  const insertedIds = after.filter((id) => !beforeSet.has(id));

  return {
    before: { additive_ids: before },
    after: { additive_ids: after, inserted_ids: insertedIds },
    convert: null,
    counts: {
      detected_total: detectedTotal,
      candidates: res.candidates,
      matched: res.matched,
      inserted: insertedIds.length,
    },
    // ★ `products.additive_detected_count` 와 «같은 축»의 수(마스터 조인 «전»)를 쓴다.
    //   0 = 「검출해 봤고 하나도 없었다」.
    foundCount: detectedTotal === null ? 0 : detectedTotal,
    scopeNote: 'ingredients_text_only',
  };
}

const AXIS_HANDLERS = {
  nutrition: applyNutritionAxis,
  ingredients: applyIngredientsAxis,
  allergens: applyAllergensAxis,
  additives: applyAdditivesAxis,
};

// ============================================================================
// 4. 공개 API
// ============================================================================

/**
 * 승인된 제보 1건(한 축)을 공식 데이터셋으로 옮긴다.
 *
 * ⚠ 이 함수는 **트랜잭션 안에서** 불려야 한다(`db.transaction`). 여기서 BEGIN 하지 않는다.
 *
 * @param {{query: Function}} client
 * @param {number} reviewId
 * @param {{ appliedBy?: string, sourceKind?: string, scopeNote?: string }} [opts]
 * @returns {Promise<{
 *   applied: boolean, axis: string, productId: number,
 *   before: object|null, after: object|null,
 *   convert: {basis_original: string|null, basis_stored: string, factor: number, note: string}|null,
 *   counts: object
 * }>}
 */
async function applyApprovedContribution(client, reviewId, opts = {}) {
  const appliedBy = opts.appliedBy ?? null;

  // ── ① 잠그고 상태를 검사한다 ──
  //   `FOR UPDATE` 가 없으면 관리자 두 명이 동시에 「승인 반영」을 누를 때 둘 다
  //   `applied_at IS NULL` 을 읽고 둘 다 적용한다.
  const rv = await client.query(
    `SELECT review_id, contribution_id, product_id, axis, status, applied_at, evidence
       FROM contribution_review
      WHERE review_id = $1
      FOR UPDATE`,
    [reviewId]);
  if (rv.rows.length === 0) {
    throw fail('REVIEW_NOT_FOUND', `contribution_review(review_id=${reviewId}) 가 없습니다.`);
  }
  const review = rv.rows[0];

  if (review.status !== 'approved') {
    // ★ 승인되지 않은 것을 옮기지 않는다. `DS-1`(전량 수동)의 코드 쪽 방어선이다
    //   (DB 쪽 방어선은 `cr_approve_human_chk`).
    throw fail('REVIEW_NOT_APPROVED',
      `승인되지 않은 제보는 반영할 수 없습니다(status=${review.status}).`,
      { status: review.status });
  }
  if (review.applied_at !== null && review.applied_at !== undefined) {
    // ★ 멱등 방어. 두 번 옮기면 원재료가 두 줄이 되고 첨가물 `detected_name` 이 뒤섞인다.
    throw fail('ALREADY_APPLIED',
      `이미 반영된 제보입니다(applied_at=${review.applied_at}).`,
      { appliedAt: review.applied_at });
  }
  if (!AXES.includes(review.axis)) {
    throw fail('UNSUPPORTED_AXIS', `알 수 없는 축입니다: ${review.axis}`, { axis: review.axis });
  }
  const productId = review.product_id === null || review.product_id === undefined
    ? null : Number(review.product_id);
  if (productId === null || !Number.isFinite(productId)) {
    // 스키마상 `product_id` 는 NULL 을 허용한다(바코드 미등록 제보). 옮길 대상이 없다.
    throw fail('NOTHING_TO_APPLY',
      '이 제보에는 연결된 제품이 없습니다(product_id 가 NULL). 제품을 먼저 지정해 주세요.');
  }

  const cr = await client.query(
    `SELECT contribution_id, data FROM contributions WHERE contribution_id = $1`,
    [review.contribution_id]);
  if (cr.rows.length === 0) {
    throw fail('NOTHING_TO_APPLY',
      `원본 제보(contribution_id=${review.contribution_id})가 없습니다.`);
  }
  const data = asObject(cr.rows[0].data) || {};

  // ── ②③④ 축별 적용 (before 읽기 → 쓰기 → after 읽기) ──
  const handler = AXIS_HANDLERS[review.axis];
  const out = await handler(client, {
    productId,
    review: { review_id: Number(review.review_id), contribution_id: Number(review.contribution_id) },
    data,
    appliedBy,
  });

  // ── ⑤ 검사 기록 1행 ──
  //   ★ 행이 «없는» 것이 「안 봤다」이므로, 여기까지 온 이상 **반드시** 1행을 남긴다.
  await client.query(
    `INSERT INTO data_inspection
       (product_id, axis, source_kind, evidence_ref, found_count, scope_note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      productId,
      review.axis,
      opts.sourceKind || 'ocr_label',
      String(review.contribution_id),
      out.foundCount,
      opts.scopeNote || out.scopeNote || null,
    ]);

  // ── ⑥ 적용 도장 + before/after/convert 기록 ──
  //   ⚠ `evidence` 를 **덮어쓰지 않는다.** `mergeService` 가 실은 병합 판정(median 등)이
  //     같은 컬럼에 있다. `||` 로 병합해야 그것이 살아남는다.
  await client.query(
    `UPDATE contribution_review
        SET applied_at = now(),
            evidence = COALESCE(evidence, '{}'::jsonb) || jsonb_build_object(
              'before', $2::jsonb,
              'after',  $3::jsonb,
              'convert', $4::jsonb,
              'counts', $5::jsonb,
              'applied_by', $6::text)
      WHERE review_id = $1`,
    [
      reviewId,
      JSON.stringify(out.before ?? null),
      JSON.stringify(out.after ?? null),
      JSON.stringify(out.convert ?? null),
      JSON.stringify(out.counts ?? {}),
      appliedBy,
    ]);

  return {
    applied: true,
    axis: review.axis,
    productId,
    before: out.before ?? null,
    after: out.after ?? null,
    convert: out.convert ?? null,
    counts: out.counts ?? {},
  };
}

// ── 축별 되돌리기 ────────────────────────────────────────────────────────────

async function undoNutritionAxis(client, { productId, reviewId, before }) {
  const row = before && before.crowd_row ? before.crowd_row : null;
  if (!row) {
    // 적용 전에 행이 «없었다» → 우리가 만든 행이다. 우리 review_id 인 것만 지운다.
    const r = await client.query(
      `DELETE FROM nutrition_data_crowd WHERE product_id = $1 AND review_id = $2`,
      [productId, reviewId]);
    return { deleted: (r && r.rowCount) || 0, restored: null };
  }
  // 적용 전에 «다른» 제보의 행이 있었다 → 그 행을 통째로 되돌린다.
  const params = [
    productId,
    ...CROWD_NUTRIENT_KEYS.map((k) => (row[k] === undefined ? null : row[k])),
    row.serving_size ?? null,
    row.ocr_confidence ?? null,
    row.contribution_id ?? null,
    row.review_id ?? null,
    row.basis_original ?? null,
    row.basis_stored ?? null,
    row.convert_factor ?? null,
    row.convert_note ?? null,
    row.applied_by ?? null,
    row.verified_at ?? null,
  ];
  await client.query(
    `UPDATE nutrition_data_crowd SET
       calories = $2, total_fat = $3, saturated_fat = $4, trans_fat = $5, cholesterol = $6,
       sodium = $7, total_carbs = $8, total_sugars = $9, added_sugars = $10,
       dietary_fiber = $11, protein = $12, calcium = $13, iron = $14, vitamin_d = $15,
       potassium = $16, serving_size = $17, ocr_confidence = $18,
       contribution_id = $19, review_id = $20,
       basis_original = $21, basis_stored = $22, convert_factor = $23, convert_note = $24,
       applied_by = $25, verified_at = $26
     WHERE product_id = $1`,
    params);
  return { deleted: 0, restored: row };
}

async function undoIngredientsAxis(client, { after }) {
  const id = after && after.inserted_id;
  if (id === null || id === undefined) return { deleted: 0, restored: null };
  // ★ **그 제보가 넣은 «그 행»만** 지운다. `product_id` 로 싹 지우면 식약처(C002·HACCP)
  //   원재료까지 사라진다.
  const r = await client.query(`DELETE FROM product_ingredients WHERE id = $1`, [id]);
  return { deleted: (r && r.rowCount) || 0, restored: null };
}

async function undoAllergensAxis(client, { productId, before, after }) {
  const beforeRows = (before && Array.isArray(before.rows)) ? before.rows : [];
  const appliedNames = (after && Array.isArray(after.applied_names)) ? after.applied_names : [];
  const beforeByName = new Map(beforeRows.map((r) => [r.allergen_name, r]));

  let deleted = 0;
  const restored = [];
  for (const name of appliedNames) {
    const prev = beforeByName.get(name);
    if (prev) {
      // 적용 «전»에도 있던 이름 → 우리가 올린 등급·개수를 원래대로 내린다.
      //   ⚠ 이것은 「등급을 내리는 것」이 아니라 **우리가 올린 것을 취소하는 것**이다.
      await client.query(
        `UPDATE product_allergens
            SET source_count = $3, status = $4, detected_via = $5, evidence_level = $6,
                updated_at = NOW()
          WHERE product_id = $1 AND allergen_name = $2`,
        [productId, name, prev.source_count, prev.status, prev.detected_via, prev.evidence_level]);
      restored.push(name);
      continue;
    }
    // 적용 «전»에는 없던 이름 → 우리가 넣은 행이다. **우리 detected_via 인 것만** 지운다.
    //   그 사이에 다른 출처가 같은 이름을 덮었다면 건드리지 않는다.
    const r = await client.query(
      `DELETE FROM product_allergens
        WHERE product_id = $1 AND allergen_name = $2 AND detected_via = $3`,
      [productId, name, ALLERGEN_DETECTED_VIA]);
    deleted += (r && r.rowCount) || 0;
  }
  return { deleted, restored };
}

async function undoAdditivesAxis(client, { productId, after }) {
  const ids = (after && Array.isArray(after.inserted_ids)) ? after.inserted_ids : [];
  if (ids.length === 0) return { deleted: 0, restored: null };
  // ★ **이 제보가 «새로» 넣은 첨가물만** 지운다. 이미 있던 행은 건드리지 않는다.
  const r = await client.query(
    `DELETE FROM product_additives
      WHERE product_id = $1 AND additive_id = ANY($2::bigint[])`,
    [productId, ids]);
  return { deleted: (r && r.rowCount) || 0, restored: null };
}

/**
 * 승인 취소 — 그 제보가 넣은 것«만» 되돌린다. (`DS-4`)
 *
 * ★ 되돌릴 수 있는 이유는 `applyApprovedContribution` 이 `before`/`after` 를
 *   `contribution_review.evidence` 에 박아 뒀기 때문이다. 그것이 없으면 원리적으로 불가능하다.
 *
 * ⚠ `status` 전이(`'undone'`)는 **여기서 하지 않는다.** 호출부(`adminRoutes`)의 소관이다 —
 *   `reopen` 도 같은 컬럼을 쓰므로 전이 규칙을 한 곳에 모은다.
 *
 * @param {{query: Function}} client
 * @param {number} reviewId
 * @param {{ undoneBy?: string }} [opts]
 * @returns {Promise<{undone: boolean, axis: string, productId: number, restored: object|null}>}
 */
async function undoAppliedContribution(client, reviewId, opts = {}) {
  const rv = await client.query(
    `SELECT review_id, contribution_id, product_id, axis, status, applied_at, evidence
       FROM contribution_review
      WHERE review_id = $1
      FOR UPDATE`,
    [reviewId]);
  if (rv.rows.length === 0) {
    throw fail('REVIEW_NOT_FOUND', `contribution_review(review_id=${reviewId}) 가 없습니다.`);
  }
  const review = rv.rows[0];
  const productId = review.product_id === null || review.product_id === undefined
    ? null : Number(review.product_id);

  if (review.applied_at === null || review.applied_at === undefined) {
    // 아직 반영된 적이 없다 — 되돌릴 것이 없다. 예외가 아니라 사실이다.
    return { undone: false, axis: review.axis, productId, restored: null, reason: 'NOT_APPLIED' };
  }

  const evidence = asObject(review.evidence) || {};
  if (!Object.prototype.hasOwnProperty.call(evidence, 'before')
      && !Object.prototype.hasOwnProperty.call(evidence, 'after')) {
    // ⛔ 조용히 「되돌렸다」고 말하지 않는다. 무엇을 넣었는지 모르면 되돌릴 수 없다.
    throw fail('UNDO_EVIDENCE_MISSING',
      `되돌리기 근거(before/after)가 없습니다(review_id=${reviewId}). `
      + '이 행은 이 서비스가 아닌 다른 경로로 반영된 것으로 보입니다.');
  }
  const before = evidence.before ?? null;
  const after = evidence.after ?? null;

  let result;
  switch (review.axis) {
    case 'nutrition':
      result = await undoNutritionAxis(client, { productId, reviewId: Number(review.review_id), before });
      break;
    case 'ingredients':
      result = await undoIngredientsAxis(client, { productId, after });
      break;
    case 'allergens':
      result = await undoAllergensAxis(client, { productId, before, after });
      break;
    case 'additives':
      result = await undoAdditivesAxis(client, { productId, after });
      break;
    default:
      throw fail('UNSUPPORTED_AXIS', `알 수 없는 축입니다: ${review.axis}`, { axis: review.axis });
  }

  await client.query(
    `UPDATE contribution_review
        SET applied_at = NULL,
            evidence = COALESCE(evidence, '{}'::jsonb) || jsonb_build_object(
              'undo', $2::jsonb,
              'undone_by', $3::text,
              'undone_at', to_jsonb(now()))
      WHERE review_id = $1`,
    [reviewId, JSON.stringify(result), opts.undoneBy ?? null]);

  return {
    undone: true,
    axis: review.axis,
    productId,
    restored: result.restored ?? null,
    deleted: result.deleted ?? 0,
  };
}

module.exports = {
  // 공개 API
  applyApprovedContribution,
  undoAppliedContribution,
  // 순수 함수 (테스트가 DB 없이 단정한다 — 계약 §6-2)
  resolveBasis,
  computeConvertFactor,
  scaleNutrition,
  // 어휘·헬퍼 (테스트·관리자 화면이 읽는다)
  AXES,
  CROWD_NUTRIENT_KEYS,
  CONTRIBUTION_BASIS_OK,
  BASIS_MARKER,
  ALLERGEN_DETECTED_VIA,
  INGREDIENTS_SOURCE,
  basisAmount,
  buildAllergenList,
  buildConvertCtx,
};
