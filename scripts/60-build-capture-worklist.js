/**
 * 60-build-capture-worklist.js — 수동 캡처 워크리스트 생성기 (읽기 전용)
 * =====================================================================
 * 설계 정본: backends/먹선/IP/manual_capture_pipeline_v1_2026-07-28.md
 *
 * 무엇을 하나:
 *   "원재료는 있는데 영양이 없는" 품목(ing_only)을 우선순위 순으로 골라
 *   제이가 쿠팡에서 캡처할 수 있게 **번호가 매겨진 리스트**로 뽑는다.
 *
 * 왜 ing_only 인가 (2026-07-23 실측, IP/nutrition_gap_decision):
 *   영양 16.8%가 병목이고, 이 그룹은 **영양 사진 1장으로 "둘 다" 승격**된다.
 *   (영양만 보유 9,931 그룹은 원재료 1장이 필요 — 규모가 1/4.6)
 *
 * 우선순위 = 4개 신호 복합 스코어 (제이 승인, 2026-07-28):
 *   s_maker    제조사 규모   0~5  (해당 제조사의 ing_only 품목 수 + 대형 브랜드 보너스)
 *   s_barcodes 바코드 묶임   0~2  (그룹 내 products 행 수 = 리뉴얼/멀티팩 = 실유통 신호)
 *   s_type     식품유형      0~2  (라면·과자·음료·유제품 등 스캔 빈도 높은 유형)
 *   s_popular  인기 상품명   0~3  (check-popular-products-v2.js 의 100개 리스트 재사용)
 *   s_scanmiss 스캔 미스     0~5  (--scan-miss-csv 로 주면 가산. 없으면 0)
 *
 * 다양성 캡 (한 제조사·브랜드가 리스트를 독식하지 않게):
 *   --max-per-maker 5 · --max-per-brand 2 · --max-per-type 10
 *
 * 중복 방지: scripts/output/ 의 기존 capture_worklist_*.csv 를 읽어 **이미 발행한 품목을 자동 제외**하고
 *   번호도 이어받는다. 그냥 같은 명령을 다시 실행하면 다음 배치가 나온다.
 *   (--start-no 는 번호만 바꾼다 — 선택을 바꾸지 않는다. 처음부터 다시 뽑으려면 output 의 기존 csv 를 지울 것)
 *
 * 실행 (제이 PC):
 *   node scripts/60-build-capture-worklist.js                    # 1차 50건
 *   node scripts/60-build-capture-worklist.js                    # 그대로 다시 = 2차 50건(자동 이어짐)
 *   node scripts/60-build-capture-worklist.js --limit 30 --max-per-maker 3
 *   node scripts/60-build-capture-worklist.js --scan-miss-csv .tmp/scan_miss.csv
 *   node scripts/60-build-capture-worklist.js --barcodes-file .tmp/마트에서찍은바코드.txt
 *   node scripts/60-build-capture-worklist.js --no-exclude       # 중복 허용(재발행)
 *
 * ★ 읽기 전용(SELECT만). 쓰기 없음.
 */
'use strict';

try { require('dotenv').config(); } catch (_) { /* 환경변수 직접 사용 */ }
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ── CLI ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LIMIT = parseInt(arg('--limit', '50'), 10);
const START_NO_ARG = argv.includes('--start-no') ? parseInt(arg('--start-no', '1'), 10) : null;
const NO_EXCLUDE = argv.includes('--no-exclude');   // 이전 배치 중복 허용(재발행용)
const SCAN_MISS_CSV = arg('--scan-miss-csv', null);
const BARCODES_FILE = arg('--barcodes-file', null);
const OUT_DIR = path.join(__dirname, 'output');

// ★ 다양성 캡 (2026-07-28 1차 실행 후 추가)
// 1차 실행에서 상위 50건이 롯데웰푸드 6·동서식품 3 으로 쏠리고 '빼빼로' 변종 3개,
// '설레임' 변종 3개가 들어왔다(라면·음료·유제품 0건). 원인 = s_maker 가 제조사 규모를
// 점수화 → 대형사 독식, s_popular 가 부분매칭 → 맛 변종이 동일 점수, 동점 tie-break 가
// 다시 제조사 규모 → 편중 증폭. 같은 노동이면 분산된 50건이 커버리지에 유리하다.
const MAX_PER_MAKER = parseInt(arg('--max-per-maker', '5'), 10);
const MAX_PER_BRAND = parseInt(arg('--max-per-brand', '2'), 10);
const MAX_PER_TYPE = parseInt(arg('--max-per-type', '10'), 10);

