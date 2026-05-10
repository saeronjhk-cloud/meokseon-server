/**
 * mergeService 핵심 알고리즘 단위 테스트
 * Node assert 기반 (의존성 없음). 실행: node tests/mergeService.test.js
 */

const assert = require('assert');
const {
  median,
  majorityText,
  majorityIngredients,
  unionAllergens,
  detectOutliers,
  mergeContributions,
} = require('../src/services/mergeService');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
    failed++;
  }
}

function suite(name, fn) {
  console.log(`\n[${name}]`);
  fn();
}

// ──────────────────────────────────────────────────────────────────
suite('median', () => {
  test('홀수 개', () => assert.strictEqual(median([1, 5, 3]), 3));
  test('짝수 개 — 중앙 두 값 평균', () => assert.strictEqual(median([1, 2, 3, 4]), 2.5));
  test('null/undefined 무시', () => assert.strictEqual(median([null, 5, undefined, 3, 1]), 3));
  test('빈 배열', () => assert.strictEqual(median([]), null));
  test('이상치에 강함 — 100, 110, 105, 9999 → 107.5', () =>
    assert.strictEqual(median([100, 110, 105, 9999]), 107.5));
});

// ──────────────────────────────────────────────────────────────────
suite('majorityText', () => {
  test('단순 다수결', () => {
    assert.strictEqual(
      majorityText(['신라면', '신라면', '신라면컵']),
      '신라면',
    );
  });
  test('동률시 가장 긴 것', () => {
    assert.strictEqual(
      majorityText(['초코파이', '초코파이정', '오리온']),
      '초코파이정',
    );
  });
  test('공백 정규화', () => {
    assert.strictEqual(
      majorityText(['신  라면', '신 라면', '신라면']),
      '신 라면',  // 공백 정규화로 "신 라면" 2건 vs "신라면" 1건
    );
  });
  test('빈/null 무시', () => {
    assert.strictEqual(majorityText(['', null, undefined, '농심']), '농심');
  });
  test('전부 비어있음', () => {
    assert.strictEqual(majorityText(['', null, undefined]), null);
  });
});

// ──────────────────────────────────────────────────────────────────
suite('majorityIngredients', () => {
  test('3건 중 2건 이상 등장한 원재료만 채택', () => {
    const result = majorityIngredients([
      ['밀가루', '정제소금', '쇼트닝'],
      ['밀가루', '정제소금', '비타민B2'],
      ['밀가루', '정제수'],
    ]);
    const names = result.map((r) => r.name);
    assert.ok(names.includes('밀가루'), '밀가루는 3건 모두 등장 → 채택');
    assert.ok(names.includes('정제소금'), '정제소금은 2건 등장 → 채택');
    assert.ok(!names.includes('쇼트닝'), '쇼트닝은 1건만 → 제외');
    assert.ok(!names.includes('비타민B2'), '비타민B2는 1건만 → 제외');
  });
  test('1~2건이면 union (보수적)', () => {
    const result = majorityIngredients([
      ['밀가루', '정제소금'],
      ['밀가루', '쇼트닝'],
    ]);
    const names = result.map((r) => r.name);
    assert.ok(names.includes('밀가루') && names.includes('정제소금') && names.includes('쇼트닝'));
  });
  test('source_count 정확', () => {
    const result = majorityIngredients([
      ['밀가루'],
      ['밀가루'],
      ['밀가루'],
    ]);
    assert.strictEqual(result[0].source_count, 3);
  });
  test('표기 차이 — 가장 흔한 원본 표기 보존', () => {
    const result = majorityIngredients([
      ['밀가루'],
      ['밀가루'],
      ['MILGARU'],     // 다른 표기
    ]);
    // normalize 는 toLowerCase 만, 한글은 유지. 한국어/영어 다른 글자라 별개로 카운트됨
    const names = result.map((r) => r.name);
    assert.ok(names.includes('밀가루'));
  });
});

// ──────────────────────────────────────────────────────────────────
suite('unionAllergens', () => {
  test('한 명이라도 등록하면 채택 (안전 우선)', () => {
    const result = unionAllergens([
      ['우유', '밀'],
      ['우유'],
      ['쇠고기'],
    ]);
    const names = result.map((r) => r.name).sort();
    assert.deepStrictEqual(names, ['밀', '쇠고기', '우유']);
  });
  test('source_count 정확', () => {
    const result = unionAllergens([
      ['우유', '밀'],
      ['우유'],
      ['우유'],
    ]);
    const milk = result.find((r) => r.name === '우유');
    const wheat = result.find((r) => r.name === '밀');
    assert.strictEqual(milk.source_count, 3);
    assert.strictEqual(wheat.source_count, 1);
  });
});

// ──────────────────────────────────────────────────────────────────
suite('detectOutliers', () => {
  test('±50% 이상 이탈 감지', () => {
    const outliers = detectOutliers({
      sodium: [400, 420, 410, 1000],   // 1000은 median(415) 대비 141% 이탈
    });
    assert.strictEqual(outliers.length, 1);
    assert.strictEqual(outliers[0].nutrient, 'sodium');
    assert.strictEqual(outliers[0].value, 1000);
  });
  test('정상 분포 — 이상치 없음', () => {
    const outliers = detectOutliers({
      sodium: [400, 420, 410, 415],
    });
    assert.strictEqual(outliers.length, 0);
  });
  test('null 값 무시', () => {
    const outliers = detectOutliers({
      sodium: [400, null, 420, 410],
    });
    assert.strictEqual(outliers.length, 0);
  });
});

