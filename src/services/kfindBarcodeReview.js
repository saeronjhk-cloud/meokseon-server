/**
 * kfindBarcodeReview.js — ★ 세션81c 관리자 «바코드 연결 확인» 큐(kfind.product_barcodes needs_review).
 *   정답 IP/eval_kfind_barcode_review_v1/cases_v1.json (A1~A8 · KA01~09).
 *   대상: 세션80 HACCP 배치(kfbc_*) + 세션81 사용자 연결(batch 'ublink'). public·web_label 표 무접촉(읽기만).
 */
'use strict';
const db = require('../config/database');

const STATUSES = ['needs_review', 'approved', 'rejected'];
const ACTIONS = ['approve', 'reject', 'reopen'];
class ReviewError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

/** A1 */
async function listQueue({ status = 'needs_review', reason = null, limit = 50, offset = 0 } = {}, conn = db) {
  if (!STATUSES.includes(status)) status = 'needs_review';
  limit = Math.min(Math.max(Number(limit) || 50, 1), 200); offset = Math.max(Number(offset) || 0, 0);
  const params = [status]; let where = 'b.status = $1';
  if (reason) { params.push(String(reason)); where += ` AND b.reason = $${params.length}`; }
  const total = Number((await conn.query(`SELECT count(*)::int n FROM kfind.product_barcodes b WHERE ${where}`, params)).rows[0].n);
  const byReason = {};
  for (const r of (await conn.query(`SELECT coalesce(reason,'') reason, count(*)::int n FROM kfind.product_barcodes WHERE status = $1 GROUP BY 1`, [status])).rows) byReason[r.reason] = Number(r.n);
  const rows = (await conn.query(
    `SELECT b.barcode, b.food_cd, b.status, b.reason, b.batch_id, b.evidence, b.decided_by, b.decided_at,
            k.food_name, k.maker, k.importer, k.report_no, k.calories, k.basis
       FROM kfind.product_barcodes b JOIN kfind.products k ON k.food_cd = b.food_cd
      WHERE ${where} ORDER BY b.reason NULLS LAST, b.barcode, b.food_cd
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset])).rows;
  const bcs = [...new Set(rows.map((r) => r.barcode))];
  const pub = new Map(); const sib = new Map(); const users = new Map();
  if (bcs.length) {
    for (const p of (await conn.query(`SELECT DISTINCT ON (barcode) barcode, product_id, product_name FROM public.products WHERE barcode = ANY($1) ORDER BY barcode, is_active DESC, product_id`, [bcs])).rows) pub.set(p.barcode, { product_id: Number(p.product_id), product_name: p.product_name });
    for (const s of (await conn.query(`SELECT b.barcode, b.food_cd, b.status, k.food_name FROM kfind.product_barcodes b JOIN kfind.products k ON k.food_cd = b.food_cd WHERE b.barcode = ANY($1)`, [bcs])).rows) (sib.get(s.barcode) || sib.set(s.barcode, []).get(s.barcode)).push(s);
    for (const u of (await conn.query(`SELECT barcode, food_cd, count(DISTINCT user_id)::int n FROM kfind.barcode_claims WHERE barcode = ANY($1) AND user_id IS NOT NULL GROUP BY 1, 2`, [bcs])).rows) users.set(`${u.barcode}|${u.food_cd}`, Number(u.n));
  }
  const items = rows.map((r) => ({
    barcode: r.barcode, food_cd: r.food_cd, status: r.status, reason: r.reason, batch_id: r.batch_id,
    source: r.batch_id === 'ublink' ? 'user' : 'haccp',
    kfind: { name: r.food_name, maker: r.maker, importer: r.importer, report_no: r.report_no, calories: r.calories == null ? null : Number(r.calories), basis: r.basis },
    evidence: r.evidence || null,
    public_product: pub.get(r.barcode) || null,
    siblings: (sib.get(r.barcode) || []).filter((s) => s.food_cd !== r.food_cd).map((s) => ({ food_cd: s.food_cd, name: s.food_name, status: s.status })),
    users: users.get(`${r.barcode}|${r.food_cd}`) || 0,
    decided_by: r.decided_by, decided_at: r.decided_at,
  }));
  return { total, by_reason: byReason, limit, offset, items };
}

/** A2~A8 */
async function decide({ barcode, foodCd, action, actor }, conn = db) {
  if (!ACTIONS.includes(action)) throw new ReviewError(400, 'ACTION_INVALID', 'action 은 approve|reject|reopen 입니다.');
  if (typeof barcode !== 'string' || !/^\d{8,14}$/.test(barcode) || typeof foodCd !== 'string' || !foodCd) throw new ReviewError(400, 'KEY_INVALID', 'barcode·food_cd 형식이 올바르지 않습니다.');
  const who = actor || 'admin-token';
  const cur = (await conn.query(`SELECT status, reason, decided_by FROM kfind.product_barcodes WHERE barcode = $1 AND food_cd = $2`, [barcode, foodCd])).rows[0];
  if (!cur) throw new ReviewError(404, 'NOT_FOUND', '연결 항목을 찾을 수 없습니다.');
  const target = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'needs_review';
  if (cur.status === target && (action !== 'reopen' || !cur.decided_by)) return { barcode, food_cd: foodCd, status: cur.status, changed: false, siblings_changed: 0 };

  if (action === 'approve') {
    if ((await conn.query(`SELECT 1 FROM public.products WHERE barcode = $1 LIMIT 1`, [barcode])).rows.length) throw new ReviewError(409, 'PUBLIC_EXISTS', '공공 제품에 이미 있는 바코드라 승인할 수 없습니다.');
    if ((await conn.query(`SELECT 1 FROM web_label.product_barcodes WHERE barcode = $1 AND status IN ('auto','approved') LIMIT 1`, [barcode])).rows.length) throw new ReviewError(409, 'LINKED_ELSEWHERE', '판매처 품목에 이미 연결된 바코드라 승인할 수 없습니다.');
  }
  let sibs = 0;
  if (action === 'reopen') {
    await conn.query(`UPDATE kfind.product_barcodes SET status = 'needs_review', decided_by = NULL, decided_at = NULL, updated_at = now() WHERE barcode = $1 AND food_cd = $2`, [barcode, foodCd]);
    if (cur.status === 'approved') {
      sibs = (await conn.query(`UPDATE kfind.product_barcodes SET status = 'needs_review', decided_by = NULL, decided_at = NULL, updated_at = now()
         WHERE barcode = $1 AND food_cd <> $2 AND status = 'rejected' AND reason = 'sibling_approved' AND decided_by = $3 RETURNING food_cd`, [barcode, foodCd, cur.decided_by])).rows.length;   // RETURNING 행 수 — pg rowCount 와 PGlite affectedRows 차이를 피한다
    }
  } else {
    await conn.query(`UPDATE kfind.product_barcodes SET status = $3, decided_by = $4, decided_at = now(), updated_at = now() WHERE barcode = $1 AND food_cd = $2`, [barcode, foodCd, target, who]);
    if (action === 'approve') {
      sibs = (await conn.query(`UPDATE kfind.product_barcodes SET status = 'rejected', reason = 'sibling_approved', decided_by = $3, decided_at = now(), updated_at = now()
         WHERE barcode = $1 AND food_cd <> $2 AND decided_by IS NULL RETURNING food_cd`, [barcode, foodCd, who])).rows.length;
    }
  }
  return { barcode, food_cd: foodCd, status: target, changed: true, siblings_changed: sibs };
}

module.exports = { listQueue, decide, ReviewError };
