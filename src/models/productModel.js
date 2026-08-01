/**
 * 제품(Product) 데이터 모델
 * PostgreSQL 쿼리 레이어
 */

const db = require('../config/database');
const { normalizeSearchQuery, isSearchable } = require('../utils/searchNormalize');
const { normalizeAllergenRows } = require('../services/allergenName');

/**
 * 바코드로 제품 + 영양정보 조회
 * @param {string} barcode
 * @returns {Promise<Object|null>}
 */
async function findByBarcode(barcode) {
  // 영양은 product_nutrition_resolved view 로 결합(식약처/OCR 우선 + OFF(A/B) 보강, ODbL 격리).
  // SOURCE: scripts/migrations/011·012 (#2 OFF 통합). nutrition_data 직접조회 → view 전환(2026-06-28).
  // off_grade/confidence/source_license/basis_confident 는 OFF 출처배지(§11)·신호등 신뢰도용.
  const result = await db.query(
    `SELECT
       p.product_id, p.barcode, p.product_name, p.brand, p.manufacturer,
       p.food_type, p.food_category, p.serving_size, p.total_content,
       p.content_unit, p.data_source, p.image_url,
       p.verification, p.verify_count,
       r.calories, r.total_fat, r.saturated_fat, r.trans_fat,
       r.cholesterol, r.sodium, r.total_carbs, r.total_sugars,
       r.dietary_fiber, r.protein,
       r.resolved_source AS nutrition_source,
       r.serving_size AS nutrition_serving_size,
       r.verified_at,
       r.off_grade, r.confidence, r.source_license, r.basis_confident
     FROM products p
     LEFT JOIN product_nutrition_resolved r ON r.product_id = p.product_id
     WHERE p.barcode = $1
     LIMIT 1`,
    [barcode]
  );
  return result.rows[0] || null;
}

/**
 * 제품 통합 검색 (search_text 정규화 컬럼 기반)
 *
 * Migration 009 의 products.search_text 컬럼을 사용하여
 *   - product_name + manufacturer + brand + food_type 4개 필드 통합 검색
 *   - 띄어쓰기·특수문자·대소문자 변형 흡수
 *   - similarity + verification + verify_count 가중 정렬
 *
 * SOURCE: OneDrive/MeokSeon/IP/search_normalization_v1.md (예정)
 * 트리거: 사용자 검색 미스매치 분석 (Notion §8, 2026-06-21)
 *
 * @param {string} query - 사용자 원본 검색어
 * @param {number} limit - 최대 결과 수
 * @param {number} offset - 오프셋
 * @returns {Promise<Array>}
 */
