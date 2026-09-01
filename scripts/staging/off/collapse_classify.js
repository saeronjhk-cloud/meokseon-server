/**
 * collapse_classify.js — collapse 충돌 큐 상태 라우팅 + 승격 가드 (단일 소스, 순수·무 I/O).
 *
 * 근거: 자문/collapse충돌큐_자문회신_결정_2026-07-06.md §5.1 계약 + §4.7 lock.
 *   - 실측(Step0): 큐 97.4% 진짜 충돌 → 이름 브릿지는 "후보 추천기"로 격하.
 *   - 절차: basis 정렬(고체/액체 분리, per_serving 은 g/ml 확실할 때만) → nutrient·category 결측0 제외(v1: kcal·sodium 만)
 *           → conflictDims 확장축(kcal·sodium·sugars·sat_fat).
 *   - 결측0 제외는 v1 에서 kcal·sodium 만(§4.7 ②). sugars·sat_fat=0 은 실제값(충돌은 어차피 suppress → 안전).
 *
 * 임계는 import_bridge_lib.conflictDims(kcal 상대차>15%, 나트륨 max/min>2 또는 min0&max>50)를 미러 + 확장축.
 * (conflictDims 는 kcal·sodium 만 — 기존 71 Eval·build 무회귀 위해 그대로 두고, 확장은 여기 신규 함수로.)
 *
 * export: collapseClassify(group, ctx) · verifyEligibility(input) · (테스트용) alignBasis·axisConflict·isMissingZero
 */
'use strict';

const VERSION = 'collapse_classify@1.1';
const TH = { kcalRel: 0.15, naRatio: 2, naMin0Max: 50, sugRel: 0.15, sugFloor: 2, sfRel: 0.15, sfFloor: 1 };

// 억제(기본 검토 큐 숨김) 정책 — route→suppressed 단일 소스. annotator·API·Eval 공유.
//   - conflict_unresolvable: 진짜 충돌(Step0 97.4%) → auto-suppress(사람 dismiss 아님, reopen 가능).
//   - basis_unknown_hold  : 수입 serving 파싱 불가로 basis 미정렬 → 안전 비교 불가 = 검토·승격 대상 아님(§7.5 ⓑ).
//     둘 다 "사람이 판단할 게 없는" 시스템 보류 → 기본 큐에서 숨김. status(사람 워크플로)와 무관(017 §대원칙 1).
const SUPPRESSED_ROUTES = Object.freeze(['conflict_unresolvable', 'basis_unknown_hold']);
function isSuppressedRoute(route) { return SUPPRESSED_ROUTES.includes(route); }

// 결측0 화이트리스트(v1 초소형). kcal=0 은 물/제로류 외 결측 의심 / sodium=0 은 오일·물·차·설탕류 외 결측 의심.
const KCAL0_REAL = /물|생수|탄산수|무가당|블랙\s*커피|제로|zero|라이트|light/i;
const NA0_REAL   = /오일|기름|식용유|올리브|카놀라|포도씨|물|생수|증류수|차|녹차|홍차|보리차|커피|설탕|시럽|꿀/i;
function isMissingZero(cand, nutrient) {
  if (cand[nutrient] !== 0) return false;
  const nm = (cand.name || '') + ' ' + (cand.category || '');
  if (nutrient === 'kcal') return !KCAL0_REAL.test(nm);
  if (nutrient === 'sodium') return !NA0_REAL.test(nm);
  return false; // sugars·sat_fat 은 v1 결측0 처리 안 함(실제값 취급)
}

// per_serving 환산은 serving 이 g/ml 로 확실할 때만('1개/1봉/1회분'은 null → hold)
function parseServingG(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/(\d+(?:\.\d+)?)\s*(g|ml|밀리리터|그램|㎖)?/i);
  if (!m) return null;
  const unit = (m[2] || '').toLowerCase();
  if (!/^(g|ml|밀리리터|그램|㎖)$/.test(unit)) return null;
  const v = parseFloat(m[1]);
  return v > 0 ? v : null;
}

