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
// ★ 세션40 추가: `용기`. 캡처 019(신라면컵) 라벨이 "1용기(65 g)당" 인데 목록에 없어서
//   basis 가 unknown 으로 떨어졌다. 라벨에 답이 적혀 있는데 어휘가 없어 못 읽은 것 —
//   하마터면 RACC 추정으로 넘어갈 뻔했다. **어휘 확장이 1차, 추정은 최후.**
//   함께 넣은 그릇/팩/매/줄/판/알/장은 실물에서 흔한 단위어(예방적).
const RE_SERVING = /1\s{0,4}(?:회\s{0,4}제공량|회분|회|봉지|봉|개입|개|포|스틱|컵|캔|병|조각|장|인분|용기|그릇|팩|매|줄|판|알|쪽|덩이)\s{0,4}\(?\s{0,4}(\d[\d,.]{0,12})\s{0,4}(g|㎖|ml|mL|kg|L)\s{0,4}\)?\s{0,4}당/;
// ★ 세션40 추가: 앞에 "1+단위어" 가 없는 단독 표기. 캡처 027(쇠고기볶음고추장) "60 g 당 140 kcal".
//   RE_PER100 을 먼저 검사하므로 "100 g 당" 이 여기로 새지 않는다(순서가 안전장치다).
// ★★ 세션42 검증 — `당` 뒤 경계가 없어 "탄수화물 250 g / 당류 0 g" 을 1회 제공량으로 오독했다.
//   한국 표준 영양성분표의 세로 배치가 정확히 이 형태다. 앱 파서에 역이식하면서 드러났다.
const RE_SERVING_BARE = /(?:^|[\s\n(])(\d[\d,.]*)\s*(g|㎖|ml|mL|kg|L)\s*당(?![가-힣])/;
// "총 내용량 당" · "총 내용량 500 g당" — 둘 다 총량 기준이다.
// ★★★ 세션44 역이식 (세션42 치명1 과 동일 결함이 정본에 남아 있었다).
//   기존 정규식은 `/총\s*내용량\s*당/` — **중량이 끼어든 형태를 못 읽었다.**
//   그리고 아래 detectBasis 에서 RE_SERVING_BARE **뒤에** 검사되고 있었다.
//   두 결함이 겹쳐서 "총 내용량 500 g당" 이 **1회 제공량 500 g** 으로 읽혔다(eval E01 실측).
//   총량을 1회분으로 읽으면 per_total 환산이 통째로 우회되고 신호등이 과대 판정한다.
//   ⚠ 앱 파서(src/services/ocrParser.js BASIS_TOTAL)는 세션42에 고쳤는데 정본은 그대로였다 —
//     "한쪽 파서만 고치기" 안티패턴. 세션43 006(정본만 정답)과 방향만 반대인 같은 사고다.
// ★★★ 세션44 서브에이전트 검증 — 역이식 초판이 **ReDoS 와 `당` 경계 누락을 함께 복사**했다.
//   ① ReDoS 실측: 공백 800자 0.5→124 ms / 1,600자 1.7→967 ms / 3,200자 7.4→**7,861 ms**(1,060배).
//      정본은 오프라인이라 원격 도달 경로는 없지만, 커밋 주석에 "상한 전수 적용" 이라고 적고
//      상한 없는 수량자 4개를 그대로 옮긴 것은 그 자체가 결함이다.
//   ② `당` 경계: `총 내용량 180 g` + `당류 11 g` + `60 g 당 140 kcal` 라벨에서
//      「당류」를 기준 표기로 읽어 serving(60) → **total** 로 뒤집혔다(거짓 초록 방향).
//      순서를 bare 앞으로 옮긴 것과 겹쳐 실제로 답이 바뀌었다.
//   ⚠ src/services/ocrParser.js BASIS_TOTAL 과 **문자 단위로 같아야 한다**(test_parser_parity.js).
const RE_TOTAL_BASIS = /총\s{0,4}내용량\s{0,4}(?:[:\s]{0,4}[\d,.]{0,12}\s{0,4}(?:g|㎖|ml|mL|kg|L)\s{0,4})?당(?![가-힣])/;
// ★ 세션44 역이식 (세션42 검증 중대5) — 1회 제공량이 따로 선언돼 있으면
//   "총 내용량 X" 단독 규칙을 억제한다.
//   "총 내용량 500 g / 1회 제공량 100 g" 을 total 로 보면 신호등이 RACC 로 **한 번 더** 나눠
//   거짓 초록이 된다. 근거가 모호하면 total 이라고 단정하지 않고 unknown 으로 남긴다.
//   ※ unknown 을 신호등이 어떻게 다룰지는 별건이다(인수인계 §6-3 — 제이 결정 대기).
const HAS_SERVING_DECLARED = /1\s*회\s*(?:제공량|분|섭취량)|1회\s*제공\s*기준/;
// ★ 세션40 추가: "총 내용량 X" 만 있고 기준 문구가 없는 유형 (캡처 68건 중 28건 — 최대 집단).
//   단품 포장은 1회분 = 총 내용량이라 라벨에 "당" 을 쓰지 않는다. 예: "총 내용량 62 g" / 다음 줄 "315 kcal".
//   이건 **추정이 아니다.** 라벨이 "이 표는 총 내용량 기준" 이라고 말하고 있는 것이다.
//   (168 g 과자를 한 번에 먹지 않는다는 건 별개 문제 — basis 가 아니라 **1회 섭취량**이고
//    식약처 RACC 가 담당한다. IP/food_type_racc_v1.json · src/services/raccPolicy.js resolveServing)
const RE_TOTAL_AMOUNT = /총\s*내용량[:\s]{0,20}(\d[\d,.]*)\s*(g|㎖|ml|mL|kg|L)/;

// ★ 세션44 — OCR 이 라벨 핵심어를 글자 단위로 쪼개는 경우를 입구에서 되붙인다.
//   `내 용 량` → `내용량` (캡처 096 "총 내용 량 당"). 다른 낱말과 충돌할 여지가 없는 조합만 다룬다.
//   ⚠ 이 함수는 **앱·정본 두 파서가 문자 단위로 같아야 한다**(tests/test_parser_parity.js 가 검사).
// ★ 공백 위치를 가정하지 않는다 — 096 실물은 「내용 량」 이었다(내·용 사이가 아니라 용·량 사이).
// ★★ 세션44 서브에이전트 검증(경미10) — 앞 경계를 요구한다. `국내 용량`·`안내 용량`·`체내 용량` 제외.
const RE_SPLIT_CONTENT_WORD = /(^|[\s:：(,.\n])내\s{0,3}용\s{0,3}량/g;
function normalizeLabelSpacing(text) {
  return String(text ?? '').replace(RE_SPLIT_CONTENT_WORD, '$1내용량');
}

function detectBasis(text) {
  // ★★ 세션44 중대8 — 앱 파서 detectNutritionBasis 와 같은 위치에서 정규화한다.
  //   detectBasis 는 parseLabel 밖에서도 직접 호출되므로(63-eval·테스트) 여기에도 있어야 한다.
  text = normalizeLabelSpacing(text);
  const m100 = text.match(RE_PER100);
  if (m100) return { basis: 'per100', amount: 100, unit: m100[1].toLowerCase() };
  const ms = text.match(RE_SERVING);
  if (ms) return { basis: 'serving', amount: num(ms[1]), unit: ms[2].toLowerCase() };
  // ★ 세션44 역이식 — 순서: 총량 명시 기준을 bare("N g 당") **보다 먼저** 본다.
  //   앱 파서 detectNutritionBasis 와 같은 순서여야 한다. 순서 자체가 안전장치다.
  if (RE_TOTAL_BASIS.test(text)) return { basis: 'total', amount: null, unit: null };
  const mb = text.match(RE_SERVING_BARE);
  if (mb) return { basis: 'serving', amount: num(mb[1]), unit: mb[2].toLowerCase(), bare: true };
  const mt = text.match(RE_TOTAL_AMOUNT);
  // ★ 세션44 역이식 — 1회 제공량 선언 가드(중대5).
  if (mt && !HAS_SERVING_DECLARED.test(text)) {
    return { basis: 'total', amount: null, unit: mt[2].toLowerCase(), from_total_only: true };
  }
  return { basis: 'unknown', amount: null, unit: null };
}

// ── 총 내용량 — "총 내용량 600g (120g x 5봉지)" / "총 내용량 1,500 mL" ────────
function detectTotalContent(text) {
  const m = text.match(/총\s*내용량[:\s]{0,20}(\d[\d,.]*)\s*(g|㎖|ml|mL|kg|L)/);
  if (!m) return { total: null, unit: null };
  return { total: num(m[1]), unit: m[2].toLowerCase() };
}

// ── 괄호 총열량 (세션43) ──────────────────────────────────────────────────
// `내용량 384 g (32 g x 12개) (1,740 kcal)` / `600 g(300 g x 2) (490 kcal)` / `총 내용량 30g(155 Kcal)`
// 배수표기와 다른 유형이다. 괄호 안에 kcal 하나뿐, 배수가 없다.
// 이 값은 문서에서 **가장 먼저 나오는 kcal** 이라서 최후 fallback 이 이것을 집는다.
// 026 은 1,740(12배) · 082 는 490(2배). 지금은 `당 N kcal` 규칙이 먼저 맞아 정답이 나오지만,
// `당` 한 글자가 OCR 에서 깨지면 그대로 거짓 빨강이 된다. 앱 파서와 같은 방어를 둔다.
// ★ 006 은 이 값이 **유일한 정답**(총량=1회분)이므로 지우기만 하면 안 된다 → 총량으로 보존해 폴백.
// ⚠ ReDoS 방지 — 간격 수량자에 전부 상한이 있다(세션42 치명2).
const RE_CTK_LABELED =
  /((?:총\s*)?내\s*용\s*량[^\n]{0,60}?)[(（]\s*(\d[\d,.]{0,12})\s*k?cal\s*[)）]/gi;
const RE_CTK_BARE =
  /(\d[\d,.]{0,12}\s*(?:g|kg|ml|mL|L|㎖|㎏)[^\n]{0,40}?)[(（]\s*(\d[\d,.]{0,12})\s*k?cal\s*[)）]/gi;
// ★★ 세션43 검증 — 초판 `당[\s:]` 는 원재료명의 `포도당 `·`정백당 `·`설탕 ` 에 걸려
//   평탄화 라벨에서 총열량 제거를 통째로 억제했다. `숫자+단위+당` 으로 좁힌다.
//   그리고 괄호 **앞**에 있을 때만 억제한다(뒤에 오는 선언은 다른 값에 붙은 것이다).
//   앱 파서 `RE_SERVING_DECLARED_INLINE` 와 동일하게 유지할 것.
const RE_CTK_SERVING_LINE =
  /1\s{0,4}회\s{0,4}(?:제공량|분(?![야])|섭취량|섭취참고량)|\d\s{0,4}(?:g|kg|ml|mL|L|㎖|㎏|개입|개|봉지|봉|포|스틱|컵|캔|병|조각|장|매|줄|판|알|쪽|인분|용기|그릇|팩)\s{0,4}\)?\s{0,4}당(?![가-힣])/;

/** offset 이 속한 줄에서 offset 앞부분만 잘라낸다. */
function _linePrefixBefore(text, offset) {
  const s = text.lastIndexOf('\n', offset - 1) + 1;
  return text.slice(s, offset);
}

/** 괄호 총열량을 후보 풀에서 빼고 값은 보존한다. 중량 표기는 남긴다(괄호만 제거). */
function stripContentTotalKcal(text) {
  const removed = [];
  let total = null;
  // ★ 검사는 매치가 아니라 **줄 전체**로 한다.
  //   BARE 매치는 `30 g (150 kcal)` 에서 시작하므로 `1회 제공량` 이 매치 밖에 있다.
  //   줄로 안 보면 `1회 제공량 30 g (150 kcal)` 의 1회분 열량을 총량으로 오인해 지운다.
  const take = (raw, kcal, offset, whole) => {
    const v = num(kcal);
    if (v == null) return false;
    const rel = Math.max(raw.lastIndexOf('('), raw.lastIndexOf('（'));
    if (RE_CTK_SERVING_LINE.test(_linePrefixBefore(whole, rel >= 0 ? offset + rel : offset))) return false;
    removed.push(raw.trim());
    if (total == null) total = v;
    return true;
  };
  let out = String(text ?? '').replace(RE_CTK_LABELED,
    (s, pre, kcal, off, whole) => (take(s, kcal, off, whole) ? `${pre} ` : s));
  out = out.replace(RE_CTK_BARE,
    (s, pre, kcal, off, whole) => (take(s, kcal, off, whole) ? `${pre} ` : s));
  return { cleaned: out, removed, total };
}

// ── 칼로리 (결함 ③④) — 기준치·총량 문구를 먼저 제거하고 찾는다 ─────────────
/**
 * @param {string} text
 * @param {string} [basisKind] detectBasis().basis — serving | total | per100 | unknown.
 *   괄호 총열량을 열량으로 쓸지 결정하는 데 쓴다. 1회분/100g 기준일 때는 쓰지 않는다.
 */
function extractCalories(text, basisKind) {
  const noise = [];
  let perUnitFromMultiplier = null;   // 배수 표기에서 건진 "개당" 값

  // ★★ 세션40 신설 — 배수 표기 kcal 은 **총량**이다. 캡처 019(신라면컵) 실물:
  //     중량:390 g(65 g×6입)
  //     열량:1,800 kcal(300 kcal×6입)     ← 레이블이 붙어 있어 최우선 규칙에 걸린다
  //     1용기(65 g)당 300 kcal            ← 정답
  //   기존 코드는 `(?:열량|칼로리)` 레이블을 1순위로 봐서 **1,800 을 집었다. 6배 과대.**
  //   거짓 초록(1/1000 축소)의 반대 방향이지만 같은 급이다 — 신호등이 **거짓 빨강**이 된다.
  //   멀쩡한 라면이 위험 식품으로 표시된다.
  //   처리: `X kcal(Y kcal×N)` 을 통째로 노이즈 제거하되, 괄호 안 Y 를 후보로 보존한다.
  //   (`당` 표기가 아예 없는 라벨에서는 Y 가 유일한 정답이 되므로 버리면 안 된다.)
  // ★★ 세션42 검증 — `[:\s]{0,20}` 는 ReDoS 였다(공백을 양쪽 다 먹는 수량자 중복). `[:\s]*` 로 축약.
  //   또 바깥값 < 괄호값 이면 배수 표기가 아니다 — 지우면 정답을 버리므로 건드리지 않는다.
  let t = text.replace(
    // ★★ 세션43: 상한 없는 `([\d,.]+)` 와 `[:\s]*` 가 8 KB 입력에서 82 ms 를 먹었다(치명2 계열).
    //   **모든** 수량자에 상한을 준다. 하나만 고치면 나머지가 그대로 O(n²)로 남는다.
    //   앱 파서 `RE_KCAL_MULTIPLIER` 와 반드시 동일하게 유지할 것.
    /(?:열량|칼로리)?[:\s]{0,20}([\d,.]{1,12})\s{0,4}kcal\s{0,4}[(（]\s{0,4}([\d,.]{1,12})\s{0,4}kcal\s{0,4}[×xX*]\s{0,4}\d{1,4}[^)）]{0,20}[)）]/gi,
    (s, outer, per) => {
      const o = num(outer); const p = num(per);
      if (o != null && p != null && o < p) return s;
      noise.push(s.trim());
      if (perUnitFromMultiplier == null) perUnitFromMultiplier = p;
      return ' ';
    }
  );

  // ★ 세션43: 괄호 총열량 제거 — 배수표기 제거 **뒤**. 규칙은 좁은 것부터.
  const ctk = stripContentTotalKcal(t);
  t = ctk.cleaned;
  for (const r of ctk.removed) noise.push(r);

  t = t
    .replace(/1\s*일\s*영양성분\s*기준치[^\n]*/g, (s) => { noise.push(s.trim()); return ' '; })
    // ★ 세션43: 상한 없는 `[\d,]+` 가 8 KB 입력에서 77 ms(치명2 계열). 앱 파서와 동일하게 상한.
    .replace(/[\d,]{1,12}\s*kcal\s*기준[^\n]*/g, (s) => { noise.push(s.trim()); return ' '; })
    .replace(/총\s*[\d,.]{1,12}\s*kcal[^\n]*/g, (s) => { noise.push(s.trim()); return ' '; });

  // ★ 세션43: 수량자 상한. `(\d[\d,.]*)\s*kcal` 는 `1,1,1,…`(4,950쌍) 입력에서 79 ms 였다.
  //   `[:\s]{0,20}` 도 세션42 치명2와 같은 중복이므로 `[:\s]{0,20}` 하나로 합친다.
  //   정본은 오프라인 스크립트라 원격 도달 경로는 없지만, 앱 파서와 규칙을 어긋나게 두지 않는다.
  const m = t.match(/(?:열량|칼로리)[:\s]{0,20}(\d[\d,.]{0,12})\s{0,4}kcal/i)   // 레이블 있는 경우
        || t.match(/당\s{0,4}(\d[\d,.]{0,12})\s{0,4}kcal/i)                    // "…(120g)당 500 kcal"
        || t.match(/(\d[\d,.]{0,12})\s{0,4}kcal/i);                            // 최후
  // 위에서 아무것도 못 찾았을 때만 배수 표기에서 건진 값을 쓴다 (라벨 명시값 우선)
  let calories = m ? num(m[1]) : perUnitFromMultiplier;

  // ★ 세션43: 그래도 없으면 괄호 총열량을 쓴다 — **기준이 총량일 때만.**
  //   006 대천김: `총 내용량 30g(155 Kcal)` 이 유일한 열량이고 총량=1회분이므로 정답이다.
  //   반대로 basis 가 serving/per100 이면 넣지 않는다. 026 이면 12배 과대(1,740)가 된다.
  //   열량이 비는 것이 12배 과대보다 낫다.
  if (calories == null && ctk.total != null
      && basisKind !== 'serving' && basisKind !== 'per100') {
    calories = ctk.total;
  }

  return {
    calories,
    removed_noise: noise,
    per_unit_from_multiplier: perUnitFromMultiplier,
    total_from_content: ctk.total,
  };
}