async function searchByName(query, limit = 20, offset = 0) {
  // 1. 검색어 정규화 (search_text 컬럼과 동일 규칙)
  const qn = normalizeSearchQuery(query);

  // 2. 검색 의미 없는 입력은 빈 결과 (성능 보호)
  if (!isSearchable(qn)) {
    return [];
  }

  // 3. 통합 검색 (v3 — 다중 필드 가중치 + 중복 제거):
  //    - WHERE: search_text 트리그램(%) + ILIKE 부분 매칭 OR 결합
  //    - DEDUP: 같은 (product_name, manufacturer) 의 여러 바코드 → 1건만 노출
  //             (예: "농심감자면" x 8개 바코드 → 1개로 압축)
  //             그룹 내 verification 높은 것 → verify_count 많은 것 → 첫 바코드 선택
  //    - SCORE: 어느 필드에 매칭됐는지 + similarity 합산
  //        product_name  매칭 → +1.0
  //        manufacturer  매칭 → +1.0 (대표 제조사 검색 시 균형)
  //        brand         매칭 → +0.5
  //        food_type     매칭 → +0.3
  //        similarity   * 0.5 (search_text 정규화 텍스트 기반)
  //    - 두 단계 쿼리: 안쪽에서 DISTINCT ON, 바깥쪽에서 score 정렬
  //
  //    NOTE (2026-06-21): "농심" 같이 generic 한 키워드로 검색 시,
  //    product_name 에 키워드가 포함된 제품(농심떡국면 등)이 자연스럽게 상위에 옴.
  //    신라면 등 manufacturer-only 매칭 제품은 결과에는 포함되지만 페이지 아래쪽.
  //    이는 의도된 동작 — 사용자가 "신라면" 같이 구체적으로 검색하면 직접 매칭됨.
  const result = await db.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (lower(p.product_name), lower(COALESCE(p.manufacturer, '')))
         p.product_id, p.barcode, p.product_name, p.brand, p.manufacturer,
         p.food_type, p.food_category, p.serving_size, p.content_unit,
         p.image_url, p.verification, p.verify_count,
         (
           CASE WHEN COALESCE(p.product_name,  '') ILIKE '%' || $1 || '%' THEN 1.0 ELSE 0 END
         + CASE WHEN COALESCE(p.manufacturer,  '') ILIKE '%' || $1 || '%' THEN 1.0 ELSE 0 END
         + CASE WHEN COALESCE(p.brand,         '') ILIKE '%' || $1 || '%' THEN 0.5 ELSE 0 END
         + CASE WHEN COALESCE(p.food_type,     '') ILIKE '%' || $1 || '%' THEN 0.3 ELSE 0 END
         + similarity(p.search_text, $1) * 0.5
         ) AS score
       FROM products p
       WHERE p.is_active = TRUE
         AND (
           p.search_text % $1
           OR p.search_text ILIKE '%' || $1 || '%'
         )
       ORDER BY
         lower(p.product_name),
         lower(COALESCE(p.manufacturer, '')),
         CASE p.verification
           WHEN 'admin_verified' THEN 4
           WHEN 'verified'       THEN 3
           WHEN 'partial'        THEN 2
           ELSE 1
         END DESC,
         COALESCE(p.verify_count, 0) DESC,
         p.product_id
     ) sub
     ORDER BY score DESC, product_name
     LIMIT $2 OFFSET $3`,
    [qn, limit, offset]
  );
  return result.rows;
}

/**
 * 제품 ID로 영양정보 조회
 * @param {number} productId
 * @returns {Promise<Object|null>}
 */
async function getNutrition(productId) {
  const result = await db.query(
    `SELECT * FROM nutrition_data WHERE product_id = $1 LIMIT 1`,
    [productId]
  );
  return result.rows[0] || null;
}

/**
 * 제품 ID로 첨가물 목록 + 위해성 조회
 * @param {number} productId
 * @returns {Promise<Array>}
 */
async function getAdditives(productId) {
  // MFRAS v2.0 컬럼까지 모두 SELECT.
  // SOURCE: OneDrive/MeokSeon/IP/MFRAS_v2.0_dictionary_spec.md
  const result = await db.query(
    `SELECT
       a.additive_id, a.name_ko, a.name_en, a.e_number, a.ins_no,
       a.category, a.description, a.max_daily_intake,
       -- v1 (호환용)
       a.risk_grade, a.risk_color,
       -- v2 MFRAS (5차원·4색)
       a.mfras_total, a.mfras_grade,
       a.dim_a_toxicity, a.dim_b_exposure, a.dim_c_genotox,
       a.dim_d_regulation, a.dim_e_data_quality,
       a.iarc_group, a.adi_value, a.adi_type, a.edi,
       a.genotox_status, a.regulatory_status, a.last_eval_year,
       a.purposes, a.usage_type, a.mfras_rationales,
       pa.amount, pa.unit
     FROM product_additives pa
     JOIN additives a ON pa.additive_id = a.additive_id
     WHERE pa.product_id = $1
     ORDER BY COALESCE(a.mfras_total, 0) DESC, a.risk_grade DESC NULLS LAST, a.name_ko`,
    [productId]
  );
  return result.rows;
}

/**
 * 제품 ID로 알레르기 목록 조회 (세션45 신규 · 마이그레이션 020)
 *
 * ★★ 왜 이 함수가 이제야 생기나 —
 *   `GET /api/products/:barcode` 응답에는 **알레르기가 아예 없었다.**
 *   세션44 인수인계 §6-2 는 「바코드 조회 사용자가 혼입/직접 함유 **구분**을 받지 못한다」고 적었지만,
 *   실제로는 구분이 아니라 **알레르기 정보 자체가 전달되지 않고 있었다.**
 *   대두 알레르기 사용자가 바코드를 찍으면 아무 경고도 받지 못한다. 등급 분리보다 앞서는 결함이다.
 *
 * ★ 정렬: 직접 함유를 먼저 낸다. 응답 배열 순서가 곧 화면 순서인 클라이언트가 있을 때,
 *   혼입 가능이 위에 오면 사용자가 가장 중요한 정보를 나중에 본다.
 *
 * @param {number} productId
 * @returns {Promise<Array<{allergen_name, evidence_level, status, source_count, detected_via}>>}
 */
// ★★★ 세션45 1차 검증 치명1 — 마이그레이션 020 이 아직 안 돈 DB 에서
//   `evidence_level` 을 SELECT 하면 쿼리가 예외를 던지고, 그 예외가
//   `getProductWithTrafficLight` → `productRoutes` 를 통과해 **500** 이 된다.
//   알레르기만 빠지는 게 아니라 **영양·신호등·제품 메타까지 응답 전체가 사라진다.**
//
//   실재하는 시나리오다 — Railway 는 `node src/server.js` 로만 뜨고 부팅 시
//   마이그레이션을 돌리지 않는다(`grep -rn "migrat" src/` 0건). 020 은 수동
//   `npm run migrate:020` 뿐이다. 즉 **코드가 먼저 배포되고 마이그레이션이 나중**일 수 있다.
//   healthcheck 는 `/api/health` 라서 배포는 정상으로 표시되고 제품 조회만 조용히 전멸한다.
//
//   → 컬럼 유무를 1회 판정해 캐싱하고, 없으면 리터럴로 대체한다.
//     ★ 대체값은 `contains` 다. 020 이전 행의 의미가 그것이고(005 이후 등급 개념이 없었다),
//       모르는 것을 약하게 만드는 방향의 기본값은 이 도메인에서 안전하지 않다.
//
// ★★ 세션46 2차 검증 중대2 — 세션45 판은 **실패를 영구 캐싱**했다.
//   `catch` 가 `_hasEvidenceLevel = false` 로 확정하는데, 무효화 경로가 없었다.
//   실측(pglite + 커넥션 1회 강제 종료): 020 이 정상 적용된 DB 에서도
//   첫 조회 순간 `Connection terminated unexpectedly` 가 한 번 나면
//   **프로세스가 죽을 때까지** 모든 알레르기가 `contains` 로 나갔다.
//   → 혼입 가능이 「직접 함유」로 표시된다(**과잉경고**). 3분리 기능 전체가 무력화되고
//     `orderExpr` 이 빈 문자열이 되어 「직접 함유 먼저」 정렬 계약도 함께 깨진다.
//   Railway 콜드 스타트·풀 고갈에서 흔한 형태다. 040 초 뒤 DB 가 멀쩡해져도 회복되지 않았다.
//
//   → **성공만 캐싱한다.** 실패는 `null` 로 두어 다음 요청에 다시 판정한다.
//     한 요청이 조금 느려지는 것과, 프로세스 수명 내내 등급이 틀리는 것은 심각도가 다르다.
//   → 그리고 캐시가 `true` 인데 컬럼이 사라진 경우(020 롤백)도 본 쿼리에서 `42703` 을 잡아
//     캐시를 버리고 1회 재시도한다. 단방향 캐시는 어느 쪽으로든 굳으면 방어가 없다.
let _hasEvidenceLevel = null;   // null=미확인/재판정필요 · true/false=확인됨

// ★★ 세션47 3차 검증 경미1 — **측정했고, 고치지 않기로 했다.** (판단 근거를 남긴다)
//   실측: 판정이 계속 실패하면 `information_schema` 조회가 **요청마다 1회** 추가된다
//   (getAllergens 200회 → 조회 200회 · 89ms). 바코드 조회는 앱에서 가장 뜨거운 경로다.
//   TTL 음성 캐시(예: 5초)로 줄일 수 있지만, 그러면 **5초간 등급이 틀린 채로 나간다**
//   (혼입 가능이 「직접 함유」로 = 과잉경고, 그리고 정렬 계약도 함께 깨진다).
//   → 거래가 맞지 않는다. ① 이 조회가 실패하는 상태는 본 쿼리도 위태로운 **이미 degraded**
//     상태이고, ② 알레르기 앱에서 「잠깐이라도 틀린 등급」은 「잠깐 느린 것」보다 비싸다.
//   세션46 의 **「성공만 캐싱한다」가 정본**이다. 바꾸려면 이 주석부터 반박할 것.
const UNDEFINED_COLUMN = '42703';   // Postgres: column does not exist

async function hasEvidenceLevelColumn() {
  if (_hasEvidenceLevel !== null) return _hasEvidenceLevel;
  try {
    const r = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'product_allergens' AND column_name = 'evidence_level'
       LIMIT 1`,
    );
    _hasEvidenceLevel = r.rows.length > 0;   // ★ 성공했을 때만 캐싱한다
    return _hasEvidenceLevel;
  } catch (_) {
    // ★ 캐싱하지 않는다. 이번 요청만 보수적으로 "없다" 로 본다.
    //   여기서 true 를 반환하면 본 쿼리가 500 을 낸다 — 치명1 이 그대로 재현된다.
    //   ★ 실패도 캐싱하지 않는다 — 위 경미1 주석의 판단 근거를 볼 것.
    return false;
  }
}