// 후보 → per_100(phase). 모든 영양(kcal·sodium·sugars·sat_fat)을 동일 배율로 환산.
const NUTR = ['kcal', 'sodium', 'sugars', 'sat_fat'];
function alignBasis(c) {
  const scale = (f) => {
    const o = { cand: c };
    for (const k of NUTR) o[k] = c[k] == null ? null : c[k] * f;
    return o;
  };
  if (c.basis === 'per_100g') return { ok: true, phase: 'g', ...scale(1) };
  if (c.basis === 'per_100ml') return { ok: true, phase: 'ml', ...scale(1) };
  if (c.basis === 'per_serving') {
    const sg = c.serving_g != null ? c.serving_g : parseServingG(c.serving_size);
    if (sg == null) return { ok: false, reason: 'per_serving_no_serving_g' };
    return { ok: true, phase: 'g', ...scale(100 / sg) };
  }
  return { ok: false, reason: 'basis_unknown' };
}

// 확장축 충돌 판정 → 충돌 축 배열. list 원소: {kcal,sodium,sugars,sat_fat}(null 허용).
function axisConflict(list) {
  const dims = [];
  const col = (k) => list.map((x) => x[k]).filter((v) => v != null);
  const relConf = (arr, rel, floor) => {
    if (arr.length < 2) return false;
    const mx = Math.max(...arr), mn = Math.min(...arr);
    return mx > 0 && (mx - mn) / mx > rel && (mx - mn) > (floor || 0);
  };
  if (relConf(col('kcal'), TH.kcalRel, 0)) dims.push('kcal');
  const na = col('sodium');
  if (na.length > 1) { const mx = Math.max(...na), mn = Math.min(...na); if ((mn > 0 && mx / mn > TH.naRatio) || (mn === 0 && mx > TH.naMin0Max)) dims.push('sodium'); }
  if (relConf(col('sugars'), TH.sugRel, TH.sugFloor)) dims.push('sugars');
  if (relConf(col('sat_fat'), TH.sfRel, TH.sfFloor)) dims.push('sat_fat');
  return dims;
}

// 그룹 라우팅. group 원소: {name,category?,basis,serving_g?,serving_size?,kcal,sodium,sugars,sat_fat}
function collapseClassify(group, ctx) {
  if (!Array.isArray(group) || group.length < 2) return { route: 'needs_review', dims: [], reason: 'single_or_empty' };
  const cat = (ctx && ctx.category) || null;
  const withCat = group.map((c) => (c.category == null && cat ? { ...c, category: cat } : c));

  const normed = withCat.map(alignBasis);
  const valid = normed.filter((n) => n.ok);
  const phases = new Set(valid.map((n) => n.phase));
  if (phases.has('g') && phases.has('ml')) return { route: 'basis_unknown_hold', dims: [], reason: 'mixed_phase' };
  if (valid.length < 2) return { route: 'basis_unknown_hold', dims: [], reason: 'lt2_comparable' };

  const alignedList = valid.map((n) => ({ kcal: n.kcal, sodium: n.sodium, sugars: n.sugars, sat_fat: n.sat_fat }));
  const alignedDims = axisConflict(alignedList);

  const zeroFiltered = valid.map((n) => ({
    kcal: isMissingZero(n.cand, 'kcal') ? null : n.kcal,
    sodium: isMissingZero(n.cand, 'sodium') ? null : n.sodium,
    sugars: n.sugars, sat_fat: n.sat_fat,
  }));
  const zeroDims = axisConflict(zeroFiltered);

  if (zeroDims.length > 0) return { route: 'conflict_unresolvable', dims: zeroDims, reason: 'true_conflict' };
  if (alignedDims.length > 0) return { route: 'zero_missing_hold', dims: alignedDims, reason: 'conflict_only_from_missing_zero' };
  return { route: 'consistent_collapse_review', dims: [], reason: 'consistent' };
}

// 승격(human_verified) 자격 — 단일후보 함정(§4.7 ③) HARD RULE.
// 순수 일반명사 + 이름정확 + 보강근거 0 → 불가. 보강(브랜드·수입원·원산지·내용량) ≥1 → 가능.
function verifyEligibility(input) {
  const corr = Array.isArray(input && input.corroboration) ? input.corroboration : [];
  if (input && input.is_generic && corr.length === 0) {
    return { eligible: false, reason: 'generic_name_no_corroboration' };
  }
  return { eligible: true, reason: null };
}

module.exports = { collapseClassify, verifyEligibility, isSuppressedRoute, SUPPRESSED_ROUTES, alignBasis, axisConflict, isMissingZero, parseServingG, VERSION };
