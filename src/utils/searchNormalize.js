/**
 * 검색어 정규화 유틸리티
 *
 * Migration 009 의 products.search_text STORED 컬럼과 동일한 규칙으로
 * 사용자 입력 검색어를 정규화한다.
 *
 * 일관성 원칙: 입력 정규화 ≡ 저장 정규화. 한쪽만 바뀌면 매칭 실패.
 *
 * 정규화 규칙:
 *   1. 소문자화 (영문 케이스 통일)
 *   2. 공백·특수문자 제거 (한글·영문·숫자만 보존)
 *   3. 빈 문자열 보호 (호출자가 빈 결과 처리)
 *
 * SOURCE: OneDrive/MeokSeon/IP/search_normalization_v1.md (예정)
 */

'use strict';

/**
 * 검색어를 search_text 컬럼과 동일하게 정규화
 * @param {string} query - 사용자 입력 검색어
 * @returns {string} 정규화된 검색어 (공백·특수문자 제거, 소문자)
 *
 * @example
 *   normalizeSearchQuery('농심 신라면') → '농심신라면'
 *   normalizeSearchQuery('Coca-Cola Zero') → 'cocacolazero'
 *   normalizeSearchQuery('신 라면!!') → '신라면'
 */
function normalizeSearchQuery(query) {
  if (typeof query !== 'string') return '';
  return query
    .toLowerCase()
    // 한글(가-힣, ㄱ-ㅎ, ㅏ-ㅣ) + 영문 + 숫자 외 모두 제거
    // 한자는 현 단계 미지원 (후속 동의어 사전에서 처리)
    .replace(/[^a-z0-9가-힣ㄱ-ㅎㅏ-ㅣ]/g, '');
}

/**
 * 정규화된 검색어가 검색에 의미 있는지 검증
 * - 빈 문자열, 너무 짧은 검색어 차단
 * @param {string} normalized
 * @returns {boolean}
 */
function isSearchable(normalized) {
  if (!normalized) return false;
  // 한글 1자도 검색 허용 (예: "차"), 영문은 2자 이상
  const isHangul = /[가-힣]/.test(normalized);
  return isHangul ? normalized.length >= 1 : normalized.length >= 2;
}

module.exports = {
  normalizeSearchQuery,
  isSearchable,
};