// ── 영양소 — 값 뒤 %기준치는 단위 불일치로 자동 배제된다 ────────────────────
const NUTRIENTS = [
  { key: 'sodium',        re: /나트륨[:\s]{0,20}(\d[\d,.]*)\s*(mg|㎎|g)/ },
  { key: 'total_carbs',   re: /탄수화물[:\s]{0,20}(\d[\d,.]*)\s*(g)/ },
  { key: 'total_sugars',  re: /당류[:\s]{0,20}(\d[\d,.]*)\s*(g)/ },
  { key: 'trans_fat',     re: /트랜스\s*지방(?:산)?[:\s]{0,20}(\d[\d,.]*)\s*(g)/ },
  { key: 'saturated_fat', re: /포화\s*지방(?:산)?[:\s]{0,20}(\d[\d,.]*)\s*(g)/ },
  { key: 'total_fat',     re: /(?<!포화\s)(?<!포화)(?<!트랜스\s)(?<!트랜스)지방[:\s]{0,20}(\d[\d,.]*)\s*(g)/ },
  { key: 'cholesterol',   re: /콜레스테롤[:\s]{0,20}(\d[\d,.]*)\s*(mg|㎎|g)/ },
  { key: 'protein',       re: /단백질[:\s]{0,20}(\d[\d,.]*)\s*(g)/ },
  { key: 'dietary_fiber', re: /식이섬유[:\s]{0,20}(\d[\d,.]*)\s*(g)/ },
  { key: 'calcium',       re: /칼슘[:\s]{0,20}(\d[\d,.]*)\s*(mg|㎎|g)/ },
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
// ★★ 세션44 2차 검증(경미K) — 여기가 정본에 마지막까지 남아 있던 O(n²) 였다.
//   `\n\s*` 의 `\s*` 가 개행을 포함하므로 개행런에서 시작 위치마다 전량을 훑는다 + 16개 대안.
//   실측(수정 전, `밀가루` + 개행 N): 1,200자 **697 ms** / 2,400자 **5,886 ms**(extractIngredients 경유).
//   ★ 방법론 메모 — 순수 개행 문자열(`'\n'.repeat(2400)`)로 재면 **0 ms** 로 나온다.
//     V8 의 1바이트 문자열 fast-path 때문이다. 한글을 1글자 섞어 2바이트 문자열로 만들어야 드러난다.
//     1차 검증이 이 결함을 놓친 이유와 같은 계열이다. **적대적 입력에 한글을 섞을 것.**
//   → `\s*` 에 상한. 라벨에서 줄바꿈 뒤 들여쓰기가 8자를 넘지 않는다.
const ING_STOP = /\n[\s]{0,8}(?:영양\s{0,4}(?:정보|성분)|소비기한|유통기한|보관방법|총?\s{0,4}내용량|포장재질|품목\s{0,4}보고|업소\s{0,4}명|제조원|반품|고객|표준번호|인증|사용|주의)/;

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
  // ★ 세션44 — 앱 파서 parseNutrition 과 같은 입구 정규화(「내 용 량」 → 「내용량」).
  //   순서: 어떤 규칙보다 먼저. basis·총내용량·괄호 총열량이 모두 이 낱말에 의존한다.
  text = normalizeLabelSpacing(text);
  const basis = detectBasis(text);
  const total = detectTotalContent(text);
  const cal = extractCalories(text, basis.basis);   // 세션43: 괄호 총열량 판단에 basis 가 필요하다
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
