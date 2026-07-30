/**
 * servingResolver.js — 인분 수·식품유형 해상도 계층  (2026-07-29 세션41)
 * ============================================================================
 * 제이 지시 (2026-07-29):
 *   "골든카레와 같이 총량과 1회분량이 명확하지 않거나, 식품유형이 명확하지 않으면,
 *    자동으로 제품 검색을 통해서 몇 인분인지와 식품유형을 파악해서 반영하도록 설정해줘"
 *
 * ★ 왜 이 파일이 필요한가 — 017 골든카레 실물
 *     라벨: 총 내용량 220g / 1070kcal / 총 내용량당 / 나트륨 9150mg **458%**
 *     실제: 220g = 6인분 블록 × 2 = **12인분** (S&B 공식 표기)
 *     1인분 18.3g · 나트륨 762mg(38%DV) · 89kcal   →  458% ÷ 12 = 38%  정확히 일치
 *   그대로 판정하면 나트륨 458% 로 초강력 빨강이 나간다. **12배 과대 = 거짓 빨강.**
 *   세션40 에서 Claude 가 "4~5인분" 이라고 **추정했다가 틀렸다**(실제 12인분).
 *   → 교훈: **인분 수는 추정하지 않는다. 제조사 표기를 확인한다.** 이 파일이 그 교훈의 코드판이다.
 *
 * ★ 설계 원칙 — 제이 고정원칙 (5) "엔진 안에서 결과 도출, 어려운 경우에만 AI 추론"
 *   T0 라벨 표기        (무료·즉시)
 *   T1 라벨 %기준치 역산 (무료·즉시)  ← 라벨이 **이미 계산해서 인쇄해 준** 값이다. 가장 강력하다
 *   T2 총 내용량 ÷ RACC (무료·즉시)
 *   T3 웹 제품검색       (유료·배치)  ← 여기까지 와야 하는 건 소수여야 정상이다
 *   이 파일은 T0~T2 만 담당한다. T3 는 `scripts/72-resolve-serving-batch.js`(배치 비동기).
 *   제이 확정(2026-07-29): **런타임 동기 검색 금지.** 앱 스캔은 즉시 응답하고 판정을 보류한다.
 *
 * ★ 200% 규칙 (세션40 §5-4 에서 도출, 여기서 구현)
 *   라벨의 %기준치가 200% 를 넘으면 총 내용량 ≠ 1회 섭취량이다.
 *   RACC 표가 없어도, 식품유형을 몰라도 작동한다 — 라벨이 이미 계산해 인쇄한 값이기 때문.
 *   캡처 68건의 per_total 26건에 적용하면 **017 하나만 걸린다**(나머지 전부 200% 미만).
 *   ⚠ 단 **%DV 로 인분 수를 역산하지는 않는다.** 017 은 458/100 = 4.6 이 나오지만 실제는 12 다.
 *      역산이 맞으려면 라벨의 모든 영양소가 동일 배수여야 하는데 %기준치는 영양소마다 DV 가 달라
 *      최대값이 곧 배수라는 보장이 없다. **판정에만 쓰고 값은 T3 로 확인한다.**
 */
'use strict';

const raccTable = require('./raccTable');

// ── 숫자 파싱 — 천단위 콤마와 소수점 콤마를 구분 (세션39 거짓 초록 정본과 동일 규칙) ──
function num(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!/\d/.test(t)) return null;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return parseFloat(t.replace(/,/g, ''));
  if (/^\d+,\d{1,2}$/.test(t)) return parseFloat(t.replace(',', '.'));
  const v = parseFloat(t.replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
}

