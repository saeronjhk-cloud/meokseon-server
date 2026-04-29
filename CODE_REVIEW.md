# 먹선(吃選) 서버 코드 리뷰 요청

## 프로젝트 소개

**먹선(吃選)**은 한국 식품 안전 정보 앱입니다. 주요 기능은 다음과 같습니다:

- **영양 신호등(Traffic Light)**: 7개 영양성분(나트륨, 당류, 포화지방, 총지방, 콜레스테롤, 단백질, 식이섬유)에 대해 %DV + 100g/100mL 절대량 이중 기준으로 3색(녹/황/적) 판정
- **식품첨가물 위해성 분석**: 제품에 포함된 첨가물을 DB 기반으로 조회하여 위해 등급별 요약 제공
- **OCR 파이프라인**: Google Cloud Vision API를 활용한 식품 라벨 이미지 텍스트 추출 → 오인식 교정 → 원재료/첨가물/영양정보/알레르기 자동 파싱 → 신호등 판정까지의 E2E 처리

## 아키텍처 개요

| 구성 요소 | 기술 스택 |
|-----------|-----------|
| 런타임 | Node.js |
| 웹 프레임워크 | Express 4 |
| 데이터베이스 | PostgreSQL (pg 커넥션 풀) |
| OCR | Google Cloud Vision API (TEXT_DETECTION + DOCUMENT_TEXT_DETECTION) |
| 보안 | Helmet, CORS, express-rate-limit |
| 입력 검증 | express-validator |
| API 문서 | Swagger UI |

### 디렉토리 구조

```
src/
├── server.js              # 엔트리포인트
├── app.js                 # Express 앱 설정 (미들웨어 체인)
├── config/
│   ├── index.js           # 환경 설정 중앙 관리
│   └── database.js        # PostgreSQL 커넥션 풀
├── middleware/
│   └── errorHandler.js    # 중앙 에러 핸들링
├── models/
│   └── productModel.js    # 제품 데이터 모델 (SQL 쿼리 레이어)
├── routes/
│   ├── index.js           # 라우터 통합
│   ├── healthRoutes.js    # 헬스체크
│   ├── productRoutes.js   # 제품 API
│   └── ocrRoutes.js       # OCR API
└── services/
    ├── nutritionTrafficLight.js  # 영양 신호등 판정 엔진
    ├── ocrService.js             # Google Vision API 호출 + 텍스트 교정
    └── ocrParser.js              # OCR 텍스트 파싱 (원재료, 첨가물, 영양정보, 알레르기)
```

---

## 소스 코드

### `package.json`

```javascript
{
  "name": "meokseon-server",
  "version": "1.0.0",
  "description": "먹선(吃選) 식품 안전 정보 API 서버",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "dev": "NODE_ENV=development node src/server.js",
    "test": "NODE_ENV=test node tests/test_traffic_light.js && node tests/test_100_products.js && node tests/test_ocr_parser.js && node tests/test_api.js",
    "test:unit": "node tests/test_traffic_light.js",
    "test:integration": "node tests/test_100_products.js",
    "test:api": "node tests/test_api.js",
    "test:ocr": "node tests/test_ocr_parser.js",
    "migrate": "psql $DATABASE_URL -f scripts/migrations/001_init_schema.sql && psql $DATABASE_URL -f scripts/migrations/002_seed_config.sql"
  },
  "keywords": ["food-safety", "nutrition", "traffic-light", "korea"],
  "author": "Jay Kim <saeronjhk@gmail.com>",
  "license": "ISC",
  "dependencies": {
    "cors": "^2.8.6",
    "dotenv": "^17.4.2",
    "express": "^4.21.2",
    "express-rate-limit": "^8.3.2",
    "express-validator": "^7.3.2",
    "helmet": "^8.1.0",
    "morgan": "^1.10.1",
    "pg": "^8.20.0",
    "swagger-ui-express": "^5.0.1"
  }
}
```

### `src/server.js`

```javascript
/**
 * 먹선(吃選) 서버 엔트리포인트
 */

require('dotenv').config();
const app = require('./app');
const config = require('./config');

const PORT = config.port;

app.listen(PORT, () => {
  console.log(`\n🍽️  먹선(吃選) API 서버 가동`);
  console.log(`   환경: ${config.env}`);
  console.log(`   포트: ${PORT}`);
  console.log(`   API:  http://localhost:${PORT}/api`);
  console.log(`   문서: http://localhost:${PORT}/api-docs`);
  console.log(`   헬스: http://localhost:${PORT}/api/health\n`);
});
```

### `src/app.js`

```javascript
/**
 * 먹선(吃選) Express 앱 설정
 * 미들웨어 체인 + 라우터 마운트
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');

const path = require('path');
const config = require('./config');
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

// ── 로깅 ──
if (config.env !== 'test') {
  app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));
}

// ── Rate Limiting ──
const limiter = rateLimit({
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
});
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
```

### `src/config/index.js`

```javascript
/**
 * 먹선 서버 설정 중앙 관리
 */

require('dotenv').config();

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT) || 3000,

  // API 제한
  rateLimit: {
    windowMs: parseInt(process.env.API_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.API_RATE_LIMIT_MAX) || 100,
  },

  // CORS 허용 도메인
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  },
};

module.exports = config;
```

### `src/config/database.js`

```javascript
/**
 * PostgreSQL 연결 설정
 * pg Pool을 사용한 커넥션 풀 관리
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'meokseon',
  user: process.env.DB_USER || 'meokseon_app',
  password: process.env.DB_PASSWORD || '',
  min: parseInt(process.env.DB_POOL_MIN) || 2,
  max: parseInt(process.env.DB_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// 연결 이벤트 로깅
pool.on('error', (err) => {
  console.error('DB 풀 오류:', err.message);
});

/**
 * DB 쿼리 헬퍼
 * @param {string} text - SQL 쿼리
 * @param {Array} params - 파라미터
 * @returns {Promise<Object>} 쿼리 결과
 */
async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;

  if (process.env.NODE_ENV === 'development') {
    console.log(`[DB] ${duration}ms | ${text.substring(0, 80)}...`);
  }

  return result;
}

/**
 * 트랜잭션 헬퍼
 * @param {Function} callback - (client) => Promise
 * @returns {Promise<any>}
 */
async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * DB 헬스체크
 */
async function healthCheck() {
  try {
    const result = await pool.query('SELECT NOW() as now, current_database() as db');
    return {
      status: 'healthy',
      database: result.rows[0].db,
      timestamp: result.rows[0].now,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    };
  } catch (err) {
    return {
      status: 'unhealthy',
      error: err.message,
    };
  }
}

module.exports = { pool, query, transaction, healthCheck };
```

### `src/middleware/errorHandler.js`

```javascript
/**
 * 중앙 에러 핸들링 미들웨어
 */

class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
  }
}

class NotFoundError extends AppError {
  constructor(resource = '리소스') {
    super(`${resource}을(를) 찾을 수 없습니다.`, 404, 'NOT_FOUND');
  }
}

class ValidationError extends AppError {
  constructor(message = '입력값이 올바르지 않습니다.', details = null) {
    super(message, 400, 'VALIDATION_ERROR');
    this.details = details;
  }
}

/**
 * Express 에러 핸들러 미들웨어
 */
function errorHandler(err, req, res, _next) {
  // 기본값
  let statusCode = err.statusCode || 500;
  let code = err.code || 'INTERNAL_ERROR';
  let message = err.message || '서버 내부 오류가 발생했습니다.';

  // express-validator 에러
  if (err.array && typeof err.array === 'function') {
    statusCode = 400;
    code = 'VALIDATION_ERROR';
    message = '입력값 검증 실패';
  }

  // 개발 환경에서는 스택 트레이스 포함
  const response = {
    success: false,
    error: {
      code,
      message,
    },
  };

  if (err.details) {
    response.error.details = err.details;
  }

  if (process.env.NODE_ENV === 'development') {
    response.error.stack = err.stack;
  }

  // 500 에러는 로깅
  if (statusCode >= 500) {
    console.error(`[ERROR] ${req.method} ${req.path}:`, err);
  }

  res.status(statusCode).json(response);
}

/**
 * 404 핸들러
 */
function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: {
      code: 'ENDPOINT_NOT_FOUND',
      message: `${req.method} ${req.path} 엔드포인트가 존재하지 않습니다.`,
    },
  });
}

