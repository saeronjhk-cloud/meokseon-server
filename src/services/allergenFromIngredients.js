'use strict';
/**
 * allergenFromIngredients.js — ★ 세션77 «DB 경로 전용» 알레르기: 원재료명(공공 데이터)에서 법정 19종을 찾는다.
 *
 * 정본 결정: 제이 2026-10-12 — 「데이터베이스를 기반으로 추론하는 경우에 한해서 변경. OCR 파싱은 여전히 유효」.
 *   · OCR 제보 경로(ocrParser · DS-6/6′/6″)는 손대지 않는다. 이 모듈은 ocrParser 가 부르지 않는다.
 *   · 공공 원재료(C002·C003·HACCP 원문 등)에는 알레르기 표시란이 없거나(제조사 표시란 미수집) 비어 있다.
 *     그런 제품에서만, 원재료명 토큰을 정본 사전(allergenName)으로 19종에 맞춘다.
 *   · 결과는 «저장하지 않는다». 응답에서 `allergens_from_ingredients` 로 «따로» 낸다(표시란 기반 allergens 와 섞지 않는다).
 *   · «없음»을 말하지 않는다: 원재료에 안 보인다고 알레르기가 없는 것이 아니다(복합원재료·혼입 미표기).
 * 규칙 파일: src/data/allergen_ingredient_rules.json (정본 IP/알레르기_원재료추론_v1/rules_v1.json)
 * eval: HACCP 원재료↔표시란 5,757쌍(.tmp/s77/a8.js) · 측정값은 인수인계 188.
 */
const { normalizeAllergenNames } = require('./allergenName');
const RULES = require('../data/allergen_ingredient_rules.json');

const TOK = /[\s,，、·ㆍ:：()（）[\]{}<>「」『』"'*+~=%\-–—0-9.\/;]+/;

function excluded(t) {
  if ((RULES.exclude_exact || []).includes(t)) return true;
  if ((RULES.exclude_suffix || []).some((s) => t.endsWith(s))) return true;
  if ((RULES.exclude_contains || []).some((s) => t.includes(s))) return true;
  return false;
}

/** @returns {{names: string[], evidence: {allergen: string, token: string}[], rules_version: string}} */
function allergensFromIngredients(raw) {
  const names = [], evidence = [], seen = new Set();
  for (const t of String(raw || '').split(TOK)) {
    if (!t || excluded(t)) continue;
    for (const h of normalizeAllergenNames(t)) {
      if (seen.has(h.name)) continue;
      seen.add(h.name); names.push(h.name); evidence.push({ allergen: h.name, token: t });
    }
  }
  return { names, evidence, rules_version: RULES.version };
}

module.exports = { allergensFromIngredients, _excluded: excluded };
