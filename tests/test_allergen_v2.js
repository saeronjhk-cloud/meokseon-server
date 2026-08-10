// test_allergen_v2.js — 알레르기 3분리(#114) Eval (Eval-First)
// SOURCE: 자문/알레르기_직접함유_혼입가능_분리_자문_2026-06-29.md (양측 수렴 7케이스 + 변형)
// 실행: node tests/test_allergen_v2.js   (순수 로직, DB 불필요)
//
// ★★★ 세션58 2단계 — 「알레르기 원재료 추론 폐기」(제이 결정 D55-2, 2026-08-08)
//   설계: `IP/알레르기_추론폐기_설계_2026-08-08_세션55.md` (§6 이 이 파일의 C4·C5·C8 을 지목했다)
//   무엇이 바뀌었나 — `detectAllergensV2` 가 `kind === 'ingredients'` 세그먼트를 **읽지 않는다.**
//     → `inferred`(원재료 추정) 구획은 이 함수에서 **항상 빈 배열**이다.
//   왜 — 알레르기 유발물질은 규정상 원재료명 표시란 «근처의 별도 표시란»에 함유량과 무관하게
//     전부 표기된다. `밀가루` 에서 `밀` 을 추론할 필요가 없다.
//     실측(라벨 68건): 추론의 «순수 추가분» 0종. v1 이 더 낸 4종 중 3종은 오탐이었다.
//   ⚠ 아래 C4·C5·C8 의 `inferred` 기대값은 「실행 결과에 맞춘 것」이 아니라
//     **이 도메인 결정이 정의한 값**이다. 되돌리려면 D55-2 를 먼저 뒤집어야 한다.
//   ⚠ 케이스는 하나도 지우지 않았다 — 질문을 「추론이 나오는가」에서
//     「추론이 «확실히» 사라졌는가 + 그 대가로 무엇을 잃는가」로 바꿨다.
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
  // ★★★ 세션58 — 종전 기대값 `inferred: ['대두','밀']`.
  //   `밀가루`→밀 · `간장`→대두 가 «원재료 형태 추론»의 교과서적 예시였고, 그것이 폐기 대상이다.
  //   이 라벨에는 법정 선언란이 없다 → 이제 3구획 전부 빈 것이 **정답**이다.
  //   ⚠ 「없음」이 아니라 「확인 못 함」으로 화면에 나가는 것은 `declarationFound:false` 가 담당한다
  //     (세션56 1단계 · `tests/test_allergen_declaration_found.js` §3-A). 이 파일의 질문이 아니다.
  ['C4 원재료명(밀가루·간장) → 아무것도 추론하지 않는다 (D55-2 추론 폐기)',
    '원재료명: 밀가루, 정제소금, 간장',
    { contains: [], mayContain: [], inferred: [] }],
  // ★★★ 세션58 — 종전 기대값 `inferred: ['우유']`(우유분말).
  //   ★ 이 케이스가 지키는 «진짜» 질문은 그대로 살아 있다 — 추론을 끊어도
  //     혼입 구획(메밀·땅콩)은 **한 종도 줄지 않는다.** 추론 폐기가 혼입 경로를 건드리면 여기가 빨간불이다.
  ['C5 원재료(우유분말) + 혼입(메밀·땅콩) — 혼입은 그대로, 추론만 사라진다',
    '원재료명: 우유분말, 설탕. 이 제품은 메밀, 땅콩을 사용한 제품과 같은 제조시설에서 제조합니다.',
    { contains: [], mayContain: ['땅콩', '메밀'], inferred: [] }],
  ['C6 ★함유가 혼입 문장 안에 → mayContain(함유로 오탐 금지)',
    '새우를 함유한 제품과 같은 제조시설에서 제조하고 있습니다.',
    { contains: [], mayContain: ['새우'], inferred: [] }],
  ['C7 OCR 띄어쓰기 붕괴(혼입) → mayContain',
    '땅콩혼입될수있습니다',
    { contains: [], mayContain: ['땅콩'], inferred: [] }],
  // ★★★ 세션58 — 종전 기대값 `mayContain:['대두'], inferred:['밀','우유']`.
  //   종전 규칙: 원재료에 «실제로» 있는 항목(inferred)은 혼입으로 «강등»하지 않는다(누락 방지).
  //   추론이 없어지면 그 보호막도 같이 없어진다 → `우유` 는 이제 혼입 문장에서만 읽히므로 mayContain 이다.
  //   ★ 이것이 D55-2 가 **의도적으로 받아들인 대가**다. 경고가 «사라지는» 것이 아니라
  //     「직접 함유 아님」 등급으로 «약해지는» 것이다. 우유는 여전히 화면에 뜬다.
  //   ★ 근거 — 이 가상 라벨에는 법정 선언란이 없다. 선언란이 있는 실물이라면 `우유 함유` 가
  //     별도 표시란에 인쇄되어 contains 로 잡힌다(68건 실측: 순수 추가분 0종).
  //   ⚠ 그러므로 이 케이스가 지키는 질문은 이제 「강등 방지」가 아니라
  //     **「혼입 항목이 소실되지는 않는다」**(우유가 어디에도 없으면 과소경고 = 회귀)이다.
  ['C8 원재료 우유 + 혼입 우유·대두 → 우유는 (강등되더라도) 소실되지 않는다',
    '원재료명: 우유, 밀가루. 우유, 대두를 사용한 제품과 같은 시설에서 제조.',
    { contains: [], mayContain: ['대두', '우유'], inferred: [] }],
  ['C9 알레르겐 없는 원재료 → 전부 빈',
    '원재료명: 정제소금, 설탕, 향료',
    { contains: [], mayContain: [], inferred: [] }],
  ['C10 명시 함유 + 별도 혼입 문장(우선순위·분리)',
    '난류, 우유 함유. 이 제품은 땅콩을 사용한 제품과 같은 제조라인에서 생산됩니다.',
    { contains: ['난류(가금류)', '우유'], mayContain: ['땅콩'], inferred: [] }],

  // ------------------------------------------------------------------
  // ★★★ 세션59 `U59-1` — 원재료명 줄에 붙은 «함유»를 어떻게 읽는가
  // ------------------------------------------------------------------
  //   정본: `IP/U59-1_수정안_확정_2026-08-09_세션59.md` (§5 회귀 목록 R1~R11)
  //
  //   무엇이 문제였나 — `_classifySegment` 가 맨몸 `/함유/` 를 `원재료명` 보다 먼저 검사해서,
  //     `아스파탐(감미료, **페닐알라닌함유**)` 하나로 원재료명 줄 전체가 `contains` 가 됐다.
  //     그러면 2단계 폐기(`kind === 'ingredients'` 건너뛰기)가 **우회**된다 — D55-2 의 뒷문이었다.
  //
  //   ⚠ 두 방향을 «같이» 봐야 한다. 한쪽만 고치면 반대쪽이 무너진다:
  //     · R7~R9  — 복합어를 선언으로 읽지 않는다        (과다경고 / 폐기 우회 차단)
  //     · R1~R6  — 진짜 선언은 원재료명 줄에 있어도 읽는다 (과소경고 차단. 실물 5건이 이 형태다)
  //   ⚠⚠ R5·R6 이 이 수정의 «가장 위험한» 지점이다. 법정 선언은 여러 이름의 나열이라
  //     `함유` 바로 앞 한 이름에서만 자르면 앞의 이름들이 **사라진다**(라벨에 인쇄된 알레르겐 소실).
  //     R5 가 `['밀']` 로 나오면 좌측 확장이 죽은 것이다.

  ['R1 실물 021 — 원재료명 줄 끝의 법정 선언 (과소경고 차단)',
    '원재료명: 콩 100 %[외국산(미국,브라질,파라과이 등)] 대두 함유',
    { contains: ['대두'], mayContain: [], inferred: [] }],
  ['R2 실물 031 — 「원재료명 및 함량」 + 우유 함유',
    '원재료명 및 함량: 국산 원유 100% 우유 함유',
    { contains: ['우유'], mayContain: [], inferred: [] }],
  ['R3 실물 098 — 선언이 «붙여» 인쇄된다 (`대두함유`)',
    '원재료명 콩 100 %[외국산(미국,브라질,파라과이 등)] · 대두함유',
    { contains: ['대두'], mayContain: [], inferred: [] }],
  ['R4 실물 082 — 선언이 대괄호 안에 있다',
    '원재료명 및 함량 : 대두 100 %(국산), 조제해수염화마그네슘, 현미유, 올리브유 [대두 함유]',
    { contains: ['대두'], mayContain: [], inferred: [] }],
  ['R5 ★★ 두 이름 나열 — 좌측 확장이 죽으면 «대두»가 사라진다',
    '원재료명: 밀가루, 정제소금, 대두, 밀 함유',
    { contains: ['대두', '밀'], mayContain: [], inferred: [] }],
  ['R6 ★★ 세 이름 나열 — 확장이 한 칸만 가면 2종이 사라진다',
    '원재료명: 밀가루, 정제소금, 우유, 대두, 밀 함유',
    { contains: ['대두', '밀', '우유'], mayContain: [], inferred: [] }],
  ['R7 ★ 페닐알라닌함유 — 복합어는 선언이 아니다 (폐기 우회 차단)',
    '원재료명: 밀가루, 정제소금, 아스파탐(감미료, 페닐알라닌함유)',
    { contains: [], mayContain: [], inferred: [] }],
  ['R8 ★ 같은 형태에서 대두유도 새지 않는다',
    '원재료명: 대두유, 정제소금, 아스파탐(페닐알라닌함유)',
    { contains: [], mayContain: [], inferred: [] }],
  ['R9 ★ 원재료에 법정명 자체가 있어도 «선언»은 아니다',
    '원재료명: 정제수, 우유, 아스파탐(감미료, 페닐알라닌함유)',
    { contains: [], mayContain: [], inferred: [] }],
  ['R10 ★★ 진짜 선언이 있어도 원재료 쪽 «밀가루»는 새지 않는다 (판정만 고치면 실패)',
    '원재료명: 밀가루, 대두유, 정제소금, 대두 함유',
    { contains: ['대두'], mayContain: [], inferred: [] }],
  ['R11 ★★ 확장이 «과다»로 새지 않는다 — 대두유는 법정명이 아니라 거기서 멈춘다',
    '원재료명: 밀가루, 대두유, 밀 함유',
    { contains: ['밀'], mayContain: [], inferred: [] }],
];

