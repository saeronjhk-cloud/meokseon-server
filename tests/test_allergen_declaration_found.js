/**
 * 세션56 1단계 — 「법정 선언란을 «봤는가»」 신호 회귀
 *
 * ★ 이 파일이 지키는 것은 「알레르겐 판정이 맞는가」가 **아니다.**
 *   판정 정확도는 `test_allergen_sentinel.js` · `test_allergen_declared.js` 소관이다.
 *   여기 질문은 하나다 — **「우리가 라벨의 알레르기 표시란을 봤는지 말할 수 있는가」.**
 *
 * ★ 왜 필요한가 (설계 = `IP/알레르기_추론폐기_설계_2026-08-08_세션55.md` §4)
 *   세션55 까지 응답은 두 상태를 **구분하지 못했다**:
 *     ㉠ 선언란을 못 찾았다 (사진에 안 담김 · 영문 라벨 · OCR 실패) → `available:true, allergens:[]`
 *     ㉡ 선언란은 찾았는데 19종이 없다                            → `available:true, allergens:[]`
 *   둘이 같은 응답이므로 화면이 ㉠ 을 「알레르겐 없음」으로 읽는다 = **과소경고**.
 *   `ocrRoutes.js` 의 주석이 이 한계를 스스로 인정하고 있었다(세션54 §9-1 «조건 3»).
 *   ★ 이 조건 3 이 앱 고지 문구(`AllergenCard.tsx` `IncompleteNotice`)를 붙잡고 있던 마지막 항목이다.
 *
 * ⚠ **이 파일이 초록이어도 고지 문구를 내리지 말 것.**
 *   여기서 재는 것은 「선언란을 봤다고 «말할 수 있는가»」이지 「봤는지 정확히 아는가」가 아니다.
 *   OCR 이 선언란을 읽고도 세그먼트 분류에 실패하면 여전히 ㉠ 으로 떨어진다.
 *
 * ⚠ 제이 결정 2026-08-09 (D56-1, B안) — `allergens_available` 의 의미를 재정의했다.
 *   `available === false` 여도 `allergens`·`allergens_v2` 는 **null 이 아니다**(§3-3 근거).
 *   되돌리려면 도메인 결정이 먼저 있어야 한다. 기대값을 구현에 맞춰 고치지 말 것.
 *
 * ★★★ 뮤턴트 실측 (2026-08-09) — «잡은 것»과 «못 잡은 것»을 함께 적는다 (세션55 §5-3 형식)
 *
 *   뮤턴트                                                      이 파일   declared   path_parity
 *   MUT-1 declarationFound 를 항상 true                          7 실패 ✅   0 ❌        0 ❌
 *   MUT-2 mergeAllergensV2 합류 지점 누락 (/multi-photo 소실)      2 실패 ✅   0 ❌        —
 *   MUT-3 reconcile 이 flat(추론)으로 신호를 올린다                 5 실패 ✅   0 ❌        —
 *   MUT-4 mayContain 을 신호에서 제외 (혼입만 라벨 9건 소실)         4 실패 ✅   0 ❌        —
 *   MUT-5 알레르겐을 찾았을 때만 신호 (㉡ 관측 불가로 되돌림)          1 실패 ✅   0 ❌        —
 *   MUT-6 buildAllergenKeys 를 종전 `!!v2` 로 되돌림               5 실패 ✅   —          0 ❌
 *
 * ⚠⚠ **이 신호를 지키는 파일은 «이 파일 하나»다.**
 *   6종 전부 `test_allergen_declared`(66건) · `test_path_parity`(60건)에서 **0 실패**다.
 *   `SENTINEL_STRICT=1` 도 MUT-1 에서 통과한다.
 *   → 이 파일을 지우거나 §5 의 전사 68건이 사라지면 **재정의가 조용히 되돌아간다.**
 *   ★ 다음 세션이 「다른 회귀가 잡아 주겠지」로 읽지 않도록 명시해 둔다.
 *
 * ⚠ MUT-6 을 `path_parity` 가 못 잡는 이유(실측): 세션56이 그 파일의 대조군 텍스트에
 *   선언란(`밀 함유`)을 넣었기 때문에 옛 구현(`!!v2`)과 새 구현이 **그 입력에서는 같은 답**을 낸다.
 *   관측하려면 «선언란이 없는» 입력이 필요하고, 그것이 이 파일 §3-A·§3-C 다.
 *
 * 실행: node tests/test_allergen_declaration_found.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  detectAllergens, detectAllergensV2, hasExplicitDeclaration,
  mergeAllergensV2, reconcileAllergens,
} = require('../src/services/ocrParser');
const { buildAllergenKeys } = require('../src/routes/ocrRoutes');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

console.log('\n===== 세션56 선언란 탐지 신호 =====\n');

// ------------------------------------------------------------------
// §0. 표본 수 단정 — 「0/0/완벽」을 먼저 의심한다 (세션54 §7)
// ------------------------------------------------------------------
console.log('── §0. 표본 단정 ──────────────────────────────');

const TRANSCRIPT_DIR = path.join(__dirname, '..', '..', '.tmp', 'captures', 'transcripts');
let transcripts = [];
t('실물 라벨 전사 68건을 읽는다 (표본이 사라지면 아래 §5 가 의미를 잃는다)', () => {
  assert.ok(fs.existsSync(TRANSCRIPT_DIR), `전사 폴더가 없다: ${TRANSCRIPT_DIR}`);
  transcripts = fs.readdirSync(TRANSCRIPT_DIR).filter((f) => f.endsWith('.txt')).sort();
  assert.strictEqual(transcripts.length, 68,
    `전사 파일이 68건이 아니다(${transcripts.length}건) — 표본이 바뀌면 §5 기대값을 다시 재야 한다`);
});

// ------------------------------------------------------------------
// §1. 파서 단위 — declarationFound 가 «무엇을 보고» 서는가
// ------------------------------------------------------------------
console.log('\n── §1. 파서 단위 ─────────────────────────────');

t('§1-A 법정 선언 문구가 있으면 true', () => {
  assert.strictEqual(detectAllergensV2('알레르기 유발물질: 밀, 난류').declarationFound, true);
  assert.strictEqual(detectAllergensV2('우유, 밀 함유').declarationFound, true);
});

t('§1-B 원재료명만 있으면 false — 이것이 폐기 대상 경로다', () => {
  const v2 = detectAllergensV2('원재료명: 밀가루, 계란, 설탕');
  assert.strictEqual(v2.declarationFound, false,
    '원재료 추론 결과를 「선언란을 봤다」로 읽고 있다 — ㉠ 과 ㉡ 이 다시 붙는다');
});

t('§1-C ★ 혼입 문구만 있어도 true (실측 근거 — 68건 중 9건)', () => {
  // ⚠ 여기를 false 로 바꾸면 혼입만 있는 라벨 9건이 `available:false` 가 되고,
  //   `web/src/domain/meokseon/allergens.ts:56` 이 available===false 를 가장 먼저 보고
  //   즉시 uncollected 를 반환하므로 **혼입 경고가 화면에서 통째로 사라진다.** 과소경고다.
  const v2 = detectAllergensV2('본 제품은 메밀을 사용한 제조시설에서 같이 제조하고 있습니다');
  assert.strictEqual(v2.declarationFound, true);
  assert.ok(v2.mayContain.includes('메밀'), '이 케이스가 성립하지 않는다 — 혼입을 못 읽었다');
});

t('§1-D ★★★ 「선언란은 봤는데 19종이 없다」가 관측 가능하다 (㉡ 상태)', () => {
  // ★ 이 단정이 이 파일의 존재 이유다. `found.size` 와 무관하게 신호가 서야 한다.
  const v2 = detectAllergensV2('알레르기 유발물질: 해당 없음');
  assert.strictEqual(v2.declarationFound, true, '선언란을 봤는데 「못 봤다」고 한다');
  assert.strictEqual(v2.contains.length + v2.inferred.length + v2.mayContain.length, 0,
    '이 케이스가 성립하지 않는다 — 19종이 검출됐다');
});

t('§1-E 빈 입력·null 에서 false (없는 근거로 「봤다」고 하지 않는다)', () => {
  assert.strictEqual(detectAllergensV2('').declarationFound, false);
  assert.strictEqual(detectAllergensV2(null).declarationFound, false);
});

// ------------------------------------------------------------------
// §2. ★★★ 합류 지점 — 여기를 빠뜨리는 것이 이 저장소의 상습 사고다
//     (세션39 /multi-photo · 세션44 치명B)
// ------------------------------------------------------------------
console.log('\n── §2. 합류 지점 ─────────────────────────────');

const DECL = { contains: ['밀'], mayContain: [], inferred: [], evidence: [], declarationFound: true };
const NODECL = { contains: [], mayContain: [], inferred: ['대두'], evidence: [], declarationFound: false };

t('§2-A mergeAllergensV2 는 OR 다 — 한 장이라도 선언란을 담았으면 본 것이다', () => {
  assert.strictEqual(mergeAllergensV2(DECL, NODECL).declarationFound, true);
  assert.strictEqual(mergeAllergensV2(NODECL, DECL).declarationFound, true);
});

t('§2-B 둘 다 선언란이 없으면 false (OR 이 항상 true 로 굳지 않았다)', () => {
  assert.strictEqual(mergeAllergensV2(NODECL, NODECL).declarationFound, false);
});

t('§2-C 한쪽이 null 이어도 신호가 사라지지 않는다', () => {
  assert.strictEqual(mergeAllergensV2(DECL, null).declarationFound, true);
  assert.strictEqual(mergeAllergensV2(null, DECL).declarationFound, true);
});

t('§2-D ★ reconcileAllergens 는 flat 병합으로 신호를 «올리지» 않는다', () => {
  // flat(v1)의 2단계 폴백은 원재료 추론이다. 그것으로 「선언란을 봤다」고 하면 거짓 단정이다.
  const out = reconcileAllergens(['밀', '우유'], NODECL);
  assert.strictEqual(out.declarationFound, false,
    '추론 결과가 선언 탐지 신호를 올렸다 — ㉠ 이 ㉡ 으로 둔갑한다');
  assert.ok(out.inferred.includes('우유'), 'flat 병합 자체는 종전대로 동작해야 한다');
});

t('§2-E reconcileAllergens 는 선언 신호를 보존한다', () => {
  assert.strictEqual(reconcileAllergens([], DECL).declarationFound, true);
});

// ------------------------------------------------------------------
// §3. 응답 계약 — buildAllergenKeys
// ------------------------------------------------------------------
console.log('\n── §3. 응답 계약 ─────────────────────────────');

t('§3-A ㉠ 선언란 못 찾음 → available=false (화면이 「확인 못 함」)', () => {
  assert.strictEqual(buildAllergenKeys(['대두'], NODECL).allergens_available, false);
});

t('§3-B ㉡ 선언란 있고 19종 없음 → available=true + 빈 목록 (「확인했고 없다」)', () => {
  const empty = { contains: [], mayContain: [], inferred: [], evidence: [], declarationFound: true };
  const r = buildAllergenKeys([], empty);
  assert.strictEqual(r.allergens_available, true);
  assert.deepStrictEqual(r.allergens, []);
});

t('§3-C ★ 종전 `!!v2` 로 굳어 있지 않다 (그 구현은 항상 true 였다)', () => {
  // ⚠ `detectAllergensV2` 는 절대 null 을 반환하지 않는다(항상 객체). 세션56 실측.
  //   따라서 종전 `const available = !!v2` 는 **OCR 경로에서 아무것도 판별하지 않았다.**
  const alwaysTrue = buildAllergenKeys([], NODECL).allergens_available;
  assert.strictEqual(alwaysTrue, false, 'available 이 여전히 항상 true 다 — 재정의가 도달하지 않았다');
});

t('§3-D ★ B안 — available=false 여도 allergens·allergens_v2 를 버리지 않는다', () => {
  // 근거 ① `web/.../allergens.ts:56` 이 available===false 를 가장 먼저 보고 즉시 uncollected 를
  //        반환하므로 목록이 남아 있어도 **화면은 「확인 못 함」이다** → 앱 변경 0.
  //      ② 2단계(추론 폐기)에서 되돌릴 수 있어야 한다. 1단계가 정보를 버리면 되돌릴 수 없다.
  const r = buildAllergenKeys(['대두'], NODECL);
  assert.strictEqual(r.allergens_available, false);
  assert.ok(Array.isArray(r.allergens), 'B안이 뒤집혔다 — 결정(D56-1) 없이 A안으로 돌아갔다');
  assert.ok(r.allergens_v2 && Array.isArray(r.allergens_v2.inferred));
});

t('§3-E 판정이 아예 없으면(v2=null) available=false · flat_complete=null', () => {
  const r = buildAllergenKeys(null, null);
  assert.strictEqual(r.allergens_available, false);
  assert.strictEqual(r.allergens_flat_complete, null,
    '판정이 없는데 boolean 을 낸다 — 「정보 없음」과 「없음」이 섞인다');
});

t('§3-F 4키가 그대로다 (D4 계약 — 키를 줄이면 화면이 상태를 구분 못 한다)', () => {
  assert.deepStrictEqual(Object.keys(buildAllergenKeys([], DECL)).sort(),
    ['allergens', 'allergens_available', 'allergens_flat_complete', 'allergens_v2']);
});

// ------------------------------------------------------------------
// §4. 판별기 B 신호 — v1 도 같은 것을 말하는가
// ------------------------------------------------------------------
console.log('\n── §4. 판별기 B 신호 ─────────────────────────');

t('§4-A hasExplicitDeclaration 이 선언 문구를 잡는다', () => {
  assert.strictEqual(hasExplicitDeclaration('알레르기 유발물질: 밀'), true);
  assert.strictEqual(hasExplicitDeclaration('우유, 밀 함유'), true);
  assert.strictEqual(hasExplicitDeclaration('원재료명: 밀가루, 설탕'), false);
});

t('§4-B ★ B 와 C 의 신호가 «다른 것을 잰다»는 사실을 못 박는다', () => {
  // B 는 정규식으로 선언 «문구»를 뽑고, C 는 세그먼트를 선언으로 «분류»한다.
  // 혼입 문장에는 `함유` 가 없을 수 있으므로 B=false / C=true 가 정상이다.
  // ⚠ 이 둘을 같게 만들려 하지 말 것. 응답 계약은 C 를 쓴다.
  const txt = '본 제품은 메밀을 사용한 제조시설에서 같이 제조하고 있습니다';
  assert.strictEqual(hasExplicitDeclaration(txt), false);
  assert.strictEqual(detectAllergensV2(txt).declarationFound, true);
});

// ★★★ 세션58 2단계 — 이 칸의 «질문을 바꿨다». 지우지 않았다. 경위를 남긴다.
//   원래 질문: 「detectAllergens 의 출력은 1단계 리팩터링으로 바뀌지 않았다」
//     세션56 1단계는 정규식을 모듈 스코프로 올리는 «순수 리팩터링»이었고,
//     그때 이 칸은 「동작을 한 글자도 바꾸지 않았다」를 못 박는 안전핀이었다. 기대값은
//       detectAllergens('알레르기 유발물질: 우유, 밀') → ['밀','우유']
//       detectAllergens('원재료명: 밀가루, 설탕')      → ['밀']   ← 원재료 추론
//   왜 수명을 다했나 — **2단계는 출력을 바꾸는 것이 목적**이다(제이 결정 D55-2).
//     「바뀌지 않았다」를 계속 물으면 2단계가 성공할수록 빨간불이 된다. 질문이 틀린 것이다.
//   ⚠ 그렇다고 지우면 「원재료 추론 경로가 살아 돌아왔다」를 아무도 못 잡는다.
//     그래서 **반대 방향의 같은 세기**로 다시 세운다 — 「의도한 방향으로만 바뀌었다」.
t('§4-C ★ detectAllergens 의 «출력»이 2단계로 «의도한 방향으로만» 바뀌었다', () => {
  // ① 바뀌지 «않아야» 하는 쪽 — 법정 선언란은 그대로 읽는다.
  //    여기가 깨지면 2단계가 선언란 파싱까지 같이 부순 것이다(과소경고 = 즉시 되돌릴 사유).
  assert.deepStrictEqual(detectAllergens('알레르기 유발물질: 우유, 밀'), ['밀', '우유']);
  assert.deepStrictEqual(detectAllergens('우유, 밀 함유'), ['밀', '우유']);
  // ② 바뀌«어야» 하는 쪽 — 원재료 형태 추론(`밀가루`→밀)은 폐기됐다. 종전 기대값은 ['밀'].
  //    §1-B 가 「원재료명만 있으면 선언란을 못 본 것」이라고 판정한 그 입력이다.
  //    B(v1) 도 이제 그 판정과 «같은 말»을 한다 — 선언 문구가 없으면 읽을 것이 없다.
  assert.deepStrictEqual(detectAllergens('원재료명: 밀가루, 설탕'), [],
    '원재료 추론이 되살아났다 — D55-2 폐기가 풀렸는지 확인할 것');
  // ③ ★ 「없음」과 「확인 못 함」이 섞이지 않는다 — 이것이 ②를 안전하게 만든 전제다(설계 §5 순서).
  //    ②의 빈 배열은 화면에서 「알레르겐 없음」이 아니라 `available:false`(확인 못 함)로 나간다.
  assert.strictEqual(detectAllergensV2('원재료명: 밀가루, 설탕').declarationFound, false);
});

// ------------------------------------------------------------------
// §5. ★★★ 실물 68건 — 분포를 «수»로 못 박는다
// ------------------------------------------------------------------
console.log('\n── §5. 실물 라벨 68건 분포 ───────────────────');

const dist = { found: 0, notFound: [] };
for (const f of transcripts) {
  const text = fs.readFileSync(path.join(TRANSCRIPT_DIR, f), 'utf8');
  if (detectAllergensV2(text).declarationFound) dist.found++;
  else dist.notFound.push(f);
}

t('§5-A 선언란을 «본» 라벨이 60건이다', () => {
  assert.strictEqual(dist.found, 60,
    `실측 60건과 다르다(${dist.found}건) — 선언 탐지 규칙이 바뀌었다면 이 수를 다시 재고 근거를 남길 것`);
});

t('§5-B 선언란을 «못 본» 8건의 정체가 그대로다', () => {
  // 세션55 설계문서 §2 가 확인한 목록이다. 전부 알레르겐이 실제로 없는 제품이었다:
  //   007 원재료섹션 없음 · 012 멥쌀·쌀미강 · 046 영문 라벨 케첩 · 076 원당 ·
  //   080 참깨 · 088 정제수·이산화탄소 · 092 유기농 레몬주스 · 095 섹션 없음
  assert.deepStrictEqual(dist.notFound,
    ['007.txt', '012.txt', '046.txt', '076.txt', '080.txt', '088.txt', '092.txt', '095.txt']);
});

t('§5-C ★ 046(영문 라벨)이 「없음」이 아니라 「확인 못 함」으로 나간다', () => {
  // ★ 설계문서 §2 가 「추론 폐기의 유일한 실측 반례」로 지목한 라벨이다.
  //   선언란 추출에 실패했고 추론이 유일한 근거였다. 이제 그 사실을 «말할 수 있다».
  const text = fs.readFileSync(path.join(TRANSCRIPT_DIR, '046.txt'), 'utf8');
  const keys = buildAllergenKeys(detectAllergens(text), detectAllergensV2(text));
  assert.strictEqual(keys.allergens_available, false,
    '영문 라벨을 「확인했고 알레르겐 없음」으로 내보내고 있다 — 과소경고');
});

t('§5-D ★ 076(갈색설탕)의 추론 오탐도 「확인 못 함」에 가려진다', () => {
  // 원재료는 「원당」뿐인데 v1 2단계 폴백이 요리 안내문 「고추장(된장)」에서 대두를 추론했다.
  // 2단계에서 폴백을 제거하면 사라지지만, 1단계만으로도 화면에는 노출되지 않는다.
  const text = fs.readFileSync(path.join(TRANSCRIPT_DIR, '076.txt'), 'utf8');
  const keys = buildAllergenKeys(detectAllergens(text), detectAllergensV2(text));
  assert.strictEqual(keys.allergens_available, false);
});

t('§5-E ★ 「본 60건」이 전부 알레르겐을 낸 것은 아니다 (신호와 판정은 별개다)', () => {
  // 신호가 판정의 별칭이 되면 ㉡ 을 다시 못 말하게 된다. 두 축이 분리돼 있는지 확인한다.
  let declaredButEmpty = 0;
  for (const f of transcripts) {
    const text = fs.readFileSync(path.join(TRANSCRIPT_DIR, f), 'utf8');
    const v2 = detectAllergensV2(text);
    if (v2.declarationFound && !(v2.contains.length + v2.mayContain.length + v2.inferred.length)) declaredButEmpty++;
  }
  // ⚠ 현재 표본에서는 0건이다. **0 이라는 사실 자체를 기록**한다 —
  //   이 수가 0 이 아니게 되면 ㉡ 상태가 실물에서 처음 관측된 것이므로 조사 대상이다.
  assert.strictEqual(declaredButEmpty, 0,
    '실물에서 ㉡(선언란 있고 19종 없음)이 처음 나타났다 — 새 현상이므로 확인할 것');
});

// ------------------------------------------------------------------
console.log(`\n📊 세션56 선언란 탐지: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})\n`);
process.exit(fail === 0 ? 0 : 1);
