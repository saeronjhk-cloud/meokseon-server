/**
 * Winston 로깅 시스템
 * Gemini 피드백: console.log → 전문 로깅 라이브러리 도입
 * - JSON 포맷 규격화
 * - 레벨별 관리 (info, warn, error)
 * - 날짜별 로그 파일 로테이션
 */

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

const logDir = path.join(__dirname, '..', '..', 'logs');

// 로그 포맷
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// 콘솔 포맷 (개발용, 읽기 쉬운 형태)
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level}: ${message}${metaStr}`;
  })
);

// 트랜스포트 설정
const transports = [];

// 콘솔 출력 (개발 환경)
if (process.env.NODE_ENV !== 'test') {
  transports.push(
    new winston.transports.Console({
      format: consoleFormat,
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    })
  );
}

// 파일 출력 (전체 로그)
transports.push(
  new DailyRotateFile({
    dirname: logDir,
    filename: 'app-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '14d',
    format: logFormat,
    level: 'info',
  })
);

// 에러 전용 파일
transports.push(
  new DailyRotateFile({
    dirname: logDir,
    filename: 'error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '30d',
    format: logFormat,
    level: 'error',
  })
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  defaultMeta: { service: 'meokseon-api' },
  transports,
  // 예외 핸들링
  exceptionHandlers: [
    new DailyRotateFile({
      dirname: logDir,
      filename: 'exceptions-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      format: logFormat,
    }),
  ],
  rejectionHandlers: [
    new DailyRotateFile({
      dirname: logDir,
      filename: 'rejections-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      format: logFormat,
    }),
  ],
});

// Morgan 스트림 연동 (HTTP 요청 로깅)
logger.stream = {
  write: (message) => {
    logger.info(message.trim(), { type: 'http' });
  },
};

module.exports = logger;
