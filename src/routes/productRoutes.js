/**
 * 제품 API 라우터
 * /api/products
 * 라우터는 HTTP 요청/응답 처리만 담당, 비즈니스 로직은 서비스 계층에 위임
 */

const express = require('express');
const { query: checkQuery, param, validationResult } = require('express-validator');
const productModel = require('../models/productModel');
const productService = require('../services/productService');
const { evaluateNutrition, sanityCheck } = require('../services/nutritionTrafficLight');
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

  const warnings = sanityCheck(nutrition, product.serving_size);
  const result = evaluateNutrition(product, nutrition);
  res.json({ success: true, data: { evaluation: result, sanity_warnings: warnings } });
});

module.exports = router;
