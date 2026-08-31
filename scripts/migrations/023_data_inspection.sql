-- ============================================================
-- 023: `U63-6` 「봤는데 없었다」를 기록하는 자리 — data_inspection
-- ============================================================
-- 왜 (세션66 계약 C1 · 설계 `IP/설계_제보데이터분리_2026-08-28_세션65.md`):
--   지금 이 저장소에는 **「검사했다」는 사실을 적을 곳이 없다.**
--   `product_allergens` 에 행이 없다는 것은 두 가지 «다른» 뜻을 한꺼번에 갖는다 —
--     ① 라벨을 봤고 알레르기 표시가 하나도 없었다
--     ② 아무도 그 라벨을 본 적이 없다
--   앱은 이 둘을 구분할 수 없어서 ②를 ①처럼(=안전한 것처럼) 보여 준다.
--   `U63-6`(알레르기 「네 번째 상태」 부재)이 정확히 그것이다.
--
-- 무엇을:
--   `data_inspection` 신설. **1행 = 「어떤 제품의 어떤 축을, 어떤 출처로, 언제 봤고,
--   그 결과 몇 개를 찾았다」는 관측 기록** 이다.
--
--   ★ `found_count = 0` 이 **「봤는데 없었다」**다.
--   ★ 행이 «없는» 것이 **「안 봤다」**다.
--   이 구분이 `U63-6` 의 전부다. 0 과 「행 없음」을 같은 것으로 뭉개면
--   022 의 `additive_detected_count`(0 vs NULL)에서 겪은 것과 같은 거짓말이 다시 생긴다.
--
--   `scope_note` 는 **「어디까지 봤는가」**다. 예: `'ingredients_text_only'`
--     = 「원재료명만 봤고 알레르기 표시란·혼입 문구는 못 봤다」.
--     ⇒ `found_count = 0` 이어도 그것이 「알레르기가 없다」는 뜻이 아님을 이 칸이 말한다.
--
-- ⚠ `source_kind` 에 CHECK 를 걸지 «않는다».
--   어휘: 'public_c005' | 'public_nutrition' | 'ocr_label' | 'admin_manual'.
--   출처는 앞으로 늘어난다. 늘어날 때마다 마이그레이션을 요구하면 안 된다.
--
-- ⚠ `axis` 는 **ENUM 이 아니라 TEXT + CHECK** 다.
--   ENUM 값 추가(`ALTER TYPE ... ADD VALUE`)는 트랜잭션 블록 제약이 있고 되돌릴 수 없다.
--   이 저장소는 `data_source_type` · `verification_status` 에서 그 함정을 이미 겪었다
--   (`000_baseline.sql` §2 의 `ALTER TYPE ... ADD VALUE IF NOT EXISTS` 세 줄이 그 흉터다).
--
-- 회귀 없음: 순수 신설. 기존 테이블·뷰·행 무접촉.
--
-- ⛔ `npm run migrate` 체인에 이어 붙였는지 확인할 것. `package.json` `_note:migrate2`.
--   **파일을 만드는 것과 체인에 잇는 것은 다른 일이다**(세션64c CI gate #19).
-- ============================================================


-- ── 묶음 1) 테이블 ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS data_inspection (
  inspection_id  BIGSERIAL PRIMARY KEY,
  product_id     BIGINT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  axis           TEXT   NOT NULL,
  source_kind    TEXT   NOT NULL,
  evidence_ref   TEXT,
  found_count    INTEGER,
  scope_note     TEXT,
  inspected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT di_axis_chk CHECK (axis IN ('nutrition','ingredients','allergens','additives'))
);


-- ── 묶음 2) 인덱스 ───────────────────────────────────────────
-- 「이 제품의 이 축을 «마지막»으로 언제 봤나」가 유일한 읽기 패턴이다.
CREATE INDEX IF NOT EXISTS idx_di_product_axis
  ON data_inspection (product_id, axis, inspected_at DESC);


-- ── 묶음 3) 주석 ─────────────────────────────────────────────
COMMENT ON TABLE data_inspection IS
  '「검사했다」는 관측 기록. 023(2026-08-30 세션66 C1). '
  '행이 없다 = 안 봤다 · found_count=0 = 봤는데 없었다. 이 구분이 U63-6 의 전부다.';

COMMENT ON COLUMN data_inspection.found_count IS
  '그 검사에서 찾은 개수. 0 = 「봤는데 없었다」. NULL = 「개수를 세지 않았다」. '
  '행 자체의 부재(=「안 봤다」)와 «다른 뜻»이다.';

COMMENT ON COLUMN data_inspection.scope_note IS
  '어디까지 봤는가. 예 ingredients_text_only = 원재료명만 봤고 알레르기 표시란·혼입 문구는 못 봤다. '
  'found_count=0 이 「없다」를 뜻하는지 「그 범위에서는 없었다」를 뜻하는지 이 칸이 가른다.';

COMMENT ON COLUMN data_inspection.source_kind IS
  'public_c005 | public_nutrition | ocr_label | admin_manual (CHECK 없음 — 출처는 늘어난다).';

COMMENT ON COLUMN data_inspection.evidence_ref IS
  '근거 식별자. 제보 경로면 contributions.contribution_id 를 문자열로 적는다.';


-- ── 검증 (실행 후 이 SELECT 로 확인) ─────────────────────────
-- 기대: 8행 (inspection_id · product_id · axis · source_kind · evidence_ref ·
--            found_count · scope_note · inspected_at)
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'data_inspection'
 ORDER BY ordinal_position;
