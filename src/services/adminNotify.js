/**
 * ★★ 세션72d — 관리자 «제보 알림» 메일 (제이 결정 2026-09-30)
 *
 * 결정: 발송 = Resend(HTTPS API · 네이티브 모듈 없음) · 빈도 = «즉시 + 10분 묶음» · 수신 = ADMIN_NOTIFY_EMAILS.
 *   · 창(window) 안 첫 제보 → 즉시 1통. 이어서 10분 안에 들어온 제보는 모아 두었다가 창이 끝날 때 1통.
 *   · 환경변수(Railway · 제이가 직접 입력 — 키를 코드·문서에 적지 않는다):
 *       RESEND_API_KEY         필수. 없으면 발송하지 않고 로그만 남긴다(제보 흐름은 절대 막지 않는다).
 *       ADMIN_NOTIFY_EMAILS    수신 주소(쉼표 구분). 없으면 ADMIN_EMAILS 를 쓴다.
 *       RESEND_FROM            발신 주소. 기본 '먹선 알림 <noreply@send.nutriformula.co.kr>' — 제이가 이미 Resend 에
 *                              인증해 둔 발송 도메인(Supabase 로그인 OTP 커스텀 SMTP 와 같은 도메인 · IP/auth_email/*).
 *       ADMIN_PAGE_URL         메일 속 「관리자 화면」 링크(예: https://…/admin). 없으면 링크 생략.
 *       ADMIN_NOTIFY_WINDOW_MS 묶음 창(기본 600000 = 10분).
 * ⚠ 메일에 개인정보를 싣지 않는다: 제품명·바코드·축·자동반영 여부만. device_id·user_id·OCR 원문 없음.
 * ⚠ 서버 재시작 시 모아 둔 항목은 사라진다 — 관리자 화면의 큐가 정본이다(메일은 알림일 뿐).
 */
const logger = require('../config/logger');

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
// ★ 세션72d — 제이가 이미 쓰는 Resend 인증 도메인(send.nutriformula.co.kr). 인증 도메인이라 어떤 수신 주소로도 배달된다.
const DEFAULT_FROM = '먹선 알림 <noreply@send.nutriformula.co.kr>';
const MAX_ITEMS_IN_MAIL = 30;

function recipients(env = process.env) {
  const raw = env.ADMIN_NOTIFY_EMAILS || env.ADMIN_EMAILS || '';
  return raw.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => /.+@.+\..+/.test(s));
}

const AXIS_KO = { nutrition: '영양', ingredients: '원재료', allergens: '알레르기', additives: '첨가물' };

// ★ 세션72e — 게이트 사유 코드를 관리자가 읽을 말로(메일에 RESIDUE 같은 코드가 그대로 보였다).
const REASON_KO = {
  NO_TEXT: '보류 · 사진 글자 없음',
  NO_DECLARATION: '보류 · 표시문 못 찾음',
  NO_NAMES: '보류 · 알레르기명 없음',
  RESIDUE: '보류 · 판독 불명 글자',
  INFERRED_PRESENT: '보류 · 추정값 섞임',
  STORED_MISMATCH: '보류 · 저장값 불일치',
};
function reasonKo(code) {
  if (!code) return '-';
  const base = String(code).split(':')[0];
  return REASON_KO[base] || `보류 · ${code}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 순수 함수 — 메일 제목·본문. 테스트가 직접 부른다. */
function buildMail(items, env = process.env) {
  const n = items.length;
  const autoN = items.filter((i) => i.allergenAutoApplied).length;
  const subject = n === 1
    ? `[먹선] 새 제보 — ${items[0].productName || '(이름 없음)'}${items[0].allergenAutoApplied ? ' · 알레르기 자동반영' : ''}`
    : `[먹선] 새 제보 ${n}건${autoN ? ` (알레르기 자동반영 ${autoN})` : ''}`;
  const rows = items.slice(0, MAX_ITEMS_IN_MAIL).map((i) => {
    const pending = (i.pendingAxes || []).map((a) => AXIS_KO[a] || a).join('·') || '없음';
    return `<tr><td>${esc(i.productName || '(이름 없음)')}</td><td>${esc(i.barcode || '-')}</td>`
      + `<td>${esc(pending)}</td><td>${i.allergenAutoApplied ? '자동반영' : esc(reasonKo(i.allergenAutoReason))}</td>`
      + `<td>${i.isNewProduct ? '신규' : '기존'}</td></tr>`;
  }).join('');
  const more = n > MAX_ITEMS_IN_MAIL ? `<p>외 ${n - MAX_ITEMS_IN_MAIL}건</p>` : '';
  const link = env.ADMIN_PAGE_URL ? `<p><a href="${esc(env.ADMIN_PAGE_URL)}">관리자 화면에서 검토하기</a></p>` : '';
  const html = `<div style="font-family:sans-serif;font-size:14px">`
    + `<p>검토가 필요한 제보가 도착했습니다.</p>`
    + `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">`
    + `<tr><th>제품명</th><th>바코드</th><th>검토 대기 축</th><th>알레르기</th><th>구분</th></tr>${rows}</table>`
    + `${more}${link}`
    + (autoN ? `<p style="color:#888;font-size:12px">알레르기 «자동반영»은 관리자 미검증 상태입니다. 관리자 화면에서 되돌릴 수 있습니다.</p>` : '')
    + `</div>`;
  const text = items.map((i) => `- ${i.productName || '(이름 없음)'} (${i.barcode || '-'}) 대기: ${(i.pendingAxes || []).map((a) => AXIS_KO[a] || a).join('·') || '없음'}${i.allergenAutoApplied ? ' · 알레르기 자동반영' : ''}`).join('\n')
    + (env.ADMIN_PAGE_URL ? `\n\n관리자 화면: ${env.ADMIN_PAGE_URL}` : '');
  return { subject, html, text };
}

