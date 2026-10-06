/**
 * 90-probe-c005-groups.js — 품목제조번호(c005_report_no) 같은 제품 묶음 정리 (읽기 전용)  세션75i 2026-10-05
 * ============================================================================
 * 제이 지시(10-05): «품목제조번호가 같으면 브랜드·제품명·중량을 확인해서 같으면 통합하고, 원재료·영양 부족분을 채운다.
 *                   일단 통합할 것들을 먼저 정리.»
 * 선행 결정(재사용 · 바꾸지 않음):
 *   · 자문/국내제품중복병합_자문회신_결정_2026-07-07.md — products 물리 행은 합치지 않는다(비파괴 엔티티 + 멤버십). serving 상속 금지.
 *   · 자문/영양커버리지확장_자문회신_결정_2026-07-08.md — 같은 c005 = 같은 배합 → per-100 영양 공유 1순위.
 *     게이트 G2 충돌 · G3 변형 토큰(제로/컵/대용량…한쪽만) · 생수 등 도메인. Step 3(c005 공유 엔진)은 7월에 미착수로 남음.
 *   · 7월 엔티티(018)는 키가 search_text(이름) — c005 묶음과 다를 수 있음 → 이 프로브가 기존 엔티티 상태도 함께 센다.
 *
 * 묶음 분류(묶음 = 같은 c005 의 활성 행 ≥2):
 *   U1 통합(같은 SKU)       : 이름·제조사(·브랜드) 같음 + 변형 표시 같음 + 중량 전원 확인·동일
 *   U2 같은 제품·중량 미상   : 위와 같으나 중량을 모르는 행이 있음(확인된 것끼리는 동일)
 *   U3 같은 배합·다른 포장   : 이름·제조사 같음 + 변형 같음 + 중량 다름 → 원재료·100g/ml 영양 공유 가능, 1회분·총량은 공유 금지
 *   H1 변형 표시 다름        : 제로/매운맛/컵/대용량… 한쪽만 → 보류(7월 G3)
 *   H2 이름 다름             : 보류(같은 번호에 다른 이름 — 리뉴얼·오기·묶음상품)
 *   H3 제조사 다름           : 보류(깨진 글자 � 는 «어떤 한 글자»로 보고 비교)
 *   H4 브랜드 다름           : 둘 다 브랜드가 있는데 다름 → 보류
 *
 * 출력(backends/먹선/.tmp/s75/):
 *   90_c005_groups_<날짜>.csv   — 묶음 1행: 분류·멤버 수·바코드 수·채울 수 있는 칸·기존 엔티티 상태
 *   90_c005_members_<날짜>.csv  — 멤버 1행: 묶음·하위군(cluster)·중량·영양/원재료 보유·엔티티 상태
 *   90_summary_<날짜>.json
 * 실행 (제이 PC · meokseon-server 폴더):  node scripts/90-probe-c005-groups.js     |  --self-test (DB 없이)
 * ⚠ 쓰기 없음 — 85/86/89 와 같은 읽기 전용 스타트업 파라미터 + SHOW 확인.
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* */ }
const fs = require('fs');
const path = require('path');

