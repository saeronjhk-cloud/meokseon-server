/**
 * allergenUpsert.js — 공적 출처(HACCP/식약처) 알레르겐 UPSERT SQL 조립.
 *
 * ── 왜 있는가 (세션47 3차 검증 🟠중대2 — 경고 소실) ──────────────────────────
 * `19-apply-haccp.js` · `26-apply-haccp-dump.js` 는
 *     INSERT INTO product_allergens (product_id, allergen_name, detected_via)
 *     VALUES ($1,$2,'haccp_api') ON CONFLICT DO NOTHING
 * 이었다. UNIQUE `(product_id, allergen_name)` 이 이미 있으면 **아무것도 쓰지 않는다.**
 *
 * 그래서 크라우드 merge 행이 먼저 있으면 `detected_via` 가 `'crowdsource_merge'` 로 **남는다.**
 * 그 다음 merge 가 실행하는
 *     DELETE FROM product_allergens
 *      WHERE product_id=$1 AND status!='admin_verified' AND detected_via='crowdsource_merge'
 * (`src/services/mergeService.js:515` 부근)이 **식약처 확인 알레르겐을 통째로 지운다.**
 * pglite 실측: 크라우드 merge → HACCP 재적재 → 알레르겐 0건 merge 순서에서 7행 → 0행.
 *
 * → 공적 출처가 크라우드 출처를 **승격(promote)** 하도록 `DO UPDATE` 로 바꾼다.
 *   승격된 행은 `detected_via='haccp_api'` 라 위 DELETE 의 사정권 밖이다.
 *
 * ── 왜 컬럼을 introspect 하는가 ───────────────────────────────────────────
 * 두 스크립트는 이미 `information_schema.columns` 로 스키마를 훑고
 * `detected_via` 부재 폴백 경로를 갖고 있다(운영과 마이그레이션 파일이 어긋나 있다 — 인수인계 §5).
 * 없는 컬럼을 SET 하면 트랜잭션이 통째로 롤백되므로 **있는 것만** 넣는다.
 *   · `updated_at` 은 운영 스키마에 실재한다 (IP/production_schema_2026-07-31.txt:136,
 *     `updated_at timestamp with time zone DEFAULT now()`).
 *   · `evidence_level` 은 **건드리지 않는다.** HACCP `allergy` 필드는 직접 함유와 혼입을
 *     구분하지 않는 자유 서술문이라, 여기서 등급을 정하면 틀린 등급을 공적 출처 이름으로
 *     확정하게 된다. 등급 보정은 `scripts/76-normalize-allergen-names.js` 가 문장을 보고 한다.
 */
'use strict';

/**
 * @param {string[]} colNames `product_allergens` 의 실제 컬럼 목록
 * @returns {string} `$1=product_id, $2=allergen_name` 을 받는 SQL
 */
function buildAllergenUpsert(colNames) {
  const has = (c) => Array.isArray(colNames) && colNames.includes(c);
  const hasVia = has('detected_via');
  const hasUpdatedAt = has('updated_at');

  const cols = ['product_id', 'allergen_name'];
  const vals = ['$1', '$2'];
  if (hasVia) { cols.push('detected_via'); vals.push(`'haccp_api'`); }

  const sets = [];
  if (hasVia) sets.push(`detected_via = 'haccp_api'`);
  if (hasUpdatedAt) sets.push('updated_at = NOW()');

  const head = `INSERT INTO product_allergens (${cols.join(', ')}) VALUES (${vals.join(',')})`;

  // SET 할 것이 하나도 없으면(두 컬럼 다 부재) DO UPDATE 를 쓸 수 없다 — 그때만 DO NOTHING.
  if (!sets.length) return `${head} ON CONFLICT (product_id, allergen_name) DO NOTHING`;

  return `${head}
     ON CONFLICT (product_id, allergen_name) DO UPDATE SET ${sets.join(', ')}`;
}

module.exports = { buildAllergenUpsert };
