// src/middleware/supabaseAuth.js
// ============================================================================
// Supabase Access Token(JWT) 검증 미들웨어 — 세션64c 신설 / 세션64c 후속에서 교정
//
// 왜 이 파일이 있는가 (제이 확정 2026-08-24):
//   「지금까지 별개의 앱을 별개의 방식으로 인증받았다. 통합이 진행되므로
//     통합앱의 인증 방법으로 변경해야 한다.」 + 「제보도 로그인 필수」
//   통합앱(영양공식)은 **Supabase Auth**(`supabase.auth.getSession()`)를 쓰고
//   먹선 서버는 **Firebase Auth** 였다. 그래서 웹 제보의 `contributions.user_id` 가
//   **항상 null** 이었다. 이 미들웨어가 그 간극을 닫는다.
//
//   ⚠ 노션 [통합 현재상태 브리프](2026-07-09) §7-2 는 「인증 분리 유지」였다.
//     이 파일이 그 결정을 **뒤집는다**. 노션이 낡았다.
//
// ⚠ `firebaseAuth.js` 를 지우지 않는다. 전환 기간에 공존한다.
//   (health-pick 등 인접 앱의 실제 사용 여부를 아직 확인하지 못했다.)
//
// ────────────────────────────────────────────────────────────────────────────
// ★★★ 서명 알고리즘 — 이 파일의 첫 판이 «틀렸던» 자리다. 고쳐 적는다.
//
//   ✗ 첫 판이 적었던 것: 「이 프로젝트는 대칭키(HS256, legacy JWT secret)를 쓴다.
//                        따라서 SUPABASE_JWT_SECRET 하나로 검증할 수 있다(JWKS 불필요).」
//   ✗ 그 근거: `web/.env.local` 의 `VITE_SUPABASE_ANON_KEY` 를 디코드해 헤더가
//              `{"alg":"HS256"}` 인 것을 확인했다.
//   ✗ 왜 틀렸나: **anon key 는 사용자 access token 이 아니다.** anon key 는 프로젝트
//              API 키이고 legacy secret 으로 서명된 HS256 이 맞다. 그러나 사용자 세션
//              토큰은 **별개의 서명 키**로 서명된다. 표본을 잘못 골랐다.
//
//   ✓ 실측 (2026-08-25 · 제이 대시보드 화면 + 공개 JWKS 엔드포인트)
//     ① Settings → JWT Keys 배너:
//          「Legacy JWT secret has been migrated to new JWT Signing Keys」
//        legacy secret 은 이제 **only verify** — 서명에는 쓰이지 않는다.
//     ② 같은 화면 `JWT Signing Keys` 의 CURRENT KEY 타입 = **ECC (P-256)**.
//     ③ `https://lrnuqhpgyuizfggxgxpl.supabase.co/auth/v1/.well-known/jwks.json`
//          → `{"keys":[{"alg":"ES256","crv":"P-256","kty":"EC","use":"sig",
//                       "kid":"d7edc63b-1b85-405a-a6cc-18891f96b6c5", …}]}`
//        `kid` 가 대시보드의 CURRENT KEY ID 와 일치하고 **키는 이것 하나뿐**이다.
//     ⇒ 새 access token 은 **ES256**. HS256 만 두고 배포하면 전부 401 이었다.
//
//   ★ 다음 세션이 같은 함정에 빠지지 않도록 — «확인하는 법»
//       curl https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json
//     비밀이 필요 없는 공개 엔드포인트다. `keys[].alg` 가 그 프로젝트가 **지금 실제로
//     서명에 쓰는** 알고리즘이다. anon key 를 디코드해서 알고리즘을 정하지 마라.
//
// ────────────────────────────────────────────────────────────────────────────
// ★ 두 경로를 «둘 다» 둔다 — 그리고 각각 알고리즘을 «고정»한다
//
//   ① 주 경로 ES256 + JWKS   — 지금 발급되는 모든 토큰
//   ② 폴백  HS256 + legacy secret — 전환 «이전»에 발급돼 아직 만료되지 않은 세션
//      Supabase 가 legacy secret 을 「still used」로 표시한다. `SUPABASE_JWT_SECRET`
//      이 설정돼 있을 때만 시도한다. 없으면 ES256 만으로 정상 동작한다.
//
//   ⚠ 토큰 헤더의 `alg` 로 «경로만» 고른다. 그리고 각 경로는 자기 알고리즘을 못박는다.
//     이것이 알고리즘 혼동(alg confusion)을 막는 방식이다:
//       · ES256 경로의 키는 **JWKS 공개키**뿐이다 — 그 값으로 HMAC 서명을 만들 수 없다.
//       · HS256 경로의 키는 **SUPABASE_JWT_SECRET** 뿐이다 — JWKS 재료가 절대 오지 않는다.
//       · `alg:none` 은 두 경로 어디에도 없다 → 거부된다.
//     첫 판의 `algorithms: ['HS256']` 한 줄이 지키려던 것이 이것이다. 그 취지를 살렸다.
//
// ────────────────────────────────────────────────────────────────────────────
// ★★ Supabase JWT 의 «실제» 클레임 구조 — 추정이 아니라 실측이다
//   근거) 앱이 실제로 쓰는 라이브러리의 타입 정의
//         `web/node_modules/@supabase/auth-js@2.110.8/dist/main/lib/types.d.ts:1622`
//           export type RequiredClaims = {
//             iss: string; sub: string; aud: string | string[];
//             exp: number; iat: number; role: string;
//             aal: AuthenticatorAssuranceLevels; session_id: string;
//           }
//         → **`sub` 가 user id** 다. `email` 은 **선택**이다(전화·익명 로그인은 없다).
//
// ★★★ 왜 «서명만» 검증하면 안 되는가 — 이 저장소에 실제로 존재하는 함정
//   Supabase 의 **anon key 자체가 legacy secret 으로 서명된 유효한 HS256 JWT** 다.
//   그 키는 앱 번들에 박혀 나가는 **공개 값**이다. 서명만 보면
//   「아무나 anon key 를 Bearer 로 보내면 로그인한 사람이 된다.」
//   → 막는 유일한 방법: **`sub` 가 실제로 있어야 한다.**
//     anon key 의 클레임은 `iss,ref,role,iat,exp` 뿐이고 `sub` 가 **없다**(실측).
//     service_role key 도 마찬가지다.
//   ⚠⚠ **HS256 폴백을 다시 여는 것이 바로 이 구멍을 다시 여는 일이다.**
//      그래서 `sub` 검사는 두 경로 «공통 자리»(`buildAuth`)에 있다. 경로별로 복사하지 않는다.
//      복사하면 한쪽만 고쳐지고 다른 쪽이 샌다. `sub` 검사가 없으면 폴백을 넣지 마라.
// ============================================================================
'use strict';

