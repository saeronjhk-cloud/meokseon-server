/**
 * userBarcodeGate.js — ★ 세션81 «사용자 바코드 연결» 판정 엔진(결정 80-9 · 81-1~81-4). 엔진 규칙 · AI 아님.
 *   정답 IP/eval_user_barcode_v1/cases_v1.json (= tests/fixtures/user_barcode_v1.json) UB01~21.
 *   증거 출처 source = 'user' | 'photo' | 'gs1' — 출처를 갈아 끼워도 판정 함수는 하나다.
 *   이름·제조사·규격 비교는 scripts/lib/barcode_link_gate 그대로(복제 금지 · R12).
 *
 *   judgeLink(in) → { status:'auto'|'personal'|'needs_review'|'reject'|'keep', reason, personal:bool, prefix:'match'|'mismatch'|'unknown'|null, barcode }
 *   in = { barcode, target:{food_cd,name,maker,importer,report_no,exposed,report_kfind_count},
 *          claims:[{user, food_cd, source, at, evidence?}], prefixTable|{prefix9:[], prefix8:[]},
 *          public_hit?, linked_other?, decided?:{status,decided_by} }
 *
 * ★ v1.1 실측(.tmp/s81/prefix_on_kfind*.js): K-FIND 정답 쌍에서 대역 «불일치» 약 25%(OEM) · 무작위 통과 0.5% → 일치=강한 근거, 불일치=약한 근거.
 * ★ 왜 대역 일치만으로 auto 를 주지 않는가(세션81 실측 · .tmp/s81/prefix_loo.js):
 *   9자리 대역은 «같은 회사 계열»을 98.7% 맞히고 엉뚱한 회사를 0.03% 만 통과시킨다 — 다른 회사 바코드를 잘못 찍은 것은 거른다.
 *   그러나 같은 회사의 다른 맛·용량은 못 가린다(결정 80-7 maker_only 와 같은 함정) → 1명 + 대역 일치 = 그 사람에게만(personal).
 */
'use strict';
const G = require('./barcodeLinkGate');   // 정본(세션81 src 로 이동 · scripts/lib 는 재수출)

const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');

/** N1 — 숫자만 · 12자리(UPC-A)는 0 을 붙여 13자리. 8/13자리가 아니면 null. */
function normalizeBarcode(raw) {
  let s = digits(raw);
  if (s.length === 12) s = '0' + s;
  return /^(\d{8}|\d{13})$/.test(s) ? s : null;
}

/** 제조사 표기 정리 — 법인 표기·공장·주소 꼬리 제거(세션81 실측: 주소 꼬리가 대역 판정을 흐렸다 «롯데칠성음료경기도안성시…»). */
const REGION = /[\s,(]*(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|충북|충남|전라|전북|전남|경상|경북|경남|제주)/;
function makerKey(s) {
  // ⚠ 세션81 실측 결함: «하이트진로(주)익산공장» 에 /[가-힣]*공장/ 을 바로 걸면 회사 이름까지 지워진다(→ '').
  //   그래서 ① 법인 표기 «뒤에 붙은» 공장명만 먼저 떼고 ② 법인 표기 제거 ③ 주소 꼬리 ④ 띄어 쓴 공장 꼬리·«제2공장»·f4 순서로 정리한다.
  let x = String(s || '').replace(/(\(주\)|㈜|주식회사)\s*\S*공장.*$/, '$1');
  x = x.replace(/\(주\)|㈜|주식회사|농업회사법인|유한회사|\(유\)/g, ' ');
  x = x.split(REGION)[0];
  x = x.replace(/\s+\S*공장.*$/, '').replace(/제?\d+공장$/, '').trim().replace(/f\d+$/i, '');
  return x.replace(/[^0-9a-z가-힣]/gi, '').toLowerCase();
}
const keyMatch = (a, b) => a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a));

/** 대역 표에서 이 바코드의 알려진 제조사(정리된 키) — 9자리 우선, 없으면 8자리. 880 13자리만. */
function prefixMakers(bc, table) {
  if (!bc || bc.length !== 13 || !bc.startsWith('880') || !table) return [];
  const get = (L) => {
    if (Array.isArray(table[`prefix${L}`])) return table[`prefix${L}`];   // 정답 셋 형태(케이스별)
    const m = table[`L${L}`]; return (m && m[bc.slice(0, L)]) || [];     // 표 파일 형태
  };
  const m9 = get(9); if (m9.includes('*')) return [];   // 공용 대역 — 판정 불가
  if (m9.length) return m9.map(makerKey);
  const m8 = get(8); return m8.includes('*') ? [] : m8.map(makerKey);
}

