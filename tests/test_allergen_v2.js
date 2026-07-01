// test_allergen_v2.js — 알레르기 3분리(#114) Eval (Eval-First)
// SOURCE: 자문/알레르기_직접함유_혼입가능_분리_자문_2026-06-29.md (양측 수렴 7케이스 + 변형)
// 실행: node tests/test_allergen_v2.js   (순수 로직, DB 불필요)
const { detectAllergensV2 } = require('../src/services/ocrParser');

// expected: {contains, mayContain, inferred} — 각 정렬된 배열
const CASES = [
  ['C1 혼입 문장(같은 제조시설) → mayContain만',
    '이 제품은 우유, 대두를 사용한 제품과 같은 제조시설에서 제조하고 있습니다.',
    { contains: [], mayContain: ['대두', '우유'], inferred: [] }],
  ['C2 명시 함유 → contains',
    '우유, 밀, 쇠고기 함유',
    { contains: ['밀', '쇠고기', '우유'], mayContain: [], inferred: [] }],
  ['C3 알레르기 유발물질: → contains',
    '알레르기 유발물질: 대두, 밀',
    { contains: ['대두', '밀'], mayContain: [], inferred: [] }],
  ['C4 원재료명(밀가루·간장) → inferred',
    '원재료명: 밀가루, 정제소금, 간장',
    { contains: [], mayContain: [], inferred: ['대두', '밀'] }],
  ['C5 원재료(우유분말) + 혼입(메밀·땅콩) 혼합',
    '원재료명: 우유분말, 설탕. 이 제품은 메밀, 땅콩을 사용한 제품과 같은 제조시설에서 제조합니다.',
    { contains: [], mayContain: ['땅콩', '메밀'], inferred: ['우유'] }],
  ['C6 ★함유가 혼입 문장 안에 → mayContain(함유로 오탐 금지)',
    '새우를 함유한 제품과 같은 제조시설에서 제조하고 있습니다.',
    { contains: [], mayContain: ['새우'], inferred: [] }],
  ['C7 OCR 띄어쓰기 붕괴(혼입) → mayContain',
    '땅콩혼입될수있습니다',
    { contains: [], mayContain: ['땅콩'], inferred: [] }],
  ['C8 중복(원재료 우유 + 혼입 우유·대두) → 우유는 inferred 유지, 대두만 mayContain',
    '원재료명: 우유, 밀가루. 우유, 대두를 사용한 제품과 같은 시설에서 제조.',
    { contains: [], mayContain: ['대두'], inferred: ['밀', '우유'] }],
  ['C9 알레르겐 없는 원재료 → 전부 빈',
    '원재료명: 정제소금, 설탕, 향료',
    { contains: [], mayContain: [], inferred: [] }],
  ['C10 명시 함유 + 별도 혼입 문장(우선순위·분리)',
    '난류, 우유 함유. 이 제품은 땅콩을 사용한 제품과 같은 제조라인에서 생산됩니다.',
    { contains: ['난류', '우유'], mayContain: ['땅콩'], inferred: [] }],
];

function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

let fail = 0, falseNeg = 0, falsePosContains = 0;
console.log('=== 알레르기 3분리(#114) v2 Eval ===\n');
for (const [desc, text, exp] of CASES) {
  const r = detectAllergensV2(text);
  const got = { contains: r.contains, mayContain: r.mayContain, inferred: r.inferred };
  const ok = eq(got.contains, exp.contains) && eq(got.mayContain, exp.mayContain) && eq(got.inferred, exp.inferred);
  if (!ok) {
    fail++;
    console.log(`[FAIL] ${desc}`);
    console.log(`   exp: ${JSON.stringify(exp)}`);
    console.log(`   got: ${JSON.stringify(got)}`);
  } else {
    console.log(`[PASS] ${desc}`);
  }
  // 안전 지표: 혼입인데 contains로 샜나(false-positive contains) / 함유인데 빠졌나(false-negative)
  for (const a of got.contains) if ((exp.mayContain || []).includes(a)) falsePosContains++;
  for (const a of exp.contains) if (!got.contains.includes(a)) falseNeg++;
}
console.log(`\n총 ${CASES.length} / 통과 ${CASES.length - fail} / 실패 ${fail}`);
console.log(`  ★ 혼입→직접함유 오탐(false-positive contains): ${falsePosContains}`);
console.log(`  ★ 직접함유 누락(false-negative): ${falseNeg}`);
console.log('합격선: 전 케이스 통과 AND 오탐0 AND 누락0.' + (!fail && !falsePosContains && !falseNeg ? '  → GREEN' : '  → 미달'));
process.exit(fail || falsePosContains || falseNeg ? 1 : 0);
