/**
 * 알레르겐 경로별 sentinel — 법정 19종 × {명시 표기, 원재료} 계약 검사.
 *
 * GT 정본: D:\서박사의 영양공식\backends\먹선\IP\allergen_sentinel_gt_v1_2026-08-06.json
 * 저장소 사본: tests/fixtures/allergen_sentinel_gt_v1.json  (IP 가 정본, 여기는 복사본)
 *
 * ★ 이 검사가 존재하는 이유
 *   외부검증 회신(2026-08-06) P2 — 「19종 전체의 경로별 최소 안전 계약을 확립하라」.
 *   세션51 교차검증에서, 두 조사가 각자 실데이터를 썼는데도 «표본에 그 항목이 없어서»
 *   결론이 뒤집혔다. 종합 정확도만 보면 그 구멍이 안 보인다.
 *   → 그래서 여기서는 «칸» 을 센다. 19종 각각이 각 경로에서 최소 한 번 실행됐는지를 단정한다.
 *
 * ★ 두 종류의 실패를 «구분해서» 보고한다
 *   contract   : 지금 성립해야 하는 계약. 깨지면 회귀다.
 *   known_gap  : P1 에서 고칠 대상. 수정 «전» 에는 실패가 정상이고, 수정 «후» 에 통과해야 한다.
 *   policy_pending : 제이 결정 전. ★판정하지 않고 현행 동작만 출력한다.
 *
 *   known_gap 을 그냥 실패로 두면 초록을 못 보고, 그냥 통과로 두면 고쳤는지 알 수 없다.
 *   그래서 «상태 전이» 를 본다 — 아래 SENTINEL_STRICT 참조.
 *
 * 실행
 *   node tests/test_allergen_sentinel.js              → known_gap 실패를 허용(EXIT 0)
 *   SENTINEL_STRICT=1 node tests/test_allergen_sentinel.js  → known_gap 도 통과해야 EXIT 0
 *
 *   P1 수정이 끝나면 SENTINEL_STRICT=1 이 초록이어야 한다. 그때 GT 의 status 를
 *   known_gap → contract 로 승격한다. **승격 전에 UI 고지 문구를 내리지 말 것.**
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { detectAllergens, detectAllergensV2 } = require('../src/services/ocrParser');
const { CANONICAL_19 } = require('../src/services/allergenName');

const STRICT = process.env.SENTINEL_STRICT === '1';

const GT_PATH = path.join(__dirname, 'fixtures', 'allergen_sentinel_gt_v1.json');
const gt = JSON.parse(fs.readFileSync(GT_PATH, 'utf8'));
const cases = gt.cases;

/**
 * 판별기 C 가 그 알레르겐을 «어떤 형태로든» 냈는가.
 * ★ 구획(contains/inferred/mayContain)을 합쳐서 본다.
 *   이 검사의 질문은 「경고가 나왔는가」이지 「어느 구획인가」가 아니다.
 *   구획 판정은 별도 계약(test_allergen_contract.js)이 본다. 한 검사가 두 질문을 섞으면
 *   실패했을 때 무엇이 깨졌는지 알 수 없다.
 */
function detectedByC(text, allergen) {
  const v2 = detectAllergensV2(text);
  return v2.contains.includes(allergen)
    || v2.inferred.includes(allergen)
    || v2.mayContain.includes(allergen);
}

function detectedByB(text, allergen) {
  return detectAllergens(text).includes(allergen);
}

// ------------------------------------------------------------
// 0. 커버리지 단정 — «표본 부재» 를 먼저 잡는다 (회신 쟁점1 권고)
//    규칙이 있는데 실행 표본이 0이면 '검증 완료' 가 아니라 UNEXERCISED 다.
// ------------------------------------------------------------
const coverageFailures = [];
{
  const byAllergen = new Map();
  for (const c of cases) {
    if (c.status === 'policy_pending') continue;   // 정책 미정 칸은 커버리지로 세지 않는다
    if (!byAllergen.has(c.allergen)) byAllergen.set(c.allergen, { declared: 0, ingredients: 0, pos: 0, neg: 0 });
    const e = byAllergen.get(c.allergen);
    e[c.path] = (e[c.path] || 0) + 1;
    if (c.expect === true) e.pos++;
    if (c.expect === false) e.neg++;
  }
  // ★ 세션55 — 축 매핑을 제거했다. 파서 표(`ALLERGEN_KEYWORDS`·`ALLERGEN_NAMES`)의 키를
  //   `난류(가금류)` 로 올려 A 와 통일했으므로, 여기서 이름을 되돌릴 이유가 없어졌다.
  //   종전 코드: `CANONICAL_19.map(n => n === '난류(가금류)' ? '난류' : n)`
  //   ⚠ 죽은 예외를 남기지 않는다(세션54 §10 — 해소된 예외는 즉시 제거).
  //     축이 다시 갈리면 `tests/test_allergen_axis.js` 가 먼저 빨간불이 된다.
  for (const a of CANONICAL_19) {
    const e = byAllergen.get(a);
    if (!e) { coverageFailures.push(`${a}: 케이스 0건 (UNEXERCISED)`); continue; }
    if (!e.ingredients) coverageFailures.push(`${a}: 원재료 경로 케이스 없음`);
    if (!e.pos) coverageFailures.push(`${a}: 양성 케이스 없음`);
    if (!e.neg) coverageFailures.push(`${a}: 음성 대조군 없음`);
  }
}

