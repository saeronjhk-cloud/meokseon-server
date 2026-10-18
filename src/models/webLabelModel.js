/**
 * webLabelModel.js — ★ 세션79 U78-3 web_label(판매처 라벨 기반) 노출 읽기 전용 모델.
 *   설계: IP/U78-3_web_label_노출/설계_v2.md §2-2 A·B · 정답 셋 IP/eval_web_label_expose_v1/cases_v1.json
 *   ⚠ 쓰기 없음. public 표는 «같은 품목보고번호의 활성 제품이 있는가»를 보는 데만 읽는다(설계 D: 있으면 web_label 쪽을 숨김).
 *   ⚠ 노출 상태 = active · stale 만. needs_review·superseded·withdrawn 은 검색·상세 모두 없음.
 *   모든 함수의 마지막 인자 `q` 는 평가(트랜잭션 안 시뮬레이션)용 실행기다. 생략하면 공용 db.
 */
'use strict';

const db = require('../config/database');
const { normalizeSearchQuery, isSearchable } = require('../utils/searchNormalize');
const { normalizeAllergenRowsWithStats } = require('../services/allergenName');
const { _toNumericOrNull: num } = require('./productModel');

const EXPOSED = `('active','stale')`;
// 설계 D — public 에 같은 번호의 «활성» 제품이 생기면 web_label 품목은 숨긴다(비활성 public 은 숨김 사유가 아니다: 실측 14건이 전부 is_active=false).
const NOT_SHADOWED = `NOT EXISTS (SELECT 1 FROM public.products pp WHERE pp.is_active AND pp.c005_report_no = p.c005_report_no)`;
const NUM_NUT = ['calories', 'total_fat', 'saturated_fat', 'trans_fat', 'cholesterol', 'sodium', 'total_carbs', 'total_sugars', 'dietary_fiber', 'protein'];
const run = (q) => (q ? (text, params) => q.query(text, params) : (text, params) => db.query(text, params));

/** 이름 검색 — public searchByName 과 같은 정규화·같은 점수식(필드 가중치 + similarity). 첫 쪽 전용(호출부가 offset 0 일 때만 부른다). */
async function searchWebLabel(query, limit = 10, q) {
  const qn = normalizeSearchQuery(query);
  if (!isSearchable(qn)) return [];
  const r = await run(q)(
    `SELECT * FROM (
       SELECT DISTINCT ON (lower(p.product_name), lower(COALESCE(p.manufacturer, '')))
         p.product_id AS web_id, p.product_name, p.brand, p.manufacturer, p.food_type,
         p.total_content, p.content_unit, p.collected_at, p.status, p.nutrition_ok,
         ( CASE WHEN COALESCE(p.product_name,'') ILIKE '%' || $1 || '%' THEN 1.0 ELSE 0 END
         + CASE WHEN COALESCE(p.manufacturer,'') ILIKE '%' || $1 || '%' THEN 1.0 ELSE 0 END
         + CASE WHEN COALESCE(p.brand,'')        ILIKE '%' || $1 || '%' THEN 0.5 ELSE 0 END
         + CASE WHEN COALESCE(p.food_type,'')    ILIKE '%' || $1 || '%' THEN 0.3 ELSE 0 END
         + similarity(p.search_text, $1) * 0.5 ) AS score
       FROM web_label.products p
       WHERE p.status IN ${EXPOSED} AND ${NOT_SHADOWED}
         AND (p.search_text % $1 OR p.search_text ILIKE '%' || $1 || '%')
       ORDER BY lower(p.product_name), lower(COALESCE(p.manufacturer, '')), p.product_id
     ) sub ORDER BY score DESC, product_name LIMIT $2`,
    [qn, limit]);
  return r.rows.map(({ score, ...x }) => ({ ...x, web_id: Number(x.web_id), total_content: num(x.total_content) }));
}

