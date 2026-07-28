/**
 * 64-probe-sodium-shrink.js — 크라우드소싱 DB "1/1000 축소" 오염 실측 (★읽기 전용★)
 * =============================================================================
 * 정본: backends/먹선/IP/false_green_sodium_fix_2026-07-28.md
 * 발주: 인수인계_2026-07-28_세션39 §2-6 "다음 세션 1순위"
 *
 * ── 무엇을 확인하나 ─────────────────────────────────────────────────────────
 * 세션39에서 잡은 버그: OCR 파서가 `.replace(',', '.')` 로 천단위 콤마를 소수점으로
 * 바꿔서 "나트륨 1,790 mg" 을 **1.79 mg** 으로 읽었다. sanityCheck 는 상한만 보므로
 * 통과했고, 신호등이 RED→GREEN 으로 뒤집혔다(= 거짓 초록).
 *
 * 이 스크립트는 **코드가 아니라 데이터**를 본다:
 *   "그렇게 축소된 값이 이미 DB 에 저장돼 있는가? 몇 건인가? 어느 제품인가?"
 * 세션39 인수인계는 "내부테스트 단계라 양은 적을 가능성이 크나 **추정 금지**" 라고
 * 못박았다. 이 스크립트가 추정을 실측으로 바꾼다.
 *
 * ── 3개 레이어 ──────────────────────────────────────────────────────────────
 *  [A] 재파싱 대조 — **증거 기반, 확정**
 *      contributions.data->>'ocr_raw_text' 에 OCR 원문이 그대로 보존돼 있다.
 *      그 원문을 **수정된 현재 파서**로 다시 파싱해서, 함께 저장된
 *      data->'parsed_nutrition' 과 비교한다.
 *        저장값 × 1000 ≈ 재파싱값  →  축소 확정 (CONFIRMED)
 *      휴리스틱이 아니다. 같은 입력 → 옛 코드 결과 vs 새 코드 결과의 직접 대조다.
 *
 *  [B] nutrition_data 휴리스틱 — **의심, 확정 아님**
 *      원문이 없거나 contributions 에 연결되지 않는 마스터 행.
 *      ⚠ 한계: nutrition_data.sodium 은 DECIMAL(8,2) 이라 소수 2자리로 반올림돼
 *        저장된다. 그래서 "×1000 하면 정수" 같은 자릿수 서명이 **남지 않는다**
 *        (2자리 소수는 전부 ×1000 하면 정수다). 따라서 여기서는 범위·정합성만 본다.
 *        → [A] 로 판정되지 않은 행은 "미판정" 으로 남긴다. 지우지도 고치지도 않는다.
 *
 *  [C] products.total_content / servings_per_container — **같은 버그의 2차 피해**
 *      "총 내용량 1,500 mL" → 1.5 로 축소되면 servings_per_container = 총량÷1회분
 *      이 0.0125 인분 같은 값이 된다. 세션40에서 ocrParser.js L883
 *      (extractProductMeta) 에 **같은 결함이 미수정 상태로 남아 있던 것**을
 *      발견해 수정했다. 그 이전 저장분이 여기 걸린다.
 *
 * ── 안전장치 ────────────────────────────────────────────────────────────────
 *  · SELECT 만 실행한다. INSERT/UPDATE/DELETE 문자열이 이 파일에 없다.
 *  · 그것만 믿지 않는다 — 커넥션마다 `default_transaction_read_only = on` 을 걸어
 *    **DB 레벨에서** 쓰기를 거부하게 한다. 실수로 쓰기가 섞이면 에러가 난다.
 *  · 스키마를 information_schema 로 먼저 실측한다. 001_init_schema.sql 은
 *    production 과 다르다(contributions 의 data·status·device_id 컬럼이 001 에 없음).
 *    하드코딩하면 제이 PC 에서 그냥 죽는다.
 *
 * ── 실행 (제이 PC — 샌드박스는 Railway Postgres 미접속) ──────────────────────
 *   cd "D:\서박사의 영양공식\backends\먹선\meokseon-server"
 *   node scripts\64-probe-sodium-shrink.js
 *   node scripts\64-probe-sodium-shrink.js --verbose      # 원문 발췌까지 출력
 *   node scripts\64-probe-sodium-shrink.js --self-test    # DB 없이 탐지 로직만 검증
 *
 * 산출물: scripts/output/sodium_shrink_probe_<날짜>.csv  (UTF-8 BOM — 엑셀 한글)
 *        scripts/output/sodium_shrink_probe_<날짜>.md    (제이가 읽는 요약)
 */
