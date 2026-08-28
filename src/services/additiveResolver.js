'use strict';
/**
 * additiveResolver.js — 「검출한 첨가물」을 «저장»으로 잇는 단일 지점
 * ============================================================================
 * ★★★ 세션65 C1 (`U64-3`) — 왜 이 파일이 생겼나
 *
 *   실측(`.tmp/s65/U64-3_재측정_판정.md` · 라벨 67건 · 파싱 실패 0건):
 *     축 A — 제보 직후 화면에 보인 첨가물          189
 *     축 B — `product_additives` 에 실제로 저장     150
 *     ├ 교집합                                       64
 *     ├ ★ A에만 = 「봤는데 사라짐」                 125 (66.1%)
 *     └ B에만 = 화면엔 없었는데 저장됨               86
 *
 *   원인은 **별칭 사전 결손이 아니었다.** 사라진 이름 47종 중 37종(78.7%)이
 *   마스터에 «이미 있다». 저장 코드가 `identifyAdditives` 결과를 **한 번도 쓰지 않고**
 *   `ingredients[].name` 을 SQL `= ANY()` 완전일치로만 조인했기 때문이다.
 *     · `identifyAdditives` 는 부분매칭(`name.includes(keyword)`) + `detail` 스캔을 해서
 *       「산도조절제(인산나트륨)」에서 `인산나트륨` 을 뽑아낸다.
 *     · 저장 경로는 그것을 버리고 `산도조절제` 를 완전일치로 찾는다 → 안 붙는다.
 *
 *   ⚠ 그렇다고 「검출 결과만 저장」하면 절반만 풀린다. 실측 축 D(= 검출 결과를
 *     마스터 완전일치로 조인) = 154 로 축 B(150)보다 4개 늘 뿐이다.
 *     **두 축이 서로 다른 것을 잡는다.** → 그래서 **합집합**이다.
 *
 *   계약(`.tmp/s65/계약_세션65.md` C1):
 *     저장집합 = ( identifyAdditives(ingredients) 의 name 집합
 *                  ∪ ingredients[].name 중 마스터 완전일치 ) ∩ additives 마스터
 *
 * ★ 왜 서비스 두 곳이 아니라 «한 파일»인가 —
 *   계약 C1 이 `crowdsourceService`(경로 ①) 와 `mergeService`(경로 ②) **양쪽 모두**를
 *   대상으로 못 박았다. 「한쪽만 고치면 경로 간 결과가 갈린다.」
 *   같은 규칙을 두 곳에 적으면 다음 수정 때 한쪽만 고친다 — 이 저장소가 4세션 연속 겪은 사고다.
 *
 * ★★ `detected_name` 에 **마스터 이름(`name_ko`)을 넣지 않는다.**
 *   컬럼 이름이 「detected(검출된) name」이다. 종전 코드는 `row.name_ko` 를 넣어
 *   컬럼 이름과 뜻이 어긋나 있었고, 그래서 「라벨에 실제로 뭐라고 적혀 있었는지」가
 *   DB 어디에도 남지 않았다(사후 검증이 불가능했다). 계약 C1 의 명시 요구다.
 *
 * ⛔ 이 파일은 `additives` 마스터의 **오염을 고치지 않는다.**
 *   `U65-1`(설탕·정제소금·팜유 같은 일반 식품원료가 마스터에 섞여 있는 문제)은
 *   운영 DB 실제 내용 확인이 선행되어야 해서 계약 C5 가 **보류**로 못 박았다.
 *   여기서 이름 필터를 넣으면 그 판단을 코드가 앞질러 버린다.
 */

const { identifyAdditives } = require('./ocrParser');

function normalizeName(s) {
  return typeof s === 'string' ? s.trim() : '';
}

/**
 * 검출 총 개수 — **마스터 조인 «전»**. `products.additive_detected_count` 의 값이다.
 *
 * ★ 「모르면 NULL」(계약 C2-a). 배열이 아니면(구버전 호출부·다른 파이프라인) `null` 이다.
 *   0 과 null 은 **다른 뜻**이다: 0 = 「검출해 봤고 하나도 없었다」,
 *   null = 「검출 결과 자체를 모른다」. 이 구분이 무너지면 `unlisted` 가 거짓말을 한다.
 *
 * @param {Array|undefined} detectedAdditives - `analysis.additives` (identifyAdditives 결과)
 * @returns {number|null}
 */
function countDetected(detectedAdditives) {
  if (!Array.isArray(detectedAdditives)) return null;
  const seen = new Set();
  for (const a of detectedAdditives) {
    const n = typeof a === 'string' ? normalizeName(a) : normalizeName(a && a.name);
    if (n) seen.add(n);
  }
  return seen.size;
}

