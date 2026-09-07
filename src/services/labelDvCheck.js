/**
 * labelDvCheck.js — 영양표 «%열»로 값을 교차검증한다 (세션68 U67-15)
 * ============================================================================
 *
 * 왜 이것이 있나
 *   Vision 원문 67건을 파서에 돌리니 알려진 오독이 한 묶음으로 나왔다:
 *     "포화지방 449 29%"  = 4.4g   (g 를 9 로 · 소수점 손실)
 *     "당류 249 24%"      = 24g    (g 를 9 로)
 *     "지방 42g 8%"       = 4.2g   (소수점 손실 — 세션67 삼치구이 32g 과 같은 종류)
 *     "지방 20g 4%"       = 2g
 *   한국 영양표는 값 «옆에» 1일 영양성분 기준치 비율(%)을 인쇄한다. 그 %는 같은 값을
 *   라벨 인쇄기가 «따로» 계산해 찍은 것이라 **값의 독립적인 두 번째 판독**이다.
 *   OCR 이 값을 틀려도 %까지 같은 방향으로 틀리는 일은 드물다.
 *
 * ⛔ 이 모듈은 값을 «고치지 않는다». 의심(suspect)과 가설(hypothesis)만 낸다.
 *   저장·승인 경로가 가설을 값으로 쓰면 그것이 곧 추정이다(P1). 가설은 «사람이 보는» 자리
 *   (검토 화면 · U67-11 정정 폼)에만 간다. 이 경계를 옮기지 말 것.
 *
 * 기준치 (식약처 「1일 영양성분 기준치」 · 2,000kcal)
 *   나트륨 2,000mg · 탄수화물 324g · 당류 100g · 지방 54g · 포화지방 15g · 콜레스테롤 300mg ·
 *   단백질 55g. 트랜스지방·열량은 %가 없다. ⚠ 이 표는 법정 상수다 — 라벨마다 다르지 않다.
 *
 * 허용 오차
 *   라벨의 %는 정수로 반올림된다 ⇒ 값의 참 범위는 ±0.5% × DV. 거기에 값 자체의
 *   표기 반올림(정수 g / 소수 1자리)을 더한다. 그 범위 밖이면 «불일치».
 *   ⚠ 표기 %가 0% 면 검증력이 없다(0~0.5% 어디든) — 그 경우 값이 DV×0.5% 를 «넘을 때만» 의심한다.
 */
'use strict';

/** 식약처 1일 영양성분 기준치 — 저장용 키 이름으로 적는다(CROWD_NUTRIENT_KEYS 와 같다). */
const DV = Object.freeze({
  sodium: 2000,          // mg
  total_carbs: 324,      // g
  total_sugars: 100,     // g
  total_fat: 54,         // g
  saturated_fat: 15,     // g
  cholesterol: 300,      // mg
  protein: 55,           // g
});

/** 라벨 표기 → 키. 긴 이름을 먼저 둔다(「포화지방」이 「지방」에 먹히지 않도록). */
const LABELS = [
  ['포화지방', 'saturated_fat'],
  ['트랜스지방', null],          // %가 없다 — 「지방」 매칭에서 제외하기 위해 둔다
  ['지방', 'total_fat'],
  ['탄수화물', 'total_carbs'],
  ['당류', 'total_sugars'],
  ['나트륨', 'sodium'],
  ['콜레스테롤', 'cholesterol'],
  ['단백질', 'protein'],
];

/**
 * 원문에서 «라벨 · 값토큰 · %» 삼중항을 뽑는다.
 *   "나트륨 1,530 mg ⏎ 77%"  → { key:'sodium', raw:'1,530', unit:'mg', pct:77 }
 *   "포화지방 449 29%"        → { key:'saturated_fat', raw:'449', unit:null, pct:29 }
 * 값과 % 사이는 짧은 공백·줄바꿈만 허용한다(다른 라벨을 건너뛰지 않는다 — 세션42 dualGap 의 교훈).
 */
function extractTriples(text) {
  const out = [];
  const src = String(text || '');
  for (const [label, key] of LABELS) {
    if (!key) continue;
    const guard = key === 'total_fat' ? '(?<!포화)(?<!트랜스)' : '';
    const re = new RegExp(
      guard + label + '(?:산)?[:\\s]{0,4}(\\d{1,4}(?:[.,]\\d{1,3})?)\\s{0,3}(mg|g)?[\\s\\n]{0,3}(\\d{1,3})\\s{0,2}%',
      'g',
    );
    let m;
    while ((m = re.exec(src)) !== null) {
      // ★ %열 덤프 방어 — Vision 이 표의 % 열을 통째로 이어서 낼 때가 있다(077 실물:
      //   "단백질 10g ⏎ 47% ⏎ 3% ⏎ 18%" — 47% 는 다른 행의 것이다). 잡힌 % 바로 다음 줄이
      //   «%만 있는 줄»이면 그 %는 이 값의 것이라고 믿을 수 없다 ⇒ weak. 검증에 쓰지 않는다.
      const rest = src.slice(m.index + m[0].length);
      const nextLine = (rest.split('\n').slice(1).find((l) => l.trim() !== '') || '').trim();
      const weak = /^\d{1,3}\s*%$/.test(nextLine);
      out.push({ key, label, raw: m[1], unit: m[2] || null, pct: Number(m[3]), index: m.index, weak });
      if (out.length > 64) break;
    }
  }
  return out;
}

