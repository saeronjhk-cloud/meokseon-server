/**
 * ★ 세션75g — 첨가물 신호등 v3 규칙 엔진 (순수 함수 · 원칙 5 «엔진이 답한다»)
 *   설계 IP/첨가물신호등_v3/설계_v0.2_2026-10-05.md · 정답 IP/첨가물신호등_v3/gold_v1.json(30 · 동결 10-05)
 *   근거 DB 정본 IP/첨가물신호등_v3/evidence_v1.2.json · 사본 src/data/additive_evidence.json (현재 evidence_v1.2 · 131종 · 세션76)
 *   국내 기준 사본 src/data/additive_codex_domestic.json (식품첨가물공전 III · 665)
 *
 *   색(위에서부터 첫 일치):
 *     R0 물질 특정 불가(범주명)                  → gray
 *     R1 근거 0건                                 → gray
 *     R2 안전 결론 불가 · 안전성 사유 승인 철회     → red
 *     R3 IARC 1/2A — 물질 자체 · 식품 경로        → red
 *     R3b IARC 2B — 물질 자체 · 식품 경로          → orange
 *     R4 법정·조건부 집단/섭취형태 경고            → orange  (EU 색소 경고 · PKU · 아황산 · 니트로소화 조건)
 *     R5 수치 ADI(잠정 포함)                      → yellow
 *     R6 ADI 불필요 결론                          → green
 *     R6n 첨가물 평가 없이 영양소 상한(UL) 근거만   → blue  (75g-4 제이 결정 · 비타민B2·E 처럼 첨가물 평가가 있으면 R5/R6 우선)
 *     R7 ADI 설정 불가 결론이 가장 최신(세션76 · β-카로틴 JECFA 2019 철회) · 그 밖 → gray
 *        (R6n 보다 먼저 본다 — 첨가물 평가가 있으면 영양소 상한보다 우선 · 75g-4 원칙)
 *   R5·R6 은 «최신 평가» 우선 · 같은 해 결론이 갈리면 더 보호적인 색 + «기관 결론 불일치» 배지.
 *   배지는 색을 바꾸지 않는다(고섭취자 · 조합 · 불순물 · 영아 · 연구 동향 · 폴리올 제품조건 · 오래된 평가 · 철회 이력).
 *   IARC 행은 route === 'food' 일 때만 색에 쓴다(inhalation · context · impurity → 배지).
 */
'use strict';

const EVIDENCE = require('../data/additive_evidence.json');
const DOMESTIC = require('../data/additive_codex_domestic.json');

const COLORS = {
  red: { emoji: '🔴', label: '주의 근거 있음' },
  orange: { emoji: '🟠', label: '조건부 주의' },
  yellow: { emoji: '🟡', label: '사용기준 관리' },
  green: { emoji: '🟢', label: '현재 평가에서 수치 제한 불필요' },
  gray: { emoji: '⚪', label: '자료 부족 · 성분 특정 불가' },
  blue: { emoji: '🔵', label: '영양강화 성분 · 상한섭취량 관리' }, // 75g-4 제이 결정(10-05): 영양소는 ADI 가 아닌 UL 로 관리 → 별도 색
};
const COLOR_RANK = { blue: 0, green: 0, yellow: 1, orange: 2, red: 3 };

const IARC_NOTE = 'IARC 분류는 발암 근거의 강도이며 일상 섭취 위험도를 뜻하지 않아요';
const OLD_EVAL_YEARS = 20;

