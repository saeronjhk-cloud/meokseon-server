'use strict';
/**
 * ★ 세션75f — 제보자에게 «관리자 확인 결과» 메일 (제이 결정 2026-10-04: «신청한 사람만(옵트인)»)
 *
 * 언제: `POST /api/admin/verify/:productId` 가 그 제품의 제보를 pending → approved/rejected 로 «바꾼 순간»
 *   (같은 UPDATE 의 RETURNING 으로 «이번에 바뀐 제보»만 받는다 → 같은 제보에 두 번 보내지 않는다. 별도 기록 테이블 없음).
 * 누구에게: 그 제보 중 `contributions.data.notify_result === true`(제보 화면 체크박스) 이고 계정 이메일이 있는 사람.
 *   같은 사람이 같은 제품에 여러 번 보냈으면 메일은 1통.
 * 무엇을: 제품명 · 결과(반영됨/반영 못 함) · 제품 화면 링크 · 「내가 보낸 제보」 링크.
 *   ⚠ 관리자 반려 사유(자유 입력)는 싣지 «않는다» — 내부 메모가 그대로 나갈 수 있다. 일반 문구만.
 *   ⚠ 바코드·제품명 외 개인정보 없음. user_id·device_id·OCR 원문 없음.
 * 실패해도 관리자 승인 응답을 막지 않는다(throw 금지 · 로그만). RESEND_API_KEY 가 없으면 보내지 않는다.
 * 환경변수: RESEND_API_KEY(기존) · RESEND_FROM(기존 · 기본 noreply@send.nutriformula.co.kr) · APP_BASE_URL(기본 https://www.nutriformula.co.kr)
 */
const db = require('../config/database');
const logger = require('../config/logger');
const { sendViaResend } = require('./adminNotify');

const DEFAULT_APP_URL = 'https://www.nutriformula.co.kr';
const USER_FROM = '서박사의 영양공식 <noreply@send.nutriformula.co.kr>';
let sender = (mail, to, env) => sendViaResend(mail, to, { ...env, RESEND_FROM: env.RESEND_FROM_USER || USER_FROM }, globalThis.fetch);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 순수 함수 — 테스트가 직접 부른다. decision: 'approved' | 'rejected' */
function buildContributorMail({ productName, barcode, decision }, env = process.env) {
  const base = (env.APP_BASE_URL || DEFAULT_APP_URL).replace(/\/+$/, '');
  const name = productName || '보내주신 제품';
  const productUrl = barcode && /^\d{8,14}$/.test(barcode) ? `${base}/scan?barcode=${encodeURIComponent(barcode)}` : null;
  const reportsUrl = `${base}/scan/reports`;
  const ok = decision === 'approved';
  const subject = ok ? `[서박사의 영양공식] 보내주신 제보가 반영됐어요 — ${name}` : `[서박사의 영양공식] 보내주신 제보를 반영하지 못했어요 — ${name}`;
  const lead = ok
    ? '관리자가 보내주신 라벨 사진을 확인했고, 확인된 정보를 제품 화면에 반영했어요. 고맙습니다.'
    : '관리자가 보내주신 라벨 사진을 확인했지만, 이번에는 제품 화면에 반영하지 못했어요. 사진이 흐리거나 다른 자료와 맞지 않는 경우가 많아요. 라벨을 다시 찍어 보내주시면 다시 확인할게요.';
  const foot = '이 메일은 제보하실 때 «확인 결과를 메일로 받기»를 선택하셔서 보내드렸어요. 이 제보에 대한 안내는 이번 한 번만 보내요.';
  const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.7">`
    + `<p><strong>${esc(name)}</strong></p><p>${esc(lead)}</p>`
    + (productUrl && ok ? `<p><a href="${esc(productUrl)}">제품 화면에서 보기</a></p>` : '')
    + `<p><a href="${esc(reportsUrl)}">내가 보낸 제보 보기</a></p>`
    + `<p style="color:#888;font-size:12px">${esc(foot)}</p></div>`;
  const text = `${name}\n\n${lead}\n\n${productUrl && ok ? `제품 화면: ${productUrl}\n` : ''}내가 보낸 제보: ${reportsUrl}\n\n${foot}`;
  return { subject, html, text };
}

/**
 * 이번에 결정된 제보들에 대해 신청자에게 메일을 보낸다. ⚠ throw 하지 않는다.
 * @param {{ contributionIds: number[], decision: 'approved'|'rejected' }} p
 * @returns {Promise<{ candidates: number, sent: number, skipped: number }>}
 */
async function notifyDecision({ contributionIds, decision }, env = process.env) {
  const out = { candidates: 0, sent: 0, skipped: 0 };
  try {
    const ids = (contributionIds || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
    if (!ids.length || !['approved', 'rejected'].includes(decision)) return out;
    const r = await db.query(
      `SELECT DISTINCT ON (lower(u.email), c.product_id)
              lower(u.email) AS email, p.product_name, p.barcode
         FROM contributions c
         JOIN users u ON u.user_id = c.user_id
         LEFT JOIN products p ON p.product_id = c.product_id
        WHERE c.contribution_id = ANY($1::bigint[])
          AND (c.data->>'notify_result') = 'true'
          AND u.email IS NOT NULL AND u.email <> ''
        ORDER BY lower(u.email), c.product_id, c.contribution_id`,
      [ids]);
    out.candidates = r.rows.length;
    for (const row of r.rows) {
      const mail = buildContributorMail({ productName: row.product_name, barcode: row.barcode, decision }, env);
      try {
        const res = await sender(mail, [row.email], env);
        if (res && res.sent) out.sent += 1; else { out.skipped += 1; logger.warn('제보자 결과 메일 미발송', { reason: res && res.reason }); }
      } catch (e) { out.skipped += 1; logger.warn('제보자 결과 메일 실패', { error: e.message }); }
    }
    if (out.candidates) logger.info('제보자 결과 메일', { decision, ...out });
  } catch (e) {
    logger.warn('제보자 결과 메일 조회 실패', { error: e.message });
  }
  return out;
}

module.exports = { buildContributorMail, notifyDecision, _setSender: (fn) => { sender = fn; } };