module.exports = {
  AppError,
  NotFoundError,
  ValidationError,
  errorHandler,
  notFoundHandler,
};
```

### `src/models/productModel.js`

```javascript
/**
 * 제품(Product) 데이터 모델
 * PostgreSQL 쿼리 레이어
 */

const db = require('../config/database');

/**
 * 바코드로 제품 + 영양정보 조회
 * @param {string} barcode
 * @returns {Promise<Object|null>}
 */
async function findByBarcode(barcode) {
  const result = await db.query(
    `SELECT
       p.product_id, p.barcode, p.product_name, p.brand, p.manufacturer,
       p.food_type, p.food_category, p.serving_size, p.total_content,
       p.content_unit, p.data_source, p.image_url,
       n.calories, n.total_fat, n.saturated_fat, n.trans_fat,
       n.cholesterol, n.sodium, n.total_carbs, n.total_sugars,
       n.dietary_fiber, n.protein, n.data_source AS nutrition_source,
       n.verified_at
     FROM products p
     LEFT JOIN nutrition_data n ON p.product_id = n.product_id
     WHERE p.barcode = $1
     LIMIT 1`,
    [barcode]
  );
  return result.rows[0] || null;
}

/**
 * 제품명 퍼지 검색 (trigram)
 * @param {string} query - 검색어
 * @param {number} limit - 최대 결과 수
 * @param {number} offset - 오프셋
 * @returns {Promise<Array>}
 */
async function searchByName(query, limit = 20, offset = 0) {
  const result = await db.query(
    `SELECT
       p.product_id, p.barcode, p.product_name, p.brand, p.manufacturer,
       p.food_type, p.food_category, p.serving_size, p.content_unit,
       p.image_url,
       similarity(p.product_name, $1) AS score
     FROM products p
     WHERE p.product_name % $1
        OR p.product_name ILIKE '%' || $1 || '%'
     ORDER BY similarity(p.product_name, $1) DESC, p.product_name
     LIMIT $2 OFFSET $3`,
    [query, limit, offset]
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
  const result = await db.query(
    `SELECT
       a.additive_id, a.name_ko, a.name_en, a.e_number,
       a.risk_grade, a.risk_color, a.category,
       a.description, a.max_daily_intake,
       pa.amount, pa.unit
     FROM product_additives pa
     JOIN additives a ON pa.additive_id = a.additive_id
     WHERE pa.product_id = $1
     ORDER BY a.risk_grade DESC, a.name_ko`,
    [productId]
  );
  return result.rows;
}

/**
 * 제품 ID로 신호등 캐시 조회
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
 * 신호등 판정 결과 저장/갱신
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
  getTrafficLight,
  upsertTrafficLight,
  getRecent,
};
```

### `src/routes/index.js`

```javascript
/**
 * 라우터 통합 모듈
 */

const express = require('express');
const productRoutes = require('./productRoutes');
const healthRoutes = require('./healthRoutes');
const ocrRoutes = require('./ocrRoutes');

const router = express.Router();

router.use('/health', healthRoutes);
router.use('/products', productRoutes);
router.use('/ocr', ocrRoutes);

module.exports = router;
```

### `src/routes/healthRoutes.js`

```javascript
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
```

### `src/routes/productRoutes.js`

```javascript
/**
 * 제품 API 라우터
 * /api/products
 */

const express = require('express');
const { query: checkQuery, param, validationResult } = require('express-validator');
const productModel = require('../models/productModel');
const { evaluateNutrition, sanityCheck } = require('../services/nutritionTrafficLight');
const { NotFoundError, ValidationError } = require('../middleware/errorHandler');

const router = express.Router();

// ============================================================
// 입력 검증 헬퍼
// ============================================================

function validate(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new ValidationError('입력값 검증 실패', errors.array());
  }
}

// ============================================================
// GET /api/products/search?q=검색어&limit=20&offset=0
// 제품명 퍼지 검색
// ============================================================

