-- ============================================================
-- 024: 제보 검토 큐 — contribution_review (`DS-1`·`DS-2`·`DS-4`)
-- ============================================================
-- 왜 (세션66 계약 C2 · 설계 §2·§11-C):
--   지금은 제보가 들어오면 **곧바로 공식 테이블에 써진다.**
--   그래서 「검토 중」이라는 상태가 스키마에 없고, 다음 세 가지가 동시에 열려 있다.
--     `U65-7` 반려가 `nutrition_data` 를 DELETE 한다 — 공공 데이터를 지울 수 있다
--     `U65-8` 미검토 제보가 즉시 다른 소비자에게 노출된다
--     `U64-12` 사람이 한 번도 안 본 것이 `verified` 로 승격된다
--   ⇒ **「승인」이라는 사건이 저장되는 자리 자체가 없었다.** 이 테이블이 그 자리다.
--
-- 무엇을:
--   `contribution_review` 신설. **1행 = 「어떤 제보의 어떤 축을, 누가, 언제,
--   어떻게 판정했는가」** 다. 축(axis)마다 따로 판정한다 —
--   영양은 못 믿겠는데 원재료명은 멀쩡한 사진이 실제로 대부분이기 때문이다.
--
-- ★★ 이 마이그레이션의 «핵심»은 컬럼이 아니라 제약 두 개다.
--
--   (1) `cr_approve_human_chk` — `status='approved'` 인데 `reviewed_by` 가 NULL 이면 DB 가 거부한다.
--       ⇒ **`DS-1`(전량 수동 검토)을 «DB 가» 강제한다.**
--       코드에 버그가 나도, 나중에 누가 자동 승인 배치를 짜도, **행이 들어가지 않는다.**
--       본보기: `imp_match_accept_human_chk`(`000_baseline.sql` §4 import 매치 블록) —
--       같은 이유로 「사람 없이 accept 될 수 없다」를 DB 에 박아둔 그 장치다.
--
--   (2) `uq_cr_approved_per_product_axis` — 한 제품의 한 축에 승인된 제보는 **최대 1건**.
--       ⇒ 뷰가 `nutrition_data_crowd` 를 1:1 로 조인할 수 있는 근거이고(025),
--         `product_ingredients` 같은 UNIQUE 없는 테이블에 같은 내용이 두 번 실리는 것을 막는다.
--       본보기: `uq_pem_approved_per_product`(`018_product_entities.sql` §2).
--       ⚠ partial unique 라 `candidate` 는 몇 건이든 쌓일 수 있다 — 큐이므로 그것이 맞다.
--
-- 어휘:
--   `status` = candidate | approved | rejected | undone | superseded
--   ★ `'undone'` 은 새 말이 아니다 — `product_entity_members.status` 가 이미 쓰고 있고,
--     `reviewActions.js` 의 4큐와 같은 어휘다. **새 어휘를 만들지 않는 것이 규칙이다.**
--   `'rejected'` 가 `U65-7` 을 없앤다: 반려는 **상태 전이**이지 DELETE 가 아니다.
--     애초에 공식 테이블에 안 들어갔으므로 지울 것이 없다.
--
-- ⚠ `product_id` 가 NULL 허용인 이유: 바코드가 아직 `products` 에 없는 제보가 실재한다.
--   그 경우 제품 행 자체를 만들 것인가는 **별개 축**이고 세션66 범위 밖이다(`U66-1`).
--   스키마는 두 경우를 모두 허용한 채로 둔다.
--
-- ⚠ `axis` 는 ENUM 이 아니라 TEXT + CHECK 다 — 023 과 같은 이유.
--
-- 회귀 없음: 순수 신설. 기존 테이블·뷰·행 무접촉.
-- 선행: `contributions`(000_baseline) · `products`(000_baseline).
-- 후행: 025 가 `nutrition_data_crowd.review_id` 로 이 테이블을 참조한다 — **순서를 지킬 것.**
--
-- ⛔ `npm run migrate` 체인에 이어 붙였는지 확인할 것. `package.json` `_note:migrate2`.
-- ============================================================


