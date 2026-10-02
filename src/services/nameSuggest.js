'use strict';
/**
 * ★ 세션73 U71-5 — 제품명 «한 글자 오독» 제안 엔진 (AI 아님 · 제품 DB 단어사전 대조)
 *
 * 왜: 사진 제보의 제품명은 OCR 이 읽고 사용자는 «확인»만 누르는 일이 많다 → 한 글자 오독이 그대로 확정된다.
 *   운영 실측(10-02 · 제보 22건 중 OCR 이름 13건): 「군살→순살」「질리→질러」「호두정고→호두정과」 3건(23%).
 * 방법(결정적):
 *   · 사전 = 제품명 토큰(공백·괄호·기호로 자름 · 한글만 · 2글자 이상) → 빈도 Map. (색인 없음 — 메모리는 토큰 수만큼)
 *   · 사전에 없는 한글 토큰이면, 음절마다 «OCR 혼동 자모쌍»(아래 CONFUSE)을 한 번 바꿔 본 변형 중 사전에 있는 것을 찾는다.
 *   · 그런 변형이 «정확히 하나»일 때만 제안. 둘 이상이면 애매 → 제안 안 함(사람 판단).
 * eval(IP/eval_name_suggest_v1): 공공 제품명 4.5만 → 학습 80%·보류 20% · 합성 오독 600 중 정답 98%+ · 오제안 0 ·
 *   보류(새 제품 흉내) 3000 중 오제안 ≤1%. 운영 실례 3건 전부 정답 · 정상 이름 10건 무제안.
 * ⛔ 이름을 자동으로 바꾸지 않는다 — 제안은 확인 화면에서 사용자가 누를 때만 적용.
 */

const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';

/**
 * OCR 혼동 자모쌍(양방향 · 초성·중성에만 적용).
 *   1순위(OBSERVED) = 운영에서 «실제로» 본 것(실측 3건: ㅅ↔ㄱ · ㅓ↔ㅣ · ㅘ↔ㅗ).
 *   2순위 = 모양이 닮은 자모. 1순위 후보가 정확히 하나면 그것, 없으면 2순위가 정확히 하나일 때만 제안.
 *   (실례: 「질리」 → 1순위 「질러」(ㅣ→ㅓ) · 2순위 「칠리」(ㅈ→ㅊ) — 1순위가 하나라 「질러」)
 */
const OBSERVED = [['ㅅ', 'ㄱ'], ['ㅓ', 'ㅣ'], ['ㅘ', 'ㅗ']];
const CONFUSE = [['ㅅ', 'ㄱ'], ['ㅓ', 'ㅣ'], ['ㅘ', 'ㅗ'], ['ㅏ', 'ㅑ'], ['ㅓ', 'ㅕ'], ['ㅗ', 'ㅛ'], ['ㅜ', 'ㅠ'],
  ['ㅐ', 'ㅔ'], ['ㅡ', 'ㅢ'], ['ㄹ', 'ㄷ'], ['ㅁ', 'ㅇ'], ['ㅂ', 'ㅍ'], ['ㅈ', 'ㅊ'], ['ㅎ', 'ㅇ'], ['ㅣ', 'ㅏ'], ['ㅗ', 'ㅜ']];
const OBS = new Set(OBSERVED.flatMap(([a, b]) => [a + b, b + a]));
const SWAP = new Map();
for (const [a, b] of CONFUSE) {
  (SWAP.get(a) || SWAP.set(a, []).get(a)).push(b);
  (SWAP.get(b) || SWAP.set(b, []).get(b)).push(a);
}

const TOKEN_SPLIT = /[\s,()[\]{}\/·\-_+&.:;'"!?~%*]+/;
function tokenize(name) {
  return String(name || '').split(TOKEN_SPLIT).filter((t) => t.length >= 2);
}
const isHangulToken = (t) => /^[가-힣]{2,}$/.test(t);

/** 사전 — 이름 목록 → { freq: Map(token→n) } (한글 토큰만) */
function buildDictionary(names) {
  const freq = new Map();
  for (const n of names || []) for (const t of tokenize(n)) if (isHangulToken(t)) freq.set(t, (freq.get(t) || 0) + 1);
  return { freq };
}

/** 토큰의 «혼동 자모 1개» 변형 중 사전에 있는 것들. */
function candidatesFor(token, dict) {
  const chars = [...token];
  const out = new Map();
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i].charCodeAt(0) - 0xac00;
    if (c < 0 || c >= 11172) continue;
    const cho = Math.floor(c / 588); const jung = Math.floor((c % 588) / 28); const jong = c % 28;
    const variants = [];
    for (const b of SWAP.get(CHO[cho]) || []) if (CHO.includes(b)) variants.push([0xac00 + CHO.indexOf(b) * 588 + jung * 28 + jong, OBS.has(CHO[cho] + b)]);
    for (const b of SWAP.get(JUNG[jung]) || []) if (JUNG.includes(b)) variants.push([0xac00 + cho * 588 + JUNG.indexOf(b) * 28 + jong, OBS.has(JUNG[jung] + b)]);
    for (const [code, observed] of variants) {
      const v = [...chars]; v[i] = String.fromCharCode(code);
      const t = v.join('');
      if (dict.freq.has(t)) out.set(t, { freq: dict.freq.get(t), observed: observed || (out.get(t) || {}).observed || false });
    }
  }
  return [...out.entries()].map(([t, o]) => ({ token: t, freq: o.freq, observed: o.observed }))
    .sort((a, b) => (b.observed - a.observed) || (b.freq - a.freq));
}

/**
 * 이름 → 토큰별 판정 + 제안 이름.
 * @returns {{tokens: Array<{text, known:boolean, suggestion:string|null}>, suggested:string|null}}
 */
function suggestName(name, dict) {
  const raw = String(name || '');
  const tokens = [];
  let suggested = raw; let any = false;
  for (const t of tokenize(raw)) {
    const known = !isHangulToken(t) || dict.freq.has(t);
    let suggestion = null;
    if (!known) {
      const cands = candidatesFor(t, dict);
      const obs = cands.filter((c) => c.observed);
      const pick = obs.length === 1 ? obs[0] : (obs.length === 0 && cands.length === 1 ? cands[0] : null);
      if (pick) { suggestion = pick.token; suggested = suggested.replace(t, suggestion); any = true; }
    }
    tokens.push({ text: t, known, suggestion });
  }
  return { tokens, suggested: any ? suggested : null };
}

module.exports = { tokenize, buildDictionary, candidatesFor, suggestName, CONFUSE, OBSERVED };
