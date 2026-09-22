-- ============================================================
-- 028: 027 첫 판이 026 이관 행에 잘못 찍은 `verified_at` 되돌리기 (데이터 정정 · 스키마 무변경)
-- ============================================================
-- 왜 (세션70 운영 실측 2026-09-22 00:47Z · 인수인계 179 §3):
--   027 첫 판이 `nutrition_data_crowd` 5행을 갱신했다. 그중 2행은 026 이관 행
--   (306257 비비고 순살 삼치구이 · 306261 (OCR 분석 제품) — `applied_by='migration_026'` · `review_id NULL` ·
--   products.verification='unverified')이라 `applied_at` 이 «이관 시각(2026-09-01 05:53Z)»이지 관리자 확인 시각이 아니다.
--   그대로 두면 소비자 API `data_freshness.verified_at` 이 «unverified 인데 확인 시각이 있는» 거짓 기록이 된다.
--
-- 무엇을 (하나):
--   이관 행(`review_id IS NULL AND applied_by = 'migration_026'`) 중 `verified_at = applied_at` 인 행(=027 이 찍은 것)만
--   `verified_at = NULL` 로 되돌린다. 원래 `nutrition_data.verified_at` 이 있어서 026 이 승계한 행은 `verified_at ≠ applied_at`
--   이므로 건드리지 않는다(2회차·빈 DB 에서도 안전).
--
-- ⚠⚠ **멱등해야 한다.** `real-postgres` job 이 `npm run migrate` 를 2회 돌린다. 027 이 고쳐진 뒤엔 이 조건에 맞는 행이
--   0개라 0행 갱신으로 끝난다. 운영에서는 1회 2행.
-- 선행: **반드시 027 뒤.**
-- ============================================================

UPDATE nutrition_data_crowd
   SET verified_at = NULL
 WHERE review_id IS NULL
   AND applied_by = 'migration_026'
   AND verified_at IS NOT NULL
   AND verified_at = applied_at;
