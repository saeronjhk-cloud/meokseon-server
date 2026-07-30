/**
 * official_source.js — 출처 신뢰도 판별 (2026-07-29 세션41)
 * ============================================================================
 * ★ 이 파일이 정책의 안전장치 전부다.
 *   제이 확정(2026-07-29): T3 웹검색 결과 중 **제조사 공식 페이지·브랜드 사이트만 자동 반영**,
 *   커머스(쿠팡·네이버쇼핑 등)는 **검토 큐**로 보낸다.
 *   근거: 017 골든카레는 S&B 공식 표기로 해결됐다(12인분). 커머스 상품정보는 오기재가 흔하다.
 *
 *   이는 IP/nutrition_gap_decision_2026-07-23.md §2-2 의 "검토 큐(자동 신호등 금지)" 잠금을
 *   **부분 해제**하는 정책 변경이다. 판별이 틀리면 잘못된 값이 신호등에 자동 반영된다.
 *   → **판별 불가는 무조건 review 다.** 애매하면 자동 반영하지 않는다. 안전 기본값이 유일한 방어선.
 */
'use strict';

// ── 커머스·마켓플레이스 — 자동 반영 절대 금지 ──────────────────────────────
// 판매자가 입력한 상품정보라 오기재·구버전·타제품 혼입이 흔하다.
const COMMERCE = [
  'coupang.com', 'coupangcdn.com',
  'shopping.naver.com', 'smartstore.naver.com', 'brand.naver.com', 'search.shopping.naver.com',
  '11st.co.kr', 'gmarket.co.kr', 'auction.co.kr', 'ssg.com', 'emart.com', 'emartmall.com',
  'homeplus.co.kr', 'lotteon.com', 'lottemart.com', 'kurly.com', 'oasis.co.kr',
  'tmon.co.kr', 'wemakeprice.com', 'interpark.com', 'gsshop.com', 'cjonstyle.com',
  'hmall.com', 'akmall.com', 'ablynote.com', 'tmall.com', 'aliexpress.com', 'amazon.com',
  'rakuten.co.jp', 'ebay.com', 'danawa.com', 'enuri.com', 'wadiz.kr', 'ohou.se',
  'themarket.com', 'kakaoshopping.com', 'toss.im', 'karrotmarket.com',
];

// ── 블로그·커뮤니티·위키 — 자동 반영 금지 (2차 출처) ────────────────────────
const UGC = [
  'blog.naver.com', 'm.blog.naver.com', 'post.naver.com', 'cafe.naver.com', 'in.naver.com',
  'tistory.com', 'brunch.co.kr', 'velog.io', 'medium.com',
  'namu.wiki', 'wikipedia.org', 'dcinside.com', 'fmkorea.com', 'clien.net',
  'instagram.com', 'facebook.com', 'youtube.com', 'tiktok.com', 'threads.net',
  'x.com', 'twitter.com', 'pinterest.com', 'reddit.com',
];

// ── 공적 출처 — 자동 반영 허용 (제조사 공식보다도 신뢰도가 높다) ────────────
const AUTHORITY = [
  'foodsafetykorea.go.kr',   // 식약처 식품안전나라
  'mfds.go.kr',              // 식약처
  'data.go.kr',              // 공공데이터포털
  'atfis.or.kr',             // 식품산업통계정보
];

/**
 * 제조사 공식 도메인 화이트리스트.
 * 키 = products.manufacturer 에 나타나는 제조사명 조각(정규화 후 부분일치).
 * 값 = 그 회사의 공식 도메인들.
 * ★ 실측으로 확인한 것만 넣는다. 추측으로 넣으면 안전장치가 무너진다.
 *   확인 안 된 회사는 여기 없어도 된다 — 없으면 review 로 가고, 그게 올바른 동작이다.
 */
