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
// 세션64c — 「내 제보 이력」. 종전엔 제보 조회가 관리자용 하나뿐이라
//   소비자가 자기 제보 결과를 볼 방법이 «없었다»(앱은 알려주겠다고 약속만 했다).
const contributionRoutes = require('./contributionRoutes');

const router = express.Router();

router.use('/health', healthRoutes);
router.use('/products', productRoutes);
router.use('/ocr', ocrRoutes);
router.use('/admin', adminRoutes);
router.use('/users', userRoutes);
router.use('/scans', scanRoutes);
router.use('/contributions', contributionRoutes);

module.exports = router;
