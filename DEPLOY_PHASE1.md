# Phase 1 배포 가이드

## STEP 1 — ADMIN_TOKEN 만들기

PowerShell에서 실행 (또는 그냥 외우기 어려운 긴 문자열 아무거나):

```
[guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
```

→ 출력된 64자 문자열을 안전한 곳에 저장.

---

## STEP 2 — Railway에 환경변수 추가

1. https://railway.app 로그인
2. `meokseon-server` 프로젝트 → 좌측 **Variables** 탭
3. **+ New Variable**
4. Name: `ADMIN_TOKEN`
5. Value: STEP 1 의 문자열
6. **Add** → 자동 재배포

---

## STEP 3 — DB 마이그레이션 실행

Railway 대시보드 → **Postgres 서비스** → **Data** 탭 → 우측상단 **Query** 버튼

아래 SQL 통째로 붙여넣고 **Run**:

```sql
ALTER TABLE contributions
  ADD COLUMN IF NOT EXISTS data       JSONB,
  ADD COLUMN IF NOT EXISTS status     VARCHAR(20) DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS device_id  VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_contributions_product ON contributions(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contributions_device ON contributions(device_id, product_id);
CREATE INDEX IF NOT EXISTS idx_contributions_status ON contributions(status);

CREATE TABLE IF NOT EXISTS product_allergens (
  id              BIGSERIAL PRIMARY KEY,
  product_id      BIGINT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  allergen_name   VARCHAR(50) NOT NULL,
  source_count    INT DEFAULT 1,
  status          VARCHAR(20) DEFAULT 'candidate',
  detected_via    VARCHAR(30),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_allergens_product ON product_allergens(product_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_allergens_unique
  ON product_allergens(product_id, allergen_name);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS merged_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS merge_sources_count  INT DEFAULT 0;
```

---

## STEP 4 — 코드 푸시

PowerShell:

```
cd /d "D:\AI MeokSeon\meokseon-server"
git add src/services/mergeService.js src/services/crowdsourceService.js src/routes/adminRoutes.js scripts/migrations/005_crowdsource_merge.sql tests/mergeService.test.js
git commit -m "feat(crowdsource): merge 서비스 + admin Bearer 인증"
git push
```

Railway 자동 배포 1~2분 대기.

---

## STEP 5 — 검증

`<TOKEN>` 자리에 STEP 1 의 토큰 넣어. PowerShell에서:

```
curl.exe https://meokseon-server-production.up.railway.app/api/admin/dashboard
```
→ 401 응답 ("관리자 인증이 필요합니다") 기대.

```
curl.exe -H "Authorization: Bearer <TOKEN>" https://meokseon-server-production.up.railway.app/api/admin/dashboard
```
→ JSON `{"success":true, "data": {...}}` 응답 기대.

```
curl.exe -H "Authorization: Bearer <TOKEN>" "https://meokseon-server-production.up.railway.app/api/admin/pending?limit=10"
```
→ 미검증 제품 목록. product_id 몇 개 메모.

```
curl.exe -H "Authorization: Bearer <TOKEN>" https://meokseon-server-production.up.railway.app/api/admin/preview-merge/<product_id>
```
→ merge dry-run 결과.