// ── DB ───────────────────────────────────────────────────────────────
const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'meokseon',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
    };
poolConfig.connectionTimeoutMillis = 25000;
poolConfig.statement_timeout = 300000;
poolConfig.keepAlive = true;
const pool = new Pool(poolConfig);

// ── 스코어 사전 ───────────────────────────────────────────────────────
// 대형 제조사 — 마트 매대 점유가 큰 곳. 제조사명 부분매칭(정규화 후).
const BIG_MAKERS = [
  '농심', '오뚜기', '삼양', '팔도', '풀무원', '씨제이', 'CJ', '대상', '동원',
  '롯데', '해태', '오리온', '크라운', '빙그레', '남양', '매일', '서울우유',
  '남양유업', '한국야쿠르트', '동서', '광동', '웅진', '코카콜라', '롯데칠성',
  '하이트진로', '샘표', '청정원', '사조', '푸르밀', '연세우유', '베지밀', '정식품',
  '아워홈', '신세계푸드', '이마트', '오뚜기라면', '농협', '한성기업', '목우촌',
];

// 스캔 빈도가 높을 식품유형 — 식약처 PRDLST_DCNM 값 기준 부분매칭.
const HOT_TYPES = [
  '유탕면', '면류', '국수', '라면',
  '과자', '스낵', '캔디', '초콜릿', '비스킷',
  '음료', '탄산', '과채', '커피', '다류', '혼합음료',
  '우유', '가공유', '발효유', '유음료', '치즈', '아이스크림', '빙과',
  '빵류', '떡류', '즉석섭취', '즉석조리', '간편조리', '소시지', '햄',
  '어묵', '만두', '김치', '조미김', '시리얼',
];

// 인기 상품명 — check-popular-products-v2.js 의 POPULAR_PRODUCTS 에서 name 만 추출(동일 소스 유지).
const POPULAR_NAMES = [
  '신라면', '진라면', '너구리', '안성탕면', '짜파게티', '불닭볶음면', '삼양라면', '팔도비빔면', '참깨라면',
  '새우깡', '포카칩', '꼬깔콘', '칙촉', '오레오', '빼빼로', '초코파이', '에이스', '홈런볼', '감자깡',
  '코카콜라', '펩시', '환타', '스프라이트', '밀키스', '포카리스웨트', '게토레이', '비타500', '박카스',
  '서울우유', '남양우유', '매일우유', '바나나맛우유', '야쿠르트', '비요뜨', '덴마크우유', '불가리스',
  '맥심모카골드', '카누', '프렌치카페', '메로나', '비비빅', '월드콘', '설레임', '누가바', '수박바',
];

const norm = (s) => (s || '').replace(/\s|\(|\)|주식회사|㈜|유한회사/g, '').toLowerCase();
const hit = (hay, list) => { const h = norm(hay); return list.some((k) => h.includes(norm(k))); };

/** 브랜드 키 — '딸기 빼빼로'·'빼빼로 스키니'·'카카오 빼빼로' 를 같은 것으로 묶는다.
 *  인기 키워드가 매칭되면 그것을, 아니면 제품명 첫 어절을 브랜드로 본다. */
function brandKey(r) {
  const h = norm(r.product_name);
  const k = POPULAR_NAMES.find((n) => h.includes(norm(n)));
  if (k) return 'p:' + norm(k);
  const first = String(r.product_name || '').trim().split(/\s+/)[0] || '?';
  return 'n:' + norm(first);
}

/** 점수 순서를 유지하면서 제조사·브랜드·유형 상한을 지켜 고른다(greedy).
 *  상한 때문에 정원이 안 차면 상한을 3배로 완화, 그래도 모자라면 상한 없이 채운다. */
function pickDiverse(list, limit, caps) {
  const out = [];
  const seen = new Set();
  const pass = (maker, brand, type) => {
    const cm = new Map(), cb = new Map(), ct = new Map();
    for (const r of out) {           // 이전 패스에서 고른 것도 카운트에 반영
      cm.set(r._mk, (cm.get(r._mk) || 0) + 1);
      cb.set(r._bk, (cb.get(r._bk) || 0) + 1);
      ct.set(r._tk, (ct.get(r._tk) || 0) + 1);
    }
    for (const r of list) {
      if (out.length >= limit) return;
      if (seen.has(r.c005_report_no)) continue;
      if ((cm.get(r._mk) || 0) >= maker) continue;
      if ((cb.get(r._bk) || 0) >= brand) continue;
      if ((ct.get(r._tk) || 0) >= type) continue;
      out.push(r); seen.add(r.c005_report_no);
      cm.set(r._mk, (cm.get(r._mk) || 0) + 1);
      cb.set(r._bk, (cb.get(r._bk) || 0) + 1);
      ct.set(r._tk, (ct.get(r._tk) || 0) + 1);
    }
  };
  pass(caps.maker, caps.brand, caps.type);
  if (out.length < limit) pass(caps.maker * 3, caps.brand * 3, caps.type * 3);
  if (out.length < limit) pass(Infinity, Infinity, Infinity);
  return out;
}

