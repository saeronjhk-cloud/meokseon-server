/**
 * 헬스체크 & 시스템 정보 라우터
 */

const express = require('express');
const { healthCheck } = require('../config/database');

const router = express.Router();

// GET /api/health — liveness check (Railway healthcheck용)
// 서버가 살아있으면 항상 200 반환. DB 상태는 정보로만 포함.
router.get('/', async (req, res) => {
  let dbHealth;
  try {
    dbHealth = await healthCheck();
  } catch {
    dbHealth = { status: 'unavailable', error: 'healthcheck query failed' };
  }

  res.status(200).json({
    success: true,
    data: {
      service: 'meokseon-api',
      version: require('../../package.json').version,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      database: dbHealth,
    },
  });
});

// GET /api/health/ready — readiness check (DB 포함 전체 준비 상태)
router.get('/ready', async (req, res) => {
  let dbHealth;
  try {
    dbHealth = await healthCheck();
  } catch {
    dbHealth = { status: 'unavailable', error: 'healthcheck query failed' };
  }

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
