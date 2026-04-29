/**
 * PostgreSQL 연결 설정
 * pg Pool을 사용한 커넥션 풀 관리
 * Gemini 피드백: 커넥션 풀 튜닝 + release 재점검
 */

const { Pool } = require('pg');
const logger = require('./logger');

// Railway 등 클라우드 환경에서는 DATABASE_URL 사용, 로컬에서는 개별 환경변수 사용
const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
      min: parseInt(process.env.DB_POOL_MIN) || 2,
      max: parseInt(process.env.DB_POOL_MAX) || 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
    }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'meokseon',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      min: parseInt(process.env.DB_POOL_MIN) || 2,
      max: parseInt(process.env.DB_POOL_MAX) || 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
    };

const pool = new Pool(poolConfig);

// 연결 이벤트 로깅
pool.on('error', (err) => {
  logger.error('DB 풀 비정상 에러', { error: err.message, stack: err.stack });
});

pool.on('connect', () => {
  logger.debug('DB 새 커넥션 생성', {
    total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount,
  });
});

/**
 * DB 쿼리 헬퍼 — 자동 커넥션 반환 보장
 */
async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;

  // 느린 쿼리 경고 (200ms 초과)
  if (duration > 200) {
    logger.warn('느린 쿼리 감지', { duration, query: text.substring(0, 100) });
  } else if (process.env.NODE_ENV === 'development') {
    logger.debug(`DB 쿼리`, { duration, query: text.substring(0, 80) });
  }

  return result;
}

/**
 * 트랜잭션 헬퍼 — finally에서 반드시 release 보장
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
 * DB 헬스체크 — 풀 상태 상세 포함
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
        max: pool.options.max,
      },
    };
  } catch (err) {
    logger.error('DB 헬스체크 실패', { error: err.message });
    return {
      status: 'unhealthy',
      error: err.message,
    };
  }
}

module.exports = { pool, query, transaction, healthCheck };
