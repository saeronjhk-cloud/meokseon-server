// src/config/supabaseJwks.js
// ============================================================================
// Supabase JWT 공개키(JWKS) 가져오기 + 캐시 — 세션64c 후속(설계 오류 교정)
//
// 왜 이 파일이 생겼나
//   세션64c 는 `supabaseAuth.js` 를 **HS256(대칭키)** 검증으로 만들었다. 그 근거로
//   「JWT 헤더 = {"alg":"HS256"} 실측」이라고 적었는데 **그 표본이 anon key 였다.**
//   anon key 는 legacy secret 으로 서명된 HS256 이 맞지만, **사용자 access token 은 다르다.**
//
// ★ 실측 (2026-08-25 · 제이 화면 + 공개 JWKS 엔드포인트)
//   ① Supabase 대시보드 → Settings → JWT Keys 배너:
//        「Legacy JWT secret has been migrated to new JWT Signing Keys」
//      legacy secret 은 이제 **only verify** — 서명에는 쓰이지 않는다.
//   ② 같은 화면 `JWT Signing Keys` 의 CURRENT KEY 타입 = **ECC (P-256)**.
//   ③ 공개 JWKS(`/auth/v1/.well-known/jwks.json`) 응답:
//        { "keys":[ { "alg":"ES256","crv":"P-256","kty":"EC","use":"sig",
//                     "key_ops":["verify"], "kid":"d7edc63b-…", "x":"…","y":"…" } ] }
//      `kid` 가 대시보드의 CURRENT KEY ID 와 일치하고, **키는 이것 하나뿐**이다.
//   ⇒ 새 access token 은 **ES256** 으로 서명된다. HS256 검증만 두면 배포 즉시 전부 401 이다.
//
// ★ 어떻게 확인했나 (다음 세션이 같은 함정에 빠지지 않도록)
//   - anon key 를 디코드해서 알고리즘을 정하지 마라. anon key 는 **프로젝트 API 키**이지
//     사용자 세션 토큰이 아니다. 둘은 다른 키로 서명된다.
//   - 정답은 **공개 JWKS 엔드포인트**에 있다. 비밀이 필요 없다:
//       curl https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json
//     `keys[].alg` 가 그 프로젝트가 지금 **실제로 서명에 쓰는** 알고리즘이다.
//   - 대시보드 Settings → JWT Keys 의 배너와 CURRENT KEY 타입이 두 번째 근거다.
//
// ────────────────────────────────────────────────────────────────────────────
// ★★ 왜 이 캐시를 «직접» 들고 있나 (jose 의 `createRemoteJWKSet` 을 쓰지 않은 이유)
//   `createRemoteJWKSet` 은 캐시가 TTL 을 넘기면 **무조건 재조회를 시도하고, 실패하면 던진다.**
//   즉 Supabase 가 10분 이상 응답하지 않으면 **먹선의 모든 인증이 죽는다** — 우리 잘못도
//   사용자 잘못도 아닌 이유로. 공개키는 「낡아도 여전히 그 사람의 서명을 검증할 수 있는」
//   값이라, 갱신 실패를 곧바로 인증 실패로 옮길 이유가 없다.
//   → 여기서는 **갱신에 실패해도 마지막으로 성공한 키셋(stale)으로 버틴다.**
//     캐시가 «아예 없을» 때만 포기한다(= `JwksUnavailableError` → 503).
//   서명 검증 자체(JWK → 키 객체 변환, kid/alg/use 매칭)는 그대로 jose 가 한다
//   (`createLocalJWKSet`). 직접 만든 것은 **가져오기와 캐시 수명뿐**이다.
//
// ⚠ fail-open 금지. 이 파일은 어떤 경우에도 「키를 못 구했으니 통과」를 하지 않는다.
//   못 구하면 던진다. 통과 여부는 호출부가 아니라 **서명 검증 결과**만 정한다.
// ============================================================================
'use strict';

const { createLocalJWKSet } = require('jose');
const logger = require('./logger');

/**
 * 정상 갱신 주기. 이 시간이 지나면 «다음 요청 때» 새로 가져온다.
 * ⚠ 짧게 잡을 이유가 없다 — 키 회전은 아래 `ERR_JWKS_NO_MATCHING_KEY` 경로가
 *   TTL 과 무관하게 즉시 잡는다. TTL 은 「폐기된 키를 언제까지 믿을 것인가」의 상한이다.
 */
const TTL_MS = 10 * 60 * 1000;      // 10분

/**
 * 재조회 최소 간격. 실패했거나 모르는 `kid` 를 봤을 때 매 요청마다 밖으로 나가지 않게 막는다.
 * ★ 이게 없으면 (1) Supabase 장애 시 우리가 장애를 증폭시키고,
 *   (2) 아무나 가짜 `kid` 를 붙인 토큰을 난사해 **우리 서버로 JWKS 를 두들기게** 만들 수 있다.
 */
