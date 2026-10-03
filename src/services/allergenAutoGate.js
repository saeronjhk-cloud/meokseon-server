/**
 * ★★★ 세션72 — 제보 알레르기 «자동 반영» 게이트 (allergen_auto_gate_v1)
 *
 * 정본 결정: `IP/결정_알레르기자동반영_2026-09-29.md` (제이 확정 2026-09-28 세션71 · 범위 2026-09-29 세션72)
 *   · 세션66 C6 「제보 → 공식 테이블은 전량 수동, 예외 없음」의 «첫 예외»다.
 *   · 예외 범위: **알레르기 축 · 이 게이트 통과분만.** 영양·원재료·첨가물은 여전히 전량 수동.
 *   · 확정 원칙(세션71): 「과잉경고도 오류다」 — 목표는 «라벨과 일치»이지 안전 쪽 치우침이 아니다.
 *
 * 게이트(세 조건 AND — eval_allergen_auto_v1 에서 치명 0 · 경미 0 으로 확정된 그것):
 *   ① `declarationFound === true`         — 알레르기 표시란(또는 혼입 문장)을 실제로 읽었다
 *   ② 19종 이름 ≥ 1 (contains ∪ mayContain) — 반영할 것이 있다
 *   ③ `declarationResidue(text).length === 0` — 목록에 19종으로 해석 안 되는 짧은 토큰(오독 흔적)이 없다
 * 여기에 «서버 경로» 조건 둘을 더한다(eval 은 파서 출력만 쟀기 때문 — eval 밖의 입력은 자동 반영하지 않는다):
 *   ④ `inferred` 가 비어 있다              — 원재료명 추론(DS-6′ 금지)이 섞이지 않았다
 *   ⑤ 저장될 v2 == 이 텍스트의 파서 v2     — 사용자 수정·다장 병합으로 달라진 것은 eval 이 보증하지 않는다
 *
 * ⚠ 이 함수는 «판정»만 한다. DB 에 쓰지 않는다(쓰기는 `contributionApply.applyAutoAllergens` 한 곳).
 * ⚠ `declarationResidue` 결과를 응답 계약(allergens_v2)에 넣지 말 것(세션71 ⛔3). 여기 evidence 에만 남긴다.
 */

const { analyzeText, declarationResidue } = require('./ocrParser');

// ★ 세션72 U72-8 — v2: residue v2(표시어 없는 선언은 이름과 가까운 토큰만 · 같은 줄 경계 검사). 판정 규칙이 바뀌면 올린다(감사 추적).
//   ⚠ `contributionApply.AUTO_APPLIED_BY`('auto:allergen_auto_gate_v1')는 «행위자 이름»이라 그대로 둔다.
// ★ 세션74 U72-9 — v3: residue v3(불용어 겹침 오독 · 3음절 이상 이름 오독 · 글머리표 · 이름 없는 선언 · 원재료 줄 `○○ 함유`).
//   eval: IP/eval_allergen_residue_v1(양성 4,743 놓침 0 · 실물 음성 98 변화 0) + HACCP 알레르기 표기 12,078 보류 검증(새 큐 18종 전부 실제 오타·깨짐).
const GATE_VERSION = 'allergen_auto_gate_v3';

function sortedSet(arr) {
  return [...new Set((Array.isArray(arr) ? arr : []).map(String))].sort();
}

function sameList(a, b) {
  const x = sortedSet(a); const y = sortedSet(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * @param {{ text: string, storedV2?: object|null }} args
 *   text     — 제보에 저장되는 OCR 원문(`contributions.data.ocr_raw_text` 와 같은 값)
 *   storedV2 — 저장될 allergens_v2(= reconcile 뒤). 생략하면 ⑤ 를 검사하지 않는다(eval 전용).
 * @returns {{ pass: boolean, reason: string|null, gate_version: string,
 *             contains: string[], may_contain: string[], residue: string[],
 *             may_inspected: boolean }}
 */
function evaluateAllergenAutoGate({ text, storedV2 } = {}) {
  const out = (pass, reason, extra = {}) => ({
    pass, reason, gate_version: GATE_VERSION,
    contains: [], may_contain: [], residue: [], may_inspected: false, ...extra,
  });

  const t = typeof text === 'string' ? text : '';
  if (!t.trim()) return out(false, 'NO_TEXT');

  const a = analyzeText(t);
  const v2 = (a && a.allergens_v2) || {};
  const contains = sortedSet(v2.contains);
  const may = sortedSet(v2.mayContain);
  const inferred = sortedSet(v2.inferred);
  const residue = (declarationResidue(t) || []).map((r) => r.tok);
  // ★ 대책3 — 혼입 목록을 하나라도 읽었는가. false 면 화면은 「혼입 정보 미확인」을 말해야 한다.
  const extra = { contains, may_contain: may, residue, may_inspected: may.length > 0 };

  if (v2.declarationFound !== true) return out(false, 'NO_DECLARATION', extra);
  if (contains.length + may.length === 0) return out(false, 'NO_NAMES', extra);
  if (residue.length > 0) return out(false, 'RESIDUE', extra);
  if (inferred.length > 0) return out(false, 'INFERRED_PRESENT', extra);
  if (storedV2 !== undefined) {
    const s = storedV2 || {};
    if (!sameList(s.contains, contains) || !sameList(s.mayContain, may)
        || sortedSet(s.inferred).length > 0) {
      return out(false, 'STORED_MISMATCH', extra);
    }
  }
  return out(true, null, extra);
}

module.exports = { evaluateAllergenAutoGate, GATE_VERSION };
