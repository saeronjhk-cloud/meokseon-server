/**
 * allergenName.js — 알레르겐 이름 정규화 (식약처 19종 정본 화이트리스트)
 *
 * ── 왜 필요한가 (실측 근거) ────────────────────────────────────────────────
 * `scripts/19-apply-haccp.js` · `scripts/26-apply-haccp-dump.js` 의 `parseAllergy` 는
 *   `s.replace(/함유|포함/g,'').split(/[,·\/|]/).map(trim).filter(x => x && x.length <= 15)`
 * 뿐이다. HACCP `allergy` 원문은 자유 서술문이라 이 파싱이 **문장 조각을 이름으로 만든다.**
 *
 * 2026-07-31 전수 집계 (parseAllergy 를 그대로 import 해 실제 덤프에 실행):
 *   · 적재분(= product_allergens 에 실제로 들어간 것) 5,649행 / **distinct 106종**
 *     → 19종 정본과 글자까지 일치하는 것은 19종 중 17종뿐. **705행(12.5%) 이 비정본 이름.**
 *     예) "계란" 339 · "조개류(굴)" 65 · "소고기" 34 · "난류" 24 · "홍합)" 22 ·
 *         "대두[d-토코페롤(혼합형)]" 10 · "밀(성분)" 1(← 운영 GET /api/products/8801005013130 에서 실물 확인)
 *   · HACCP 덤프 전체(14,682건) universe distinct **320종** / 비정본 302종 · 2,846행
 *
 * 원문이 어떻게 조각나는지 (실측 예):
 *   "본 제품은 새우,오징어를 원료로 사용한 제품과 같은 제조시설에서 제조하고 있습니다."
 *     → ["본 제품은 새우"]  ("오징어를…있습니다." 는 15자 초과라 filter 에서 탈락 = 알레르겐 소실)
 *   "·이 제품은 원재료에 알레르기 유발물질인 대두,밀,돼지고기,조개류(굴 포함)를 함유하고 있습니다."
 *     → ["·이 제품은 원재료에 알레르기 유발물질인 대두", "밀", "돼지고기", "조개류(굴 )를 하고 있습니다."]
 *        (앞 조각은 15자 초과로 탈락 → **대두가 통째로 사라진다**)
 *
 * ── 설계 원칙 ──────────────────────────────────────────────────────────────
 * ★ 과소경고 > 과잉경고 위험. 애매하면 **살리는 쪽**을 택한다.
 *   - `조개류(굴)` → `조개류` : 굴이라는 구체성을 잃지만 **더 넓은 경고**라 안전 방향.
 *   - `밀크` → `우유`, `강낭콩`류 → `대두` : 오탐이어도 경고가 늘어나는 방향이라 허용.
 *   - 반대로 19종 어디에도 못 붙는 것은 `null`(버림). 그 목록은 §DROPPED 주석에 남겼다.
 * ★ 부분 문자열 매칭은 **긴 별칭부터** 하고, 매칭한 구간을 지운 뒤 짧은 별칭을 본다.
 *   그러지 않으면 `메밀`→`밀`, `땅콩`→`콩`, `계란`→`게` 처럼 **틀린 알레르겐이 추가된다.**
 * ★ 하나의 조각에 알레르겐이 여러 개 들어 있는 경우가 실재한다("밀.우유.땅콩", "대두 밀",
 *   "대두\n액상소스:우유"). 그래서 복수형 `normalizeAllergenNames` 를 정본으로 두고,
 *   단수형 `normalizeAllergenName` 은 그 **첫 결과**를 돌려준다(요구 계약 유지).
 *   ⚠ 단수형만 쓰면 나머지 알레르겐이 사라진다 = 과소경고. 노출·백필 경로는 복수형을 쓸 것.
 *
 * 정본: IP/allergens_19_korea.json (식약처 식품 등의 표시기준)
 *   ⚠ 그 파일은 배포 산출물(meokseon-server/)에 포함되지 않으므로 여기에 사본을 둔다.
 *     사본이 갈라지지 않도록 `tests/test_allergen_name_normalize.js` 가 두 목록을 대조한다.
 */
