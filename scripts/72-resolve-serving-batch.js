/**
 * 72-resolve-serving-batch.js — 인분 수·식품유형 T3 웹 해상 배치 (2026-07-29 세션41)
 * ============================================================================
 * 제이 지시(2026-07-29): "총량과 1회분량이 명확하지 않거나 식품유형이 명확하지 않으면,
 *   자동으로 제품 검색을 통해서 몇 인분인지와 식품유형을 파악해서 반영"
 *
 * 제이 확정 정책 2건 — 이 스크립트가 그 정책의 집행부다
 *   ① **제조사 공식 페이지·공적 출처만 자동 반영.** 커머스·블로그는 검토 큐.  → scripts/lib/official_source.js
 *   ② **배치 비동기.** 런타임 동기 검색 금지 — 앱 스캔은 즉시 응답하고 판정을 보류한다.
 *
 * 해상도 계층에서 이 스크립트의 위치 (src/services/servingResolver.js 헤더 참조)
 *   T0 라벨 표기 / T1 %기준치 판정 / T2 총량÷RACC  ← 무료·즉시. 여기까지가 엔진.
 *   **T3 웹검색  ← 이 파일.** 엔진이 답하지 못한 것만 온다.
 *   결과는 DB 에 영구 저장되므로 **같은 제품을 두 번 검색하지 않는다.**
 *
 * ★ 새로 만들지 않고 재사용한 것 (제이 안티패턴: "코드 아까우니까 가져가기" 회피)
 *   - Naver 쇼핑 OpenAPI 호출 패턴 : scripts/53-web-ingredient-harvester.js L96 naverCandidates()
 *   - 페이지 fetch / HTML→평문       : 53 L70 fetchText, L76 stripHtml
 *   - 거짓양성 가드 사고방식          : 53 L44 isPlaceholder()
 *   53 을 직접 require 하지 않는 이유: 53 은 module.exports 가 없는 실행 스크립트다.
 *   (다음 세션 과제: 53 의 공통부를 scripts/lib/web_fetch.js 로 승격하고 양쪽에서 쓰기)
 *
 * 실행 (제이 PC — 샌드박스는 Railway Postgres 미접속)
 *   node scripts/72-resolve-serving-batch.js --self-test        ← DB·네트워크 없이 로직 검증
 *   node scripts/72-resolve-serving-batch.js --limit 20         ← 조회+검색, DB 쓰기 없음(기본)
 *   node scripts/72-resolve-serving-batch.js --limit 20 --apply ← auto=true 인 것만 DB 반영
 *
 * 안전
 *   - `--apply` 없으면 **읽기 전용**으로 접속한다(스타트업 파라미터 + SHOW 검증).
 *   - `--apply` 라도 `official`/`authority` 출처만 쓴다. 나머지는 CSV 검토 큐로만 나간다.
 */
'use strict';

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');

const raccTable = require('../src/services/raccTable');
const { classifySource } = require('./lib/official_source');

const ARGV = process.argv.slice(2);
const SELF_TEST = ARGV.includes('--self-test');
const APPLY = ARGV.includes('--apply');
const LIMIT = (() => {
  const i = ARGV.indexOf('--limit');
  return i >= 0 && ARGV[i + 1] ? Math.max(1, parseInt(ARGV[i + 1], 10) || 20) : 20;
})();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ────────────────────────────────────────────────────────────────────────────
// 추출기 — 페이지 평문에서 인분 수·식품유형을 읽는다 (순수 함수 · self-test 대상)
// ────────────────────────────────────────────────────────────────────────────

/**
 * ★ 거짓양성 가드. 커머스·상세페이지의 안내문구를 값으로 오인하면 안 된다.
 *   53 의 isPlaceholder() 와 같은 취지 — "상품설명 참조" 류를 값으로 받지 않는다.
 */
const PLACEHOLDER = /(상품\s*설명|상세\s*(페이지|정보)|상품\s*이미지|이미지\s*참조|별도\s*표기|하단\s*참조|제품\s*표기\s*참조|해당\s*없음)/;