/** 테스트에서 캐시를 비운다(마이그레이션 전/후를 한 프로세스에서 검사하기 위함). */
function _resetEvidenceLevelCache() { _hasEvidenceLevel = null; }

function buildAllergenQuery(hasLevel) {
  const levelExpr = hasLevel ? 'evidence_level' : `'contains'::text AS evidence_level`;
  const orderExpr = hasLevel
    ? `CASE evidence_level
         WHEN 'contains' THEN 1
         WHEN 'inferred' THEN 2
         WHEN 'may_contain' THEN 3
         ELSE 4
       END,`
    : '';
  return `SELECT allergen_name, ${levelExpr}, status, source_count, detected_via
     FROM product_allergens
     WHERE product_id = $1
     ORDER BY ${orderExpr}
              source_count DESC,
              allergen_name`;
}

// ★★★ 세션47 — 노출 경로 알레르겐 이름 정규화.
//   `product_allergens.allergen_name` 에는 HACCP `parseAllergy` 가 만든 **문장 조각**이 섞여 있다.
//   실측(2026-07-31, parseAllergy 를 import 해 실제 덤프에 실행): 적재 5,649행 중
//   **705행(12.5%)·distinct 87종**이 19종 정본이 아니다. 운영 응답에서도 확인됐다:
//     GET /api/products/8801005013130 → allergens_v2.contains = ["대두", "밀(성분)"]
//   → 사용자 화면에 「직접 함유: 밀(성분)」으로 나간다.
//
//   ★ 왜 여기(model)인가 — 노출 계약을 만드는 `buildAllergens` 는 `productService.js` 에 있지만
//     이 세션에서 그 파일은 편집 금지였다. `getAllergens` 는 `buildAllergens` 의 **유일한 입력원**
//     (`grep -rn getAllergens src/` → productService.js:267 1곳)이므로 여기서 걸러도 노출 결과는 같다.
//     ⚠ 다만 `collected` 판정이 `rows.length > 0` 이라 **여기서 거르면 collected 도 함께 내려간다.**
//        판정 근거는 인수인계 §회귀보고에 적었다. 이 위치를 옮길 때 반드시 함께 볼 것.
function normalizeRows(rows) {
  return normalizeAllergenRows(rows);
}

