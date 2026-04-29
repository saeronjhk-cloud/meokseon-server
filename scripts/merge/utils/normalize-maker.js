/**
 * 제조사명 정규화 유틸리티
 *
 * 1단계: 법인 접미사 제거 ((주), 주식회사, ㈜ 등)
 * 2단계: 공장명/지점명 제거 (제N공장, OO지점 등)
 * 3단계: 공백 제거 + 소문자 변환
 * 4단계: 동의어 사전으로 canonical name 변환
 *
 * 사용법:
 *   const { normalizeMaker, resolveCanonical } = require('./utils/normalize-maker');
 *   normalizeMaker('(주)롯데제과')  // → '롯데제과' (정규화만)
 *   resolveCanonical('(주)롯데제과')  // → '롯데웰푸드' (canonical name)
 */

const fs = require('fs');
const path = require('path');

// 동의어 사전 로드
// __dirname = scripts/merge/utils/ → 3단계 위로 올라가야 프로젝트 루트
const SYNONYMS_PATH = path.join(__dirname, '..', '..', '..', 'data', 'manufacturer-synonyms.json');
let synonymMap = null;

function loadSynonyms() {
  if (synonymMap) return synonymMap;

  try {
    const raw = JSON.parse(fs.readFileSync(SYNONYMS_PATH, 'utf-8'));
    synonymMap = new Map();

    for (const [key, value] of Object.entries(raw.synonyms || {})) {
      // 구분선 제외
      if (key.startsWith('===') || value === '--- 구분선 ---') continue;
      synonymMap.set(key, value);
    }

    console.log(`  📖 제조사 동의어 사전: ${synonymMap.size}개 로드`);
    return synonymMap;
  } catch (err) {
    console.warn(`  ⚠️ 동의어 사전 로드 실패: ${err.message}`);
    synonymMap = new Map();
    return synonymMap;
  }
}

/**
 * 제조사명 정규화 (법인 접미사/공장명 제거 + 소문자)
 * 동의어 사전은 적용하지 않음 — 순수 문자열 정규화만
 */
function normalizeMaker(name) {
  if (!name) return '';
  return name
    // 법인 형태 제거
    .replace(/\s*\(주\)\s*/g, '')
    .replace(/주식회사/g, '')
    .replace(/㈜/g, '')
    .replace(/(주)/g, '')
    .replace(/유한회사/g, '')
    .replace(/유한책임회사/g, '')
    .replace(/합자회사/g, '')
    .replace(/합명회사/g, '')
    // 법인 유형 제거
    .replace(/농업회사법인/g, '')
    .replace(/영농조합법인/g, '')
    .replace(/사회적협동조합/g, '')
    .replace(/협동조합/g, '')
    // 공장명 제거 (매칭용 — 원본은 보존)
    .replace(/제?\d+공장/g, '')
    .replace(/[가-힣]+공장/g, '')
    // 지점/센터 제거
    .replace(/[가-힣]+지점/g, '')
    .replace(/[가-힣]+센터/g, '')
    // 공백 제거 + 소문자
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

/**
 * 제조사명 → canonical name 변환
 * normalizeMaker 적용 후 동의어 사전에서 대표 이름으로 매핑
 */
function resolveCanonical(name) {
  if (!name) return '';
  const normalized = normalizeMaker(name);
  if (!normalized) return '';

  const dict = loadSynonyms();
  return dict.get(normalized) || normalized;
}

/**
 * 두 제조사가 같은 회사인지 비교
 * canonical name 기준으로 비교하되, 부분 포함도 허용
 */
function isSameMaker(maker1, maker2) {
  if (!maker1 || !maker2) return false;

  const c1 = resolveCanonical(maker1);
  const c2 = resolveCanonical(maker2);

  if (!c1 || !c2) return false;

  // 정확 일치
  if (c1 === c2) return true;

  // 부분 포함 (한쪽이 다른 쪽에 포함)
  if (c1.includes(c2) || c2.includes(c1)) return true;

  return false;
}

module.exports = { normalizeMaker, resolveCanonical, isSameMaker, loadSynonyms };
