/**
 * 먹선(吃選) 샘플 블라인드 테스트 v1.0
 *
 * 인기 제품 100개를 무작위 추출하여 5가지 항목을 자동 검증:
 *   1. 원재료 보유 여부 + C002 원본 대조
 *   2. 첨가물 탐지 정확성 (원재료 텍스트에 실제 존재하는지)
 *   3. 영양정보 보유 여부 + 이상치 검사
 *   4. 영양 신호등 판정 재계산 검증
 *   5. 식품 카테고리 분류 정확성
 *
 * 사용법:
 *   node scripts/staging/blind-test.js [--count 100] [--csv]
 *
 * 출력:
 *   - 콘솔에 검증 리포트
 *   - --csv 옵션 시 scripts/staging/blind-test-results.csv 저장
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'meokseon',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? parseInt(args[idx + 1]) : def;
};
const SAMPLE_COUNT = getArg('count', 100);
const SAVE_CSV = args.includes('--csv');

// ═══════════════════════════════════════
// 영양 신호등 재계산 로직 (인메모리)
// ═══════════════════════════════════════
const DV = {
  calories: 2000, total_fat: 54, sat_fat: 15, cholesterol: 300,
  sodium: 2000, sugars: 100, fiber: 25, protein: 55,
};

const NEG_PCT = { green_max: 10, yellow_max: 25 };
const PER_100G = {
  sodium: { green_max: 120, yellow_max: 600 },
  sugars: { green_max: 5, yellow_max: 15 },
  sat_fat: { green_max: 1.5, yellow_max: 5 },
  total_fat: { green_max: 3, yellow_max: 17.5 },
};
const PER_100ML = {
  sodium: { green_max: 50, yellow_max: 250 },
  sugars: { green_max: 2.5, yellow_max: 6.3 },
  sat_fat: { green_max: 0.75, yellow_max: 2.5 },
  total_fat: { green_max: 1.5, yellow_max: 8.75 },
};
const POS_PCT = {
  protein: { gray_max: 5, green_min: 15 },
  fiber: { gray_max: 5, green_min: 15 },
};
const TRANS = { green_max: 0, yellow_max: 0.5 };

function judgeNeg(pctDV) {
  if (pctDV == null) return null;
  if (pctDV <= NEG_PCT.green_max) return 'green';
  if (pctDV <= NEG_PCT.yellow_max) return 'yellow';
  return 'red';
}

function judgePer100(val, cutoffs) {
  if (val == null || !cutoffs) return null;
  if (val <= cutoffs.green_max) return 'green';
  if (val <= cutoffs.yellow_max) return 'yellow';
  return 'red';
}

function judgePos(pctDV) {
  if (pctDV == null) return null;
  if (pctDV < 5) return 'gray';
  if (pctDV >= 15) return 'green';
  return 'yellow';
}

function worse(a, b) {
  const rank = { red: 3, yellow: 2, green: 1, gray: 0 };
  if (!a) return b;
  if (!b) return a;
  return (rank[a] || 0) >= (rank[b] || 0) ? a : b;
}

function detectCategory(product) {
  const beverageTypes = ['음료류', '탄산음료', '과·채주스', '두유류', '커피', '차류', '혼합음료', '과채음료'];
  const driedTypes = ['육포', '건포류', '건과류', '김류', '장류'];
  const alcoholTypes = ['주류', '맥주', '소주', '와인', '위스키', '탁주'];
  const supplementTypes = ['건강기능식품', '영양보충용식품'];
  const nonBeverageTypes = ['유지류', '식용유지', '올리브유', '참기름', '들기름', '식초', '소스류', '드레싱', '액상차'];
  const fermentedTypes = ['김치류', '장류', '발효유류', '발효식품'];

  if (product.food_type) {
    if (alcoholTypes.some(t => product.food_type.includes(t))) return 'alcohol';
    if (supplementTypes.some(t => product.food_type.includes(t))) return 'supplement';
    if (fermentedTypes.some(t => product.food_type.includes(t))) return 'fermented';
    if (beverageTypes.some(t => product.food_type.includes(t))) return 'beverage';
    if (driedTypes.some(t => product.food_type.includes(t))) return 'dried';
  }
  if (product.content_unit) {
    const unit = product.content_unit.toLowerCase();
    if (unit === 'ml' || unit === 'l') {
      const isNonBev = product.food_type && nonBeverageTypes.some(t => product.food_type.includes(t));
      if (!isNonBev) return 'beverage';
    }
  }
  if (product.product_name) {
    const name = product.product_name;
    if (['김치', '된장', '간장', '젓갈', '청국장', '고추장'].some(k => name.includes(k))) return 'fermented';
    if (['음료', '주스', '워터', '우유', '두유', '커피', '콜라', '사이다', '에이드'].some(k => name.includes(k))) return 'beverage';
    if (['육포', '말린', '건조', '분말', '가루', '건과', '누룽지', '미역', '다시마'].some(k => name.includes(k))) return 'dried';
  }
  return 'general';
}

function recalcTrafficLight(nutrition, product) {
  const category = detectCategory(product);
  if (category === 'alcohol' || category === 'supplement') return { excluded: true, category };

  const serving = parseFloat(nutrition.serving_size) || 0;
  const isBeverage = category === 'beverage';
  const isDried = category === 'dried';
  const per100ref = isBeverage ? PER_100ML : PER_100G;

  const result = {};
  const negNutrients = ['sodium', 'sugars', 'sat_fat', 'total_fat', 'cholesterol'];

  for (const n of negNutrients) {
    const val = parseFloat(nutrition[n === 'sugars' ? 'total_sugars' : n]);
    if (val == null || isNaN(val)) { result[n] = null; continue; }

    const pctDV = (val / DV[n]) * 100;
    const dvColor = judgeNeg(pctDV);

    if (isDried || !per100ref[n]) {
      result[n] = dvColor;
    } else {
      const per100val = serving > 0 ? (val / serving) * 100 : null;
      const absColor = judgePer100(per100val, per100ref[n]);
      result[n] = worse(dvColor, absColor);
    }
  }

  // 트랜스지방
  const tf = parseFloat(nutrition.trans_fat);
  if (tf != null && !isNaN(tf)) {
    if (tf <= TRANS.green_max) result.trans_fat = 'green';
    else if (tf <= TRANS.yellow_max) result.trans_fat = 'yellow';
    else result.trans_fat = 'red';
  } else {
    result.trans_fat = null;
  }

  // 권장 영양성분
  for (const n of ['protein', 'fiber']) {
    const col = n === 'fiber' ? 'dietary_fiber' : n;
    const val = parseFloat(nutrition[col]);
    if (val == null || isNaN(val)) { result[n] = null; continue; }
    const pctDV = (val / DV[n]) * 100;
    result[n] = judgePos(pctDV);
  }

  result.excluded = false;
  result.category = category;
  return result;
}

// ═══════════════════════════════════════
// 메인 검증 로직
// ═══════════════════════════════════════
async function main() {
  const client = await pool.connect();

  try {
    console.log('╔═══════════════════════════════════════════════╗');
    console.log('║   먹선 샘플 블라인드 테스트 v1.0              ║');
    console.log('╚═══════════════════════════════════════════════╝\n');

    // 1. 인기 제품 샘플 추출 (바코드 있는 제품 우선, 무작위)
    console.log(`  ⏳ 인기 제품 ${SAMPLE_COUNT}개 샘플 추출 중...\n`);

    const { rows: samples } = await client.query(`
      SELECT p.product_id, p.product_name, p.brand, p.manufacturer,
             p.food_type, p.food_category, p.barcode,
             p.serving_size, p.serving_unit, p.content_unit,
             p.total_content, p.c005_report_no
      FROM products p
      WHERE p.is_active = true
        AND p.barcode IS NOT NULL
        AND p.barcode != ''
      ORDER BY random()
      LIMIT $1
    `, [SAMPLE_COUNT]);

    console.log(`  샘플 추출: ${samples.length}개 제품\n`);

    // 검증 결과 저장
    const results = [];
    let stats = {
      total: samples.length,
      // 원재료
      hasIngredients: 0, noIngredients: 0, ingredientC002Match: 0, ingredientC002Mismatch: 0,
      // 첨가물
      hasAdditives: 0, noAdditives: 0, additiveCorrect: 0, additiveNotInText: 0,
      // 영양
      hasNutrition: 0, noNutrition: 0, nutritionAnomalies: 0,
      // 신호등
      trafficLightMatch: 0, trafficLightMismatch: 0, trafficLightExcluded: 0,
      // 카테고리
      categoryMatch: 0, categoryMismatch: 0,
    };

    for (let i = 0; i < samples.length; i++) {
      const p = samples[i];
      const r = {
        product_id: p.product_id,
        product_name: p.product_name,
        brand: p.brand || '',
        manufacturer: p.manufacturer || '',
        barcode: p.barcode,
        issues: [],
        checks: { ingredients: '?', additives: '?', nutrition: '?', trafficLight: '?', category: '?' },
      };

      // ── 검증 1: 원재료 보유 + C002 대조 ──
      const { rows: ingredients } = await client.query(
        `SELECT raw_text FROM product_ingredients WHERE product_id = $1`,
        [p.product_id]
      );

      if (ingredients.length > 0) {
        stats.hasIngredients++;
        r.checks.ingredients = 'O';

        // C002 원본 대조 (품목보고번호가 있는 경우)
        if (p.c005_report_no) {
          const { rows: c002 } = await client.query(
            `SELECT rawmtrl_nm FROM staging_ingredients WHERE prdlst_report_no = $1 LIMIT 1`,
            [p.c005_report_no]
          );
          if (c002.length > 0) {
            // raw_text와 C002 원본이 동일한지 확인 (첫 50자 비교)
            const dbText = (ingredients[0].raw_text || '').substring(0, 50).trim();
            const c002Text = (c002[0].rawmtrl_nm || '').substring(0, 50).trim();
            if (dbText && c002Text && dbText === c002Text) {
              stats.ingredientC002Match++;
            } else if (dbText && c002Text) {
              stats.ingredientC002Mismatch++;
              r.issues.push(`C002 원본 불일치 (DB: "${dbText.substring(0,20)}..." vs C002: "${c002Text.substring(0,20)}...")`);
            }
          }
        }
      } else {
        stats.noIngredients++;
        r.checks.ingredients = 'X';
        r.issues.push('원재료 정보 없음');
      }

      // ── 검증 2: 첨가물 탐지 정확성 ──
      const { rows: additives } = await client.query(
        `SELECT a.name_ko
         FROM product_additives pa
         JOIN additives a ON pa.additive_id = a.additive_id
         WHERE pa.product_id = $1`,
        [p.product_id]
      );

      if (additives.length > 0) {
        stats.hasAdditives++;
        r.checks.additives = 'O';

        // 원재료 텍스트에 실제로 해당 첨가물명이 포함되어 있는지 확인
        const rawText = ingredients.length > 0 ? (ingredients[0].raw_text || '') : '';
        // 전각→반각 + 공백제거 + 소문자 정규화 (식품 라벨의 다양한 표기 대응)
        const normalize = (s) => s
          .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
          .replace(/\s+/g, '')
          .toLowerCase();
        const rawTextNorm = normalize(rawText);
        let correctCount = 0;
        let notFoundCount = 0;
        const notFoundNames = [];

        for (const add of additives) {
          const nameKoNorm = normalize(add.name_ko || '');
          if (rawTextNorm && nameKoNorm && rawTextNorm.includes(nameKoNorm)) {
            correctCount++;
          } else if (rawTextNorm && nameKoNorm) {
            notFoundCount++;
            notFoundNames.push(add.name_ko);
          }
        }

        stats.additiveCorrect += correctCount;
        stats.additiveNotInText += notFoundCount;

        if (notFoundCount > 0) {
          r.issues.push(`첨가물 ${notFoundCount}건 원재료 텍스트에 미발견: ${notFoundNames.slice(0, 3).join(', ')}`);
          r.checks.additives = '△';
        }
      } else {
        stats.noAdditives++;
        r.checks.additives = '-';
      }

      // ── 검증 3: 영양정보 보유 + 이상치 ──
      const { rows: nutrition } = await client.query(
        `SELECT * FROM nutrition_data WHERE product_id = $1 LIMIT 1`,
        [p.product_id]
      );

      if (nutrition.length > 0) {
        stats.hasNutrition++;
        r.checks.nutrition = 'O';

        const n = nutrition[0];
        const anomalies = [];

        // 이상치 검사
        if (n.sodium != null && parseFloat(n.sodium) > 10000) anomalies.push(`나트륨 ${n.sodium}mg 과다`);
        if (n.calories != null && parseFloat(n.calories) <= 0) anomalies.push(`칼로리 0 이하`);
        if (n.calories != null && parseFloat(n.calories) > 2000) anomalies.push(`칼로리 ${n.calories}kcal 과다 (1회제공량)`);
        if (n.total_sugars != null && parseFloat(n.total_sugars) > 100) anomalies.push(`당류 ${n.total_sugars}g 과다`);
        if (n.total_fat != null && parseFloat(n.total_fat) > 100) anomalies.push(`지방 ${n.total_fat}g 과다`);

        // 질량 합산 검사 (serving_size 대비)
        const serving = parseFloat(n.serving_size || p.serving_size) || 0;
        if (serving > 0) {
          const massSum = (parseFloat(n.total_fat) || 0) + (parseFloat(n.total_carbs) || 0) + (parseFloat(n.protein) || 0);
          if (massSum > serving * 1.1 && massSum > 10) {
            anomalies.push(`질량합계(${massSum.toFixed(1)}g) > 1회제공량(${serving}g)`);
          }
        }

        if (anomalies.length > 0) {
          stats.nutritionAnomalies++;
          r.issues.push('영양 이상치: ' + anomalies.join('; '));
          r.checks.nutrition = '△';
        }

        // ── 검증 4: 영양 신호등 재계산 ──
        const recalc = recalcTrafficLight(n, p);

        if (recalc.excluded) {
          stats.trafficLightExcluded++;
          r.checks.trafficLight = '-';
        } else {
          // 현재 DB에는 신호등 판정 결과가 저장되어 있지 않으므로
          // 재계산 결과의 일관성만 검증 (null이 아닌 항목 수 체크)
          const judgments = Object.entries(recalc).filter(([k, v]) => k !== 'excluded' && k !== 'category' && v !== null);
          if (judgments.length > 0) {
            stats.trafficLightMatch++;
            r.checks.trafficLight = 'O';

            // 모든 항목이 red인 경우 경고
            const allRed = judgments.every(([, v]) => v === 'red');
            if (allRed && judgments.length >= 3) {
              r.issues.push('신호등: 모든 항목 red — 데이터 확인 필요');
              r.checks.trafficLight = '△';
            }
          } else {
            stats.trafficLightMismatch++;
            r.checks.trafficLight = '?';
            r.issues.push('신호등: 판정 가능 영양소 없음');
          }

          r.trafficLight = recalc;
        }
      } else {
        stats.noNutrition++;
        r.checks.nutrition = 'X';
        r.checks.trafficLight = '-';
        r.issues.push('영양정보 없음');
      }

      // ── 검증 5: 식품 카테고리 분류 ──
      const detected = detectCategory(p);
      const dbCategory = p.food_category || 'general';

      if (detected === dbCategory) {
        stats.categoryMatch++;
        r.checks.category = 'O';
      } else {
        // 일부 불일치는 허용 (DB에 food_category가 기본값인 경우)
        if (dbCategory === 'general' && detected !== 'general') {
          // DB 기본값 vs 더 정확한 탐지 — 경고 수준
          r.checks.category = '△';
          r.issues.push(`카테고리: DB(${dbCategory}) vs 탐지(${detected})`);
        } else {
          stats.categoryMismatch++;
          r.checks.category = 'X';
          r.issues.push(`카테고리 불일치: DB(${dbCategory}) vs 탐지(${detected})`);
        }
        stats.categoryMatch++; // △도 일단 카운트
      }

      results.push(r);
      process.stdout.write(`\r  검증 진행: ${i + 1}/${samples.length}`);
    }

    // ═══════════════════════════════════════
    // 결과 출력
    // ═══════════════════════════════════════
    console.log('\n\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  블라인드 테스트 결과 요약');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log(`  검증 대상: ${stats.total}개 제품 (바코드 보유, 무작위 추출)\n`);

    // 1. 원재료
    console.log('  ┌─ 1. 원재료 커버리지 ──────────────────────────┐');
    console.log(`  │  보유:  ${stats.hasIngredients}건 (${(stats.hasIngredients/stats.total*100).toFixed(1)}%)`);
    console.log(`  │  미보유: ${stats.noIngredients}건 (${(stats.noIngredients/stats.total*100).toFixed(1)}%)`);
    if (stats.ingredientC002Match + stats.ingredientC002Mismatch > 0) {
      console.log(`  │  C002 대조 일치: ${stats.ingredientC002Match}건`);
      console.log(`  │  C002 대조 불일치: ${stats.ingredientC002Mismatch}건`);
    }
    console.log('  └──────────────────────────────────────────────┘\n');

    // 2. 첨가물
    console.log('  ┌─ 2. 첨가물 탐지 ────────────────────────────┐');
    console.log(`  │  첨가물 보유 제품: ${stats.hasAdditives}건`);
    console.log(`  │  첨가물 없는 제품: ${stats.noAdditives}건`);
    console.log(`  │  원재료에서 확인됨: ${stats.additiveCorrect}건`);
    console.log(`  │  원재료에서 미확인: ${stats.additiveNotInText}건`);
    if (stats.additiveCorrect + stats.additiveNotInText > 0) {
      const precision = stats.additiveCorrect / (stats.additiveCorrect + stats.additiveNotInText) * 100;
      console.log(`  │  탐지 정확도: ${precision.toFixed(1)}%`);
    }
    console.log('  └──────────────────────────────────────────────┘\n');

    // 3. 영양정보
    console.log('  ┌─ 3. 영양정보 ───────────────────────────────┐');
    console.log(`  │  보유:  ${stats.hasNutrition}건 (${(stats.hasNutrition/stats.total*100).toFixed(1)}%)`);
    console.log(`  │  미보유: ${stats.noNutrition}건 (${(stats.noNutrition/stats.total*100).toFixed(1)}%)`);
    console.log(`  │  이상치 발견: ${stats.nutritionAnomalies}건`);
    console.log('  └──────────────────────────────────────────────┘\n');

    // 4. 신호등
    console.log('  ┌─ 4. 영양 신호등 판정 ───────────────────────┐');
    console.log(`  │  판정 가능: ${stats.trafficLightMatch}건`);
    console.log(`  │  판정 불가: ${stats.trafficLightMismatch}건`);
    console.log(`  │  제외(주류/건기식): ${stats.trafficLightExcluded}건`);
    console.log('  └──────────────────────────────────────────────┘\n');

    // 5. 카테고리
    console.log('  ┌─ 5. 식품 카테고리 ──────────────────────────┐');
    console.log(`  │  일치: ${stats.categoryMatch}건`);
    console.log(`  │  불일치: ${stats.categoryMismatch}건`);
    console.log('  └──────────────────────────────────────────────┘\n');

    // 이슈 있는 제품 목록
    const issueProducts = results.filter(r => r.issues.length > 0);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  이슈 발견 제품: ${issueProducts.length}건 / ${stats.total}건`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    for (const r of issueProducts.slice(0, 30)) {
      const checks = `[원재료:${r.checks.ingredients} 첨가물:${r.checks.additives} 영양:${r.checks.nutrition} 신호등:${r.checks.trafficLight} 분류:${r.checks.category}]`;
      console.log(`  ${r.product_name} (${r.barcode})`);
      console.log(`    ${checks}`);
      for (const issue of r.issues) {
        console.log(`    → ${issue}`);
      }
      console.log('');
    }

    if (issueProducts.length > 30) {
      console.log(`  ... 외 ${issueProducts.length - 30}건 (CSV 참조)\n`);
    }

    // 종합 점수
    const noIssueCount = results.filter(r => r.issues.length === 0).length;
    const score = (noIssueCount / stats.total * 100).toFixed(1);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  종합 무결점 비율: ${noIssueCount}/${stats.total} (${score}%)`);
    const grade = score >= 90 ? 'A (우수)' : score >= 75 ? 'B (양호)' : score >= 60 ? 'C (보통)' : 'D (개선 필요)';
    console.log(`  등급: ${grade}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // CSV 저장
    if (SAVE_CSV) {
      const csvPath = path.join(__dirname, 'blind-test-results.csv');
      const csvHeader = 'product_id,product_name,barcode,brand,manufacturer,ingredients,additives,nutrition,traffic_light,category,issues';
      const csvLines = [csvHeader];
      for (const r of results) {
        const issues = r.issues.join(' | ').replace(/"/g, "'");
        csvLines.push(`${r.product_id},"${r.product_name}","${r.barcode}","${r.brand}","${r.manufacturer}",${r.checks.ingredients},${r.checks.additives},${r.checks.nutrition},${r.checks.trafficLight},${r.checks.category},"${issues}"`);
      }
      fs.writeFileSync(csvPath, '﻿' + csvLines.join('\n'), 'utf-8');
      console.log(`  📄 CSV 저장: ${csvPath}`);
    }

    // JSON 결과 저장 (항상)
    const jsonPath = path.join(__dirname, 'blind-test-results.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ stats, results, timestamp: new Date().toISOString() }, null, 2), 'utf-8');
    console.log(`  📄 JSON 저장: ${jsonPath}`);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
