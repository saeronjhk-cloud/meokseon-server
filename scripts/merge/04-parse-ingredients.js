/**
 * Step 4: 원재료 파싱 (Stack 기반 계층 파서)
 *
 * product_ingredients 테이블의 raw_text를 파싱하여:
 * 1. Stack 기반 계층적 괄호 파싱 (복합 원재료 분리)
 * 2. 각 원재료를 additives DB와 대조
 * 3. 매칭된 첨가물을 product_additives에 등록
 * 4. parsed_ingredients JSONB에 파싱 결과 저장
 *
 * 배치: 1,000건 단위
 * 사용법: node scripts/merge/04-parse-ingredients.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'meokseon',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  statement_timeout: 60000,
});

const BATCH_SIZE = 1000;

function progress(current, total, label) {
  const pct = ((current / total) * 100).toFixed(1);
  process.stdout.write(`\r  ${label}: ${pct}% (${current.toLocaleString()}/${total.toLocaleString()})`);
}

/**
 * Stack 기반 계층적 괄호 파서
 * "밀가루, 혼합제제(타피오카전분, 구연산), 정제수" 같은 구조를 파싱
 *
 * @param {string} text - 원재료명 텍스트
 * @returns {Array<Object>} 파싱된 원재료 배열
 */
function parseIngredientText(text) {
  if (!text || text.trim().length === 0) return [];

  // 전처리
  let cleaned = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\{/g, '(').replace(/\}/g, ')')  // 중괄호 → 소괄호
    .replace(/【/g, '(').replace(/】/g, ')')   // 겹낫표 → 소괄호
    .replace(/（/g, '(').replace(/）/g, ')');   // 전각 → 반각

  // 알레르기 정보 제거
  cleaned = cleaned.replace(/\[?알레르기\s*유발물질\s*[:]\s*[^\]]*\]?/g, '');
  cleaned = cleaned.replace(/\*[^*]*\*/g, '');  // *알레르기 관련 표시* 제거

  // Stack 기반 파싱
  const result = [];
  const stack = [];    // 현재 depth 위치의 parent 참조
  let current = '';
  let depth = 0;

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (char === '(') {
      if (depth === 0) {
        // 최상위 레벨: 현재까지의 텍스트가 상위 원재료명
        const parentName = current.trim();
        if (parentName) {
          const parent = { name: parentName, sub_ingredients: [], raw: '' };
          stack.push(parent);
          current = '';
        }
      } else {
        current += char;
      }
      depth++;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && stack.length > 0) {
        // 괄호 닫힘: 내부 텍스트를 하위 성분으로 파싱
        const parent = stack[stack.length - 1];
        parent.raw = current.trim();

        // 쉼표로 하위 성분 분리
        const subs = current.split(',').map(s => s.trim()).filter(s => s.length > 0);
        parent.sub_ingredients = subs.map(s => {
          // 함량 비율 추출
          const pctMatch = s.match(/(\d+[.,]?\d*)\s*%/);
          const percentage = pctMatch ? parseFloat(pctMatch[1].replace(',', '.')) : null;
          const name = s.replace(/\d+[.,]?\d*\s*%/, '').trim();
          return { name, percentage };
        });

        result.push(parent);
        stack.pop();
        current = '';
      } else {
        current += char;
      }
    } else if (char === ',' && depth === 0) {
      // 최상위 레벨 쉼표: 성분 구분
      const name = current.trim();
      if (name && stack.length === 0) {
        result.push({ name, sub_ingredients: [], raw: '' });
      } else if (name && stack.length > 0) {
        // stack에 pending parent가 있으면 먼저 push
        const parent = stack.pop();
        result.push(parent);
        result.push({ name, sub_ingredients: [], raw: '' });
      }
      current = '';
    } else {
      current += char;
    }
  }

  // 잔여 텍스트 처리
  const remaining = current.trim();
  if (remaining) {
    if (stack.length > 0) {
      const parent = stack.pop();
      parent.raw = remaining;
      parent.sub_ingredients = remaining.split(',').map(s => ({
        name: s.trim(), percentage: null,
      })).filter(s => s.name.length > 0);
      result.push(parent);
    } else {
      result.push({ name: remaining, sub_ingredients: [], raw: '' });
    }
  }

  // 빈 항목 제거
  return result.filter(r => r.name && r.name.length > 0);
}

/**
 * 파싱된 원재료에서 모든 개별 성분명 추출 (하위 포함)
 */
function extractAllIngredientNames(parsed) {
  const names = [];
  for (const item of parsed) {
    names.push(item.name);
    if (item.sub_ingredients && item.sub_ingredients.length > 0) {
      for (const sub of item.sub_ingredients) {
        if (sub.name) names.push(sub.name);
      }
    }
  }
  return names;
}