const OFFICIAL = {
  '농심': ['nongshim.com', 'nongshim.co.kr'],
  '오뚜기': ['ottogi.co.kr'],
  '씨제이': ['cj.co.kr', 'cjfoods.co.kr', 'cjthemarket.com'],
  'cj': ['cj.co.kr', 'cjfoods.co.kr'],
  '롯데웰푸드': ['lottewellfood.com', 'lotteconf.co.kr'],
  '롯데칠성': ['lottechilsung.co.kr'],
  '동원': ['dongwonfnb.com', 'dongwon.com'],
  '빙그레': ['bing.co.kr', 'bingfamily.com'],
  '삼양': ['samyangfoods.com'],
  '팔도': ['paldofood.co.kr'],
  '풀무원': ['pulmuone.co.kr', 'pulmuone.com'],
  '대상': ['daesang.com', 'chungjungone.com'],
  '샘표': ['sempio.com'],
  '해태': ['ht.co.kr', 'haitai.co.kr'],
  '크라운': ['crown.co.kr'],
  '오리온': ['orionworld.com'],
  '남양': ['namyangi.com'],
  '매일': ['maeil.com'],
  '서울우유': ['seoulmilk.co.kr'],
  '하림': ['harim.com'],
  '사조': ['sajo.co.kr'],
  '아워홈': ['ourhome.co.kr'],
  '신세계푸드': ['shinsegaefood.com'],
  '삼립': ['samlip.co.kr', 'spcsamlip.co.kr'],
  '샤니': ['shany.co.kr', 'spc.co.kr'],
  '에스앤비': ['sbfoods.co.jp', 'sbfoods-worldwide.com'],   // 017 골든카레 = S&B
  's&b': ['sbfoods.co.jp', 'sbfoods-worldwide.com'],
  '한국야쿠르트': ['hy.co.kr'],
  '동서': ['dongsuh.co.kr'],
  '대한제분': ['dhflour.co.kr'],
  '청정원': ['chungjungone.com'],
  '백설': ['cjfoods.co.kr'],
};

function hostOf(url) {
  try {
    const u = new URL(String(url).trim());
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) { return null; }
}

/** 호스트가 도메인 목록 중 하나에 속하는가 (서브도메인 포함, 부분문자열 오탐 방지) */
function hostMatches(host, domains) {
  if (!host) return false;
  return domains.some((d) => host === d || host.endsWith('.' + d));
}

/** 제조사명 정규화 — 법인격·공장명·공백 제거. '(주)신세계푸드 음성공장' → '신세계푸드' */
function normMaker(s) {
  if (!s) return '';
  return String(s)
    .replace(/[(（]?\s*주\s*[)）]/g, '')
    .replace(/주식회사|유한회사|\(유\)|㈜/g, '')
    // 공장·지점 표기는 **앞의 지명까지 통째로** 지운다.
    //   '(주)신세계푸드 음성공장' → '신세계푸드'  ('음성' 이 남으면 화이트리스트와 안 맞는다)
    //   '광동헬스바이오(주) 2공장' → '광동헬스바이오'
    // 공백을 제거하기 **전에** 해야 한다 — 공백이 토큰 경계 정보다.
    .replace(/\s+\S*(공장|지점|사업장|본사|영업소|공장동)\s*$/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * URL 이 이 제조사의 공식 출처인가?
 * @returns {{trust:'authority'|'official'|'commerce'|'ugc'|'unknown', auto:boolean, reason:string, host:string|null}}
 *   auto=true 인 것만 자동 반영한다. 나머지는 전부 검토 큐.
 */
function classifySource(url, manufacturer) {
  const host = hostOf(url);
  if (!host) return { trust: 'unknown', auto: false, reason: 'URL 파싱 불가', host: null };

  if (hostMatches(host, AUTHORITY)) {
    return { trust: 'authority', auto: true, reason: '공적 출처(식약처·공공데이터)', host };
  }
  // ★ 커머스·UGC 를 공식 판별보다 **먼저** 본다.
  //   브랜드사가 스마트스토어를 운영하는 경우가 많아, 공식 판별을 먼저 하면 커머스가 통과해 버린다.
  if (hostMatches(host, COMMERCE)) {
    return { trust: 'commerce', auto: false, reason: '커머스 — 판매자 입력 정보라 검토 필요', host };
  }
  if (hostMatches(host, UGC)) {
    return { trust: 'ugc', auto: false, reason: '블로그·커뮤니티 — 2차 출처', host };
  }

  const mk = normMaker(manufacturer);
  if (mk) {
    for (const [key, domains] of Object.entries(OFFICIAL)) {
      if (!mk.includes(key)) continue;
      if (hostMatches(host, domains)) {
        return { trust: 'official', auto: true, reason: `제조사 공식 도메인(${key})`, host };
      }
    }
  }

  // ★ 판별 불가 = 자동 반영 금지. 이것이 유일한 방어선이다.
  return { trust: 'unknown', auto: false, reason: '공식 도메인 미확인 — 안전 기본값으로 검토 큐', host };
}

module.exports = { classifySource, normMaker, hostOf, _lists: { COMMERCE, UGC, AUTHORITY, OFFICIAL } };
