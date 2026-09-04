'use strict';
/**
 * reviewQueueRead.js — 관리자 제보 검토 큐의 «읽기 전용» 조회 본문
 * ============================================================================
 * ① 정체성 —
 *   `contribution_review` 를 **목록으로 읽는 유일한 곳**이다.
 *   `listReviewQueue(client, opts)`   → 계약 세션67 §5-1 의 응답 `data`
 *   `getReviewDetail(client, productId)` → 계약 세션67 §5-2 의 응답 `data`
 *
 * ② 왜 생겼나 (계약 `.tmp/s67/계약_세션67.md` §2 G1·G2) —
 *   세션66 이 「제보는 공식 테이블에 쓰지 않는다」를 운영에 넣었다. 그 결과 실측으로:
 *     · `nutrition_data` 의 `ocr_crowdsource` = **0행**
 *     · `contribution_review` 에 `candidate` **5건 대기**
 *     · 그런데 그 큐를 **목록으로 읽는 엔드포인트가 0개**였다(`G1`).
 *   ⇒ 제보가 「아무에게도 안 보이는」 상태였다. 이 파일이 그 눈이다.
 *
 * ③ ★★ 이 화면의 «존재 이유» 두 필드 —
 *   · `held` = `status='approved' AND applied_at IS NULL` — **보류**.
 *     승인은 됐는데 반영이 안 된 상태다. `approveAndApply` 는 `candidate` 만 집으므로
 *     **`approve` 로는 다시 안 잡힌다**(세션67 `G2`).
 *     ⚠⚠ 세션67 검증 정정 — 이 자리에 「`undo` 도 `UNDO_EVIDENCE_MISSING` 을 던져
 *       막다른 길이다」라고 적혀 있었는데 **틀렸다.** `undoAppliedContribution` 은
 *       `applied_at IS NULL` 검사(`:1101`)가 그 예외(`:1108`)보다 **먼저** 있어
 *       `{undone:false, reason:'NOT_APPLIED'}` 로 조용히 성공하고, `reopen` 도 통과한다.
 *       ⇒ `reopen` → `approve` 로 «이미» 나올 수 있었다. `retry` 는 그것을 1클릭으로
 *         줄이고 `approved` 를 유지할 뿐이다(버그 수정이 아니라 더 나은 경로).
 *     ★ 그래도 이 필드는 필수다 — **이 필드가 없으면 보류 행이 어느 화면에도 «안 뜬다».**
 *       나올 길이 있어도 «보이지 않으면» 아무도 안 나온다.
 *   · `basis` — 「지금 승인하면 반영될 것인가」를 «누르기 전»에 알려 준다.
 *     `null` 이면 승인해도 `BASIS_UNKNOWN` 으로 보류된다. 누른 뒤 409 로 아는 것은 늦다.
 *
 * ④ 이 파일이 «하지 않는» 것 —
 *   ⛔ **쓰기 SQL 이 한 줄도 없다.** INSERT·UPDATE·DELETE 를 여기에 넣지 말 것.
 *      판정을 바꾸는 것은 `adminRoutes` 의 `/verify` 와 `contributionApply` 의 소관이다.
 *   ⛔ `require('../config/database')` 를 하지 않는다. `client` 를 인자로 받는다
 *      (그래야 pglite 로 실제 SQL 을 검증할 수 있다 — `contributionApply.js` 와 같은 규율).
 *   ⛔ `BEGIN`/`COMMIT` 을 부르지 않는다. 읽기다.
 *   ⛔ ★ **기준(basis) 판정 규칙을 다시 구현하지 않는다**(계약 §4 Q6).
 *      `contributionApply.resolveBasis` 를 **호출**한다. 화면이 규칙을 두 벌 갖는 순간
 *      한쪽만 고치게 되고, 그때 「승인하면 될까」 예고와 실제 승인 결과가 갈린다.
 *   ⛔ ★★ `contributions.data` 를 **통째로 내보내지 않는다**(계약 §5-4).
 *      거기엔 `ocr_raw_text` · `device_id` 가 들어 있다. `proposed` 는
 *      `pickNutritionObject` · `pickIngredientNames` · `buildAllergenList` 로 «뽑아» 만들고,
 *      영양은 다시 `CROWD_NUTRIENT_KEYS` **화이트리스트**로 거른다.
 *      (세션64c `test:contributions-mine` ⑥ 「개인정보 무유출」과 같은 축이다.)
 *
 * ⑤ ★ N+1 금지 —
 *   `listReviewQueue` 는 제품이 몇 건이든 **쿼리 4번**이다(존재 확인 1 + 총계 1 + 제품 페이지 1
 *   + 축·제보 1 + 제품 메타 1 = 5). 제품마다 축을 다시 묻지 않는다.
 *
 * ⑥ ★ 024 «미적용» DB 방어 (배포 순서 · 세션66 §1) —
 *   `to_regclass` 로 **매 호출마다** 판정한다. `mergeService.hasContributionReviewTable()` 을
 *   재사용하지 «않은» 이유는 아래 `hasReviewTable` 주석에 적었다. 요약: 그 함수는
 *   ㉠ 「없다」를 **캐싱**해서 024 적용 후에도 재시작 전엔 회복하지 않고,
 *   ㉡ 인자로 받은 `client` 가 아니라 모듈 전역 `db` 를 본다(이 파일의 주입 규율과 어긋난다).
 */

