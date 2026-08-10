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

// ★★★ 세션59 4단계 — 여기 있던 `getAllergenKeywords()` 를 **제거**했다.
//   호출부가 저장소 전체에 **0건**이었다(세션59 실측 · 설계 §6 이 지목한 그 함수다).
//
// ⚠⚠ 그런데 이 함수를 지운다고 문제가 사라지지 않는다. 지우면서 «더 큰 것»을 발견했다 — `U59-3`:
//   `loadFromDB()` 는 서버 기동 때마다(`server.js:20`) DB 에서 알레르기 사전을 읽어
//   `allergenKeywords` 에 채운다. **그런데 그 값을 읽는 곳이 이제 하나도 없다.**
//   판별기 B·C 는 `ocrParser` 의 `ALLERGEN_NAMES` 를 직접 본다 — 이 캐시를 경유하지 않는다.
//
//   ⇒ 관리자가 DB 알레르기 사전을 고치고 `/api/admin/cache/reload` 를 눌러도 **판정은 안 바뀐다.**
//     이 파일 머리말의 「관리자가 DB 데이터를 수정하면 리로드 가능합니다」는 첨가물에만 참이다.
//   ⚠ 이건 «죽은 코드»가 아니라 **거짓 기대**다. 고치려면 도메인 결정이 먼저다 —
//     ⓐ 알레르기 사전을 DB 로 옮길 것인가(그러면 D55-2 폐기 결정과 충돌한다), 아니면
//     ⓑ 알레르기 캐시를 통째로 걷어낼 것인가.
//   근거·판단은 `IP/인수인계_2026-08-09_세션59.md` 의 `U59-3`. **여기서 임의로 정하지 말 것.**

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
  // ★ 세션59 — `getAllergenKeywords` 를 뺐다. 호출부 0건이었다. 위 주석(`U59-3`) 참조.
  getCacheStatus,
};
