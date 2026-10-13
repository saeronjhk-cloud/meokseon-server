'use strict';
/**
 * nutritionBasisReconcile.js — ★ 세션78 · 2열 영양표(1회분 | 100g당)에서 «값이 어느 열인지» 다시 판정한다.
 *
 * 왜 (실측 · IP/eval_nutrition_basis_v1/cases_v1.json · 세션78 판매처 라벨 OCR 시범)
 *   두 파서(src/services/ocrParser.js · scripts/lib/capture_label_parser.js)의 기준 판정은
 *   텍스트 어디에든 「100g당」이 있으면 무조건 per100 이다. 그런데 한국 라벨은
 *   「1봉지(20g)당 102 kcal」 열과 「100g당」 열을 «나란히» 적는 경우가 흔하고, OCR 이 두 열을 섞어 읽으면
 *   파서가 집은 값은 1회분인데 기준은 100g 으로 붙는다.
 *   실물: 촉촉한초코칩 — 102 kcal(1봉지 20g) 을 100g 값으로 저장 → 정답 510 의 1/5 · 과소(거짓 초록 방향).
 *   기준선: 정답 12건 중 두 파서 모두 7/12.
 *
 * 규칙 (좁게 · 근거가 있을 때만 바꾼다. 근거가 없으면 null = 종전 동작 그대로)
 *   전제: 현재 기준이 per100 이고, 라벨에 1회분 선언(「1봉지(20g)당」 등)이 있고, 파서가 열량을 집었다.
 *   A) 라벨에 「<1회분 선언>당 N kcal」 이 있고 N == 집은 열량 → 그 1회분 열이다.
 *      (단 「100g당 N kcal」 도 같은 N 이면 구분 불가 → null)
 *   B) 라벨에 총량과 총열량(「320g(1,632 kcal)」)이 있으면 1회분 기대값 K·s/T 와 100g 기대값 K·100/T 중
 *      집은 열량이 1회분 쪽에 5% 안으로 맞고 100g 쪽과 20% 넘게 다를 때만 → 1회분 열이다.
 * 반환: null | { basis: 'serving', amount, unit, reason }
 * ⚠ 두 파서가 «이 한 함수»를 같이 쓴다(세션42~44 「한쪽 파서만 고치기」 사고 방지). 사본을 만들지 말 것.
 * ⚠ 모든 수량자에 상한(세션43 ReDoS 교훈).
 */

const UNIT = '(g|㎖|ml|mL|kg|L)';
const SERVING_HEAD = '1\\s{0,4}(?:회\\s{0,4}제공량|회분|회|봉지|봉|개입|개|포|스틱|컵|캔|병|조각|장|인분|용기|그릇|팩|매|줄|판|알|쪽|덩이)\\s{0,4}\\(?\\s{0,4}(\\d[\\d,.]{0,12})\\s{0,4}' + UNIT + '\\s{0,4}\\)?\\s{0,4}당';
const KCAL_TAIL = '\\s{0,6}(?:열량\\s{0,4}[:：]?\\s{0,4})?(\\d[\\d,.]{0,12})\\s{0,4}(?:kcal|킬로칼로리)';
const RE_SERVING_DECL = new RegExp(SERVING_HEAD, 'g');
const RE_SERVING_KCAL = new RegExp(SERVING_HEAD + KCAL_TAIL, 'gi');
const RE_PER100_KCAL = new RegExp('100\\s{0,4}(?:g|㎖|ml|mL)\\s{0,4}당' + KCAL_TAIL, 'i');
const RE_TOTAL_KCAL = /(\d[\d,.]{0,12})\s{0,4}(g|㎖|ml|mL)\s{0,4}[(（]\s{0,4}(\d[\d,.]{0,12})\s{0,4}kcal\s{0,4}[)）]/gi;

function n(s) { const v = Number(String(s).replace(/,/g, '')); return Number.isFinite(v) ? v : null; }

/**
 * @param {{text:string, basis:string, calories:number|null}} p  basis 는 정본 어휘(per100|serving|total|unknown)
 */
function reconcileServingVsPer100({ text, basis, calories }) {
  if (basis !== 'per100' || calories == null || !Number.isFinite(calories)) return null;
  const t = String(text || '').slice(0, 20000);
  const decls = [...t.matchAll(RE_SERVING_DECL)].map((m) => ({ amount: n(m[1]), unit: m[2].toLowerCase() })).filter((d) => d.amount);
  if (!decls.length) return null;

  // A) 1회분 선언 바로 뒤의 kcal 이 집은 열량과 같다
  const p100 = t.match(RE_PER100_KCAL);
  const p100k = p100 ? n(p100[1]) : null;
  for (const m of t.matchAll(RE_SERVING_KCAL)) {
    const s = n(m[1]); const k = n(m[3]);
    if (s && k != null && k === calories && s !== 100) {
      if (p100k != null && p100k === calories) return null;
      return { basis: 'serving', amount: s, unit: m[2].toLowerCase(), reason: 'serving_kcal_pair' };
    }
  }

  // B) 총량·총열량으로 기대값 비교
  for (const m of t.matchAll(RE_TOTAL_KCAL)) {
    const T = n(m[1]); const K = n(m[3]);
    if (!T || !K) continue;
    for (const d of decls) {
      if (!(T > d.amount) || d.amount === 100) continue;
      const es = (K * d.amount) / T; const e100 = (K * 100) / T;
      if (Math.abs(calories - es) <= Math.max(1, 0.05 * es) && Math.abs(calories - e100) > 0.2 * e100) {
        return { basis: 'serving', amount: d.amount, unit: d.unit, reason: 'total_kcal_ratio' };
      }
    }
  }
  return null;
}

module.exports = { reconcileServingVsPer100 };
