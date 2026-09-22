-- ============================================================
-- 027: `U69-3` — 승인 반영된 제보 영양 행의 `verified_at` 백필 (데이터 정정 · 스키마 무변경)
-- ============================================================
-- 왜 (세션70 · 인수인계 178 §2-4 실측):
--   `contributionApply.applyNutritionAxis` 가 `nutrition_data_crowd` 에 행을 쓸 때 `applied_at` 만 적고
--   `verified_at` 은 비워 뒀다. 소비자 API 는 `product_nutrition_resolved.verified_at =
--   COALESCE(nd.verified_at, ndc.verified_at)` 를 읽으므로, 제보만 있는 제품(육포 306258 · 쌈장 306260)이
--   `verification_status: admin_verified` 인데 `data_freshness.verified_at: null` 로 나갔다.
--   코드는 세션70 에서 고쳤다(반영 시 `verified_at = now()`). 이 파일은 **그 전에 반영된 행**을 채운다.
--
-- 무엇을 (하나):
--   `nutrition_data_crowd` 에서 `verified_at IS NULL` 이고 `applied_at` 이 있는 행 →
--   `verified_at = applied_at`. 「반영됨 = 관리자가 확인함」이므로 반영 시각이 곧 확인 시각이다.
--   ⛔ `now()` 로 채우지 말 것 — 실제 확인 시각(9/21 06:07 · 06:09)이 있는데 오늘 날짜로 덮으면 거짓 기록이다.
--
-- ⚠⚠ **멱등해야 한다.** `real-postgres` job 이 `npm run migrate` 를 2회 돌린다.
--   2회차엔 `verified_at IS NULL` 인 행이 0개라 0행 갱신으로 끝난다.
--
-- 선행: **반드시 025 뒤.** `nutrition_data_crowd` 가 있어야 한다.
-- ⛔ `npm run migrate` 체인에 이어 붙였는지 확인할 것 (`package.json` `_note:migrate2` ·
--    `tests/test_contribution_apply.js §0` 이 체인을 단정한다).
-- ============================================================

UPDATE nutrition_data_crowd
   SET verified_at = applied_at
 WHERE verified_at IS NULL
   AND applied_at IS NOT NULL;
