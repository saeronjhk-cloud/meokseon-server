-- ============================================================
-- 026: `DS-2`·`DS-7` — 기존 제보 영양 행 이관 + 분리를 DB 가 강제
-- ============================================================
-- 왜 (세션66 계약 C4 · 설계 §11-B-4):
--   025 가 격리 홈(`nutrition_data_crowd`)과 통합 뷰를 만들었지만,
--   **이미 `nutrition_data` 안에 들어가 있는 제보 행**은 그대로다.
--   그 행들이 남아 있는 한 「공공 테이블에 제보가 섞여 있다」가 계속 참이고,
--   `U65-6`(공공데이터 보호 1회용) 이 구조적으로 닫히지 않는다.
--
-- 무엇을 (넷):
--   1) `nutrition_data` 의 `data_source='ocr_crowdsource'` 행을 `nutrition_data_crowd` 로 «옮긴다»
--   2) 옮겨진 것만 원본에서 지운다
--   3) 그 제품들의 제보를 `contribution_review` 에 `candidate` 로 올린다 (`DS-2`)
--   4) ★ `nutrition_data` 에 CHECK 를 걸어 **제보가 다시 못 들어오게 한다**
--
-- ★ 이것은 `DS-2` 의 「공식 테이블에서 빼내지 않는다」를 어기는 것이 «아니다».
--   뷰가 여전히 통합해서 내보내므로 **화면이 완전히 같다.**
--   `DS-2` 가 막은 것은 「사용자에게 보이던 값이 사라지는 것」이고, 그것은 일어나지 않는다.
--
-- ★ `'as_stored'` 는 **「원본이 무엇이었는지 모른다」는 정직한 표시**다.
--   ⛔ 추정해서 `'per_100g'` 이라고 적지 말 것. 이관은 «환산이 아니다» — 값을 한 자리도 안 바꿨고,
--     원본 `nutrition_data` 의 기준을 그대로 승계한다. 그래서 `convert_factor = 1.0` 이다.
--   근거 없는 기준 표기는 신호등 색으로 곧장 넘어간다
--   (`IP/basis_unknown_decision_2026-07-30.md` 가 여러 세션 싸운 그 축).
--
-- ⚠⚠ **멱등해야 한다.** `real-postgres` job 이 `npm run migrate` 를 **2회** 돌린다.
--   2회차에서 죽으면 CI 가 빨강이다.
--   · 묶음 1 — `ON CONFLICT (product_id) DO NOTHING`
--   · 묶음 2 — 2회차엔 잡을 행이 0개다(1회차가 지웠다)
--   · 묶음 3 — `ON CONFLICT` 를 쓸 수 없다(적절한 UNIQUE 가 없다) ⇒ **`NOT EXISTS` 가드**로 막는다
--   · 묶음 4 — `ADD CONSTRAINT` 는 `IF NOT EXISTS` 를 못 쓴다 ⇒ `pg_constraint` 조회 + 예외 처리
--
-- ⚠ 실측상 기존 제보 행은 전부 「제보로 «생성된» 제품」이라 대응하는 공공 행이 없다
--   ⇒ 이관 시 통합 충돌이 발생하지 않는다.
--
-- 선행: **반드시 025 뒤.** `nutrition_data_crowd` · `contribution_review` 가 있어야 한다.
--
-- ⛔ `npm run migrate` 체인에 이어 붙였는지 확인할 것. `package.json` `_note:migrate2`.
-- ============================================================

BEGIN;