const { jwtVerify, decodeProtectedHeader } = require('jose');
const { makeKeyResolver, JwksUnavailableError } = require('../config/supabaseJwks');
const logger = require('../config/logger');

/**
 * 사람이 볼 수 있는 신원만 담는다. 토큰 원문·서명은 **절대** 여기에 넣지 않는다
 * (로그·에러 응답에 실려 나가는 사고를 원천 차단).
 * @typedef {{ supabaseUid: string, email: string|null, isAnonymous: boolean }} SupabaseAuth
 */

/** 토큰을 받을 수 없는 role. anon key·service_role key 를 Bearer 로 보내는 것을 막는다. */
const REJECTED_ROLES = new Set(['anon', 'service_role']);

/** Supabase 의 공개 JWKS 경로. 프로젝트 URL 뒤에 붙는 «고정» 경로다. */
const JWKS_PATH = '/auth/v1/.well-known/jwks.json';

/**
 * ⚠ 환경변수는 **호출 시점에** 읽는다. 모듈 로드 시점에 캐시하면
 *   테스트가 `process.env` 를 바꿔도 안 먹고, Railway 가 환경변수를 나중에 주입하는
 *   순서(마이그레이션 → 환경변수 → 코드)에서도 조용히 빈 값으로 굳는다.
 */
function env(name) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** legacy HS256 폴백용 비밀. 없으면 null — 그래도 ES256 으로 정상 동작해야 한다. */
function getSecret() {
  return env('SUPABASE_JWT_SECRET');
}

/**
 * JWKS URL 을 **환경변수에서 조립**한다. ⚠ 하드코딩 금지 —
 * 프로젝트 ref 를 소스에 박으면 스테이징/교체 시 아무도 못 찾는 곳에서 401 이 난다.
 *
 *   ① `SUPABASE_URL`        = `https://<ref>.supabase.co`   ← 권장. NutriLens `.env.example` 관례.
 *   ② `SUPABASE_PROJECT_REF`= `<ref>`                       ← ①이 없을 때만
 *
 * ⚠ 평문 http 는 **루프백(127.0.0.1·localhost)에서만** 허용한다. 공개망에서 http 로
 *   JWKS 를 받으면 중간자가 «자기 공개키»를 밀어넣어 아무 토큰이나 통과시킬 수 있다.
 *   (루프백은 중간자가 없고, 테스트가 목 서버를 세울 때 쓴다.)
 *
 * @returns {string|null} 조립된 URL. 환경변수가 없거나 형식이 틀리면 null.
 */
