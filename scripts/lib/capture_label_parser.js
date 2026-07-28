/**
 * capture_label_parser.js — 캡처 라벨 텍스트 → 구조화 영양/원재료 (2026-07-28 세션39)
 * ============================================================================
 * 설계 정본: backends/먹선/IP/manual_capture_pipeline_v1_2026-07-28.md §4
 *
 * ★ 왜 앱 파서(src/services/ocrParser.js)를 고치지 않고 새로 만드나
 *   앱 파서는 production 스캔 경로에서 돌고 있다. 캡처 적재 때문에 건드리면
 *   실사용자 스캔 결과가 같이 바뀐다. 여기서 검증이 끝난 뒤에 앱으로 역이식한다.
 *
 * ★ 실측으로 확인된 앱 파서의 결함 5개 (2026-07-28, 캡처 001·008·021 실물)
 *   ① 천단위 콤마 파괴 — `.replace(',', '.')` 가 "1,790mg" 을 **1.79** 로 만든다.
 *      신라면 나트륨 1,790mg → 1.79mg. 신호등이 완전히 뒤집힌다(거짓 초록).
 *   ② "1회" 외 표기 미인식 — 실물은 "1봉지(120g)당"(신라면) · "1개(12g)당"(맥심).
 *      앱 정규식은 `1회` 를 요구 → serving 미추출.
 *   ③ "열량" 레이블 없는 표 — 실물 표에는 "500 kcal" 만 있고 "열량" 이라는 글자가 없다.
 *      앱은 `열량` 키워드에 의존 → calories 실패.
 *   ④ kcal fallback 도박 — 한 라벨에 kcal 후보가 3개(정답 500 · 기준치 2,000 · 총량 2,500).
 *      앱의 `/(\d+)\s*kcal/` 는 무엇을 잡을지 텍스트 순서에 달려 있다.
 *   ⑤ 표기 기준 미기록 — 콩기름은 **100g당 지방 100g**. 1회분으로 취급하면
 *      "한 번에 지방 100g" 이 되어 판정이 무의미해진다.
 *
 * 입력: 라벨 이미지에서 전사한 텍스트(줄바꿈 보존 권장)
 * 출력: { basis, serving, nutrition, ingredients, report_nos, product_name, food_type, warnings }
 */
'use strict';

// ── 숫자 파싱 — 천단위 콤마와 소수점 콤마를 구분한다 (결함 ①) ──────────────
function num(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!/\d/.test(t)) return null;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return parseFloat(t.replace(/,/g, ''));  // 1,790 / 2,500 / 1,500.5
  if (/^\d+,\d{1,2}$/.test(t)) return parseFloat(t.replace(',', '.'));               // 1,5 = OCR이 소수점을 콤마로 읽은 경우
  return parseFloat(t.replace(/,/g, ''));
}

// ── 표기 기준 판정 (결함 ⑤) — 이게 1순위. 무엇을 읽었는지 모르면 값이 무의미하다 ──
const RE_PER100 = /100\s*(g|㎖|ml|mL|㎎|mg)\s*당/;
// 실물 표기 다양성: 1회 제공량 / 1봉지 / 1개 / 1포 / 1스틱 / 1컵 / 1캔 / 1병 / 1조각 / 1장 / 1인분
const RE_SERVING = /1\s*(?:회\s*제공량|회분|회|봉지|봉|개입|개|포|스틱|컵|캔|병|조각|장|인분)\s*\(?\s*(\d[\d,.]*)\s*(g|㎖|ml|mL|kg|L)\s*\)?\s*당/;
const RE_TOTAL_BASIS = /총\s*내용량\s*당/;

function detectBasis(text) {
  const m100 = text.match(RE_PER100);
  if (m100) return { basis: 'per100', amount: 100, unit: m100[1].toLowerCase() };
  const ms = text.match(RE_SERVING);
  if (ms) return { basis: 'serving', amount: num(ms[1]), unit: ms[2].toLowerCase() };
  if (RE_TOTAL_BASIS.test(text)) return { basis: 'total', amount: null, unit: null };
  return { basis: 'unknown', amount: null, unit: null };
}

