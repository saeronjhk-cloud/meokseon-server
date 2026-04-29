/**
 * Google Cloud Vision OCR 서비스
 * 식품 라벨 이미지에서 텍스트를 추출하고 교정합니다.
 */

const https = require('https');
const http = require('http');
const logger = require('../config/logger');

// ============================================================
// 설정
// ============================================================

const VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY;
const VISION_URL = process.env.GOOGLE_VISION_URL || 'https://vision.googleapis.com/v1/images:annotate';
const MAX_FILE_SIZE_MB = parseInt(process.env.OCR_MAX_FILE_SIZE_MB) || 10;
const MAX_RETRIES = parseInt(process.env.OCR_MAX_RETRIES) || 3;
const TIMEOUT_MS = parseInt(process.env.OCR_TIMEOUT_MS) || 30000;

// ============================================================
// Circuit Breaker (Gemini 피드백: 외부 API 장애 격리)
// ============================================================

const circuitBreaker = {
  failures: 0,
  threshold: 5,          // 연속 5회 실패 시 회로 차단
  resetTimeout: 60000,   // 1분 후 반개방 시도
  state: 'CLOSED',       // CLOSED | OPEN | HALF_OPEN
  lastFailureTime: null,

  recordSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  },

  recordFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.threshold) {
      this.state = 'OPEN';
      logger.error('Circuit Breaker OPEN — Vision API 연속 실패', { failures: this.failures });
    }
  },

  canRequest() {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      // 리셋 시간 경과 시 반개방
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = 'HALF_OPEN';
        logger.info('Circuit Breaker HALF_OPEN — 재시도 허용');
        return true;
      }
      return false;
    }
    // HALF_OPEN
    return true;
  },
};

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
  // Circuit Breaker 체크
  if (!circuitBreaker.canRequest()) {
    throw new Error('OCR 서비스가 일시적으로 중단되었습니다. 잠시 후 다시 시도해주세요. (Circuit Breaker OPEN)');
  }

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

      circuitBreaker.recordSuccess();
      logger.info('Vision API 호출 성공', { elapsed, blocks: blocks.length, confidence: avgConfidence });

      return {
        full_text: fullText,
        blocks,
        block_count: blocks.length,
        avg_confidence: Math.round(avgConfidence * 1000) / 1000,
        elapsed_ms: elapsed,
      };

    } catch (err) {
      lastError = err;
      circuitBreaker.recordFailure();
      // 재시도 가능한 에러인 경우만 대기
      if (attempt < MAX_RETRIES - 1 && isRetryable(err)) {
        const wait = (attempt + 1) * 3000;
        logger.warn(`Vision API 재시도`, { error: err.message, attempt: attempt + 1, waitSec: wait / 1000 });
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
