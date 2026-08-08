/**
 * OCR API 라우터
 * /api/ocr
 * multer(multipart) + base64 JSON 양쪽 지원
 */

const express = require('express');
const multer = require('multer');
const { callVisionAPI, correctOcrText } = require('../services/ocrService');
const {
  analyzeText, detectNutritionBasis, reconcileAllergens, mergeAllergensV2, flattenAllergensV2,
} = require('../services/ocrParser');
// ★ 세션50 D2 — `sanityCheck` 를 **일부러 import 하지 않는다.** 판정은 엔진 한 곳에서만 한다.
//   (되돌리려면 import 부터 다시 넣어야 하므로, 이 한 줄이 다음 세션에 보내는 신호다)
const { evaluateNutrition } = require('../services/nutritionTrafficLight');
const { getRaccPolicy } = require('../services/raccPolicy');
// ★ 세션48 — 사용자 입력 쓰기 경로 방어. 노출 경로(productModel.getAllergens)와 **같은 정규화기**를 쓴다.
const { normalizeAllergenNames } = require('../services/allergenName');
const { ValidationError } = require('../middleware/errorHandler');
const { saveOcrContribution, reportError } = require('../services/crowdsourceService');

const router = express.Router();

// multer 설정: 메모리 스토리지, 10MB 제한
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new ValidationError('이미지 파일만 업로드 가능합니다.'));
    }
  },
});

// OCR 텍스트 최대 길이 (ReDoS 방어)
const MAX_OCR_TEXT_LENGTH = 10000;

// ============================================================
// ★★ 세션42: 신호등 판정 공통부
// ============================================================
/**
 * 왜 함수로 뽑았나 —
 *   세션39 는 /analyze(L153) 만 basis 를 배선했고 /multi-photo(L309) 를 못 봤다.
 *   **같은 라벨을 읽는 두 번째 경로가 아무 기준 없이 per_serving 으로 판정**되고 있었다.
 *   (세션40 §2-2 와 완전히 같은 유형의 누락이다.)
 *   두 곳에 같은 코드를 복사해 두면 다음 수정 때 또 한 곳만 고친다. 한 곳으로 합친다.
 *
 * per_total 은 이제 신호등이 직접 다룬다(세션42 §1-1 배선 완료).
 *   evaluateNutrition 이 servingResolver 로 1회분 환산하고,
 *   인분 수를 모르면 **판정 보류(is_withheld)** 로 떨어뜨린다.
 *   → 여기서 per_serving 으로 눙치면 안 된다. 그게 032 떡국떡 거짓 빨강의 원인이다.
 */
const BASIS_OK = {
  per_serving: 'per_serving',
  per_100g: 'per_100g',
  per_100ml: 'per_100ml',
  per_total: 'per_total',      // ★ 세션42 신규 — 신호등 배선이 끝나서 열었다
};

/**
 * 사용자가 보낸 알레르기 목록을 배열로 정규화한다.
 *
 * ★★ 세션47 3차 검증 경미4 — 이전에는 `Array.isArray` 만 봤다.
 *   클라이언트가 `"밀,대두"` 처럼 **문자열로** 보내면 조건이 false 라 **통째로 버려졌다.**
 *   그 값이 흘러가는 `data.user_input.allergens` 는 `extractCandidatesFromContribution` 이
 *   한 번도 읽지 않으므로(세션46 §3-4 부수 발견) 회수 경로도 없다 = **과소경고**.
 *   → 문자열은 구분자로 쪼개 배열로 만든다. 조용히 버리지 않는다.
 *   ⚠ 배열이 아니고 문자열도 아니면(객체·숫자 등) 여전히 무시한다 — 의미를 추측할 수 없다.
 */
function coerceUserAllergens(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  if (typeof v === 'string') {
    return splitUserAllergenText(v);
  }
  return [];
}

/**
 * 사용자 자유 입력 문자열을 항목으로 쪼갠다. **괄호 안의 구분자는 경계가 아니다.**
 *
 * ★★ 세션48 외부검증 — 세션47 판은 `v.split(/[,;/·\n]+/)` 였다. 실측 반례:
 *     "조개류(굴,전복,홍합 포함)" → ["조개류(굴", "전복", "홍합 포함)"]
 *   조개류 하나가 **세 개의 쓰레기 행**이 되어 product_allergens 에 들어갔다.
 *   그리고 정규화가 그 셋을 다시 `조개류` 로 모으면서 source_count 를 3배로 부풀린다.
 *   → 괄호 depth 를 추적해 **괄호 밖에서만** 자른다.
 * ★ 구분자 집합은 `ocrParser.ALLERGEN_DELIM` 과 맞췄다. 세션44 가 전각 콤마·읽점·가운뎃점을
 *   빠뜨려 밀을 놓친 사고가 있었는데, 세션47 의 새 경로가 그 교훈을 이월받지 못했다.
 *   ⚠ 괄호는 구분자로 쓰지 않는다 — 위 반례가 그 이유다(ocrParser 와 의도적으로 다르다).
 */