// ──────────────────────────────────────────────────────────────────
suite('mergeContributions — 통합 시나리오', () => {
  // 시뮬레이션: 같은 신라면을 3명이 등록, 약간씩 다름
  const fixtures = [
    {
      contribution_id: 1,
      data: {
        device_id: 'devA',
        avg_confidence: 0.92,
        parsed_nutrition: {
          calories: 500, sodium: 1860, total_sugars: 5, total_fat: 17,
          saturated_fat: 8, protein: 11, serving_size: 120, total_content: 120,
        },
        parsed_ingredients: [
          { name: '밀가루' }, { name: '정제소금' }, { name: '비타민B2' }, { name: '쇼트닝' },
        ],
        allergens: ['밀', '대두', '쇠고기'],
        user_input: {
          product_name: '신라면',
          brand: '농심',
          food_type: '유탕면',
          serving_size: 120,
          total_content: 120,
        },
      },
    },
    {
      contribution_id: 2,
      data: {
        device_id: 'devB',
        avg_confidence: 0.88,
        parsed_nutrition: {
          calories: 510, sodium: 1900, total_sugars: 5.5, total_fat: 17.5,
          saturated_fat: 8, protein: 11, serving_size: 120, total_content: 120,
        },
        parsed_ingredients: [
          { name: '밀가루' }, { name: '정제소금' }, { name: '비타민B2' }, { name: '팜유' },
        ],
        allergens: ['밀', '대두'],
        user_input: {
          product_name: '신라면',
          brand: '농심',
          food_type: '면류',  // 약간 다름
          serving_size: 120,
          total_content: 120,
        },
      },
    },
    {
      contribution_id: 3,
      data: {
        device_id: 'devC',
        avg_confidence: 0.85,
        parsed_nutrition: {
          calories: 495, sodium: 1840, total_sugars: 5, total_fat: 17,
          saturated_fat: 7, protein: 11, serving_size: 120, total_content: 120,
        },
        parsed_ingredients: [
          { name: '밀가루' }, { name: '정제소금' }, { name: '비타민B2' },
        ],
        allergens: ['밀', '대두', '쇠고기'],
        user_input: {
          product_name: '신라면',
          brand: '농심',
          food_type: '유탕면',
          serving_size: 120,
          total_content: 120,
        },
      },
    },
  ];

  test('3건 모두 다른 device → distinctDeviceCount = 3', () => {
    const r = mergeContributions(fixtures);
    assert.strictEqual(r.distinctDeviceCount, 3);
    assert.strictEqual(r.sourceCount, 3);
  });

  test('영양: median 적용 (sodium=1840·1860·1900 → 1860)', () => {
    const r = mergeContributions(fixtures);
    assert.strictEqual(r.nutrition.sodium, 1860);
    assert.strictEqual(r.nutrition.calories, 500);
  });

  test('메타: 다수결 (food_type: 유탕면 2 vs 면류 1 → 유탕면)', () => {
    const r = mergeContributions(fixtures);
    assert.strictEqual(r.meta.product_name, '신라면');
    assert.strictEqual(r.meta.brand, '농심');
    assert.strictEqual(r.meta.food_type, '유탕면');
  });

  test('원재료: 2건 이상 등장만 채택 (밀가루·정제소금·비타민B2 채택, 쇼트닝·팜유 제외)', () => {
    const r = mergeContributions(fixtures);
    const names = r.ingredients.map((i) => i.name);
    assert.ok(names.includes('밀가루'));
    assert.ok(names.includes('정제소금'));
    assert.ok(names.includes('비타민B2'));
    assert.ok(!names.includes('쇼트닝'), '쇼트닝은 1건만 → 제외');
    assert.ok(!names.includes('팜유'), '팜유는 1건만 → 제외');
  });

  test('알레르기: union (밀·대두·쇠고기 모두 채택)', () => {
    const r = mergeContributions(fixtures);
    const names = r.allergens.map((a) => a.name).sort();
    assert.deepStrictEqual(names, ['대두', '밀', '쇠고기']);
    const milk = r.allergens.find((a) => a.name === '밀');
    const beef = r.allergens.find((a) => a.name === '쇠고기');
    assert.strictEqual(milk.source_count, 3);
    assert.strictEqual(beef.source_count, 2);
  });

  test('이상치 없음 — 정상 분포', () => {
    const r = mergeContributions(fixtures);
    assert.strictEqual(r.hasSignificantOutliers, false);
  });

  test('이상치 시나리오 — 1명이 잘못 입력', () => {
    const withOutlier = [
      ...fixtures,
      {
        contribution_id: 4,
        data: {
          device_id: 'devD',
          avg_confidence: 0.95,
          parsed_nutrition: {
            calories: 5000,  // ← 잘못된 입력 (10배 큼)
            sodium: 1850,
            serving_size: 120,
          },
          parsed_ingredients: [{ name: '밀가루' }],
          allergens: ['밀'],
          user_input: { product_name: '신라면', brand: '농심', serving_size: 120 },
        },
      },
    ];
    const r = mergeContributions(withOutlier);
    assert.strictEqual(r.hasSignificantOutliers, true);
    const calOutlier = r.outliers.find((o) => o.nutrient === 'calories' && o.value === 5000);
    assert.ok(calOutlier, '5000 칼로리는 이상치로 잡혀야 함');
    // median 은 여전히 정상값 사용
    assert.ok(r.nutrition.calories < 1000, `merged calories=${r.nutrition.calories}, 정상 범위여야`);
  });
});

// ──────────────────────────────────────────────────────────────────
console.log(`\n결과: ${passed} 통과, ${failed} 실패`);
process.exit(failed === 0 ? 0 : 1);
