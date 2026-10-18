/**
 * userBarcodeLinkService.js — ★ 세션81 «사용자 바코드 연결»(결정 80-9 · 81-1~81-4). 정답 IP/eval_user_barcode_v1 (UR01~06).
 *   제보 저장(kfind.barcode_claims · 037) → 엔진 판정(userBarcodeGate.judgeLink) → auto/needs_review 는 kfind.product_barcodes(batch 'ublink').
 *   ⚠ 쓰기 범위: kfind.barcode_claims · kfind.product_barcodes 의 «우리 행»(batch_id 'ublink' 또는 새 행 · decided_by 없음)만.
 *     HACCP 배치(kfbc_*)·사람 판정 행은 덮지 않는다. public·web_label 표 무접촉.
 *   ⚠ 이 경로는 source='user' 만 받는다 — 클라이언트가 보낸 «사진에서 읽은 번호»는 위조가 쉽다(K-FIND 응답에 번호가 나간다).
 *     사진 근거(photo)는 서버가 직접 OCR 한 경우에만 이 서비스의 submitClaim 을 내부에서 부른다(다음 단계).
 */
'use strict';
const db = require('../config/database');
const kfindModel = require('../models/kfindModel');
const { judgeLink, normalizeBarcode } = require('./userBarcodeGate');

const DAILY_LIMIT = 30;   // UR06 — 한 사용자 24시간 제보 상한
const BATCH = 'ublink';
let PREFIX = null;
function prefixTable() {
  if (PREFIX) return PREFIX;
  try { PREFIX = require('../data/barcode_prefix.json'); } catch (_) { PREFIX = { L9: {}, L8: {} }; }
  return PREFIX;
}

class LinkError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

/**
 * @returns {{ verdict, reason, personal, prefix, barcode, food_cd }}
 */
