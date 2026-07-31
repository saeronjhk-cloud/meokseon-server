/**
 * 74-probe-basis-unknown.js — 안① 전환 영향 실측 (68건 캡처 전사 전수)
 * =========================================================================
 * 무엇을 재나 —
 *   `unknown → 판정 보류` 전환으로 **판정이 사라지는 라벨이 몇 건인가**.
 *   IP/basis_unknown_decision_2026-07-30.md §3 은 2건(2.9%)이라고 예측했다.
 *   그 예측이 맞는지 코드로 확인한다. **넘으면 원인을 확인해야 한다**(인수인계 §4 권고 3).
 *
 * 왜 실제 관문을 부르나 —
 *   ocrRoutes.judgeNutrition 이 basis 관문이다. 여기를 복사해서 재면
 *   관문이 아직 unknown 을 per_serving 으로 눙치고 있어도 프로브는 "2건 보류" 라고 보고한다.
 *   세션44 중대8(반쪽 적용)과 같은 함정이므로 **정본 함수를 그대로 부른다.**
 *
 * DB·네트워크 안 씀. 어디서나:
 *   node scripts/74-probe-basis-unknown.js
 *   node scripts/74-probe-basis-unknown.js --verbose
 */
'use strict';

const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const { judgeNutrition } = require('../src/routes/ocrRoutes');
const { parseNutrition, detectNutritionBasis, parseIngredients } = require('../src/services/ocrParser');

const VERBOSE = process.argv.includes('--verbose');
const DIR = path.join(__dirname, '..', '..', '.tmp', 'captures', 'transcripts');

if (typeof judgeNutrition !== 'function') {
  console.error('[중단] ocrRoutes.judgeNutrition 이 노출되지 않았다. src/routes/ocrRoutes.js 말미의 export 를 확인할 것.');
  process.exit(1);
}
if (!fs.existsSync(DIR)) {
  console.error(`[중단] 전사 디렉터리 없음: ${DIR}`);
  process.exit(1);
}

const files = fs.readdirSync(DIR).filter((f) => /^\d+\.txt$/.test(f)).sort();
console.log('=== 안① 전환 영향 실측 (basis unknown → 판정 보류) ===');
console.log(`전사 ${files.length}건 · ${new Date().toISOString()}\n`);

const basisDist = {};
const withheld = [];
const judged = [];
const notJudged = [];

for (const f of files) {
  const id = f.replace('.txt', '');
  const text = fs.readFileSync(path.join(DIR, f), 'utf8');

  let nutrition;
  try {
    nutrition = parseNutrition(text) || {};
  } catch (e) {
    console.log(`✗ ${id} parseNutrition 예외: ${e.message}`);
    continue;
  }

  const detected = (nutrition._basis) || (detectNutritionBasis(text) || {}).basis || 'unknown';
  basisDist[detected] = (basisDist[detected] || 0) + 1;

  // ocrRoutes 의 신호등 진입 조건과 동일하게 맞춘다.
  const enters = !!(nutrition.calories || nutrition.sodium || nutrition.total_sugars);
  if (!enters) {
    notJudged.push({ id, detected });
    continue;
  }

  let meta = {};
  try { meta = (parseIngredients(text) || {}).product_meta || {}; } catch (_) { /* 메타 없어도 진행 */ }

  const { trafficLight } = judgeNutrition({
    productData: {
      product_name: meta.product_name || null,
      food_type: meta.food_type || null,
      content_unit: nutrition.content_unit ?? null,
      serving_size: nutrition.serving_size ?? null,
      total_content: nutrition.total_content ?? null,
    },
    nutrition,
    labelText: text,
    explicitServingSize: nutrition.serving_size ?? null,
  });

  if (!trafficLight) { notJudged.push({ id, detected, why: 'trafficLight null' }); continue; }
  if (trafficLight.is_excluded) { notJudged.push({ id, detected, why: `제외:${trafficLight.exclude_reason}` }); continue; }

  if (trafficLight.is_withheld) {
    withheld.push({ id, detected, reason: trafficLight.withhold_reason, name: meta.product_name || '(제품명 없음)' });
  } else {
    judged.push({ id, detected });
  }
}

console.log('── basis 분포 (68건 전수) ────────────────────────────');
for (const [k, v] of Object.entries(basisDist).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${k.padEnd(18)} ${v}`);
}

console.log('\n── 판정 보류 라벨 ───────────────────────────────────');
for (const w of withheld) {
  console.log(`   ${w.id}  [${w.detected}]  ${w.reason}  — ${w.name}`);
}
const byReason = {};
for (const w of withheld) byReason[w.reason] = (byReason[w.reason] || 0) + 1;

console.log('\n── 요약 ─────────────────────────────────────────────');
console.log(`   신호등 판정 시도  : ${judged.length + withheld.length}건`);
console.log(`   그중 판정 보류    : ${withheld.length}건`);
for (const [k, v] of Object.entries(byReason)) console.log(`     · ${k}: ${v}건`);
console.log(`   신호등 진입 안 함 : ${notJudged.length}건 (영양소 전무 또는 카테고리 제외)`);

if (VERBOSE) {
  console.log('\n── 진입 안 한 라벨 ──');
  for (const n of notJudged) console.log(`   ${n.id} [${n.detected}] ${n.why || '영양소 없음'}`);
}

// ★ 회귀 성격의 상한. IP 문서 예측(basis_unknown 2건)을 초과하면 원인을 확인해야 한다.
const unknownWithheld = byReason.basis_unknown || 0;
console.log('');
if (unknownWithheld > 3) {
  console.log(`⚠ basis_unknown 보류 ${unknownWithheld}건 — IP 문서 예측(2건)을 크게 넘었다. 파서 퇴행을 의심할 것.`);
  process.exit(1);
}
console.log(`✅ basis_unknown 보류 ${unknownWithheld}건 (예측 2건, 상한 3건)`);