/**
 * 인분 수 추출. **명시적으로 "인분/인용/회분" 이라고 적힌 것만** 받는다.
 * ⚠ "N개입"·"N봉" 은 여기서 받지 않는다. 그건 포장 단위지 섭취 단위가 아니다.
 *    017 골든카레가 정확히 그 함정이다 — "6인분 블록 × 2" 에서 6도 2도 답이 아니고 12 다.
 */
const RE_SERVINGS = [
  // ★ 017 실물: "220g = 6인분 블록 × 2". '인분' 과 '×' 사이에 단위어가 낀다.
  //   이 규칙이 **가장 먼저** 와야 한다 — 뒤의 단순 '인분' 규칙이 먼저 걸리면 6 을 답으로 내고,
  //   그게 세션40 에서 Claude 가 틀렸던 바로 그 오답 유형이다(정답 12).
  { re: /(\d+)\s*인분[^\d×xX*)）]{0,8}[×xX*]\s*(\d+)/, rule: '인분×배수', pick: (m) => Number(m[1]) * Number(m[2]) },
  { re: /(\d+)\s*[)）]?\s*인분/,          rule: '인분',      pick: (m) => Number(m[1]) },
  { re: /(\d+)\s*인용/,                   rule: '인용',      pick: (m) => Number(m[1]) },
  { re: /약\s*(\d+)\s*회\s*분/,           rule: '회분',      pick: (m) => Number(m[1]) },
  { re: /(\d+)\s*회\s*분량/,              rule: '회분량',    pick: (m) => Number(m[1]) },
];

function extractServingsFromPage(textRaw) {
  if (!textRaw) return null;
  const text = String(textRaw).replace(/\s+/g, ' ');
  for (const { re, rule, pick } of RE_SERVINGS) {
    const m = text.match(re);
    if (!m) continue;
    const n = pick(m);
    if (!Number.isFinite(n) || n < 1 || n > 200) continue;
    const around = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
    if (PLACEHOLDER.test(around)) continue;      // 안내문구 근처면 버린다
    return { servings: n, rule, evidence: m[0].trim(), context: around.trim() };
  }
  return null;
}

/** 식품유형 추출 — "식품유형: 유탕면" 형태. 값 뒤는 2칸 공백·구분자·다음 필드에서 끊는다. */
const RE_FOODTYPE = /식품\s*(?:의\s*)?유형\s*[:：|]?\s*([^\n|·,;]{1,24}?)(?=\s{2,}|\s*[|/]|\s*(?:내용량|중량|원재료|품목|업소|제조|소비기한|유통기한|포장|보관|영양)|$)/;

function extractFoodTypeFromPage(textRaw) {
  if (!textRaw) return null;
  const text = String(textRaw).replace(/[ \t]+/g, ' ');
  const m = text.match(RE_FOODTYPE);
  if (!m) return null;
  const v = m[1].trim().replace(/[.。]$/, '');
  if (!v || v.length < 2) return null;
  if (PLACEHOLDER.test(v)) return null;
  return { foodType: v, evidence: m[0].trim(), racc: raccTable.lookupRacc(v) };
}

/** HTML → 평문. 53 L76 stripHtml 과 동일 취지. */
function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * 한 제품에 대한 최종 판정.
 * @returns {{decision:'auto'|'review'|'none', ...}}
 *   auto 는 **official/authority 출처에서 값을 얻었을 때만** 나온다.
 */
function decide(candidates) {
  // candidates: [{ url, trust, auto, servings, foodType, ... }]
  const withValue = candidates.filter((c) => c.servings != null || c.foodType != null);
  if (!withValue.length) return { decision: 'none', reason: '어떤 후보에서도 값을 얻지 못함', picked: null };

  const auto = withValue.find((c) => c.auto);
  if (auto) return { decision: 'auto', reason: `${auto.trust} 출처`, picked: auto };

  return { decision: 'review', reason: `공식 출처 없음(최선 ${withValue[0].trust})`, picked: withValue[0] };
}

