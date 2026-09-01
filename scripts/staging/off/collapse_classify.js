/**
 * collapse_classify.js — ⚠ **껍데기다. 로직은 여기 없다.**
 *
 * 정본: `src/services/collapseClassify.js`
 *
 * ★ 왜 옮겼나 (세션66 · 2026-09-01)
 *   `src/routes/adminRoutes.js` 가 이 파일을 require 했는데, `src/`(런타임)와
 *   `scripts/staging/`(배치)는 **배포 경계가 다르다**:
 *     · `.dockerignore` 가 `scripts/staging/` 을 **의도적으로 제외**한다
 *       (「일회성 데이터 파이프라인 스크립트 — 운영엔 불필요」).
 *     · 그래서 운영 이미지에 이 파일이 없었고, 컨테이너가 부팅 즉시 죽어
 *       **크래시 루프 + healthcheck 실패**가 났다. 로그에 에러가 한 줄도 안 남았다.
 *   ⇒ 런타임이 필요로 하는 로직은 `src/` 에 있어야 한다. `.dockerignore` 를 뚫는 것은 오답이다.
 *
 * ★ 이 껍데기를 남긴 이유
 *   배치 스크립트 4개가 이 경로를 쓴다:
 *     · `scripts/staging/off/annotate_collapse_routes.js`
 *     · `scripts/staging/off/run_import_bridge_eval.js`
 *     · `scripts/staging/domestic/product_dedup_classify.js`
 *     · `scripts/staging/domestic/build_product_entities.js`
 *   경로를 바꾸면 그 넷을 동시에 고쳐야 하고, 그중 하나라도 빠뜨리면 Eval 이 조용히 깨진다.
 *   **재수출이 더 싸고 더 안전하다.**
 *
 * ⛔ 여기에 로직을 다시 쓰지 말 것. 두 벌이 되면 반드시 한쪽만 고치게 된다.
 *    (이 저장소가 여러 세션 겪은 사고 유형이다 — 그래서 `additiveResolver.js` ·
 *     `contributionApply.js` 도 「규칙의 유일한 본문」 하나로 두고 있다.)
 */
'use strict';

module.exports = require('../../../src/services/collapseClassify');
