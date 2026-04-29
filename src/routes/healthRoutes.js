/**
 * 헬스체크 & 시스템 정보 라우터
 */

const express = require('express');
const { healthCheck } = require('../config/database');

const router = express.Router();

// GET /api/health
router.get('/', async (req, res) => {
  const dbHealth = await healthCheck();

  const status = dbHealth.status === 'healthy' ? 200 : 503;

  res.status(status).json({
    success: dbHealth.status === 'healthy',
    data: {
      service: 'meokseon-api',
      version: require('../../package.json').version,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      database: dbHealth,
    },
  });
});

module.exports = router;