/** 상세 1건 — productModel.findByBarcode 와 같은 별칭(nutrition_source·nutrition_serving_size)으로 낸다 → 응답 조립을 공유한다. */
async function findWebProduct(webId, q) {
  const r = await run(q)(
    `SELECT p.product_id, NULL::text AS barcode, p.product_name, p.brand, p.manufacturer,
            p.food_type, p.food_category, p.serving_size, p.total_content, p.content_unit,
            p.data_source, NULL::text AS image_url, p.verification, p.verify_count,
            p.status, p.nutrition_ok, p.collected_at, p.c005_report_no, p.quality,
            n.calories, n.total_fat, n.saturated_fat, n.trans_fat, n.cholesterol, n.sodium,
            n.total_carbs, n.total_sugars, n.dietary_fiber, n.protein,
            n.data_source AS nutrition_source, n.serving_size AS nutrition_serving_size, n.verified_at,
            n.label_basis
       FROM web_label.products p
       LEFT JOIN web_label.nutrition_data n ON n.product_id = p.product_id
      WHERE p.product_id = $1 AND p.status IN ${EXPOSED} AND ${NOT_SHADOWED}
      LIMIT 1`, [webId]);
  const row = r.rows[0];
  if (!row) return null;
  const out = { ...row, product_id: Number(row.product_id) };
  for (const k of [...NUM_NUT, 'serving_size', 'total_content']) out[k] = num(row[k]);
  return out;
}

/**
 * ★ 세션79 바코드 잇기 — 스캔 바코드 → 연결된 web_label 품목 id(auto·approved · 노출 상태 · 숨김 아님). 0개·2개 이상(모호)이면 null.
 *   정답 IP/eval_barcode_link_v1/runtime_v1.json(E7).
 */
async function findWebIdByBarcode(barcode, q) {
  const r = await run(q)(
    `SELECT DISTINCT b.product_id FROM web_label.product_barcodes b
       JOIN web_label.products p ON p.product_id = b.product_id
      WHERE b.barcode = $1 AND b.status IN ('auto','approved') AND p.status IN ${EXPOSED} AND ${NOT_SHADOWED}`, [barcode]);
  return r.rows.length === 1 ? Number(r.rows[0].product_id) : null;
}

/** 표시란 알레르기 — productModel.getAllergens 와 같은 행 모양·같은 정규화(19종 밖 이름은 버리고 stats.dropped 에 센다). */
async function getWebAllergens(webId, stats, q) {
  const r = await run(q)(
    `SELECT allergen_name, evidence_level, status, source_count, detected_via
       FROM web_label.product_allergens WHERE product_id = $1
      ORDER BY CASE evidence_level WHEN 'contains' THEN 1 WHEN 'inferred' THEN 2 WHEN 'may_contain' THEN 3 ELSE 4 END,
               source_count DESC, allergen_name`, [webId]);
  const n = normalizeAllergenRowsWithStats(r.rows);
  if (stats) stats.dropped = n.dropped;
  return n.rows;
}

/** 원재료 원문 — productModel.getIngredientText 와 같은 반환 계약({text, source, raw_source} · 실패 undefined). */
async function getWebIngredientText(webId, q) {
  try {
    const r = await run(q)(
      `SELECT raw_text, source FROM web_label.product_ingredients
        WHERE product_id = $1 AND raw_text IS NOT NULL AND btrim(raw_text) <> '' ORDER BY id LIMIT 1`, [webId]);
    if (!r.rows[0]) return { text: null, source: null };
    return { text: String(r.rows[0].raw_text).trim(), source: 'own', raw_source: r.rows[0].source };
  } catch (_) { return undefined; }
}

/** public 제품의 판매처 라벨 보충(active 만) — 축별 최신 1건. 수집일 = 원문 페이지 fetched_at(없으면 created_at). */
async function getActiveSupplements(productId, q) {
  const r = await run(q)(
    `SELECT DISTINCT ON (s.axis) s.axis, s.data, COALESCE(sp.fetched_at, s.created_at) AS collected_at
       FROM web_label.public_supplements s
       LEFT JOIN web_label.source_pages sp ON sp.url = s.source_url
      WHERE s.product_id = $1 AND s.status = 'active'
      ORDER BY s.axis, s.updated_at DESC, s.supplement_id DESC`, [productId]);
  return r.rows;
}

module.exports = { searchWebLabel, findWebProduct, findWebIdByBarcode, getWebAllergens, getWebIngredientText, getActiveSupplements };
