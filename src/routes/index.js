/**
 * 라우터 통합 모듈
 *
 * Phase 1 통합 (2026-05-27):
 *   - userRoutes (03번): /api/users/me + /api/users/me/pulse-consent/*
 *   - scanRoutes (04번): /api/scans
 *
 * SOURCE: IP/pulse/auth_routes_design_2026-05-20.md §7
 *         IP/pulse/cursor_prompts/04_scan_routes.md §3-4
 */

const express = require('express');
const productRoutes = require('./productRoutes');
const healthRoutes = require('./healthRoutes');
const ocrRoutes = require('./ocrRoutes');
const adminRoutes = require('./adminRoutes');
const userRoutes = require('./userRoutes');
const scanRoutes = require('./scanRoutes');

const router = express.Router();

router.use('/health', healthRoutes);
router.use('/products', productRoutes);
router.use('/ocr', ocrRoutes);
router.use('/admin', adminRoutes);
router.use('/users', userRoutes);
router.use('/scans', scanRoutes);

module.exports = router;
