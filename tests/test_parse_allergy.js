/**
 * test_parse_allergy.js — 세션50 `parseAllergy` 소실 결함 3건 회귀
 * ==========================================================================================
 * ★★★ 이 파일이 왜 있는가
 *
 *   `parseAllergy` 는 바코드 조회 화면에 뜨는 **「공적 출처(식약처 HACCP)」 알레르겐의
 *   유일한 생성기**다(측정 근거: `.tmp/s50/parse/FINDINGS.md` §1-2).
 *     scripts/17,18,23,24 → 19/26-apply-haccp*.js → scripts/lib/allergenUpsert.js
 *       → product_allergens → productModel.getAllergens() → productService.buildAllergens()
 *       → GET /api/products/:barcode
 *   그런데 파서 본체는 **6줄짜리 문자열 split** 이었다. 세션50 측정(전사 68건, Tier A 쌍 586개):
 *     · L1 미검출 99쌍(16.9%) — 원인의 84~90% 가 「구분자 빈약 + 15자 절단」
 *     · L2 이름 소실 89~103쌍 — 정본과 글자까지 일치하는 난류 계열 조각 **0종**
 *     · L4 오검출 2건
 *
 * ── 무엇을 고정하나 (수정 3건) ─────────────────────────────────────────────
 *   D1  `/알수없음|없음|해당없음/.test(s)` 가 **부분 일치**라 입력 어디에든 `없음` 이
 *       있으면 **입력 전체가 `[]`**. 전사 014 의 표준 라벨 항목 `해당없음` 한 줄 때문에
 *       같은 문서의 함유 8종 + 혼입 7종이 전부 소실됐다.
 *       ⚠ 「알레르겐이 진짜로 없다」는 정당한 입력은 계속 `[]` 여야 한다 → §4 가 그걸 지킨다.
 *   D2  구분자가 `, · / |` 4개뿐이라 개행·괄호·마침표·공백이 문장을 자르지 못하고,
 *       마지막 알레르겐이 뒤따르는 안내문을 통째로 삼킨 뒤 `length <= 15` 필터에 버려진다.
 *       잣 검출률 52%(최악) · 전사 031 은 **우유 제품인데 우유가 사라졌다** · 전사 013 은 **16자**.
 *   D3  정본 19종으로의 이름 매핑이 없어 `계란`·`알류`·`달걀`·`조개류(굴` 이 그대로 DB 로 간다.
 *       정본은 `IP/allergens_19_korea.json` = `src/services/allergenName.js` 의 CANONICAL_19.
 *
 * ── 이 파일이 지키는 규칙 (세션48 4차검증의 교훈) ─────────────────────────
 *   ① **소스 문자열을 검사하지 않는다.** 두 스크립트에서 함수를 그대로 import 해
 *      **실제로 호출한 결과 배열**만 단정한다. (소스 regex 단정은 세션46·47·48 에서 3번 뚫렸다.)
 *   ② **골든을 계산해 옮겨 적지 않았다.** 기대값은 전부 「원문에 실제로 등장하는 표면형」을
 *      손으로 읽어 `CANONICAL_19` 로 옮긴 것이다. 각 케이스에 표면형→정본 대응을 적어 뒀다.
 *      `normalizeAllergenNames` 로 기대값을 만들면 순환이 되므로 **쓰지 않았다.**
 *   ③ **고친 코드 경로를 실제로 지나는지 확인한다** (§6). 세션49 사고 — 「고쳤는데 픽스처가
 *      그 코드 경로를 한 번도 지나지 않아 뮤테이션 4종이 전부 통과」. 그래서 각 결함 케이스가
 *      **수정 전 구현(LEGACY)과 반드시 다른 답**을 내는지 단정한다. 다르지 않으면 그 케이스는
 *      결함을 구별하지 못하는 케이스이므로 **실패**다.
 *   ④ 19 와 26 두 사본이 **계속 같은 함수**인지 단정한다(한쪽만 고치는 사고 차단).
 *
 * ── 대장(KNOWN) 방식 — `tests/test_path_parity.js` 와 같다 ────────────────
 *   · 대장에 있고 값도 그대로   → 「미해결 결함」으로 보고, 기본 실행은 EXIT 0
 *   · 대장에 없는 새 불일치     → 실패 (회귀)
 *   · 대장에 있는데 이제 통과함 → **실패**. 고쳐졌으니 대장에서 지우라는 뜻이다.
 *     (이 마지막 규칙이 대장이 낡아 무의미해지는 것을 막는 유일한 장치다.)
 *
 * ── 실행 ──────────────────────────────────────────────────────────────────
 *   NODE_ENV=test node tests/test_parse_allergy.js
 *   NODE_ENV=test PARSE_ALLERGY_STRICT=1 node tests/test_parse_allergy.js
 *      → owner='parseAllergy' 인 미해결 결함을 실패로 센다. **수정 뒤 초록이어야 한다.**
 *      → owner 가 다른(소관 밖) 항목은 STRICT 에서도 실패로 세지 않는다. 보고만 한다.
 *
 * ⚠ DB 에 접속하지 않는다. 순수 함수 단위 회귀다.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { CANONICAL_19 } = require('../src/services/allergenName');
const A19 = require('../scripts/19-apply-haccp').parseAllergy;
const A26 = require('../scripts/26-apply-haccp-dump').parseAllergy;

// ══════════════════════════════════════════════════════════════════════════
// 0. 출력 (기존 테스트 파일들과 같은 형식)
// ══════════════════════════════════════════════════════════════════════════
let pass = 0;
let fail = 0;
const failures = [];
const openIssues = [];   // 대장과 값이 일치하는 미해결 결함

function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, message: e.message });
    console.log(`  ❌ ${name}\n     → ${e.message}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

// ══════════════════════════════════════════════════════════════════════════
// 1. 수정 전 구현 (LEGACY) — **기대값 계산에 쓰지 않는다.**
//    §6 에서 「이 케이스가 결함을 실제로 구별하는가」를 확인하는 용도로만 쓴다.
//    scripts/19-apply-haccp.js:51 (2026-08-01 시점) 을 한 글자도 바꾸지 않고 옮긴 것이다.
// ══════════════════════════════════════════════════════════════════════════
const LEGACY_parseAllergy = (s) => {
  if (!s || /알수없음|없음|해당없음/.test(s)) return [];
  return s.replace(/함유|포함/g, '').split(/[,·\/|]/).map((x) => x.trim()).filter((x) => x && x.length <= 15);
};

// ══════════════════════════════════════════════════════════════════════════
// 2. ★★★ 알려진 결함 대장 (KNOWN)
//    key = 케이스 id. owner='parseAllergy' 는 세션50이 고칠 것,
//    owner 가 다른 것은 **소관 밖**(다른 파일이 고쳐야 한다)이라 STRICT 에서도 안 센다.
// ══════════════════════════════════════════════════════════════════════════
const KNOWN = {
  // ── D1 / D2 / D3 ────────────────────────────────────────────────────────
  //  ✅ 세션50 에 전부 고쳐져 **대장에서 제거**했다 (13건).
  //     · D1 `/없음/` 부분일치 전면 무효화 → 절 단위 무효화
  //     · D2 15자 절단 + 문장 미분리       → 문장·괄호·공백 분리 + 사전 기반 선별
  //     · D3 비정본 이름                   → CANONICAL_19 로 반환
  //  지운 줄을 되살리려는 사람에게: 되살리면 그 케이스는 「대장이 낡았다」로 실패한다.

  // ── 소관 밖 (보고만 — STRICT 에서도 실패로 세지 않는다) ─────────────────
  //  ✅ 세션53 에 해소돼 **대장에서 제거**했다 (1건).
  //     · X-fp-mil `'밀폐'·'밀봉'→밀`
  //       원인은 `allergenName.js` 에 밀 경계 가드가 «아예 없던» 것이었다. 그 파일 주석은
  //       「`밀크` 를 막으면 `통밀크래커` 의 밀까지 잃는다」는 이유로 가드를 두지 않았는데,
  //       **걱정만 맞고 대가를 재지 않은 판단**이었다. 실측하니 GT 740종 중 530종·10,812회를
  //       밀로 오판하고 있었다(밀납 4,829회 · 밀크씨슬 2,368회 · 당밀 · 패밀리 · 아밀라아제…).
  //       세션53 이 토큰 앵커 가드를 넣어 FP 를 2종·9회로 줄이면서 `통밀크래커` 는 지켰다.
  //       ⚠ `X-fp-tongmil` 케이스가 그 손실을 지키고 있다. 지우지 말 것.
  //  지운 줄을 되살리려는 사람에게: 되살리면 그 케이스는 「대장이 낡았다」로 실패한다.
};

// ══════════════════════════════════════════════════════════════════════════
// 3. 케이스 — 입력은 **원문 그대로**, 기대값은 **표면형 → CANONICAL_19** 손 유도
// ══════════════════════════════════════════════════════════════════════════
const TR = path.join(__dirname, '..', '..', '.tmp', 'captures', 'transcripts');

const CASES = [
  // ───────────────────────────────────────────────────────────────── D1 ──
  {
    id: 'D1-014-full',
    title: 'D1 · 전사 014 — 라벨의 `해당없음` 한 줄이 같은 문서의 15종을 지운다',
    /**
     * 원문 그대로 (`.tmp/captures/transcripts/014.txt` 28·45·52행, 전사의 줄 순서 유지).
     * 표면형 → 정본:
     *   45행  밀→밀 · 대두→대두 · 계란→난류(가금류) · 우유→우유 · 쇠고기→쇠고기 ·
     *         돼지고기→돼지고기 · 닭고기→닭고기 · 조개류(굴,홍합 포함)→조개류      = 8종
     *   52행  메밀→메밀 · 토마토→토마토 · 오징어→오징어 · 새우→새우 · 게→게 ·
     *         고등어→고등어 · 땅콩→땅콩                                        = 7종
     *   28행  `해당없음` — 유전자변형식품 표시 항목. **알레르겐 선언이 아니다.**
     */
    input: [
      '해당없음',
      '밀,대두,계란,우유,쇠고기,돼지고기,닭고기,조개류(굴,홍합 포함) 함유',
      '• 메밀,토마토,오징어,새우,게,고등어,땅콩 혼입가능 • 소비자기본법에 따라 피해 보상 • 부정·불량식품 신고는 국번없이 1399 • 제품에 첨가된 건더기에 의하여 면에 색상이 묻어 있을 수 있음 • 직사광선을 피해 서늘하고 건조한 곳에 보관 • 벌레나 냄새의 영향을 받기 쉬우므로 보관에 유의 • 분말스프는 식성에 따라 적당량 넣어 주십시오.',
    ].join('\n'),
    expect: ['밀', '대두', '난류(가금류)', '우유', '쇠고기', '돼지고기', '닭고기', '조개류',
      '메밀', '토마토', '오징어', '새우', '게', '고등어', '땅콩'],
    fixture: { file: '014.txt', lines: [28, 45, 52] },
  },
  {
    id: 'D1-findings-repro',
    title: 'D1 · FINDINGS §7-2② 재현식 — 함유 선언이 `해당없음` 과 한 입력에 있어도 살아남는다',
    input: '밀, 대두, 우유 함유. 유전자변형식품 해당없음',
    expect: ['밀', '대두', '우유'],
  },

  // ───────────────────────────────────────────────────────────────── D2 ──
  {
    id: 'D2-013-jat',
    title: 'D2 · 전사 013 원문 1줄 — 잣(최악 52%)과 알류(16자, 1자 차이)',
    /**
     * 원문 그대로 (`.tmp/captures/transcripts/013.txt` 17행).
     * 표면형 → 정본:
     *   알류→난류(가금류) · 우유 · 메밀 · 땅콩 · 고등어 · 게 · 새우 · 돼지고기 ·
     *   복숭아 · 토마토 · 호두 · 닭고기 · 오징어 · 조개류(굴,전복,홍합 포함)→조개류 ·
     *   아황산류 · 잣                                                        = 16종
     * (뒤에 이어지는 안내문 4문장에는 19종 표면형이 하나도 없다 — 손으로 전수 확인)
     */
    input: '주의사항: • 이 제품은 알류, 우유, 메밀, 땅콩, 고등어, 게, 새우, 돼지고기, 복숭아, 토마토, 호두, 닭고기, 오징어, 조개류(굴, 전복, 홍합 포함), 아황산류, 잣을 사용한 제품과 같은 제조시설에서 제조하고 있습니다. • 개봉한 제품은 변질될 우려가 있으니, 개봉 후에는 가능한 빨리 드십시오. • 부풀거나 파손된 제품은 드시지 마시고 구입처나 영업소에서 교환하시기 바랍니다. • 본 제품은 소비자분쟁해결 기준에 의거, 교환 또는 보상받을 수 있습니다. • 부정·불량식품 신고는 국번없이 1399 • 포장재 끝이 날카로울 수 있으니 손베임에 유의하시기 바랍니다.',
    expect: ['난류(가금류)', '우유', '메밀', '땅콩', '고등어', '게', '새우', '돼지고기',
      '복숭아', '토마토', '호두', '닭고기', '오징어', '조개류', '아황산류', '잣'],
    fixture: { file: '013.txt', lines: [17] },
  },
  {
    id: 'D2-jat-tail',
    title: 'D2 · 잣이 혼입 문구 맨 끝에 오는 관행 (11/23 전사 동일 패턴)',
    // 표면형 → 정본: 조개류(굴,전복,홍합 포함)→조개류 · 잣→잣
    input: '조개류(굴, 전복, 홍합 포함), 잣을 사용한 제품과 같은 제조시설에서 제조하고 있습니다.',
    expect: ['조개류', '잣'],
  },
  {
    id: 'D2-031-milk',
    title: 'D2 · 전사 031 — 우유 제품인데 우유가 사라진다 (26자)',
    // 원문 그대로 (`.tmp/captures/transcripts/031.txt` 25행). 표면형 → 정본: 우유→우유
    // ('원유' 는 19종 표면형이 아니다. 여기서 기대하지 않는다.)
    input: '원재료명 및 함량: 국산 원유 100%   우유 함유',
    expect: ['우유'],
    fixture: { file: '031.txt', lines: [25] },
  },
  {
    id: 'D2-dump-newline',
    title: 'D2 · HACCP 덤프 실측 — `alg` 필드 안에 개행이 들어 있다',
    // scripts/output/haccp_dump.ndjson 실측값. 표면형 → 정본: 대두 · 땅콩
    input: '대두\n[검정깨강정] 대두\n[참깨강정] 대두\n[들깨강정] 대두\n[땅콩강정] 땅콩',
    expect: ['대두', '땅콩'],
  },
  {
    id: 'D2-dump-sentence',
    title: 'D2 · HACCP 덤프 실측 — 안내문이 통째로 한 조각(15자 초과)',
    // scripts/output/haccp_dump.ndjson 실측값. 표면형 → 정본: 오징어
    input: '오징어를 원료로 사용한 제품과 같은 제조시설에서 제조하고 있습니다.',
    expect: ['오징어'],
  },

  // ───────────────────────────────────────────────────────────────── D3 ──
  { id: 'D3-egg-gyeran', title: 'D3 · `계란` → 정본 `난류(가금류)`', input: '계란 함유', expect: ['난류(가금류)'] },
  { id: 'D3-egg-alryu', title: 'D3 · `알류` → 정본 `난류(가금류)`', input: '알류, 우유 함유', expect: ['난류(가금류)', '우유'] },
  { id: 'D3-egg-dalgyal', title: 'D3 · `달걀` → 정본 `난류(가금류)`', input: '달걀', expect: ['난류(가금류)'] },
  { id: 'D3-egg-bullet', title: 'D3 · `•계란` — 장식 기호가 이름에 붙는다', input: '•계란', expect: ['난류(가금류)'] },
  {
    id: 'D3-shellfish-paren',
    title: 'D3 · `조개류(굴, 바지락)` 이 `조개류(굴` + `바지락)` 로 찢긴다',
    // scripts/output/haccp_dump.ndjson 실측값(= test_allergen_name_normalize.js:405 와 같은 원문).
    // 표면형 → 정본: 대두 · 밀 · 쇠고기 · 새우 · 조개류/굴/바지락 → 조개류
    input: '대두, 밀, 쇠고기, 새우, 조개류(굴, 바지락) 함유',
    expect: ['대두', '밀', '쇠고기', '새우', '조개류'],
  },
  {
    id: 'D3-dump-19',
    title: 'D3 · HACCP 덤프 실측(×6) — 19종 전건 선언문이 정본 19종 그대로 나온다',
    // scripts/output/haccp_dump.ndjson 실측값. 표면형이 곧 정본인데 `난류`·`조개류(굴,전복,홍합포함)` 만 다르다.
    input: '난류,우유,메밀,땅콩,대두,밀,고등어,게,새우,돼지고기,복숭아,토마토,아황산류,호두,닭고기,쇠고기,오징어,조개류(굴,전복,홍합포함),잣',
    expect: CANONICAL_19.slice(),
  },

  // ─────────────────────────────────── 의미 보존 (D1 을 고치다 뒤집지 않기) ──
  { id: 'N-none', title: '보존 · `없음` 단독 → []', input: '없음', expect: [] },
  { id: 'N-none-dot', title: '보존 · `없음.` (덤프 실측) → []', input: '없음.', expect: [] },
  { id: 'N-haedang', title: '보존 · `해당없음` (덤프 실측 ×19) → []', input: '해당없음', expect: [] },
  { id: 'N-alsu', title: '보존 · `알 수 없음` (덤프 실측 ×5) → []', input: '알 수 없음', expect: [] },
  { id: 'N-alreugi', title: '보존 · `알러지유발식품없음` (덤프 실측 ×20) → []', input: '알러지유발식품없음', expect: [] },
  { id: 'N-haedangsahang', title: '보존 · `해당사항없음` (덤프 실측 ×4) → []', input: '해당사항없음', expect: [] },
  { id: 'N-gmo-line', title: '보존 · 유전자변형식품 표시 항목만 있는 줄 → []', input: '유전자변형식품에 해당하는 경우의 표시 / 해당없음', expect: [] },
  { id: 'N-negation-milk', title: '★ 보존 · `우유 없음` 은 「우유가 있다」로 뒤집히면 안 된다', input: '우유 없음', expect: [] },
  { id: 'N-empty', title: '보존 · 빈 문자열 → []', input: '', expect: [] },
  { id: 'N-null', title: '보존 · null → []', input: null, expect: [] },
  { id: 'N-undef', title: '보존 · undefined → []', input: undefined, expect: [] },

  // ─────────────────────────────────────────────── 오검출 억제 (L4) ──
  //  ★ 이 절이 「L1 을 줄이려다 L4 를 늘리는」 것을 막는다. 알레르기에서 과잉경고는
  //    과소경고와 종류가 다른 위험이다(경고 신뢰도 붕괴). 전부 라벨 보일러플레이트다.
  { id: 'X-fp-gge', title: 'L4 · 「깨끗하게」를 게(갑각류)로 읽지 않는다', input: '환경은 깨끗하게 관리하고 있습니다', expect: [] },
  { id: 'X-fp-mil', title: 'L4 · 「밀폐」를 밀로 읽지 않는다', input: '개봉 후 밀폐 용기에 보관하십시오', expect: [] },
  { id: 'X-fp-plain', title: 'L4 · 알레르겐이 없는 안내문에서 아무것도 만들지 않는다', input: '직사광선을 피해 서늘하고 건조한 곳에 보관하십시오. 부정·불량식품 신고는 국번없이 1399', expect: [] },
  { id: 'X-fp-jjapageti', title: 'L4 · 「짜파게티」를 게로 읽지 않는다 (경계 가드 대조군)', input: '짜파게티 큰사발면', expect: [] },
  { id: 'X-fp-tongmil', title: 'L4 · 「통밀크래커」는 밀 하나다 (우유로 둔갑하지 않는다)', input: '[통밀크래커] 밀', expect: ['밀'] },
];

