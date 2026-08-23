/**
 * analysisCache.js — OCR 분석 결과 «임시 보관소» (세션64 신설)
 * ============================================================================
 * 왜 이 파일이 있는가
 *   실물 라벨 67건 실측: OCR 이 뽑은 값 중 **제품명으로 쓸 수 있는 것은 33건(49.3%)** 뿐이다.
 *   목표선은 95%(`IP/label_ocr_pipeline_v1.md:104`). 반이 비는데도 저장은 됐다 —
 *   `crowdsourceService.js` 가 **첫 원재료명을 제품명으로** 쓰고 있었기 때문이다.
 *   실측 21건이 그 폴백을 탔고, `products.product_name` 에 들어갈 값은
 *   `"정제수"`(6건) · `"주정"` · `"옥수수"` · `"륨"` · `"(고형분 95% 이상, 베트남산) 0.5264%"` 였다.
 *
 *   제이 결정(2026-08-21):
 *     ① 제품명은 **사용자 텍스트 입력**으로 받는다. OCR 값은 «자동채움» 용도.
 *     ② 제품명이 없으면 **저장을 거부**한다.
 *
 *   ①을 하려면 「분석」과 「저장」이 **두 번의 왕복**으로 갈라진다.
 *   그 사이에 분석 결과를 어딘가 둬야 하는데, 사진을 다시 보내면
 *   **Vision 을 두 번 호출**하게 된다 = OCR 비용 2배(비용 축 `U60-1`).
 *   → 서버가 «자기 분석 결과»를 토큰과 함께 들고 있다가, 확정 요청 때 그것을 쓴다.
 *
 * 무엇을 담는가 — **서버가 만든 값만**이다.
 *   `analysis`(merged 전체) · `barcode` · `ocrResult` · `avgConfidence`.
 *   클라이언트가 정본인 것은 확정 요청의 `product_info`(사용자 입력 메타)뿐이며,
 *   원재료·알레르기·영양·첨가물은 **여기 담긴 서버 값을 쓴다.**
 *   (클라이언트가 보낸 분석값으로 덮어쓰면 라벨을 읽은 근거가 사라진다 —
 *    세션44 치명B·세션48 과소경고가 전부 「클라이언트 값이 서버 값을 덮는」 유형이었다.)
 *
 * ⚠ 프로세스 메모리다. 다중 인스턴스·재배포에서는 토큰이 살아남지 않는다.
 *   그 경우 확정 요청은 **410** 이 되고 앱이 재촬영을 안내한다 —
 *   조용히 빈 분석으로 저장되는 것보다 낫다(`null = 판정 없음 ≠ 안전` 도크트린).
 *   Railway 는 현재 단일 인스턴스다. 스케일아웃하면 Redis 로 옮겨야 한다.
 */
'use strict';

const crypto = require('crypto');
const logger = require('../config/logger');

/** 토큰 수명. 사용자가 제품명을 타이핑하는 시간이다 — 10분이면 충분하고, 넘치지 않는다. */
const TTL_MS = 10 * 60 * 1000;

/**
 * 상한. 없으면 이 Map 이 **메모리 누수**다.
 * 넘치면 가장 오래된 것부터 버린다(Map 은 삽입 순서를 보존한다).
 * ⚠ 상한에 걸려 버려진 토큰은 확정 요청에서 410 이 된다 — 만료와 같은 화면이다.
 */
const MAX_ENTRIES = 500;

/** 청소 주기. TTL 의 1/5 — 만료분이 최대 2분 더 머문다(메모리만 차지하고 조회는 안 된다). */
const SWEEP_INTERVAL_MS = 2 * 60 * 1000;

/** token → { analysis, barcode, ocrResult, avgConfidence, createdAt, expiresAt } */
const store = new Map();

/**
 * 만료분 제거. **조회할 때마다도 돈다**(lazy) — 타이머에만 의존하면
 * 테스트가 타이머를 기다려야 하고, 그런 테스트는 느리거나 거짓 초록이 된다.
 * @param {number} now
 * @returns {number} 지운 개수
 */
function sweep(now = Date.now()) {
  let removed = 0;
  for (const [token, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(token);
      removed += 1;
    }
  }
  return removed;
}

// 주기적 청소. `unref()` 가 **필수**다 — 없으면 이 타이머가 이벤트 루프를 붙잡아
// `node tests/....js` 가 끝나도 프로세스가 안 죽고 CI 가 타임아웃으로 빨간불이 된다.
const sweepTimer = setInterval(() => {
  const n = sweep();
  if (n > 0) logger.debug('analysisCache 만료분 정리', { removed: n, remaining: store.size });
}, SWEEP_INTERVAL_MS);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

/**
 * 분석 결과를 담고 토큰을 발급한다.
 *
 * @param {Object} payload
 * @param {Object} payload.analysis      merged 분석 결과 전체(서버가 만든 값)
 * @param {string|null} [payload.barcode]
 * @param {Object} [payload.ocrResult]   { corrected_text, corrections }
 * @param {number} [payload.avgConfidence]
 * @param {number} [now]
 * @returns {string} 토큰 (48 hex chars)
 */
function putAnalysis(payload, now = Date.now()) {
  sweep(now);

  // ★ 추측 불가해야 한다. `Math.random()` 은 예측 가능하다 — 남의 분석 결과를
  //   제 이름으로 저장할 수 있게 되므로 CSPRNG 를 쓴다.
  const token = crypto.randomBytes(24).toString('hex');

  // 상한 초과분은 가장 오래된 것부터 버린다(FIFO). sweep 뒤에도 넘치는 경우다.
  while (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }

  store.set(token, {
    analysis: payload.analysis,
    barcode: payload.barcode ?? null,
    ocrResult: payload.ocrResult || null,
    avgConfidence: typeof payload.avgConfidence === 'number' ? payload.avgConfidence : 0,
    createdAt: now,
    expiresAt: now + TTL_MS,
  });

  return token;
}

/**
 * 토큰으로 분석 결과를 꺼낸다. **소모하지 않는다.**
 *
 * ★ 왜 1회용이 아닌가 — 확정 요청은 제품명이 비면 400 으로 되돌아온다.
 *   소모형이면 그 400 다음의 재시도가 410 이 되어, 앱이 사용자에게
 *   「사진을 다시 읽어 주세요」라고 말하게 된다. 그러면 **Vision 을 또 부른다** —
 *   이 경로가 존재하는 이유(비용 2배 방지)가 정확히 무너진다.
 *   중복 저장은 `crowdsourceService` 의 24시간 기기 중복 게이트가 막는다.
 *
 * @param {string} token
 * @param {number} [now] 테스트가 시계를 앞당길 수 있게 열어 둔다(타이머 대기 금지).
 * @returns {Object|null} 없거나 만료면 null
 */
function getAnalysis(token, now = Date.now()) {
  if (!token || typeof token !== 'string') return null;
  const entry = store.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    store.delete(token);
    return null;
  }
  return entry;
}

/** 명시적 폐기(성공 저장 후 앱이 더 못 쓰게 하고 싶을 때 쓸 수 있다. 현재 라우터는 안 부른다). */
function dropAnalysis(token) {
  return store.delete(token);
}

/** 테스트·진단용. 운영 코드는 쓰지 않는다. */
function _size() {
  return store.size;
}

/** 테스트용 초기화. 테스트 파일 사이에 상태가 새지 않게 한다. */
function _clear() {
  store.clear();
}

module.exports = {
  putAnalysis,
  getAnalysis,
  dropAnalysis,
  sweep,
  TTL_MS,
  MAX_ENTRIES,
  _size,
  _clear,
};
