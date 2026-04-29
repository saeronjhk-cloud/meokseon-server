/**
 * 중앙 에러 핸들링 미들웨어
 */

const logger = require('../config/logger');

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

  // 에러 로깅 (Winston)
  if (statusCode >= 500) {
    logger.error(`${req.method} ${req.path}`, { statusCode, code, message, stack: err.stack });
  } else if (statusCode >= 400) {
    logger.warn(`${req.method} ${req.path}`, { statusCode, code, message });
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
