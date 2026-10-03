/**
 * 제품 API 라우터
 * /api/products
 * 라우터는 HTTP 요청/응답 처리만 담당, 비즈니스 로직은 서비스 계층에 위임
 */

const express = require('express');
const { query: checkQuery, param, validationResult } = require('express-validator');
const productModel = require('../models/productModel');
const productService = require('../services/productService');
// ★ 세션50 D2 — `sanityCheck` 를 **일부러 import 하지 않는다.** 판정은 엔진 한 곳에서만 한다.
const { evaluateNutrition } = require('../services/nutritionTrafficLight');
const { getRaccPolicy } = require('../services/raccPolicy');
const { ValidationError } = require('../middleware/errorHandler');

const router = express.Router();

function validate(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new ValidationError('입력값 검증 실패', errors.array());
  }
}

// GET /api/products/search
router.get(
  '/search',
  [
    checkQuery('q').trim().notEmpty().withMessage('검색어(q)를 입력하세요.'),
    checkQuery('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
    checkQuery('offset').optional().isInt({ min: 0 }).toInt(),
  ],
  async (req, res) => {
    validate(req);
    const { q, limit = 20, offset = 0 } = req.query;
    const products = await productModel.searchByName(q, limit, offset);
    res.json({ success: true, data: { query: q, count: products.length, products } });
  }
);

// GET /api/products/recent
router.get(
  '/recent',
  [checkQuery('limit').optional().isInt({ min: 1, max: 50 }).toInt()],
  async (req, res) => {
    const { limit = 20 } = req.query;
    const products = await productModel.getRecent(limit);
    res.json({ success: true, data: { count: products.length, products } });
  }
);

// ★ 세션73 U71-5 — GET /api/products/name-suggest?name=… — 제품명 «한 글자 오독» 제안(AI 아님 · 제품 DB 사전 대조)
//   응답 { name, suggested|null, tokens:[{text, known, suggestion}] } · 사전을 못 만들면 suggested null(종전 화면).
router.get(
  '/name-suggest',
  [checkQuery('name').trim().isLength({ min: 1, max: 200 }).withMessage('name 은 1~200자입니다.')],
  async (req, res) => {
    validate(req);
    const { suggestName } = require('../services/nameSuggest');
    const { getDictionary } = require('../services/nameSuggestDict');
    const dict = await getDictionary(require('../config/database'));
    const name = req.query.name;
    if (!dict) return res.json({ success: true, data: { name, suggested: null, tokens: [], dictionary: false } });
    const r = suggestName(name, dict);
    res.json({ success: true, data: { name, suggested: r.suggested, tokens: r.tokens, dictionary: true } });
  }
);

// GET /api/products/:barcode — 서비스 계층 위임
router.get(
  '/:barcode',
  [param('barcode').trim().matches(/^\d{8,14}$/).withMessage('바코드는 8~14자리 숫자입니다.')],
  async (req, res) => {
    validate(req);
    const data = await productService.getProductWithTrafficLight(req.params.barcode);
    res.json({ success: true, data });
  }
);

// ★ 2026-10-03 — GET /api/products/:barcode/portion?kind=pack|serving|gram&qty=
//   영양공식 식사 기록용 «먹은 양 × 영양». 계산은 portionService 한 곳(웹·Edge 산식 금지).
//   kind 없으면 portion=null 로 단위별 가능 여부(options)만 준다. 무인증 GET(제품 조회와 같은 등급).
router.get(
  '/:barcode/portion',
  [
    param('barcode').trim().matches(/^\d{8,14}$/).withMessage('바코드는 8~14자리 숫자입니다.'),
    checkQuery('kind').optional().isIn(['pack', 'serving', 'gram']).withMessage('kind 는 pack|serving|gram 입니다.'),
    checkQuery('qty').optional().isFloat({ gt: 0, max: 5000 }).toFloat(),
  ],
  async (req, res) => {
    validate(req);
    const { computePortion, portionOptions } = require('../services/portionService');
    const { NotFoundError } = require('../middleware/errorHandler');
    const row = await productModel.findForPortion(req.params.barcode);
    if (!row) throw new NotFoundError('제품');
    const product = {
      product_id: row.product_id, barcode: row.barcode, product_name: row.product_name, brand: row.brand,
      serving_size: row.serving_size, total_content: row.total_content, content_unit: row.content_unit,
      servings_per_container: row.servings_per_container,
    };
    const { deriveBasis } = require('../services/nutritionTrafficLight');
    const hasNut = row.calories !== null && row.calories !== undefined;
    const basis = hasNut ? deriveBasis(row.nutrition_serving_size) : null;
    const options = portionOptions(product, row);
    const { kind, qty } = req.query;
    const portion = kind ? computePortion(product, row, { kind, qty: qty == null ? 1 : qty }) : null;
    res.json({ success: true, data: { product, basis, options, portion } });
  }
);

// GET /api/products/:barcode/additives — 서비스 계층 위임
router.get(
  '/:barcode/additives',
  [param('barcode').trim().matches(/^\d{8,14}$/).withMessage('바코드는 8~14자리 숫자입니다.')],
  async (req, res) => {
    validate(req);
    const data = await productService.getProductAdditives(req.params.barcode);
    res.json({ success: true, data });
  }
);

// POST /api/products/evaluate
router.post('/evaluate', async (req, res) => {
  const { product, nutrition } = req.body;

  if (!product || !nutrition) {
    throw new ValidationError('product와 nutrition 객체가 필요합니다.');
  }
  if (!product.serving_size || product.serving_size <= 0) {
    throw new ValidationError('serving_size는 양수여야 합니다.');
  }

  // ★ 세션42: basis 를 안 넘겨 evaluateNutrition 과 **서로 다른 기준으로** 계산되고 있었다.
  //   per_total 라벨이면 evaluation 은 1회분 환산값, sanity_warnings 는 총량 기준 —
  //   같은 응답 안에서 모순된 값이 나간다. (세션39가 /multi-photo 를 놓친 것과 같은 유형)
  //   per_total 은 신호등이 환산 후 자체 sanityCheck 를 돌리므로 그 결과를 그대로 쓴다.
  //   ※ 세션50: 그 「per_total 만」 이라는 조건이 아래에서 사라졌다 — **모든 basis** 가 엔진 결과다.
  // ★★ 세션47 — RACC 정책 누락(ocrRoutes 와 같은 사고). productService 만 넘기고 있었다.
  //   food_type 이 없거나 매핑에 없으면 null 이므로 종전 동작과 같다.
  // ★★★ 세션50 D2 — **여기도 다시 계산하지 않는다.**
  //   종전: per_total 만 엔진 결과를 쓰고 그 밖에는 `sanityCheck(..., false, basis)` 로 재계산했다.
  //   3번째 인자가 하드코딩 false 라 건조식품(김·육포·미역)이 이 경로에서만 100g 상한에 걸렸다.
  //   ⚠ ocrRoutes 만 고치고 여기를 놔두면 같은 제품이 `/api/ocr/analyze` 에서는 경고 0건,
  //     `/api/products/evaluate` 에서는 1건이 되어 **결함이 자리만 옮긴다.** 그래서 동시에 고친다.
  //   ★ 엔진 배열을 **같은 참조로** 내보낸다(값을 복사해 두 벌로 만들지 말 것).
  const result = evaluateNutrition(product, nutrition, undefined, getRaccPolicy(product.food_type));
  const warnings = result.sanity_warnings;
  res.json({ success: true, data: { evaluation: result, sanity_warnings: warnings } });
});

module.exports = router;