'use strict';

/** 식약처 의무표시 알레르기 유발물질 19종 — 표기까지 정본 그대로. */
const CANONICAL_19 = Object.freeze([
  '난류(가금류)', '우유', '메밀', '땅콩', '대두', '밀', '고등어', '게', '새우',
  '돼지고기', '복숭아', '토마토', '아황산류', '호두', '닭고기', '쇠고기',
  '오징어', '조개류', '잣',
]);
const CANONICAL_SET = new Set(CANONICAL_19);

/**
 * 별칭표 — [별칭, 정본]. 등록 순서는 무관하고 **길이 내림차순으로 자동 정렬**해 적용한다.
 * 여기 없는 어휘는 매칭되지 않는다(= 조용히 버려진다). 새 오염이 보이면 여기에 추가할 것.
 */
const ALIAS_PAIRS = [
  // ── 난류(가금류) ── 「알류」는 식약처 구표기, 「계란/달걀」은 통칭, 메추리알도 가금류다.
  ['난류(가금류)', '난류(가금류)'], ['난류', '난류(가금류)'], ['알류', '난류(가금류)'],
  ['계란', '난류(가금류)'], ['달걀', '난류(가금류)'], ['난백', '난류(가금류)'],
  ['난황', '난류(가금류)'], ['난각칼슘', '난류(가금류)'], ['메추리알', '난류(가금류)'],
  ['가금류', '난류(가금류)'],
  // ── 우유 ── 유래 원재료 표기가 실제로 매우 많다(유청/카제인/분유/버터…).
  ['우유', '우유'], ['탈지분유', '우유'], ['전지분유', '우유'], ['분유', '우유'],
  ['유청', '우유'], ['유당', '우유'], ['카제인', '우유'], ['버터', '우유'],
  ['치즈', '우유'], ['크림', '우유'],
  // ⚠ `밀크` 는 **일부러 별칭에 넣지 않았다.** 넣으면 길이 정렬상 `밀` 보다 먼저 소모돼
  //   실측 조각 `"[통밀크래커] 밀"` 이 `우유` 로만 잡히고 **밀이 사라진다**(= 과소경고).
  //   HACCP 덤프 universe 320종에 `밀크` 표기는 0건이고, 우유는 항상 `우유/유청/분유/카제인` 으로 쓴다.
  //   반대 방향(밀크초코 → `밀` 오탐)은 경고가 늘어나는 방향이라 감수한다.
  // ── 메밀 ── ★ '밀' 보다 길어서 먼저 소모된다. 이 순서가 깨지면 메밀이 밀로 둔갑한다.
  ['메밀', '메밀'],
  // ── 땅콩 ── ★ '콩'(대두) 보다 먼저 소모돼야 한다.
  ['땅콩', '땅콩'], ['낙화생', '땅콩'],
  // ── 대두 ──
  ['대두', '대두'], ['분리대두단백', '대두'], ['탈지대두', '대두'], ['두부', '대두'],
  ['유부', '대두'], ['된장', '대두'], ['간장', '대두'], ['콩', '대두'],
  ['백태', '대두'], ['서리태', '대두'],
  // ── 밀 ── 소맥 계열 포함.
  //   ⚠ `밀가루`·`통밀` 을 **일부러 넣지 않았다.** `밀` 하나로 이미 잡히는데,
  //     `밀가루`(3자)를 넣으면 길이 정렬상 `메밀`(2자)보다 먼저 소모돼
  //     `메밀가루(메밀)` 이 **밀 + 메밀** 로 갈라진다(실측 회귀에서 잡혔다).
  ['밀', '밀'], ['소맥', '밀'], ['글루텐', '밀'],
  // ── 고등어 ──
  ['고등어', '고등어'],
  // ── 게 ── ★ 1글자. 아래 GUARD 로 경계를 본다.
  ['게', '게'], ['꽃게', '게'], ['대게', '게'],
  // ── 새우 ──
  ['새우', '새우'], ['보리새우', '새우'], ['건새우', '새우'],
  // ── 돼지고기 ── 돈(豚) 접두 원재료 표기. 「돈」 단독은 쓰지 않는다(돈=금전).
  ['돼지고기', '돼지고기'], ['돼지', '돼지고기'], ['돈육', '돼지고기'], ['돈지방', '돼지고기'],
  ['돈지', '돼지고기'], ['돈골', '돼지고기'], ['돈창', '돼지고기'], ['돈혈', '돼지고기'],
  ['돈피', '돼지고기'], ['라드', '돼지고기'],
  // ── 복숭아 ──
  ['복숭아', '복숭아'], ['백도', '복숭아'], ['황도', '복숭아'],
  // ── 토마토 ──
  ['토마토', '토마토'],
  // ── 아황산류 ──
  ['아황산류', '아황산류'], ['산성아황산나트륨', '아황산류'], ['아황산나트륨', '아황산류'],
  ['무수아황산', '아황산류'], ['메타중아황산', '아황산류'], ['이산화황', '아황산류'],
  ['아황산', '아황산류'], ['황산염', '아황산류'],
  // ── 호두 ──
  ['호두', '호두'],
  // ── 닭고기 ──
  ['닭고기', '닭고기'], ['닭가슴살', '닭고기'], ['계육', '닭고기'], ['닭뼈', '닭고기'], ['닭', '닭고기'],
  // ── 쇠고기 ── 「소」 단독은 쓰지 않는다(소스·소금 오탐).
  ['쇠고기', '쇠고기'], ['소고기', '쇠고기'], ['우육', '쇠고기'], ['우골', '쇠고기'],
  ['우사골', '쇠고기'], ['사골', '쇠고기'], ['소뼈', '쇠고기'], ['우지', '쇠고기'],
  // ── 오징어 ──
  ['오징어', '오징어'],
  // ── 조개류 ── 정본 `additional_keywords_for_strip_only` 가 굴·전복·홍합을 조개류로 본다.
  //   ★ 구체 조개명을 전부 `조개류` 로 올린다. 구체성은 잃지만 경고 범위는 넓어진다(안전 방향).
  ['조개류', '조개류'], ['조개', '조개류'], ['굴', '조개류'], ['전복', '조개류'],
  ['홍합', '조개류'], ['바지락', '조개류'], ['모시조개', '조개류'], ['대합', '조개류'],
  ['백합', '조개류'], ['가리비', '조개류'], ['꼬막', '조개류'], ['소라', '조개류'],
  ['개량조개', '조개류'], ['기조개', '조개류'], ['키조개', '조개류'], ['재첩', '조개류'],
  ['패주', '조개류'],
  // ── 잣 ──
  ['잣', '잣'],
];