const isBlank = (v) => v == null || String(v).trim() === '';
// 이름 비교용(86 과 동일): 괄호 내용·용량·개수·공백·기호 제거
function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .replace(/\d+(\.\d+)?\s*(kg|g|mg|ml|l|리터|개입|개|입|봉|팩|매|ea|x|\*)/gi, '')
    .replace(/[^0-9a-z가-힣�]/g, '');
}
// 변형 표시(7월 SPLIT_TOKEN + G3 추가분) — 괄호 안까지 원문에서 찾는다
const VARIANT = /제로|zero|라이트|light|무가당|무설탕|저당|저염|저지방|고칼슘|디카페인|매운맛|순한맛|불닭|골드|프리미엄|오리지널|스페셜|리뉴얼|new|대용량|미니|mini|기획|1\+1|컵|봉지|스틱|건면|생면|비빔|수출용|업소용/gi;
function variantKey(name) {
  const m = String(name || '').toLowerCase().match(VARIANT) || [];
  return [...new Set(m.map((x) => (x === 'zero' ? '제로' : x === 'light' ? '라이트' : x === 'mini' ? '미니' : x)))].sort().join('|');
}
// 제조사 키: 법인격·공장명·공백 제거
function makerKey(s) {
  return String(s || '').toLowerCase()
    .replace(/(\(주\)|㈜|\s)\s*[가-힣0-9]*공장$/, '$1')
    .replace(/주식회사|유한회사|농업회사법인|영농조합법인|어업회사법인|\(주\)|㈜|\(유\)|\(합\)|\(농\)/g, '')
    .replace(/제\d+공장/g, '')
    .replace(/[^0-9a-z가-힣�]/g, '');
}
// 깨진 글자: UTF-8 한 글자(3바이트)가 � 1~3개로 깨진다(75i 실측: «현���», «드림���») → � 연속 k개 = 아무 글자 1~k개
function fuzzyRe(s) {
  return new RegExp('^' + s.replace(/\uFFFD+|[^\uFFFD]/g, (t) => (t[0] === '\uFFFD' ? `.{1,${t.length}}` : t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) + '$', 'u');
}
function fuzzyEq(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const fa = a.includes('\uFFFD'), fb = b.includes('\uFFFD');
  if (!fa && !fb) return false;
  if (fa && !fb) return fuzzyRe(a).test(b);
  if (fb && !fa) return fuzzyRe(b).test(a);
  // 둘 다 깨짐: 깨진 자리를 빼고 앞뒤 고정 부분이 맞는지만 본다(보수적: 앞 2글자·뒤 2글자)
  const strip = (x) => x.replace(/\uFFFD+/g, '');
  return strip(a).slice(0, 2) === strip(b).slice(0, 2) && strip(a).slice(-2) === strip(b).slice(-2);
}
// 중량: total_content(+content_unit) 우선, 없으면 이름에서. 반환 'g:120' | 'ml:500' (×개수 반영) | null
function parseWeight(p) {
  const conv = (v, u) => {
    const x = parseFloat(v); if (!(x > 0)) return null;
    const unit = String(u || '').toLowerCase();
    if (/^(kg|킬로그램)$/.test(unit)) return ['g', x * 1000];
    if (/^(g|그램)$/.test(unit)) return ['g', x];
    if (/^(mg)$/.test(unit)) return ['g', x / 1000];
    if (/^(l|리터)$/.test(unit)) return ['ml', x * 1000];
    if (/^(ml|㎖|밀리리터)$/.test(unit)) return ['ml', x];
    return null;
  };
  let w = null;
  if (p.total_content != null && !isBlank(p.content_unit)) w = conv(p.total_content, p.content_unit);
  if (!w) {
    const m = String(p.product_name || '').match(/(\d+(?:\.\d+)?)\s*(kg|g|mg|ml|㎖|l|리터)(?![a-z가-힣])/i);
    if (m) w = conv(m[1], m[2]);
  }
  if (!w) return null;
  const c = String(p.product_name || '').match(/(?:[x×*]\s*(\d+)(?!\s*(?:g|ml|kg|l)))|(\d+)\s*(?:개입|입|봉|팩|ea)(?![가-힣a-z])/i);
  const n = c ? parseInt(c[1] || c[2], 10) : 1;
  const tot = Math.round(w[1] * (n > 0 && n < 1000 ? n : 1) * 100) / 100;
  return `${w[0]}:${tot}`;
}
// 원재료가 분류명·유형명뿐인가(75h 표본 #12 «캔디류», #13·#26 «소스, 기타가공품…»)
function ingredientIsCategoryOnly(raw) {
  const toks = String(raw || '').split(/[,，]/).map((t) => t.replace(/\s/g, '')).filter(Boolean);
  if (!toks.length) return true;
  const cat = toks.filter((t) => /(류|가공품|기타가공품|조미식품|복합조미식품)$/.test(t) || /^(소스|기타)$/.test(t));
  return toks.length <= 2 ? cat.length === toks.length : cat.length / toks.length >= 0.5;
}
function basisOf(ss) {
  const s = String(ss || '').replace(/\s/g, '').toLowerCase();
  if (/^100ml/.test(s)) return '100ml';
  if (/^100g/.test(s)) return '100g';
  if (/^100unknown/.test(s)) return '100unknown';
  return s ? 'serving_or_total' : 'unknown';
}
/**
 * 묶음 분류. members: [{product_id, product_name, manufacturer, brand, total_content, content_unit}]
 * 반환 { cls, clusters:[[idx…]], weights:[…] }
 */
function classifyC005Group(members) {
  const rawKey = (m) => `${m.product_name || ''}|${m.manufacturer || ''}|${m.brand || ''}`.replace(/\s/g, '');
  const key = members.map((m) => ({ raw: rawKey(m), n: normName(m.product_name).replace(VARIANT, ''), v: variantKey(m.product_name), mk: makerKey(m.manufacturer), b: makerKey(m.brand), w: parseWeight(m) }));
  // 하위군: 이름+변형+제조사(퍼지)+브랜드(둘 다 있을 때만) 가 같은 것끼리
  const clusters = [];
  key.forEach((k, i) => {
    // 75i-3: 깨진 글자가 법인격·변형어 안에 있으면(«(���)», «매���맛») 정규화 뒤 비교가 어긋남 → 원문 전체가 퍼지로 같으면 같은 하위군
    const c = clusters.find((cl) => { const h = key[cl[0]]; return fuzzyEq(h.raw, k.raw) || fuzzyEq(h.n, k.n) && h.v === k.v && fuzzyEq(h.mk, k.mk) && (!h.b || !k.b || fuzzyEq(h.b, k.b)); });
    if (c) c.push(i); else clusters.push([i]);
  });
  let cls;
  if (clusters.length === 1) {
    const ws = key.map((k) => k.w);
    const known = [...new Set(ws.filter(Boolean))];
    if (known.length > 1) cls = 'U3';
    else if (ws.every(Boolean)) cls = 'U1';
    else cls = 'U2';
  } else {
    // 왜 갈렸나 — 첫 행과 다른 하위군 대표를 비교해 가장 앞선 사유
    const h = key[clusters[0][0]];
    const reasons = clusters.slice(1).map((cl) => { const o = key[cl[0]];
      if (!fuzzyEq(h.mk, o.mk)) return 'H3';
      if (h.b && o.b && !fuzzyEq(h.b, o.b)) return 'H4';
      if (fuzzyEq(h.n, o.n) && h.v !== o.v) return 'H1';
      return 'H2'; });
    cls = ['H1', 'H2', 'H3', 'H4'].find((r) => reasons.includes(r));
  }
  return { cls, clusters, weights: key.map((k) => k.w), keys: key };
}
const csvCell = (v) => { const s = v == null ? '' : String(v).replace(/\r?\n/g, ' '); return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

if (require.main === module && process.argv.includes('--self-test')) {
  let pass = 0, fail = 0; const eq = (a, b, m) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log('FAIL', m, JSON.stringify(a), JSON.stringify(b)); } };
  const P = (product_name, manufacturer, extra = {}) => ({ product_name, manufacturer, ...extra });
  eq(classifyC005Group([P('허니버터칩 60g', '해태제과식품(주)'), P('허니버터칩 60g', '해태제과식품 주식회사')]).cls, 'U1', 'u1 법인격 차이 무시');
  eq(classifyC005Group([P('허니버터칩', '해태'), P('허니버터칩 60g', '해태')]).cls, 'U2', 'u2 중량 일부 미상');
  eq(classifyC005Group([P('허니버터칩 60g', '해태'), P('허니버터칩 120g', '해태')]).cls, 'U3', 'u3 다른 중량');
  eq(classifyC005Group([P('신라면', '농심'), P('신라면 컵', '농심')]).cls, 'H1', 'h1 컵 한쪽만');
  eq(classifyC005Group([P('신라면', '농심'), P('짜파게티', '농심')]).cls, 'H2', 'h2 이름 다름');
  eq(classifyC005Group([P('감귤꽃 홍차', '푸르메다'), P('감귤꽃 홍차', '푸�메다')]).cls, 'U2', 'h3 아님: 깨진 글자 퍼지');
  eq(classifyC005Group([P('홍차', '갑회사'), P('홍차', '을회사')]).cls, 'H3', 'h3 제조사 다름');
  eq(classifyC005Group([P('홍차', '갑', { brand: '해피' }), P('홍차', '갑', { brand: '스마일' })]).cls, 'H4', 'h4 브랜드 둘 다 있고 다름');
  eq(classifyC005Group([P('홍차', '갑', { brand: '해피' }), P('홍차', '갑')]).cls, 'U2', '브랜드 한쪽만 → 비교 안 함');
  eq(classifyC005Group([P('매일우유 200ml', '매일유업(주) 광주공장'), P('매일우유 200ml', '매일유업(주)평택공장')]).cls, 'U1', '공장명 무시');
  eq(parseWeight(P('우유 1L', '')), 'ml:1000', 'w1'); eq(parseWeight(P('과자 30g x 10', '')), 'g:300', 'w2'); eq(parseWeight(P('라면 120g 5개입', '')), 'g:600', 'w3');
  eq(parseWeight(P('라면', '', { total_content: 0.5, content_unit: 'kg' })), 'g:500', 'w4'); eq(parseWeight(P('비타500', '')), null, 'w5 숫자만');
  eq(parseWeight(P('콜라 1.5L', '')), 'ml:1500', 'w6');
  eq(variantKey('신라면 (매운맛) 컵'), '매운맛|컵', 'v1'); eq(variantKey('펩시 ZERO'), '제로', 'v2');
  eq(ingredientIsCategoryOnly('캔디류'), true, 'i1'); eq(ingredientIsCategoryOnly('소스, 기타가공품, 곡류가공품, 소스, 천일염, 주정'), true, 'i2');
  eq(ingredientIsCategoryOnly('밀가루, 설탕, 쇼트닝'), false, 'i3'); eq(ingredientIsCategoryOnly('볶은참깨가루'), false, 'i4');
  eq(fuzzyEq('진미식품', '진미�품'), true, 'f1'); eq(fuzzyEq('진미식품', '진미식'), false, 'f2');
  eq(fuzzyEq('현미발효식초', '현���발효식초'), true, 'f3 3바이트 깨짐'); eq(fuzzyEq('드림초파인애플', '드림���파인애플'), true, 'f4');
  eq(fuzzyEq('양념깻잎', '��념깻잎'), true, 'f5 앞자리'); eq(fuzzyEq('양념깻잎', '������깻잎'), true, 'f6 두 글자');
  eq(fuzzyEq('신라면', '��짜게티'), false, 'f7 다른 이름');
  eq(classifyC005Group([P('롯샌 딸기', '롯데웰푸드(주)'), P('롯샌 딸기', '롯데웰푸드(���)')]).cls, 'U2', 'g1 법인격 안 깨짐');
  eq(classifyC005Group([P('치킨 소스(매운맛)', '모두팜'), P('치킨 소스(매���맛)', '모두팜')]).cls, 'U2', 'g2 변형어 안 깨짐');
  eq(classifyC005Group([P('신라면', '농심'), P('신라면 컵', '농�')]).cls, 'H1', 'g3 진짜 변형은 그대로 보류');
  console.log(`[self-test] 통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
}

const { Pool } = require('pg');
const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } }
  : { host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'meokseon', user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || '' };
Object.assign(poolConfig, { connectionTimeoutMillis: 25000, statement_timeout: 300000, keepAlive: true, options: '-c default_transaction_read_only=on' });
let pool; // main 에서 생성(91 이 분류 함수만 require 할 때 연결을 만들지 않게)
const CHUNK = 5000;
const NUT_KEYS = ['calories','protein','total_fat','saturated_fat','trans_fat','cholesterol','sodium','total_carbs','total_sugars','dietary_fiber'];
async function chunked(ids, sql) { const out = []; for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await pool.query(sql, [ids.slice(i, i + CHUNK)])).rows); return out; }
async function step(label, fn) { const t0 = Date.now(); process.stdout.write(`  · ${label} … `); const r = await fn(); console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`); return r; }