/** R7 */
function prefixVerdict(bc, target, table) {
  const known = prefixMakers(bc, table).filter((k) => k.length >= 2);
  if (!known.length) return 'unknown';
  const mine = [makerKey(target.maker), makerKey(target.importer)].filter((k) => k.length >= 2);
  return known.some((k) => mine.some((m) => keyMatch(k, m))) ? 'match' : 'mismatch';
}

/** 사용자별 최신 1건만(같은 사용자가 마음을 바꾸면 최신이 이긴다 · UB20). user 가 null(gs1)인 건은 그대로. */
function latestPerUser(claims) {
  const by = new Map(); const anon = [];
  for (const c of claims || []) {
    if (c.user == null) { anon.push(c); continue; }
    const prev = by.get(c.user); if (!prev || (c.at || 0) >= (prev.at || 0)) by.set(c.user, c);
  }
  return [...by.values(), ...anon];
}

function out(status, reason, personal, prefix, barcode) { return { status, reason, personal: !!personal, prefix: prefix || null, barcode }; }

function judgeLink(inp) {
  const bc = normalizeBarcode(inp.barcode);
  if (!bc) return out('reject', 'format', false, null, null);
  if (!G.checksumOk(bc)) return out('reject', 'checksum', false, null, bc);                       // R1
  const t = inp.target || {};
  if (!t.exposed) return out('reject', 'target_hidden', false, null, bc);                          // R2
  if (inp.decided && inp.decided.decided_by) return out('keep', 'decided', false, null, bc);       // R3
  if (inp.public_hit) return out('needs_review', 'conflict_public', false, null, bc);              // R4
  if (inp.linked_other) return out('needs_review', 'conflict_linked', false, null, bc);            // R5

  const claims = latestPerUser(inp.claims);
  const mine = claims.filter((c) => c.food_cd === t.food_cd);
  const people = claims.filter((c) => c.user != null && (c.source === 'user' || c.source === 'photo'));
  if (new Set(people.map((c) => c.food_cd)).size > 1) return out('needs_review', 'conflict_user', mine.some((c) => c.user != null), null, bc);   // R6

  const table = inp.prefixTable || { prefix9: inp.prefix9 || [], prefix8: inp.prefix8 || [] };
  const pv = prefixVerdict(bc, t, table);

  // R10 사진 — 제품 단위 근거(품목보고번호 + 이름). 대역보다 먼저 본다: 번호가 다르면 대역과 무관하게 틀린 연결이다.
  const photo = mine.find((c) => c.source === 'photo');
  if (photo) {
    const ev = photo.evidence || {};
    if (!digits(ev.report_no) || digits(ev.report_no) !== digits(t.report_no)) return out('reject', 'report_no', false, pv, bc);
    if ((t.report_kfind_count || 1) > 1) return out('needs_review', 'multi_kfind', true, pv, bc);
    if (!G.nameMatch(ev.name, t.name) && !G.nameMatch(t.name, ev.name)) return out('needs_review', 'identity', true, pv, bc);
    return out('auto', 'photo_report_no', true, pv, bc);
  }

  // R11 GS1 — 외부 표준DB 레코드(이름·제조사·규격). 사람 행위가 아니라 personal 은 없다.
  const gs1 = mine.find((c) => c.source === 'gs1');
  if (gs1 && !mine.some((c) => c.source === 'user')) {
    const ev = gs1.evidence || {};
    const ws = G.sizeOf(t.name); const cs = G.sizeOf(ev.name);
    if (ws && cs && !(ws.u === cs.u && Math.abs(ws.v - cs.v) < 0.5)) return out('needs_review', 'size_mismatch', false, pv, bc);
    const nm = G.nameMatch(t.name, ev.name);
    if (!nm) return out('needs_review', G.makerMatch(t.maker || t.importer, ev.maker) ? 'maker_only' : 'identity', false, pv, bc);
    if ((ev.gs1_candidates || 1) > 1) return out('needs_review', 'multi', false, pv, bc);
    return out('auto', 'gs1_exact', false, pv, bc);
  }

  // R9 사용자 (v1.1 — 대역은 «일치»일 때 신뢰를 더할 뿐, «불일치»로 막지 않는다: 정답 쌍의 약 25% 가 OEM 으로 불일치)
  const n = new Set(mine.filter((c) => c.user != null && c.source === 'user').map((c) => c.user)).size;
  if (pv === 'match') {
    if (n >= 2) return out('auto', 'user_pair', true, pv, bc);
    if (n === 1) return out('personal', 'user_single', true, pv, bc);
  } else {
    if (n >= 3) return out('auto', 'user_trio_unverified', true, pv, bc);
    if (n === 2) return out('needs_review', 'user_pair_unverified', true, pv, bc);
    if (n === 1) return out('personal', 'user_single_unverified', true, pv, bc);
  }
  return out('reject', 'no_claim', false, pv, bc);
}

module.exports = { judgeLink, normalizeBarcode, makerKey, prefixVerdict, latestPerUser };
