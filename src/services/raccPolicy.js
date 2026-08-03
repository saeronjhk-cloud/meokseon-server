/**
 * RACC-aware small-use 정책 매핑 (영양 신호등 v1.4)
 * SOURCE: OneDrive→D:\먹선\IP\racc_policy_v1.md, food_type_racc_v1.json (식약처 [표3])
 *
 * getRaccPolicy(food_type) → { racc, unit, exempt, guards[], basis } | null
 * - exempt=true: per-100g 절대량 분기 면제, %DV(RACC serving) 판정 (단 guards 적용)
 * - guards: 'sodium'|'sugar'|'oil' 농축가드 (초록 금지 floor)
 * - 안전: 모호한 '소스'·'복합조미식품'은 미포함(=비면제, per-100g 유지). 명확한 소량식품만 면제.
 * - basis='imputed': [표3] 공란 추정치(공식 RACC 아님).
 */

const RACC_MAP = {
  // 식용유지류 (oil 가드: 지방 Green 금지)
  '참기름':   { racc: 5,  unit: 'g',  exempt: true, guards: ['oil'] },
  '들기름':   { racc: 5,  unit: 'g',  exempt: true, guards: ['oil'] },
  '올리브유': { racc: 5,  unit: 'g',  exempt: true, guards: ['oil'] },
  // 장류 (sodium 가드)
  '간장':     { racc: 5,  unit: 'ml', exempt: true, guards: ['sodium'] },
  '혼합장':   { racc: 10, unit: 'g',  exempt: true, guards: ['sodium'] },
  '된장':     { racc: 10, unit: 'g',  exempt: true, guards: ['sodium'] },
  '고추장':   { racc: 10, unit: 'g',  exempt: true, guards: ['sodium', 'sugar'] },
  // 식초
  '발효식초': { racc: 5,  unit: 'ml', exempt: true, guards: [] },
  // 조미김 (sodium 가드)
  '조미김':   { racc: 4,  unit: 'g',  exempt: true, guards: ['sodium'] },
  '김자반':   { racc: 5,  unit: 'g',  exempt: true, guards: ['sodium'] },
  // 당류 (sugar 가드)
  '당류가공품': { racc: 10, unit: 'g', exempt: true, guards: ['sugar'] },
  // 젓갈 (sodium 가드, [표3] 공란 → imputed)
  '젓갈':     { racc: 15, unit: 'g',  exempt: true, guards: ['sodium'], basis: 'imputed' },
  '양념젓갈': { racc: 15, unit: 'g',  exempt: true, guards: ['sodium'], basis: 'imputed' },
};

// ★★★ 세션49 — 치명A 수정. 여기가 「배선은 살아 있는데 한 번도 발동하지 않던」 지점이다.
//   세션47 이 이 함수를 두 라우트에 배선했지만 본체가 `RACC_MAP[foodType.trim()]` 정확 일치라
//   **캡처 68건 중 매칭 0건**이었다. 실측 미스: "가공김(조미김)" · "혼합장(살균제품)".
//   같은 저장소의 raccTable 이 이미 L0~L4 정규화로 같은 68건에서 43/68 을 맞히고 있었다.
//   → 정규화를 공용 모듈로 뽑아(src/services/foodTypeMatch.js) 양쪽이 같은 것을 쓴다.
//   ⚠ 부분 문자열 매칭은 하지 않는다. 정규화 후에도 전체가 같아야 매칭이다
//     ('초고추장'→'고추장', '양조간장'→'간장' 같은 근거 없는 면제를 만들지 않는다).
const { buildFoodTypeIndex, matchFoodType } = require('./foodTypeMatch');

const RACC_INDEX = buildFoodTypeIndex(Object.keys(RACC_MAP));

/**
 * food_type → 소량섭취 면제 정책.
 * @returns {{racc,unit,exempt,guards,basis?,matchedKey,matchLevel,ambiguousWith}|null}
 *   못 찾으면 null → 엔진이 종전대로 per-100g worse-of 로 판정한다(추정하지 않는다).
 *
 * ★ 반환 객체에 `matchedKey`/`matchLevel` 을 실어 보낸다. 「어떻게 매칭됐는가」가 보이지 않으면
 *   치명A 처럼 **매칭률 0 인 상태로 몇 세션이 지나간다.** 값과 근거는 항상 함께 흐른다.
 * ★ RACC_MAP 원본 객체를 그대로 돌려주지 않고 사본을 만든다 — 호출부가 변형해도
 *   다음 호출에 새지 않게(엔진이 guards 배열을 만지는 경로가 있다).
 */
function getRaccPolicy(foodType) {
  const m = matchFoodType(RACC_INDEX, foodType);
  if (!m) return null;
  const p = RACC_MAP[m.key];
  if (!p) return null;
  return {
    ...p,
    guards: Array.isArray(p.guards) ? [...p.guards] : [],
    matchedKey: m.key,
    matchLevel: m.matchLevel,
    ambiguousWith: m.ambiguousWith,
  };
}

/**
 * 섭취 기준 결정: label_serving 이 sane(≥0.5×RACC)면 라벨, 아니면 RACC.
 */
function resolveServing(labelServing, racc) {
  if (racc && racc > 0) {
    if (labelServing && labelServing > 0 && labelServing >= 0.5 * racc) return labelServing;
    return racc;
  }
  return labelServing || 100;
}

module.exports = { getRaccPolicy, resolveServing, RACC_MAP };
