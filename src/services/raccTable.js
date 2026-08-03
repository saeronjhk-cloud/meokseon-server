/**
 * raccTable.js — 식약처 [표3] 1회섭취참고량(RACC) 60유형 조회  (2026-07-29 세션41)
 * ============================================================================
 * 정본 데이터: IP/food_type_racc_v1.json (식약처 「식품등의 표시기준」[표3] 원문 대조, 2026-06-24)
 *   구조: { _meta, map: { "<식품유형>": { racc, unit, src, note?, supplement? } } }
 *
 * ★ raccPolicy.js 의 RACC_MAP(13종) 과 무엇이 다른가 — 헷갈리면 안 된다
 *   raccPolicy.RACC_MAP : **소량섭취 면제 가드 전용** 13종(참기름·간장·고추장 등).
 *                         "이 제품은 조금밖에 안 먹으니 100g 환산 판정을 면제한다" 는 판단에 쓴다.
 *   raccTable(이 파일) : **1회 섭취량 환산용** 60종 전체.
 *                         "총 내용량 500g 을 1회 몇 g 으로 볼 것인가" 에 쓴다.
 *   목적이 다르므로 **RACC_MAP 을 이걸로 대체하면 안 된다.** test_racc_policy.js 16/16 이 그 계약을 지킨다.
 *
 * ★ 왜 정규화 계층이 필요한가 (json 의 _meta.integration_todo 가 이미 경고한 문제)
 *   products.food_type 실제 문자열과 표 키가 byte 단위로 안 맞는다. 세션40 실측 4건:
 *     가공김(조미김)      → 표 키 '조미김'    (괄호 **안**)
 *     프레스햄(살균제품)   → 표 키 '프레스햄'  (괄호 **밖**)
 *     소시지(살균제품)     → 표 키 '소시지'    (괄호 밖)
 *     과/채 주스          → 표 키 '과·채주스'  (분리자 + 공백)
 *   정확일치만 하면 이 넷이 전부 미매핑으로 떨어져 RACC 환산이 통째로 무력화된다.
 *
 * ★ 안전 원칙
 *   - 못 찾으면 **못 찾았다고 반환한다.** 근사값·추정값을 만들어 넣지 않는다.
 *   - 표에 값이 없는 것(racc:null, [표3] 공란 12키)과 매칭 실패는 **다른 상태**다.
 *     호출부가 구분할 수 있어야 안전 실패(per-100g fallback)를 설계할 수 있다.
 *   - 데이터 파일이 없어도 **throw 하지 않는다.** Railway 배포본에 IP 폴더가 없을 수 있고,
 *     RACC 표가 없다고 서버가 죽으면 안 된다. 빈 표로 degrade 하고 isLoaded()=false 를 알린다.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { resolveServing } = require('./raccPolicy');   // ★ 재구현 금지 — 검증된 규칙을 그대로 쓴다

// ── 데이터 로딩 ─────────────────────────────────────────────────────────────
// 제이 고정원칙 (3): IP 원본은 D:\<앱>\IP\ 에 보관하고 코드 저장소엔 **복사본만** 둔다.
//   → 1순위 src/data 복사본(배포에 포함), 2순위 상위 IP 원본(로컬 개발 시 최신본).
const CANDIDATE_PATHS = [
  path.join(__dirname, '..', 'data', 'food_type_racc_v1.json'),
  path.join(__dirname, '..', '..', '..', 'IP', 'food_type_racc_v1.json'),
];

let TABLE = {};          // { key: {racc, unit, src, note, supplement} }
let LOADED = false;
let LOADED_FROM = null;
let LOAD_ERROR = null;

function loadTable(paths = CANDIDATE_PATHS) {
  TABLE = {}; LOADED = false; LOADED_FROM = null; LOAD_ERROR = null;
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!j || typeof j.map !== 'object' || j.map === null) {
        LOAD_ERROR = `map 키 없음: ${p}`;
        continue;
      }
      TABLE = j.map; LOADED = true; LOADED_FROM = p;
      buildIndexes();
      return true;
    } catch (e) {
      LOAD_ERROR = `${p}: ${e.message}`;   // 다음 후보로 계속 — 하나 깨졌다고 포기하지 않는다
    }
  }
  buildIndexes();                           // 빈 인덱스라도 만들어 둔다(호출부 방어)
  return false;
}

// ── 정규화 ──────────────────────────────────────────────────────────────────
// ★★ 세션49 — 정규화 4종과 인덱스를 이 파일에서 들어냈다.
//   세션48 치명A 의 원인이 「이 파일에는 정규화가 있는데 raccPolicy 에는 없었다」였다.
//   같은 규칙이 두 파일에 각각 있으면 한쪽만 고쳐지고 다른 쪽은 몇 세션이고 무동작으로 남는다.
//   → src/services/foodTypeMatch.js 하나로 모았다. **동작은 그대로다**(함수 본문 그대로 이관).
//   test_racc_table.js 의 71 단정(L0~L4 전 계층 + 충돌 시 먼저 등록 키 유지)이 그것을 지킨다.
const { buildFoodTypeIndex, matchFoodType, _norm } = require('./foodTypeMatch');
const { stripSpace, stripSep, outsideParen, insideParen } = _norm;

let INDEX = null;

function buildIndexes() {
  INDEX = buildFoodTypeIndex(Object.keys(TABLE));
}

loadTable();

// ── 조회 ────────────────────────────────────────────────────────────────────
const MISS = Object.freeze({
  matched: false, matchLevel: null, key: null,
  racc: null, unit: null, supplement: false, src: null, note: null, ambiguousWith: null,
});

function hit(key, matchLevel, ambiguousWith = null) {
  const e = TABLE[key] || {};
  return {
    matched: true,
    matchLevel,
    key,
    racc: (e.racc === undefined ? null : e.racc),   // ★ null 은 "[표3] 공란" — 매칭 실패와 다르다
    unit: e.unit || null,
    supplement: e.supplement === true,
    src: e.src || null,
    note: e.note || null,
    // ★ 세션49 — L3(괄호 밖)과 L4(괄호 안)가 서로 다른 키에 걸린 경우. 판정은 종전대로 L3 우선이되
    //   모호했다는 사실을 남긴다. 조용히 한쪽을 고르면 나중에 왜 그 값이 나왔는지 알 수 없다.
    ambiguousWith,
  };
}

/**
 * 식품유형 → RACC 조회.
 * @param {string} foodType products.food_type 또는 라벨에서 읽은 식품유형
 * @returns {{matched, matchLevel, key, racc, unit, supplement, src, note, ambiguousWith}}
 *   matchLevel: 'L0' 정확 | 'L1' 공백무시 | 'L2' 분리자무시 | 'L3' 괄호밖 | 'L4' 괄호안
 *   ★ 매칭 규칙 본체는 foodTypeMatch.matchFoodType 에 있다(raccPolicy 와 공유).
 */