function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ★ 세션58 — `contractFail` 은 케이스 실패와 «별도»로 센다. 아래 요약의 `통과 N/10` 이
//   계약 위반 때문에 흔들리면 「10건 중 몇 건이 맞았나」라는 숫자의 뜻이 흐려진다.
let fail = 0, contractFail = 0, falseNeg = 0, falsePosContains = 0;
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
  // ★★★ 세션58 — 값이 «항상 빈 배열»이 됐다고 해서 **필드가 사라져도 된다는 뜻이 아니다.**
  //   위 C4·C5·C8 은 `inferred: []` 를 기대하는데, 만약 구현이 `inferred` 를 아예 «누락»시키면
  //   `r.inferred` 는 `undefined` 가 되고 `JSON.stringify(undefined) === undefined` 라
  //   `eq(undefined, [])` 가 false 이므로 위 비교는 잡는다. 하지만 그건 우연이다 — 명시로 못 박는다.
  if (!Array.isArray(r.inferred)) {
    contractFail++;
    console.log(`[FAIL] ${desc} — ★ 응답 계약 위반: inferred 필드가 배열이 아니다 (got=${JSON.stringify(r.inferred)})`);
  }
}

// ------------------------------------------------------------------
// ★★★ 세션58 — `inferred` «필드»의 생존 단정 (세션44 치명3 재발 방지)
// ------------------------------------------------------------------
//   무엇을 막는가 — 세션44 치명3: 「flat 에만 있는 알레르기가 화면에서 통째로 사라진다」.
//     클라이언트는 `allergens_v2` 가 비어 있지 않으면 flat `allergens` 를 «쓰지 않는다».
//     `reconcileAllergens` 가 flat 전용 항목을 담는 곳이 바로 `inferred` 구획이다.
//   ⚠ 2단계에서 `detectAllergensV2` 의 inferred «값»이 항상 빈 배열이 됐다.
//     그것을 보고 「이 필드는 죽었으니 지워도 된다」고 판단하면 치명3 가 되살아난다.
//     값이 비는 것과 필드가 없어지는 것은 **다른 사건**이다. 여기서 그 선을 긋는다.
{
  const shape = detectAllergensV2('원재료명: 밀가루, 설탕');
  for (const k of ['contains', 'mayContain', 'inferred', 'evidence']) {
    if (!Array.isArray(shape[k])) {
      contractFail++;
      console.log(`[FAIL] ★ 응답 계약 — detectAllergensV2 의 ${k} 가 배열이 아니다 (필드를 지웠는가?)`);
    }
  }
  // ★ 그리고 그 구획이 «실제로 쓰이는» 경로를 함께 못 박는다.
  //   추론은 폐기됐지만 `reconcileAllergens` 는 여전히 flat 전용 항목을 inferred 에 넣는다.
  //   여기가 비면 사용자가 원재료 텍스트를 추가로 보냈을 때 사진에서 얻은 종이 화면에서 소실된다.
  const { reconcileAllergens } = require('../src/services/ocrParser');
  const flat = ['게', '난류(가금류)', '우유'];
  const rec = reconcileAllergens(flat, { contains: [], mayContain: [], inferred: [], evidence: [] });
  const shown = new Set([...rec.contains, ...rec.mayContain, ...rec.inferred]);
  for (const a of flat) {
    if (!shown.has(a)) {
      contractFail++;
      console.log(`[FAIL] ★ 치명3 재발 — flat 의 ${a} 가 3분리 어디에도 없다 (화면에서 사라진다)`);
    }
  }
  if (!contractFail) console.log('\n[PASS] ★ inferred 필드 생존 — 값은 비었지만 구획은 살아 있다 (세션44 치명3 방지)');
}

console.log(`\n총 ${CASES.length} / 통과 ${CASES.length - fail} / 실패 ${fail}`);
console.log(`  ★ 응답 계약(inferred 필드 생존) 위반: ${contractFail}`);
console.log(`  ★ 혼입→직접함유 오탐(false-positive contains): ${falsePosContains}`);
console.log(`  ★ 직접함유 누락(false-negative): ${falseNeg}`);
console.log('합격선: 전 케이스 통과 AND 계약0 AND 오탐0 AND 누락0.'
  + (!fail && !contractFail && !falsePosContains && !falseNeg ? '  → GREEN' : '  → 미달'));
process.exit(fail || contractFail || falsePosContains || falseNeg ? 1 : 0);