'use strict';

try { require('dotenv').config(); } catch (_) { /* 환경변수 직접 사용 */ }
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const SELF_TEST = argv.includes('--self-test');
const OUT_DIR = path.join(__dirname, 'output');

// ════════════════════════════════════════════════════════════════════════════
// 1. 탐지 로직 (DB 무관 — --self-test 로 단독 검증 가능)
// ════════════════════════════════════════════════════════════════════════════

/**
 * 저장값이 재파싱값의 1/1000 인가?
 *
 * 왜 tolerance 가 필요한가: 저장 컬럼이 DECIMAL(8,2) 라 반올림된다.
 *   라벨 1,795 → (옛 파서) 1.795 → (DB) 1.80.  1.80 × 1000 = 1800 ≠ 1795.
 * 그래서 정확히 1/1000 을 요구하면 이런 행을 놓친다. 상대오차 1% 를 허용한다.
 * (1% 는 DECIMAL(8,2) 반올림 오차의 상한보다 넉넉하다: 0.005/1.0 = 0.5%)
 */
function isShrunk1000(stored, reparsed) {
  if (stored == null || reparsed == null) return false;
  const s = Number(stored), r = Number(reparsed);
  if (!isFinite(s) || !isFinite(r) || s <= 0 || r <= 0) return false;
  if (r < 1000) return false;                 // 원값이 1000 미만이면 천단위 콤마가 없었다
  return Math.abs(s * 1000 - r) / r <= 0.01;  // 상대오차 1% 이내
}

/**
 * [B] 레이어용 약한 신호 — 나트륨이 비정상적으로 작다.
 * 확정이 아니다. 기름·설탕·사탕·생수는 실제로 나트륨이 0~5mg 이다.
 * 그래서 "칼로리는 정상인데 나트륨만 작다" 는 정합성 조건을 함께 본다.
 */
function sodiumLooksShrunk(sodium, calories) {
  if (sodium == null) return null;
  const na = Number(sodium);
  if (!isFinite(na) || na <= 0 || na >= 10) return null;   // 1,000~9,999 → 1.0~9.999
  const kcal = calories == null ? null : Number(calories);
  // 칼로리가 있고 그게 정상 범위면 "가공식품인데 나트륨만 1자리" → 신호가 세진다
  const strong = kcal != null && isFinite(kcal) && kcal >= 50;
  return {
    suspect: true,
    strength: strong ? 'medium' : 'weak',
    implied: Math.round(na * 1000),
    note: strong
      ? `열량 ${kcal}kcal 인데 나트륨 ${na}mg — 축소 의심`
      : `나트륨 ${na}mg — 기름·당류·생수면 정상일 수 있음`,
  };
}

/** [C] 총 내용량 축소 — "1,500 mL" → 1.5 */
function contentLooksShrunk(totalContent, contentUnit, servingsPerContainer) {
  if (totalContent == null) return null;
  const tc = Number(totalContent);
  if (!isFinite(tc) || tc <= 0 || tc >= 10) return null;
  const unit = String(contentUnit || '').toLowerCase();
  if (!['g', 'ml', 'mg', '㎖'].includes(unit)) return null;   // kg·L 는 1.5L 가 정상
  const spc = servingsPerContainer == null ? null : Number(servingsPerContainer);
  const strong = spc != null && isFinite(spc) && spc > 0 && spc < 1;
  return {
    suspect: true,
    strength: strong ? 'strong' : 'medium',
    implied: Math.round(tc * 1000),
    note: strong
      ? `총 내용량 ${tc}${unit} · 제공횟수 ${spc}회 — 1회분보다 포장이 작다(불가능)`
      : `총 내용량 ${tc}${unit} — 1,${String(Math.round(tc * 1000)).slice(-3)} 축소 의심`,
  };
}

