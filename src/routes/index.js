/**
 * 라우터 통합 모듈
 */

const express = require('express');
const productRoutes = require('./productRoutes');
const healthRoutes = require('./healthRoutes');
const ocrRoutes = require('./ocrRoutes');
const adminRoutes = require('./adminRoutes');

const router = express.Router();

router.use('/health', healthRoutes);
router.use('/products', productRoutes);
router.use('/ocr', ocrRoutes);
router.use('/admin', adminRoutes);

module.exports = router;