// ══════════════════════════════════════════════════════════════════════════
// 4. 비교기
// ══════════════════════════════════════════════════════════════════════════
const srt = (a) => [...a].sort();
const setEq = (a, b) => srt(a).join('|') === srt(b).join('|');
const diff = (got, exp) => ({
  missing: exp.filter((x) => !got.includes(x)),   // L1/L2 = 소실
  extra: got.filter((x) => !exp.includes(x)),     // L4 = 오검출
});

function main() {
  console.log('\n════════ 세션50 parseAllergy 소실 결함 회귀 ════════');
  const STRICT = process.env.PARSE_ALLERGY_STRICT === '1';

  // ══════════════════════════════════════════════════════════════════════
  section('§0. 전제 — 두 사본이 같은 함수인가');

  t('★★ 19 와 26 의 parseAllergy 가 글자까지 같은 함수다 (한쪽만 고치면 여기서 걸린다)', () => {
    assert.strictEqual(typeof A19, 'function', '19-apply-haccp.js 가 parseAllergy 를 export 하지 않는다');
    assert.strictEqual(typeof A26, 'function', '26-apply-haccp-dump.js 가 parseAllergy 를 export 하지 않는다');
    assert.strictEqual(A19.toString(), A26.toString(), '두 스크립트의 parseAllergy 가 갈라졌다 — 반드시 동시에 고칠 것');
  });

  t('★★ 19 와 26 이 모든 케이스에서 같은 답을 낸다 (toString 만으로는 클로저 차이를 못 본다)', () => {
    for (const c of CASES) {
      assert.deepStrictEqual(A19(c.input), A26(c.input),
        `[${c.id}] 19 와 26 의 결과가 다르다: ${JSON.stringify(A19(c.input))} vs ${JSON.stringify(A26(c.input))}`);
    }
  });

  t('★ 시그니처 유지 — 항상 string[] 을 돌려준다', () => {
    for (const c of CASES) {
      const got = A19(c.input);
      assert.ok(Array.isArray(got), `[${c.id}] 배열이 아니다`);
      for (const x of got) assert.strictEqual(typeof x, 'string', `[${c.id}] 원소가 문자열이 아니다: ${JSON.stringify(x)}`);
    }
  });

  t('★ 중복을 만들지 않는다 (product_allergens 는 (product_id, allergen_name) UNIQUE 다)', () => {
    for (const c of CASES) {
      const got = A19(c.input);
      assert.strictEqual(new Set(got).size, got.length, `[${c.id}] 중복 이름이 있다: ${JSON.stringify(got)}`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§1. 픽스처 원문 대조 — 케이스 입력이 전사 원문 그대로인가');

  t('★ 전사 파일의 해당 줄과 케이스 입력이 글자까지 같다', () => {
    if (!fs.existsSync(TR)) {
      console.log('     (캡처 전사 폴더 없음 — 이 대조는 건너뛴다)');
      return;
    }
    for (const c of CASES.filter((x) => x.fixture)) {
      const lines = fs.readFileSync(path.join(TR, c.fixture.file), 'utf8').split(/\n/);
      const want = c.fixture.lines.map((n) => lines[n - 1]).join('\n');
      assert.strictEqual(c.input, want,
        `[${c.id}] 케이스 입력이 ${c.fixture.file} ${c.fixture.lines.join(',')}행과 다르다 — 원문을 손대면 측정이 무의미해진다`);
    }
  });

  t('★ 기대값에 19종 정본 아닌 이름이 없다 (골든이 정본에서 유도됐는가)', () => {
    const canon = new Set(CANONICAL_19);
    for (const c of CASES) {
      for (const n of c.expect) {
        assert.ok(canon.has(n), `[${c.id}] 기대값 "${n}" 이 CANONICAL_19 에 없다`);
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  section('§2~5. 케이스 실행 — 소실(L1/L2) 과 오검출(L4) 을 함께 본다');

  const results = new Map();
  for (const c of CASES) {
    const got = A19(c.input);
    const ok = setEq(got, c.expect);
    results.set(c.id, { got, ok });
    const k = KNOWN[c.id];

    t(`${c.title}`, () => {
      const d = diff(got, c.expect);
      const detail = `\n       입력   ${JSON.stringify(String(c.input).slice(0, 90))}`
        + `\n       기대   ${JSON.stringify(srt(c.expect))}`
        + `\n       실제   ${JSON.stringify(srt(got))}`
        + `\n       소실   ${JSON.stringify(d.missing)}   오검출 ${JSON.stringify(d.extra)}`;

      if (k) {
        if (ok) {
          throw new Error(`[대장이 낡았다] ${c.id} 가 이제 통과한다 (${k.defect}/${k.owner}).`
            + `\n       → KNOWN 에서 이 줄을 지울 것. 남겨 두면 다음 회귀를 못 잡는다.${detail}`);
        }
        openIssues.push({ id: c.id, ...k, ...diff(got, c.expect) });
        return;   // 대장과 일치 → 기본 실행에서는 통과로 센다
      }
      if (!ok) throw new Error(`알레르겐 소실/오검출이 발생했다 (대장에 없는 새 불일치)${detail}`);
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§6. ★★★ 고친 코드 경로를 케이스가 실제로 지나는가');
  //  세션49 사고 — 「고쳤는데 픽스처가 그 코드 경로를 한 번도 지나지 않아 뮤테이션이 전부 통과」.
  //  결함 케이스는 **수정 전 구현(LEGACY)과 반드시 다른 답**을 내야 한다. 같으면 그 케이스는
  //  결함을 구별하지 못하므로 회귀로서 무가치하다.

  t('★★★ D1/D2/D3 케이스는 전부 수정 전 구현(LEGACY)과 다른 답을 낸다 (= 그 코드 경로를 지난다)', () => {
    const blind = [];
    for (const c of CASES.filter((x) => /^D[123]-/.test(x.id))) {
      const legacy = LEGACY_parseAllergy(c.input);
      if (setEq(legacy, results.get(c.id).got)) blind.push(`${c.id} (LEGACY=${JSON.stringify(legacy)})`);
    }
    assert.strictEqual(blind.length, 0,
      `아래 케이스는 수정 전 구현과 결과가 같다 — 결함을 구별하지 못한다:\n       ${blind.join('\n       ')}`);
  });

  t('★★ 수정 전 구현은 이 회귀를 통과하지 못한다 (회귀가 결함을 실제로 잡는다는 증명)', () => {
    const survived = [];
    for (const c of CASES.filter((x) => /^D[123]-/.test(x.id))) {
      if (setEq(LEGACY_parseAllergy(c.input), c.expect)) survived.push(c.id);
    }
    assert.strictEqual(survived.length, 0,
      `수정 전 구현이 통과해 버리는 케이스가 있다(= 결함 재현이 아니다): ${survived.join(', ')}`);
  });

  t('★ D1 케이스는 수정 전 구현에서 반드시 빈 배열이었다 (`/없음/` 전면 무효화의 지문)', () => {
    for (const c of CASES.filter((x) => /^D1-/.test(x.id))) {
      assert.deepStrictEqual(LEGACY_parseAllergy(c.input), [],
        `[${c.id}] 수정 전 구현이 []가 아니다 — 이 케이스는 D1(전면 무효화)을 재현하지 않는다`);
    }
  });

  t('★ D2 케이스는 수정 전 구현에서 15자 초과 조각이 실제로 버려졌다 (길이 필터의 지문)', () => {
    for (const c of CASES.filter((x) => /^D2-/.test(x.id))) {
      const dropped = String(c.input).replace(/함유|포함/g, '').split(/[,·\/|]/)
        .map((x) => x.trim()).filter((x) => x && x.length > 15);
      assert.ok(dropped.length > 0,
        `[${c.id}] 수정 전 구현에서 15자 초과로 버려진 조각이 없다 — 이 케이스는 D2 를 재현하지 않는다`);
    }
  });

  t('★ D3 케이스는 수정 전 구현이 비정본 이름을 만들었다 (이름 소실의 지문)', () => {
    const canon = new Set(CANONICAL_19);
    for (const c of CASES.filter((x) => /^D3-/.test(x.id))) {
      const legacy = LEGACY_parseAllergy(c.input);
      assert.ok(legacy.some((x) => !canon.has(x)),
        `[${c.id}] 수정 전 구현이 정본 이름만 만들었다 — 이 케이스는 D3 를 재현하지 않는다: ${JSON.stringify(legacy)}`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // 결과 보고
  // ══════════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`📊 세션50 parseAllergy 회귀: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})`);

  const mine = openIssues.filter((x) => x.owner === 'parseAllergy');
  const theirs = openIssues.filter((x) => x.owner !== 'parseAllergy');

  if (openIssues.length) {
    console.log(`\n⚠  미해결 결함 ${openIssues.length}건 — 대장(KNOWN)과 값이 일치한다:`);
    for (const o of openIssues) {
      console.log(`   [${o.defect}] ${o.id}  (소관: ${o.owner})`);
      console.log(`        소실 ${JSON.stringify(o.missing)}  오검출 ${JSON.stringify(o.extra)}`);
      console.log(`        ${o.note}`);
    }
    if (mine.length) console.log(`   ★ parseAllergy 소관 ${mine.length}건 — 고친 뒤 PARSE_ALLERGY_STRICT=1 이 초록이어야 한다.`);
    if (theirs.length) console.log(`   ※ 소관 밖 ${theirs.length}건 — 세션50 은 그 파일을 편집하지 않는다(보고만).`);
  }

  if (fail > 0) {
    console.log('\n실패 상세:');
    for (const f of failures) console.log(`  - ${f.name}\n    ${f.message}`);
    process.exit(1);
  }

  if (STRICT && mine.length > 0) {
    console.log(`\n❌ PARSE_ALLERGY_STRICT=1 — parseAllergy 소관 미해결 결함 ${mine.length}건을 실패로 센다.`);
    process.exit(1);
  }

  console.log('✅ 새 소실·오검출 없음 (미해결 결함은 위에 나열)');
}

main();