/**
 * 오타·깨짐 표 — **문자열 전체가** 이것과 같을 때만 적용한다(부분 매칭 금지).
 * 전부 2026-07-31 HACCP 덤프 실측에서 나온 것이다. 추정으로 넣은 것은 없다.
 */
const TYPO_EXACT = new Map(Object.entries({
  '게란': '난류(가금류)', '날류': '난류(가금류)',
  '유유': '우유', '유우': '우유', '우류': '우유',
  '대듀': '대두',
  '토마도': '토마토', '토마투': '토마토', '토미토': '토마토', '토마': '토마토',
  '호도': '호두',
  '탕콩': '땅콩',
  '닭괴': '닭고기',
  '돼고기': '돼지고기', '괘지고기': '돼지고기',
  '쇠구기': '쇠고기', '쇠소기': '쇠고기',
  '오지엉': '오징어',
  '아산화황': '아황산류', '이산화항': '아황산류', '이황산류': '아황산류',
  '조래규': '조개류', '조개루': '조개류', '위소라': '조개류',
}));

/**
 * 1글자(또는 오탐 위험) 별칭의 경계 가드.
 * 값 = 「이 정규식에 걸리면 매칭하지 않는다」.
 *   게 : `게란`(계란 오타) 을 갑각류로 읽지 않기 위함. 뒤에 한글이 붙으면 원칙적으로 거부하되,
 *        `게살/게맛/게추출/게농축/게가루/게분말/게엑기스` 처럼 게 자체를 가리키는 접미만 허용한다.
 *   굴 : `굴비`(생선) 배제.
 * ⚠ `밀` 에는 가드를 두지 않는다. `밀크` 를 막으면 `통밀크래커` 의 밀까지 잃는다(과소경고).
 */