const REFRESH_COOLDOWN_MS = 30 * 1000;   // 30초

/** 한 번의 조회에 허용하는 시간. 인증은 모든 요청의 앞에 있다 — 오래 붙잡고 있으면 안 된다. */
const FETCH_TIMEOUT_MS = 5000;

/**
 * 키를 구하지 못했다. **「검증 실패」가 아니다.**
 * 사용자는 다시 로그인해도 못 고친다 → 호출부는 401 이 아니라 503 을 내야 한다.
 */
class JwksUnavailableError extends Error {
  constructor(cause) {
    super('Supabase JWKS 를 가져오지 못했다 (캐시도 없음)');
    this.name = 'JwksUnavailableError';
    this.code = 'JWKS_UNAVAILABLE';
    this.cause = cause;
  }
}

/**
 * 단일 캐시. 프로세스 하나가 보는 Supabase 프로젝트는 하나다.
 * `url` 이 바뀌면(테스트·환경변수 변경) 통째로 버린다 — 남의 프로젝트 키로 검증하는 사고를 막는다.
 */
let cache = {
  url: null,
  /** 마지막으로 «성공적으로» 가져온 JWKS 원문 */
  raw: null,
  /** jose 가 만든 키 해석기 `(protectedHeader, token) => KeyLike` */
  resolve: null,
  fetchedAt: 0,
  lastFailureAt: 0,
  /** 「모르는 kid」때문에 마지막으로 재조회한 시각 — 키 회전 재조회의 쿨다운 기준 */
  lastRotationFetchAt: 0,
  lastError: null,
  /** 동시 요청이 같은 조회를 N번 하지 않게 묶는다 */
  inflight: null,
};

function resetCache(url) {
  cache = {
    url, raw: null, resolve: null,
    fetchedAt: 0, lastFailureAt: 0, lastRotationFetchAt: 0, lastError: null, inflight: null,
  };
}

/**
 * ⚠ **테스트 전용** 캐시 조작. 운영 코드에서 부르지 않는다.
 *   reset    캐시를 통째로 버린다(키·타임스탬프 전부)
 *   age      키는 남기고 «TTL 을 넘긴 것»으로 만든다 → 다음 요청이 갱신을 시도한다
 *   cooldown 재조회 쿨다운만 푼다 → 모르는 kid 재조회·실패 재시도가 즉시 일어난다
 *
 * ★ 왜 필요한가: TTL 10분·쿨다운 30초를 «기다려서» 검증할 수는 없다. 시간을 기다리는
 *   테스트는 느리거나 불안정하다. 상태를 직접 옮겨 «분기»만 정확히 겨눈다.
 */
function __testCache({ reset = false, age = false, cooldown = false } = {}) {
  if (reset) return resetCache(null);
  if (age) cache.fetchedAt = Date.now() - TTL_MS - 1;
  if (cooldown) { cache.lastFailureAt = 0; cache.lastRotationFetchAt = 0; }
  return undefined;
}

/** 테스트/진단용 — 지금 캐시가 어떤 상태인지. 키 «값»은 내보내지 않는다. */
function cacheStatus() {
  return {
    url: cache.url,
    hasKeys: Boolean(cache.raw),
    keyCount: cache.raw ? cache.raw.keys.length : 0,
    fetchedAt: cache.fetchedAt,
    ageMs: cache.fetchedAt ? Date.now() - cache.fetchedAt : null,
    lastFailureAt: cache.lastFailureAt,
  };
}

/** JWKS 로 보이는가. `keys` 가 배열이면 jose 가 나머지를 검사한다. */
function isJwksLike(json) {
  return Boolean(json) && Array.isArray(json.keys);
}

/**
 * 실제 조회 한 번. 성공하면 캐시를 갈아끼우고, 실패하면 «캐시를 건드리지 않고» 던진다.
 * ★ 실패 시 기존 캐시를 지우지 않는 것이 이 함수의 핵심이다 — 그게 「stale 로 버틴다」의 실체다.
 */