function toNum(raw) {
  // 천단위 콤마: "1,530" → 1530. 소수 콤마: "1,99" 는 라벨에 없다(세션39 parseNum 과 같은 규칙).
  const s = String(raw);
  if (/^\d{1,3}(,\d{3})+$/.test(s)) return Number(s.replace(/,/g, ''));
  return Number(s.replace(',', '.'));
}

/**
 * 값 v 가 표기 % 와 «맞는가». 반올림 범위를 계산해 그 안이면 true.
 * @param {number} decimals 값 토큰의 소수 자릿수. 정수 표기("4g")는 참값이 ±0.5 안 어디든 있을 수 있다
 *   (092 실물: "단백질 4g 8%" — 8%×55=4.4 를 라벨이 4 로 반올림해 인쇄했다). 소수 1자리면 ±0.05.
 */
function consistent(key, v, pct, decimals = 1) {
  const dv = DV[key];
  if (!dv || !Number.isFinite(v) || !Number.isFinite(pct)) return null;
  const lo = Math.max(0, (pct - 0.5) / 100 * dv);
  const hi = (pct + 0.5) / 100 * dv;
  const tol = decimals === 0 ? 0.5 : 0.05;
  return v >= lo - tol && v <= hi + tol;
}

function decimalsOf(raw) {
  const s = String(raw).replace(/,/g, '');
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/**
 * 오독 «가설» 후보. 순서가 곧 우선순위다 — 가장 흔한 것부터.
 *   ÷10 · ÷100 : 소수점 손실("4.2g"→"42g")
 *   끝 9 제거   : 단위 g 를 9 로 읽음("24g"→"249")
 *   끝 9 제거 후 ÷10 : 둘 다("4.4g"→"449")
 */
function hypotheses(raw) {
  const s = String(raw).replace(/,/g, '');
  const v = Number(s);
  const out = [];
  if (Number.isFinite(v)) {
    out.push({ value: v / 10, reason: 'decimal_lost' });
    out.push({ value: v / 100, reason: 'decimal_lost' });
  }
  if (/^\d{2,}9$/.test(s)) {
    const t = Number(s.slice(0, -1));
    out.push({ value: t, reason: 'g_read_as_9' });
    out.push({ value: t / 10, reason: 'g_read_as_9+decimal_lost' });
  }
  return out;
}

/**
 * ★ 본문. 파서 결과(`parsed`)와 원문(`text`)을 받아 키별 판정을 낸다.
 *
 * @returns {{
 *   checked: Object<string,{value:number, pct:number, status:'ok'|'mismatch'|'weak'}>,
 *   suspects: Array<{key, parsed, pct, hypothesis:number|null, reason:string|null}>,
 * }}
 *   · checked[key].status  'ok' = 값이 %와 맞는다 · 'mismatch' = 안 맞는다 · 'weak' = %=0 이라 검증력 없음
 *   · suspects             mismatch 인 키. hypothesis 는 %와 맞아떨어지는 «첫» 가설(없으면 null).
 *
 * ⚠ 파서가 못 뽑은 키(parsed[key] 가 없음)도 원문에 «값 %»가 있으면 여기서 잡힌다 —
 *   그때 parsed:null · hypothesis 는 원문 토큰 기준이다. 검토자가 「파서가 놓친 값」을 본다.
 */
function dvCheck(parsed, text) {
  const p = parsed || {};
  const triples = extractTriples(text);
  const checked = {};
  const suspects = [];
  const seen = new Set();
  for (const t of triples) {
    if (seen.has(t.key)) continue;           // 같은 키가 여러 번(2열 표) — 첫 것만 본다
    seen.add(t.key);
    const tokenVal = toNum(t.raw);
    const parsedVal = (typeof p[t.key] === 'number' && Number.isFinite(p[t.key])) ? p[t.key] : null;
    const v = parsedVal !== null ? parsedVal : tokenVal;
    if (!Number.isFinite(v)) continue;
    const dec = decimalsOf(t.raw);

    if (t.weak) { checked[t.key] = { value: v, pct: t.pct, status: 'weak' }; continue; }

    if (t.pct === 0) {
      const cap = DV[t.key] * 0.005 + ((t.key === 'sodium' || t.key === 'cholesterol') ? 0.5 : 0.05);
      checked[t.key] = { value: v, pct: 0, status: v <= cap ? 'weak' : 'mismatch' };
      if (v > cap) suspects.push({ key: t.key, parsed: parsedVal, token: t.raw, pct: 0, hypothesis: null, reason: null });
      continue;
    }
    const ok = consistent(t.key, v, t.pct, dec);
    if (ok) { checked[t.key] = { value: v, pct: t.pct, status: 'ok' }; continue; }

    let hyp = null;
    for (const h of hypotheses(t.raw)) {
      // 가설값의 소수 자릿수는 «가설이 만든» 것이라 표기 반올림을 다시 허용하지 않는다(엄격 ±0.05)
      if (consistent(t.key, h.value, t.pct, 1)) { hyp = { value: Math.round(h.value * 100) / 100, reason: h.reason }; break; }
    }
    checked[t.key] = { value: v, pct: t.pct, status: 'mismatch' };
    suspects.push({
      key: t.key, parsed: parsedVal, token: t.raw, pct: t.pct,
      hypothesis: hyp ? hyp.value : null, reason: hyp ? hyp.reason : null,
    });
  }
  return { checked, suspects };
}

module.exports = { dvCheck, extractTriples, consistent, hypotheses, DV };
