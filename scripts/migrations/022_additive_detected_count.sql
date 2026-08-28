-- ============================================================
-- 022: `U65-2` 「불러오지 못한 N종」 — products.additive_detected_count
-- ============================================================
-- 왜 (세션65 계약 C2-a · 근거 `.tmp/s65/U64-3_재측정_판정.md` §4):
--   조회 응답의 `risk_summary.total` 은 **「저장된 것의 개수」**다.
--   그래서 서버는 「원래 몇 개였는지」를 **모른다**. 앱의
--   `Math.max(serverTotal, items.length)` 는 그 값으로는 구조적으로 항상 0 이 되고,
--   `AdditiveList.tsx` 의 「N종은 상세 정보를 불러오지 못했어요」는
--   **한 번도 뜬 적이 없다.**
--
--   실측: 라벨에서 검출된 189종 중 125종(66.1%)이 저장 단계에서 사라지는데,
--   화면은 **저장된 것이 전부인 것처럼** 보인다. 사라진 사실이 어디에도 안 남는다.
--
-- 무엇을:
--   products 에 `additive_detected_count`(INTEGER) 추가.
--   뜻 = **제보 당시 라벨에서 «검출»된 첨가물 총 개수(마스터 조인 «전»).**
--   ★ 모르면 NULL 이다. 0 과 NULL 은 **다른 뜻**이다 —
--     0 = 「검출해 봤고 하나도 없었다」 · NULL = 「검출 결과 자체를 모른다」.
--     이 구분이 무너지면 `risk_summary.unlisted` 가 거짓말을 한다.
--
-- 회귀 없음:
--   기존 229,028행은 전부 NULL 이다. `productService` 가 NULL 을 `unlisted = 0` 으로
--   내리므로 **화면이 지금과 완전히 같다**(계약 C2-b).
--
-- 적용 순서 (반드시 지킬 것):
--   1) 이 SQL 을 먼저 적용한다 (`npm run migrate` 체인에 이어 붙어 있다)
--   2) 그 «다음»에 서버 코드를 배포한다
--   ★ 순서를 바꿔도 죽지는 않는다 — `productModel.hasAdditiveDetectedCountColumn()` 이
--     컬럼 부재를 1회 판정해 읽기·쓰기 양쪽에서 이 컬럼을 통째로 건너뛴다
--     (세션45 치명1 · 020 배포순서 사고와 같은 방어). 그래도 순서를 지키는 쪽이 맞다.
--
-- ⛔ `npm run migrate` 체인에 이어 붙였는지 확인할 것. `package.json` `_note:migrate2`.
--   세션64c 가 파일만 만들고 체인에 안 이어서 CI gate #19 를 태웠다.
--   **파일을 만드는 것과 체인에 잇는 것은 다른 일이다.**
-- ============================================================


-- ── 묶음 1) 컬럼 추가 ────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS additive_detected_count INTEGER;


-- ── 묶음 2) 주석 ─────────────────────────────────────────────
COMMENT ON COLUMN products.additive_detected_count IS
  '제보 당시 라벨에서 검출된 첨가물 총 개수(additives 마스터 조인 «전»). 022(2026-08-28). '
  'NULL = 모름(0 과 다른 뜻). risk_summary.unlisted = max(0, 이 값 - 저장·조회된 개수).';


-- ── 검증 (실행 후 이 SELECT 로 확인) ─────────────────────────
-- 기대: 1행 · data_type = integer · is_nullable = YES
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'products'
   AND column_name = 'additive_detected_count';