// ────────────────────────────────────────────────────────────────────────────
// T1 재료 — 라벨 %기준치 추출
// ────────────────────────────────────────────────────────────────────────────
/**
 * 영양성분 값 **뒤에 붙은** %기준치만 뽑는다.
 * 단위(mg/g/kcal) 뒤에 오는 % 로 한정하는 이유:
 *   원재료 함량 표기("설탕 15%")와 안내문구("비율(%)은 2,000 kcal 기준")를 배제해야 한다.
 *   원재료 %는 최대 100 이라 200% 판정에 영향이 없지만, 값 오염은 애초에 막는 게 맞다.
 * @returns {number[]} 발견된 %기준치 목록
 */
function extractPctDV(text) {
  if (!text) return [];
  const out = [];
  const re = /(?:mg|㎎|㎍|µg|ug|g|kcal|Kcal)\s*(?:미만|이하)?\s*(\d[\d,.]*)\s*%/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = num(m[1]);
    if (v != null && v >= 0 && v <= 10000) out.push(v);   // 10000% 초과는 OCR 오독으로 본다
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// T0 — 라벨에 인분 수가 직접 적혀 있는가
// ────────────────────────────────────────────────────────────────────────────
const RE_SERVINGS_WORD = /(\d+)\s*인분/;                     // "12인분"
// "390 g(65 g×6입)" · "600 g (120 g×5봉지)" · "384 g (32 g x 12개입)"
const RE_MULTIPLIER = /[\d,.]+\s*(?:g|kg|ml|mL|㎖|L)\s*[(（]\s*[\d,.]+\s*(?:g|kg|ml|mL|㎖|L)\s*[×xX*]\s*(\d+)\s*(?:입|개입|개|봉지|봉|공기|컵|팩|블록|매|장|조각|줄|알)?\s*[)）]/;
// "6블록" · "2단" 같은 단독 표기는 인분 수가 아닐 수 있어 쓰지 않는다(중량 분할 표기일 뿐).

function extractServingsFromLabel(text) {
  if (!text) return null;
  const w = text.match(RE_SERVINGS_WORD);
  if (w) {
    const n = num(w[1]);
    if (n && n > 1 && n <= 200) return { servings: n, evidence: w[0].trim(), rule: 'label_인분' };
  }
  const m = text.match(RE_MULTIPLIER);
  if (m) {
    const n = num(m[1]);
    if (n && n > 1 && n <= 200) return { servings: n, evidence: m[0].trim(), rule: 'label_배수표기' };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// 메인 — 인분 수 해상
// ────────────────────────────────────────────────────────────────────────────
/**
 * @param {Object} p
 * @param {string} p.text          라벨 원문(OCR 전사)
 * @param {string} p.basis         'per_serving' | 'per_100g' | 'per_100ml' | 'per_total' | 'unknown'
 * @param {number} p.totalContent  총 내용량 수치
 * @param {string} p.contentUnit   'g' | 'ml' ...
 * @param {number} p.servingSize   라벨 1회 제공량(있으면)
 * @param {string} p.foodType      식품유형
 * @returns {{
 *   servings: number|null, servingSize: number|null,
 *   tier: 'T0'|'T1'|'T2'|null, source: string|null, evidence: string|null,
 *   totalIsNotSingleServing: boolean|null,
 *   needsLookup: boolean, lookupReasons: string[], warnings: string[], maxPctDV: number|null
 * }}
 */
function resolveServings(p = {}) {
  const { text = '', basis = 'unknown', totalContent = null, contentUnit = null,
          servingSize = null, foodType = null } = p;

  const warnings = [];
  const lookupReasons = [];
  const r = {
    servings: null, servingSize: servingSize ?? null,
    tier: null, source: null, evidence: null,
    totalIsNotSingleServing: null,
    needsLookup: false, lookupReasons, warnings, maxPctDV: null,
  };

  // ── 200% 규칙 — 판정만 한다. 값은 만들지 않는다 ──
  const pcts = extractPctDV(text);
  const maxPct = pcts.length ? Math.max(...pcts) : null;
  r.maxPctDV = maxPct;
  const pctSaysMulti = maxPct != null && maxPct > 200;
  if (pctSaysMulti) {
    r.totalIsNotSingleServing = true;
    warnings.push(`PCT_DV_OVER_200: 라벨 %기준치 최대 ${maxPct}% — 총 내용량 ≠ 1회 섭취량이 확정적이다`);
  }

  // ── T0. 라벨에 인분 수가 적혀 있는가 ──
  const t0 = extractServingsFromLabel(text);
  if (t0) {
    r.servings = t0.servings; r.tier = 'T0'; r.source = t0.rule; r.evidence = t0.evidence;
    if (r.servings > 1) r.totalIsNotSingleServing = true;
    if (totalContent && r.servings > 0) r.servingSize = round2(totalContent / r.servings);
    return finish(r, foodType, basis, pctSaysMulti);
  }

  // ── T2. 총 내용량 ÷ RACC ──
  //    T1(=%DV 역산)은 **의도적으로 구현하지 않는다.** 위 헤더 ⚠ 참조 — 017 에서 4.6 vs 실제 12.
  //    %DV 는 "여러 회분이다" 라는 **판정**에만 쓰고, 인분 수 값은 RACC 또는 웹으로 얻는다.
  const rt = raccTable.lookupRacc(foodType);
  if (rt.matched && typeof rt.racc === 'number' && rt.racc > 0 && totalContent > 0) {
    // 단위 정합성: RACC 가 ml 인데 라벨이 g 이면 밀도 1 근사로 취급(json _meta.unit_note 정책)
    const ratio = totalContent / rt.racc;
    r.servingSize = rt.racc;
    if (ratio >= 1.5) {
      r.servings = Math.round(ratio * 10) / 10;
      r.tier = 'T2'; r.source = `racc:${rt.key}(${rt.racc}${rt.unit})`;
      r.evidence = `총 ${totalContent}${contentUnit || ''} ÷ RACC ${rt.racc}${rt.unit} = ${r.servings}`;
      r.totalIsNotSingleServing = true;
    } else {
      // 총량이 RACC 의 1.5배 미만 = 사실상 1회분. 세션40 §5-3 A그룹(1회분≈총량) 과 같은 판단.
      r.servings = 1;
      r.tier = 'T2'; r.source = `racc:${rt.key}(${rt.racc}${rt.unit})`;
      r.evidence = `총 ${totalContent}${contentUnit || ''} ÷ RACC ${rt.racc}${rt.unit} = ${ratio.toFixed(2)} → 1회분으로 본다`;
      if (r.totalIsNotSingleServing !== true) r.totalIsNotSingleServing = false;
    }
    return finish(r, foodType, basis, pctSaysMulti);
  }

  return finish(r, foodType, basis, pctSaysMulti);
}

function round2(n) { return Math.round(n * 100) / 100; }

/** 남은 불확실성을 정리하고 T3(웹검색) 필요 여부를 판정한다. */
function finish(r, foodType, basis, pctSaysMulti) {
  const rt = raccTable.lookupRacc(foodType);

  // ① 식품유형이 불명확한가
  if (!foodType || !String(foodType).trim()) {
    r.lookupReasons.push('FOOD_TYPE_MISSING: 식품유형이 비어 있다');
  } else if (!rt.matched) {
    r.lookupReasons.push(`FOOD_TYPE_UNMAPPED: '${foodType}' 이 RACC 60유형 표에 없다`);
  } else if (rt.racc === null && !rt.supplement) {
    // [표3] 공란 12키 — 매칭은 됐지만 환산 기준이 없다. 미매핑과 구분해서 알린다.
    r.warnings.push(`RACC_BLANK: '${rt.key}' 는 [표3] 공란 — 1회량 환산 불가(per-100g fallback)`);
  }

  // ② 인분 수가 불명확한가
  if (r.servings == null) {
    if (basis === 'per_total') {
      r.lookupReasons.push('SERVINGS_UNKNOWN: 총 내용량 기준 라벨인데 1회 섭취량을 알 수 없다');
    } else if (pctSaysMulti) {
      r.lookupReasons.push('SERVINGS_UNKNOWN: %기준치가 200% 를 넘어 여러 회분인데 인분 수 미상');
    }
  } else if (pctSaysMulti && r.tier === 'T2') {
    // 200% 규칙과 RACC 환산이 **크게 어긋나면** RACC 쪽을 믿지 않는다.
    // 017 이 정확히 이 경우다: RACC 미매핑이라 여기 안 오지만, 매핑돼도 458% 를 설명 못 하면 위험하다.
    const impliedMin = 2;   // 200% 초과 = 최소 2회분 이상
    if (r.servings < impliedMin) {
      r.lookupReasons.push(
        `SERVINGS_CONFLICT: RACC 환산 ${r.servings}회분인데 라벨 %기준치는 ${r.maxPctDV}% (2회분 이상을 시사) — 확인 필요`
      );
      r.warnings.push('RACC 환산과 라벨 %기준치가 어긋난다. 라벨이 인쇄해 준 값을 더 신뢰한다.');
    }
  }

  r.needsLookup = r.lookupReasons.length > 0;
  return r;
}

/**
 * 신호등에 넘길 1회분 환산 계수.
 * per_total 라벨의 값을 1회분으로 바꿀 때 **나눌 수**를 돌려준다.
 * 제이 확정 정책(2026-07-29): RACC 로 환산, RACC 미매핑이면 총량 = 1회분(나누지 않음).
 * @returns {{divisor: number, reason: string, safe: boolean}}
 *   safe=false 면 신호등 판정을 보류해야 한다(거짓 빨강 방지).
 */
function totalToServingDivisor(resolved) {
  if (!resolved) return { divisor: 1, reason: 'no_input', safe: true };

  // ★★ 세션42 검증에서 잡힌 치명 결함 — 아래 200% 가드보다 이 분기가 먼저 돌아서 가드가 죽어 있었다.
  //   resolveServings 의 T2 는 `총량 ÷ RACC < 1.5` 이면 **servings = 1 을 확정적으로 써넣는다.**
  //   그 순간 "%기준치 458%" 라는 확정 증거가 있어도 여기서 safe:true, divisor:1 로 빠져나갔다.
  //   → 017 골든카레와 똑같은 라벨이 **식품유형이 RACC 에 매칭되기만 하면** 457% 빨강으로 나갔다.
  //   RACC 환산과 라벨 %기준치가 어긋나면 **라벨이 인쇄해 준 값을 믿는다.**(servingResolver 헤더 원칙)
  if (resolved.servings != null && resolved.servings > 1) {
    return {
      divisor: resolved.servings,
      reason: `${resolved.tier}:${resolved.source}`,
      safe: true,
    };
  }
  if (resolved.servings === 1 && resolved.totalIsNotSingleServing === true) {
    return {
      divisor: 1,
      reason: 'racc_says_single_but_pct_dv_says_multi',
      safe: false,
    };
  }
  if (resolved.servings === 1) {
    return {
      divisor: 1,
      reason: `${resolved.tier}:${resolved.source}`,
      safe: true,
    };
  }
  // 모르는데 %기준치가 200% 를 넘는다 = 여러 회분인 게 확실하다.
  // 여기서 1 로 나누면(=총량 그대로) **거짓 빨강**이 나간다. 판정을 보류한다.
  if (resolved.totalIsNotSingleServing === true) {
    return {
      divisor: 1,
      reason: 'multi_serving_but_count_unknown',
      safe: false,
    };
  }
  // 모르고 단서도 없다 → 제이 확정 정책: 총량 = 1회분
  return { divisor: 1, reason: 'racc_unmapped_treat_total_as_serving', safe: true };
}

module.exports = {
  resolveServings, totalToServingDivisor,
  extractPctDV, extractServingsFromLabel,
  _num: num,
};