// ------------------------------------------------------------
// 1. 케이스 실행
// ------------------------------------------------------------
const results = { contractPass: 0, contractFail: [], gapPass: [], gapFail: [], pending: [] };

for (const c of cases) {
  if (c.status === 'policy_pending') {
    results.pending.push({
      id: c.id,
      text: c.text,
      B: detectedByB(c.text, c.allergen),
      C: detectedByC(c.text, c.allergen),
      why: c.why,
    });
    continue;
  }

  const gotC = detectedByC(c.text, c.allergen);
  const gotB = detectedByB(c.text, c.allergen);
  // ★ 두 판별기 «모두» 계약을 지켜야 한다. 한쪽만 맞으면 같은 응답에서 값이 갈린다(쟁점4).
  const ok = gotC === c.expect && gotB === c.expect;

  const rec = { id: c.id, allergen: c.allergen, path: c.path, text: c.text, expect: c.expect, B: gotB, C: gotC, why: c.why };

  if (c.status === 'known_gap') {
    (ok ? results.gapPass : results.gapFail).push(rec);
  } else if (ok) {
    results.contractPass++;
  } else {
    results.contractFail.push(rec);
  }
}

// ------------------------------------------------------------
// 2. 보고
// ------------------------------------------------------------
const line = (s) => console.log(s);
line('='.repeat(78));
line('알레르겐 경로별 sentinel — 법정 19종');
line(`GT: ${path.relative(process.cwd(), GT_PATH)}  (정본은 IP/allergen_sentinel_gt_v1_2026-08-06.json)`);
line(`모드: ${STRICT ? 'SENTINEL_STRICT=1 (known_gap 도 통과해야 함)' : '기본 (known_gap 실패 허용)'}`);
line('='.repeat(78));

if (coverageFailures.length) {
  line('');
  line(`⚠ 커버리지 미달 ${coverageFailures.length}건 — 표본이 없는 칸이 있다:`);
  for (const f of coverageFailures) line(`   · ${f}`);
} else {
  line('');
  line('✅ 커버리지: 19종 전부 원재료 경로 + 양성 + 음성 대조군 보유');
}

line('');
line(`계약(contract)  통과 ${results.contractPass} · 실패 ${results.contractFail.length}`);
for (const r of results.contractFail) {
  line(`   ❌ ${r.id}  기대 ${r.expect} / B=${r.B} C=${r.C}`);
  line(`      "${r.text}"`);
  line(`      ${r.why}`);
}

line('');
line(`알려진 갭(known_gap)  해소 ${results.gapPass.length} · 미해소 ${results.gapFail.length}`);
for (const r of results.gapFail) {
  line(`   🟠 ${r.id}  기대 ${r.expect} / B=${r.B} C=${r.C}   ← P1 수정 대상`);
  line(`      "${r.text}"`);
}
for (const r of results.gapPass) line(`   ✅ ${r.id}  해소됨 — GT 를 contract 로 승격할 것`);

line('');
line(`정책 미정(policy_pending) ${results.pending.length}건 — 판정하지 않고 현행 동작만 기록`);
for (const r of results.pending) {
  line(`   · ${r.id}  현행: B=${r.B} C=${r.C}`);
  line(`     "${r.text}"`);
}

line('');
line('='.repeat(78));

const hardFail = results.contractFail.length > 0 || coverageFailures.length > 0;
const strictFail = STRICT && results.gapFail.length > 0;

if (hardFail) {
  line(`❌ 계약 위반 ${results.contractFail.length}건 · 커버리지 미달 ${coverageFailures.length}건`);
  process.exit(1);
}
if (strictFail) {
  line(`❌ SENTINEL_STRICT=1 — 미해소 갭 ${results.gapFail.length}건`);
  process.exit(1);
}
line(`✅ 계약 ${results.contractPass}건 통과` + (results.gapFail.length ? ` (알려진 갭 ${results.gapFail.length}건은 P1 대상, 기본 모드에서 허용)` : ''));
process.exit(0);