// finding → 역할. color 행만 색을 만들고, 나머지는 배지.
const ADI_COLOR = {
  adi_numeric: 'yellow', adi_temporary: 'yellow',
  adi_not_specified: 'green', adi_not_limited: 'green', no_safety_concern: 'green',
};
const R2_FINDINGS = new Set(['not_safe_conclusion', 'eu_authorisation_withdrawn']);
const R4_LABELS = {
  warning_label_children_eu: 'EU 어린이 활동·주의력 경고문 대상 색소',
  warning_label_pku: '페닐케톤뇨증 환자 주의(페닐알라닌 표시)',
  warning_label_sulfite: '아황산 민감자(천식 등) 표시 대상',
};
// 화면 문구는 한글만 — 근거 행의 badge_ko 가 있으면 그것, 없으면 일반 문구(영어 basis 노출 금지 · 75g-4)
const BADGE_TEXT = {
  high_consumer_concern: () => '고섭취자 기준 초과 가능',
  combo_risk: () => '제품 조합 주의',
  impurity_spec: () => '불순물 규격 관리',
  infant_use_specific: () => '영아 특수용도 별도 평가',
  research_trend: () => '연구 동향 — 인과 미확립',
  warning_label_polyol: () => '제품 조건: 폴리올 10% 초과 시 과다 섭취 설사 표시',
  adi_withdrawn: (r) => `이전 ADI 철회 이력(${r.source} ${r.year})`,
  reevaluation_ongoing: (r) => `재평가 진행 중(${r.source})`,
  allergy_reports: () => '알레르기 사례 보고',
  allergen_ingredient: () => '알레르기 표시 대상 원료',
  multi_substance: () => '여러 물질을 포괄하는 품목명 — 가장 엄격한 평가 기준', // 세션76 시클로덱스트린
  other_use_concern: () => '다른 용도(보충제 등) 평가의 우려 — 이 용도 평가 아님', // 세션76 홍국색소
};
const badgeText = (r) => r.badge_ko || BADGE_TEXT[r.finding](r);

const SRC = (r) => `${r.source} ${r.year}`;
const adiText = (r) => {
  if (r.finding === 'adi_numeric' || r.finding === 'adi_temporary') {
    const v = r.value == null ? '수치' : `${r.value}`;
    return `${r.finding === 'adi_temporary' ? '잠정 ' : ''}ADI ${v}${r.value == null ? '' : ' ' + (r.unit || '')}`.trim();
  }
  // 화면 문구는 한글만(75j 실화면 확인 — «JECFA 1973 not limited» 가 그대로 노출됐다)
  return { adi_not_specified: 'ADI 설정 불필요', adi_not_limited: 'ADI 제한 불필요', no_safety_concern: '안전성 우려 없음' }[r.finding];
};

function indexEvidence(ev) {
  const m = new Map();
  for (const r of ev.rows) {
    if (!m.has(r.additive)) m.set(r.additive, []);
    m.get(r.additive).push(r);
  }
  return m;
}
const EV_INDEX = indexEvidence(EVIDENCE);

// 이름 → 근거 키. 정확 일치 → 로마 숫자 꼬리(카라멜색소IV) 떼기.
function evidenceKey(name, idx) {
  if (idx.has(name)) return { key: name, family: false };
  const base = String(name).replace(/(I{1,3}|IV)$/u, '');
  if (base !== name && idx.has(base)) return { key: base, family: false };
  return null;
}

const USAGE_TEXT = {
  general_use: '일반 사용기준',
  quantity_limited: '식품별 최대 사용량 규정',
  prohibited_foods: '일부 식품군 사용 금지 규정',
  purpose_limited: '사용 목적 제한',
  flavor_only: '착향 목적에 한해 사용',
  remove_before_final: '최종 식품 완성 전 제거',
  other: '사용기준 있음(원문 확인)',
};
function domesticOf(name, dom) {
  const it = dom.items[name];
  if (it) {
    const parts = [USAGE_TEXT[it.u] || '사용기준 있음'];
    if (it.q && it.u !== 'quantity_limited') parts.push('최대 사용량 규정');
    return { listed: true, usage_type: it.u, has_quantity_limit: it.q, text: `국내: 식약처 허용 첨가물 · ${parts.join(' · ')}` };
  }
  const fam = Object.keys(dom.items).filter((k) => k.startsWith(name) && /^(I{1,3}|IV)$/u.test(k.slice(name.length)));
  if (fam.length) {
    return { listed: true, usage_type: 'family', has_quantity_limit: fam.some((k) => dom.items[k].q), family: fam,
      text: `국내: 식약처 허용 첨가물 · 종류(${fam.map((k) => k.slice(name.length)).join('·')})별 사용기준` };
  }
  return { listed: false, usage_type: null, has_quantity_limit: null, text: '국내: 공전 품목명과 정확히 일치하지 않음' };
}

/**
 * @param {string} name  공전 품목명(검출기 v2 name)
 * @param {{evidenceIndex?:Map, domestic?:object, asOfYear?:number, matchType?:string}} opt
 * @returns {{name, evidence_key, color, emoji, color_label, rule, reason, badges:{code,text}[], iarc_note:string|null, domestic, deciding:object[]}}
 */