router.get(
  '/search',
  [
    checkQuery('q').trim().notEmpty().withMessage('검색어(q)를 입력하세요.'),
    checkQuery('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
    checkQuery('offset').optional().isInt({ min: 0 }).toInt(),
  ],
  async (req, res, next) => {
    try {
      validate(req);
      const { q, limit = 20, offset = 0 } = req.query;
      const products = await productModel.searchByName(q, limit, offset);

      res.json({
        success: true,
        data: {
          query: q,
          count: products.length,
          products,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================
// GET /api/products/recent?limit=20
// 최근 등록 제품
// ============================================================

router.get(
  '/recent',
  [checkQuery('limit').optional().isInt({ min: 1, max: 50 }).toInt()],
  async (req, res, next) => {
    try {
      const { limit = 20 } = req.query;
      const products = await productModel.getRecent(limit);

      res.json({
        success: true,
        data: { count: products.length, products },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================
// GET /api/products/:barcode
// 바코드로 제품 조회 + 영양 신호등 판정
// ============================================================

router.get(
  '/:barcode',
  [
    param('barcode')
      .trim()
      .matches(/^\d{8,14}$/)
      .withMessage('바코드는 8~14자리 숫자입니다.'),
  ],
  async (req, res, next) => {
    try {
      validate(req);
      const product = await productModel.findByBarcode(req.params.barcode);

      if (!product) {
        throw new NotFoundError('제품');
      }

      // 영양정보가 있으면 신호등 판정
      let trafficLight = null;
      if (product.sodium !== null || product.calories !== null) {
        trafficLight = evaluateNutrition(
          {
            product_name: product.product_name,
            food_type: product.food_type,
            content_unit: product.content_unit,
            serving_size: product.serving_size,
            total_content: product.total_content,
          },
          {
            calories: product.calories,
            sodium: product.sodium,
            sugars: product.total_sugars,
            sat_fat: product.saturated_fat,
            total_fat: product.total_fat,
            cholesterol: product.cholesterol,
            protein: product.protein,
            fiber: product.dietary_fiber,
            trans_fat: product.trans_fat,
          }
        );
      }

      res.json({
        success: true,
        data: {
          product: {
            product_id: product.product_id,
            barcode: product.barcode,
            product_name: product.product_name,
            brand: product.brand,
            manufacturer: product.manufacturer,
            food_type: product.food_type,
            food_category: product.food_category,
            serving_size: product.serving_size,
            total_content: product.total_content,
            content_unit: product.content_unit,
            image_url: product.image_url,
            data_source: product.data_source,
          },
          nutrition: product.calories !== null ? {
            calories: product.calories,
            total_fat: product.total_fat,
            saturated_fat: product.saturated_fat,
            trans_fat: product.trans_fat,
            cholesterol: product.cholesterol,
            sodium: product.sodium,
            total_carbs: product.total_carbs,
            total_sugars: product.total_sugars,
            dietary_fiber: product.dietary_fiber,
            protein: product.protein,
            source: product.nutrition_source,
            verified_at: product.verified_at,
          } : null,
          traffic_light: trafficLight,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================
// GET /api/products/:barcode/additives
// 제품 첨가물 목록 + 위해성
// ============================================================

router.get(
  '/:barcode/additives',
  [
    param('barcode')
      .trim()
      .matches(/^\d{8,14}$/)
      .withMessage('바코드는 8~14자리 숫자입니다.'),
  ],
  async (req, res, next) => {
    try {
      validate(req);
      const product = await productModel.findByBarcode(req.params.barcode);

      if (!product) {
        throw new NotFoundError('제품');
      }

      const additives = await productModel.getAdditives(product.product_id);

      // 위해성 요약
      const riskSummary = {
        total: additives.length,
        by_color: {
          blue: additives.filter(a => a.risk_color === 'blue').length,
          yellow: additives.filter(a => a.risk_color === 'yellow').length,
          red: additives.filter(a => a.risk_color === 'red').length,
          gray: additives.filter(a => a.risk_color === 'gray').length,
        },
      };

      res.json({
        success: true,
        data: {
          product_id: product.product_id,
          product_name: product.product_name,
          additives,
          risk_summary: riskSummary,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================
// POST /api/products/evaluate
// 수동 영양 신호등 판정 (DB 조회 없이 직접 입력)
// ============================================================

router.post('/evaluate', async (req, res, next) => {
  try {
    const { product, nutrition } = req.body;

    if (!product || !nutrition) {
      throw new ValidationError('product와 nutrition 객체가 필요합니다.');
    }

    if (!product.serving_size || product.serving_size <= 0) {
      throw new ValidationError('serving_size는 양수여야 합니다.');
    }

    // OCR Sanity Check
    const warnings = sanityCheck(nutrition, product.serving_size);

    // 신호등 판정
    const result = evaluateNutrition(product, nutrition);

    res.json({
      success: true,
      data: {
        evaluation: result,
        sanity_warnings: warnings,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
```

### `src/routes/ocrRoutes.js`

```javascript
/**
 * OCR API 라우터
 * /api/ocr
 */

const express = require('express');
const { callVisionAPI, correctOcrText, MAX_FILE_SIZE_MB } = require('../services/ocrService');
const { analyzeText } = require('../services/ocrParser');
const { evaluateNutrition, sanityCheck } = require('../services/nutritionTrafficLight');
const { ValidationError } = require('../middleware/errorHandler');

const router = express.Router();

// ============================================================
// POST /api/ocr/analyze
// 식품 라벨 이미지 OCR 분석 (E2E 파이프라인)
// ============================================================

router.post('/analyze', async (req, res, next) => {
  try {
    const { image, product_info } = req.body;

    // 입력 검증
    if (!image) {
      throw new ValidationError('image (base64 인코딩 이미지)가 필요합니다.');
    }

    if (typeof image !== 'string') {
      throw new ValidationError('image는 base64 문자열이어야 합니다.');
    }

    // 최소 길이 체크 (유효한 이미지인지)
    const cleanBase64 = image.replace(/^data:image\/\w+;base64,/, '');
    if (cleanBase64.length < 100) {
      throw new ValidationError('유효하지 않은 이미지 데이터입니다.');
    }

    console.log(`[OCR] 분석 시작 (이미지 크기: ${(cleanBase64.length * 0.75 / 1024).toFixed(0)}KB)`);

    // Step 1: Google Vision OCR
    const ocrResult = await callVisionAPI(image);

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

    // Step 2: OCR 텍스트 교정
    const { corrected, corrections } = correctOcrText(ocrResult.full_text);

    // Step 3: 텍스트 분석 (원재료, 첨가물, 영양정보, 알레르기)
    const analysis = analyzeText(corrected);

    // Step 4: 영양 신호등 판정 (영양정보가 추출된 경우)
    let trafficLight = null;
    let sanityWarnings = [];

    const nutrition = analysis.nutrition;
    const hasNutrition = nutrition.calories || nutrition.sodium || nutrition.total_sugars;

    if (hasNutrition) {
      // product_info가 제공되면 사용, 아니면 OCR에서 추출한 정보 사용
      const productData = {
        product_name: product_info?.product_name || '(OCR 분석)',
        food_type: product_info?.food_type || '',
        content_unit: nutrition.serving_unit || product_info?.content_unit || 'g',
        serving_size: nutrition.serving_size || product_info?.serving_size || 100,
        total_content: product_info?.total_content || null,
      };

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

      // Sanity check
      sanityWarnings = sanityCheck(nutritionData, productData.serving_size);

      // 신호등 판정
      trafficLight = evaluateNutrition(productData, nutritionData);
    }

    // 응답
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
          allergens: analysis.allergens,
        },
        traffic_light: trafficLight,
        sanity_warnings: sanityWarnings,
      },
    });

  } catch (err) {
    next(err);
  }
});

// ============================================================
// POST /api/ocr/text-only
// 텍스트만 추출 (분석 없이)
// ============================================================

router.post('/text-only', async (req, res, next) => {
  try {
    const { image } = req.body;

    if (!image) {
      throw new ValidationError('image (base64 인코딩 이미지)가 필요합니다.');
    }

    const ocrResult = await callVisionAPI(image);
    const { corrected, corrections } = correctOcrText(ocrResult.full_text);

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

  } catch (err) {
    next(err);
  }
});

module.exports = router;
```

### `src/services/nutritionTrafficLight.js`

```javascript
/**
 * 먹선(吃選) 영양 신호등 판정 서비스 v1.3
 *
 * 핵심 원칙:
 * - 7개 영양소 각각 독립적 3색 판정 (종합 점수 없음)
 * - 이중 기준: %DV + 100g/100mL 절대량 중 더 나쁜 쪽 적용
 * - 건조식품 예외: 100g 기준 면제, %DV만 적용
 * - 권장 영양성분 적색 피로감 방지: 5% DV 미만 → gray
 * - Config DB에서 기준값 로드 (하드코딩 금지)
 */

// ============================================================
// 1. Config 로더 (DB 또는 인메모리)
// ============================================================

/**
 * nutrition_config 테이블에서 기준값을 로드한다.
 * 실제 운영에서는 DB 쿼리, 여기서는 인메모리 캐시로 대체 가능.
 *
 * @param {Object} db - 데이터베이스 클라이언트
 * @param {string} profile - 'adult', 'child', 'pregnant' 등
 * @returns {Object} configMap - { nutrient: { basis: { threshold: value } } }
 */
async function loadConfig(db, profile = 'adult') {
  const query = `
    SELECT nutrient, threshold, basis, value, unit
    FROM nutrition_config
    WHERE profile = $1
      AND effective_from <= CURRENT_DATE
      AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
    ORDER BY nutrient, basis, threshold
  `;
  const rows = await db.query(query, [profile]);

  const configMap = {};
  for (const row of rows.rows) {
    if (!configMap[row.nutrient]) configMap[row.nutrient] = {};
    if (!configMap[row.nutrient][row.basis]) configMap[row.nutrient][row.basis] = {};
    configMap[row.nutrient][row.basis][row.threshold] = parseFloat(row.value);
  }

  return configMap;
}

// ============================================================
// 2. 인메모리 기본 Config (DB 없이 독립 실행용)
// ============================================================

const DEFAULT_CONFIG = {
  // DV 기준치
  dv: {
    calories: 2000,
    total_fat: 54,
    sat_fat: 15,
    cholesterol: 300,
    sodium: 2000,
    sugars: 100,
    fiber: 25,
    protein: 55,
  },

  // 제한 영양성분 %DV 컷오프
  negative_pct_dv: {
    sodium:      { green_max: 10, yellow_max: 25 },
    sugars:      { green_max: 10, yellow_max: 25 },
    sat_fat:     { green_max: 10, yellow_max: 25 },
    total_fat:   { green_max: 10, yellow_max: 25 },
    cholesterol: { green_max: 10, yellow_max: 25 },
  },

  // 100g당 절대량 컷오프 (일반식품)
  per_100g: {
    sodium:    { green_max: 120, yellow_max: 600 },
    sugars:    { green_max: 5,   yellow_max: 15 },
    sat_fat:   { green_max: 1.5, yellow_max: 5 },
    total_fat: { green_max: 3,   yellow_max: 17.5 },
  },

  // 100mL당 절대량 컷오프 (음료)
  per_100ml: {
    sodium:    { green_max: 50,   yellow_max: 250 },
    sugars:    { green_max: 2.5,  yellow_max: 6.3 },
    sat_fat:   { green_max: 0.75, yellow_max: 2.5 },
    total_fat: { green_max: 1.5,  yellow_max: 8.75 },
  },

  // 권장 영양성분 %DV 컷오프 (역방향)
  positive_pct_dv: {
    protein: { gray_max: 5, green_min: 15 },
    fiber:   { gray_max: 5, green_min: 15 },
  },

  // 트랜스지방 (별도 규칙)
  trans_fat: {
    green_max: 0,
    yellow_max: 0.5,
  },
};

// ============================================================
// 3. 식품 유형 판별
// ============================================================

/**
 * 음료 여부를 판별한다 (영양 신호등 v1.3 §4.2).
 *
 * 우선순위:
 * 1. C005 API 식품유형 코드
 * 2. 내용량 단위 (mL, L → 음료)
 * 3. 제품명 키워드 ('음료', '주스', '워터', '차', '우유')
 * 4. Silent Fallback → 일반식품
 */
function detectFoodCategory(product) {
  // 1. 식품유형 코드 기반
  const beverageTypes = ['음료류', '탄산음료', '과·채주스', '두유류', '커피', '차류', '혼합음료', '과채음료'];
  const driedTypes = ['육포', '건포류', '건과류', '김류', '장류'];
  const alcoholTypes = ['주류', '맥주', '소주', '와인', '위스키', '탁주'];
  const supplementTypes = ['건강기능식품', '영양보충용식품'];

  // 비음료 식품유형 (content_unit이 mL이어도 음료가 아닌 경우)
  const nonBeverageTypes = ['유지류', '식용유지', '올리브유', '참기름', '들기름', '식초', '소스류', '드레싱', '액상차'];
  // 발효식품 식품유형 (건조 키워드보다 우선)
  const fermentedTypes = ['김치류', '장류', '발효유류', '발효식품'];

  if (product.food_type) {
    if (alcoholTypes.some(t => product.food_type.includes(t))) return 'alcohol';
    if (supplementTypes.some(t => product.food_type.includes(t))) return 'supplement';
    if (fermentedTypes.some(t => product.food_type.includes(t))) return 'fermented';
    if (beverageTypes.some(t => product.food_type.includes(t))) return 'beverage';
    if (driedTypes.some(t => product.food_type.includes(t))) return 'dried';
  }

  // 2. 내용량 단위 기반 (비음료 식품유형 제외)
  if (product.content_unit) {
    const unit = product.content_unit.toLowerCase();
    if (unit === 'ml' || unit === 'l') {
      // 식용유 등 비음료 제외
      const isNonBeverage = product.food_type && nonBeverageTypes.some(t => product.food_type.includes(t));
      if (!isNonBeverage) return 'beverage';
    }
  }

  // 3. 제품명 키워드 기반 (발효 > 건조 > 음료 순서로 체크)
  if (product.product_name) {
    const name = product.product_name;
    const fermentedKeywords = ['김치', '된장', '간장', '젓갈', '청국장', '고추장'];
    const beverageKeywords = ['음료', '주스', '워터', '우유', '두유', '커피', '콜라', '사이다', '에이드'];
    // '김'은 '김치'와 구분하기 위해 정규식으로 체크 (김치/김밥 등 제외)
    const driedKeywords = ['육포', '말린', '건조', '분말', '가루', '건과', '누룽지', '미역', '다시마'];

    // 발효식품 우선 체크
    if (fermentedKeywords.some(k => name.includes(k))) return 'fermented';
    if (beverageKeywords.some(k => name.includes(k))) return 'beverage';
    if (driedKeywords.some(k => name.includes(k))) return 'dried';
    // '김'은 단독 또는 조미김/구운김 등일 때만 건조식품 (김치, 김밥 제외)
    if (/김(?!치|밥)/.test(name) && name.includes('김')) return 'dried';
  }

  // 4. Silent Fallback → 일반식품
  return 'general';
}

// ============================================================
// 4. 핵심 판정 로직
// ============================================================

/**
 * %DV를 계산한다.
 */
function calcPctDV(amount, dvValue) {
  if (!dvValue || dvValue === 0) return null;
  return (amount / dvValue) * 100;
}

/**
 * 100g/100mL당 환산값을 계산한다.
 */
function calcPer100(amountPerServing, servingSize) {
  if (!servingSize || servingSize === 0) return null;
  return (amountPerServing / servingSize) * 100;
}

/**
 * 제한 영양성분(negative)의 색상을 판정한다.
 *
 * @param {number} pctDV - %DV 값
 * @param {Object} dvCutoffs - { green_max, yellow_max }
 * @returns {string} 'green' | 'yellow' | 'red'
 */
function judgeNegativeByPctDV(pctDV, cutoffs) {
  if (pctDV === null || pctDV === undefined) return null;
  if (pctDV <= cutoffs.green_max) return 'green';
  if (pctDV <= cutoffs.yellow_max) return 'yellow';
  return 'red';
}

/**
 * 100g/100mL 절대량 기준으로 색상을 판정한다.
 */
function judgeByAbsolute(per100Value, cutoffs) {
  if (per100Value === null || per100Value === undefined) return null;
  if (per100Value <= cutoffs.green_max) return 'green';
  if (per100Value <= cutoffs.yellow_max) return 'yellow';
  return 'red';
}

/**
 * 권장 영양성분(positive)의 색상을 판정한다.
 * 적색 피로감 방지: 5% DV 미만 → gray
 */
function judgePositive(pctDV, cutoffs) {
  if (pctDV === null || pctDV === undefined) return null;
  if (pctDV < cutoffs.gray_max) return 'gray';
  if (pctDV >= cutoffs.green_min) return 'green';
  return 'yellow';
}

/**
 * 트랜스지방 특별 규칙.
 */
function judgeTransFat(amount, cutoffs) {
  if (amount === null || amount === undefined) return null;
  if (amount <= cutoffs.green_max) return 'green';
  if (amount <= cutoffs.yellow_max) return 'yellow';
  return 'red';
}

/**
 * 두 색상 중 더 나쁜(높은) 쪽을 반환한다.
 * 순서: green < yellow < red
 */
function worseColor(colorA, colorB) {
  const order = { green: 0, yellow: 1, red: 2 };
  if (colorA === null) return colorB;
  if (colorB === null) return colorA;
  return order[colorA] >= order[colorB] ? colorA : colorB;
}

// ============================================================
// 5. OCR Sanity Check
// ============================================================

const SANITY_LIMITS = {
  calories:    { per_serving: 2000, per_100g: 900 },
  sodium:      { per_serving: 5000, per_100g: 40000 },
  sugars:      { per_serving: 200,  per_100g: 100 },
  total_fat:   { per_serving: 200,  per_100g: 100 },
  sat_fat:     { per_serving: 100,  per_100g: 100 },
  protein:     { per_serving: 200,  per_100g: 100 },
  cholesterol: { per_serving: 2000, per_100g: null },
  trans_fat:   { per_serving: 50,   per_100g: 100 },
  fiber:       { per_serving: 100,  per_100g: 100 },
};

/**
 * OCR 데이터 Sanity Check.
 * @returns {Array} 경고 목록 [{ nutrient, value, limit, type }]
 */
function sanityCheck(nutritionData, servingSize) {
  const warnings = [];

  for (const [nutrient, limits] of Object.entries(SANITY_LIMITS)) {
    const value = nutritionData[nutrient];
    if (value === null || value === undefined) continue;

    // 음수 차단
    if (value < 0) {
      warnings.push({ nutrient, value, limit: 0, type: 'negative_value' });
      continue;
    }

    // 1회 제공량 상한
    if (limits.per_serving !== null && value > limits.per_serving) {
      warnings.push({ nutrient, value, limit: limits.per_serving, type: 'per_serving_exceeded' });
    }

    // 100g당 상한
    if (limits.per_100g !== null && servingSize > 0) {
      const per100 = calcPer100(value, servingSize);
      if (per100 > limits.per_100g) {
        warnings.push({ nutrient, value: per100, limit: limits.per_100g, type: 'per_100g_exceeded' });
      }
    }
  }

  // 포화지방 > 총지방 체크
  if (nutritionData.sat_fat != null && nutritionData.total_fat != null) {
    if (nutritionData.sat_fat > nutritionData.total_fat) {
      warnings.push({ nutrient: 'sat_fat', value: nutritionData.sat_fat, limit: nutritionData.total_fat, type: 'exceeds_total_fat' });
    }
  }

  // 1회 제공량 > 총내용량 체크
  if (servingSize && nutritionData._totalContent && servingSize > nutritionData._totalContent) {
    warnings.push({ nutrient: 'serving_size', value: servingSize, limit: nutritionData._totalContent, type: 'serving_exceeds_total' });
  }

  return warnings;
}

// ============================================================
// 6. 메인 판정 함수
// ============================================================

/**
 * 영양 신호등 전체 판정을 수행한다.
 *
 * @param {Object} product - 제품 정보 { product_name, food_type, content_unit, serving_size, total_content, ... }
 * @param {Object} nutrition - 영양성분 { calories, sodium, sugars, sat_fat, total_fat, cholesterol, protein, fiber, trans_fat }
 * @param {Object} [config] - 기준값 (없으면 DEFAULT_CONFIG 사용)
 * @returns {Object} 판정 결과
 */
function evaluateNutrition(product, nutrition, config = DEFAULT_CONFIG) {
  const result = {
    product_name: product.product_name,
    food_category: null,
    is_excluded: false,
    exclude_reason: null,
    is_dried_exception: false,
    nutrients: {},
    calories: null,
    context_messages: [],
    sanity_warnings: [],
    multi_serving: null,
  };

  // ----------------------------------------------------------
  // Step 0: 스코프 필터 — 평가 대상 여부 확인
  // ----------------------------------------------------------
  const category = detectFoodCategory(product);
  result.food_category = category;

  const excludedCategories = ['alcohol', 'supplement', 'raw_ingredient'];
  if (excludedCategories.includes(category)) {
    result.is_excluded = true;
    result.exclude_reason = category;
    return result;
  }

  // ----------------------------------------------------------
  // Step 1: 식품 유형 분류 + 기준 선택
  // ----------------------------------------------------------
  const isBeverage = category === 'beverage';
  const isDried = category === 'dried';
  const absoluteBasis = isBeverage ? config.per_100ml : config.per_100g;

  result.is_dried_exception = isDried;

  // ----------------------------------------------------------
  // Sanity Check
  // ----------------------------------------------------------
  result.sanity_warnings = sanityCheck(nutrition, product.serving_size);

  // ----------------------------------------------------------
  // Step 2-4: 각 영양성분별 판정
  // ----------------------------------------------------------
  const servingSize = product.serving_size || 100;
  const dv = config.dv;

  // --- 제한 영양성분 (Negative) ---
  const negativeNutrients = ['sodium', 'sugars', 'sat_fat', 'total_fat', 'cholesterol'];

  for (const nutrient of negativeNutrients) {
    const amount = nutrition[nutrient];

    if (amount === null || amount === undefined) {
      result.nutrients[nutrient] = { color: null, pct_dv: null, per_100: null, basis: null, data: 'missing' };
      continue;
    }

    // 기준 A: %DV
    const pctDV = calcPctDV(amount, dv[nutrient]);
    const colorA = judgeNegativeByPctDV(pctDV, config.negative_pct_dv[nutrient]);

    // 기준 B: 100g/100mL 절대량 (콜레스테롤은 제외)
    let per100 = null;
    let colorB = null;
    let finalBasis = 'pct_dv';

    const hasAbsoluteThreshold = nutrient !== 'cholesterol' && absoluteBasis[nutrient];

    if (hasAbsoluteThreshold && !isDried) {
      per100 = calcPer100(amount, servingSize);
      colorB = judgeByAbsolute(per100, absoluteBasis[nutrient]);
    }

    // Step 3: 더 나쁜 쪽 적용
    let finalColor;
    if (colorB !== null) {
      finalColor = worseColor(colorA, colorB);
      const orderMap = { green: 0, yellow: 1, red: 2 };
      finalBasis = (orderMap[colorB] || 0) > (orderMap[colorA] || 0) ? (isBeverage ? 'per_100ml' : 'per_100g') : 'pct_dv';
    } else {
      finalColor = colorA;
      finalBasis = 'pct_dv';
    }

    result.nutrients[nutrient] = {
      color: finalColor,
      pct_dv: pctDV !== null ? Math.round(pctDV * 10) / 10 : null,
      per_100: per100 !== null ? Math.round(per100 * 100) / 100 : null,
      basis: finalBasis,
      data: 'present',
    };
  }

  // --- 권장 영양성분 (Positive) ---
  const positiveNutrients = ['protein', 'fiber'];

  for (const nutrient of positiveNutrients) {
    const amount = nutrition[nutrient];

    if (amount === null || amount === undefined) {
      result.nutrients[nutrient] = { color: null, pct_dv: null, basis: null, data: 'missing' };
      continue;
    }

    const pctDV = calcPctDV(amount, dv[nutrient]);
    const color = judgePositive(pctDV, config.positive_pct_dv[nutrient]);

    result.nutrients[nutrient] = {
      color,
      pct_dv: pctDV !== null ? Math.round(pctDV * 10) / 10 : null,
      basis: 'pct_dv',
      data: 'present',
    };
  }

  // --- 트랜스지방 (별도 규칙) ---
  const transFatAmount = nutrition.trans_fat;
  if (transFatAmount !== null && transFatAmount !== undefined) {
    const tfColor = judgeTransFat(transFatAmount, config.trans_fat);
    result.nutrients.trans_fat = {
      color: tfColor,
      amount: transFatAmount,
      basis: 'absolute',
      data: 'present',
      // 0g 투명성 툴팁
      tooltip: transFatAmount === 0
        ? '식약처 규정에 따라 0.2g 미만은 0g으로 표시될 수 있습니다.'
        : null,
    };
  } else {
    result.nutrients.trans_fat = { color: null, amount: null, basis: null, data: 'missing' };
  }

  // --- 열량 (색상 판정 없음) ---
  if (nutrition.calories !== null && nutrition.calories !== undefined) {
    const calPctDV = calcPctDV(nutrition.calories, dv.calories);
    result.calories = {
      amount: nutrition.calories,
      pct_dv: calPctDV !== null ? Math.round(calPctDV * 10) / 10 : null,
      unit: 'kcal',
    };
  }

  // ----------------------------------------------------------
  // 다회 제공량 처리
  // ----------------------------------------------------------
  if (product.serving_size && product.total_content && product.total_content > product.serving_size) {
    const servingsCount = Math.round((product.total_content / product.serving_size) * 10) / 10;
    if (servingsCount > 1) {
      result.multi_serving = {
        servings_per_container: servingsCount,
        message: `이 제품은 ${servingsCount}회분입니다. 전량 섭취 시 수치가 ${servingsCount}배가 됩니다.`,
      };
    }
  }

  // ----------------------------------------------------------
  // 맥락 안내 메시지
  // ----------------------------------------------------------
  if (isDried) {
    result.context_messages.push('건조식품으로 100g당 수치가 높게 표시됩니다. 1회 제공량 기준으로 판정하였습니다.');
  }
  if (category === 'fermented') {
    result.context_messages.push('발효식품은 나트륨이 높으나, 유산균·식이섬유 등 건강 유익 성분이 함께 포함되어 있습니다.');
  }
  if (category === 'nuts') {
    result.context_messages.push('지방 함량이 높지만, 불포화지방산이 풍부한 건강한 지방입니다.');
  }

  return result;
}

// ============================================================
// 7. 결과 포맷터 (CLI 출력용)
// ============================================================

function formatResult(result) {
  if (result.is_excluded) {
    const reasons = {
      alcohol: '주류는 영양 신호등 평가 대상이 아닙니다.',
      supplement: '건강기능식품은 별도 기준이 적용됩니다.',
      raw_ingredient: '원료 식품은 영양성분표가 부착되지 않는 미가공 제품입니다.',
    };
    return `⛔ ${result.product_name}: ${reasons[result.exclude_reason] || '평가 대상 외'}`;
  }

  const colorEmoji = { green: '🟢', yellow: '🟡', red: '🔴', gray: '⚪' };
  const lines = [];

  lines.push(`┌─── ${result.product_name} ───`);
  lines.push(`│  카테고리: ${result.food_category}${result.is_dried_exception ? ' (건조식품 예외 적용)' : ''}`);
  lines.push('│');

  // 열량
  if (result.calories) {
    lines.push(`│  열량      ${result.calories.amount}kcal   ${result.calories.pct_dv}%`);
  }

  // 영양소 신호등
  const nutrientNames = {
    sodium: '나트륨', sugars: '당류', sat_fat: '포화지방', total_fat: '지방',
    cholesterol: '콜레스테롤', protein: '단백질', fiber: '식이섬유', trans_fat: '트랜스지방',
  };

  for (const [key, name] of Object.entries(nutrientNames)) {
    const n = result.nutrients[key];
    if (!n || n.data === 'missing') {
      lines.push(`│  ${name.padEnd(6, '　')}  데이터 없음`);
      continue;
    }
    const emoji = colorEmoji[n.color] || '❓';
    const dvStr = n.pct_dv !== null && n.pct_dv !== undefined ? `${n.pct_dv}%` : '';
    const per100Str = n.per_100 !== null && n.per_100 !== undefined ? ` (100g: ${n.per_100})` : '';
    lines.push(`│  ${name.padEnd(6, '　')}  ${emoji} ${dvStr}${per100Str}  [${n.basis}]`);

    if (n.tooltip) {
      lines.push(`│    ⓘ ${n.tooltip}`);
    }
  }

  // 다회 제공량
  if (result.multi_serving) {
    lines.push('│');
    lines.push(`│  ⚠️ ${result.multi_serving.message}`);
  }

  // 맥락 메시지
  if (result.context_messages.length > 0) {
    lines.push('│');
    for (const msg of result.context_messages) {
      lines.push(`│  💬 ${msg}`);
    }
  }

  // Sanity 경고
  if (result.sanity_warnings.length > 0) {
    lines.push('│');
    for (const w of result.sanity_warnings) {
      lines.push(`│  ⚠️ Sanity: ${w.nutrient} ${w.type} (값: ${w.value}, 상한: ${w.limit})`);
    }
  }

  lines.push('└───────────────────────');
  return lines.join('\n');
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  DEFAULT_CONFIG,
  loadConfig,
  detectFoodCategory,
  calcPctDV,
  calcPer100,
  evaluateNutrition,
  sanityCheck,
  formatResult,
};
```

### `src/services/ocrService.js`

```javascript
/**
 * Google Cloud Vision OCR 서비스
 * 식품 라벨 이미지에서 텍스트를 추출하고 교정합니다.
 */

const https = require('https');
const http = require('http');

// ============================================================
// 설정
// ============================================================

const VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY;
const VISION_URL = process.env.GOOGLE_VISION_URL || 'https://vision.googleapis.com/v1/images:annotate';
const MAX_FILE_SIZE_MB = parseInt(process.env.OCR_MAX_FILE_SIZE_MB) || 10;
const MAX_RETRIES = parseInt(process.env.OCR_MAX_RETRIES) || 3;
const TIMEOUT_MS = parseInt(process.env.OCR_TIMEOUT_MS) || 30000;

// ============================================================
// OCR 오인식 교정 사전
// ============================================================

const OCR_CORRECTIONS = {
  // 영양성분 관련
  '탄백질': '단백질', '브랜스지방': '트랜스지방', '포화지방샨': '포화지방산',
  '나드륨': '나트륨', '나뜨륨': '나트륨', '나트류': '나트륨',
  '콜래스테롤': '콜레스테롤', '콜레스태롤': '콜레스테롤',
  '탄수확물': '탄수화물', '탄수화뭘': '탄수화물',
  '열렁': '열량', '열랑': '열량', '엻량': '열량',
  '당뉴': '당류', '식이섬류': '식이섬유', '식이섬우': '식이섬유',
  '총내용렁': '총내용량', '영양성붂': '영양성분',
  // 원재료 관련
  '원재료멍': '원재료명', '게란': '계란', '겨란': '계란',
  '견과뉴': '견과류', '갑갂류': '갑각류', '땅공': '땅콩',
  '아황산뉴': '아황산류', '토마도': '토마토', '글류텐': '글루텐',
  // 첨가물 관련
  '아질산나뜨륨': '아질산나트륨', '안식향산나뜨륨': '안식향산나트륨',
  'L-글루타민산나뜨륨': 'L-글루타민산나트륨', '소르빈산갈뉨': '소르빈산칼륨',
  '삭카린나뜨륨': '삭카린나트륨', '차아황산나뜨륨': '차아황산나트륨',
};

// ============================================================
// Google Cloud Vision API 호출
// ============================================================

/**
 * base64 인코딩된 이미지로 Vision API를 호출합니다.
 * @param {string} base64Image - base64 인코딩된 이미지 데이터
 * @returns {Promise<Object>} OCR 결과
 */
async function callVisionAPI(base64Image) {
  if (!VISION_API_KEY) {
    throw new Error('GOOGLE_VISION_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.');
  }

  // base64 데이터에서 접두사 제거 (data:image/png;base64, 등)
  const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, '');

  // 파일 크기 체크 (base64는 원본의 ~1.33배)
  const estimatedSizeMB = (cleanBase64.length * 0.75) / (1024 * 1024);
  if (estimatedSizeMB > MAX_FILE_SIZE_MB) {
    throw new Error(`이미지 크기(${estimatedSizeMB.toFixed(1)}MB)가 제한(${MAX_FILE_SIZE_MB}MB)을 초과합니다.`);
  }

  const payload = {
    requests: [{
      image: { content: cleanBase64 },
      features: [
        { type: 'TEXT_DETECTION', maxResults: 1 },
        { type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 },
      ],
      imageContext: {
        languageHints: ['ko', 'en'],
      },
    }],
  };

  const url = `${VISION_URL}?key=${VISION_API_KEY}`;

  // 재시도 로직
  let lastError = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const start = Date.now();
      const result = await httpPost(url, payload);
      const elapsed = Date.now() - start;

      const response = result.responses?.[0];
      if (!response) {
        throw new Error('Vision API 빈 응답');
      }

      if (response.error) {
        throw new Error(`Vision API 오류: ${response.error.message || '알 수 없는 오류'}`);
      }

      // DOCUMENT_TEXT_DETECTION 결과 우선 사용
      const fullTextAnnotation = response.fullTextAnnotation || {};
      let fullText = fullTextAnnotation.text || '';

      // fallback: TEXT_DETECTION
      if (!fullText) {
        const textAnnotations = response.textAnnotations || [];
        if (textAnnotations.length > 0) {
          fullText = textAnnotations[0].description || '';
        }
      }

      // 블록별 텍스트 + 신뢰도
      const blocks = [];
      for (const page of fullTextAnnotation.pages || []) {
        for (const block of page.blocks || []) {
          let blockText = '';
          const blockConfidence = block.confidence || 0;
          for (const paragraph of block.paragraphs || []) {
            for (const word of paragraph.words || []) {
              const wordText = (word.symbols || [])
                .map(s => s.text || '')
                .join('');
              blockText += wordText;
            }
            blockText += '\n';
          }
          blocks.push({
            text: blockText.trim(),
            confidence: blockConfidence,
          });
        }
      }

      const avgConfidence = blocks.length > 0
        ? blocks.reduce((sum, b) => sum + b.confidence, 0) / blocks.length
        : 0;

      return {
        full_text: fullText,
        blocks,
        block_count: blocks.length,
        avg_confidence: Math.round(avgConfidence * 1000) / 1000,
        elapsed_ms: elapsed,
      };

    } catch (err) {
      lastError = err;
      // 재시도 가능한 에러인 경우만 대기
      if (attempt < MAX_RETRIES - 1 && isRetryable(err)) {
        const wait = (attempt + 1) * 3000;
        console.log(`  [OCR] ${err.message}, ${wait / 1000}초 후 재시도 (${attempt + 1}/${MAX_RETRIES})...`);
        await sleep(wait);
      } else {
        throw err;
      }
    }
  }

  throw lastError;
}

// ============================================================
// OCR 텍스트 교정
// ============================================================

/**
 * OCR 오인식 텍스트를 교정합니다.
 * @param {string} text - 원본 OCR 텍스트
 * @returns {{ corrected: string, corrections: string[] }}
 */
function correctOcrText(text) {
  let corrected = text;
  const corrections = [];

  for (const [wrong, right] of Object.entries(OCR_CORRECTIONS)) {
    if (corrected.includes(wrong)) {
      corrected = corrected.split(wrong).join(right);
      corrections.push(`${wrong}→${right}`);
    }
  }

  return { corrected, corrections };
}

// ============================================================
// 헬퍼 함수
// ============================================================

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: TIMEOUT_MS,
    };

    const req = transport.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => { responseData += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const err = new Error(`HTTP ${res.statusCode}: ${responseData.substring(0, 200)}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(responseData));
        } catch {
          reject(new Error('응답 JSON 파싱 실패'));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`API 타임아웃 (${TIMEOUT_MS / 1000}초)`));
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function isRetryable(err) {
  const code = err.statusCode;
  return code === 403 || code === 429 || code === 500 || code === 503;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  callVisionAPI,
  correctOcrText,
  OCR_CORRECTIONS,
  MAX_FILE_SIZE_MB,
};
```

### `src/services/ocrParser.js`

```javascript
/**
 * OCR 텍스트 파서
 * 원재료명 파싱, 첨가물 식별, 영양정보 추출, 알레르기 탐지
 * Python 09_google_vision_ocr.py에서 포팅
 */

// ============================================================
// 1. 원재료명 섹션 추출
// ============================================================

/**
 * 전체 OCR 텍스트에서 원재료명 섹션만 추출합니다.
 * @param {string} text - 교정된 OCR 텍스트
 * @returns {string|null}
 */
function extractIngredientSection(text) {
  // 특수문자 bullet 제거
  const cleaned = text.replace(/[●▶■□◆◇▷▸•·|]/g, ' ');

  // 종료 키워드
  const endKeywords = '(?=영양(?:정보|성분)|유통기한|보관방법|내용량|포장재질|' +
    '품목보고|※|주의사항|직사광선|부정\\s*[·.]|반품|고객상담|' +
    '업소명|제조원|판매원|\\d{10,})';

  const patterns = [
    new RegExp(`원재료명\\s*(?:및\\s*)?(?:함량)?\\s*[:\\s]\\s*(.+?)${endKeywords}`, 's'),
    new RegExp(`원재료명\\s*(.+?)${endKeywords}`, 's'),
    new RegExp(`원재료\\s*[:\\s]\\s*(.+?)${endKeywords}`, 's'),
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match && match[1].trim().length >= 10) {
      return match[1].trim();
    }
  }

  // 라면류 특수 케이스
  const ramenPattern = new RegExp(`\\*?면\\s*[:]\\s*(.+?)${endKeywords}`, 's');
  const ramenMatch = cleaned.match(ramenPattern);
  if (ramenMatch && ramenMatch[1].trim().length >= 10) {
    return ramenMatch[1].trim();
  }

  return null;
}

// ============================================================
// 2. 개별 성분 파싱
// ============================================================

/**
 * 원재료명 텍스트에서 개별 성분을 파싱합니다.
 * 한국 식품 라벨의 복잡한 괄호 구조를 처리합니다.
 * @param {string} ingredientText
 * @returns {Array<Object>}
 */
function parseIngredients(ingredientText) {
  if (!ingredientText) return [];

  let text = ingredientText.replace(/\s+/g, ' ').trim();

  // 함유 표시 제거
  text = text.replace(/[,，\s]*(함유|포함|사용)\s*$/, '');
  // 알레르기 표시 제거
  text = text.replace(/\[?알레르기\s*유발물질\s*[:]\s*[^\]]*\]?/g, '');
  // 중괄호 → 소괄호 통일
  text = text.replace(/\{/g, '(').replace(/\}/g, ')');

  // 최상위 레벨에서 쉼표로 분리 (괄호 내부 쉼표는 무시)
  const ingredients = [];
  let current = '';
  let depth = 0;

  for (const char of text) {
    if ('(（['.includes(char)) {
      depth++;
      current += char;
    } else if (')）]'.includes(char)) {
      depth = Math.max(0, depth - 1);
      current += char;
    } else if (char === ',' && depth === 0) {
      if (current.trim()) ingredients.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) ingredients.push(current.trim());

  // 각 성분 구조화
  return ingredients
    .filter(ing => ing.length >= 1)
    .map(ing => {
      // 함량 비율
      const pctMatch = ing.match(/(\d+[.,]?\d*)\s*%/);
      const percentage = pctMatch ? parseFloat(pctMatch[1].replace(',', '.')) : null;

      // 원산지
      const originMatch = ing.match(/[(（]([^)）]*산)[)）]/);
      const origin = originMatch ? originMatch[1] : null;

      // 메인 성분명
      const nameMatch = ing.match(/^([^(（[\d%]+)/);
      const name = nameMatch ? nameMatch[1].trim() : ing.trim();

      // 세부 성분 (최외곽 괄호/대괄호 안 — 가장 긴 매칭 사용)
      let detail = '';
      const bracketStart = ing.search(/[(（\[]/);
      if (bracketStart !== -1) {
        // 괄호 깊이 추적으로 매칭되는 닫힘 괄호까지 추출
        let d = 0;
        let detailEnd = -1;
        for (let i = bracketStart; i < ing.length; i++) {
          if ('(（['.includes(ing[i])) d++;
          else if (')）]'.includes(ing[i])) { d--; if (d === 0) { detailEnd = i; break; } }
        }
        if (detailEnd > bracketStart) {
          detail = ing.substring(bracketStart + 1, detailEnd);
        }
      }

      // 서브 성분 추출
      const subIngredients = [];
      if (detail && detail.includes(',')) {
        for (const sub of detail.split(',')) {
          const subName = sub.trim().match(/^([^(（[\d%:]+)/);
          if (subName) {
            const sn = subName[1].trim();
            if (sn.length >= 2 && !/.*산$/.test(sn)) {
              subIngredients.push(sn);
            }
          }
        }
      }

      return { name, detail, origin, percentage, raw: ing, sub_ingredients: subIngredients };
    });
}

// ============================================================
// 3. 식품첨가물 식별
// ============================================================

const ADDITIVE_KEYWORDS = {
  // 보존료
  '안식향산나트륨': '보존료', '안식향산': '보존료',
  '소르빈산칼륨': '보존료', '소르빈산': '보존료',
  '프로피온산나트륨': '보존료', '프로피온산칼슘': '보존료',
  '아질산나트륨': '발색제/보존료', '질산나트륨': '발색제', '질산칼륨': '발색제',
  // 산화방지제
  'BHA': '산화방지제', 'BHT': '산화방지제', 'TBHQ': '산화방지제',
  '에리소르빈산나트륨': '산화방지제', '부틸히드록시아니솔': '산화방지제',
  '디부틸히드록시톨루엔': '산화방지제',
  'L-아스코르브산': '산화방지제/비타민', '아스코르브산': '산화방지제/비타민',
  '비타민C': '산화방지제/비타민', '토코페롤': '산화방지제/비타민',
  // 감미료
  '아스파탐': '감미료', '아세설팜칼륨': '감미료', '수크랄로스': '감미료',
  '삭카린나트륨': '감미료', '스테비아': '감미료', '자일리톨': '감미료',
  '소르비톨': '감미료', '에리스리톨': '감미료',
  // 착색료
  '타르색소': '착색료', '적색제2호': '착색료', '적색2호': '착색료',
  '적색제3호': '착색료', '적색3호': '착색료',
  '적색제40호': '착색료', '적색40호': '착색료',
  '황색제4호': '착색료', '황색4호': '착색료',
  '황색제5호': '착색료', '황색5호': '착색료',
  '청색제1호': '착색료', '청색1호': '착색료',
  '청색제2호': '착색료', '청색2호': '착색료',
  '카라멜색소': '착색료', '이산화티타늄': '착색료',
  '코치닐추출색소': '착색료', '카민': '착색료',
  '베타카로틴': '착색료/비타민', '파프리카추출색소': '착색료', '안나토색소': '착색료',
  // 향미증진제
  'L-글루타민산나트륨': '향미증진제', '글루타민산나트륨': '향미증진제',
  "5'-리보뉴클레오티드이나트륨": '향미증진제',
  '이노신산나트륨': '향미증진제', '구아닐산나트륨': '향미증진제',
  // 팽창제
  '탄산수소나트륨': '팽창제', '탄산나트륨': '팽창제',
  '산성피로인산나트륨': '팽창제', '제일인산칼슘': '팽창제',
  '황산알루미늄칼륨': '팽창제',
  // 유화제
  '레시틴': '유화제', '대두레시틴': '유화제',
  '글리세린지방산에스테르': '유화제', '자당지방산에스테르': '유화제',
  '폴리소르베이트': '유화제', '폴리소르베이트60': '유화제', '폴리소르베이트80': '유화제',
  '카르복시메틸셀룰로스': '유화제/증점제', 'CMC': '유화제/증점제',
  // 증점제/안정제
  '잔탄검': '증점제', '구아검': '증점제', '카라기난': '증점제', '젤란검': '증점제',
  '펙틴': '증점제', '한천': '증점제', '알긴산나트륨': '증점제',
  '셀룰로스검': '증점제', '셀룰로오스검': '증점제',
  '변성전분': '증점제', '아라비아검': '증점제',
  '메틸셀룰로스': '증점제', '히드록시프로필메틸셀룰로스': '증점제', '로커스트콩검': '증점제',
  // 산도조절제
  '구연산': '산도조절제', '구연산나트륨': '산도조절제', '구연산삼나트륨': '산도조절제',
  '젖산': '산도조절제', '젖산칼슘': '산도조절제',
  '주석산': '산도조절제', '푸마르산': '산도조절제',
  '인산': '산도조절제', '빙초산': '산도조절제',
  '글루코노델타락톤': '산도조절제', '글루콘산': '산도조절제',
  '면류첨가알칼리제': '산도조절제', '탄산칼륨': '산도조절제',
  // 인산염류 (품질개량제)
  '폴리인산나트륨': '품질개량제', '메타인산나트륨': '품질개량제',
  '메타인산칼륨': '품질개량제', '피로인산나트륨': '품질개량제',
  '피로인산사나트륨': '품질개량제', '제삼인산칼슘': '품질개량제',
  '인산나트륨': '품질개량제', '인산칼슘': '품질개량제',
  // 기타
  '이산화규소': '고결방지제', '규소수지': '소포제',
  '카르나우바왁스': '피막제', '셸락': '피막제',
  '프로필렌글리콜': '습윤제', '글리세린': '습윤제',
  '합성향료': '향료', '바닐린': '향료', '에틸바닐린': '향료',
  '강황추출액': '착색료/향신료', '강황색소': '착색료',
  '혼합제제': '복합첨가물',
  '덱스트린': '부형제', '텍스트린': '부형제',
  '말토덱스트린': '부형제', '사이클로덱스트린': '부형제',
};

/**
 * 파싱된 원재료 목록에서 식품첨가물을 식별합니다.
 * @param {Array} ingredients - parseIngredients() 결과
 * @returns {Array<Object>}
 */
function identifyAdditives(ingredients) {
  const found = [];
  const seen = new Set();

  function checkName(name, raw, source) {
    name = name.trim();
    if (name.length < 2 || seen.has(name)) return;

    // 정확 매칭
    if (ADDITIVE_KEYWORDS[name]) {
      seen.add(name);
      found.push({
        name,
        category: ADDITIVE_KEYWORDS[name],
        raw,
        match_type: `exact(${source})`,
      });
      return;
    }

    // 부분 매칭 (키워드가 성분명에 포함)
    for (const [keyword, category] of Object.entries(ADDITIVE_KEYWORDS)) {
      if (name.includes(keyword) && !seen.has(keyword)) {
        seen.add(keyword);
        found.push({
          name: keyword,
          category,
          raw,
          match_type: `partial(${source})`,
        });
        return;
      }
    }
  }

  for (const ing of ingredients) {
    checkName(ing.name, ing.raw, 'main');

    for (const sub of ing.sub_ingredients || []) {
      checkName(sub, ing.raw, 'sub');
    }

    // detail 텍스트 키워드 직접 검색
    const detail = ing.detail || '';
    if (detail) {
      for (const [keyword, category] of Object.entries(ADDITIVE_KEYWORDS)) {
        if (detail.includes(keyword) && !seen.has(keyword)) {
          seen.add(keyword);
          found.push({
            name: keyword,
            category,
            raw: ing.raw,
            match_type: 'detail_scan',
          });
        }
      }
    }
  }

  return found;
}

// ============================================================
// 4. 영양정보 파싱
// ============================================================

const NUTRIENT_PATTERNS = {
  calories:      /열량[:\s]*(\d+[.,]?\d*)\s*(kcal|킬로칼로리|Kcal)/,
  total_carbs:   /탄수화물[:\s]*(\d+[.,]?\d*)\s*g/,
  total_sugars:  /당류[:\s]*(\d+[.,]?\d*)\s*g/,
  protein:       /단백질[:\s]*(\d+[.,]?\d*)\s*g/,
  total_fat:     /(?<!포화)(?<!트랜스)지방[:\s]*(\d+[.,]?\d*)\s*g/,
  saturated_fat: /포화지방(?:산)?[:\s]*(\d+[.,]?\d*)\s*g/,
  trans_fat:     /트랜스지방(?:산)?[:\s]*(\d+[.,]?\d*)\s*g/,
  cholesterol:   /콜레스테롤[:\s]*(\d+[.,]?\d*)\s*m?g/,
  sodium:        /나트륨[:\s]*(\d+[.,]?\d*)\s*m?g/,
  dietary_fiber: /식이섬유[:\s]*(\d+[.,]?\d*)\s*g/,
};

/**
 * OCR 텍스트에서 영양정보를 추출합니다.
 * @param {string} text
 * @returns {Object}
 */
function parseNutrition(text) {
  const nutrition = {};

  for (const [nutrient, pattern] of Object.entries(NUTRIENT_PATTERNS)) {
    const match = text.match(pattern);
    if (match) {
      const value = match[1].replace(',', '.');
      nutrition[nutrient] = parseFloat(value);
    }
  }

  // 1회 제공량 / 총 내용량
  const servingMatch = text.match(
    /(?:1회\s*제공량|총\s*내용량)[:\s]*(\d+[.,]?\d*)\s*(g|ml|mL|kg|L)/
  );
  if (servingMatch) {
    nutrition.serving_size = parseFloat(servingMatch[1].replace(',', '.'));
    nutrition.serving_unit = servingMatch[2].toLowerCase();
  }

  return nutrition;
}

// ============================================================
// 5. 알레르기 유발물질 탐지
// ============================================================

const ALLERGEN_KEYWORDS = {
  '난류': ['계란', '달걀', '난백', '난황', '마요네즈', '리소자임'],
  '우유': ['우유', '탈지분유', '유청', '카제인', '락토스', '버터', '치즈', '크림', '유단백'],
  '밀': ['밀가루', '소맥분', '글루텐'],
  '대두': ['대두', '두부', '간장', '된장', '콩기름', '레시틴'],
  '땅콩': ['땅콩', '피넛'],
  '메밀': ['메밀', '소바'],
  '게': ['게살', '크래미', '꽃게'],
  '새우': ['새우', '건새우', '새우젓'],
  '돼지고기': ['돼지고기', '베이컨', '돈지'],
  '복숭아': ['복숭아', '황도'],
  '토마토': ['토마토', '케첩'],
  '호두': ['호두'],
  '닭고기': ['닭고기', '닭가슴살', '치킨'],
  '쇠고기': ['쇠고기', '소고기', '젤라틴', '쇠고기엑기스'],
  '오징어': ['오징어'],
  '조개류': ['굴', '홍합', '전복', '조개', '바지락'],
  '아황산류': ['아황산', '이산화황'],
};

/**
 * 텍스트에서 알레르기 유발물질을 탐지합니다.
 * @param {string} text
 * @returns {string[]}
 */
function detectAllergens(text) {
  const detected = new Set();
  for (const [allergen, keywords] of Object.entries(ALLERGEN_KEYWORDS)) {
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        detected.add(allergen);
        break;
      }
    }
  }
  return [...detected].sort();
}

// ============================================================
// 6. 통합 분석 파이프라인
// ============================================================

/**
 * 교정된 OCR 텍스트를 완전 분석합니다.
 * @param {string} correctedText - 교정된 텍스트
 * @returns {Object} 분석 결과
 */
function analyzeText(correctedText) {
  // 원재료명 파싱
  const ingredientSection = extractIngredientSection(correctedText);
  const ingredients = ingredientSection ? parseIngredients(ingredientSection) : [];

  // 첨가물 식별
  const additives = identifyAdditives(ingredients);

  // 영양정보
  const nutrition = parseNutrition(correctedText);

  // 알레르기
  const allergens = detectAllergens(correctedText);

  return {
    ingredient_section: ingredientSection,
    ingredients: ingredients.map(i => ({
      name: i.name,
      origin: i.origin,
      percentage: i.percentage,
      sub_ingredients: i.sub_ingredients,
    })),
    ingredient_count: ingredients.length,
    additives,
    additive_count: additives.length,
    nutrition,
    allergens,
  };
}

module.exports = {
  extractIngredientSection,
  parseIngredients,
  identifyAdditives,
  parseNutrition,
  detectAllergens,
  analyzeText,
  ADDITIVE_KEYWORDS,
  ALLERGEN_KEYWORDS,
};
```

---

## 리뷰 요청 사항

아래 항목에 대해 코드 리뷰를 요청합니다:

### 1. 코드 구조 및 아키텍처
- 레이어 분리(routes/services/models)가 적절한지
- 관심사 분리 원칙이 잘 지켜지고 있는지
- 확장성과 유지보수성 측면에서 개선할 점

### 2. 보안 취약점
- SQL Injection, XSS 등 일반적인 웹 취약점 존재 여부
- API 키 관리 및 환경변수 처리의 적절성
- Rate Limiting, Helmet 등 보안 미들웨어 설정의 충분성
- OCR 이미지 입력(base64)에 대한 검증 수준

### 3. 에러 핸들링
- 중앙 에러 핸들러의 완성도
- 비동기 에러 누락 가능성
- DB 연결 실패, 외부 API 장애 시 복원력(resilience)

### 4. 성능 최적화 포인트
- DB 쿼리 효율성 (인덱스 활용, N+1 문제 등)
- OCR 파이프라인의 병목 구간
- 메모리 사용 (15MB JSON 파싱 등)
- 커넥션 풀 설정의 적절성

### 5. 코드 품질 및 Best Practices
- Node.js/Express 생태계의 모범 사례 준수 여부
- 테스트 가능성(testability) 개선 방안
- 로깅 전략의 적절성
- 타입 안전성 (JSDoc 또는 TypeScript 도입 필요성)
