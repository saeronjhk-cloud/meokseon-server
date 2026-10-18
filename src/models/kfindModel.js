/**
 * kfindModel.js — ★ 세션80 결정 80-1 · 식약처 K-FIND 가공식품DB(kfind 스키마 · 035) 읽기 전용 모델.
 *   정답 IP/eval_kfind_expose_v1/cases_v1.json (R1~R8 · K01~K11).
 *   ⚠ 쓰기 없음. 숨김(R2·읽기 시점): 같은 품목보고번호의 public «활성» 제품 또는 «노출 중» web_label 품목이 있으면 숨긴다.
 *   ⚠ 노출 상태 = active 만(withdrawn 비노출).
 *   모든 함수의 마지막 인자 `q` 는 평가용 실행기(생략 = 공용 db).
 */
'use strict';

const db = require('../config/database');
const { normalizeSearchQuery, isSearchable } = require('../utils/searchNormalize');
const { _toNumericOrNull: num } = require('./productModel');

const NUM_NUT = ['calories', 'total_fat', 'saturated_fat', 'trans_fat', 'cholesterol', 'sodium', 'total_carbs', 'total_sugars', 'dietary_fiber', 'protein'];
// R2 — web_label 의 «노출 중» 정의는 webLabelModel 과 같다(active·stale 이고 public 활성 동번호에 가려지지 않음).
const NOT_SHADOWED = `k.report_no IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.products pp WHERE pp.is_active AND pp.c005_report_no = k.report_no)
  AND NOT EXISTS (SELECT 1 FROM web_label.products w WHERE w.status IN ('active','stale') AND w.c005_report_no = k.report_no
                    AND NOT EXISTS (SELECT 1 FROM public.products pp2 WHERE pp2.is_active AND pp2.c005_report_no = w.c005_report_no))`;
const run = (q) => (q ? (text, params) => q.query(text, params) : (text, params) => db.query(text, params));

/** 이름 검색 — public·web_label 과 같은 정규화·같은 점수식. 첫 쪽 전용. */
async function searchKfind(query, limit = 10, q) {
  const qn = normalizeSearchQuery(query);
  if (!isSearchable(qn)) return [];
  const r = await run(q)(
    `SELECT * FROM (
       SELECT DISTINCT ON (lower(k.food_name), lower(COALESCE(k.maker, k.importer, '')))
         k.food_cd, k.food_name, k.maker, k.importer, k.is_imported, k.origin_country, k.food_type, k.basis, k.food_weight,
         k.calories, k.nutrition_ok, k.release_id,
         ( CASE WHEN COALESCE(k.food_name,'') ILIKE '%' || $1 || '%' THEN 1.0 ELSE 0 END
         + CASE WHEN COALESCE(k.maker,'')     ILIKE '%' || $1 || '%' THEN 1.0 ELSE 0 END
         + CASE WHEN COALESCE(k.importer,'')  ILIKE '%' || $1 || '%' THEN 0.5 ELSE 0 END
         + CASE WHEN COALESCE(k.rep_food,'')  ILIKE '%' || $1 || '%' THEN 0.3 ELSE 0 END
         + similarity(k.search_text, $1) * 0.5 ) AS score
       FROM kfind.products k
       WHERE k.status = 'active' AND ${NOT_SHADOWED}
         AND (k.search_text % $1 OR k.search_text ILIKE '%' || $1 || '%')
       ORDER BY lower(k.food_name), lower(COALESCE(k.maker, k.importer, '')), k.food_cd
     ) sub ORDER BY score DESC, food_name LIMIT $2`,
    [qn, limit]);
  return r.rows.map(({ score, ...x }) => ({ ...x, calories: num(x.calories) }));
}

/** 상세 1건 — productModel.findByBarcode 와 같은 별칭으로 낸다 → assembleProductPayload 공유. */
async function findKfindProduct(foodCd, q) {
  const r = await run(q)(
    `SELECT k.food_cd AS product_id, NULL::text AS barcode, k.food_name AS product_name, NULL::text AS brand,
            COALESCE(k.maker, k.importer) AS manufacturer, k.food_type, k.category_l AS food_category,
            NULL::numeric AS serving_size, NULL::numeric AS total_content, NULL::text AS content_unit,
            'kfind' AS data_source, NULL::text AS image_url,
            k.status, k.nutrition_ok, k.release_id, k.report_no, k.maker, k.importer, k.is_imported, k.origin_country,
            k.basis, k.food_weight, k.serving_ref, k.rep_food,
            k.calories, k.total_fat, k.saturated_fat, k.trans_fat, k.cholesterol, k.sodium,
            k.total_carbs, k.total_sugars, k.dietary_fiber, k.protein,
            'kfind' AS nutrition_source, CASE k.basis WHEN 'per_100ml' THEN '100ml' ELSE '100g' END AS nutrition_serving_size,
            NULL::timestamptz AS verified_at
       FROM kfind.products k
      WHERE k.food_cd = $1 AND k.status = 'active' AND ${NOT_SHADOWED}
      LIMIT 1`, [foodCd]);
  const row = r.rows[0];
  if (!row) return null;
  const out = { ...row };
  for (const k of NUM_NUT) out[k] = num(row[k]);
  return out;
}

/** R8 — 같은 품목보고번호의 active kfind 후보(web_label 품목 보충·교차확인용). 숨김 규칙은 적용하지 않는다(대상이 web_label 자신이므로). */
async function findByReportNo(reportNo, q) {
  if (!reportNo) return [];
  const r = await run(q)(
    `SELECT food_cd, food_name, basis, release_id, ${NUM_NUT.join(', ')} FROM kfind.products
      WHERE report_no = $1 AND status = 'active' ORDER BY food_cd LIMIT 5`, [reportNo]);
  return r.rows.map((x) => { const o = { ...x }; for (const k of NUM_NUT) o[k] = num(x[k]); return o; });
}

/**
 * ★ 세션80 바코드 잇기(036) — 스캔 바코드 → 연결된 kfind 품목 food_cd(auto·approved · 노출 중 · 정확히 1개). 아니면 null.
 *   정답 IP/eval_kfind_barcode_v1 R1·KB01~06.
 */
async function findKfindIdByBarcode(barcode, q) {
  const r = await run(q)(
    `SELECT DISTINCT b.food_cd FROM kfind.product_barcodes b JOIN kfind.products k ON k.food_cd = b.food_cd
      WHERE b.barcode = $1 AND b.status IN ('auto','approved') AND k.status = 'active' AND ${NOT_SHADOWED}`, [barcode]);
  return r.rows.length === 1 ? r.rows[0].food_cd : null;
}

/** ★ 세션81 사용자 바코드 연결 — 판정 대상 품목(노출 여부 · 같은 품목보고번호의 노출 품목 수 포함). 없으면 null. */
async function findLinkTarget(foodCd, q) {
  const r = await run(q)(
    `SELECT k.food_cd, k.food_name, k.maker, k.importer, k.report_no,
            (k.status = 'active' AND ${NOT_SHADOWED}) AS exposed,
            (SELECT count(*)::int FROM kfind.products k2 WHERE k2.report_no = k.report_no AND k2.status = 'active') AS report_kfind_count
       FROM kfind.products k WHERE k.food_cd = $1`, [foodCd]);
  const x = r.rows[0]; if (!x) return null;
  return { food_cd: x.food_cd, name: x.food_name, maker: x.maker, importer: x.importer, report_no: x.report_no, exposed: !!x.exposed, report_kfind_count: Number(x.report_kfind_count) || 1 };
}

module.exports = { searchKfind, findKfindProduct, findByReportNo, findKfindIdByBarcode, findLinkTarget };