// ────────────────────────────────────────────────────────────────────────────
// self-test
// ────────────────────────────────────────────────────────────────────────────
if (SELF_TEST) {
  let pass = 0, fail = 0;
  const eq = (n, got, exp) => {
    const ok = JSON.stringify(got) === JSON.stringify(exp);
    if (ok) pass++; else { fail++; console.log(`  ✗ ${n}: ${JSON.stringify(got)} ≠ ${JSON.stringify(exp)}`); }
  };

  console.log('=== 72 self-test (DB·네트워크 미사용) ===\n');

  // ★ 017 골든카레 — S&B 공식 표기 형태. 6인분 블록 × 2 = 12
  eq('017 인분×배수 → 12', extractServingsFromPage('220g (6인분 블록 × 2)').servings, 12);
  eq('017 rule', extractServingsFromPage('220g (6인분 블록 × 2)').rule, '인분×배수');
  eq('단순 12인분', extractServingsFromPage('12인분 대용량').servings, 12);
  eq('4인용', extractServingsFromPage('4인용 패밀리팩').servings, 4);
  eq('약 5회분', extractServingsFromPage('약 5회 분').servings, 5);
  eq('3회 분량', extractServingsFromPage('3회 분량').servings, 3);
  // ★ 포장 단위는 받지 않는다 — 섭취 단위가 아니다
  eq('6개입은 무시', extractServingsFromPage('총 390g 6개입'), null);
  eq('5봉지는 무시', extractServingsFromPage('600g 5봉지'), null);
  // 거짓양성 가드
  eq('안내문구 근처 무시', extractServingsFromPage('인분 수는 상품 설명 참조 2인분'), null);
  eq('범위 밖(0)', extractServingsFromPage('0인분'), null);
  eq('범위 밖(999)', extractServingsFromPage('999인분'), null);
  eq('빈 입력', extractServingsFromPage(''), null);
  eq('null', extractServingsFromPage(null), null);

  eq('식품유형 추출', extractFoodTypeFromPage('식품유형: 유탕면').foodType, '유탕면');
  eq('식품유형 RACC 연결', extractFoodTypeFromPage('식품유형: 유탕면').racc.racc, 120);
  eq('식품의 유형', extractFoodTypeFromPage('식품의 유형 : 즉석조리식품').foodType, '즉석조리식품');
  eq('괄호 유형 L4', extractFoodTypeFromPage('식품유형: 가공김(조미김)').racc.key, '조미김');
  eq('안내문구 배제', extractFoodTypeFromPage('식품유형: 상세정보 참조'), null);
  eq('없음', extractFoodTypeFromPage('제품명 신라면'), null);

  eq('HTML 제거', stripHtml('<div>식품유형: <b>유탕면</b></div>').includes('유탕면'), true);
  eq('script 제거', stripHtml('<script>var a="유탕면"</script>x').includes('유탕면'), false);

  // decide — 정책 집행 검증
  eq('공식 있으면 auto', decide([
    { url: 'a', trust: 'commerce', auto: false, servings: 4 },
    { url: 'b', trust: 'official', auto: true, servings: 12 },
  ]).decision, 'auto');
  eq('공식 값 채택', decide([
    { url: 'a', trust: 'commerce', auto: false, servings: 4 },
    { url: 'b', trust: 'official', auto: true, servings: 12 },
  ]).picked.servings, 12);
  eq('★ 커머스뿐이면 review', decide([{ url: 'a', trust: 'commerce', auto: false, servings: 4 }]).decision, 'review');
  eq('★ unknown 도 review', decide([{ url: 'a', trust: 'unknown', auto: false, servings: 4 }]).decision, 'review');
  eq('값 없으면 none', decide([{ url: 'a', trust: 'official', auto: true }]).decision, 'none');
  eq('빈 후보', decide([]).decision, 'none');

  console.log(`\n[self-test] 통과 ${pass} / 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}

// ────────────────────────────────────────────────────────────────────────────
// 실행부 — DB + 네트워크
// ────────────────────────────────────────────────────────────────────────────
const { Pool } = require('pg');

const NAVER_ID = process.env.NAVER_CLIENT_ID;
const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET;

const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } }
  : {
      host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'meokseon', user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
    };
poolConfig.connectionTimeoutMillis = 25000;
poolConfig.statement_timeout = 300000;
// ★ --apply 가 없으면 엔진 레벨에서 쓰기를 막는다(세션40 §3-3 교훈: 스타트업 파라미터로)
if (!APPLY) poolConfig.options = '-c default_transaction_read_only=on';

const pool = new Pool(poolConfig);

async function assertMode() {
  const r = await pool.query('SHOW default_transaction_read_only');
  const v = r.rows[0].default_transaction_read_only;
  if (!APPLY && v !== 'on') throw new Error(`읽기 전용이 안 걸렸다(SHOW=${v}). 중단.`);
  console.log(`[모드] ${APPLY ? '★ APPLY — DB 쓰기 허용' : '조회 전용'} · default_transaction_read_only=${v}`);
}

/** T3 대상 조회 — 엔진(T0~T2)이 답하지 못하는 제품 */
async function pickTargets(limit) {
  const r = await pool.query(`
    SELECT p.product_id, p.barcode, p.product_name, p.manufacturer, p.brand,
           p.food_type, p.total_content, p.content_unit, p.serving_size, p.servings_per_container
    FROM products p
    WHERE p.is_active
      AND p.product_name IS NOT NULL AND btrim(p.product_name) <> ''
      AND p.total_content IS NOT NULL AND p.total_content > 0
      AND p.servings_per_container IS NULL
      AND (p.food_type IS NULL OR btrim(p.food_type) = '' OR p.serving_size IS NULL)
    ORDER BY p.product_id
    LIMIT $1
  `, [limit]);
  // 식품유형이 있어도 RACC 표에 없으면 대상이다 — SQL 로는 판별 못 하니 여기서 거른다
  return r.rows.filter((row) => {
    const rt = raccTable.lookupRacc(row.food_type);
    return !rt.matched || rt.racc == null || row.serving_size == null;
  });
}

async function naverCandidates(q) {
  if (!NAVER_ID || !NAVER_SECRET) return [];
  const out = [];
  for (const ep of ['shop.json', 'webkr.json']) {
    try {
      const res = await fetch(`https://openapi.naver.com/v1/search/${ep}?query=${encodeURIComponent(q)}&display=15`, {
        headers: { 'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SECRET },
      });
      if (!res.ok) continue;
      const j = await res.json();
      for (const it of (j.items || [])) if (it.link) out.push(it.link);
    } catch (_) { /* 한 엔드포인트 실패가 전체를 막지 않는다 */ }
  }
  return [...new Set(out)];
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow',
      signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!/text|html/i.test(ct)) return null;
    return stripHtml(await res.text());
  } catch (_) { return null; }
}