-- ── 묶음 1) 기존 제보 영양 행을 crowd 테이블로 «이관» ─────────
INSERT INTO nutrition_data_crowd (
  product_id, calories, total_fat, saturated_fat, trans_fat, cholesterol,
  sodium, total_carbs, total_sugars, added_sugars, dietary_fiber, protein,
  calcium, iron, vitamin_d, potassium, serving_size, ocr_confidence, verified_at,
  basis_original, basis_stored, convert_factor, convert_note, applied_by
)
SELECT
  nd.product_id, nd.calories, nd.total_fat, nd.saturated_fat, nd.trans_fat, nd.cholesterol,
  nd.sodium, nd.total_carbs, nd.total_sugars, nd.added_sugars, nd.dietary_fiber, nd.protein,
  nd.calcium, nd.iron, nd.vitamin_d, nd.potassium, nd.serving_size, nd.ocr_confidence, nd.verified_at,
  'as_stored', 'as_stored', 1.0,
  '026 이관 — 값을 바꾸지 않았다. 원본 nutrition_data 의 기준을 그대로 승계한다.',
  'migration_026'
FROM nutrition_data nd
WHERE nd.data_source = 'ocr_crowdsource'
ON CONFLICT (product_id) DO NOTHING;


-- ── 묶음 2) 원본 삭제 (이관이 끝난 것만) ─────────────────────
-- ⚠ EXISTS 가드가 「이관됐다」를 확인한 행만 지운다. 이관이 실패한 행은 남는다 —
--   그 경우 묶음 4 의 CHECK 가 «실패해서» 마이그레이션 전체가 멈춘다. 그것이 맞다.
--   조용히 넘어가면 제보 행이 공공 테이블에 남은 채 「분리했다」고 착각하게 된다.
DELETE FROM nutrition_data nd
 WHERE nd.data_source = 'ocr_crowdsource'
   AND EXISTS (SELECT 1 FROM nutrition_data_crowd c WHERE c.product_id = nd.product_id);


-- ── 묶음 3) contribution_review 에 candidate 적재 (`DS-2`) ───
-- ⚠ 계약이 「담당 에이전트가 contributions 실물을 보고 확정한다」고 남겨둔 부분이다.
--   확정한 것과 근거:
--   · 대상 판별 기준을 **`nutrition_data_crowd.applied_by = 'migration_026'`** 으로 잡았다.
--     묶음 2 가 원본을 이미 지웠으므로 「이관 대상」을 `nutrition_data` 로는 더 이상 알 수 없다.
--     2회차 실행에서도 이 집합은 «같다» ⇒ 멱등의 근거가 여기에 있다.
--   · `contributions.contribution_type` 은 CHECK 없는 VARCHAR 다. 영양 제보의 실제 어휘는
--     `'ocr_nutrition'` 하나이고(`crowdsourceService` 가 쓰고 `adminRoutes`·`mergeService` 가 읽는다),
--     `'new_product'`·`'verify'` 는 **제품 행의 수명주기 축**이라 `axis='nutrition'` 이 아니다.
--   · `status='pending'` 만 올린다. 이미 처리된 제보를 큐에 되살리지 않는다.
--   · `product_id IS NOT NULL` — 스키마는 NULL 을 허용하지만 이관 집합과 조인해야 하므로
--     여기서는 정의상 NULL 이 아니다.
--   · 제품 하나에 제보가 여러 건이면 **제보마다 1행**을 만든다. 큐의 단위가 「제보 × 축」이기 때문이다.
--     `uq_cr_approved_per_product_axis` 는 partial unique(approved 한정)라 candidate 다건을 허용한다 —
--     관리자가 그중 하나를 고르는 것이 검토다.
--   · ⛔ `ON CONFLICT` 를 쓸 수 없다(적절한 UNIQUE 가 없다) ⇒ **NOT EXISTS 가드가 멱등의 전부다.**
--     축까지 함께 보는 이유: 나중에 같은 제보의 다른 축(ingredients 등)이 올라와도 서로 안 지운다.
INSERT INTO contribution_review (contribution_id, product_id, axis, status, evidence)
SELECT
  c.contribution_id,
  c.product_id,
  'nutrition',
  'candidate',
  jsonb_build_object(
    'origin', 'migration_026',
    'note', '026 이관 시점에 존재하던 제보. 값은 이미 nutrition_data_crowd 에 있고(DS-2: 빼내지 않는다), '
            || '이 행은 「아직 사람이 검토하지 않았다」는 사실만 표시한다.'
  )