// ── 헬퍼 ─────────────────────────────────────────────────────────────
function readLines(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** ★ 이미 발행한 워크리스트를 읽어 중복 발행을 막는다.
 *  --start-no 는 번호만 바꿀 뿐 선택을 바꾸지 않는다 → 이게 없으면 2차 배치가
 *  1차와 똑같은 품목을 번호만 바꿔 다시 낸다. (2026-07-28 설계 시 발견)
 *  반환: { seen:Set<report_no>, maxNo:number } */
function loadPrevious(dir) {
  const seen = new Set();
  let maxNo = 0;
  if (!fs.existsSync(dir)) return { seen, maxNo };
  for (const f of fs.readdirSync(dir)) {
    if (!/^capture_worklist_.*\.csv$/.test(f)) continue;
    const txt = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, '');
    for (const ln of txt.split(/\r?\n/).slice(1)) {
      if (!ln.trim()) continue;
      const cols = ln.split(',');                 // no, c005_report_no, ... (둘 다 콤마 없음)
      const no = parseInt((cols[0] || '').replace(/"/g, '').trim(), 10);
      const rn = (cols[1] || '').replace(/"/g, '').trim();
      if (rn) seen.add(rn);
      if (Number.isFinite(no) && no > maxNo) maxNo = no;
    }
  }
  return { seen, maxNo };
}

// ── 메인 ─────────────────────────────────────────────────────────────
(async () => {
  console.log('=== 수동 캡처 워크리스트 생성 (읽기 전용) ===');
  console.log(`실행: ${new Date().toISOString()}`);

  // 이전 배치 자동 제외 + 번호 이어받기
  const prev = NO_EXCLUDE ? { seen: new Set(), maxNo: 0 } : loadPrevious(OUT_DIR);
  const START_NO = START_NO_ARG != null ? START_NO_ARG : prev.maxNo + 1;
  console.log(`대상: ing_only(원재료 O · 영양 X) · 상위 ${LIMIT}건 · 번호 ${START_NO}부터`);
  if (prev.seen.size) console.log(`[중복 방지] 이전 배치 ${prev.seen.size}품목 제외 (최대 번호 ${prev.maxNo})`);
  console.log('');

  // scan_miss 바코드 (선택) — 영양공식 Supabase 에서 뽑아온 CSV. 한 줄에 바코드 하나 또는 첫 컬럼.
  const scanMiss = new Set(
    readLines(SCAN_MISS_CSV).map((l) => l.split(',')[0].replace(/"/g, '').trim()).filter((b) => /^\d{8,14}$/.test(b)),
  );
  if (SCAN_MISS_CSV) console.log(`[scan_miss] 바코드 ${scanMiss.size}건 로드 → +5점 가산`);

  // 마트 직접 선정 바코드 (선택) — 이 바코드가 속한 품목만 대상으로 좁힌다.
  const manualBarcodes = readLines(BARCODES_FILE).map((l) => l.trim()).filter((b) => /^\d{8,14}$/.test(b));
  if (BARCODES_FILE) console.log(`[마트 직접] 바코드 ${manualBarcodes.length}건 → 이 품목만 대상`);

  // 1) ing_only 품목 그룹 + 대표 제품 1개
  //    대표 = 바코드 있는 것 우선 → 이름 짧은 것(부제·용량 표기 적은 원형에 가까움)
  const params = [];
  let manualFilter = '';
  if (manualBarcodes.length) {
    params.push(manualBarcodes);
    manualFilter = `AND g.c005_report_no IN (
      SELECT c005_report_no FROM products WHERE barcode = ANY($${params.length}) AND c005_report_no IS NOT NULL
    )`;
  }

  console.log('[1/3] ing_only 품목 추출 중... (수 분 소요 가능)');
  const { rows } = await pool.query(`
    WITH grp AS (
      SELECT p.c005_report_no,
             BOOL_OR(pi.product_id IS NOT NULL) AS has_ing,
             BOOL_OR(nd.product_id IS NOT NULL) AS has_nut,
             COUNT(*)::int                      AS n_barcodes
      FROM products p
      LEFT JOIN (SELECT DISTINCT product_id FROM product_ingredients
                 WHERE raw_text IS NOT NULL AND btrim(raw_text) <> '') pi ON pi.product_id = p.product_id
      LEFT JOIN (SELECT DISTINCT product_id FROM nutrition_data)        nd ON nd.product_id = p.product_id
      WHERE p.is_active AND p.c005_report_no IS NOT NULL AND p.c005_report_no <> ''
      GROUP BY p.c005_report_no
    ),
    g AS (SELECT * FROM grp WHERE has_ing AND NOT has_nut),
    rep AS (
      SELECT DISTINCT ON (p.c005_report_no)
             p.c005_report_no, p.product_id, p.product_name, p.barcode,
             p.manufacturer, p.food_type
      FROM products p
      JOIN g ON g.c005_report_no = p.c005_report_no
      WHERE p.is_active
      ORDER BY p.c005_report_no,
               (p.barcode IS NULL) ASC,
               length(COALESCE(p.product_name, '')) ASC
    )
    SELECT r.*, g.n_barcodes
    FROM rep r JOIN g ON g.c005_report_no = r.c005_report_no
    WHERE TRUE ${manualFilter}
  `, params);
  console.log(`      ing_only 품목: ${rows.length.toLocaleString()}건`);
  const pool_rows = rows.filter((r) => !prev.seen.has(String(r.c005_report_no)));
  if (prev.seen.size) console.log(`      제외 후 대상: ${pool_rows.length.toLocaleString()}건`);
  if (!pool_rows.length) { await pool.end(); return console.log('대상 없음 — 종료'); }

  // 2) 제조사별 ing_only 품목 수 (규모 프록시)
  console.log('[2/3] 스코어 계산...');
  // 제조사 규모는 배치와 무관한 값이라 **전체 ing_only** 기준으로 센다(제외 전 rows).
  const makerCount = new Map();
  for (const r of rows) {
    const k = norm(r.manufacturer) || '(무명)';
    makerCount.set(k, (makerCount.get(k) || 0) + 1);
  }

  const scored = pool_rows.map((r) => {
    const mc = makerCount.get(norm(r.manufacturer) || '(무명)') || 0;
    let s_maker = mc >= 200 ? 3 : mc >= 50 ? 2 : mc >= 10 ? 1 : 0;
    if (hit(r.manufacturer, BIG_MAKERS)) s_maker += 2;                 // 최대 5
    const s_barcodes = r.n_barcodes >= 3 ? 2 : r.n_barcodes === 2 ? 1 : 0;
    const s_type = hit(r.food_type, HOT_TYPES) ? 2 : 0;
    const s_popular = hit(r.product_name, POPULAR_NAMES) ? 3 : 0;
    const s_scanmiss = (r.barcode && scanMiss.has(String(r.barcode).trim())) ? 5 : 0;
    const total = s_maker + s_barcodes + s_type + s_popular + s_scanmiss;
    const why = [
      s_scanmiss && '스캔미스',
      s_popular && '인기상품',
      s_maker >= 4 ? '대형제조사' : s_maker && '제조사규모',
      s_type && '주요유형',
      s_barcodes && `바코드${r.n_barcodes}`,
    ].filter(Boolean).join('·');
    const o = { ...r, mc, s_maker, s_barcodes, s_type, s_popular, s_scanmiss, total, why };
    o._mk = norm(r.manufacturer) || '(무명)';
    o._tk = norm(r.food_type) || '(무유형)';
    o._bk = brandKey(r);
    return o;
  });

  // 동점 tie-break 에서 제조사 규모(mc)를 쓰면 편중이 증폭된다 → 바코드 수 우선, 그다음 이름 짧은 순.
  scored.sort((a, b) => b.total - a.total
    || b.n_barcodes - a.n_barcodes
    || String(a.product_name || '').length - String(b.product_name || '').length
    || String(a.c005_report_no).localeCompare(String(b.c005_report_no)));

  // 전체 점수 분포 — 선택 전. 상위 구간이 얼마나 두꺼운지 알아야 배치 계획이 선다.
  const allDist = {};
  for (const r of scored) allDist[r.total] = (allDist[r.total] || 0) + 1;
  console.log(`      전체 점수 분포: ${Object.entries(allDist).sort((a, b) => b[0] - a[0])
    .map(([k, v]) => `${k}점 ${v.toLocaleString()}`).join(' · ')}`);

  const picked = pickDiverse(scored, LIMIT, { maker: MAX_PER_MAKER, brand: MAX_PER_BRAND, type: MAX_PER_TYPE })
    .map((r, i) => ({ no: String(START_NO + i).padStart(3, '0'), ...r }));

  // 3) 산출
  console.log('[3/3] 파일 작성...');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `capture_worklist_${stamp}_${START_NO}-${START_NO + picked.length - 1}`;

  // (a) 기계용 CSV — 파싱 단계가 번호→품목을 되찾는 정본. UTF-8 BOM(엑셀 한글).
  const cols = ['no', 'c005_report_no', 'product_id', 'product_name', 'manufacturer', 'food_type',
                'barcode', 'n_barcodes', 'need', 'score', 'why'];
  const csv = '\uFEFF' + cols.join(',') + '\n' +
    picked.map((r) => [r.no, r.c005_report_no, r.product_id, r.product_name, r.manufacturer,
                       r.food_type, r.barcode, r.n_barcodes, '영양', r.total, r.why]
      .map(csvCell).join(',')).join('\n') + '\n';
  fs.writeFileSync(path.join(OUT_DIR, base + '.csv'), csv, 'utf8');

  // (b) 제이용 체크리스트 — 이것만 보고 쿠팡에서 캡처하면 된다.
  const md = [
    `# 캡처 워크리스트 ${stamp} — ${picked[0].no}~${picked[picked.length - 1].no} (${picked.length}건)`,
    '',
    '**필요한 것: 영양정보 사진 1장** (이 품목들은 원재료가 이미 있습니다)',
    '',
    `**저장 위치**: \`D:\\서박사의 영양공식\\backends\\먹선\\.tmp\\captures\\\``,
    '**파일명**: `<번호>_영양.jpg` — 예: `001_영양.jpg`. 번호만 맞으면 됩니다.',
    '',
    '> 영양성분표가 **1회 제공량당 / 총 내용량당 두 열**이면 두 열이 다 보이게 찍어주세요.',
    '> 잘리면 숫자가 몇 배씩 틀어집니다.',
    '> 제품명·용량이 같이 보이면 좋습니다(엉뚱한 제품인지 자동 대조에 씁니다).',
    '',
    '| 번호 | 제품명 | 제조사 | 유형 | 바코드 | 우선순위 근거 |',
    '|---|---|---|---|---|---|',
    ...picked.map((r) => `| **${r.no}** | ${r.product_name || '?'} | ${r.manufacturer || '?'} | ${r.food_type || '?'} | ${r.barcode || '-'} | ${r.why || '-'} |`),
    '',
    '---',
    `생성: \`node scripts/60-build-capture-worklist.js --limit ${LIMIT}\``,
    `다양성 캡: 제조사 ≤${MAX_PER_MAKER} · 브랜드 ≤${MAX_PER_BRAND} · 유형 ≤${MAX_PER_TYPE}`,
    '',
    `**다음 배치**: 같은 명령을 그대로 다시 실행하면 됩니다 — 이 배치 ${picked.length}품목은 자동 제외되고 번호도 ${START_NO + picked.length}부터 이어집니다.`,
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, base + '.md'), md, 'utf8');

  // 콘솔 요약
  console.log(`\n── 상위 10 미리보기 ──`);
  for (const r of picked.slice(0, 10)) {
    console.log(`  ${r.no}  [${r.total}] ${(r.product_name || '?').slice(0, 28).padEnd(30)} ${(r.manufacturer || '?').slice(0, 12).padEnd(13)} ${r.why}`);
  }
  const dist = {};
  for (const r of picked) dist[r.total] = (dist[r.total] || 0) + 1;
  console.log(`\n선정 점수 분포: ${Object.entries(dist).sort((a, b) => b[0] - a[0]).map(([k, v]) => `${k}점 ${v}건`).join(' · ')}`);

  // 다양성 확인 — 캡이 실제로 작동했는지 눈으로 본다
  const top = (key) => {
    const m = new Map();
    for (const r of picked) { const k = r[key] || '?'; m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, v]) => `${k}(${v})`).join(' · ');
  };
  console.log(`제조사 ${new Set(picked.map((r) => r._mk)).size}곳: ${top('manufacturer')}`);
  console.log(`유형   ${new Set(picked.map((r) => r._tk)).size}종: ${top('food_type')}`);

  console.log(`\nCSV : ${path.join(OUT_DIR, base + '.csv')}   (파싱 단계가 쓰는 정본)`);
  console.log(`체크리스트: ${path.join(OUT_DIR, base + '.md')}   ← 이걸 보고 캡처하세요`);
  console.log('\nDONE (읽기 전용 — DB 변경 없음)');
  await pool.end();
})().catch((e) => { console.error('오류:', e.message || e); process.exit(1); });