function csvCell(v) {
  const s = v == null ? '' : String(v).replace(/\r?\n/g, ' ').trim();
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

(async () => {
  console.log('=== 72. 인분 수·식품유형 T3 웹 해상 배치 ===');
  console.log(`실행: ${new Date().toISOString()} · limit=${LIMIT}\n`);
  if (!NAVER_ID) console.log('⚠ NAVER_CLIENT_ID 없음 — 후보 검색이 비활성. .env 확인.\n');

  await assertMode();
  console.log(`[RACC] 표 로드 ${raccTable.isLoaded() ? 'OK' : '실패'} · ${raccTable.tableSize()}유형`);

  const targets = await pickTargets(LIMIT * 3);
  console.log(`[대상] ${targets.length}건 (조회 상한 ${LIMIT * 3})\n`);

  const rows = [];
  let nAuto = 0, nReview = 0, nNone = 0;

  for (const t of targets.slice(0, LIMIT)) {
    const q = [t.manufacturer, t.brand, t.product_name].filter(Boolean).join(' ').slice(0, 80);
    const urls = await naverCandidates(q);
    const cands = [];

    for (const url of urls.slice(0, 8)) {
      const cls = classifySource(url, t.manufacturer);
      // ★ 비용 절약: 자동 반영이 불가능한 출처는 **가져오지도 않는다**.
      //   단 검토 큐에 넣을 근거가 필요하므로 커머스는 1건만 남긴다.
      if (!cls.auto && cands.some((c) => !c.auto)) continue;
      const text = await fetchText(url);
      if (!text) continue;
      const sv = extractServingsFromPage(text);
      const ft = extractFoodTypeFromPage(text);
      if (!sv && !ft) continue;
      cands.push({
        url, trust: cls.trust, auto: cls.auto, trustReason: cls.reason,
        servings: sv ? sv.servings : null, servingsRule: sv ? sv.rule : null, servingsEvidence: sv ? sv.evidence : null,
        foodType: ft ? ft.foodType : null, foodTypeMapped: ft ? ft.racc.key : null,
      });
      if (cls.auto && sv && ft) break;     // 공식 출처에서 둘 다 얻었으면 그만
    }

    const d = decide(cands);
    if (d.decision === 'auto') nAuto++; else if (d.decision === 'review') nReview++; else nNone++;

    rows.push({
      product_id: t.product_id, barcode: t.barcode, product_name: t.product_name,
      manufacturer: t.manufacturer, total_content: t.total_content, content_unit: t.content_unit,
      food_type_db: t.food_type,
      decision: d.decision, reason: d.reason,
      url: d.picked ? d.picked.url : '', trust: d.picked ? d.picked.trust : '',
      servings: d.picked ? d.picked.servings : '', servings_rule: d.picked ? d.picked.servingsRule : '',
      servings_evidence: d.picked ? d.picked.servingsEvidence : '',
      food_type_web: d.picked ? d.picked.foodType : '', food_type_mapped: d.picked ? d.picked.foodTypeMapped : '',
      applied: '',
    });

    console.log(`  ${String(t.product_id).padStart(7)} ${String(t.product_name).slice(0, 24).padEnd(26)} → ${d.decision.padEnd(6)} ${d.picked ? `${d.picked.trust} servings=${d.picked.servings ?? '-'} type=${d.picked.foodType ?? '-'}` : d.reason}`);

    // ── DB 반영 — auto 만, official/authority 만 ──
    if (APPLY && d.decision === 'auto') {
      const p = d.picked;
      const sets = [], vals = [];
      if (p.servings != null) { sets.push(`servings_per_container = $${sets.length + 2}`); vals.push(p.servings); }
      if (p.foodTypeMapped && (!t.food_type || !raccTable.lookupRacc(t.food_type).matched)) {
        sets.push(`food_type = $${sets.length + 2}`); vals.push(p.foodType);
      }
      if (sets.length) {
        await pool.query(
          `UPDATE products SET ${sets.join(', ')}, updated_at = NOW() WHERE product_id = $1`,
          [t.product_id, ...vals]
        );
        rows[rows.length - 1].applied = 'Y';
      }
    }
  }

  // ── CSV ──
  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(outDir, `serving_resolve_${stamp}.csv`);
  const cols = Object.keys(rows[0] || { product_id: '' });
  // ★ UTF-8 BOM — 없으면 엑셀이 CP949 로 읽어 한글이 깨진다(세션40 §10)
  fs.writeFileSync(outPath, '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n'), 'utf8');

  console.log(`\n── 결과 ──`);
  console.log(`  자동 반영 대상(공식·공적 출처) : ${nAuto}`);
  console.log(`  검토 큐(커머스·미확인)          : ${nReview}`);
  console.log(`  값 못 얻음                      : ${nNone}`);
  console.log(`  CSV: ${outPath}`);
  if (!APPLY) console.log('\n  (조회 전용 실행 — DB 변경 없음. 반영하려면 --apply)');

  await pool.end();
  console.log('\nDONE');
})().catch(async (e) => {
  console.error('\n오류:', e.message || e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
