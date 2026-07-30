/**
 * test_racc_table.js — RACC 60유형 조회·정규화 회귀 (2026-07-29 세션41)
 * 실행: node tests/test_racc_table.js   또는   npm run test:racc-table
 *
 * 이 테스트가 지키는 계약
 *   ① 정규화 L0~L4 가 각각 **실제로 발동**한다 (실측 4건 포함)
 *   ② racc:null([표3] 공란)과 미매핑은 **다른 상태**로 구분된다
 *   ③ 표를 못 읽어도 throw 하지 않고 degrade 한다
 *   ④ raccPolicy 의 13종 RACC_MAP 을 침범하지 않는다
 */
'use strict';

const T = require('../src/services/raccTable');

let pass = 0, fail = 0;
const fails = [];

function eq(name, got, exp) {
  const ok = Object.is(got, exp);
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name} — got ${JSON.stringify(got)} ≠ ${JSON.stringify(exp)}`); }
}

console.log('══════════════════════════════════════════════════════');
console.log('RACC 60유형 테이블 테스트');
console.log('══════════════════════════════════════════════════════\n');

// ── 0. 로딩 ────────────────────────────────────────────────────────────────
console.log('── 0. 표 로딩 ──');
eq('표가 로드됨', T.isLoaded(), true);
eq('60유형', T.tableSize(), 60);
console.log(`     경로: ${T.loadedFrom()}`);

// ── 1. L0 정확일치 ─────────────────────────────────────────────────────────
console.log('\n── 1. L0 정확일치 ──');
eq('유탕면 racc', T.lookupRacc('유탕면').racc, 120);
eq('유탕면 level', T.lookupRacc('유탕면').matchLevel, 'L0');
eq('즉석조리식품 racc', T.lookupRacc('즉석조리식품').racc, 210);
eq('가공유 racc', T.lookupRacc('가공유').racc, 200);
eq('가공유 unit', T.lookupRacc('가공유').unit, 'ml');
eq('조미김 racc(소량섭취)', T.lookupRacc('조미김').racc, 4);

// ── 2. L1 공백 무시 ────────────────────────────────────────────────────────
console.log('\n── 2. L1 공백 무시 ──');
// 표 키 '기타 수산물가공품' — DB 에는 공백 없이 들어오는 경우가 있다
eq('기타수산물가공품 → 매칭', T.lookupRacc('기타수산물가공품').matched, true);
eq('기타수산물가공품 level', T.lookupRacc('기타수산물가공품').matchLevel, 'L1');
eq('유탕면 앞뒤공백', T.lookupRacc('  유탕면  ').matchLevel, 'L0');   // trim 후 정확일치
eq('즉석 조리식품(중간공백)', T.lookupRacc('즉석 조리식품').matchLevel, 'L1');
eq('비타민C(표 키는 "비타민 C")', T.lookupRacc('비타민C').matched, true);

// ── 3. L2 분리자 무시 ★ 실측 근거 ──────────────────────────────────────────
console.log('\n── 3. L2 분리자 무시 (실측: 과/채 주스 ↔ 과·채주스) ──');
eq('과/채 주스 → 매칭', T.lookupRacc('과/채 주스').matched, true);
eq('과/채 주스 → 표 키', T.lookupRacc('과/채 주스').key, '과·채주스');
eq('과/채 주스 level', T.lookupRacc('과/채 주스').matchLevel, 'L2');
eq('과/채 주스 racc', T.lookupRacc('과/채 주스').racc, 200);
eq('과.채음료(마침표)', T.lookupRacc('과.채음료').key, '과·채음료');
eq('인삼-홍삼음료(하이픈)', T.lookupRacc('인삼-홍삼음료').key, '인삼·홍삼음료');
eq('과채가공품(분리자 없음)', T.lookupRacc('과채가공품').key, '과·채가공품');

// ── 4. L3 괄호 밖 ★ 실측 근거 ──────────────────────────────────────────────
console.log('\n── 4. L3 괄호 밖 (실측: 프레스햄(살균제품) · 소시지(살균제품)) ──');
eq('프레스햄(살균제품) → 매칭', T.lookupRacc('프레스햄(살균제품)').matched, true);
eq('프레스햄(살균제품) → 키', T.lookupRacc('프레스햄(살균제품)').key, '프레스햄');
eq('프레스햄(살균제품) level', T.lookupRacc('프레스햄(살균제품)').matchLevel, 'L3');
eq('프레스햄(살균제품) racc', T.lookupRacc('프레스햄(살균제품)').racc, 30);
eq('소시지(살균제품) → 키', T.lookupRacc('소시지(살균제품)').key, '소시지');
eq('만두(냉동) → 키', T.lookupRacc('만두(냉동)').key, '만두');
eq('전각괄호 소시지（살균）', T.lookupRacc('소시지（살균）').key, '소시지');

// ── 5. L4 괄호 안 ★ 실측 근거 ──────────────────────────────────────────────
console.log('\n── 5. L4 괄호 안 (실측: 가공김(조미김)) ──');
eq('가공김(조미김) → 매칭', T.lookupRacc('가공김(조미김)').matched, true);
eq('가공김(조미김) → 키', T.lookupRacc('가공김(조미김)').key, '조미김');
eq('가공김(조미김) level', T.lookupRacc('가공김(조미김)').matchLevel, 'L4');
eq('가공김(조미김) racc', T.lookupRacc('가공김(조미김)').racc, 4);
// L3 이 L4 보다 먼저다 — 괄호 밖이 표에 있으면 그쪽을 쓴다
eq('소시지(조미김) → L3 우선', T.lookupRacc('소시지(조미김)').key, '소시지');

// ── 6. racc:null — 매칭은 성공, 값은 없음 ★ 핵심 계약 ──────────────────────
console.log('\n── 6. [표3] 공란 12키: matched=true 이지만 racc=null ──');
eq('기타가공품 matched', T.lookupRacc('기타가공품').matched, true);
eq('기타가공품 racc=null', T.lookupRacc('기타가공품').racc, null);
eq('젓갈 matched', T.lookupRacc('젓갈').matched, true);
eq('젓갈 racc=null', T.lookupRacc('젓갈').racc, null);
eq('고춧가루 matched', T.lookupRacc('고춧가루').matched, true);
eq('포장육 racc=null', T.lookupRacc('포장육').racc, null);
eq('당류가공품 matched', T.lookupRacc('당류가공품').matched, true);

// ── 7. supplement ──────────────────────────────────────────────────────────
console.log('\n── 7. 건강기능식품 (신호등 제외 대상) ──');
eq('홍삼 supplement', T.isSupplement('홍삼'), true);
eq('프로바이오틱스 supplement', T.isSupplement('프로바이오틱스'), true);
eq('비타민 C supplement', T.isSupplement('비타민 C'), true);
eq('유탕면은 supplement 아님', T.isSupplement('유탕면'), false);
eq('미매핑도 supplement 아님', T.isSupplement('존재하지않는유형'), false);

// ── 8. 미매핑 안전 실패 ────────────────────────────────────────────────────
console.log('\n── 8. 미매핑 — 추정하지 않고 못 찾았다고 답한다 ──');
eq('없는 유형 matched=false', T.lookupRacc('카레').matched, false);
eq('없는 유형 racc=null', T.lookupRacc('카레').racc, null);
eq('없는 유형 level=null', T.lookupRacc('카레').matchLevel, null);
eq('빈 문자열', T.lookupRacc('').matched, false);
eq('공백만', T.lookupRacc('   ').matched, false);
eq('null 입력', T.lookupRacc(null).matched, false);
eq('undefined 입력', T.lookupRacc(undefined).matched, false);
eq('숫자 입력', T.lookupRacc(123).matched, false);
eq('괄호만', T.lookupRacc('()').matched, false);

// ── 9. resolveServingFromRacc — raccPolicy 규칙 재사용 ──────────────────────
console.log('\n── 9. 1회 제공량 해상 (raccPolicy.resolveServing 재사용) ──');
// 유탕면 RACC 120. 라벨 120 → 0.5배 이상이므로 라벨 채택
eq('유탕면 라벨120 → 120', T.resolveServingFromRacc('유탕면', 120).serving, 120);
eq('유탕면 라벨120 source', T.resolveServingFromRacc('유탕면', 120).source, 'label');
// 라벨 30 은 120 의 0.5배(60) 미만 → RACC 채택
eq('유탕면 라벨30 → RACC 120', T.resolveServingFromRacc('유탕면', 30).serving, 120);
eq('유탕면 라벨30 source', T.resolveServingFromRacc('유탕면', 30).source, 'racc');
// 라벨 없음 → RACC
eq('유탕면 라벨없음 → 120', T.resolveServingFromRacc('유탕면', null).serving, 120);
// 표 공란(racc:null) → 라벨값 그대로
eq('기타가공품 라벨50 → 50', T.resolveServingFromRacc('기타가공품', 50).serving, 50);
eq('기타가공품 source', T.resolveServingFromRacc('기타가공품', 50).source, 'label_fallback');
// 미매핑 + 라벨 없음 → 100 (raccPolicy 기본값)
eq('미매핑 라벨없음 → 100', T.resolveServingFromRacc('카레', null).serving, 100);
// 정규화된 유형도 환산에 쓰인다
eq('과/채 주스 라벨없음 → 200', T.resolveServingFromRacc('과/채 주스', null).serving, 200);

// ── 10. 로딩 실패 degrade ★ 서버가 죽으면 안 된다 ──────────────────────────
console.log('\n── 10. 데이터 파일 없음 → throw 금지, degrade ──');
let threw = false;
try { T._loadTable(['/존재하지/않는/경로.json']); } catch (_) { threw = true; }
eq('throw 하지 않음', threw, false);
eq('isLoaded=false', T.isLoaded(), false);
eq('빈 표', T.tableSize(), 0);
eq('조회는 안전 실패', T.lookupRacc('유탕면').matched, false);
eq('resolveServing 은 계속 동작', T.resolveServingFromRacc('유탕면', 65).serving, 65);
// 원상 복구
T._loadTable();
eq('재로딩 복구', T.isLoaded(), true);
eq('재로딩 후 60유형', T.tableSize(), 60);

// ── 11. raccPolicy 13종 불가침 ─────────────────────────────────────────────
console.log('\n── 11. raccPolicy.RACC_MAP(13종) 침범하지 않음 ──');
const { RACC_MAP } = require('../src/services/raccPolicy');
eq('RACC_MAP 여전히 13종', Object.keys(RACC_MAP).length, 13);
eq('RACC_MAP 참기름 보존', RACC_MAP['참기름'] != null, true);

// ── 결과 ───────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════');
console.log(`📊 결과: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail}개)`);
console.log('══════════════════════════════════════════════════════');
if (fail) { console.log('\n실패 목록:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('\n✅ 전체 통과');