function lookupRacc(foodType) {
  const m = matchFoodType(INDEX, foodType);
  if (!m) return MISS;
  return hit(m.key, m.matchLevel, m.ambiguousWith);
}

/** 건강기능식품 여부 — 신호등 평가 제외 판정에 쓴다(evaluateNutrition excludedCategories 와 짝). */
function isSupplement(foodType) {
  return lookupRacc(foodType).supplement === true;
}

/**
 * 식품유형 + 라벨 1회량 → 실제 적용할 1회 제공량.
 * 규칙은 raccPolicy.resolveServing 을 그대로 재사용한다(라벨값이 RACC 의 0.5배 이상이면 라벨 우선).
 * @returns {{serving, source}} source: 'label' | 'racc' | 'label_fallback'
 */
function resolveServingFromRacc(foodType, labelServing) {
  const r = lookupRacc(foodType);
  const racc = (r.matched && typeof r.racc === 'number' && r.racc > 0) ? r.racc : null;
  const serving = resolveServing(labelServing, racc);
  let source;
  if (!racc) source = 'label_fallback';                 // 표에 값 없음 or 미매핑 → 라벨값(없으면 100)
  else if (serving === labelServing) source = 'label';
  else source = 'racc';
  return { serving, source, racc, unit: r.unit, matched: r.matched, matchLevel: r.matchLevel, key: r.key };
}

function isLoaded() { return LOADED; }
function loadedFrom() { return LOADED_FROM; }
function loadError() { return LOAD_ERROR; }
function tableSize() { return Object.keys(TABLE).length; }
function allKeys() { return Object.keys(TABLE); }

module.exports = {
  lookupRacc, isSupplement, resolveServingFromRacc,
  isLoaded, loadedFrom, loadError, tableSize, allKeys,
  // 테스트 전용 — 로딩 실패 degrade 검증에 쓴다
  _loadTable: loadTable,
  _norm: { stripSpace, stripSep, outsideParen, insideParen },
};