/**
 * 원재료 «이름만» 가지고 검출한다 — `analysis.additives` 가 없는 경로(경로 ②)용.
 *
 * ⚠ 이 경로는 경로 ① 보다 **약하다.** `mergeService` 가 기여에서 꺼내는 것은
 *   `parsed_ingredients[].name` 뿐이라 `raw` · `detail` · `sub_ingredients` 가 없다.
 *   즉 「산도조절제(인산나트륨)」 같은 detail 스캔은 여기서 재현되지 않는다.
 *   그래도 부분매칭은 살아 있으므로 종전(완전일치 only)보다 넓다.
 *   ★ 이것이 경로 간에 남는 유일한 비대칭이다. 지우려면 기여 레코드에
 *     검출 결과를 함께 저장해야 하는데, 그것은 이번 계약의 범위 밖이다.
 */
function detectFromIngredientNames(ingredientNames) {
  const list = (Array.isArray(ingredientNames) ? ingredientNames : [])
    .map((s) => normalizeName(typeof s === 'string' ? s : (s && s.name)))
    .filter(Boolean)
    .map((name) => ({ name, raw: name, sub_ingredients: [], detail: '' }));
  if (list.length === 0) return [];
  return identifyAdditives(list);
}

/**
 * 저장 후보(합집합)와 `detected_name`(= 라벨 원문) 대응표를 만든다.
 *
 * @returns {{names: string[], rawByName: Map<string,string>}}
 *   `names` — 마스터 조회에 쓸 이름 배열(중복 제거, 입력 순서 보존)
 *   `rawByName` — 마스터 조회 이름 → **라벨에서 실제로 읽은 원문**
 */
function buildAdditiveCandidates({ detectedAdditives, ingredientNames } = {}) {
  const names = [];
  const rawByName = new Map();

  // ── 축 A: identifyAdditives 결과 ──
  //   `name` 은 사전 키워드(= 마스터 조회용)이고, `raw` 가 라벨 원문이다.
  //   예) 라벨 「산도조절제(인산나트륨)」 → { name:'인산나트륨', raw:'산도조절제(인산나트륨)' }
  for (const a of (Array.isArray(detectedAdditives) ? detectedAdditives : [])) {
    if (!a) continue;
    const n = typeof a === 'string' ? normalizeName(a) : normalizeName(a.name);
    if (!n) continue;
    const raw = typeof a === 'string' ? n : (normalizeName(a.raw) || n);
    if (!rawByName.has(n)) names.push(n);
    if (!rawByName.has(n)) rawByName.set(n, raw);
  }

  // ── 축 B: ingredients[].name ──
  //   이 축에서는 **이름 그 자체가 라벨 원문**이다.
  //   ★ 그래서 축 B 가 축 A 의 `raw` 를 **이긴다.** 같은 마스터 이름이 두 축에 다 있으면
  //     「원재료명에 그 이름이 통째로 적혀 있었다」는 뜻이므로 더 좁고 정확한 원문이다.
  for (const s of (Array.isArray(ingredientNames) ? ingredientNames : [])) {
    const n = normalizeName(typeof s === 'string' ? s : (s && s.name));
    if (!n) continue;
    if (!rawByName.has(n)) names.push(n);
    rawByName.set(n, n);
  }

  return { names, rawByName };
}

/**
 * 합집합을 `product_additives` 에 넣는다.
 *
 * ⚠ `ON CONFLICT (product_id, additive_id) DO NOTHING` 은 계약 C1 이 **유지**로 못 박았다.
 *   경로 ②가 경로 ①의 `detected_name` 을 덮어쓰면, 나중에 온 «약한» 검출이
 *   먼저 온 «정확한» 원문을 지운다.
 *
 * @param {{query: Function}} client - 트랜잭션 client (또는 db)
 * @param {number} productId
 * @param {Object} opts
 * @param {Array}  [opts.detectedAdditives] - `analysis.additives`. 배열이 아니면 이름으로 직접 검출한다.
 * @param {Array<string>} [opts.ingredientNames]
 * @param {number} [opts.confidence]
 * @returns {Promise<{candidates:number, matched:number, inserted:number}>}
 */
async function upsertProductAdditives(client, productId, opts = {}) {
  const { ingredientNames, confidence } = opts;
  const detectedAdditives = Array.isArray(opts.detectedAdditives)
    ? opts.detectedAdditives
    : detectFromIngredientNames(ingredientNames);

  const { names, rawByName } = buildAdditiveCandidates({ detectedAdditives, ingredientNames });
  if (names.length === 0) return { candidates: 0, matched: 0, inserted: 0 };

  const matchResult = await client.query(
    `SELECT additive_id, name_ko
       FROM additives
      WHERE name_ko = ANY($1::text[])`,
    [names],
  );

  let inserted = 0;
  for (const row of matchResult.rows) {
    const detectedName = rawByName.get(row.name_ko) || row.name_ko;
    const r = await client.query(
      `INSERT INTO product_additives (product_id, additive_id, detected_name, confidence)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (product_id, additive_id) DO NOTHING`,
      [productId, row.additive_id, detectedName, confidence ?? null],
    );
    inserted += (r && typeof r.rowCount === 'number') ? r.rowCount : 0;
  }

  return { candidates: names.length, matched: matchResult.rows.length, inserted };
}

module.exports = {
  upsertProductAdditives,
  buildAdditiveCandidates,
  countDetected,
  detectFromIngredientNames,
};
