/**
 * 사전 데이터 인메모리 캐시
 * Gemini 피드백: 정적 사전 데이터의 코드 종속성 해소
 *
 * 서버 기동 시 DB에서 첨가물/알레르기 사전 데이터를 로드하여 메모리에 캐시합니다.
 * DB 미연결 시 ocrParser.js의 기본 데이터를 폴백으로 사용합니다.
 * 관리자가 DB 데이터를 수정하면 /api/admin/cache/reload로 리로드 가능합니다.
 */

const logger = require('../config/logger');
const db = require('../config/database');

// 기본 사전 데이터 (폴백)
const {
  ADDITIVE_KEYWORDS: DEFAULT_ADDITIVES,
  ALLERGEN_KEYWORDS: DEFAULT_ALLERGENS,
} = require('./ocrParser');

// 인메모리 캐시
let additiveKeywords = { ...DEFAULT_ADDITIVES };
let allergenKeywords = { ...DEFAULT_ALLERGENS };
let lastLoaded = null;

/**
 * DB에서 첨가물 사전 데이터를 로드합니다.
 * additives 테이블에 데이터가 있으면 DB 데이터를 우선 사용합니다.
 */
async function loadFromDB() {
  try {
    // 첨가물 사전 로드
    const additiveResult = await db.query(
      `SELECT name_ko, category FROM additives WHERE name_ko IS NOT NULL`
    );

    if (additiveResult.rows.length > 0) {
      const dbAdditives = {};
      for (const row of additiveResult.rows) {
        dbAdditives[row.name_ko] = row.category || '기타';
      }
      // DB 데이터 + 기본 데이터 병합 (DB 우선)
      additiveKeywords = { ...DEFAULT_ADDITIVES, ...dbAdditives };
      logger.info('첨가물 사전 DB 로드 완료', {
        db_count: additiveResult.rows.length,
        total_count: Object.keys(additiveKeywords).length,
      });
    } else {
      additiveKeywords = { ...DEFAULT_ADDITIVES };
      logger.info('첨가물 사전: DB 데이터 없음, 기본 사전 사용', {
        count: Object.keys(additiveKeywords).length,
      });
    }

    lastLoaded = new Date();
    return true;
  } catch (err) {
    logger.warn('사전 데이터 DB 로드 실패, 기본 사전 사용', { error: err.message });
    additiveKeywords = { ...DEFAULT_ADDITIVES };
    allergenKeywords = { ...DEFAULT_ALLERGENS };
    return false;
  }
}

/**
 * 캐시된 첨가물 사전을 반환합니다.
 */
function getAdditiveKeywords() {
  return additiveKeywords;
}

/**
 * 캐시된 알레르기 사전을 반환합니다.
 */
function getAllergenKeywords() {
  return allergenKeywords;
}

/**
 * 캐시 상태 조회
 */
function getCacheStatus() {
  return {
    additive_count: Object.keys(additiveKeywords).length,
    allergen_count: Object.keys(allergenKeywords).length,
    last_loaded: lastLoaded,
    source: lastLoaded ? 'database' : 'default',
  };
}

module.exports = {
  loadFromDB,
  getAdditiveKeywords,
  getAllergenKeywords,
  getCacheStatus,
};
