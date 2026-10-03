/**
 * portionService.js — 가공식품 «먹은 양» × 영양 계산 (2026-10-03 · 영양공식 웹앱트랙 요청)
 * ============================================================================
 * 목적: 뉴트리렌즈(영양공식) 식사 기록에 가공식품을 «먹은 양»과 함께 남긴다.
 *   설계  영양공식 IP/integration/meal_product_log_design_v1.md
 *   평가  같은 폴더 meal_product_log_eval_v1.md (C01~C15) → tests/test_portion.js
 *
 * ★ 계산은 여기 한 곳. 웹·Edge 는 이 결과를 «저장만» 한다(영양공식 웹앱트랙 규칙1).
 * ★ 저장 영양의 기준(basis)은 `deriveBasis(nutrition_serving_size)` 마커로만 판정한다(nutritionTrafficLight.js).
 *     per_100g / per_100ml / per_100_unknown → 값은 100 당
 *     per_serving                           → 값은 라벨 1회 제공량 당
 * ★ 인분 수를 추정하지 않는다(servingResolver.js 머리말 — 골든카레 12인분 사고).
 *     필요한 값(총 내용량·1회 제공량)이 없으면 그 단위는 «불가 + 이유». 숫자를 지어내지 않는다.
 */
'use strict';

const { deriveBasis } = require('./nutritionTrafficLight');

const KINDS = ['pack', 'serving', 'gram'];
const LIMITS = { pack: 20, serving: 20, gram: 5000 };
const MAX_FACTOR = 50;

/** 응답에 싣는 영양 키(저장 컬럼명 → 응답 키). null 은 null 그대로 둔다(0 으로 바꾸지 않는다). */
const NUTRIENTS = [
  ['calories', 'calories_kcal'],
  ['total_carbs', 'carbs_g'],
  ['protein', 'protein_g'],
  ['total_fat', 'fat_g'],
  ['sodium', 'sodium_mg'],
  ['total_sugars', 'sugar_g'],
  ['dietary_fiber', 'fiber_g'],
  ['saturated_fat', 'sat_fat_g'],
];

function pos(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}
function r1(v) { return Math.round(v * 10) / 10; }

function unitOf(product, basis) {
  const u = String(product?.content_unit || '').trim().toLowerCase();
  if (u === 'ml' || u === 'l') return 'ml';
  if (u === 'g' || u === 'kg') return 'g';
  if (basis === 'per_100ml') return 'ml';
  return 'g';
}

function hasNutrition(nutrition) {
  if (!nutrition) return false;
  return NUTRIENTS.some(([k]) => nutrition[k] !== null && nutrition[k] !== undefined);
}

function fracLabel(q) {
  const map = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
  return map[q] || String(r1(q));
}

/**
 * 단위별 가능 여부와 계수.
 * @returns {{ ok: true, factor: number, grams: number|null } | { ok: false, reason: string }}
 */
function resolve(product, basis, kind, qty) {
  const total = pos(product?.total_content);
  const serving = pos(product?.serving_size);
  const spcRaw = pos(product?.servings_per_container);
  if (basis === 'per_serving') {
    if (kind === 'serving') return { ok: true, factor: qty, grams: serving ? qty * serving : null };
    if (kind === 'pack') {
      const spc = spcRaw || (total && serving ? total / serving : null);
      if (!spc) return { ok: false, reason: 'need_serving_info' };
      return { ok: true, factor: qty * spc, grams: total ? qty * total : (serving ? qty * spc * serving : null) };
    }
    // gram
    if (!serving) return { ok: false, reason: 'need_serving_info' };
    return { ok: true, factor: qty / serving, grams: qty };
  }
  // per_100*
  let g = null;
  if (kind === 'gram') g = qty;
  else if (kind === 'pack') { if (!total) return { ok: false, reason: 'need_total_content' }; g = qty * total; }
  else { if (!serving) return { ok: false, reason: 'need_serving_info' }; g = qty * serving; }
  return { ok: true, factor: g / 100, grams: g };
}

function label(kind, qty, grams, unit) {
  const amt = grams != null ? `(${r1(grams)}${unit})` : '';
  if (kind === 'pack') return `${fracLabel(qty)}개${amt}`;
  if (kind === 'serving') return `1회 제공량${qty === 1 ? '' : ` ×${fracLabel(qty)}`}${amt}`;
  return `${r1(qty)}${unit}`;
}

/**
 * @param {object} product   { serving_size, total_content, content_unit, servings_per_container }
 * @param {object|null} nutrition 저장 영양(calories…) + nutrition_serving_size(마커 문자열) 또는 basis
 * @param {{kind:string, qty:number}} amount
 */
function computePortion(product, nutrition, amount) {
  if (!hasNutrition(nutrition)) return { ok: false, reason: 'no_nutrition' };
  const basis = nutrition.basis || deriveBasis(nutrition.nutrition_serving_size);
  const kind = amount?.kind;
  const qty = typeof amount?.qty === 'string' ? Number(amount.qty) : amount?.qty;
  if (!KINDS.includes(kind)) return { ok: false, reason: 'invalid_kind' };
  if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0 || qty > LIMITS[kind]) return { ok: false, reason: 'invalid_qty' };
  const res = resolve(product, basis, kind, qty);
  if (!res.ok) return { ok: false, reason: res.reason };
  if (!(res.factor > 0) || res.factor > MAX_FACTOR) return { ok: false, reason: 'invalid_qty' };
  const unit = unitOf(product, basis);
  const out = {};
  for (const [k, key] of NUTRIENTS) {
    const v = nutrition[k];
    const n = typeof v === 'string' ? Number(v) : v;
    out[key] = typeof n === 'number' && Number.isFinite(n) ? r1(n * res.factor) : null;
  }
  const approx = basis === 'per_100_unknown'
    || (basis === 'per_100g' && unit === 'ml')
    || (basis === 'per_100ml' && unit === 'g');
  return {
    ok: true,
    basis,
    kind,
    qty,
    factor: Math.round(res.factor * 10000) / 10000,
    grams: res.grams != null ? r1(res.grams) : null,
    unit,
    approx,
    label: label(kind, qty, res.grams, unit),
    nutrients: out,
  };
}

/** 화면 칩용 — 단위별 가능 여부(qty 1 기준). */
function portionOptions(product, nutrition) {
  if (!hasNutrition(nutrition)) return KINDS.map((kind) => ({ kind, available: false, reason: 'no_nutrition' }));
  const basis = nutrition.basis || deriveBasis(nutrition.nutrition_serving_size);
  return KINDS.map((kind) => {
    const r = resolve(product, basis, kind, kind === 'gram' ? 100 : 1);
    return r.ok ? { kind, available: true } : { kind, available: false, reason: r.reason };
  });
}

module.exports = { computePortion, portionOptions, KINDS, LIMITS, MAX_FACTOR, _resolve: resolve };