function getJwksUrl() {
  const raw = env('SUPABASE_URL');
  const ref = env('SUPABASE_PROJECT_REF');
  const base = raw || (ref ? `https://${ref}.supabase.co` : null);
  if (!base) return null;

  let u;
  try {
    u = new URL(base);
  } catch (_) {
    logger.error('SUPABASE_URL 이 URL 이 아니다 — JWKS 를 조립할 수 없다', { value: base });
    return null;
  }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    logger.error('SUPABASE_URL 이 https 가 아니다 — 평문 JWKS 는 중간자에게 키를 갈아끼울 틈을 준다', {
      protocol: u.protocol,
    });
    return null;
  }
  return `${u.origin}${JWKS_PATH}`;
}

/**
 * `Authorization: Bearer <token>` 에서 토큰만 뽑는다.
 * @returns {string|null} 헤더가 없거나 Bearer 형식이 아니면 null
 */
function extractBearer(req) {
  const h = req.headers?.authorization;
  if (typeof h !== 'string') return null;
  if (!/^Bearer\s+/i.test(h)) return null;
  const t = h.replace(/^Bearer\s+/i, '').trim();
  return t || null;
}

/** 헤더의 `alg` 를 «신뢰하지 않고» 읽는다 — 경로 선택에만 쓴다. 깨진 토큰이면 null. */
function peekAlg(token) {
  try {
    const h = decodeProtectedHeader(token);
    return typeof h?.alg === 'string' ? h.alg : null;
  } catch (_) {
    return null;
  }
}

/** 앱이 사용자에게 **그대로 보여줄 수 있는** 문장들. 기술 용어를 넣지 않는다. */
const MSG = {
  required: '로그인이 필요해요.',
  invalid: '로그인 정보가 올바르지 않아요. 다시 로그인해 주세요.',
  expired: '로그인이 만료되었어요. 다시 로그인해 주세요.',
  notConfigured: '서버 점검 중이에요. 잠시 후 다시 시도해 주세요.',
  keysUnavailable: '로그인 확인 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.',
};

const fail = (reason, message = MSG.invalid) => ({ ok: false, kind: 'invalid', reason, message });

/**
 * 검증된 payload → 신원. **`sub` 검사가 여기 있다** — 두 경로가 «공유»하는 자리다.
 * @param {object} payload 서명이 이미 검증된 클레임
 */
function buildAuth(payload, via) {
  // ── `sub` 필수 ────────────────────────────────────────────────────────────
  // ★★★ 위 「함정」주석 참조 — anon key 를 로그인으로 인정하지 않는 유일한 방어선이다.
  const sub = payload && typeof payload.sub === 'string' ? payload.sub.trim() : '';
  if (!sub) return fail(`NO_SUB:${via}`);

  // ── role 거름 ─────────────────────────────────────────────────────────────
  // `sub` 검사만으로도 anon/service key 는 걸리지만, 두 겹으로 둔다.
  // ⚠ 「`role === 'authenticated'` 여야 한다」로 **좁히지 않았다** — Supabase 의
  //   Custom Access Token Hook 으로 role 을 바꾸는 것이 정상 기능이라
  //   좁히면 나중에 전원이 401 을 맞는다. 「이것만 거부」가 안전한 쪽이다.
  const role = typeof payload.role === 'string' ? payload.role : '';
  if (REJECTED_ROLES.has(role)) return fail(`ROLE_REJECTED:${role}`);

  return {
    ok: true,
    via,
    auth: {
      supabaseUid: sub,
      // ★ `email` 은 **선택 클레임**이다(types.d.ts:1641). 없으면 null — 빈 문자열이 아니다.
      //   '' 과 null 이 섞이면 users.email 에 두 가지 「모름」이 저장된다.
      email: typeof payload.email === 'string' && payload.email.trim() ? payload.email.trim() : null,
      // ★ Supabase 익명 로그인(`signInAnonymously`)도 `role: 'authenticated'` 에 `sub` 를 받는다.
      //   즉 **위 검사를 전부 통과한다.** 「제보도 로그인 필수」의 의도가 익명 계정까지
      //   허용하는 것인지는 확인하지 못했다 → 여기서 **거부하지 않고 표시만 한다**.
      //   차단이 필요하면 라우트에서 `req.auth.isAnonymous` 를 보고 막으면 된다.
      isAnonymous: payload.is_anonymous === true,
    },
  };
}