// ── 총 내용량 — "총 내용량 600g (120g x 5봉지)" / "총 내용량 1,500 mL" ────────
function detectTotalContent(text) {
  const m = text.match(/총\s*내용량\s*[:\s]*(\d[\d,.]*)\s*(g|㎖|ml|mL|kg|L)/);
  if (!m) return { total: null, unit: null };
  return { total: num(m[1]), unit: m[2].toLowerCase() };
}

// ── 칼로리 (결함 ③④) — 기준치·총량 문구를 먼저 제거하고 찾는다 ─────────────
function extractCalories(text) {
  const noise = [];
  let t = text
    .replace(/1\s*일\s*영양성분\s*기준치[^\n]*/g, (s) => { noise.push(s.trim()); return ' '; })
    .replace(/[\d,]+\s*kcal\s*기준[^\n]*/g, (s) => { noise.push(s.trim()); return ' '; })
    .replace(/총\s*[\d,.]+\s*kcal[^\n]*/g, (s) => { noise.push(s.trim()); return ' '; });

  const m = t.match(/(?:열량|칼로리)\s*[:\s]*(\d[\d,.]*)\s*kcal/i)   // 레이블 있는 경우
        || t.match(/당\s*(\d[\d,.]*)\s*kcal/i)                        // "…(120g)당 500 kcal"
        || t.match(/(\d[\d,.]*)\s*kcal/i);                            // 최후
  return { calories: m ? num(m[1]) : null, removed_noise: noise };
}

// ── 영양소 — 값 뒤 %기준치는 단위 불일치로 자동 배제된다 ────────────────────
const NUTRIENTS = [
  { key: 'sodium',        re: /나트륨\s*[:\s]*(\d[\d,.]*)\s*(mg|㎎|g)/ },
  { key: 'total_carbs',   re: /탄수화물\s*[:\s]*(\d[\d,.]*)\s*(g)/ },
  { key: 'total_sugars',  re: /당류\s*[:\s]*(\d[\d,.]*)\s*(g)/ },
  { key: 'trans_fat',     re: /트랜스\s*지방(?:산)?\s*[:\s]*(\d[\d,.]*)\s*(g)/ },
  { key: 'saturated_fat', re: /포화\s*지방(?:산)?\s*[:\s]*(\d[\d,.]*)\s*(g)/ },
  { key: 'total_fat',     re: /(?<!포화\s)(?<!포화)(?<!트랜스\s)(?<!트랜스)지방\s*[:\s]*(\d[\d,.]*)\s*(g)/ },
  { key: 'cholesterol',   re: /콜레스테롤\s*[:\s]*(\d[\d,.]*)\s*(mg|㎎|g)/ },
  { key: 'protein',       re: /단백질\s*[:\s]*(\d[\d,.]*)\s*(g)/ },
  { key: 'dietary_fiber', re: /식이섬유\s*[:\s]*(\d[\d,.]*)\s*(g)/ },
  { key: 'calcium',       re: /칼슘\s*[:\s]*(\d[\d,.]*)\s*(mg|㎎|g)/ },
];

function extractNutrients(text) {
  const out = {};
  const units = {};
  for (const { key, re } of NUTRIENTS) {
    const m = text.match(re);
    if (!m) continue;
    out[key] = num(m[1]);
    units[key] = (m[2] || '').replace('㎎', 'mg').toLowerCase();
  }
  return { values: out, units };
}

// ── 품목보고번호 — "품목보고번호" 앵커 뒤에서만 찾는다(바코드·전화번호 오인 방지) ──
function extractReportNos(text) {
  const i = text.search(/품목\s*보고\s*번호/);
  if (i < 0) return [];
  const window = text.slice(i, i + 300);
  const found = [...window.matchAll(/(\d{10,14}(?:-\d{1,4})?)/g)].map((m) => m[1]);
  return [...new Set(found)];
}

// ── 제품명·식품유형 (정합성 대조용) ─────────────────────────────────────────
// 실물 라벨은 한 줄에 여러 필드가 들어간다("제품명 콩기름   내용량 1.5L").
// → 2칸 이상 공백 · 파이프 · 다음 필드 키워드에서 끊는다.
const FIELD_STOP = '(?=\\s{2,}|\\s*\\||\\s*(?:식품\\s*유형|내용량|중량|원재료|품목|업소|제조|소비기한|유통기한|포장재질|표준번호|종류|인증|보관|영양)|\\n|$)';