async function main() {
  const client = await pool.connect();

  try {
    console.log('========================================');
    console.log('  Step 4: 원재료 파싱 + 첨가물 매칭');
    console.log('========================================');

    const startTime = Date.now();

    // ── 테이블 존재 확인 ──
    const { rows: tableCheck } = await client.query(`
      SELECT 1 FROM information_schema.tables WHERE table_name = 'product_ingredients'
    `);
    if (tableCheck.length === 0) {
      console.error('  ❌ product_ingredients 테이블이 없습니다. 먼저 01-migration.js를 실행하세요.');
      process.exit(1);
    }

    // ── 첨가물 사전 로드 ──
    let additiveRows = [];
    try {
      const result = await client.query(`
        SELECT additive_id, name_ko, name_en, risk_grade, risk_color, category
        FROM additives
      `);
      additiveRows = result.rows;
    } catch (e) {
      console.log('  ⚠️ additives 테이블이 없거나 접근 불가 — 첨가물 매칭 없이 파싱만 수행');
    }

    // 이름 → additive 매핑 (정규화된 이름으로)
    const additiveMap = new Map();
    for (const a of additiveRows) {
      const normalizedKo = (a.name_ko || '').replace(/\s+/g, '').toLowerCase();
      if (normalizedKo) additiveMap.set(normalizedKo, a);

      const normalizedEn = (a.name_en || '').replace(/\s+/g, '').toLowerCase();
      if (normalizedEn) additiveMap.set(normalizedEn, a);
    }
    console.log(`  첨가물 사전: ${additiveRows.length}건 로드`);

    // ── 파싱 대상 조회 ──
    const { rows: ingredients } = await client.query(`
      SELECT id, product_id, raw_text
      FROM product_ingredients
      WHERE parsed_ingredients IS NULL
      ORDER BY id
    `);

    console.log(`  파싱 대상: ${ingredients.length.toLocaleString()}건`);

    let parsed = 0, additivesFound = 0, errors = 0;
    const total = ingredients.length;

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = ingredients.slice(i, i + BATCH_SIZE);
      const batchClient = await pool.connect();

      try {
        await batchClient.query('BEGIN');

        for (const ing of batch) {
          const parsedResult = parseIngredientText(ing.raw_text);

          // parsed_ingredients JSONB 업데이트
          await batchClient.query(`
            UPDATE product_ingredients
            SET parsed_ingredients = $2, updated_at = NOW()
            WHERE id = $1
          `, [ing.id, JSON.stringify(parsedResult)]);

          // 모든 성분명 추출 후 첨가물 매칭
          const allNames = extractAllIngredientNames(parsedResult);

          for (const name of allNames) {
            const normalized = name.replace(/\s+/g, '').toLowerCase();
            const additive = additiveMap.get(normalized);

            if (additive) {
              // product_additives에 등록 (중복 방지)
              await batchClient.query(`
                INSERT INTO product_additives (product_id, additive_id)
                VALUES ($1, $2)
                ON CONFLICT DO NOTHING
              `, [ing.product_id, additive.additive_id]);

              additivesFound++;
            }
          }

          await batchClient.query(`
            INSERT INTO merge_log (step, status, source_id, source_table, target_product_id, detail)
            VALUES ('step4_parse', 'matched', $1, 'product_ingredients', $2, $3)
          `, [
            ing.id, ing.product_id,
            JSON.stringify({
              ingredient_count: parsedResult.length,
              total_names: allNames.length,
            }),
          ]);

          parsed++;
        }

        await batchClient.query('COMMIT');
      } catch (err) {
        await batchClient.query('ROLLBACK');
        errors += batch.length;
        console.error(`\n  ❌ 배치 오류 (${i}~${i + batch.length}): ${err.message}`);
      } finally {
        batchClient.release();
      }

      progress(Math.min(i + BATCH_SIZE, total), total, '원재료 파싱');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n\n========================================');
    console.log('  Step 4 완료 요약');
    console.log('========================================');
    console.log(`  파싱 완료:     ${parsed.toLocaleString()}건`);
    console.log(`  첨가물 매칭:   ${additivesFound.toLocaleString()}건`);
    console.log(`  오류:          ${errors}건`);
    console.log(`  소요 시간:     ${elapsed}초`);

    // 첨가물 등록 통계
    const { rows: [{ count: paCount }] } = await client.query(
      `SELECT count(*) FROM product_additives`
    );
    console.log(`  product_additives 총: ${parseInt(paCount).toLocaleString()}건`);

    console.log('\n  다음: node scripts/merge/05-verify-quality.js');
    console.log('========================================');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