FROM contributions c
JOIN nutrition_data_crowd ndc
  ON ndc.product_id = c.product_id
 AND ndc.applied_by = 'migration_026'
WHERE c.contribution_type = 'ocr_nutrition'
  AND c.status = 'pending'
  AND c.product_id IS NOT NULL
  AND NOT EXISTS (
        SELECT 1 FROM contribution_review cr
         WHERE cr.contribution_id = c.contribution_id
           AND cr.axis = 'nutrition'
      );


-- ── 묶음 4) ★ 분리를 DB 가 강제한다 ──────────────────────────
-- ⚠ `ADD CONSTRAINT` 는 `IF NOT EXISTS` 를 못 쓴다 ⇒ `000_baseline.sql` §3-4 의
--   `DO $...$ ... IF NOT EXISTS (SELECT 1 FROM pg_constraint ...) ...` 패턴을 그대로 쓴다.
--   경합까지 대비해 `duplicate_object` 예외도 삼킨다(2회 실행에서 죽지 않게).
-- ★ 이것이 `DS-7` 을 **DB 가** 강제하게 만든다. `imp_match_accept_human_chk` ·
--   `cr_approve_human_chk`(024) 와 같은 장치다 — 코드 버그로도 되돌아갈 수 없다.
-- ⚠ `data_source` 는 ENUM(`data_source_type`)이다. 리터럴은 그 타입으로 강제 변환된다.
-- ⚠ NULL 을 허용한다 — `data_source` 는 NOT NULL 이 아니고, NULL 은 「제보다」가 아니다.
DO $m026$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'nutrition_data_no_crowd_chk'
                    AND conrelid = 'nutrition_data'::regclass) THEN
    ALTER TABLE nutrition_data
      ADD CONSTRAINT nutrition_data_no_crowd_chk
      CHECK (data_source IS NULL OR data_source <> 'ocr_crowdsource');
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$m026$;


-- ── 묶음 5) 주석 ─────────────────────────────────────────────
COMMENT ON CONSTRAINT nutrition_data_no_crowd_chk ON nutrition_data IS
  '★ DS-7 물리 분리를 DB 가 강제한다. 026(2026-08-30 세션66 C4). '
  'nutrition_data 는 공공 전용이다 — 승인된 제보는 nutrition_data_crowd 로 간다. '
  '이 제약이 붙은 뒤엔 adminRoutes 의 DELETE ... data_source=ocr_crowdsource 가 잡을 행이 애초에 0개다(U65-7 소멸).';

COMMIT;


-- ── 검증 (실행 후 이 SELECT 들로 확인) ───────────────────────
-- 기대 1: 0행 — 공공 테이블에 제보가 하나도 안 남았다.
SELECT count(*) AS leftover_crowd_rows_in_nutrition_data
  FROM nutrition_data WHERE data_source = 'ocr_crowdsource';

-- 기대 2: 이관된 행 수. 전부 basis_stored='as_stored' · convert_factor=1.0 이다.
SELECT count(*) AS migrated, count(*) FILTER (WHERE basis_stored = 'as_stored') AS as_stored
  FROM nutrition_data_crowd WHERE applied_by = 'migration_026';

-- 기대 3: CHECK 가 실제로 살아 있는가 (1행)
SELECT conname, pg_get_constraintdef(oid) AS def
  FROM pg_constraint
 WHERE conname = 'nutrition_data_no_crowd_chk';


-- ── 롤백 ─────────────────────────────────────────────────────
--  ALTER TABLE nutrition_data DROP CONSTRAINT IF EXISTS nutrition_data_no_crowd_chk;
--  -- 그 다음에야 이관된 행을 nutrition_data 로 되돌릴 수 있다(applied_by='migration_026' 기준).
--  -- ⚠ contribution_review 의 candidate 행은 지우지 말 것 — 검토 이력이다.