const {
  resolveBasis,
  pickNutritionObject,
  pickIngredientNames,
  buildAllergenList,
  CROWD_NUTRIENT_KEYS,
  AXES,
} = require('./contributionApply');

// ============================================================================
// 0. 어휘·상수
// ============================================================================

/** `cr_status_chk`(024)와 «같은» 목록이어야 한다. 어휘 밖 값은 조용히 버린다. */
const REVIEW_STATUSES = ['candidate', 'approved', 'rejected', 'undone', 'superseded'];

/** 계약 §5-1 — `status` 를 안 주면 「지금 사람이 볼 것」 둘이다. */
const DEFAULT_STATUSES = ['candidate', 'approved'];

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

/**
 * ★★ `contribution_review.evidence` 에서 **지우고 내보내는** 키.
 *
 * ⚠ 이것은 이론적 방어가 아니다. 실측으로 셋이 실려 있다:
 *   · `crowdsourceService.js` 의 `commonEvidence` 에 **`device_id` 가 그대로** 들어간다.
 *   · `contributionApply.applyIngredientsAxis` 는 `data.ocr_raw_text` 를
 *     `product_ingredients.raw_text` 로 쓰고, 그 행이 `evidence.before.rows[].raw_text` 로
 *     되돌아온다 ⇒ **OCR 원문이 evidence 를 타고 나온다.**
 *   · `user_input` 은 사용자가 손으로 적은 값이다.
 *
 * ⇒ 그래서 「evidence 원본을 그대로」(계약 §5-2)를 **키 단위로 한 겹 걸러서** 지킨다.
 *   merge 판정(`origin`·`source_count`·`distinct_device_count`·median·이상치)은
 *   **하나도 안 지운다** — 관리자가 「기기 3대가 무엇에 일치했는가」를 볼 근거다.
 *   ★ 기기 «수»는 남기고 기기 «식별자»만 지운다. 그 둘은 다른 것이다.
 */
const EVIDENCE_PII_KEYS = new Set([
  'device_id', 'device_ids', 'ocr_raw_text', 'raw_text', 'user_input', 'user_id',
]);

/** 재귀 폭주 방어. evidence 는 사람이 만든 JSON 이 아니라 코드가 쌓아 올린 것이다. */
const SCRUB_MAX_DEPTH = 12;

// ============================================================================
// 1. 순수 헬퍼 — DB 없이 단정된다
// ============================================================================

/** JSONB 는 드라이버에 따라 객체이거나 문자열이다. 둘 다 받는다. */
function asObject(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (_) { return null; }
  }
  return null;
}

function toIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * `status=a,b` · `status[]=a&status[]=b` · `status=a` 를 하나로 받는다.
 * 어휘 밖 값은 **버린다**(400 을 던지지 않는다 — 읽기 화면이 오타 하나로 죽으면 안 된다).
 * 전부 버려져 빈 배열이 되면 `fallback` 을 쓴다.
 */
function normalizeList(raw, vocabulary, fallback) {
  let parts;
  if (raw === undefined || raw === null || raw === '') parts = [];
  else if (Array.isArray(raw)) parts = raw;
  else parts = String(raw).split(',');
  const out = [];
  for (const p of parts) {
    const s = String(p).trim();
    if (vocabulary.includes(s) && !out.includes(s)) out.push(s);
  }
  return out.length ? out : fallback.slice();
}

/** `1` · `'1'` · `'true'` · `true` 를 참으로 본다. 그 밖은 거짓. */
function isTruthyFlag(v) {
  if (v === true) return true;
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'y' || s === 'yes';
}

/**
 * ★★ evidence 에서 개인정보 키를 **지운다.** 값을 가리는 것이 아니라 «키째» 지운다 —
 *   `'[redacted]'` 로 바꾸면 `device_id` 라는 **키 문자열이 응답 원문에 남는다**.
 */
function scrubEvidence(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (depth > SCRUB_MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.map((v) => scrubEvidence(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (EVIDENCE_PII_KEYS.has(k)) continue;
    out[k] = scrubEvidence(v, depth + 1);
  }
  return out;
}

/**
 * ★ 제보 영양 객체를 **화이트리스트로** 뽑는다.
 * `pickNutritionObject` 가 돌려주는 것은 `contributions.data.parsed_nutrition` **원본**이라
 * 파서가 넣은 임의의 키(`_basis`·`_raw`·`serving_size` …)가 섞여 있다.
 * 그대로 내보내면 「원본을 통째로 내보내지 않는다」가 반쯤만 지켜진다.
 */
function proposedNutrition(data) {
  const src = pickNutritionObject(data);
  if (!src) return { nutrition: null, nutrient_count: 0 };
  const out = {};
  let n = 0;
  for (const k of CROWD_NUTRIENT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    const v = src[k];
    const num = (v === null || v === undefined || v === '') ? null : Number(v);
    out[k] = Number.isFinite(num) ? num : null;
    if (out[k] !== null) n += 1;
  }
  return { nutrition: out, nutrient_count: n };
}

/**
 * 축별 `proposed` 를 만든다 (계약 §5-4 — 모양은 에이전트 B 가 정한다).
 *
 * ★ 네 축이 **서로 다른 모양**인 것이 맞다. 억지로 같은 모양으로 맞추면
 *   화면이 「빈 값」과 「그 축에 없는 개념」을 구분하지 못한다.
 * ★ `null` 과 `[]` 를 «구분»한다 — `ingredients: null` = 「원재료를 안 봤다」,
 *   `[]` = 「봤는데 없었다」(`U63-6`). 이 구분이 이 저장소의 규칙이다.
 */
function buildProposed(axis, data) {
  const d = data || {};
  switch (axis) {
    case 'nutrition':
      return proposedNutrition(d);
    case 'ingredients': {
      const names = pickIngredientNames(d);
      return { ingredients: names, count: names === null ? 0 : names.length };
    }
    case 'allergens': {
      const { inspected, list } = buildAllergenList(d);
      return {
        inspected,
        allergens: inspected ? list : null,
        count: inspected ? list.length : 0,
      };
    }
    case 'additives': {
      // 첨가물 축의 제보값은 **원재료명**이다 — 검출은 승인 시
      // `additiveResolver.detectFromIngredientNames` 가 다시 한다(규칙을 두 벌로 만들지 않는다).
      const names = pickIngredientNames(d);
      return {
        ingredient_names: names,
        count: names === null ? 0 : names.length,
        has_explicit_additives: Array.isArray(d.additives),
      };
    }
    default:
      return null;
  }
}

// ============================================================================
// 2. 024 미적용 방어
// ============================================================================

/**
 * `contribution_review` 테이블이 «지금» 있는가.
 *
 * ★★ `mergeService.hasContributionReviewTable()` 을 **재사용하지 않았다.** 근거 둘:
 *
 *   ㉠ 그 함수는 「없다」도 **캐싱**한다(`mergeService.js` 의 `_hasContributionReview`).
 *      쓰기 경로에서는 그것이 옳다 — 제보 저장이 매번 `information_schema` 를 뒤지면
 *      느리고, 「없다」가 잠깐 더 유지돼도 제보 원본은 `contributions` 에 남는다.
 *      그러나 **읽기 화면에서는 정반대다.** 024 를 적용한 직후 관리자가 새로고침하면
 *      화면은 여전히 「큐가 비었다」를 보여 준다. 서버를 재시작하기 전까지 회복이 없고,
 *      그 사이 관리자는 **「제보가 0건이다」라고 믿는다.** 이 화면이 존재하는 이유가
 *      정확히 그 오해를 없애는 것이므로, 여기서 그 캐시를 쓰면 목적이 뒤집힌다.
 *
 *   ㉡ 그 함수는 인자로 받은 `client` 가 아니라 **모듈 전역 `db`** 를 본다.
 *      이 파일은 `client` 를 주입받는 규율(`contributionApply.js` 와 같다)이라,
 *      「존재 확인은 A 연결에서, 실제 조회는 B 연결에서」가 된다. 테스트에서도
 *      shim 이 아닌 진짜 Pool 을 끌어올 여지가 생긴다.
 *
 * ⇒ `to_regclass` 로 매 호출 판정한다. 쿼리 1번이고, 이미
 *   `adminRoutes` 의 `/review/summary` 가 쓰는 «같은 규칙»이다(새 규칙이 아니다).
 *
 * ⚠ 판정 자체가 실패하면(연결 문제 등) **false 를 돌려 500 대신 빈 큐를 낸다.**
 *   그리고 그 사실은 `queue_ready:false` 로 응답에 실려 나간다 — 조용한 무동작이 아니다.
 */
async function hasReviewTable(client) {
  try {
    const r = await client.query(`SELECT to_regclass('public.contribution_review') AS t`);
    return !!(r && r.rows && r.rows.length && r.rows[0].t);
  } catch (_) {
    return false;
  }
}

const EMPTY_TOTALS = Object.freeze({
  candidate: 0, held: 0, approved_applied: 0, rejected: 0,
});

// ============================================================================
// 3. §5-1  GET /api/admin/review/contributions
// ============================================================================

/**
 * 검토 큐 목록. **제품 단위로 묶고, 축을 배열로** 낸다.
 *
 * ★ `limit`/`offset` 은 «제품» 단위다(계약 §5-1 의 `items[]` 가 제품이다).
 *   축 단위로 자르면 한 제품의 축이 페이지 경계에서 갈라져 화면이 반쪽 카드를 그린다.
 *
 * ⚠ `product_id IS NULL` 인 검토 행(바코드가 아직 `products` 에 없는 제보 — 024 가
 *   «의도적으로» 허용한 경우)은 **이 목록에 안 나온다.** 제품 단위로 묶는 화면이라
 *   묶을 키가 없다. 보고서에 「소관 밖 발견」으로 적었다(`U66-1` 축).
 *
 * @param {{query: Function}} client
 * @param {{status?, axis?, held?, limit?, offset?}} [opts]
 * @returns {Promise<{count:number, totals:object, items:Array, queue_ready:boolean,
 *                    limit:number, offset:number}>}
 */
async function listReviewQueue(client, opts = {}) {
  const statuses = normalizeList(opts.status, REVIEW_STATUSES, DEFAULT_STATUSES);
  const axes = normalizeList(opts.axis, AXES, AXES);
  const heldOnly = isTruthyFlag(opts.held);
  const limit = Math.min(Math.max(toIntOrNull(opts.limit) || LIMIT_DEFAULT, 1), LIMIT_MAX);
  const offset = Math.max(toIntOrNull(opts.offset) || 0, 0);

  // ── ⓪ 024 미적용 방어 ──
  if (!(await hasReviewTable(client))) {
    return {
      count: 0, totals: { ...EMPTY_TOTALS }, items: [],
      queue_ready: false, limit, offset,
    };
  }

  // ── ① 총계 — ★ 필터와 «무관하게» 전역이다 ──
  //   화면의 탭 배지(특히 「보류」)는 지금 보고 있는 탭이 무엇이든 **큐 전체**를 말해야 한다.
  //   nutrition 탭을 보는 동안 보류 배지가 0 으로 보이면, 그것이 바로 이 화면이
  //   없애려던 「안 보인다」다.
  const totalsRow = (await client.query(
    `SELECT count(*) FILTER (WHERE status = 'candidate')::int                        AS candidate,
            count(*) FILTER (WHERE status = 'approved' AND applied_at IS NULL)::int  AS held,
            count(*) FILTER (WHERE status = 'approved' AND applied_at IS NOT NULL)::int
                                                                                     AS approved_applied,
            count(*) FILTER (WHERE status = 'rejected')::int                         AS rejected
       FROM contribution_review`)).rows[0];
  const totals = {
    candidate: Number(totalsRow.candidate) || 0,
    held: Number(totalsRow.held) || 0,
    approved_applied: Number(totalsRow.approved_applied) || 0,
    rejected: Number(totalsRow.rejected) || 0,
  };

  // ── 공통 필터 ──
  const params = [statuses, axes];
  let where = 'cr.product_id IS NOT NULL AND cr.status = ANY($1::text[]) AND cr.axis = ANY($2::text[])';
  if (heldOnly) where += " AND cr.status = 'approved' AND cr.applied_at IS NULL";

  // ── ② 이 페이지의 제품 목록 (쿼리 1번) ──
  //   ★ **오래된 순**이다. 024 의 `idx_cr_status (status, created_at)` 이 전제한 읽기 패턴이고,
  //     큐는 오래 기다린 것부터 본다. `product_id` tie-breaker 로 페이지가 겹치지 않게 한다.
  const pageRows = (await client.query(
    `SELECT cr.product_id, min(cr.created_at) AS oldest
       FROM contribution_review cr
      WHERE ${where}
      GROUP BY cr.product_id
      ORDER BY min(cr.created_at) ASC, cr.product_id ASC
      LIMIT $3 OFFSET $4`,
    [...params, limit, offset])).rows;

  const productIds = pageRows.map((r) => Number(r.product_id));
  if (productIds.length === 0) {
    return { count: 0, totals, items: [], queue_ready: true, limit, offset };
  }

  // ── ③ 그 제품들의 축 + 원본 제보 (쿼리 1번 — ★ 제품마다 묻지 않는다) ──
  //   ⚠ `c.data` 를 **여기서만** 읽는다. 응답에는 절대 실리지 않는다 —
  //     `basis` 판정과 `proposed` 추출에만 쓰고 버린다.
  const axisRows = (await client.query(
    `SELECT cr.review_id, cr.product_id, cr.axis, cr.status, cr.contribution_id,
            cr.created_at, cr.reviewed_by, cr.reviewed_at, cr.applied_at, cr.reject_reason,
            cr.evidence->>'origin' AS origin,
            cr.evidence AS evidence,
            c.data AS contribution_data
       FROM contribution_review cr
       LEFT JOIN contributions c ON c.contribution_id = cr.contribution_id
      WHERE cr.product_id = ANY($3::bigint[]) AND ${where}
      ORDER BY cr.product_id ASC, cr.created_at ASC, cr.review_id ASC`,
    [...params, productIds])).rows;

  // ── ④ 제품 메타 + 「공공 영양 행이 있는가」 (쿼리 1번) ──
  const productRows = (await client.query(
    `SELECT p.product_id, p.barcode, p.product_name, p.manufacturer, p.verification,
            p.serving_size, p.serving_unit, p.total_content, p.content_unit,
            (nd.product_id IS NOT NULL) AS has_public_nutrition,
            nd.serving_size AS public_serving_marker
       FROM products p
       LEFT JOIN nutrition_data nd ON nd.product_id = p.product_id
      WHERE p.product_id = ANY($1::bigint[])`,
    [productIds])).rows;
  const productById = new Map(productRows.map((p) => [Number(p.product_id), p]));

  // ── ⑤ 조립 ──
  const byProduct = new Map();
  for (const pid of productIds) byProduct.set(pid, []);
  for (const row of axisRows) {
    const pid = Number(row.product_id);
    if (!byProduct.has(pid)) continue;
    byProduct.get(pid).push(row);
  }

  const items = productIds.map((pid) => {
    const p = productById.get(pid) || {};
    const rows = byProduct.get(pid) || [];
    const axesOut = rows.map((row) => buildAxisSummary(row, p));
    return {
      product_id: pid,
      barcode: p.barcode ?? null,
      product_name: p.product_name ?? null,
      manufacturer: p.manufacturer ?? null,
      verification: p.verification ?? null,
      has_public_nutrition: !!p.has_public_nutrition,
      axes: axesOut,
      pending_count: axesOut.filter((a) => a.status === 'candidate').length,
      held_count: axesOut.filter((a) => a.held).length,
    };
  });

  return { count: items.length, totals, items, queue_ready: true, limit, offset };
}

/**
 * 검토 행 1개 → 계약 §5-1 의 `axes[]` 원소.
 *
 * ★★ `held` 가 이 함수의 «핵심»이다. `status='approved' AND applied_at IS NULL`.
 *   승인은 됐는데 반영이 안 된 상태 — `approve` 로는 다시 안 잡힌다(`G2`).
 *   나가는 길은 `retry`(1클릭) 또는 `reopen` → `approve` 다. ⚠ 머리말 ③의 정정을 볼 것.
 *   화면이 이것을 못 그리면 그 행들은 **어디에도 안 보인다** — 길이 있어도 안 보이면 못 나온다.
 *
 * ★ `basis` 는 **nutrition 축만** 낸다. 다른 축에 기준이라는 개념이 없다.
 *   ⛔ 판정은 `resolveBasis` 가 한다 — 여기서 다시 계산하지 않는다(계약 §4 Q6).
 */
function buildAxisSummary(row, productRow) {
  const held = row.status === 'approved'
    && (row.applied_at === null || row.applied_at === undefined);

  let basis = null;
  let basisRaw = null;
  let basisFrom = null;
  if (row.axis === 'nutrition') {
    const r = resolveBasis(
      asObject(row.contribution_data) || {},
      {
        has_public_nutrition: !!(productRow && productRow.has_public_nutrition),
        public_serving_marker: (productRow && productRow.public_serving_marker) ?? null,
      },
      row.evidence,
    );
    basis = r.basis;
    basisRaw = r.evidence.raw ?? null;
    basisFrom = r.evidence.from ?? null;
  }

  return {
    review_id: Number(row.review_id),
    axis: row.axis,
    status: row.status,
    contribution_id: row.contribution_id === null || row.contribution_id === undefined
      ? null : Number(row.contribution_id),
    origin: row.origin ?? null,
    created_at: row.created_at ?? null,
    reviewed_by: row.reviewed_by ?? null,
    reviewed_at: row.reviewed_at ?? null,
    applied_at: row.applied_at ?? null,
    reject_reason: row.reject_reason ?? null,
    held,
    basis,
    basis_raw: basisRaw,
    basis_from: basisFrom,
  };
}

// ============================================================================
// 4. §5-2  GET /api/admin/review/contributions/:productId
// ============================================================================

/**
 * 제품 1개의 검토 상세. **제보값 vs 현재 공식값**을 나란히 놓을 재료를 낸다.
 *
 * ★ `current` 는 **공공(`nutrition_data`) 기준**이다. `nutrition_data_crowd`(승인된 제보)를
 *   섞지 않는다 — 화면이 비교하려는 것이 「제보 vs 공식 공공값」이고, 뷰의 통합 결과를
 *   내놓으면 「이미 반영된 내 제보」와 「원래 공공값」이 한 칸에서 겹친다.
 *
 * @param {{query: Function}} client
 * @param {number|string} productId
 * @returns {Promise<object|null>} 제품이 없으면 `null` (호출부가 404 를 낸다)
 */
async function getReviewDetail(client, productId) {
  const pid = toIntOrNull(productId);
  if (pid === null) return null;

  // ── ① 제품 + 공공 영양 (쿼리 1번) ──
  const prow = (await client.query(
    `SELECT p.product_id, p.barcode, p.product_name, p.manufacturer,
            p.serving_size, p.serving_unit, p.total_content, p.content_unit,
            p.verification,
            (nd.product_id IS NOT NULL) AS has_public_nutrition,
            nd.serving_size AS public_serving_marker,
            nd.data_source  AS nutrition_source,
            nd.calories, nd.total_fat, nd.saturated_fat, nd.trans_fat, nd.cholesterol,
            nd.sodium, nd.total_carbs, nd.total_sugars, nd.added_sugars, nd.dietary_fiber,
            nd.protein, nd.calcium, nd.iron, nd.vitamin_d, nd.potassium
       FROM products p
       LEFT JOIN nutrition_data nd ON nd.product_id = p.product_id
      WHERE p.product_id = $1`,
    [pid])).rows[0];
  if (!prow) return null;

  const product = {
    product_id: Number(prow.product_id),
    barcode: prow.barcode ?? null,
    product_name: prow.product_name ?? null,
    manufacturer: prow.manufacturer ?? null,
    serving_size: prow.serving_size ?? null,
    serving_unit: prow.serving_unit ?? null,
    total_content: prow.total_content ?? null,
    content_unit: prow.content_unit ?? null,
    verification: prow.verification ?? null,
  };

  let currentNutrition = null;
  if (prow.has_public_nutrition) {
    currentNutrition = {};
    for (const k of CROWD_NUTRIENT_KEYS) currentNutrition[k] = prow[k] ?? null;
    // ★ 마커 문자열이지 숫자가 아니다. `deriveBasis` 가 이 문자열로 기준을 읽는다
    //   (`productModel.NUM_NUTRITION` 이 「숫자로 바꾸면 전 제품 basis 가 무너진다」고
    //    못 박은 그 컬럼이다). 이름을 `serving_size_marker` 로 «명시»해서 내보낸다.
    currentNutrition.serving_size_marker = prow.public_serving_marker ?? null;
    currentNutrition.source = prow.nutrition_source ?? null;
  }

  // ── ② 현재 공식 원재료 · 알레르겐 · 첨가물 (쿼리 3번 · 고정) ──
  const ingRows = (await client.query(
    `SELECT id, parsed_ingredients, source
       FROM product_ingredients WHERE product_id = $1 ORDER BY id`, [pid])).rows;
  const seen = new Set();
  const currentIngredients = [];
  for (const r of ingRows) {
    const list = asObject(r.parsed_ingredients);
    if (!Array.isArray(list)) continue;
    for (const it of list) {
      const name = typeof it === 'string' ? it : (it && it.name);
      if (typeof name !== 'string' || !name.trim()) continue;
      const v = name.trim();
      if (seen.has(v)) continue;   // 식약처 행과 제보 행이 같은 이름을 두 번 싣는다
      seen.add(v);
      currentIngredients.push({ name: v, sequence: currentIngredients.length + 1 });
    }
  }
  // ⛔ `raw_text` 를 내보내지 않는다 — 제보로 들어온 행의 `raw_text` 는
  //   `contributions.data.ocr_raw_text` 일 수 있다(`contributionApply.applyIngredientsAxis`).

  const currentAllergens = (await client.query(
    `SELECT allergen_name, evidence_level, detected_via
       FROM product_allergens WHERE product_id = $1 ORDER BY allergen_name`, [pid])).rows
    .map((r) => ({
      allergen_name: r.allergen_name,
      evidence_level: r.evidence_level ?? null,
      detected_via: r.detected_via ?? null,
    }));

  const currentAdditives = (await client.query(
    `SELECT pa.additive_id, a.name_ko, pa.detected_name
       FROM product_additives pa
       LEFT JOIN additives a ON a.additive_id = pa.additive_id
      WHERE pa.product_id = $1
      ORDER BY pa.additive_id`, [pid])).rows
    .map((r) => ({
      additive_id: Number(r.additive_id),
      name_ko: r.name_ko ?? null,
      detected_name: r.detected_name ?? null,
    }));

  const current = {
    nutrition: currentNutrition,
    ingredients: currentIngredients,
    allergens: currentAllergens,
    additives: currentAdditives,
  };

  // ── ③ 검토 축 (쿼리 1번). 024 미적용이면 «빈 배열», 500 이 아니다 ──
  if (!(await hasReviewTable(client))) {
    return { product, current, axes: [], queue_ready: false };
  }

  const rows = (await client.query(
    `SELECT cr.review_id, cr.axis, cr.status, cr.contribution_id,
            cr.created_at, cr.reviewed_by, cr.reviewed_at, cr.applied_at, cr.reject_reason,
            cr.evidence->>'origin' AS origin,
            cr.evidence AS evidence,
            c.data AS contribution_data
       FROM contribution_review cr
       LEFT JOIN contributions c ON c.contribution_id = cr.contribution_id
      WHERE cr.product_id = $1
      ORDER BY cr.created_at ASC, cr.review_id ASC`,
    [pid])).rows;

  const axesOut = rows.map((row) => {
    const data = asObject(row.contribution_data) || {};
    const held = row.status === 'approved'
      && (row.applied_at === null || row.applied_at === undefined);

    let basis = null;
    if (row.axis === 'nutrition') {
      const r = resolveBasis(
        data,
        {
          has_public_nutrition: !!prow.has_public_nutrition,
          public_serving_marker: prow.public_serving_marker ?? null,
        },
        row.evidence,
      );
      basis = {
        value: r.basis,
        raw: r.evidence.raw ?? null,
        from: r.evidence.from ?? null,
        considered: r.evidence.considered || [],
        product_basis: r.evidence.product_basis ?? null,
        admin_basis: r.evidence.admin_basis ?? null,
      };
    }

    return {
      review_id: Number(row.review_id),
      axis: row.axis,
      status: row.status,
      held,
      contribution_id: row.contribution_id === null || row.contribution_id === undefined
        ? null : Number(row.contribution_id),
      origin: row.origin ?? null,
      created_at: row.created_at ?? null,
      reviewed_by: row.reviewed_by ?? null,
      reviewed_at: row.reviewed_at ?? null,
      applied_at: row.applied_at ?? null,
      reject_reason: row.reject_reason ?? null,
      proposed: buildProposed(row.axis, data),
      basis,
      // ★ merge 판정(median·기기 «수»·이상치)은 **살려서** 내보낸다.
      //   개인 식별자만 키째 지운다 — `EVIDENCE_PII_KEYS` 주석 참조.
      evidence: scrubEvidence(asObject(row.evidence)),
    };
  });

  return { product, current, axes: axesOut, queue_ready: true };
}

module.exports = {
  listReviewQueue,
  getReviewDetail,
  // 테스트·호출부가 읽는 것 (규칙을 두 벌로 적지 않기 위해 여기서만 정의한다)
  hasReviewTable,
  REVIEW_STATUSES,
  DEFAULT_STATUSES,
  LIMIT_MAX,
  LIMIT_DEFAULT,
  EVIDENCE_PII_KEYS,
  // 순수 함수 (DB 없이 단정된다)
  scrubEvidence,
  buildProposed,
  normalizeList,
};