// 재파싱 대조 대상 영양소 — 라벨에서 1000 을 넘을 수 있는 것만.
// 지방·단백질(g)은 천단위 콤마가 안 붙는다. 나트륨(mg)·칼륨(mg)·열량(kcal 총량표기)이 대상.
const SHRINKABLE = ['sodium', 'calories', 'potassium', 'cholesterol', 'calcium'];

// ════════════════════════════════════════════════════════════════════════════
// 2. self-test — DB 없이 탐지 로직만 검증
// ════════════════════════════════════════════════════════════════════════════
function selfTest() {
  let pass = 0, fail = 0;
  const t = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) { pass++; } else { fail++; console.log(`  ✗ ${name}\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`); }
  };

  console.log('\n[self-test] isShrunk1000 — 축소 판정');
  t('1,790 → 1.79 축소',            isShrunk1000(1.79, 1790), true);
  t('1,795 → 1.80 (DECIMAL 반올림)', isShrunk1000(1.80, 1795), true);
  t('2,500 → 2.5 축소',             isShrunk1000(2.50, 2500), true);
  t('정상값(둘 다 1790)',            isShrunk1000(1790, 1790), false);
  t('원값 900 — 콤마 없음',          isShrunk1000(0.9, 900),   false);
  t('무관한 두 값',                  isShrunk1000(5, 1790),    false);
  t('null 저장값',                   isShrunk1000(null, 1790), false);
  t('0 저장값',                      isShrunk1000(0, 1790),    false);
  t('오차 5% — 다른 값으로 봄',       isShrunk1000(1.88, 1790), false);

  console.log('[self-test] sodiumLooksShrunk — 약한 신호');
  t('1.79mg + 500kcal → medium', sodiumLooksShrunk(1.79, 500)?.strength, 'medium');
  t('1.79mg + 열량없음 → weak',   sodiumLooksShrunk(1.79, null)?.strength, 'weak');
  t('2mg + 5kcal(생수) → weak',   sodiumLooksShrunk(2, 5)?.strength, 'weak');
  t('890mg 정상 → 신호없음',       sodiumLooksShrunk(890, 500), null);
  t('10mg 경계 밖',               sodiumLooksShrunk(10, 500), null);
  t('9.99mg 경계 안 → medium',    sodiumLooksShrunk(9.99, 500)?.strength, 'medium');
  t('0 → 신호없음',                sodiumLooksShrunk(0, 500), null);
  t('null → 신호없음',             sodiumLooksShrunk(null, 500), null);

  console.log('[self-test] contentLooksShrunk — 총 내용량');
  t('1.5mL + 0.0125회 → strong', contentLooksShrunk(1.5, 'mL', 0.0125)?.strength, 'strong');
  t('1.5mL + 제공횟수없음 → medium', contentLooksShrunk(1.5, 'mL', null)?.strength, 'medium');
  t('1.5L 은 정상 단위',          contentLooksShrunk(1.5, 'L', null), null);
  t('1.5kg 은 정상 단위',         contentLooksShrunk(1.5, 'kg', null), null);
  t('120g 정상',                  contentLooksShrunk(120, 'g', 1), null);
  t('null',                       contentLooksShrunk(null, 'g', 1), null);

  // 파서 회귀 — 세션40에 고친 extractProductMeta 총 내용량 결함
  console.log('[self-test] ocrParser.extractProductMeta — 세션40 수정분 회귀');
  try {
    const { extractProductMeta, parseNutrition } = require('../src/services/ocrParser');
    const 해표 = '해표 콩기름\n내용량 1.5L(25℃)\n영양정보\n총 내용량 1,500 mL\n100g당\n지방 100g';
    const m = extractProductMeta(해표);
    t('총 내용량 1,500 mL → 1500 (1.5 아님)', m.total_content, 1500);
    t('단위는 ml (L 아님)',                    m.content_unit, 'ml');
    const 신라면 = '1봉지(120g)당\n나트륨 1,790mg 90%\n열량 500kcal';
    const n = parseNutrition(신라면);
    t('나트륨 1,790mg → 1790 (1.79 아님)',     n.sodium, 1790);
    t('basis = per_serving',                   n._basis, 'per_serving');
  } catch (e) {
    fail++; console.log(`  ✗ ocrParser 로드/실행 실패: ${e.message}`);
  }

  console.log(`\n[self-test] ${pass} / ${pass + fail} 통과`);
  if (fail > 0) { console.log('★ 실패가 있다. 탐지 로직을 고치기 전에는 DB 실측 결과를 믿지 말 것.'); process.exit(1); }
  console.log('★ 탐지 로직 정상. 이제 제이 PC 에서 --self-test 없이 실행하면 DB 실측이 돈다.');
}

