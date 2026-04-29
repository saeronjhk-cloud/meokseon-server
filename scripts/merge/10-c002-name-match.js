/**
 * Step 10: C002 제품명 기반 원재료 매칭 (report_no 미매칭 제품 대상)
 *
 * 기존 Step 2에서 report_no 기반으로 매칭되지 않은 34,845개 제품을 대상으로
 * C002 staging_ingredients의 prdlst_nm(제품명) + bssh_nm(제조사)을 활용한
 * fuzzy matching을 수행하여 원재료 커버리지를 확대합니다.
 *
 * 전략:
 * Pass 1: 정확 매칭 — 제품명이 C002 prdlst_nm에 완전 포함 + 제조사 일치
 * Pass 2: 퍼지 매칭 — pg_trgm similarity ≥ 0.5 + 제조사 일치
 * Pass 3: 느슨 매칭 — pg_trgm similarity ≥ 0.6 (제조사 무관, 단 제품명 5자 이상)
 *
 * 사용법:
 *   node scripts/merge/10-c002-name-match.js                  # Pass 1+2 실행 (DB 저장)
 *   node scripts/merge/10-c002-name-match.js --dry-run        # Pass 1+2 dry-run
 *   node scripts/merge/10-c002-name-match.js --max-pass 3     # Pass 1+2+3 실행
 *   node scripts/merge/10-c002-name-match.js --review-pass3   # Pass 3 검토 리포트 출력 (DB 미변경)
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { normalizeMaker, resolveCanonical, isSameMaker, loadSynonyms } = require('./utils/normalize-maker');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'meokseon',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  statement_timeout: 120000,
});

const DRY_RUN = process.argv.includes('--dry-run');
const REVIEW_PASS3 = process.argv.includes('--review-pass3');

// --max-pass N 파싱 (기본값: 2)
function getMaxPass() {
  const idx = process.argv.indexOf('--max-pass');
  if (idx !== -1 && process.argv[idx + 1]) {
    return parseInt(process.argv[idx + 1]);
  }
  return REVIEW_PASS3 ? 3 : 2;
}
const MAX_PASS = getMaxPass();

// --pass3-min-sim N 파싱 (기본값: 0.6)
function getPass3MinSim() {
  const idx = process.argv.indexOf('--pass3-min-sim');
  if (idx !== -1 && process.argv[idx + 1]) {
    return parseFloat(process.argv[idx + 1]);
  }
  return 0.6;
}
const PASS3_MIN_SIM = getPass3MinSim();

const BATCH_SIZE = 500;

// 제조사명 정규화 — utils/normalize-maker.js에서 import
// normalizeMaker, resolveCanonical, isSameMaker 사용

function progress(current, total, label, extra = '') {
  const pct = ((current / total) * 100).toFixed(1);
  const elapsed = (Date.now() - globalStart) / 1000;
  const eta = current > 0 ? ((elapsed / current) * (total - current)).toFixed(0) : '?';
  process.stdout.write(`\r  ${label}: ${pct}% (${current.toLocaleString()}/${total.toLocaleString()}) | ${elapsed.toFixed(0)}s elapsed, ~${eta}s left ${extra}    `);
}

let globalStart;

async function ensureIndexes(client) {
  console.log('  인덱스 확인 중...');

  const { rows: trgmIdx } = await client.query(`
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'staging_ingredients'
      AND indexdef LIKE '%gin_trgm_ops%'
      AND indexdef LIKE '%prdlst_nm%'
    LIMIT 1
  `);

  if (trgmIdx.length === 0) {
    console.log('  ⏳ prdlst_nm GIN trigram 인덱스 생성 중...');
    await client.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_staging_ing_prdlst_nm_trgm
      ON staging_ingredients USING gin(prdlst_nm gin_trgm_ops)
    `);
    console.log('  ✅ 인덱스 생성 완료');
  } else {
    console.log('  ✅ GIN trigram 인덱스 존재');
  }

  const { rows: bsshIdx } = await client.query(`
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'staging_ingredients'
      AND indexdef LIKE '%bssh_nm%'
    LIMIT 1
  `);

  if (bsshIdx.length === 0) {
    console.log('  ⏳ bssh_nm 인덱스 생성 중...');
    await client.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_staging_ing_bssh_nm
      ON staging_ingredients USING gin(bssh_nm gin_trgm_ops)
    `);
    console.log('  ✅ bssh_nm 인덱스 생성 완료');
  }
}

async function getUnmatchedProducts(client) {
  const { rows } = await client.query(`
    SELECT p.product_id, p.product_name, p.manufacturer, p.c005_report_no
    FROM products p
    WHERE p.c005_report_no IS NOT NULL AND p.c005_report_no != ''
      AND NOT EXISTS (
        SELECT 1 FROM product_ingredients pi WHERE pi.product_id = p.product_id
      )
    ORDER BY p.product_id
  `);
  return rows;
}

// Pass 1: 정확 포함 매칭 + 제조사 일치
async function pass1ExactContain(client, product) {
  const name = product.product_name;
  if (!name || name.length < 3) return null;

  const maker = normalizeMaker(product.manufacturer);
  if (!maker || maker.length < 2) return null;

  const { rows } = await client.query(`
    SELECT prdlst_report_no, prdlst_nm, bssh_nm,
           string_agg(rawmtrl_nm, ', ' ORDER BY id) AS combined_raw
    FROM staging_ingredients
    WHERE prdlst_nm ILIKE '%' || $1 || '%'
    GROUP BY prdlst_report_no, prdlst_nm, bssh_nm
    HAVING length(string_agg(rawmtrl_nm, ', ' ORDER BY id)) > 5
    ORDER BY length(prdlst_nm) ASC
    LIMIT 10
  `, [name]);

  for (const r of rows) {
    if (isSameMaker(product.manufacturer, r.bssh_nm)) {
      return { ...r, pass: 1, matchType: 'exact_contain+maker' };
    }
  }

  return null;
}

// Pass 2: 퍼지 매칭 + 제조사 일치
async function pass2FuzzyWithMaker(client, product) {
  const name = product.product_name;
  const maker = normalizeMaker(product.manufacturer);
  if (!name || name.length < 3 || !maker || maker.length < 2) return null;

  const { rows } = await client.query(`
    SELECT prdlst_report_no, prdlst_nm, bssh_nm,
           similarity(prdlst_nm, $1) AS sim,
           string_agg(rawmtrl_nm, ', ' ORDER BY id) AS combined_raw
    FROM staging_ingredients
    WHERE prdlst_nm % $1
    GROUP BY prdlst_report_no, prdlst_nm, bssh_nm
    HAVING length(string_agg(rawmtrl_nm, ', ' ORDER BY id)) > 5
    ORDER BY similarity(prdlst_nm, $1) DESC
    LIMIT 5
  `, [name]);

  for (const r of rows) {
    if (r.sim < 0.5) continue;
    if (isSameMaker(product.manufacturer, r.bssh_nm)) {
      return { ...r, pass: 2, matchType: `fuzzy(${r.sim.toFixed(2)})+maker` };
    }
  }

  return null;
}

// Pass 3: 느슨 퍼지 매칭 (제조사 무관, 높은 유사도 요구)
async function pass3LooseFuzzy(client, product) {
  const name = product.product_name;
  if (!name || name.length < 5) return null;

  const { rows } = await client.query(`
    SELECT prdlst_report_no, prdlst_nm, bssh_nm,
           similarity(prdlst_nm, $1) AS sim,
           string_agg(rawmtrl_nm, ', ' ORDER BY id) AS combined_raw
    FROM staging_ingredients
    WHERE prdlst_nm % $1
    GROUP BY prdlst_report_no, prdlst_nm, bssh_nm
    HAVING length(string_agg(rawmtrl_nm, ', ' ORDER BY id)) > 5
    ORDER BY similarity(prdlst_nm, $1) DESC
    LIMIT 1
  `, [name]);

  if (rows.length > 0 && rows[0].sim >= PASS3_MIN_SIM) {
    return { ...rows[0], pass: 3, matchType: `loose_fuzzy(${rows[0].sim.toFixed(2)})` };
  }

  return null;
}

async function main() {
  globalStart = Date.now();
  const client = await pool.connect();

  try {
    const modeLabel = REVIEW_PASS3 ? '📋 PASS 3 검토 리포트'
                    : DRY_RUN ? '🔍 DRY RUN (DB 미변경)'
                    : '✏️  실행';

    console.log('========================================');
    console.log('  Step 10: C002 제품명 기반 원재료 매칭');
    console.log(`  모드: ${modeLabel}`);
    console.log(`  적용 범위: Pass 1~${MAX_PASS}${MAX_PASS >= 3 ? ` (Pass 3 최소 유사도: ${PASS3_MIN_SIM})` : ''}`);
    console.log('========================================\n');

    // 0. 동의어 사전 로드
    loadSynonyms();

    // 1. 인덱스 확인
    await ensureIndexes(client);

    // 2. 미매칭 제품 로드
    const products = await getUnmatchedProducts(client);
    console.log(`\n  미매칭 제품 (원재료 없음): ${products.length.toLocaleString()}건\n`);

    if (products.length === 0) {
      console.log('  ✅ 모든 제품에 원재료가 등록되어 있습니다.');
      return;
    }

    // similarity 임계값 설정
    await client.query(`SET pg_trgm.similarity_threshold = 0.3`);

    // 3. 매칭 실행
    const stats = { pass1: 0, pass2: 0, pass3: 0, skipped: 0, errors: 0 };
    const sampleMatches = [];
    const pass3Results = []; // Pass 3 검토용 전체 결과
    const total = products.length;

    for (let i = 0; i < total; i++) {
      const p = products[i];
      if (i % 100 === 0) progress(i, total, '매칭 진행');

      try {
        // Pass 1
        let match = await pass1ExactContain(client, p);

        // Pass 2
        if (!match) match = await pass2FuzzyWithMaker(client, p);

        // Pass 3 (MAX_PASS >= 3일 때만)
        if (!match && MAX_PASS >= 3) match = await pass3LooseFuzzy(client, p);

        if (!match) {
          stats.skipped++;
          continue;
        }

        stats[`pass${match.pass}`]++;

        // Pass 3 검토 모드: 전체 결과 수집
        if (match.pass === 3 && REVIEW_PASS3) {
          const c1 = resolveCanonical(p.manufacturer);
          const c2 = resolveCanonical(match.bssh_nm);
          const makerMatch = c1 && c2 && c1 === c2;
          const makerPartial = !makerMatch && c1 && c2 && (c1.includes(c2) || c2.includes(c1));
          pass3Results.push({
            product_id: p.product_id,
            product_name: p.product_name,
            manufacturer: p.manufacturer || '(없음)',
            matched_name: match.prdlst_nm,
            matched_maker: match.bssh_nm,
            similarity: parseFloat(match.sim).toFixed(2),
            maker_status: makerMatch ? '✅일치' : makerPartial ? '🟡유사' : '❌불일치',
            raw_length: match.combined_raw?.length || 0,
          });
        }

        // 샘플 수집 (처음 30건)
        if (sampleMatches.length < 30) {
          sampleMatches.push({
            product: p.product_name,
            manufacturer: p.manufacturer,
            matched: match.prdlst_nm,
            matchedMaker: match.bssh_nm,
            type: match.matchType,
            rawLen: match.combined_raw?.length || 0,
          });
        }

        // DB 저장 (DRY_RUN이 아니고, REVIEW_PASS3 모드에서는 Pass 3 제외)
        const shouldSave = !DRY_RUN && !REVIEW_PASS3 && match.combined_raw;
        const shouldSavePass3Review = !DRY_RUN && REVIEW_PASS3 && match.pass < 3 && match.combined_raw;

        if (shouldSave || shouldSavePass3Review) {
          // 이미 등록된 원재료가 있으면 건너뛰기
          const { rows: existing } = await client.query(`
            SELECT 1 FROM product_ingredients
            WHERE product_id = $1
            LIMIT 1
          `, [p.product_id]);

          if (existing.length === 0) {
            await client.query(`
              INSERT INTO product_ingredients (product_id, raw_text, prdlst_report_no, source)
              VALUES ($1, $2, $3, 'c002_name')
            `, [p.product_id, match.combined_raw, match.prdlst_report_no]);

            await client.query(`
              INSERT INTO merge_log (step, status, source_table, target_product_id, detail)
              VALUES ('step10_c002_name', 'matched', 'staging_ingredients', $1, $2)
            `, [p.product_id, JSON.stringify({
              match_type: match.matchType,
              matched_name: match.prdlst_nm,
              similarity: match.sim || 1.0,
            })]);
          }
        }

      } catch (err) {
        stats.errors++;
        if (stats.errors <= 5) {
          console.error(`\n  ❌ ${p.product_name}: ${err.message}`);
        }
      }
    }

    progress(total, total, '매칭 완료');
    console.log('');

    // 4. 결과 출력
    const totalMatched = stats.pass1 + stats.pass2 + (MAX_PASS >= 3 ? stats.pass3 : 0);
    const savedCount = REVIEW_PASS3 ? stats.pass1 + stats.pass2 : (DRY_RUN ? 0 : totalMatched);

    console.log('\n========================================');
    console.log('  매칭 결과');
    console.log('========================================');
    console.log(`  대상 제품:              ${total.toLocaleString()}건`);
    console.log(`  Pass 1 (정확+제조사):   ${stats.pass1.toLocaleString()}건 ${MAX_PASS >= 1 && !DRY_RUN ? '→ ✅ DB 저장' : ''}`);
    console.log(`  Pass 2 (퍼지+제조사):   ${stats.pass2.toLocaleString()}건 ${MAX_PASS >= 2 && !DRY_RUN ? '→ ✅ DB 저장' : ''}`);
    if (MAX_PASS >= 3) {
      const p3label = REVIEW_PASS3 ? '→ 📋 검토 대기' : (DRY_RUN ? '' : '→ ✅ DB 저장');
      console.log(`  Pass 3 (느슨 퍼지):     ${stats.pass3.toLocaleString()}건 ${p3label}`);
    }
    console.log(`  총 매칭:                ${totalMatched.toLocaleString()}건 (${(totalMatched/total*100).toFixed(1)}%)`);
    if (!DRY_RUN) {
      console.log(`  DB 저장:                ${savedCount.toLocaleString()}건`);
    }
    console.log(`  미매칭:                 ${stats.skipped.toLocaleString()}건`);
    console.log(`  오류:                   ${stats.errors.toLocaleString()}건`);

    // 매칭 샘플 출력
    if (sampleMatches.length > 0) {
      console.log('\n── 매칭 샘플 (최대 30건) ──');
      for (const s of sampleMatches) {
        console.log(`  ${s.product} [${s.manufacturer}]`);
        console.log(`    → ${s.matched} [${s.matchedMaker}] | ${s.type} | 원재료 ${s.rawLen}자`);
      }
    }

    // Pass 3 검토 리포트
    if (REVIEW_PASS3 && pass3Results.length > 0) {
      // 콘솔 요약
      const makerOk = pass3Results.filter(r => r.maker_status === '✅일치').length;
      const makerPartial = pass3Results.filter(r => r.maker_status === '🟡유사').length;
      const makerBad = pass3Results.filter(r => r.maker_status === '❌불일치').length;

      console.log('\n========================================');
      console.log('  Pass 3 검토 요약');
      console.log('========================================');
      console.log(`  총 ${pass3Results.length}건`);
      console.log(`  제조사 일치:     ${makerOk}건 (${(makerOk/pass3Results.length*100).toFixed(1)}%)`);
      console.log(`  제조사 유사:     ${makerPartial}건 (${(makerPartial/pass3Results.length*100).toFixed(1)}%)`);
      console.log(`  제조사 불일치:   ${makerBad}건 (${(makerBad/pass3Results.length*100).toFixed(1)}%)`);

      // 유사도 분포
      const simBuckets = { '1.00': 0, '0.90+': 0, '0.80+': 0, '0.70+': 0, '0.60+': 0 };
      for (const r of pass3Results) {
        const s = parseFloat(r.similarity);
        if (s >= 1.0) simBuckets['1.00']++;
        else if (s >= 0.9) simBuckets['0.90+']++;
        else if (s >= 0.8) simBuckets['0.80+']++;
        else if (s >= 0.7) simBuckets['0.70+']++;
        else simBuckets['0.60+']++;
      }
      console.log('\n  유사도 분포:');
      for (const [k, v] of Object.entries(simBuckets)) {
        if (v > 0) console.log(`    ${k}: ${v}건`);
      }

      // CSV 파일로 전체 결과 저장
      const csvPath = path.join(__dirname, '..', '..', 'pass3-review.csv');
      const csvHeader = 'product_id,product_name,manufacturer,matched_name,matched_maker,similarity,maker_status,raw_length\n';
      const csvRows = pass3Results.map(r =>
        `${r.product_id},"${r.product_name}","${r.manufacturer}","${r.matched_name}","${r.matched_maker}",${r.similarity},${r.maker_status},${r.raw_length}`
      ).join('\n');
      fs.writeFileSync(csvPath, csvHeader + csvRows, 'utf-8');
      console.log(`\n  📄 전체 결과 CSV: ${csvPath}`);

      // 불일치 샘플 출력 (최대 20건)
      const badSamples = pass3Results.filter(r => r.maker_status === '❌불일치').slice(0, 20);
      if (badSamples.length > 0) {
        console.log('\n── 제조사 불일치 샘플 (최대 20건) ──');
        for (const r of badSamples) {
          console.log(`  ${r.product_name} [${r.manufacturer}]`);
          console.log(`    → ${r.matched_name} [${r.matched_maker}] | sim: ${r.similarity} | ${r.maker_status}`);
        }
      }

      // 일치 샘플 출력 (최대 10건)
      const goodSamples = pass3Results.filter(r => r.maker_status === '✅일치').slice(0, 10);
      if (goodSamples.length > 0) {
        console.log('\n── 제조사 일치 샘플 (최대 10건) ──');
        for (const r of goodSamples) {
          console.log(`  ${r.product_name} [${r.manufacturer}]`);
          console.log(`    → ${r.matched_name} [${r.matched_maker}] | sim: ${r.similarity} | ${r.maker_status}`);
        }
      }
    }

    // 5. 개선된 커버리지 계산
    if (!DRY_RUN && !REVIEW_PASS3) {
      const { rows: [{ count: newTotal }] } = await client.query(
        'SELECT count(DISTINCT product_id) FROM product_ingredients'
      );
      const { rows: [{ count: productTotal }] } = await client.query(
        'SELECT count(*) FROM products'
      );
      console.log(`\n── 전체 커버리지 변화 ──`);
      console.log(`  원재료 보유 제품: ${parseInt(newTotal).toLocaleString()} / ${parseInt(productTotal).toLocaleString()} (${(newTotal/productTotal*100).toFixed(1)}%)`);
    }

    console.log('\n========================================');
    console.log(`  소요 시간: ${((Date.now() - globalStart) / 1000).toFixed(1)}초`);
    console.log('========================================');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