function field(text, label) {
  const m = text.match(new RegExp(label + '\\s*[:\\s|]*(.{1,40}?)' + FIELD_STOP));
  const v = m ? m[1].trim() : null;
  return v && v.length ? v : null;
}

function extractIdentity(text) {
  return {
    product_name: field(text, '제품\\s*명'),
    food_type: field(text, '식품\\s*유형'),
  };
}

// ── 원재료 ──────────────────────────────────────────────────────────────────
// ★ "영양정보 및 원재료명" 같은 **헤더**도 '원재료명' 을 포함한다(신라면 실물).
//    헤더를 잡으면 제품명·식품유형까지 원재료로 딸려 들어간다.
//    → 후보를 전부 뽑아 "쉼표가 많고 충분히 긴" 것을 고른다(진짜 원재료 목록의 특징).
const ING_STOP = /\n\s*(?:영양\s*(?:정보|성분)|소비기한|유통기한|보관방법|총?\s*내용량|포장재질|품목\s*보고|업소\s*명|제조원|반품|고객|표준번호|인증|사용|주의)/;

function extractIngredients(text) {
  const cands = [];
  const re = /원재료\s*명?\s*[:\s|]*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const rest = text.slice(m.index + m[0].length);
    const stop = rest.search(ING_STOP);
    const body = (stop >= 0 ? rest.slice(0, stop) : rest).replace(/\s*\n\s*/g, ' ').trim();
    if (body.length >= 10) cands.push(body);
  }
  if (!cands.length) return null;
  // 쉼표 밀도 우선, 동률이면 짧은 쪽(헤더에서 시작한 후보는 앞에 군더더기가 붙어 더 길다)
  cands.sort((a, b) => {
    const ca = (a.match(/,/g) || []).length, cb = (b.match(/,/g) || []).length;
    return cb - ca || a.length - b.length;
  });
  return cands[0];
}

// ── 메인 ────────────────────────────────────────────────────────────────────
function parseLabel(text) {
  const warnings = [];
  const basis = detectBasis(text);
  const total = detectTotalContent(text);
  const cal = extractCalories(text);
  const { values, units } = extractNutrients(text);
  const report_nos = extractReportNos(text);
  const identity = extractIdentity(text);
  const ingredients = extractIngredients(text);

  if (cal.calories != null) values.calories = cal.calories;

  // ── 게이트: 기준을 모르면 적재하지 않는다 (추정 금지) ──
  if (basis.basis === 'unknown') {
    warnings.push('BASIS_UNKNOWN: 1회분/총량/100g당 중 무엇인지 판정 불가 → 적재 거부');
  }
  if (basis.basis === 'serving' && !basis.amount) {
    warnings.push('SERVING_AMOUNT_MISSING: 1회 제공량(g/ml) 없음 → 환산 불가, 적재 거부');
  }
  if (basis.basis === 'total' && !total.total) {
    warnings.push('TOTAL_CONTENT_MISSING: 총 내용량 없음 → 환산 불가, 적재 거부');
  }
  if (cal.removed_noise.length) {
    warnings.push(`NOISE_REMOVED: ${cal.removed_noise.length}건 제외(${cal.removed_noise.join(' | ').slice(0, 120)})`);
  }
  if (!report_nos.length) warnings.push('REPORT_NO_MISSING: 라벨에서 품목보고번호를 못 찾음 → 이름 대조로 폴백');
  if (Object.keys(values).length < 4) warnings.push('NUTRIENTS_SPARSE: 추출 영양소 4개 미만 — 사진 품질 확인');
  // 단위 방어: 나트륨이 g 으로 잡히면 대개 오독
  if (units.sodium === 'g' && values.sodium > 5) warnings.push('SODIUM_UNIT_SUSPECT: 나트륨 단위 g 로 읽힘 — 확인 필요');

  return {
    basis: basis.basis,                 // serving | total | per100 | unknown
    basis_amount: basis.amount,         // serving 이면 1회 제공량, per100 이면 100
    basis_unit: basis.unit,
    total_content: total.total,
    total_unit: total.unit,
    nutrition: values,
    nutrition_units: units,
    ingredients,
    report_nos,
    ...identity,
    loadable: warnings.every((w) => !/적재 거부/.test(w)),
    warnings,
  };
}

module.exports = { parseLabel, num, detectBasis, extractCalories, extractNutrients, extractReportNos };