async function fetchJwks(url) {
  if (cache.inflight) return cache.inflight;

  cache.inflight = (async () => {
    // ★ 전역 `fetch` 를 쓴다. Node 18+ 표준이고(운영 이미지는 node:20-alpine),
    //   HTTP 클라이언트 의존성을 하나 더 늘리지 않는다.
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`JWKS 응답이 ${res.status} 다 (200 이 아니다)`);
    }
    const json = await res.json();
    if (!isJwksLike(json)) {
      throw new Error('JWKS 모양이 아니다 (keys 배열이 없다)');
    }
    if (json.keys.length === 0) {
      // ⚠ 빈 키셋을 캐시하면 「가져오기는 성공했는데 아무 토큰도 검증 못 한다」가 되고,
      //   그 상태가 TTL 동안 굳는다. 성공으로 치지 않는다.
      throw new Error('JWKS 가 비어 있다 (keys 길이 0)');
    }
    return json;
  })();

  try {
    const json = await cache.inflight;
    cache.raw = json;
    // jose 가 JWK → KeyObject 변환과 kid/alg/use/key_ops 매칭을 전부 한다.
    cache.resolve = createLocalJWKSet(json);
    cache.fetchedAt = Date.now();
    cache.lastError = null;
    logger.info('Supabase JWKS 갱신 완료', { keyCount: json.keys.length });
    return json;
  } catch (err) {
    cache.lastFailureAt = Date.now();
    cache.lastError = err;
    throw err;
  } finally {
    cache.inflight = null;
  }
}

/**
 * 검증에 쓸 키가 준비되게 만든다.
 *
 * 규칙:
 *   신선(TTL 이내)          → 아무것도 안 한다
 *   낡음 + 쿨다운 중        → 캐시가 있으면 그대로 쓴다 / 없으면 포기(503)
 *   낡음 + 조회 성공        → 갈아끼운다
 *   낡음 + 조회 실패        → **캐시가 있으면 그대로 버틴다**(에러 로그) / 없으면 포기(503)
 */
async function ensureKeys(url) {
  if (cache.url !== url) resetCache(url);

  const now = Date.now();
  if (cache.resolve && now - cache.fetchedAt < TTL_MS) return;

  const cooling = now - cache.lastFailureAt < REFRESH_COOLDOWN_MS;
  if (cooling) {
    if (cache.resolve) return;                       // 낡았지만 있다 → 버틴다
    throw new JwksUnavailableError(cache.lastError); // 아무것도 없다 → 포기
  }

  try {
    await fetchJwks(url);
  } catch (err) {
    if (cache.resolve) {
      // ★★ 이 로그가 「인증이 왜 조용히 낡은 키로 돌고 있나」의 유일한 단서다.
      logger.error('Supabase JWKS 갱신 실패 — 마지막으로 성공한 키로 버틴다 (인증은 계속된다)', {
        url,
        ageMs: Date.now() - cache.fetchedAt,
        detail: err.message,
      });
      return;
    }
    logger.error('Supabase JWKS 를 가져오지 못했고 캐시도 없다 — 인증이 전부 503 이 된다', {
      url,
      detail: err.message,
    });
    throw new JwksUnavailableError(err);
  }
}

/**
 * `jose.jwtVerify(token, resolver, …)` 에 그대로 넘길 키 해석기를 만든다.
 *
 * ★ 키 회전 대응: 모르는 `kid` 를 보면 (쿨다운을 지키며) **즉시 한 번 재조회**한다.
 *   Supabase 가 키를 회전시켜도 TTL 10분을 기다리지 않는다.
 *
 * @param {string} url JWKS URL (호출부가 환경변수에서 «조립»해서 넘긴다 — 여기서 하드코딩하지 않는다)
 */
function makeKeyResolver(url) {
  return async function resolveKey(protectedHeader, token) {
    await ensureKeys(url);
    if (!cache.resolve) throw new JwksUnavailableError(cache.lastError);

    try {
      return await cache.resolve(protectedHeader, token);
    } catch (err) {
      // 모르는 kid = 「키가 회전했다」의 정상적인 첫 증상이다. 한 번만 다시 가져와 본다.
      // ⚠ 쿨다운이 «반드시» 필요하다 — 없으면 아무나 가짜 kid 를 난사해
      //   우리 서버가 Supabase 로 JWKS 를 두들기게 만들 수 있다(증폭 공격).
      const rotated = err && err.code === 'ERR_JWKS_NO_MATCHING_KEY';
      const now = Date.now();
      const cooling = now - cache.lastFailureAt < REFRESH_COOLDOWN_MS
        || now - cache.lastRotationFetchAt < REFRESH_COOLDOWN_MS;
      if (!rotated || cooling) throw err;

      logger.warn('모르는 kid — JWKS 재조회 (키 회전 가능성)', { url });
      cache.lastRotationFetchAt = now;
      try {
        await fetchJwks(url);
      } catch (refetchErr) {
        // 재조회가 실패하면 **원래 에러**(키 없음)를 던진다. 그래야 401 로 분류된다.
        logger.error('키 회전 재조회 실패', { url, detail: refetchErr.message });
        throw err;
      }
      return cache.resolve(protectedHeader, token);
    }
  };
}

module.exports = {
  makeKeyResolver,
  JwksUnavailableError,
  cacheStatus,
  __testCache,
  TTL_MS,
  REFRESH_COOLDOWN_MS,
  FETCH_TIMEOUT_MS,
};
