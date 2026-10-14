/**
 * label_basis.js — ★ 세션79 «포장지에 있는 그대로» 영양 기준(제이 2026-10-14 23:05).
 *   저장 정본은 100g/100ml(엔진 공통 · 신호등·먹은 양 계산) 그대로 두고, 라벨의 원래 기준과 «인쇄된 숫자»를 곁에 둔다.
 *   정답: IP/eval_label_basis_v1/cases_v1.json = tests/fixtures/label_basis_v1.json
 */
'use strict';
const KEYS = ['calories', 'total_fat', 'saturated_fat', 'trans_fat', 'cholesterol', 'sodium', 'total_carbs', 'total_sugars', 'dietary_fiber', 'protein'];

/** parseNutrition 결과 → {basis, amount, unit, values} | null (기준·양을 모르면 null — 지어내지 않는다) */
function labelFromParsed(n, text) {
  if (!n) return null;
  // 파서가 «1봉지당(115g)»(양이 «당» 뒤 괄호)을 못 읽는다(_basis unknown · 남자라면 F12 실측) → 원문에서 이 꼴만 보충. 런타임 파서는 건드리지 않는다(후속 과제).
  if ((!n._basis || n._basis === 'unknown') && text) {
    const m = String(text).match(/\d*\s*(?:봉지|봉|팩|개|컵|병|용기|캔|포|회|인분|조각|입)\s*당\s*\(\s*([\d.]+)\s*(g|ml|mL|㎖)\s*\)/);
    if (m) n = { ...n, _basis: 'per_serving', _basis_amount: Number(m[1]), serving_unit: m[2] };
  }
  if (!n._basis) return null;
  let amount = null; let unit = null;
  if (n._basis === 'per_100g') { amount = 100; unit = 'g'; }
  else if (n._basis === 'per_100ml') { amount = 100; unit = 'ml'; }
  else if (n._basis === 'per_serving') { amount = n._basis_amount || n.serving_size || null; unit = n.serving_unit || null; }
  else if (n._basis === 'per_total') { amount = n.total_content || null; unit = n.content_unit || null; }
  unit = unit ? String(unit).toLowerCase().replace('㎖', 'ml') : null;
  if (!(amount > 0) || !['g', 'ml'].includes(unit)) return null;
  const values = {};
  for (const k of KEYS) if (typeof n[k] === 'number' && Number.isFinite(n[k])) values[k] = n[k];
  if (!Object.keys(values).length) return null;
  return { basis: n._basis, amount, unit, values };
}

/** 라벨 숫자를 100 기준으로 바꾼 값이 이미 저장된 per100 과 맞는가(공통 키 전부 ±1% 또는 ±0.05). 공통 키가 없으면 false. */
function consistent(label, per100) {
  if (!label || !per100) return false;
  const f = 100 / label.amount; let n = 0;
  for (const [k, v] of Object.entries(label.values || {})) {
    if (typeof per100[k] !== 'number') continue; n++;
    const c = v * f; if (Math.abs(c - per100[k]) > Math.max(0.05, Math.abs(per100[k]) * 0.01)) return false;
  }
  return n > 0;
}

module.exports = { labelFromParsed, consistent, KEYS };