/** jose 의 예외를 사용자 문구 + 로그용 사유로 옮긴다. 토큰 내용은 절대 싣지 않는다. */
function mapVerifyError(err, via) {
  // ★ 키를 못 구한 것은 «검증 실패»가 아니다. 사용자는 다시 로그인해도 못 고친다.
  if (err instanceof JwksUnavailableError || err?.code === 'JWKS_UNAVAILABLE') {
    return { ok: false, kind: 'unavailable', reason: 'JWKS_UNAVAILABLE', message: MSG.keysUnavailable };
  }
  if (err?.code === 'ERR_JWT_EXPIRED') {
    return { ok: false, kind: 'invalid', reason: 'EXPIRED', message: MSG.expired };
  }
  return fail(`VERIFY_FAILED:${via}:${err?.code || err?.name || 'UNKNOWN'}`);
}

/**
 * 토큰을 검증해 신원을 만든다. **DB 를 만지지 않는다** — 순수 함수라 테스트가 쉽다.
 *
 * ⚠ 세션64c 후속에서 **비동기가 됐다**(JWKS 조회 때문). 부르는 쪽은 반드시 await 해야 한다.
 *
 * @param {string} token
 * @param {{ jwksUrl: string|null, secret: string|null }} cfg
 * @returns {Promise<{ ok:true, via:string, auth:SupabaseAuth }
 *                 | { ok:false, kind:'invalid'|'unavailable'|'not_configured', reason:string, message:string }>}
 */
async function verifySupabaseToken(token, cfg = {}) {
  const jwksUrl = cfg.jwksUrl ?? null;
  const secret = cfg.secret ?? null;
  const alg = peekAlg(token);

  // ── ② 폴백: legacy HS256 ──────────────────────────────────────────────────
  // ⚠ `HS256` 만이 아니라 **HMAC 계열 전체**(HS256/384/512)를 이쪽으로 보낸다.
  //   왜? 보내지 않으면 `HS512` 가 ES256 경로로 흘러가 거기서 막히고, 그러면
  //   **아래 `algorithms: ['HS256']` 고정이 「죽은 코드」가 된다** — 누가 지워도 아무도 모른다.
  //   여기로 보내야 그 고정이 실제로 일하는 줄이 되고, 테스트가 그것을 겨눌 수 있다.
  if (alg && alg.startsWith('HS')) {
    if (!secret) {
      // 전환이 끝난 뒤 정상 토큰은 전부 ES256 이다. 여기 오는 것은 폐기된 세션이거나 공격이다.
      // ⚠ 503 으로 올리지 않는다 — 그러면 아무나 HS256 모양 토큰을 보내 503 을 만들 수 있다.
      return fail('HS256_NO_SECRET');
    }
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
        algorithms: ['HS256'],   // ★ 폴백에서도 고정을 «유지»한다
        requiredClaims: ['exp'], // 만료 없는 토큰 = 영원한 토큰. 받지 않는다.
      });
      return buildAuth(payload, 'hs256');
    } catch (err) {
      return mapVerifyError(err, 'hs256');
    }
  }

  // ── ① 주 경로: ES256 + JWKS ───────────────────────────────────────────────
  // ⚠ `alg` 가 null(깨진 토큰)이거나 모르는 값이어도 이쪽으로 온다. 그래도 안전하다 —
  //   아래 `algorithms: ['ES256']` 이 ES256 아닌 것을 전부 거부한다(`none` 포함).
  if (!jwksUrl) {
    // 환경변수 미설정. 사용자 잘못이 아니다 → 401 이 아니라 503 으로 올린다.
    return {
      ok: false, kind: 'not_configured', reason: 'NO_JWKS_URL', message: MSG.notConfigured,
    };
  }
  try {
    const { payload } = await jwtVerify(token, makeKeyResolver(jwksUrl), {
      algorithms: ['ES256'],   // ★★ 이 한 줄이 이 파일에서 가장 중요한 줄이다.
      requiredClaims: ['exp'],
    });
    return buildAuth(payload, 'es256');
  } catch (err) {
    return mapVerifyError(err, 'es256');
  }
}

/** 401 응답 한 곳. 저장소 관례 `{ success, error:{ code, message } }` 그대로. */
function deny(res, code, message) {
  return res.status(401).json({ success: false, error: { code, message } });
}

/** 503 응답 한 곳. ⚠ 401 로 내리지 않는다 — 사용자는 다시 로그인해도 못 고친다. */
function unavailable(res, code, message) {
  return res.status(503).json({ success: false, error: { code, message } });
}