function classifyAdditive(name, opt = {}) {
  const idx = opt.evidenceIndex || EV_INDEX;
  const dom = opt.domestic || DOMESTIC;
  const asOf = opt.asOfYear || new Date().getFullYear();
  const badges = [];
  const add = (code, text) => { if (!badges.some((b) => b.code === code && b.text === text)) badges.push({ code, text }); };
  // ⚪ 은 이름을 둘로 나눈다(75j 실화면): R0 = 성분 특정 불가(분류명·용도명) / 그 밖 = 자료 부족
  const grayLabel = (rule) => (rule === 'R0' ? '성분 특정 불가' : '자료 부족');
  const out = (color, rule, reason, deciding = [], key = null, iarcNote = null) => ({
    name, evidence_key: key, color, emoji: COLORS[color].emoji, color_label: color === 'gray' ? grayLabel(rule) : COLORS[color].label,
    rule, reason, badges, iarc_note: iarcNote,
    // 용도명만 적힌 표기(class_only)는 공전 «품목»이 아니므로 국내 기준 줄을 내지 않는다
    domestic: opt.matchType === 'class_only' ? null : domesticOf(key || name, dom), deciding,
  });

  if (opt.matchType === 'class_only') { return out('gray', 'R0', '용도명만 표시돼 어떤 물질인지 특정할 수 없어요'); }

  const ek = evidenceKey(name, idx);
  if (!ek) return out('gray', 'R1', '평가 근거를 아직 모으지 못했어요');
  const rows = idx.get(ek.key);
  if (ek.key !== name) add('family_unknown', `번호(I~IV) 미상 — «${ek.key}» 근거로 판정`);

  if (rows.some((r) => r.finding === 'category_not_substance')) {
    // 75j: 색 이름이 이미 «성분 특정 불가» — 같은 말의 배지는 내지 않는다
    return out('gray', 'R0', '개별 물질이 아닌 분류명이라 평가 대상을 특정할 수 없어요', [], ek.key);
  }

  // ── 배지(색 무관) ──
  for (const r of rows) if (BADGE_TEXT[r.finding]) add(r.finding, badgeText(r));
  for (const r of rows) {
    if (r.source !== 'IARC') continue;
    if (r.route === 'inhalation') add('iarc_non_food', `IARC 분류는 흡입 노출 기준 — 식품 섭취 평가 아님(${r.year})`);
    if (r.route === 'context' && r.finding !== 'iarc_3') add('iarc_context', r.badge_ko || 'IARC 분류는 섭취 맥락(식품군)에 대한 것 — 이 물질 자체 등급 아님');
  }
  const foodIarc = rows.filter((r) => r.source === 'IARC' && r.route === 'food');
  const iarcNote = foodIarc.some((r) => r.finding !== 'iarc_3') ? IARC_NOTE : null;

  // R5·R6 판정용 ADI 행(철회 행 제외) — 배지(불일치 · ADI 다름 · 잠정 · 오래됨)는 색과 무관하게 계산
  // ★ 세션76: 영양소(UL 행 보유)의 «향료 용도» 평가(basis «flavouring»)는 강화 목적 사용의 색을 정하지 않는다 → 배지
  //   (비타민B1: JECFA 2002 티아민염산염 향료 평가가 🟢를 만들어 비타민B1염산염 🔵과 어긋났다 · 75g-4 «첨가물 평가 우선»의 «첨가물 평가»에 향료 용도는 포함하지 않음)
  const isNutrient = rows.some((r) => r.finding === 'nutrient_ul' || r.finding === 'nutrient_ul_not_established');
  const flavourOnly = (r) => isNutrient && /flavouring/i.test(r.basis || '');
  for (const r of rows) if (ADI_COLOR[r.finding] && flavourOnly(r)) add('flavouring_use_only', `향료 용도 평가: ${adiText(r)}(${SRC(r)})`);
  const adiRows = rows.filter((r) => ADI_COLOR[r.finding] && !flavourOnly(r));
  // 기관별 최신 ADI 행(같은 해 여러 결론이면 보호적인 쪽) — 기관 «사이» 결론이 다를 때만 불일치(같은 기관 안 용도별 결론 차이는 제외 · 75g-4 바닐린)
  const latestBySrc = {};
  for (const r of adiRows) {
    const cur = latestBySrc[r.source];
    if (!cur || r.year > cur.year || (r.year === cur.year && ADI_COLOR[r.finding] === 'yellow')) latestBySrc[r.source] = r;
  }
  const adiColors = new Set(Object.values(latestBySrc).map((r) => ADI_COLOR[r.finding]));
  if (adiColors.size > 1) {
    add('agency_conflict', `기관 결론 불일치(${Object.values(latestBySrc).sort((a, b) => a.year - b.year).map((r) => `${SRC(r)} ${adiText(r)}`).join(' · ')})`);
  }
  const numeric = adiRows.filter((r) => r.finding === 'adi_numeric' && r.value != null);
  const srcVals = {};
  for (const r of numeric) (srcVals[r.source] = srcVals[r.source] || new Set()).add(r.value);
  if (Object.keys(srcVals).length > 1 && new Set(numeric.map((r) => r.value)).size > 1) {
    add('adi_differs', `기관 ADI 다름(${numeric.map((r) => `${SRC(r)} ${r.value}`).join(' · ')} ${numeric[0].unit || ''})`.replace(' )', ')'));
  }
  if (adiRows.some((r) => r.finding === 'adi_temporary')) add('temporary', '잠정 평가');

  // ── R2 ──
  const r2 = rows.filter((r) => R2_FINDINGS.has(r.finding));
  if (r2.length) {
    const others = adiRows.filter((r) => !r2.some((x) => x.source === r.source));
    if (others.length && !badges.some((b) => b.code === 'agency_conflict')) {
      add('agency_conflict', `기관 결론 불일치(${r2.map(SRC).join(' · ')} 안전 결론 불가 · ${others.map((r) => `${SRC(r)} ${adiText(r)}`).join(' · ')})`);
    }
    const reason = r2.map((r) => r.reason_ko || (r.finding === 'not_safe_conclusion' ? `${SRC(r)} 안전하다고 결론 내릴 수 없음` : `EU 식품첨가물 승인 철회(${r.year})`)).join(' · ');
    return out('red', 'R2', reason, r2, ek.key, iarcNote);
  }

  // ── R3 / R3b (물질 자체 · 식품 경로) ──
  const r3 = foodIarc.filter((r) => r.finding === 'iarc_1' || r.finding === 'iarc_2a');
  if (r3.length) return out('red', 'R3', `IARC ${r3[0].finding === 'iarc_1' ? '1군' : '2A군'}(${r3[0].year})`, r3, ek.key, iarcNote);
  const r3b = foodIarc.filter((r) => r.finding === 'iarc_2b');
  if (r3b.length) {
    add('iarc_2b', `IARC 2B — 일상 섭취 위험도를 뜻하지 않음`);
    const r4also = rows.filter((r) => R4_LABELS[r.finding]);
    for (const r of r4also) add(r.finding, R4_LABELS[r.finding]);
    return out('orange', 'R3b', `IARC 2B군(${r3b[0].year}) — 가능성 근거 제한적`, r3b, ek.key, iarcNote);
  }

  // ── R4 ──
  const r4 = rows.filter((r) => R4_LABELS[r.finding] || (r.finding === 'iarc_conditional_exposure' && r.route === 'food'));
  if (r4.length) {
    const reason = r4.map((r) => (r.finding === 'iarc_conditional_exposure'
      ? `IARC 2A는 체내 니트로소화 조건(가공육 등)에 대한 분류이며 물질 자체 등급은 아니에요`
      : R4_LABELS[r.finding])).join(' · ');
    return out('orange', 'R4', reason, r4, ek.key, iarcNote);
  }

  // ── R7a 가장 최신 결론이 «ADI 설정 불가»(세션76) — 수치·불필요 결론보다 새로우면 그 결론을 따른다(최신 평가 우선) ──
  const noAdi = rows.filter((r) => r.finding === 'no_adi_allocated').sort((a, b) => b.year - a.year);
  const maxAdiY = adiRows.length ? Math.max(...adiRows.map((r) => r.year)) : -Infinity;
  if (noAdi.length && noAdi[0].year > maxAdiY) {
    if (asOf - noAdi[0].year > OLD_EVAL_YEARS) add('old_evaluation', `오래된 평가(최신 ${noAdi[0].year})`);
    return out('gray', 'R7', `${noAdi[0].source}가 평가했으나 자료 부족으로 ADI를 정하지 않았어요(${noAdi[0].year})`, [noAdi[0]], ek.key, iarcNote);
  }

  // ── R5 / R6 (최신 평가 우선) ──
  if (adiRows.length) {
    const maxY = Math.max(...adiRows.map((r) => r.year));
    const latest = adiRows.filter((r) => r.year === maxY);
    const color = latest.some((r) => ADI_COLOR[r.finding] === 'yellow') ? 'yellow' : 'green';
    const deciding = latest.filter((r) => ADI_COLOR[r.finding] === color);
    if (asOf - maxY > OLD_EVAL_YEARS) add('old_evaluation', `오래된 평가(최신 ${maxY})`);
    const reason = [...new Set(deciding.map((r) => `${SRC(r)} ${adiText(r)}`))].join(' · '); // 세션76: 같은 문구 반복 제거(우유응고효소 키모신 3종)
    return out(color, color === 'yellow' ? 'R5' : 'R6', reason, deciding, ek.key, iarcNote);
  }

  // ── R6n 영양강화 성분(첨가물 ADI 평가 없음 · UL 근거 있음) ──
  const ul = rows.filter((r) => r.finding === 'nutrient_ul');
  const ulNone = rows.filter((r) => r.finding === 'nutrient_ul_not_established');
  if (ul.length || ulNone.length) {
    if (ul.length) {
      const adult = ul.filter((r) => /adult/i.test(r.basis || ''));
      const pool = adult.length ? adult : ul;
      const pick = pool.slice().sort((a, b) => (a.source === 'EFSA' ? -1 : 0) - (b.source === 'EFSA' ? -1 : 0) || b.year - a.year)[0];
      const who = /adult/i.test(pick.basis || '') ? '성인 ' : '';
      if (ul.some((r) => r !== pick && r.source !== pick.source && r.value !== pick.value && /adult/i.test(r.basis || ''))) {
        add('ul_differs', `기관 상한 다름(${ul.filter((r) => /adult/i.test(r.basis || '')).map((r) => `${SRC(r)} ${r.value}`).join(' · ')})`);
      }
      return out('blue', 'R6n', `영양강화 성분 — ${who}상한섭취량 ${pick.value} ${String(pick.unit || '').replace(/\/day$/, '/일')}(${SRC(pick)})`, [pick], ek.key, iarcNote);
    }
    const ko = ulNone.find((r) => r.reason_ko); // 세션76: 아미노산은 «자료 부족»으로 미설정 — 이상반응 없음과 구분
    return out('blue', 'R6n', ko ? ko.reason_ko : `영양강화 성분 — 과잉 섭취 이상반응 근거가 없어 상한섭취량 미설정(${ulNone.map(SRC).join(' · ')})`, ulNone, ek.key, iarcNote);
  }

  if (rows.every((r) => r.finding === 'not_evaluated' || BADGE_TEXT[r.finding])) {
    return out('gray', 'R7', '국제기구(JECFA·EFSA) 첨가물 평가 기록을 찾지 못했어요', [], ek.key, iarcNote);
  }
  if (rows.every((r) => r.finding === 'not_evaluated' || r.finding === 'adi_cited' || BADGE_TEXT[r.finding])) {
    return out('gray', 'R7', '다른 용도·다른 물질의 평가만 있어 색을 정할 근거가 부족해요', [], ek.key, iarcNote); // 세션76 proxy 원칙
  }
  return out('gray', 'R7', '색을 정할 평가 결론이 없어요', [], ek.key, iarcNote);
}

/** 검출기 v2 결과 배열에 신호를 붙인다(입력은 바꾸지 않음). */
function attachSignals(additives, opt = {}) {
  return (additives || []).map((a) => ({ ...a, signal: classifyAdditive(a.name, { ...opt, matchType: a.match_type }) }));
}

module.exports = { classifyAdditive, attachSignals, COLORS, COLOR_RANK, IARC_NOTE, _indexEvidence: indexEvidence };