async function submitClaim({ userId, barcode, foodCd, source = 'user', evidence = null }, conn = db) {
  const bc = normalizeBarcode(barcode);
  if (!bc) throw new LinkError(400, 'BARCODE_INVALID', '바코드 숫자가 올바르지 않아요.');
  const target = await kfindModel.findLinkTarget(foodCd, conn);
  if (!target) throw new LinkError(404, 'KFIND_NOT_FOUND', '제품을 찾을 수 없어요.');
  if (userId != null) {
    const c = await conn.query(`SELECT count(*)::int AS n FROM kfind.barcode_claims WHERE user_id = $1 AND created_at > now() - interval '24 hours'`, [userId]);
    if (Number(c.rows[0].n) >= DAILY_LIMIT) throw new LinkError(429, 'CLAIM_LIMIT', '오늘은 더 연결할 수 없어요. 내일 다시 시도해 주세요.');
  }
  const ins = await conn.query(
    `INSERT INTO kfind.barcode_claims (barcode, food_cd, user_id, source, evidence) VALUES ($1,$2,$3,$4,$5) RETURNING claim_id`,
    [bc, foodCd, userId, source, evidence ? JSON.stringify(evidence) : null]);
  const claimId = ins.rows[0].claim_id;

  const claims = (await conn.query(
    `SELECT user_id, food_cd, source, evidence, date_part('epoch', created_at) * 1000 + claim_id::numeric / 1e6 AS at
       FROM kfind.barcode_claims WHERE barcode = $1`, [bc])).rows
    .map((r) => ({ user: r.user_id == null ? null : Number(r.user_id), food_cd: r.food_cd, source: r.source, evidence: r.evidence, at: Number(r.at) }));
  const publicHit = (await conn.query(`SELECT 1 FROM public.products WHERE barcode = $1 LIMIT 1`, [bc])).rows.length > 0;
  const wlLinked = (await conn.query(`SELECT 1 FROM web_label.product_barcodes WHERE barcode = $1 AND status IN ('auto','approved') LIMIT 1`, [bc])).rows.length > 0;
  const rows = (await conn.query(`SELECT food_cd, status, decided_by, batch_id FROM kfind.product_barcodes WHERE barcode = $1`, [bc])).rows;
  const table = prefixTable();

  // ★ 같은 바코드에 제보된 «모든» 품목을 다시 판정한다 — 한 사람이 마음을 바꾸면 다른 품목의 근거가 줄어든다.
  //   target 을 먼저, 나머지는 그 뒤에(나머지의 linked_other 는 «남의 행(HACCP·사람 승인)»만 본다 · 우리 'ublink' 행끼리는 conflict_user 가 가른다).
  const fcs = [foodCd, ...new Set(claims.map((c) => c.food_cd).filter((f) => f !== foodCd))];
  let mineResult = null;
  for (const fc of fcs) {
    const t = fc === foodCd ? target : await kfindModel.findLinkTarget(fc, conn);
    if (!t) continue;
    const cur = rows.find((x) => x.food_cd === fc) || null;
    const foreign = rows.some((x) => x.food_cd !== fc && (x.status === 'auto' || x.status === 'approved') && (x.batch_id !== BATCH || x.decided_by));
    const r = judgeLink({ barcode: bc, target: t, claims, prefixTable: table, public_hit: publicHit, linked_other: wlLinked || foreign, decided: cur && cur.decided_by ? cur : null });
    if (fc === foodCd) mineResult = r;
    const ours = !cur || (cur.batch_id === BATCH && !cur.decided_by);
    if (!ours) continue;
    if (r.status === 'auto' || r.status === 'needs_review') {
      const n = new Set(claims.filter((c) => c.food_cd === fc && c.user != null).map((c) => c.user)).size;
      await conn.query(
        `INSERT INTO kfind.product_barcodes (barcode, food_cd, status, reason, evidence, batch_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (barcode, food_cd) DO UPDATE SET status = excluded.status, reason = excluded.reason, evidence = excluded.evidence, updated_at = now()
           WHERE kfind.product_barcodes.decided_by IS NULL AND kfind.product_barcodes.batch_id = '${BATCH}'`,
        [bc, fc, r.status, r.reason, JSON.stringify({ src: 'user_claims', users: n, prefix: r.prefix, kfind_name: t.name, kfind_maker: t.maker || t.importer }), BATCH]);
    } else if (cur && cur.status !== 'unlinked') {
      // 예전에 우리가 auto/needs_review 로 썼는데 지금은 근거가 줄었다 → 전역 연결을 내린다(행은 기록으로 남긴다).
      await conn.query(`UPDATE kfind.product_barcodes SET status = 'unlinked', reason = $3, updated_at = now() WHERE barcode = $1 AND food_cd = $2 AND decided_by IS NULL AND batch_id = '${BATCH}'`, [bc, fc, r.reason]);
    }
  }
  const r = mineResult;
  await conn.query(`UPDATE kfind.barcode_claims SET verdict = $2, reason = $3, personal = $4, prefix = $5 WHERE claim_id = $1`, [claimId, r.status, r.reason, r.personal, r.prefix]);
  return { verdict: r.status, reason: r.reason, personal: r.personal, prefix: r.prefix, barcode: bc, food_cd: foodCd };
}

/** UR02 — 본인의 최신 제보가 personal 이고 대상이 아직 노출 중이면 그 food_cd. */
async function findMyLink(userId, barcode, conn = db) {
  const bc = normalizeBarcode(barcode); if (!bc || userId == null) return null;
  const r = await conn.query(
    `SELECT c.food_cd, c.verdict, c.reason, c.personal FROM kfind.barcode_claims c
      WHERE c.user_id = $1 AND c.barcode = $2 ORDER BY c.created_at DESC, c.claim_id DESC LIMIT 1`, [userId, bc]);
  const x = r.rows[0]; if (!x || !x.personal) return null;
  const t = await kfindModel.findLinkTarget(x.food_cd, conn); if (!t || !t.exposed) return null;
  return { food_cd: x.food_cd, verdict: x.verdict, reason: x.reason, barcode: bc };
}

module.exports = { submitClaim, findMyLink, LinkError, DAILY_LIMIT, _resetPrefix: (t) => { PREFIX = t || null; } };