/**
 * 검증 실패 결과를 HTTP 응답으로 옮긴다. 두 미들웨어가 공유한다.
 * ★ 401 코드 체계는 **유지**한다 — 앱(`web/src/domain/meokseon/reportAuth.ts`)이
 *   `AUTH_REQUIRED`(로그인 안 됨)와 `AUTH_INVALID`(만료·폐기)로 문구를 갈라 말한다.
 */
function respondFailure(res, r, req) {
  if (r.kind === 'not_configured') {
    logger.error('SUPABASE_URL / SUPABASE_PROJECT_REF 미설정 — ES256 토큰을 검증할 수 없다', {
      path: req.originalUrl,
    });
    return unavailable(res, 'AUTH_NOT_CONFIGURED', r.message);
  }
  if (r.kind === 'unavailable') {
    // ★ 이미 supabaseJwks.js 가 원인을 error 로 남겼다. 여기서는 영향 범위만 적는다.
    logger.error('JWKS 를 구하지 못해 인증을 «통과시키지 않았다» (fail-open 금지)', {
      path: req.originalUrl,
    });
    return unavailable(res, 'AUTH_KEYS_UNAVAILABLE', r.message);
  }
  // ⚠ 토큰 값 자체는 절대 로깅하지 않는다(그대로 재사용 가능한 자격증명이다).
  logger.warn('Supabase token verification failed', { reason: r.reason, path: req.originalUrl });
  return deny(res, 'AUTH_INVALID', r.message);
}

/**
 * 인증 **필수** 미들웨어. 성공 시 `req.auth = { supabaseUid, email, isAnonymous }`.
 */
async function supabaseAuth(req, res, next) {
  const jwksUrl = getJwksUrl();
  const secret = getSecret();

  if (!jwksUrl && !secret) {
    // ★★ 배포 순서(마이그레이션 → 환경변수 → 코드)가 어긋났을 때 **500 이 아니라**
    //   원인이 보이는 오류를 준다. 401 로 내리면 「사용자 잘못」처럼 보여서
    //   아무도 서버 설정을 의심하지 않는다 — 그게 가장 오래 안 잡히는 종류의 사고다.
    logger.error('SUPABASE_URL(또는 SUPABASE_PROJECT_REF)·SUPABASE_JWT_SECRET 이 «둘 다» 없다 — 인증 라우트가 전부 막힌다', {
      path: req.originalUrl,
    });
    return unavailable(res, 'AUTH_NOT_CONFIGURED', MSG.notConfigured);
  }

  const token = extractBearer(req);
  if (!token) {
    return deny(res, 'AUTH_REQUIRED', MSG.required);
  }

  const r = await verifySupabaseToken(token, { jwksUrl, secret });
  if (!r.ok) return respondFailure(res, r, req);

  req.auth = r.auth;
  return next();
}

/**
 * 인증 **선택** 미들웨어. 토큰이 있으면 검증하고, 없으면 `req.auth = null` 로 통과.
 *
 * ★ 「토큰이 있는데 틀렸다」는 **통과시키지 않는다**(401). 조용히 게스트로 강등하면
 *   만료된 세션으로 제보한 사용자의 기록이 주인 없이 쌓이고, 본인은 영영 못 찾는다.
 *   같은 이유로 「JWKS 를 못 구했다」도 게스트로 강등하지 않는다(503). fail-open 금지.
 * ★ 설정이 **아예 없을** 때에만 게스트로 통과시킨다 — 선택 인증 라우트(제품 조회 등)를
 *   환경변수 하나로 통째로 죽이지 않기 위해서다.
 */
async function supabaseAuthOptional(req, res, next) {
  const token = extractBearer(req);
  if (!token) {
    req.auth = null;
    return next();
  }
  const jwksUrl = getJwksUrl();
  const secret = getSecret();
  if (!jwksUrl && !secret) {
    logger.error('Supabase 인증 환경변수 미설정 — 토큰이 왔지만 게스트로 처리한다', {
      path: req.originalUrl,
    });
    req.auth = null;
    return next();
  }
  const r = await verifySupabaseToken(token, { jwksUrl, secret });
  if (!r.ok) {
    if (r.kind === 'invalid') {
      logger.warn('Supabase token verification failed (optional)', {
        reason: r.reason, path: req.originalUrl,
      });
      return deny(res, 'AUTH_INVALID', r.message);
    }
    return respondFailure(res, r, req);
  }
  req.auth = r.auth;
  return next();
}

module.exports = {
  supabaseAuth,
  supabaseAuthOptional,
  verifySupabaseToken,
  // 테스트·진단용. 라우트가 쓰지 않는다.
  getJwksUrl,
};