async function sendViaResend(mail, to, env = process.env, fetchImpl = globalThis.fetch) {
  const key = env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: 'NO_RESEND_API_KEY' };
  if (!to.length) return { sent: false, reason: 'NO_RECIPIENTS' };
  const r = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.RESEND_FROM || DEFAULT_FROM, to, subject: mail.subject, html: mail.html, text: mail.text }),
  });
  if (!r.ok) {
    let body = '';
    try { body = (await r.text()).slice(0, 300); } catch (_) { /* noop */ }
    return { sent: false, reason: `HTTP_${r.status}`, body };
  }
  return { sent: true };
}

/**
 * 묶음 발송기. 테스트는 now·setTimer·send 를 주입한다.
 */
function createNotifier(opts = {}) {
  const env = opts.env || process.env;
  const now = opts.now || (() => Date.now());
  const setTimer = opts.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
  const send = opts.send || ((mail, to) => sendViaResend(mail, to, env, opts.fetchImpl));
  const windowMs = Number(env.ADMIN_NOTIFY_WINDOW_MS) > 0 ? Number(env.ADMIN_NOTIFY_WINDOW_MS) : DEFAULT_WINDOW_MS;
  let lastSentAt = -Infinity;
  let pending = [];
  let timer = null;

  async function flush() {
    timer = null;
    if (!pending.length) return null;
    const items = pending; pending = [];
    return dispatch(items);
  }

  async function dispatch(items) {
    lastSentAt = now();
    const to = recipients(env);
    try {
      const res = await send(buildMail(items, env), to);
      if (!res.sent) logger.warn('관리자 제보 알림 미발송', { reason: res.reason, count: items.length, body: res.body });
      else logger.info('관리자 제보 알림 발송', { count: items.length, to: to.length });
      return res;
    } catch (e) {
      logger.warn('관리자 제보 알림 실패', { error: e.message, count: items.length });
      return { sent: false, reason: 'EXCEPTION' };
    }
  }

  /** 제보 1건 알림. ⚠ throw 하지 않는다 — 호출부(제보 저장)를 절대 막지 않는다. */
  async function notify(item) {
    try {
      if (now() - lastSentAt >= windowMs && !timer) return await dispatch([item]);
      pending.push(item);
      if (!timer) timer = setTimer(() => { flush(); }, Math.max(0, lastSentAt + windowMs - now()));
      return { queued: true };
    } catch (e) {
      logger.warn('관리자 제보 알림 예외', { error: e.message });
      return { sent: false, reason: 'EXCEPTION' };
    }
  }

  return { notify, flush, _state: () => ({ pending: pending.length, lastSentAt, timer: !!timer }) };
}

const defaultNotifier = createNotifier();

module.exports = {
  reasonKo,
  notifyNewContribution: (item) => defaultNotifier.notify(item),
  createNotifier, buildMail, recipients, sendViaResend,
};
