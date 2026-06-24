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

/**
 * food_type 정확 매칭만 면제 적용(애매하면 null → 엔진 per-100g worse-of).
 */
function getRaccPolicy(foodType) {
  if (!foodType || typeof foodType !== 'string') return null;
  return RACC_MAP[foodType.trim()] || null;
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
