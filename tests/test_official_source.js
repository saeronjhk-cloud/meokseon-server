/**
 * test_official_source.js — 출처 신뢰도 판별 회귀 (2026-07-29 세션41)
 * 실행: node tests/test_official_source.js
 *
 * ★ 이 테스트가 지키는 것: **자동 반영되면 안 되는 것이 자동 반영되지 않는다.**
 *   판별이 틀리면 잘못된 인분 수·식품유형이 신호등에 그대로 들어간다.
 *   특히 "브랜드사가 운영하는 스마트스토어" 같은 경계 사례를 고정한다.
 */
'use strict';

const S = require('../scripts/lib/official_source');

let pass = 0, fail = 0; const fails = [];
function eq(name, got, exp) {
  const ok = Object.is(got, exp);
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name} — got ${JSON.stringify(got)} ≠ ${JSON.stringify(exp)}`); }
}

console.log('══════════════════════════════════════════════════════');
console.log('출처 신뢰도 판별 테스트');
console.log('══════════════════════════════════════════════════════\n');

// ── 1. 제조사명 정규화 ─────────────────────────────────────────────────────
console.log('── 1. 제조사명 정규화 (실측: 70-probe 출력 형태) ──');
eq('(주)신세계푸드 음성공장', S.normMaker('(주)신세계푸드 음성공장'), '신세계푸드');
eq('주식회사 오뚜기', S.normMaker('주식회사 오뚜기'), '오뚜기');
eq('(주)오뚜기', S.normMaker('(주)오뚜기'), '오뚜기');
eq('롯데웰푸드(주)', S.normMaker('롯데웰푸드(주)'), '롯데웰푸드');
eq('씨제이제일제당(주)', S.normMaker('씨제이제일제당(주)'), '씨제이제일제당');
eq('광동헬스바이오(주) 2공장', S.normMaker('광동헬스바이오(주) 2공장'), '광동헬스바이오');
eq('null 방어', S.normMaker(null), '');

// ── 2. ★ 커머스는 절대 자동 반영 안 됨 ─────────────────────────────────────
console.log('\n── 2. ★ 커머스 = 검토 큐 (제이 확정 정책) ──');
{
  const c = S.classifySource('https://www.coupang.com/vp/products/123', '농심');
  eq('쿠팡 trust', c.trust, 'commerce');
  eq('쿠팡 auto=false', c.auto, false);
}
eq('네이버쇼핑', S.classifySource('https://shopping.naver.com/x', '오뚜기').auto, false);
eq('컬리', S.classifySource('https://www.kurly.com/goods/1001440426', '빙그레').auto, false);
eq('SSG', S.classifySource('https://www.ssg.com/item/1', '씨제이제일제당').auto, false);
eq('11번가', S.classifySource('https://www.11st.co.kr/products/1', '농심').auto, false);
// ★ 경계: 브랜드사가 운영하는 스마트스토어 — 공식처럼 보이지만 커머스다
eq('★ 스마트스토어(브랜드 운영)', S.classifySource('https://smartstore.naver.com/nongshim/products/1', '농심').auto, false);
eq('★ brand.naver.com', S.classifySource('https://brand.naver.com/ottogi/products/1', '(주)오뚜기').auto, false);

// ── 3. 블로그·커뮤니티 ─────────────────────────────────────────────────────
console.log('\n── 3. UGC = 검토 큐 ──');
eq('네이버블로그', S.classifySource('https://blog.naver.com/x/1', '농심').trust, 'ugc');
eq('나무위키', S.classifySource('https://namu.wiki/w/신라면', '농심').auto, false);
eq('티스토리', S.classifySource('https://abc.tistory.com/1', '농심').auto, false);
eq('유튜브', S.classifySource('https://www.youtube.com/watch?v=1', '농심').auto, false);

// ── 4. 제조사 공식 = 자동 반영 ─────────────────────────────────────────────
console.log('\n── 4. 제조사 공식 도메인 = 자동 반영 ──');
{
  const c = S.classifySource('https://www.nongshim.com/product/view?id=1', '(주)농심');
  eq('농심 공식 trust', c.trust, 'official');
  eq('농심 공식 auto', c.auto, true);
}
eq('오뚜기 공식', S.classifySource('https://www.ottogi.co.kr/product/1', '주식회사 오뚜기').auto, true);
eq('서브도메인 허용', S.classifySource('https://m.seoulmilk.co.kr/mobile/x', '서울우유협동조합').auto, true);
eq('빙그레 공식', S.classifySource('https://www.bing.co.kr/product/1', '(주)빙그레').auto, true);
// ★ 017 골든카레 — 이 경로로 12인분이 확인됐다
{
  const c = S.classifySource('https://www.sbfoods-worldwide.com/products/curry', '에스앤비푸드');
  eq('★ S&B 공식(017 골든카레)', c.auto, true);
  eq('★ S&B trust', c.trust, 'official');
}

// ── 5. ★ 제조사 불일치 — 다른 회사 공식몰이면 자동 반영 안 됨 ──────────────
console.log('\n── 5. ★ 제조사 불일치 방어 ──');
eq('농심 제품인데 오뚜기 사이트', S.classifySource('https://www.ottogi.co.kr/x', '(주)농심').auto, false);
eq('제조사 없음', S.classifySource('https://www.nongshim.com/x', null).auto, false);
eq('제조사 빈문자', S.classifySource('https://www.nongshim.com/x', '').auto, false);

// ── 6. 공적 출처 ───────────────────────────────────────────────────────────
console.log('\n── 6. 공적 출처 = 자동 반영 ──');
eq('식품안전나라', S.classifySource('https://www.foodsafetykorea.go.kr/x', '아무개식품').trust, 'authority');
eq('식품안전나라 auto', S.classifySource('https://www.foodsafetykorea.go.kr/x', null).auto, true);
eq('식약처', S.classifySource('https://www.mfds.go.kr/x', null).auto, true);

// ── 7. ★ 판별 불가 = 안전 기본값 ───────────────────────────────────────────
console.log('\n── 7. ★ 판별 불가 = 자동 반영 금지 (유일한 방어선) ──');
eq('모르는 도메인', S.classifySource('https://randomfood.co.kr/x', '(주)무명식품').auto, false);
eq('모르는 도메인 trust', S.classifySource('https://randomfood.co.kr/x', '(주)무명식품').trust, 'unknown');
eq('URL 아님', S.classifySource('not-a-url', '농심').auto, false);
eq('null URL', S.classifySource(null, '농심').auto, false);
eq('빈 URL', S.classifySource('', '농심').auto, false);

// ── 8. 부분문자열 오탐 방지 ────────────────────────────────────────────────
console.log('\n── 8. 도메인 부분문자열 오탐 방지 ──');
// 'coupang.com' 이 'notcoupang.com' 에 포함된다고 커머스로 잡으면 안 되고,
// 반대로 'evil-coupang.com.attacker.net' 을 커머스로 오인해도 안 된다(둘 다 unknown 이 정답)
eq('notcoupang.com', S.classifySource('https://notcoupang.com/x', '농심').trust, 'unknown');
eq('coupang.com.evil.net', S.classifySource('https://coupang.com.evil.net/x', '농심').trust, 'unknown');
eq('진짜 서브도메인은 잡음', S.classifySource('https://m.coupang.com/x', '농심').trust, 'commerce');

console.log('\n══════════════════════════════════════════════════════');
console.log(`📊 결과: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail}개)`);
console.log('══════════════════════════════════════════════════════');
if (fail) { console.log('\n실패 목록:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('\n✅ 전체 통과');