function splitUserAllergenText(s) {
  const out = [];
  let buf = '';
  let depth = 0;
  for (const ch of String(s)) {
    if ('([［（'.includes(ch)) { depth += 1; buf += ch; continue; }
    if (')]］）'.includes(ch)) { depth = Math.max(0, depth - 1); buf += ch; continue; }
    if (depth === 0 && ',;/\n\t，、·ㆍ‧∙／'.includes(ch)) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out.map((x) => x.trim()).filter(Boolean);
}

// ★★★ 세션48 — 사용자 입력이 도달하는 곳에 대한 상한. 실측 근거:
//   allergen_name 에 **20,000자**가 저장됐고, `<script>x</script>` 가 쪼개져 들어갔다.
//   product_allergens 는 **바코드 단위 공용 마스터**다 — 한 사람의 입력이 그 바코드를
//   조회하는 전원에게 간다. 쓰기 경로에 화이트리스트도 길이 상한도 없었다.
const USER_ALLERGEN_MAX_ITEMS = 20;
const USER_ALLERGEN_MAX_LEN = 40;

/**
 * ⚠⚠ **잠정 조치다.** 외부 검증 2인이 독립적으로 「사용자 자유 입력을 공용 마스터에
 *   직접 넣지 말라」(D안: 격리 검토 큐)고 권고했고 제이가 채택했다.
 *   그 구조(`allergen_contributions` + `product_allergen_observations` 2테이블 + 자동승격 규칙)는
 *   스키마 변경이라 별도 세션이다. **이 함수는 그때까지의 방어막이며, 그 작업에서 제거된다.**
 *   → `IP/외부검증_회신종합_2026-08-01_세션48.md` §3 · §5-3
 *
 * 규칙:
 *   ① 항목 수 20 · 항목 길이 40자 상한 (초과분은 버리지 않고 감사용으로 센다)
 *   ② 식약처 19종 canonical 에 붙는 것만 통과 — `normalizeAllergenNames` 재사용.
 *      같은 정규화기를 쓰는 것이 중요하다. 여기서 새 규칙을 쓰면 노출 경로와 갈라진다.
 *   ③ 붙지 않은 원문은 **버리지 않고** 호출부가 `user_input` 에 남긴다(회수 경로 보존).
 *   ★ 19종 밖 실제 알레르겐(아몬드·참깨·생선 등)도 여기서 떨어진다. 그것이 옳아서가 아니라
 *     **공용 마스터에 넣을 채널이 아직 없어서**다. 별도 필드(`allergens_extra`)는 §5-3 ⑤ 과제다.
 */
function sanitizeUserAllergens(items) {
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (const raw of items.slice(0, USER_ALLERGEN_MAX_ITEMS)) {
    const s = raw.slice(0, USER_ALLERGEN_MAX_LEN);
    let hits = [];
    try {
      hits = normalizeAllergenNames(s) || [];
    } catch (e) {
      hits = [];   // 정규화기가 죽어도 사용자 요청 전체를 죽이지 않는다
    }
    if (!hits.length) { rejected.push(raw); continue; }
    for (const h of hits) {
      const name = h && h.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      accepted.push(name);
    }
  }
  if (items.length > USER_ALLERGEN_MAX_ITEMS) {
    rejected.push(...items.slice(USER_ALLERGEN_MAX_ITEMS));
  }
  return { accepted, rejected };
}

/**
 * ★★★ 세션54 — 대장 결함 **D4** 해소. OCR 응답의 알레르기 «4키» 를 한 곳에서 만든다.
 *
 * 무엇이 결함이었나 (`tests/test_path_parity.js` D4)
 *   바코드 경로는 `allergens` · `allergens_v2` · `allergens_available` · `allergens_flat_complete`
 *   4키를 냈는데 **OCR 경로는 앞 2키만** 냈다.
 *   → 「혼입만 있는 제품」이 OCR 화면에서 `allergens: []` 로 보이고, 화면이 그것을
 *     「알레르기 없음」과 구별할 방법이 없다. **과소경고**다.
 *     (같은 사고가 바코드 경로에서 세션46 에 실물로 확인됐다 — 짜왕 8801043032155.)
 *
 * ★ 왜 헬퍼로 빼는가 — OCR 응답 조립 지점이 **세 곳**이다(`/analyze` · `/multi-photo` 2곳).
 *   세 곳에 같은 식을 적으면 다음 수정에서 한 곳이 빠진다. 세션39 `/multi-photo` ·
 *   세션44 치명B 가 정확히 그 사고였다. 그래서 «한 함수»를 세 곳이 부른다.
 *
 * ★ 값의 의미 — 바코드 경로(`productService`)와 **같은 질문에 답한다**:
 *   · `allergens_available`    이 응답에 알레르기 «판정» 이 실려 있는가.
 *   · `allergens_flat_complete` flat 배열이 «전부» 인가. 혼입이 있으면 flat 에 안 들어가므로 false.
 *   앱 계약: `available === true && allergens.length === 0` 이라도
 *     `flat_complete === false` 면 「알레르기 없음」이라고 말하면 안 된다.
 *
 * ⚠⚠ OCR 경로에만 있는 한계 — `available === true` 는 **「우리가 읽은 텍스트를 분석했다」**는
 *   뜻이지 **「라벨 전체를 봤다」**는 뜻이 아니다. 사진이 알레르기 표시줄을 안 담았거나 OCR 이
 *   그 줄을 놓쳤으면, 알레르겐이 있는데도 `available: true, allergens: []` 가 나온다.
 *   바코드 경로의 「DB 에 행이 없다」와는 성격이 다른 불확실성이며, **이 키로는 표현되지 않는다.**
 *   → 그래서 앱의 알레르기 불완전성 고지(`web/src/components/AllergenCard.tsx` `IncompleteNotice`)는
 *     OCR 결과에 대해 이 4키가 생겼다는 이유로 내리면 안 된다. 두 문제는 별개다.
 *
 * @param {string[]|null} flat  `analysis.allergens` (원본 flat)
 * @param {object|null} v2raw   `analysis.allergens_v2`
 * @returns {{allergens: string[]|null, allergens_v2: object|null,
 *            allergens_available: boolean, allergens_flat_complete: (boolean|null)}}
 */
function buildAllergenKeys(flat, v2raw) {
  const v2 = reconcileAllergens(flat, v2raw);
  const available = !!v2;
  return {
    allergens: flattenAllergensV2(v2, flat),
    allergens_v2: v2,
    allergens_available: available,
    // ★ 미판정일 때 `false` 가 아니라 **null** 이다 — 바코드 경로(A1, 세션54)와 같은 규칙.
    //   `false` 는 「flat 이 전부가 아니다」라는 «판정» 인데, 판정 자체가 없으면 그렇게 말할 수 없다.
    allergens_flat_complete: available ? v2.mayContain.length === 0 : null,
  };
}

function judgeNutrition({ productData, nutrition, labelText, explicitServingSize = null }) {
  const nutritionData = {
    calories: nutrition.calories ?? null,
    sodium: nutrition.sodium ?? null,
    sugars: nutrition.total_sugars ?? null,
    sat_fat: nutrition.saturated_fat ?? null,
    total_fat: nutrition.total_fat ?? null,
    cholesterol: nutrition.cholesterol ?? null,
    protein: nutrition.protein ?? null,
    fiber: nutrition.dietary_fiber ?? null,
    trans_fat: nutrition.trans_fat ?? null,
  };

  // ★ 세션42: 기준 문구가 영양표 사진이 아니라 **라벨 사진 쪽**에 찍히는 경우가 흔하다.
  //   2장 분리 촬영(제이의 `_원재료` / `_영양` 규칙)에서 basis 가 unknown 으로 떨어지면
  //   합친 텍스트로 한 번 더 판정한다. 라벨에 답이 적혀 있는데 못 읽는 일을 막는다.
  let basisRaw = nutrition._basis || 'unknown';
  if (basisRaw === 'unknown' && labelText) {
    const re = detectNutritionBasis(labelText);
    if (re && re.basis && re.basis !== 'unknown') basisRaw = re.basis;
  }
  // ★★ 세션45 (제이 결정 안①) — 여기가 정책의 실제 관문이다.
  //   이전 코드는 `|| 'per_serving'` 으로 **unknown 을 눙쳐서** 신호등에 넘겼다.
  //   그래서 신호등에 `unknown → 판정 보류` 를 넣어도 이 줄이 있는 한 영원히 발동하지 않는다.
  //   세션44 중대8(normalizeLabelSpacing 반쪽 적용)과 같은 유형의 함정이다 —
  //   **정책을 엔진에만 넣고 관문을 안 고치면 초록 테스트와 무동작이 공존한다.**
  //   per_100_unknown 은 BASIS_OK 에 없지만 파서가 내지 않는 값이며(별도 경로), 여기 오면 unknown 취급이 맞다.
  const basis = BASIS_OK[basisRaw] || 'unknown';
  const basisUncertain = !BASIS_OK[basisRaw];
  nutritionData.basis = basis;

  if (basis === 'per_total') {
    // 라벨 원문을 함께 넘긴다. servingResolver 의 T0(“12인분”·“(65 g×6입)”)이 여기서만 작동한다.
    nutritionData._label_text = labelText || '';
    nutritionData._totalContent = productData.total_content ?? nutrition.total_content ?? null;

    // ★★ 세션42 검증에서 잡힌 치명 결함의 흔적 — **세션49 에 원인이 제거됐다.**
    //   당시: 호출부가 `|| 100` 으로 기본값을 채워 보냈고, per_total 라벨은 1회 제공량이
    //   라벨에 없어서 per_total 인 것이므로 그 100 은 **가짜 값**이었다. 그대로 두면 신호등의
    //   "serving_size 가 비면 총 내용량을 쓴다" 가드가 영원히 안 돈다(`!100` 은 false).
    //   30g 단품 과자가 100g 기준으로 환산돼 per-100 이 1/3 로 줄고 = **거짓 초록.**
    //   ★ 세션49: 호출부 두 곳(/analyze · /multi-photo)이 이제 explicitServingSize 를
    //     **그대로** 넘긴다(치명B 수정). 따라서 이 줄은 값을 바꾸지 않는 항등이다.
    //     그래도 남겨 둔다 — 호출부가 다시 기본값을 채우기 시작하면 여기가 마지막 방어선이고,
    //     "per_total 에서 serving_size 는 근거 있는 값뿐" 이라는 계약을 이 줄이 명시한다.
    productData = { ...productData, serving_size: explicitServingSize };
  }

  // ★★ 세션47 — RACC 정책을 **넘기지 않고 있었다.**
  //   `productService.getProductWithTrafficLight` 는 4번째 인자로 `getRaccPolicy(food_type)` 를
  //   넘기는데 이 경로와 `productRoutes /evaluate` 는 안 넘겼다. 같은 제품이
  //   바코드 조회와 OCR 조회에서 **서로 다른 신호등**을 받는다(참기름·간장·조미김 등 소량식품).
  //   세션42 가 basis 에서 고친 것과 같은 유형의 누락이다 — 한쪽만 고치면 이렇게 남는다.
  //   ★ food_type 이 없거나 매핑에 없으면 `getRaccPolicy` 는 null 을 돌려준다 = 종전 동작.
  const trafficLight = evaluateNutrition(
    productData, nutritionData, undefined, getRaccPolicy(productData.food_type),
  );

  // ★★★ 세션50 D2 해결 — **라우터는 sanity 를 다시 계산하지 않는다.**
  //   종전: per_total·unknown·보류일 때만 엔진 결과를 쓰고, **그 밖의 정상 경로 전부**에서
  //     `sanityCheck(nutritionData, productData.serving_size, false, basis)` 로 다시 계산했다.
  //     3번째 인자 `isDried` 가 **하드코딩 false** 라 엔진(detectFoodCategory → dried)과 답이 갈렸고,
  //     같은 응답에 `traffic_light.sanity_warnings`(엔진)와 `data.sanity_warnings`(라우터)가
  //     **서로 반대 값으로** 동시에 실렸다(김자반: "" vs "calories:per_100g_exceeded").
  //     화면(public/ocr-test.html:465)은 하필 라우터 쪽 = 틀린 쪽을 읽고 있었다.
  //   지금: 엔진 배열을 **같은 참조로** 그대로 내보낸다. 값이 두 번 계산될 수 없으므로
  //     모순이 **구조적으로 불가능**해진다(값 비교가 아니라 참조 동일성이 그것을 보증한다).
  //   ★ 판정이 없을 때(영양정보를 못 읽어 trafficLight 가 null)는 `[]` 가 아니라 **null** 이다.
  //     `[] = 검사했고 이상 없음` · `null = 검사 못 함`. 이 저장소가 알레르기에서 이미 쓰는 규칙이다
  //     (productService.js:335-337). 종전 분기(per_total·unknown·보류)는 엔진이 이미 같은 정책으로
  //     `[]` 를 내므로 **동작이 바뀌지 않는다** — tests/test_path_parity.js §7 이 그것을 고정한다.
  const sanityWarnings = trafficLight ? trafficLight.sanity_warnings : null;

  if (trafficLight) {
    trafficLight.basis_detected = basisRaw;
    if (basisUncertain) trafficLight.basis_uncertain = true;
  }

  return { trafficLight, sanityWarnings };
}

/**
 * 요청에서 base64 이미지 추출 (multer 파일 또는 JSON body)
 */
function extractBase64Image(req) {
  // multer로 업로드된 파일
  if (req.file) {
    return req.file.buffer.toString('base64');
  }
  // JSON body의 base64 문자열
  if (req.body.image && typeof req.body.image === 'string') {
    return req.body.image.replace(/^data:image\/\w+;base64,/, '');
  }
  throw new ValidationError('이미지가 필요합니다. multipart/form-data의 image 필드 또는 JSON body의 image(base64) 중 하나를 전송하세요.');
}

// ============================================================
// POST /api/ocr/analyze
// multipart: image(file) + product_info(JSON string)
// JSON: { image: "base64...", product_info: {...} }
// ============================================================

router.post('/analyze', upload.single('image'), async (req, res) => {
  const base64Image = extractBase64Image(req);

  if (base64Image.length < 100) {
    throw new ValidationError('유효하지 않은 이미지 데이터입니다.');
  }

  // product_info 파싱 (multer에서는 JSON string으로 전달될 수 있음)
  let productInfo = req.body.product_info;
  if (typeof productInfo === 'string') {
    try { productInfo = JSON.parse(productInfo); } catch { productInfo = null; }
  }

  console.log(`[OCR] 분석 시작 (이미지 크기: ${(base64Image.length * 0.75 / 1024).toFixed(0)}KB)`);

  // Step 1: Google Vision OCR
  const ocrResult = await callVisionAPI(base64Image);

  if (!ocrResult.full_text || ocrResult.full_text.trim().length === 0) {
    return res.json({
      success: true,
      data: {
        ocr: { ...ocrResult, full_text: '' },
        analysis: null,
        traffic_light: null,
        message: '이미지에서 텍스트를 추출하지 못했습니다. 더 선명한 이미지를 사용해주세요.',
      },
    });
  }

  // Step 2: 텍스트 교정 (길이 제한)
  const truncatedText = ocrResult.full_text.substring(0, MAX_OCR_TEXT_LENGTH);
  const { corrected, corrections } = correctOcrText(truncatedText);

  // Step 3: 분석
  const analysis = analyzeText(corrected);

  // ── 사용자 입력값 우선 병합 ──
  // 사용자가 OCR 결과 화면에서 영양성분·원재료·알레르기를 직접 수정한 경우,
  // OCR 결과 대신 사용자 값을 신뢰한다. (Trust the user, not the OCR.)
  if (productInfo?.nutrition) {
    analysis.nutrition = { ...analysis.nutrition, ...productInfo.nutrition };
  }
  if (productInfo?.ingredients_text) {
    // 사용자가 텍스트 영역에서 수정한 원재료 — corrected 텍스트로 갈아끼우면
    // analyzeText 가 다시 파싱해 ingredients 배열을 새로 생성
    // ★ 세션42: 여기가 **길이 제한이 적용되지 않던 유일한 경로**였다.
    //   사용자가 보낸 문자열이 그대로 정규식 엔진에 들어가 ReDoS 표면이 됐다(app.js 는 15MB 허용).
    //   OCR 텍스트와 같은 상한을 적용한다.
    const reanalyzed = analyzeText(String(productInfo.ingredients_text).substring(0, MAX_OCR_TEXT_LENGTH));
    if (reanalyzed.ingredients?.length) {
      analysis.ingredients = reanalyzed.ingredients;
      analysis.ingredient_count = reanalyzed.ingredient_count;
      analysis.additives = reanalyzed.additives;
      analysis.additive_count = reanalyzed.additive_count;
      // ★ 세션44: 사용자가 원재료 텍스트를 고쳤으면 알레르기 3분리도 그 텍스트로 다시 뽑는다.
      //   안 그러면 화면의 원재료와 혼입 경고가 서로 다른 텍스트에서 나온 값이 된다.
      // ★★★ 단, 사진 라벨에서 읽은 것을 **버리지 않는다**(서브에이전트 검증 치명3).
      //   사용자가 보낸 것은 보통 「원재료만」이라 함유 선언(`♥…함유♥`)이 들어 있지 않다.
      //   그대로 갈아끼우면 사진에서 읽은 직접 함유 선언이 사라지고,
      //   클라이언트는 v2 가 있으면 flat 을 안 쓰므로 **화면에서 통째로 없어진다.**
      //   → 두 결과를 합집합으로 병합한다. 경고는 잃지 않는다.
      // ★ 세션44 2차: 인라인 병합을 `mergeAllergensV2` 로 통합했다.
      //   `/multi-photo` 가 같은 병합을 필요로 하는데 로직이 두 벌이면 또 갈라진다(치명B가 그 사고였다).
      analysis.allergens_v2 = mergeAllergensV2(analysis.allergens_v2, reanalyzed.allergens_v2);
    }
  }
  // ★★ 세션44 2차 검증(경미M) — 초판은 `Array.isArray` 만 봐서 **빈 배열도 덮어쓰기**로 처리했다.
  //   `allergens: []` 를 보내면 flat 이 비고 3분리도 null 이 되어 **알레르기 카드가 통째로 사라진다.**
  //   빈 배열은 "사용자가 전부 지웠다" 와 "클라이언트가 기본값으로 보냈다" 를 구별하지 못한다.
  //   → 항목이 하나 이상일 때만 덮어쓰기로 본다. 지우는 것은 별도 플래그가 필요하다(미구현).
  //   ★ 세션47 경미4 — 문자열로 온 것도 배열로 받는다(위 coerceUserAllergens 주석 참조).
  const userAllergens = coerceUserAllergens(productInfo?.allergens);
  if (userAllergens.length > 0) {
    // ★★★ 세션48 외부검증 — 세션47 판은 `analysis.allergens = userAllergens` 였다(**덮어쓰기**).
    //   실측: 라벨에서 ["밀","우유","대두","새우(혼입)"] 를 읽은 상태에서 사용자가 "밀" 한 글자를
    //   보내면 응답이 ["밀"] + allergens_v2=null 이 된다 — **우유·대두·새우가 사라진다(과소경고).**
    //   옛 코드는 문자열을 무시했으므로(무해) 세션47 수정이 **새 과소경고를 만들었다.**
    //   ★ 배열 경로에는 「전부 지웠다」는 명시적 계약이 있었지만(세션44 경미M),
    //     문자열 경로에는 그런 의도의 근거가 없다. 계약을 모르는 클라이언트가 보내는 값이다.
    //   → **합집합**으로 받는다. 3분리(v2)도 내리지 않는다 — 라벨에서 읽은 등급 근거는 유효하다.
    //     사용자가 준 이름은 등급을 모르므로 `inferred` 로 넣는다(직접함유로 단정하지 않는다).
    const { accepted, rejected } = sanitizeUserAllergens(userAllergens);
    if (accepted.length > 0) {
      analysis.allergens = Array.from(new Set([...(analysis.allergens || []), ...accepted]));
      analysis.allergens_v2 = mergeAllergensV2(analysis.allergens_v2, {
        contains: [], inferred: accepted, mayContain: [],
      });
    }
    // ★ 정규화에 붙지 않은 원문은 **버리지 않는다.** 회수 경로가 사라지면 다음 세션이 못 찾는다.
    if (rejected.length > 0) analysis._user_allergens_rejected = rejected;
  }

  // Step 4: 영양 신호등
  let trafficLight = null;
  // ★ 세션50 D2 — 영양정보를 못 읽으면 sanity 는 `[]`(=이상 없음)가 아니라 **null**(=검사 못 함)이다.
  let sanityWarnings = null;
  const nutrition = analysis.nutrition;

  if (nutrition.calories || nutrition.sodium || nutrition.total_sugars) {
    // ★★★ 세션49 — 치명B 수정. 이 한 줄이 RACC 정책을 통째로 무력화하고 있었다.
    //   종전: `serving_size: nutrition.serving_size || productInfo?.serving_size || 100`
    //   RACC_MAP 13종의 racc 는 전부 4~15 g 이라 `100 >= 0.5 × racc` 가 **항상 참**이다.
    //   그래서 신호등이 "라벨값이 sane 하면 라벨 우선" 규칙을 적용해 **RACC 1회량을
    //   한 번도 쓰지 않았다.** 실측 불일치: 샘표 진간장 바코드 sodium=yellow(14.8%) ↔ OCR red(295%).
    //   ★ 다른 상수로 바꾸면 안 된다. 근거 없는 값을 넣지 말고 **null 을 넘겨**
    //     신호등이 RACC 로 정하게 한다(정책 결정은 엔진 한 곳에서만).
    //   ★ 아래 explicitServingSize 와 **같은 식을 두 번 쓰지 않는다.** 한 번 계산해 둘 다에 넘긴다 —
    //     같은 의미를 두 곳에서 재해석하던 것이 세션48 외부 검증의 근본 원인 진단이었다.
    const explicitServingSize = nutrition.serving_size ?? productInfo?.serving_size ?? null;
    const productData = {
      product_name: productInfo?.product_name || analysis.product_meta?.product_name || '(OCR 분석)',
      // ★ 세션42: food_type 이 비면 RACC 매칭이 통째로 실패한다. 라벨에서 읽은 값을 폴백으로 쓴다.
      food_type: productInfo?.food_type || analysis.product_meta?.food_type || '',
      content_unit: nutrition.serving_unit || nutrition.content_unit || productInfo?.content_unit || 'g',
      serving_size: explicitServingSize,
      // ★ 세션42: 총 내용량이 null 이면 per_total 환산(총량 ÷ RACC)이 아예 못 돈다.
      //   `/multi-photo` 는 product_meta 폴백이 있었는데 여기만 없었다.
      total_content: productInfo?.total_content ?? nutrition.total_content
        ?? analysis.product_meta?.total_content ?? null,
    };

    // ★ 세션39: 표기 기준(basis)을 신호등에 전달한다. ★ 세션42: 공통부로 이관(judgeNutrition).
    //   실물 반례: 해표 콩기름은 "100g당 지방 100g" → 1회분으로 읽히면 판정이 무의미해진다.
    ({ trafficLight, sanityWarnings } = judgeNutrition({
      productData,
      nutrition,
      labelText: corrected,
      // 기본값 100 을 섞지 않은 **근거 있는 값만** — per_total 판정에 쓰인다.
      // ★ 세션49: productData.serving_size 와 같은 값이다(위에서 한 번 계산했다).
      explicitServingSize,
    }));
  }

  // Step 5: DB 저장 (save=true 시 크라우드소싱 파이프라인)
  let saveResult = null;
  const shouldSave = req.body.save === true || req.body.save === 'true';

  if (shouldSave) {
    saveResult = await saveOcrContribution({
      barcode: productInfo?.barcode || req.body.barcode || null,
      productInfo: productInfo || {},
      ocrResult: { corrected_text: corrected, corrections },
      analysis,
      avgConfidence: ocrResult.avg_confidence,
      userId: req.body.user_id || null,
      deviceId: req.body.device_id || null,
    });
  }

  res.json({
    success: true,
    data: {
      ocr: {
        block_count: ocrResult.block_count,
        avg_confidence: ocrResult.avg_confidence,
        elapsed_ms: ocrResult.elapsed_ms,
        corrections,
        full_text_length: ocrResult.full_text.length,
      },
      corrected_text: corrected,
      analysis: {
        ingredients: analysis.ingredients,
        ingredient_count: analysis.ingredient_count,
        additives: analysis.additives,
        additive_count: analysis.additive_count,
        nutrition: analysis.nutrition,
        // ★★ 세션45 중대4 — flat 을 **3분리에서 되짚어** 만든다.
        //   analysis.allergens 를 그대로 내보내면 혼입 항목이 flat 에 섞여(v1 폴백 경로)
        //   구버전 앱이 「직접 함유」로 붉게 표시한다. 바코드 조회 경로와 의미도 어긋난다.
        // ★ 세션44 — `allergens_v2`(직접함유/혼입가능/추정 3분리)는 #114 부터 analyzeText 안에서
        //   **계산되고 있었지만 응답에 실리지 않았다**(서버는 만들고 아무도 안 쓴다).
        // ★★★ reconcileAllergens — flat 에만 있는 항목을 3분리에 합쳐 넣는다(치명3 최종 방어).
        //   클라이언트는 v2 가 있으면 flat 을 안 보므로, 여기서 합치지 않으면 화면에서 사라진다.
        // ★★★ 세션54 D4 — 네 키를 «한 함수»가 만든다. 세 조립 지점이 갈라지지 않게 하기 위함이다.
        ...buildAllergenKeys(analysis.allergens, analysis.allergens_v2),
        product_meta: analysis.product_meta,
      },
      traffic_light: trafficLight,
      // ⚠ deprecated (세션50 D2) — `traffic_light.sanity_warnings` 와 **같은 배열**이다.
      //   지우지 않는 이유: public/ocr-test.html:465 와 배포된 앱이 이 키를 읽는다(계약 미확인).
      //   새 클라이언트는 `traffic_light.sanity_warnings` 를 읽을 것. null = 검사 못 함.
      sanity_warnings: sanityWarnings,
      save_result: saveResult,
    },
  });
});

// ============================================================
// POST /api/ocr/multi-photo
// 두 장의 사진을 받아 통합 분석:
//   - label_image: 제품 라벨 (제품명·식품유형·판매원·원재료·알레르기)
//   - nutrition_image: 영양성분표 (11개 영양소)
// 두 장의 OCR 결과를 합쳐 사용자가 거의 수정 없이 등록할 수 있게 한다.
// ============================================================

router.post(
  '/multi-photo',
  upload.fields([
    { name: 'label_image', maxCount: 1 },
    { name: 'nutrition_image', maxCount: 1 },
  ]),
  async (req, res) => {
    const labelFile = req.files?.label_image?.[0];
    const nutritionFile = req.files?.nutrition_image?.[0];

    if (!labelFile && !nutritionFile) {
      throw new ValidationError('label_image 또는 nutrition_image 중 하나 이상은 필수입니다.');
    }

    let productInfo = req.body.product_info;
    if (typeof productInfo === 'string') {
      try { productInfo = JSON.parse(productInfo); } catch { productInfo = null; }
    }

    console.log('[OCR/multi] 두 사진 분석 시작', {
      label: labelFile ? `${(labelFile.size / 1024).toFixed(0)}KB` : '없음',
      nutrition: nutritionFile ? `${(nutritionFile.size / 1024).toFixed(0)}KB` : '없음',
    });

    // ─── 1. 라벨 사진 OCR (제품명·원재료·알레르기) ───
    let labelAnalysis = null;
    let labelOcr = null;
    if (labelFile) {
      const base64 = labelFile.buffer.toString('base64');
      labelOcr = await callVisionAPI(base64);
      const truncated = labelOcr.full_text.substring(0, MAX_OCR_TEXT_LENGTH);
      const { corrected: c1, corrections: cor1 } = correctOcrText(truncated);
      labelAnalysis = analyzeText(c1);
      labelAnalysis._corrected_text = c1;
      labelAnalysis._corrections = cor1;
      labelAnalysis._avg_confidence = labelOcr.avg_confidence;
    }

    // ─── 2. 영양성분 사진 OCR (영양소만) ───
    let nutritionAnalysis = null;
    let nutritionOcr = null;
    if (nutritionFile) {
      const base64 = nutritionFile.buffer.toString('base64');
      nutritionOcr = await callVisionAPI(base64);
      const truncated = nutritionOcr.full_text.substring(0, MAX_OCR_TEXT_LENGTH);
      const { corrected: c2, corrections: cor2 } = correctOcrText(truncated);
      nutritionAnalysis = analyzeText(c2);
      nutritionAnalysis._corrected_text = c2;
      nutritionAnalysis._corrections = cor2;
      nutritionAnalysis._avg_confidence = nutritionOcr.avg_confidence;
    }

    // ─── 3. 두 분석 결과 병합 ───
    // 라벨 사진 → 메타·원재료·첨가물·알레르기 우선
    // 영양표 사진 → 영양정보 우선
    const merged = {
      product_meta: labelAnalysis?.product_meta || nutritionAnalysis?.product_meta || {},
      ingredients: labelAnalysis?.ingredients || [],
      ingredient_count: labelAnalysis?.ingredient_count || 0,
      additives: labelAnalysis?.additives || [],
      additive_count: labelAnalysis?.additive_count || 0,
      // ★★★ 세션44 2차 검증 — 여기가 치명3 과 **완전히 같은 결함**이었다(2차 검증 치명B).
      //   초판은 `labelAnalysis?.allergens_v2 || nutritionAnalysis?.allergens_v2` 였는데
      //   `analyzeText` 는 `allergens_v2` 를 **항상 객체로** 반환한다(전부 빈 배열이라도 truthy).
      //   → 라벨 사진이 알레르기 표기를 못 잡으면 영양표 쪽은 **영원히 평가되지 않는다.**
      //   flat 의 `|| []` 도 같다(빈 배열도 truthy).
      //   실측: 표기가 영양표 사진에 찍힌 라면 라벨 → 단독 분석 8종이 **두 장 함께 보내면 1종**.
      //     소실: 게·난류·새우·쇠고기·우유(직접함유 5종) + 땅콩·메밀(혼입 2종).
      //     남은 밀도 「직접 함유」 → 「원재료 추정」 으로 강등됐다.
      //   ★ 법정 알레르기 표기는 영양성분표 옆에 인쇄되는 경우가 흔하다. 예외가 아니라 정상 케이스다.
      //   ★ 같은 파일 judgeNutrition 은 이미 두 사진 텍스트를 합쳐서 넘긴다 —
      //     영양은 합치고 알레르기는 안 합치고 있었다.
      //   → 두 사진 결과를 **합집합**으로 병합한다. 어느 쪽에서 읽혔든 경고는 잃지 않는다.
      allergens: [...new Set([
        ...(labelAnalysis?.allergens || []),
        ...(nutritionAnalysis?.allergens || []),
      ])].sort(),
      allergens_v2: mergeAllergensV2(labelAnalysis?.allergens_v2, nutritionAnalysis?.allergens_v2),
      nutrition: nutritionAnalysis?.nutrition || labelAnalysis?.nutrition || {},
    };

    // 사용자 입력 우선 적용
    if (productInfo?.nutrition) {
      merged.nutrition = { ...merged.nutrition, ...productInfo.nutrition };
    }
    // ★ 세션44 2차: /analyze 와 같은 이유 — 빈 배열은 덮어쓰기로 보지 않는다(경미M).
    //   ★ 세션47 경미4 — /analyze 와 같은 정규화. 문자열로 와도 버리지 않는다.
    const userAllergensMulti = coerceUserAllergens(productInfo?.allergens);
    if (userAllergensMulti.length > 0) {
      // ★★★ 세션48 — /analyze 와 **같은 규칙**이다. 두 경로가 갈라지면 한쪽만 고쳐지는 사고가 난다
      //   (세션44 치명B·세션47 RACC 누락이 전부 이 유형이었다).
      const { accepted, rejected } = sanitizeUserAllergens(userAllergensMulti);
      if (accepted.length > 0) {
        merged.allergens = Array.from(new Set([...(merged.allergens || []), ...accepted]));
        merged.allergens_v2 = mergeAllergensV2(merged.allergens_v2, {
          contains: [], inferred: accepted, mayContain: [],
        });
      }
      if (rejected.length > 0) merged._user_allergens_rejected = rejected;
    }

    // ─── 4. 영양 신호등 판정 ───
    const nutrition = merged.nutrition;
    let trafficLight = null;
    // ★ 세션50 D2 — /analyze 와 같은 계약: 판정이 없으면 `[]` 가 아니라 **null**(=검사 못 함).
    let sanityWarnings = null;

    if (nutrition.calories || nutrition.sodium || nutrition.total_sugars) {
      // ★★★ 세션49 — 치명B 수정. /analyze 와 **같은 결함이 여기에도 있었다.**
      //   세션39 가 basis 를 /analyze 만 고치고 이 엔드포인트를 놓쳤던 것과 같은 유형이다.
      //   `|| 100` 이 RACC 1회량을 영원히 덮어써서 소량식품(참기름·간장·조미김)의
      //   판정이 바코드 경로와 갈라졌다. 근거 없는 값 대신 null 을 넘겨 엔진이 정하게 한다.
      const explicitServingSize = nutrition.serving_size ?? productInfo?.serving_size ?? null;
      const productData = {
        product_name: productInfo?.product_name || merged.product_meta.product_name || '(OCR 분석)',
        food_type: productInfo?.food_type || merged.product_meta.food_type || '',
        content_unit: nutrition.serving_unit || productInfo?.content_unit || merged.product_meta.content_unit || 'g',
        serving_size: explicitServingSize,
        total_content: productInfo?.total_content || merged.product_meta.total_content || null,
      };
      // ★★ 세션42 수정 — 여기가 basis 미배선 지점이었다(세션41 §5-4 발견).
      //   세션39 는 /analyze 만 고치고 이 두 번째 엔드포인트를 보지 못했다.
      //   이 경로로 들어온 **모든 라벨이 per_serving 으로 판정**되고 있었다.
      //   제이의 새 캡처 규칙(`_원재료` / `_영양` 2장 분리)이 정확히 이 경로를 쓴다.
      //   라벨 텍스트는 두 장을 합쳐 넘긴다 — 인분 수 표기는 영양표가 아니라
      //   제품 라벨 쪽에 적혀 있는 경우가 많다(019 "65 g×6입" 은 중량 줄에 있다).
      const labelText = [
        labelAnalysis?._corrected_text,
        nutritionAnalysis?._corrected_text,
      ].filter(Boolean).join('\n');

      ({ trafficLight, sanityWarnings } = judgeNutrition({
        productData,
        nutrition,
        labelText,
        // ★ 세션49: productData.serving_size 와 같은 값이다(위에서 한 번 계산했다).
        explicitServingSize,
      }));
    }

    // ─── 5. 등록 (선택) ───
    let saveResult = null;
    const shouldSave = req.body.save === true || req.body.save === 'true';

    if (shouldSave) {
      // 사용자 입력 + 메타 병합 → productInfo 로 saveOcrContribution 에 전달
      const mergedProductInfo = {
        ...merged.product_meta,
        ...productInfo,
        nutrition: merged.nutrition,
        // ★ 세션45 중대4 — 저장 경로(`user_input.allergens`)도 같은 규칙을 쓴다.
        //   여기만 raw flat 이면 혼입 항목이 「사용자가 직접 함유라고 했다」는 기록으로 DB 에 남는다.
        // ★ 세션54 D4 — 응답과 «같은 함수»에서 뽑는다. 저장 경로만 따로 계산하면
        //   DB 에 남는 기록과 사용자가 본 화면이 갈라진다.
        allergens: buildAllergenKeys(merged.allergens, merged.allergens_v2).allergens,
      };
      saveResult = await saveOcrContribution({
        barcode: productInfo?.barcode || req.body.barcode || null,
        productInfo: mergedProductInfo,
        ocrResult: {
          corrected_text: [
            labelAnalysis?._corrected_text,
            nutritionAnalysis?._corrected_text,
          ].filter(Boolean).join('\n---LABEL/NUTRITION SPLIT---\n'),
          corrections: [
            ...(labelAnalysis?._corrections || []),
            ...(nutritionAnalysis?._corrections || []),
          ],
        },
        analysis: merged,
        avgConfidence: Math.max(
          labelAnalysis?._avg_confidence || 0,
          nutritionAnalysis?._avg_confidence || 0,
        ),
        userId: req.body.user_id || null,
        deviceId: req.body.device_id || null,
      });
    }

    // ─── 6. 응답 ───
    res.json({
      success: true,
      data: {
        label_ocr: labelOcr ? {
          block_count: labelOcr.block_count,
          avg_confidence: labelOcr.avg_confidence,
          elapsed_ms: labelOcr.elapsed_ms,
          full_text_length: labelOcr.full_text.length,
        } : null,
        nutrition_ocr: nutritionOcr ? {
          block_count: nutritionOcr.block_count,
          avg_confidence: nutritionOcr.avg_confidence,
          elapsed_ms: nutritionOcr.elapsed_ms,
          full_text_length: nutritionOcr.full_text.length,
        } : null,
        analysis: {
          product_meta: merged.product_meta,
          ingredients: merged.ingredients,
          ingredient_count: merged.ingredient_count,
          additives: merged.additives,
          additive_count: merged.additive_count,
          nutrition: merged.nutrition,
          // ★★ 세션45 중대4 — /analyze 와 **문자 단위로 같은 방식**으로 만든다.
          //   여기만 `merged.allergens` 를 그대로 두면 두 엔드포인트가 또 갈라진다
          //   (세션39·세션44 치명B 가 정확히 그 사고였다).
          // ★★★ 세션54 D4 — 이제 «같은 함수»를 부른다. 「같은 방식으로 적는다」는 지켜지지 않는다.
          ...buildAllergenKeys(merged.allergens, merged.allergens_v2),
        },
        traffic_light: trafficLight,
        // ⚠ deprecated (세션50 D2) — `traffic_light.sanity_warnings` 와 **같은 배열**이다. null = 검사 못 함.
        sanity_warnings: sanityWarnings,
        save_result: saveResult,
        corrected_text: {
          label: labelAnalysis?._corrected_text || null,
          nutrition: nutritionAnalysis?._corrected_text || null,
        },
      },
    });
  }
);

// ============================================================
// POST /api/ocr/report — 제품 오류 신고
// ============================================================

router.post('/report', async (req, res) => {
  const { product_id, user_id, reason } = req.body;

  if (!product_id || !reason) {
    throw new ValidationError('product_id와 reason이 필요합니다.');
  }

  const result = await reportError(product_id, user_id, reason);
  res.json({ success: true, data: result });
});

// ============================================================
// POST /api/ocr/text-only
// ============================================================

router.post('/text-only', upload.single('image'), async (req, res) => {
  const base64Image = extractBase64Image(req);

  const ocrResult = await callVisionAPI(base64Image);
  const truncatedText = ocrResult.full_text.substring(0, MAX_OCR_TEXT_LENGTH);
  const { corrected, corrections } = correctOcrText(truncatedText);

  res.json({
    success: true,
    data: {
      full_text: ocrResult.full_text,
      corrected_text: corrected,
      corrections,
      block_count: ocrResult.block_count,
      avg_confidence: ocrResult.avg_confidence,
      elapsed_ms: ocrResult.elapsed_ms,
    },
  });
});

module.exports = router;

// ★ 세션45: judgeNutrition 을 테스트·프로브에서 직접 부를 수 있게 노출한다.
//   노출하지 않으면 회귀 테스트가 이 함수를 **복사**해서 검사하게 되고,
//   그 순간 "두 파서 중 한쪽만 고치기" 사고가 basis 관문에서도 반복된다(세션42~44에서 4회).
//   라우터는 함수 객체이므로 속성 부착은 기존 `app.use(router)` 사용에 영향이 없다.
module.exports.judgeNutrition = judgeNutrition;
// ★ 세션47 경미4: 같은 이유로 노출한다. 테스트가 복사본을 만들면 두 벌이 갈라진다.
module.exports.coerceUserAllergens = coerceUserAllergens;
// ★★ 세션54 D4: 알레르기 4키 조립을 노출한다.
//   종전 회귀는 이 배선을 **소스 문자열 정규식**으로 봤다(`allergens_v2: reconcileAllergens(X..., X...)`).
//   그 검사는 리터럴이 헬퍼로 바뀌는 순간 «동작이 옳아도» 깨진다 — 리팩터링을 막는 족쇄였다.
//   실제로 세션54 에 그렇게 깨졌다. 함수를 노출해 **실동작**으로 검사한다.
module.exports.buildAllergenKeys = buildAllergenKeys;
// ★ 세션55: 같은 이유로 노출한다. 이름 축 회귀(`tests/test_allergen_axis.js` §3)가
//   「사용자 입력 ∪ OCR 출력」에서 같은 알레르겐이 두 이름으로 들어가지 않는지를 검사하는데,
//   노출하지 않으면 테스트가 이 함수의 **로직을 재현**하게 된다 —
//   그러면 정작 이 함수가 바뀌었을 때 회귀가 못 잡는다(세션45 주석과 같은 사고).
module.exports.sanitizeUserAllergens = sanitizeUserAllergens;