const NEGATIVE_GUARD = {
  '게': /게(?![살맛향추농가분엑])(?=[가-힣])/,
  '굴': /굴비/,
};

/**
 * 혼입(may_contain) 어휘.
 * ⚠ `함유하고 있습니다` 는 **직접 함유**다. `하고 있습니다` 단독을 트리거로 쓰면
 *   실측 조각 `"굴을 하고 있습니다."`(= "…굴을 함유하고 있습니다." 에서 '함유' 가 지워진 것)가
 *   혼입으로 **격하**된다 — 과소경고. 그래서 「같은 + 시설/설비/라인/공정/기계」 조합과
 *   「혼입」 계열만 트리거로 둔다.
 */
const MAY_CONTAIN_RE = /혼입|혼입가능|같은\s*(?:제조\s*)?(?:시설|설비|라인|생산라인|공정|기계|장비)|같은\s*(?:공장|생산)|동일\s*(?:시설|제조시설|생산시설|라인|공정)|미량\s*함유될|흔적/;

/** 길이 내림차순 별칭 목록 (동률이면 등록 순서 유지). */
const ALIASES_SORTED = ALIAS_PAIRS
  .map(([alias, canon], i) => ({ alias, canon, i }))
  .sort((a, b) => (b.alias.length - a.alias.length) || (a.i - b.i));

/** 매칭 구간을 지울 때 쓰는 치환 문자 — 한글이 아니어서 다음 별칭의 경계 판정을 방해하지 않는다. */
const BLANK = ' ';

function preclean(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFC')
    // 개행·탭·전각공백을 보통 공백으로 (조각에 "\n" 이 실제로 들어 있다)
    .replace(/[\r\n\t 　]+/g, ' ')
    // 앞뒤 장식 기호(·※★●* 등)와 공백 제거
    .replace(/^[\s·※★●○◆■▲▼☆◎*・\-–—]+/, '')
    .replace(/[\s·※★●○◆■▲▼☆◎*・\-–—]+$/, '')
    .trim();
}

/**
 * 오염된 알레르겐 이름 1건 → 정본 19종 목록.
 *
 * @param {string} raw
 * @returns {Array<{name: string, level: ('may_contain'|null)}>}
 *   · `name` 은 반드시 CANONICAL_19 중 하나.
 *   · `level` 은 혼입 어휘가 있을 때만 `'may_contain'`, 아니면 `null`
 *     (= 호출부가 기존 등급을 유지한다. 여기서 `'contains'` 를 만들어 내지 않는다).
 *   · 하나도 못 붙이면 빈 배열.
 */
