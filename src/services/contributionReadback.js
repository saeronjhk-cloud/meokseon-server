/**
 * ★ 세션75d — 「내가 보낸 제보」 상세: 사용자가 «자기가 보낸 것»을 다시 보는 응답을 만든다(순수 함수).
 *
 * 왜 (제이 실물 2026-10-04): 제보는 세션66 C6 이후 «승인 전까지 제품에 반영되지 않는다».
 *   목록 카드를 누르면 제품 화면으로 가는데, 거기엔 아직 아무것도 없다 → «카드는 있는데 내용이 안 보인다».
 *   ⇒ 제품 화면이 아니라 «제보 그 자체»를 돌려준다. 승인 여부와 무관하게 사용자가 보낸 내용이다.
 *
 * ★★ 화이트리스트만 담는다 — `contributions.data` 를 통째로 넘기지 않는다(목록 엔드포인트와 같은 원칙).
 *   담지 않는 것: ocr_raw_text(원문 전체) · device_id · corrections · sanity_warnings · rejected_nutrition ·
 *   user_input.manufacturer/brand(주소 잔해가 섞여 있다 — U73-3) · 사진.
 * ★ 값을 «고치지» 않는다 — 읽힌 그대로다. 숫자가 아닌 영양값은 버린다(0 은 남긴다).
 */
'use strict';

const NUT_KEYS = ['calories', 'protein', 'total_fat', 'saturated_fat', 'trans_fat',
  'cholesterol', 'sodium', 'total_carbs', 'total_sugars', 'dietary_fiber'];
const BASIS_OK = new Set(['per_serving', 'per_100g', 'per_100ml', 'per_total', 'unknown']);
const MAX_LIST = 200;

const str = (v, max = 2000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const names = (arr) => (Array.isArray(arr)
  ? [...new Set(arr.map((x) => (typeof x === 'string' ? x : (x && typeof x.name === 'string' ? x.name : null)))
    .filter((s) => s && s.trim()).map((s) => s.trim()))].slice(0, MAX_LIST)
  : null);

function buildReadback(data) {
  const d = data && typeof data === 'object' ? data : {};
  const ui = d.user_input && typeof d.user_input === 'object' ? d.user_input : {};

  let nutrition = null;
  const pn = d.parsed_nutrition;
  if (pn && typeof pn === 'object') {
    const values = {};
    for (const k of NUT_KEYS) { const n = num(pn[k]); if (n !== null) values[k] = n; }
    if (Object.keys(values).length) {
      const b = typeof pn._basis === 'string' && BASIS_OK.has(pn._basis) ? pn._basis : 'unknown';
      nutrition = { basis: b, basis_amount: num(pn._basis_amount), values };
    }
  }

  const v2 = d.allergens_v2 && typeof d.allergens_v2 === 'object' ? d.allergens_v2 : null;
  const allergens = v2
    ? { contains: names(v2.contains) || [], inferred: names(v2.inferred) || [], may_contain: names(v2.mayContain) || [] }
    : null;

  return {
    product_name: str(ui.product_name, 200),
    food_type: str(ui.food_type, 100),
    total_content: num(ui.total_content) ?? (typeof ui.total_content === 'string' && /^\d+(\.\d+)?$/.test(ui.total_content.trim()) ? Number(ui.total_content) : null),
    content_unit: str(ui.content_unit, 10),
    ingredients_text: str(ui.ingredients_text, 4000),
    ingredients: names(d.parsed_ingredients),
    allergens,
    additives: names(d.additives),
    nutrition,
    nutrition_status: str(d.nutrition_status, 20),
  };
}

module.exports = { buildReadback, NUT_KEYS };
