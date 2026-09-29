-- ============================================================
-- 029: contribution_review.status 에 'auto_applied' 추가 (세션72 · 알레르기 자동 반영)
-- ============================================================
-- 왜:
--   세션71 제이 결정(2026-09-28) — 제보 알레르기 축은 게이트(allergen_auto_gate_v1)를 통과하면
--   관리자 승인 없이 `product_allergens` 에 `status='crowd_auto'` 로 반영한다.
--   세션72 범위 확정(2026-09-29) — **알레르기 축 · 게이트 통과분만.** 영양·원재료·첨가물은 전량 수동 그대로.
--   정본: IP/결정_알레르기자동반영_2026-09-29.md
--
-- 무엇을 (하나): `cr_status_chk` 어휘에 'auto_applied' 를 더한다.
--   ★ 'approved' 로 적지 «않는» 이유 — `cr_approve_human_chk`(024)는 「approved = 사람이 승인」을 DB 가 강제하는
--     장치다. 기계 반영을 approved + reviewed_by='system' 으로 적으면 그 뜻이 흐려져 감사에서 구분할 수 없다.
--     → `cr_approve_human_chk` 는 **그대로 둔다.** auto_applied 는 approved 가 아니므로 그 제약과 무관하다.
--   ★ `uq_cr_approved_per_product_axis`(approved 최대 1건)도 그대로 — auto_applied 는 그 인덱스 밖이다.
--
-- 회귀 없음: 어휘 «추가»만. 기존 행·기존 5개 값 그대로 허용.
-- ⚠⚠ 멱등: real-postgres job 이 `npm run migrate` 를 2회 돌린다 → DROP IF EXISTS 후 ADD.
-- 선행: 024.
-- ============================================================

ALTER TABLE contribution_review DROP CONSTRAINT IF EXISTS cr_status_chk;
ALTER TABLE contribution_review ADD CONSTRAINT cr_status_chk
  CHECK (status IN ('candidate','approved','rejected','undone','superseded','auto_applied'));

COMMENT ON COLUMN contribution_review.status IS
  'candidate=검토 대기 | approved=승인(사람 · 적용 대상) | rejected=반려 | undone=승인/자동반영 취소 | '
  'superseded=더 나은 제보로 대체 | auto_applied=게이트 자동 반영(029 · 알레르기 축만 · 사람 아님). '
  'undone 어휘는 product_entity_members.status 가 이미 쓰던 것이다 — 새 말을 만들지 않는다.';

-- 검증: 기대 def 에 'auto_applied' 포함
SELECT conname, pg_get_constraintdef(oid) AS def
  FROM pg_constraint WHERE conname = 'cr_status_chk';