// ════════════════════════════════════════════════════════════════════════════
// 3. DB 실측
// ════════════════════════════════════════════════════════════════════════════
async function probe() {
  const { Pool } = require('pg');
  const { parseNutrition, extractProductMeta } = require('../src/services/ocrParser');

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
  poolConfig.max = 3;
  const pool = new Pool(poolConfig);

  // ★ DB 레벨 쓰기 차단. 코드 리뷰가 아니라 엔진이 막는다.
  pool.on('connect', (client) => { client.query('SET default_transaction_read_only = on'); });

  const q = (sql, p) => pool.query(sql, p);
  const rows = [];       // CSV 로 나갈 결과
  const summary = { A_confirmed: 0, A_checked: 0, A_clean: 0, B_suspect: 0, C_suspect: 0, unadjudicated: 0 };

  try {
    // ── 0) 스키마 실측 ─────────────────────────────────────────────────────
    // 001_init_schema.sql 은 production 과 다르다. 하드코딩 금지.
    const colsRes = await q(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('products','nutrition_data','contributions')`
    );
    const cols = {};
    for (const r of colsRes.rows) (cols[r.table_name] ||= new Set()).add(r.column_name);
    const has = (t, c) => cols[t] && cols[t].has(c);

    console.log('── 스키마 실측 ──');
    for (const t of ['products', 'nutrition_data', 'contributions']) {
      console.log(`  ${t}: ${cols[t] ? [...cols[t]].join(', ') : '(테이블 없음)'}`);
    }

    if (!cols.contributions) {
      console.log('\n⚠ contributions 테이블이 없다. [A] 재파싱 대조를 건너뛴다.');
    }

    // ── A) 재파싱 대조 (확정) ──────────────────────────────────────────────
    const canLayerA = has('contributions', 'data') && has('contributions', 'contribution_type');
    if (canLayerA) {
      console.log('\n── [A] 재파싱 대조 (증거 기반) ──');
      const selCols = ['c.contribution_id', 'c.product_id', 'c.data', 'c.created_at'];
      if (has('contributions', 'device_id')) selCols.push('c.device_id');
      const aRes = await q(
        `SELECT ${selCols.join(', ')},
                p.product_name, p.barcode, p.c005_report_no,
                n.sodium AS master_sodium, n.calories AS master_calories, n.data_source AS master_source
           FROM contributions c
           LEFT JOIN products p       ON p.product_id = c.product_id
           LEFT JOIN nutrition_data n ON n.product_id = c.product_id
          WHERE c.contribution_type = 'ocr_nutrition'
          ORDER BY c.contribution_id`
      );
      summary.A_checked = aRes.rows.length;
      console.log(`  ocr_nutrition 기여 ${aRes.rows.length}건 조회`);

      for (const r of aRes.rows) {
        const d = typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || {});
        const rawText = d.ocr_raw_text || '';
        const storedNut = d.parsed_nutrition || {};
        if (!rawText.trim()) {
          summary.unadjudicated++;
          rows.push({
            layer: 'A', verdict: 'NO_RAW_TEXT', strength: '-',
            contribution_id: r.contribution_id, product_id: r.product_id,
            product_name: r.product_name || '', barcode: r.barcode || '',
            c005_report_no: r.c005_report_no || '',
            field: '-', stored: '', reparsed: '', implied: '',
            master_sodium: r.master_sodium ?? '', master_source: r.master_source ?? '',
            note: '원문(ocr_raw_text)이 비어 재파싱 대조 불가 — 미판정',
            created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
          });
          continue;
        }

        // ★ 수정된 현재 파서로 같은 원문을 다시 읽는다.
        let re = {};
        let reMeta = {};
        try { re = parseNutrition(rawText) || {}; } catch (e) { re = { _error: e.message }; }
        try { reMeta = extractProductMeta(rawText) || {}; } catch (_) { reMeta = {}; }

        let hitAny = false;
        for (const f of SHRINKABLE) {
          if (isShrunk1000(storedNut[f], re[f])) {
            hitAny = true;
            summary.A_confirmed++;
            rows.push({
              layer: 'A', verdict: 'CONFIRMED_SHRUNK', strength: 'confirmed',
              contribution_id: r.contribution_id, product_id: r.product_id,
              product_name: r.product_name || '', barcode: r.barcode || '',
              c005_report_no: r.c005_report_no || '',
              field: f, stored: storedNut[f], reparsed: re[f], implied: re[f],
              master_sodium: r.master_sodium ?? '', master_source: r.master_source ?? '',
              note: `저장 ${storedNut[f]} × 1000 ≈ 재파싱 ${re[f]} — 축소 확정`
                + (f === 'sodium' && r.master_sodium != null
                    && isShrunk1000(r.master_sodium, re[f])
                    ? ' ★마스터(nutrition_data)에도 축소값이 반영됨' : ''),
              created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
            });
          }
        }
        // 총 내용량 축소도 같은 방식으로 확정 가능
        const storedTc = storedNut.total_content ?? d.user_input?.total_content;
        const reTc = re.total_content ?? reMeta.total_content;
        if (isShrunk1000(storedTc, reTc)) {
          hitAny = true;
          summary.A_confirmed++;
          rows.push({
            layer: 'A', verdict: 'CONFIRMED_SHRUNK', strength: 'confirmed',
            contribution_id: r.contribution_id, product_id: r.product_id,
            product_name: r.product_name || '', barcode: r.barcode || '',
            c005_report_no: r.c005_report_no || '',
            field: 'total_content', stored: storedTc, reparsed: reTc, implied: reTc,
            master_sodium: r.master_sodium ?? '', master_source: r.master_source ?? '',
            note: `총 내용량 ${storedTc} × 1000 ≈ ${reTc} — 축소 확정(세션40 L883 결함)`,
            created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
          });
        }
        if (!hitAny) summary.A_clean++;

        if (VERBOSE && hitAny) {
          console.log(`  · contribution ${r.contribution_id} (${r.product_name || 'unknown'})`);
          console.log(`      원문 발췌: ${rawText.replace(/\s+/g, ' ').slice(0, 160)}`);
        }
      }
      console.log(`  확정 축소 ${summary.A_confirmed}건 · 정상 ${summary.A_clean}건 · 미판정(원문없음) ${summary.unadjudicated}건`);
    }

    // ── B) nutrition_data 휴리스틱 (의심) ──────────────────────────────────
    if (cols.nutrition_data) {
      console.log('\n── [B] nutrition_data 범위 검사 (의심 — 확정 아님) ──');
      const bRes = await q(
        `SELECT n.product_id, n.sodium, n.calories, n.data_source,
                p.product_name, p.barcode, p.c005_report_no, p.verification
           FROM nutrition_data n
           JOIN products p ON p.product_id = n.product_id
          WHERE n.data_source::text LIKE 'ocr%'
            AND n.sodium IS NOT NULL AND n.sodium > 0 AND n.sodium < 10
          ORDER BY n.sodium`
      );
      for (const r of bRes.rows) {
        const sig = sodiumLooksShrunk(r.sodium, r.calories);
        if (!sig) continue;
        // [A] 에서 이미 확정된 product 는 중복 보고하지 않는다
        const already = rows.some((x) => x.layer === 'A' && x.verdict === 'CONFIRMED_SHRUNK'
          && String(x.product_id) === String(r.product_id) && x.field === 'sodium');
        if (already) continue;
        summary.B_suspect++;
        rows.push({
          layer: 'B', verdict: 'SUSPECT', strength: sig.strength,
          contribution_id: '', product_id: r.product_id,
          product_name: r.product_name || '', barcode: r.barcode || '',
          c005_report_no: r.c005_report_no || '',
          field: 'sodium', stored: r.sodium, reparsed: '', implied: sig.implied,
          master_sodium: r.sodium, master_source: r.data_source ?? '',
          note: `${sig.note} (원문 대조 불가 — 미판정. 추정으로 고치지 말 것)`,
          created_at: '',
        });
      }
      console.log(`  의심 ${summary.B_suspect}건 (나트륨 0<x<10mg, ocr 출처)`);
    }

    // ── C) products 총 내용량 / 제공횟수 ───────────────────────────────────
    if (cols.products) {
      console.log('\n── [C] products.total_content 검사 ──');
      const cRes = await q(
        `SELECT product_id, product_name, barcode, c005_report_no,
                total_content, content_unit, serving_size, servings_per_container, data_source
           FROM products
          WHERE data_source::text LIKE 'ocr%'
            AND total_content IS NOT NULL AND total_content > 0 AND total_content < 10
          ORDER BY total_content`
      );
      for (const r of cRes.rows) {
        const sig = contentLooksShrunk(r.total_content, r.content_unit, r.servings_per_container);
        if (!sig) continue;
        summary.C_suspect++;
        rows.push({
          layer: 'C', verdict: 'SUSPECT', strength: sig.strength,
          contribution_id: '', product_id: r.product_id,
          product_name: r.product_name || '', barcode: r.barcode || '',
          c005_report_no: r.c005_report_no || '',
          field: 'total_content', stored: `${r.total_content}${r.content_unit || ''}`,
          reparsed: '', implied: sig.implied,
          master_sodium: '', master_source: r.data_source ?? '',
          note: sig.note, created_at: '',
        });
      }
      console.log(`  의심 ${summary.C_suspect}건`);
    }

    // ── 산출물 ─────────────────────────────────────────────────────────────
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `sodium_shrink_probe_${stamp}`;

    const csvCell = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const COLS = ['layer', 'verdict', 'strength', 'contribution_id', 'product_id', 'product_name',
                  'barcode', 'c005_report_no', 'field', 'stored', 'reparsed', 'implied',
                  'master_sodium', 'master_source', 'note', 'created_at'];
    const csv = '\uFEFF' + COLS.join(',') + '\n'
      + rows.map((r) => COLS.map((c) => csvCell(r[c])).join(',')).join('\n') + '\n';
    fs.writeFileSync(path.join(OUT_DIR, base + '.csv'), csv, 'utf8');

    const confirmed = rows.filter((r) => r.verdict === 'CONFIRMED_SHRUNK');
    const md = [
      `# 나트륨 1/1000 축소 오염 실측 — ${stamp}`,
      '',
      `> 읽기 전용 probe. **아무것도 수정하지 않았다.**`,
      `> 정본: \`IP/false_green_sodium_fix_2026-07-28.md\` · 발주: 세션39 인수인계 §2-6`,
      '',
      '## 결론',
      '',
      `| 항목 | 건수 |`,
      `|---|---|`,
      `| [A] ocr_nutrition 기여 총 검사 | ${summary.A_checked} |`,
      `| **[A] 축소 확정 (재파싱 대조)** | **${summary.A_confirmed}** |`,
      `| [A] 정상 확인 | ${summary.A_clean} |`,
      `| [A] 미판정 (원문 없음) | ${summary.unadjudicated} |`,
      `| [B] nutrition_data 의심 | ${summary.B_suspect} |`,
      `| [C] total_content 의심 | ${summary.C_suspect} |`,
      '',
      summary.A_confirmed === 0 && summary.B_suspect === 0 && summary.C_suspect === 0
        ? '**오염 없음.** 내부테스트 단계라 저장 경로를 탄 기여분이 없었거나, 모두 정상 파싱됐다.'
        : '**오염 있음.** 아래 목록을 보고 정정 방침을 정한다. 이 스크립트는 고치지 않는다.',
      '',
      '## 확정 목록',
      '',
      confirmed.length === 0 ? '(없음)' : [
        '| product_id | 제품명 | 필드 | 저장값 | 실제값 | 품목보고번호 |',
        '|---|---|---|---|---|---|',
        ...confirmed.map((r) => `| ${r.product_id} | ${r.product_name} | ${r.field} | ${r.stored} | ${r.reparsed} | ${r.c005_report_no} |`),
      ].join('\n'),
      '',
      '## 다음 판단 (제이 확인 필요)',
      '',
      '1. **확정분 정정 방식** — 재파싱값으로 UPDATE 할지, 행을 삭제하고 재수집할지.',
      '   재파싱값은 *수정된 파서가 같은 원문에서 뽑은 값*이라 근거가 있다. 다만 basis 판별이',
      '   `unknown` 인 건은 UPDATE 대상에서 빼야 한다 (`null = 판정 없음 ≠ 안전`).',
      '2. **미판정분** — 원문이 없어 대조가 불가능하다. 추정으로 고치지 않는다.',
      '   `verification` 을 낮추거나 재수집 큐에 넣는 쪽이 안전하다.',
      '3. **정정 스크립트는 별도 파일**로 만든다. 이 파일은 읽기 전용을 유지한다.',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(OUT_DIR, base + '.md'), md, 'utf8');

    console.log('\n════════ 요약 ════════');
    console.log(`  [A] 축소 확정 : ${summary.A_confirmed}`);
    console.log(`  [A] 정상      : ${summary.A_clean}`);
    console.log(`  [A] 미판정    : ${summary.unadjudicated}`);
    console.log(`  [B] 의심      : ${summary.B_suspect}`);
    console.log(`  [C] 의심      : ${summary.C_suspect}`);
    console.log(`\n  → ${path.join(OUT_DIR, base + '.csv')}`);
    console.log(`  → ${path.join(OUT_DIR, base + '.md')}`);
    if (summary.A_confirmed + summary.B_suspect + summary.C_suspect === 0) {
      console.log('\n  ★ 오염 없음. 세션39 §2-6 미확인 항목 종결.');
    } else {
      console.log('\n  ★ 오염 발견. md 를 읽고 정정 방침을 정할 것. 이 스크립트는 아무것도 고치지 않았다.');
    }
  } finally {
    await pool.end();
  }
}

// ════════════════════════════════════════════════════════════════════════════
if (SELF_TEST) {
  selfTest();
} else {
  probe().catch((e) => {
    console.error('\n✗ probe 실패:', e.message);
    if (/password|ECONNREFUSED|ENOTFOUND|timeout/i.test(e.message)) {
      console.error('  → DATABASE_URL 환경변수를 확인하세요. 이 스크립트는 제이 PC 에서 실행해야 합니다');
      console.error('    (Claude 샌드박스는 Railway Postgres 에 접속하지 못합니다 — 세션39 §9).');
    }
    process.exit(1);
  });
}
