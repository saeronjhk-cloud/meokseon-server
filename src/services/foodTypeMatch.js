/**
 * foodTypeMatch.js — 식품유형 문자열 ↔ 표 키 매칭기 (세션49 신설)
 * ============================================================================
 * ★ 왜 이 파일이 생겼는가 — 세션48 치명A 의 재발 방지 장치다.
 *
 *   세션47 이 `raccPolicy.getRaccPolicy` 를 두 라우트에 배선했다. 그런데 그 함수가
 *   `RACC_MAP[foodType.trim()]` 정확 일치만 해서 **캡처 68건 중 0건이 매칭**됐다.
 *   즉 배선은 살아 있는데 정책이 **한 번도 발동하지 않았다.**
 *   실측 미스: "가공김(조미김)" · "혼합장(살균제품)" · "카레 (고형제품)" · "과자 (유처리 제품)"
 *
 *   그런데 **같은 저장소의 `raccTable.js` 는 이 문제를 이미 풀어 놓고 있었다.**
 *   L0~L4 정규화를 갖고 있었고 같은 68건에서 43/68 을 매칭했다.
 *   세션47 은 정규화가 없는 쪽에 배선한 것이다.
 *
 *   → 그래서 정규화를 **한 곳으로 모은다.** raccTable 과 raccPolicy 가 이 파일을 공유한다.
 *     세션48 외부 검증이 근본 원인으로 지목한 것이 정확히 이것이다:
 *       "같은 의미 → 여러 파일에서 재해석 → 여러 경로에서 서로 다른 기본값"
 *       "답은 검증 에이전트를 더 붙이는 것이 아니라 경로와 상태 수를 줄이는 것이다."
 *
 * ★ 순환 참조 주의
 *   raccTable → raccPolicy(resolveServing) 방향의 의존이 이미 있다.
 *   그래서 정규화를 raccTable 에 두고 raccPolicy 가 가져다 쓰면 순환이 된다.
 *   이 파일은 **아무것도 require 하지 않는다.** 두 쪽 모두 안전하게 의존할 수 있다.
 *
 * ★ 안전 원칙
 *   - **부분 문자열 매칭을 하지 않는다.** 정규화 후에도 **전체 문자열이 같아야** 매칭이다.
 *     '초고추장' 이 '고추장' 으로, '양조간장' 이 '간장' 으로 붙으면 근거 없는 면제가 된다.
 *   - 못 찾으면 **못 찾았다고 반환한다**(null). 근사값을 만들지 않는다.
 *   - L3(괄호 밖)과 L4(괄호 안)가 **서로 다른 키**에 걸리면 `ambiguousWith` 로 보고한다.
 *     판정은 종전대로 L3 우선이지만, 모호했다는 사실을 호출부가 볼 수 있어야 한다.
 *     (세션41 이 정한 L3 우선 규칙은 test_racc_table.js §5 "소시지(조미김) → L3 우선" 이 지킨다.)
 */
'use strict';

// ── 정규화 4종 ──────────────────────────────────────────────────────────────
// L1 — 공백만 제거
function stripSpace(s) { return s.replace(/\s+/g, ''); }

// L2 — 공백 + 분리자 제거. '과/채 주스' 와 '과·채주스' 를 같은 '과채주스' 로 만든다.
//   · 는 U+00B7 외에 U+318D(ㆍ)·U+2027·U+22C5 등으로도 들어온다 — 실물 OCR·공공DB 양쪽에서 관측된다.
function stripSep(s) { return s.replace(/[\s·ㆍ․‧⋅∙/／.,\-‐‑–—~_]/g, ''); }

// L3 — 괄호 밖: '프레스햄(살균제품)' → '프레스햄'
function outsideParen(s) { return s.replace(/[(（[［][^)）\]］]*[)）\]］]/g, '').trim(); }

// L4 — 괄호 안: '가공김(조미김)' → '조미김'. 마지막 괄호를 쓴다(부가표기가 뒤에 오는 실물 패턴).
function insideParen(s) {
  const all = [...s.matchAll(/[(（[［]([^)）\]］]+)[)）\]］]/g)].map((m) => m[1].trim()).filter(Boolean);
  return all.length ? all[all.length - 1] : null;
}

// ── 인덱스 ──────────────────────────────────────────────────────────────────
/**
 * 표 키 목록으로 조회 인덱스를 만든다.
 * 충돌 시 **먼저 등록된 키를 유지한다.** 나중 키가 덮어쓰면 조회 결과가 키 순서에 좌우된다.
 * @param {string[]} keys
 */
function buildFoodTypeIndex(keys) {
  const exact = new Map();
  const space = new Map();
  const sep = new Map();
  for (const key of keys) {
    exact.set(key, key);
    const sp = stripSpace(key); if (!space.has(sp)) space.set(sp, key);
    const se = stripSep(key);   if (!sep.has(se))   sep.set(se, key);
  }
  return { exact, space, sep };
}

/** 한 후보 문자열을 3개 인덱스로 시도. via: 0=L0 정확 · 1=L1 공백무시 · 2=L2 분리자무시 */
function probe(index, cand) {
  if (!cand || !index) return null;
  if (index.exact.has(cand)) return { key: index.exact.get(cand), via: 0 };
  const sp = stripSpace(cand); if (index.space.has(sp)) return { key: index.space.get(sp), via: 1 };
  const se = stripSep(cand);   if (index.sep.has(se))   return { key: index.sep.get(se), via: 2 };
  return null;
}

/**
 * 식품유형 문자열 → 표 키.
 * @returns {{key:string, matchLevel:'L0'|'L1'|'L2'|'L3'|'L4', ambiguousWith:{key,matchLevel}|null}|null}
 *   못 찾으면 null. **추정하지 않는다.**
 */
function matchFoodType(index, foodType) {
  if (foodType == null || !index) return null;
  const raw = String(foodType).trim();
  if (!raw) return null;

  // L0~L2 — 원문 그대로
  const direct = probe(index, raw);
  if (direct) {
    return { key: direct.key, matchLevel: ['L0', 'L1', 'L2'][direct.via], ambiguousWith: null };
  }

  // L3 — 괄호 밖 ('프레스햄(살균제품)' 처럼 괄호가 **부가 설명**인 경우)
  const out = outsideParen(raw);
  const l3 = (out && out !== raw) ? probe(index, out) : null;

  // L4 — 괄호 안 ('가공김(조미김)' 처럼 괄호가 **더 구체적인 유형**인 경우)
  const inn = insideParen(raw);
  const l4 = inn ? probe(index, inn) : null;

  // L3 을 먼저 보는 이유: 괄호 밖이 주된 유형인 경우가 더 흔하다(살균제품·비살균 등 공정 표기).
  // 둘 다 걸리고 키가 다르면 **모호**하다. 판정은 L3 로 하되 사실을 보고한다.
  if (l3) {
    return {
      key: l3.key,
      matchLevel: 'L3',
      ambiguousWith: (l4 && l4.key !== l3.key)
        ? { key: l4.key, matchLevel: 'L4' }
        : null,
    };
  }
  if (l4) return { key: l4.key, matchLevel: 'L4', ambiguousWith: null };

  return null;
}

module.exports = {
  buildFoodTypeIndex,
  matchFoodType,
  // 테스트·감사 전용 — 정규화 단계를 개별로 확인할 때 쓴다
  _norm: { stripSpace, stripSep, outsideParen, insideParen },
  _probe: probe,
};