-- ── 묶음 1) 테이블 ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contribution_review (
  review_id       BIGSERIAL PRIMARY KEY,
  contribution_id BIGINT NOT NULL REFERENCES contributions(contribution_id) ON DELETE CASCADE,
  product_id      BIGINT REFERENCES products(product_id) ON DELETE CASCADE,
  axis            TEXT   NOT NULL,
  status          TEXT   NOT NULL DEFAULT 'candidate',
  reviewed_by     TEXT,
  reviewed_at     TIMESTAMPTZ,
  applied_at      TIMESTAMPTZ,
  reject_reason   TEXT,
  evidence        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cr_axis_chk   CHECK (axis IN ('nutrition','ingredients','allergens','additives')),
  CONSTRAINT cr_status_chk CHECK (status IN ('candidate','approved','rejected','undone','superseded')),
  CONSTRAINT cr_approve_human_chk CHECK (status <> 'approved' OR reviewed_by IS NOT NULL)
);


-- ── 묶음 2) 인덱스 ───────────────────────────────────────────
-- ★ 제품당·축당 approved 는 최대 1건. 뷰 1:1 조인의 근거이자 중복 적용 방어다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cr_approved_per_product_axis
  ON contribution_review (product_id, axis) WHERE status = 'approved';
-- 관리자 큐의 유일한 읽기 패턴(「candidate 를 오래된 순으로」).
CREATE INDEX IF NOT EXISTS idx_cr_status ON contribution_review (status, created_at);
-- 「이 제보가 어떻게 처리됐나」 역추적.
CREATE INDEX IF NOT EXISTS idx_cr_contribution ON contribution_review (contribution_id);


-- ── 묶음 3) 주석 ─────────────────────────────────────────────
COMMENT ON TABLE contribution_review IS
  '제보 검토 큐. 024(2026-08-30 세션66 C2). 1행 = (제보 × 축)의 판정. '
  '반려는 status 전이이지 DELETE 가 아니다(U65-7 소멸).';

COMMENT ON CONSTRAINT cr_approve_human_chk ON contribution_review IS
  '★ DS-1(전량 수동)을 DB 가 강제한다. reviewed_by 없이 approved 가 될 수 없다 — '
  '코드 버그로도 자동 승인이 불가능하다. imp_match_accept_human_chk 와 같은 장치.';

COMMENT ON COLUMN contribution_review.status IS
  'candidate=검토 대기 | approved=승인(적용 대상) | rejected=반려 | undone=승인 취소 | superseded=더 나은 제보로 대체. '
  'undone 어휘는 product_entity_members.status 가 이미 쓰던 것이다 — 새 말을 만들지 않는다.';

COMMENT ON COLUMN contribution_review.applied_at IS
  'contributionApply 가 공식 데이터셋에 실제로 옮긴 시각. NULL = 승인됐지만 아직 안 옮겼다. '
  'NOT NULL 인 행을 다시 적용하면 ALREADY_APPLIED 다(멱등 방어).';

COMMENT ON COLUMN contribution_review.evidence IS
  '적용 «전/후» 스냅샷과 환산 근거. {before, after, convert}. '
  '★ 이것이 없으면 undo 가 불가능하다 — product_entity_audit.before_json 이 의도했다가 '
  '한 번도 안 쓰인 그것을 이번엔 실제로 쓴다.';

COMMENT ON COLUMN contribution_review.product_id IS
  'NULL 허용 — 바코드가 아직 products 에 없는 제보가 실재한다. '
  '제품 행 자체의 수명주기는 별개 축이다(U66-1).';


-- ── 검증 (실행 후 이 SELECT 로 확인) ─────────────────────────
-- 기대: cr_axis_chk · cr_status_chk · cr_approve_human_chk 3건
SELECT conname, pg_get_constraintdef(oid) AS def
  FROM pg_constraint
 WHERE conrelid = 'contribution_review'::regclass
   AND contype = 'c'
 ORDER BY conname;
