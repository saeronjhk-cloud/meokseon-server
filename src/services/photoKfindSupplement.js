/**
 * photoKfindSupplement.js — ★ 세션82 결정 ⑧ 사진 제보 제품(영양 없음) ← K-FIND 보충 카드 (엔진 규칙 · AI 아님)
 *   정답: IP/eval_photo_kfind_supplement_v1/cases_v1.json (= tests/fixtures/photo_kfind_supplement_v1.json · PK01~18 · S1~S6)
 *   ⚠ 번호는 서버가 가진 OCR 원문에서만(81-3). products.c005_report_no 에는 절대 쓰지 않는다 — 검색 가림 키(kfind/webLabel NOT_SHADOWED).
 */
'use strict';
const { nameMatch } = require('./barcodeLinkGate');
const { extractProductMeta } = require('./ocrParser');

/** 번호 정규화(S3) — 숫자만 · 10~16자리. 아니면 null. */
function normalizeReportNo(s) {
  const d = String(s == null ? '' : s).replace(/\D/g, '');
  return d.length >= 10 && d.length <= 16 ? d : null;
}

/** 서버 OCR 원문 → 품목보고번호(정규화 · 없으면 null). 저장(contributions.data.ocr_report_no)·백필이 같이 쓴다. */
function ocrReportNoFromText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let meta = {};
  try { meta = extractProductMeta(text) || {}; } catch (_) { return null; }
  return normalizeReportNo(meta.report_no);
}

/** 순수 판정(S1~S5). product = {data_source, product_name, has_nutrition, ocr_report_nos[]} · kfindRows = 같은 번호 K-FIND 후보. */
function decidePhotoKfind(product, kfindRows) {
  if (!product || product.data_source !== 'ocr_crowdsource') return { ok: false, reason: 'not_crowd' };
  if (product.has_nutrition) return { ok: false, reason: 'has_nutrition' };
  const raw = Array.isArray(product.ocr_report_nos) ? product.ocr_report_nos : [];
  if (!raw.length) return { ok: false, reason: 'no_rn' };
  const norm = raw.map(normalizeReportNo);
  if (norm.some((x) => !x)) return { ok: false, reason: 'bad_rn' };
  const uniq = [...new Set(norm)];
  if (uniq.length !== 1) return { ok: false, reason: 'rn_conflict' };
  const rows = Array.isArray(kfindRows) ? kfindRows : [];
  if (rows.length === 0) return { ok: false, reason: 'no_kfind' };
  if (rows.length > 1) return { ok: false, reason: 'multi_kfind' };
  if (rows[0].calories == null) return { ok: false, reason: 'no_kfind_nutrition' };
  if (!nameMatch(product.product_name, rows[0].food_name)) return { ok: false, reason: 'name' };
  return { ok: true, reason: 'ok', report_no: uniq[0], row: rows[0] };
}

module.exports = { decidePhotoKfind, normalizeReportNo, ocrReportNoFromText };
