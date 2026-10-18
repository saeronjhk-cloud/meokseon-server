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
// ★ 세션81 — 단위어에 «갑» 추가(연양갱 «1갑(50g)당» · eval_label_basis_anchor_v1 B).
const WORD = '(?:회\\s{0,4}제공량|회분|회|봉지|봉|개입|개|포|스틱|컵|캔|병|조각|장|인분|용기|그릇|팩|매|줄|판|알|쪽|덩이|갑)';
const SERVING_HEAD = '1\\s{0,4}' + WORD + '\\s{0,4}\\(?\\s{0,4}(\\d[\\d,.]{0,12})\\s{0,4}' + UNIT + '\\s{0,4}\\)?\\s{0,4}당';
const KCAL_TAIL = '\\s{0,6}(?:열량\\s{0,4}[:：]?\\s{0,4})?(\\d[\\d,.]{0,12})\\s{0,4}(?:kcal|킬로칼로리)';
const RE_SERVING_DECL = new RegExp(SERVING_HEAD, 'g');
const RE_SERVING_KCAL = new RegExp(SERVING_HEAD + KCAL_TAIL, 'gi');
// ★ 세션81 — 열량 «바로 앞/뒤»에 붙은 1회분 선언의 다른 표기(eval_label_basis_anchor_v1 · 판매처 라벨 실측).
//   이 넷은 «열량 숫자와 붙어 있을 때만» 쓴다(A 규칙 · 집은 열량과 같아야 함) — 선언만 있는 것으로는 기준을 바꾸지 않는다.
//   P1 «30g당 166 kcal»(앞에 1+단위어 없음 · 당 뒤 한글 금지 = 당류 오독 방지 · «총 내용량 500 g당» 은 제외 = 총량 기준(parity))
//   P2 «1회섭취참고량(30g)당 128kcal» · «1회 섭취 참고량(150g)당 360kcal»
//   P3 «1개당(130g) 205 kcal» · «1봉지당(120g) 505 kcal»(당이 괄호 앞)
//   P4 «510kcal 개(120g)당»(열량이 앞 · OCR 이 «1» 을 떼어 냄)
const RE_PAIR = [
  ['bare_serving_kcal', new RegExp('(?:^|[\\s(|/])(?<!내용량[\\s:]{0,8})(\\d[\\d,.]{0,12})\\s{0,4}' + UNIT + '\\s{0,4}당(?![가-힣])' + KCAL_TAIL, 'gi'), 1, 2, 3],
  ['ref_amount_kcal', new RegExp('섭취\\s{0,4}참고량\\s{0,4}\\(\\s{0,4}(\\d[\\d,.]{0,12})\\s{0,4}' + UNIT + '\\s{0,4}\\)\\s{0,4}당' + KCAL_TAIL, 'gi'), 1, 2, 3],
  ['word_dang_paren_kcal', new RegExp('1\\s{0,4}' + WORD + '\\s{0,4}당\\s{0,4}\\(\\s{0,4}(\\d[\\d,.]{0,12})\\s{0,4}' + UNIT + '\\s{0,4}\\)' + KCAL_TAIL, 'gi'), 1, 2, 3],
  ['kcal_word_paren_dang', new RegExp('(\\d[\\d,.]{0,12})\\s{0,4}(?:kcal|킬로칼로리)\\s{0,6}(?:1\\s{0,4})?' + WORD + '\\s{0,4}\\(\\s{0,4}(\\d[\\d,.]{0,12})\\s{0,4}' + UNIT + '\\s{0,4}\\)\\s{0,4}당', 'gi'), 2, 3, 1],
];
const RE_PER100_KCAL = new RegExp('100\\s{0,4}(?:g|㎖|ml|mL)\\s{0,4}당' + KCAL_TAIL, 'i');
const RE_TOTAL_KCAL = /(\d[\d,.]{0,12})\s{0,4}(g|㎖|ml|mL)\s{0,4}[(（]\s{0,4}(\d[\d,.]{0,12})\s{0,4}kcal\s{0,4}[)）]/gi;

function n(s) { const v = Number(String(s).replace(/,/g, '')); return Number.isFinite(v) ? v : null; }

/**
 * @param {{text:string, basis:string, calories:number|null}} p  basis 는 정본 어휘(per100|serving|total|unknown)
 */
function reconcileServingVsPer100({ text, basis, calories }) {
  // ★ 세션81 — 'total'(총 내용량 기준)에도 적용: 묶음 라벨 «총 내용량 780g(130g×6) / 1개당(130g) 205 kcal» 을
  //   총량으로 나누던 결함(양반밥 100g당 26 → 정답 158). total 은 «열량에 붙은 1회분 선언»(A) 이 있을 때만 바꾼다(B 규칙 미적용).
  if ((basis !== 'per100' && basis !== 'total') || calories == null || !Number.isFinite(calories)) return null;
  const t = String(text || '').slice(0, 20000);
  const p100 = t.match(RE_PER100_KCAL);
  const p100k = p100 ? n(p100[1]) : null;

  // A) 1회분 선언 바로 뒤(또는 앞)의 kcal 이 집은 열량과 같다
  const pairs = [];
  for (const m of t.matchAll(RE_SERVING_KCAL)) pairs.push({ s: n(m[1]), unit: m[2], k: n(m[3]), reason: 'serving_kcal_pair' });
  for (const [reason, re, si, ui, ki] of RE_PAIR) for (const m of t.matchAll(re)) pairs.push({ s: n(m[si]), unit: m[ui], k: n(m[ki]), reason });
  // ★ 세션81 v1.1 — 1회분은 총 내용량보다 클 수 없고 1kg(1L)를 넘지 않는다(68-eval 048 «2000g당 185 kcal» = «100g당» OCR 오독 · 내용량 1kg).
  //   라벨의 «내용량» 숫자 중 «가장 큰 것»과 비교한다 — 첫 값은 OCR 오독일 수 있다(rv_1002070588 «총 내용량 30mL(38ml * 1개)» · 실제 380mL).
  let totalAmt = null;
  for (const tm of t.matchAll(/내용량[:\s]{0,10}(\d[\d,.]{0,12})\s{0,4}(kg|g|㎖|ml|mL|L)(?![a-zA-Z])/g)) {
    const v = n(tm[1]) * (/^(kg|L)$/.test(tm[2]) ? 1000 : 1); if (v && (totalAmt == null || v > totalAmt)) totalAmt = v;
  }
  for (const p of pairs) {
    if (p.s && (p.s > 1000 || (totalAmt && p.s > totalAmt))) continue;
    if (p.s && p.k != null && p.k === calories && p.s !== 100) {
      if (p100k != null && p100k === calories) return null;
      return { basis: 'serving', amount: p.s, unit: String(p.unit).toLowerCase(), reason: p.reason };
    }
  }
  if (basis === 'total') return null;

  const decls = [...t.matchAll(RE_SERVING_DECL)].map((m) => ({ amount: n(m[1]), unit: m[2].toLowerCase() })).filter((d) => d.amount);
  if (!decls.length) return null;
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
