/**
 * web_label_gate.js — 판매처 라벨(web_label) 노출 품질 게이트. 순수 함수 · 엔진 규칙(AI 추론 없음). 세션79.
 *   정답 IP/eval_web_label_gate_v1/cases_v1.json = tests/fixtures/web_label_gate_v1.json (구현 전 고정)
 *   설계 IP/U78-3_web_label_노출/설계_v2.md §2-4 · 자문 라운드1 반영.
 */
'use strict';
const MAJOR = ['난류(가금류)', '우유', '메밀', '땅콩', '대두', '밀', '고등어', '게', '새우', '돼지고기', '복숭아', '토마토', '호두', '닭고기', '쇠고기', '오징어', '조개류', '잣'];
const FT_STOP = /(품목\s*보고|보고\s*번호|질량|중량|내용량|용량|포장\s*재질|1회\s*제공|제공량|kcal|원재료|영양|소비기한|유통기한|\d{6,})/;

/** 식품유형 잡음 제거. 다음 항목 낱말 앞에서 자르고, 남는 게 없으면 null. */
function cleanFoodType(s) {
  if (s == null) return null;
  let t = String(s).trim();
  const m = t.search(FT_STOP); if (m >= 0) t = t.slice(0, m);
  t = t.replace(/[·.,:;\s]+$/, '').replace(/^[·.,:;\s]+/, '').trim();
  return t.length ? t : null;
}

/** 영양 교차확인(4·4·9). true=통과 · false=실패(신호등 끔) · null=판정 불가(열량 없음·영양 없음). */
function nutritionOk(n) {
  if (!n || n.calories == null) return null;
  const c = Number(n.calories); const k = ['total_carbs', 'protein', 'total_fat'];
  for (const x of ['total_carbs', 'protein', 'total_fat', 'total_sugars']) if (n[x] != null && Number(n[x]) > 100) return false;   // 100g 당 100g 초과 불가
  if (k.some((x) => n[x] == null)) return false;   // 교차확인 불가 → 신호등 끔
  const at = 4 * Number(n.total_carbs) + 4 * Number(n.protein) + 9 * Number(n.total_fat);
  return Math.abs(at - c) <= Math.max(25, 0.2 * c);
}

/** 알레르기 교차확인. 'ok' · 'needs_review'(MAJOR 1종이라도 라벨에 없음) · 'none'(정보 없음). inferred=null 은 원재료 없음. */
function allergenCheck(label, inferred) {
  const L = Array.isArray(label) ? label : [];
  if (!L.length && (!inferred || !inferred.length)) return 'none';
  if (!inferred) return 'ok';
  if (!L.length && inferred.length) return 'needs_review';
  return inferred.some((a) => MAJOR.includes(a) && !L.includes(a)) ? 'needs_review' : 'ok';
}

/** 품목 노출 상태. */
function productStatus({ allergen, has_alg, has_nut }) {
  if (allergen === 'needs_review') return 'needs_review';
  if (!has_alg && !has_nut) return 'needs_review';
  return 'active';
}

/**
 * ★ 세션80 v1.1 — 판매처 라벨 영양 ↔ 식약처 K-FIND(같은 품목보고번호) 교차확인. 정답 IP/eval_kfind_expose_v1 G01~G10(구현 전 고정).
 *   wl·cands 원소 = {calories, sodium, total_sugars, total_fat} (100g/100ml 기준).
 *   반환 null(판정 불가) | {result:'agree'|'conflict', diff:[축], food_cd?}. 후보 여럿이면 열량이 가장 가까운 1개와 비교.
 */
const KF_AXES = [['calories', 10], ['sodium', 30], ['total_sugars', 1], ['total_fat', 1]];
const _n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
function kfindCheck(wl, cands) {
  if (!wl || _n(wl.calories) == null) return null;
  const C = (cands || []).filter((c) => c && _n(c.calories) != null);
  if (!C.length) return null;
  const k = _n(wl.calories);
  const best = C.slice().sort((a, b) => Math.abs(_n(a.calories) - k) - Math.abs(_n(b.calories) - k))[0];
  const diff = [];
  for (const [ax, abs] of KF_AXES) {
    const a = _n(wl[ax]), b = _n(best[ax]);
    if (a == null || b == null) continue;
    if (Math.abs(a - b) > Math.max(abs, 0.1 * Math.max(Math.abs(a), Math.abs(b)))) diff.push(ax);
  }
  return { result: diff.length ? 'conflict' : 'agree', diff, ...(best.food_cd ? { food_cd: best.food_cd } : {}) };
}

module.exports = { cleanFoodType, nutritionOk, allergenCheck, productStatus, kfindCheck, MAJOR };