async function getAllergens(productId) {
  const hasLevel = await hasEvidenceLevelColumn();
  try {
    const result = await db.query(buildAllergenQuery(hasLevel), [productId]);
    return normalizeRows(result.rows);
  } catch (e) {
    // ★ 세션46 중대2-(c) — 캐시가 true 인데 컬럼이 사라진 경우(020 롤백).
    //   단방향 캐시라 방어가 없었고, 그대로 던지면 응답 전체가 500 이 된다(치명1 재발).
    //   컬럼 부재(42703)일 때만 캐시를 버리고 등급 없이 1회 재시도한다.
    if (hasLevel && e && e.code === UNDEFINED_COLUMN) {
      _hasEvidenceLevel = null;
      const result = await db.query(buildAllergenQuery(false), [productId]);
      return normalizeRows(result.rows);
    }
    throw e;
  }
}

/** 정규화 전 원본 행 (관리자·백필·감사용). 노출 경로에서는 쓰지 말 것. */
async function getAllergensRaw(productId) {
  const hasLevel = await hasEvidenceLevelColumn();
  const result = await db.query(buildAllergenQuery(hasLevel), [productId]);
  return result.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// ⛔ 아래 두 함수(`getTrafficLight` / `upsertTrafficLight`)는 **사용하지 말 것.**
//
// ★★★ 세션47 조사 결론 — 운영 `nutrition_traffic_light` 가 0행인 이유는
//   「쓰는 코드가 저장소 어디에서도 호출되지 않기 때문」이다(호출부 0곳, 시퀀스 미사용).
//   버그가 아니라 **완성된 채로 배선되지 않은 캐시**다. 그래서 위험하다 —
//   다음 세션의 누군가가 "캐시가 있는데 왜 안 쓰지?" 하고 한 줄 연결하면 아래가 전부 터진다.
//
//   ① 이익이 0이다. 신호등 계산은 **5.8 마이크로초**짜리 순수 CPU 연산으로 요청의 0.09% 다.
//      반면 캐시 SELECT 는 0.29ms — **재계산보다 50배 비싸다.** 쿼리도 3→4개로 는다.
//      진짜 병목은 `product_nutrition_resolved` 4-way 뷰 조인(62%)이고 캐시로는 못 없앤다.
//   ② 무효화가 없다. 신호등 입력을 바꾸는 코드가 20곳(merge·크라우드·관리자 정정·배치)인데
//      **아무도 이 캐시를 건드리지 않는다.** 채우는 순간부터 적/황/녹이 영원히 옛 값이다.
//   ③ 판정 규칙 버전 컬럼이 없다. 기준은 v1.0→v1.4 로 계속 바뀌어 왔는데(세션39·42·45),
//      배포로 기준이 바뀌면 전 행이 조용히 stale 이 되고 **그것을 탐지할 수단이 스키마에 없다.**
//   ④ 왕복에서 정보가 손실된다. `evaluateNutrition` 의 `is_excluded`·`exclude_reason`·
//      `sanity_warnings`·`per_100`·`is_withheld` 를 저장할 컬럼이 없다.
//      주류(`is_excluded`)를 캐시에 넣으면 모든 색이 NULL 로 저장돼
//      **「평가 제외」와 「영양 데이터 없음」이 구분 불가**가 된다.
//
//   → **틀린 캐시는 없는 캐시보다 나쁘다.** 실시간 계산이 정본이다.
//     제거 여부는 제이 결정 사항으로 인수인계에 올려 두었다(세션47 §4).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⛔ 미사용 — 위 블록 참조. 조회 경로는 `productService.getProductWithTrafficLight` 가
 *    매번 실시간 계산한다(캐시 조회 자체를 하지 않는다).
 * @param {number} productId
 * @returns {Promise<Object|null>}
 */
async function getTrafficLight(productId) {
  const result = await db.query(
    `SELECT * FROM nutrition_traffic_light WHERE product_id = $1 LIMIT 1`,
    [productId]
  );
  return result.rows[0] || null;
}

/**
 * ⛔ 미사용 — 위 `getTrafficLight` 앞 블록 참조. **호출부가 저장소에 0곳이다.**
 *    연결하기 전에 무효화·규칙버전·손실 컬럼 4가지를 먼저 해결할 것.
 * @param {number} productId
 * @param {Object} evaluation - 판정 결과 객체
 * @returns {Promise<Object>}
 */
async function upsertTrafficLight(productId, evaluation) {
  const result = await db.query(
    `INSERT INTO nutrition_traffic_light (
       product_id, food_category,
       sodium_color, sodium_pct_dv, sodium_basis,
       sugars_color, sugars_pct_dv, sugars_basis,
       sat_fat_color, sat_fat_pct_dv, sat_fat_basis,
       total_fat_color, total_fat_pct_dv, total_fat_basis,
       cholesterol_color, cholesterol_pct_dv,
       protein_color, protein_pct_dv,
       fiber_color, fiber_pct_dv,
       trans_fat_color,
       is_dried_exception,
       context_messages,
       multi_serving_count,
       evaluated_at
     ) VALUES (
       $1, $2,
       $3, $4, $5,
       $6, $7, $8,
       $9, $10, $11,
       $12, $13, $14,
       $15, $16,
       $17, $18,
       $19, $20,
       $21,
       $22,
       $23,
       $24,
       NOW()
     )
     ON CONFLICT (product_id) DO UPDATE SET
       food_category = EXCLUDED.food_category,
       sodium_color = EXCLUDED.sodium_color,
       sodium_pct_dv = EXCLUDED.sodium_pct_dv,
       sodium_basis = EXCLUDED.sodium_basis,
       sugars_color = EXCLUDED.sugars_color,
       sugars_pct_dv = EXCLUDED.sugars_pct_dv,
       sugars_basis = EXCLUDED.sugars_basis,
       sat_fat_color = EXCLUDED.sat_fat_color,
       sat_fat_pct_dv = EXCLUDED.sat_fat_pct_dv,
       sat_fat_basis = EXCLUDED.sat_fat_basis,
       total_fat_color = EXCLUDED.total_fat_color,
       total_fat_pct_dv = EXCLUDED.total_fat_pct_dv,
       total_fat_basis = EXCLUDED.total_fat_basis,
       cholesterol_color = EXCLUDED.cholesterol_color,
       cholesterol_pct_dv = EXCLUDED.cholesterol_pct_dv,
       protein_color = EXCLUDED.protein_color,
       protein_pct_dv = EXCLUDED.protein_pct_dv,
       fiber_color = EXCLUDED.fiber_color,
       fiber_pct_dv = EXCLUDED.fiber_pct_dv,
       trans_fat_color = EXCLUDED.trans_fat_color,
       is_dried_exception = EXCLUDED.is_dried_exception,
       context_messages = EXCLUDED.context_messages,
       multi_serving_count = EXCLUDED.multi_serving_count,
       evaluated_at = NOW()
     RETURNING *`,
    [
      productId,
      evaluation.food_category,
      evaluation.nutrients.sodium?.color,
      evaluation.nutrients.sodium?.pct_dv,
      evaluation.nutrients.sodium?.basis,
      evaluation.nutrients.sugars?.color,
      evaluation.nutrients.sugars?.pct_dv,
      evaluation.nutrients.sugars?.basis,
      evaluation.nutrients.sat_fat?.color,
      evaluation.nutrients.sat_fat?.pct_dv,
      evaluation.nutrients.sat_fat?.basis,
      evaluation.nutrients.total_fat?.color,
      evaluation.nutrients.total_fat?.pct_dv,
      evaluation.nutrients.total_fat?.basis,
      evaluation.nutrients.cholesterol?.color,
      evaluation.nutrients.cholesterol?.pct_dv,
      evaluation.nutrients.protein?.color,
      evaluation.nutrients.protein?.pct_dv,
      evaluation.nutrients.fiber?.color,
      evaluation.nutrients.fiber?.pct_dv,
      evaluation.nutrients.trans_fat?.color,
      evaluation.is_dried_exception || false,
      JSON.stringify(evaluation.context_messages || []),
      evaluation.multi_serving?.servings_per_container || null,
    ]
  );
  return result.rows[0];
}

/**
 * 최근 등록된 제품 목록
 * @param {number} limit
 * @returns {Promise<Array>}
 */
async function getRecent(limit = 20) {
  const result = await db.query(
    `SELECT product_id, barcode, product_name, manufacturer, food_type, food_category, image_url, created_at
     FROM products
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

module.exports = {
  findByBarcode,
  searchByName,
  getNutrition,
  getAdditives,
  getAllergens,                 // 세션45 (세션47: 이름 정규화 필터 포함)
  getAllergensRaw,              // 세션47 — 정규화 전 원본(감사·백필용)
  hasEvidenceLevelColumn,       // 세션45 — 배포 순서 방어(치명1)
  _resetEvidenceLevelCache,     // 테스트 전용
  getTrafficLight,
  upsertTrafficLight,
  getRecent,
};