function normalizeAllergenNames(raw) {
  const s = preclean(raw);
  if (!s) return [];

  const level = MAY_CONTAIN_RE.test(s) ? 'may_contain' : null;

  // ① 오타 표는 **전체 일치**로만 (부분 매칭하면 "게란가루" 같은 미지 어휘까지 끌어온다)
  const stripped = s.replace(/[()[\]{}<>「」『』"'.,:;!?~]/g, '').trim();
  const typo = TYPO_EXACT.get(s) || TYPO_EXACT.get(stripped);
  if (typo) return [{ name: typo, level }];

  // ② 긴 별칭부터 훑고, 맞은 구간은 지운다.
  let scan = s;
  const found = [];
  const seen = new Set();
  for (const { alias, canon } of ALIASES_SORTED) {
    let idx;
    while ((idx = scan.indexOf(alias)) !== -1) {
      const guard = NEGATIVE_GUARD[alias];
      if (guard) {
        // 가드는 「매칭 지점 주변」에 적용한다. 앞뒤 1글자를 함께 본다.
        const around = scan.slice(Math.max(0, idx - 1), idx + alias.length + 1);
        if (guard.test(around)) {
          // 이 지점은 건너뛰고 다음 등장 위치를 본다 (지우지 않으면 무한 루프가 된다)
          scan = scan.slice(0, idx) + BLANK.repeat(alias.length) + scan.slice(idx + alias.length);
          continue;
        }
      }
      scan = scan.slice(0, idx) + BLANK.repeat(alias.length) + scan.slice(idx + alias.length);
      if (!seen.has(canon)) { seen.add(canon); found.push({ name: canon, level }); }
    }
  }
  return found;
}

/**
 * 요구 계약형 — 단수. 첫 매칭만 돌려준다.
 * ⚠ 조각에 알레르겐이 2개 이상 들어 있으면 나머지가 사라진다(과소경고).
 *   노출 경로·백필은 `normalizeAllergenNames` 를 쓸 것.
 *
 * @param {string} raw
 * @returns {{name: string, level: ('may_contain'|null)}|null}
 */
function normalizeAllergenName(raw) {
  const r = normalizeAllergenNames(raw);
  return r.length ? r[0] : null;
}

/** 이미 정본 그대로인가 (백필 스크립트가 「손댈 필요 없음」을 판정할 때 쓴다). */
function isCanonicalAllergenName(name) {
  return typeof name === 'string' && CANONICAL_SET.has(name);
}

/** 등급 강도 — 큰 쪽이 강한 경고. 중복 병합 시 **강한 쪽을 남긴다**(과소경고 방지). */
const LEVEL_RANK = { contains: 3, inferred: 2, may_contain: 1 };
function strongerLevel(a, b) {
  const ra = LEVEL_RANK[a] || 0, rb = LEVEL_RANK[b] || 0;
  return ra >= rb ? a : b;
}

/**
 * `product_allergens` 행 배열 → 정규화 + 중복 병합.
 * 반환 행은 입력 행의 shape 을 유지한다(allergen_name 만 정본으로 교체, evidence_level 보정).
 *
 * ★ 중복이 반드시 생긴다 — "계란"·"난류"·"난각칼슘(계란)" 이 모두 `난류(가금류)` 가 된다.
 *   병합 시 evidence_level 은 **강한 쪽**, source_count 는 **합**, detected_via 는 첫 행 것을 쓴다.
 * ★ 순서는 입력 순서를 유지한다(getAllergens 의 「직접 함유 먼저」 정렬 계약을 깨지 않기 위함).
 *
 * @param {Array<Object>} rows
 * @returns {Array<Object>}
 */
function normalizeAllergenRows(rows) {
  if (!Array.isArray(rows)) return [];
  const byName = new Map();
  const order = [];
  for (const r of rows) {
    if (!r) continue;
    const hits = normalizeAllergenNames(r.allergen_name);
    for (const hit of hits) {
      // hit.level 이 null 이면 기존 등급 유지. 혼입 어휘가 잡혔을 때만 격하한다.
      const lvl = hit.level || r.evidence_level || 'contains';
      const prev = byName.get(hit.name);
      if (!prev) {
        byName.set(hit.name, { ...r, allergen_name: hit.name, evidence_level: lvl });
        order.push(hit.name);
      } else {
        prev.evidence_level = strongerLevel(prev.evidence_level, lvl);
        if (Number.isFinite(Number(r.source_count))) {
          prev.source_count = (Number(prev.source_count) || 0) + Number(r.source_count);
        }
      }
    }
  }
  return order.map((n) => byName.get(n));
}

module.exports = {
  CANONICAL_19,
  ALIAS_PAIRS,
  TYPO_EXACT,
  MAY_CONTAIN_RE,
  normalizeAllergenName,
  normalizeAllergenNames,
  normalizeAllergenRows,
  isCanonicalAllergenName,
  strongerLevel,
};
