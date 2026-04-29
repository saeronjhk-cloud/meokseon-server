/**
 * 먹선(吃選) Express 앱 설정
 * 미들웨어 체인 + 라우터 마운트
 */

require('express-async-errors'); // 비동기 에러 자동 포워딩 (try/catch 없이도 errorHandler로 전달)
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');

const path = require('path');
const config = require('./config');
const logger = require('./config/logger');
const routes = require('./routes');
const swaggerDocument = require('./config/swagger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const app = express();

// ── ETag 비활성화 (304 캐시 응답 방지) ──
app.disable('etag');

// ── 보안 미들웨어 ──
// Swagger UI 경로는 helmet CSP에서 제외 (인라인 스크립트 필요)
app.use('/api-docs', helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use('/api', helmet());
app.use(cors(config.cors));

// ── 요청 파싱 ──
app.use(express.json({ limit: '15mb' }));  // OCR 이미지 base64 전송 대응
app.use(express.urlencoded({ extended: true }));

// ── HTTP 요청 로깅 (Winston 연동) ──
if (config.env !== 'test') {
  app.use(morgan(config.env === 'production' ? 'combined' : 'dev', { stream: logger.stream }));
}

// ── Rate Limiting (Redis 사용 가능 시 자동 전환) ──
const rateLimitConfig = {
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: '요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.',
    },
  },
  // TODO: 분산 환경 대비 — Redis 설치 후 아래 주석 해제
  // store: new RedisStore({ sendCommand: (...args) => redisClient.sendCommand(args) }),
};
const limiter = rateLimit(rateLimitConfig);
app.use('/api', limiter);

// ── Swagger 문서 (포트에 맞게 서버 URL 동적 설정) ──
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(
  { ...swaggerDocument, servers: [{ url: `http://localhost:${config.port}/api`, description: 'Local API' }] },
  {
    customSiteTitle: '먹선 API 문서',
    customCss: '.swagger-ui .topbar { display: none }',
    swaggerOptions: { tryItOutEnabled: true },
  }
));

// ── API 캐시 비활성화 (항상 최신 데이터 반환) ──
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// ── 정적 파일 (OCR 테스트 페이지 등) ──
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── API 라우터 ──
app.use('/api', routes);

// ── 루트 경로 ──
app.get('/', (req, res) => {
  res.json({
    service: '먹선(吃選) API',
    version: require('../package.json').version,
    docs: '/api-docs',
    health: '/api/health',
  });
});

// ── 404 + 에러 핸들링 ──
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