async function main() {
  pool = new Pool(poolConfig);
  const ro = (await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only;
  if (ro !== 'on') throw new Error(`읽기 전용 아님(SHOW=${ro}) — 중단`);
  console.log(`[안전] default_transaction_read_only = ${ro}`);

  const prods = await step('products(보고번호 있는 활성)', async () => (await pool.query(`
    SELECT product_id, barcode, product_name, brand, manufacturer, food_type, total_content, content_unit,
           btrim(c005_report_no) AS rn, (barcode ~ '^[0-9]{8,14}$') AS is_bc
    FROM products WHERE is_active AND btrim(COALESCE(c005_report_no,'')) <> ''`)).rows);
  const byRn = new Map();
  for (const p of prods) { if (!byRn.has(p.rn)) byRn.set(p.rn, []); byRn.get(p.rn).push(p); }
  const groups = [...byRn.entries()].filter(([, ms]) => ms.length >= 2);
  const ids = groups.flatMap(([, ms]) => ms.map((m) => Number(m.product_id)));
  console.log(`  · 묶음(같은 번호 ≥2행) ${groups.length.toLocaleString()} · 멤버 ${ids.length.toLocaleString()}`);

  const nutRows = await step('resolved 영양', () => chunked(ids,
    `SELECT product_id, serving_size, resolved_source FROM product_nutrition_resolved WHERE product_id = ANY($1::bigint[]) AND (${NUT_KEYS.map((k) => k + ' IS NOT NULL').join(' OR ')})`));
  const nut = new Map(nutRows.map((r) => [Number(r.product_id), r]));
  const ingRows = await step('원재료', () => chunked(ids,
    `SELECT DISTINCT ON (product_id) product_id, raw_text, source FROM product_ingredients WHERE product_id = ANY($1::bigint[]) AND raw_text IS NOT NULL AND btrim(raw_text) <> '' ORDER BY product_id, id`));
  const ing = new Map(ingRows.map((r) => [Number(r.product_id), r]));
  const entRows = await step('기존 엔티티(7월 018)', () => chunked(ids,
    `SELECT m.product_id, m.status AS member_status, e.entity_id, e.route, e.relation_type
       FROM product_entity_members m JOIN product_entities e ON e.entity_id = m.entity_id
      WHERE m.product_id = ANY($1::bigint[]) ORDER BY m.product_id, (m.status = 'approved') DESC, m.member_id`));
  const ent = new Map(); for (const r of entRows) if (!ent.has(Number(r.product_id))) ent.set(Number(r.product_id), r);
  // 75i-2: 승인 엔티티의 전체 승인 멤버 수·승인 프로필 유무(묶음 밖 멤버가 섞였는지 — U1 통합 방식 결정용)
  const eids = [...new Set(entRows.filter((r) => r.member_status === 'approved').map((r) => Number(r.entity_id)))];
  const eSize = new Map((await step('엔티티 크기', () => chunked(eids,
    `SELECT entity_id, count(*)::int AS n FROM product_entity_members WHERE status = 'approved' AND entity_id = ANY($1::bigint[]) GROUP BY entity_id`))).map((r) => [Number(r.entity_id), r.n]));
  const eProf = new Set((await step('엔티티 승인 프로필', () => chunked(eids,
    `SELECT DISTINCT entity_id FROM entity_nutrition_profiles WHERE status = 'approved' AND entity_id = ANY($1::bigint[])`))).map((r) => Number(r.entity_id)));
  // 75i-2: nutrition_data 행은 있는데 10칸이 전부 비어 있음 — resolved 뷰는 이 행을 «자기 영양»으로 보므로 엔티티 상속이 막힌다
  const ndEmpty = new Set((await step('빈 nutrition_data 행', () => chunked(ids,
    `SELECT product_id FROM nutrition_data WHERE product_id = ANY($1::bigint[]) AND ${NUT_KEYS.map((k) => k + ' IS NULL').join(' AND ')}`))).map((r) => Number(r.product_id)));

  const gOut = []; const mOut = [];
  const S = { groups: groups.length, members: ids.length, byCls: {}, fill: {}, entity: {}, u1: {} };
  const add = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
  for (const [rn, ms] of groups) {
    const { cls, clusters, weights } = classifyC005Group(ms);
    const pid = ms.map((m) => Number(m.product_id));
    const hasN = pid.map((id) => nut.has(id)); const hasI = pid.map((id) => ing.has(id));
    const donorN = pid.filter((id, i) => hasN[i] && ['100g', '100ml'].includes(basisOf(nut.get(id).serving_size)));
    const donorI = pid.filter((id, i) => hasI[i] && !ingredientIsCategoryOnly(ing.get(id).raw_text));
    // 채울 수 있는 칸: 같은 하위군 안에서만(U 묶음은 하위군 1개 = 묶음 전체)
    let fillN = 0, fillI = 0, fillNbc = 0, fillIbc = 0;
    for (const cl of clusters) {
      const cn = cl.some((i) => donorN.includes(pid[i])); const ci = cl.some((i) => donorI.includes(pid[i]));
      for (const i of cl) {
        if (!hasN[i] && cn) { fillN++; if (ms[i].is_bc) fillNbc++; }
        if (!hasI[i] && ci) { fillI++; if (ms[i].is_bc) fillIbc++; }
      }
    }
    const entStat = pid.map((id) => ent.get(id));
    const entIds = new Set(entStat.filter(Boolean).map((e) => e.entity_id));
    const allApprovedOne = entStat.every((e) => e && e.member_status === 'approved') && entIds.size === 1;
    const apprE = [...new Set(entStat.filter((e) => e && e.member_status === 'approved').map((e) => Number(e.entity_id)))];
    const outsiders = apprE.reduce((a, id) => a + (eSize.get(id) || 0), 0) - entStat.filter((e) => e && e.member_status === 'approved').length;
    const entLabel = allApprovedOne ? '이미 한 엔티티(승인)' : entStat.every((e) => !e) ? '엔티티 없음' : entIds.size > 1 ? '엔티티 여럿으로 갈림' : '일부만/후보';
    add(S.byCls, cls); add(S.entity, `${cls}|${entLabel}`);
    if (cls[0] === 'U') { add(S.fill, `${cls}|영양칸`, fillN); add(S.fill, `${cls}|원재료칸`, fillI); add(S.fill, `${cls}|영양칸(바코드)`, fillNbc); add(S.fill, `${cls}|원재료칸(바코드)`, fillIbc); }
    gOut.push({ rn, cls, n: ms.length, n_bc: ms.filter((m) => m.is_bc).length, n_cluster: clusters.length,
      name: ms[0].product_name, maker: ms[0].manufacturer, names: [...new Set(ms.map((m) => m.product_name))].slice(0, 6).join(' / '),
      weights: [...new Set(weights.map((w) => w || '?'))].join(' / '),
      has_nut: hasN.filter(Boolean).length, has_ing: hasI.filter(Boolean).length, fill_nut: fillN, fill_ing: fillI, fill_nut_bc: fillNbc, fill_ing_bc: fillIbc,
      entity: entLabel, entity_outsiders: outsiders, entity_has_profile: apprE.some((id) => eProf.has(id)), nd_empty_rows: pid.filter((id) => ndEmpty.has(id)).length });
    if (cls === 'U1') { add(S.u1, `엔티티:${entLabel}${outsiders > 0 ? '+묶음밖멤버' : ''}`); if (pid.some((id) => ndEmpty.has(id))) add(S.u1, '빈 nutrition_data 행 있음'); }
    clusters.forEach((cl, ci) => cl.forEach((i) => {
      const m = ms[i], e = ent.get(pid[i]);
      mOut.push({ rn, cls, cluster: ci + 1, product_id: pid[i], barcode: m.barcode, is_bc: m.is_bc, product_name: m.product_name, brand: m.brand, manufacturer: m.manufacturer,
        food_type: m.food_type, weight: weights[i] || '', has_nut: hasN[i], nut_basis: hasN[i] ? basisOf(nut.get(pid[i]).serving_size) : '', nut_source: hasN[i] ? nut.get(pid[i]).resolved_source : '',
        has_ing: hasI[i], ing_category_only: hasI[i] ? ingredientIsCategoryOnly(ing.get(pid[i]).raw_text) : '', ing_source: hasI[i] ? ing.get(pid[i]).source : '',
        entity_id: e ? e.entity_id : '', entity_member: e ? e.member_status : '', entity_route: e ? e.route : '', nd_empty_row: ndEmpty.has(pid[i]) });
    }));
  }
  S.brand_coverage = { rows: ids.length, with_brand: prods.filter((p) => !isBlank(p.brand) && byRn.get(p.rn).length >= 2).length };
  S.weight_known = mOut.filter((m) => m.weight).length;

  const LABEL = { U1: '통합(같은 SKU)', U2: '같은 제품·중량 미상', U3: '같은 배합·다른 포장', H1: '보류-변형 표시 다름', H2: '보류-이름 다름', H3: '보류-제조사 다름', H4: '보류-브랜드 다름' };
  console.log('\n================ 90 품목제조번호 묶음 ================');
  console.log(`묶음 ${S.groups.toLocaleString()} · 멤버 ${S.members.toLocaleString()} · 중량 확인 멤버 ${S.weight_known.toLocaleString()} · 브랜드 있는 멤버 ${S.brand_coverage.with_brand.toLocaleString()}`);
  for (const k of Object.keys(LABEL)) console.log(`  ${k} ${LABEL[k].padEnd(16)} 묶음 ${(S.byCls[k] || 0).toLocaleString()}`);
  console.log('채울 수 있는 칸(U 묶음 · 바코드 행):');
  for (const k of ['U1', 'U2', 'U3']) console.log(`  ${k} 영양 ${(S.fill[`${k}|영양칸(바코드)`] || 0).toLocaleString()} · 원재료 ${(S.fill[`${k}|원재료칸(바코드)`] || 0).toLocaleString()}`);
  console.log('U1 세부(통합 방식 결정용):'); for (const [k, v] of Object.entries(S.u1).sort()) console.log(`  ${k.padEnd(30)} ${v.toLocaleString()}`);
  console.log('기존 엔티티 상태:'); for (const [k, v] of Object.entries(S.entity).sort()) console.log(`  ${k.padEnd(30)} ${v.toLocaleString()}`);

  const dir = path.resolve(__dirname, '../../.tmp/s75'); fs.mkdirSync(dir, { recursive: true });
  const d = new Date().toISOString().slice(0, 10);
  const w = (f, rows) => { const cols = Object.keys(rows[0] || { rn: '' }); fs.writeFileSync(path.join(dir, f), '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n')); };
  w(`90_c005_groups_${d}.csv`, gOut); w(`90_c005_members_${d}.csv`, mOut);
  fs.writeFileSync(path.join(dir, `90_summary_${d}.json`), JSON.stringify(S, null, 1));
  console.log(`\n저장: ${dir}\\90_c005_groups_${d}.csv · 90_c005_members_${d}.csv · 90_summary_${d}.json`);
}
module.exports = { normName, variantKey, makerKey, fuzzyEq, parseWeight, ingredientIsCategoryOnly, classifyC005Group };
if (require.main === module) main().then(() => pool.end()).catch((e) => { console.error('ERR', e.message); pool.end(); process.exit(1); });
