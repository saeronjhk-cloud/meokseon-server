/**
 * 먹선 REST API 테스트
 * DB 없이 동작하는 엔드포인트 중심 테스트
 */

const http = require('http');
const app = require('../src/app');

let server;
let baseUrl;
let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ ${testName}`);
    passed++;
  } else {
    console.log(`  ❌ ${testName}`);
    failed++;
  }
}

/**
 * HTTP 요청 헬퍼
 */
function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  console.log('══════════════════════════════════════════════════════');
  console.log('  먹선 REST API 테스트');
  console.log('══════════════════════════════════════════════════════\n');

  // ── 테스트 1: 루트 경로 ──
  console.log('📡 테스트 1: GET /');
  const r1 = await request('GET', '/');
  assert(r1.status === 200, 'HTTP 200');
  assert(r1.body.service === '먹선(吃選) API', '서비스명 확인');
  assert(r1.body.docs === '/api-docs', 'API 문서 경로');

  // ── 테스트 2: 404 핸들링 ──
  console.log('\n📡 테스트 2: GET /api/nonexistent (404)');
  const r2 = await request('GET', '/api/nonexistent');
  assert(r2.status === 404, 'HTTP 404');
  assert(r2.body.success === false, 'success: false');
  assert(r2.body.error.code === 'ENDPOINT_NOT_FOUND', '에러 코드 정확');

  // ── 테스트 3: 검색 검증 실패 ──
  console.log('\n📡 테스트 3: GET /api/products/search (검색어 누락)');
  const r3 = await request('GET', '/api/products/search');
  assert(r3.status === 400, 'HTTP 400');
  assert(r3.body.success === false, '검증 실패 응답');

  // ── 테스트 4: 바코드 형식 검증 ──
  console.log('\n📡 테스트 4: GET /api/products/abc (잘못된 바코드)');
  const r4 = await request('GET', '/api/products/abc');
  assert(r4.status === 400, 'HTTP 400 (비숫자 바코드)');

  // ── 테스트 5: POST /api/products/evaluate — 새우깡 ──
  console.log('\n📡 테스트 5: POST /api/products/evaluate (새우깡)');
  const r5 = await request('POST', '/api/products/evaluate', {
    product: {
      product_name: '새우깡',
      food_type: '과자',
      content_unit: 'g',
      serving_size: 30,
      total_content: 90,
    },
    nutrition: {
      calories: 140, sodium: 200, sugars: 2,
      sat_fat: 1.5, total_fat: 7, cholesterol: 5,
      protein: 2, fiber: 0.5, trans_fat: 0,
    },
  });
  assert(r5.status === 200, 'HTTP 200');
  assert(r5.body.success === true, 'success: true');
  assert(r5.body.data.evaluation.food_category === 'general', '카테고리 general');
  assert(r5.body.data.evaluation.nutrients.sodium.color === 'red', '나트륨 이중기준 빨강');
  assert(r5.body.data.evaluation.multi_serving.servings_per_container === 3, '3회분 감지');
  assert(r5.body.data.sanity_warnings.length === 0, 'Sanity Check 통과');

  // ── 테스트 6: POST /api/products/evaluate — 소주 (제외) ──
  console.log('\n📡 테스트 6: POST /api/products/evaluate (소주 → 평가 제외)');
  const r6 = await request('POST', '/api/products/evaluate', {
    product: {
      product_name: '참이슬',
      food_type: '소주',
      content_unit: 'ml',
      serving_size: 45,
      total_content: 360,
    },
    nutrition: { calories: 64, sodium: 0, sugars: 0 },
  });
  assert(r6.status === 200, 'HTTP 200');
  assert(r6.body.data.evaluation.is_excluded === true, '주류 평가 제외');
  assert(r6.body.data.evaluation.exclude_reason === 'alcohol', '제외 사유: alcohol');

  // ── 테스트 7: POST /api/products/evaluate — 음료 (콜라 제로) ──
  console.log('\n📡 테스트 7: POST /api/products/evaluate (콜라 제로 → 음료)');
  const r7 = await request('POST', '/api/products/evaluate', {
    product: {
      product_name: '코카콜라 제로',
      food_type: '탄산음료',
      content_unit: 'ml',
      serving_size: 250,
      total_content: 500,
    },
    nutrition: {
      calories: 0, sodium: 25, sugars: 0,
      sat_fat: 0, total_fat: 0, cholesterol: 0,
      protein: 0, fiber: 0, trans_fat: 0,
    },
  });
  assert(r7.status === 200, 'HTTP 200');
  assert(r7.body.data.evaluation.food_category === 'beverage', '음료 카테고리');
  assert(r7.body.data.evaluation.nutrients.sodium.color === 'green', '나트륨 초록');

  // ── 테스트 8: POST /api/products/evaluate — 입력 오류 ──
  console.log('\n📡 테스트 8: POST /api/products/evaluate (입력 누락)');
  const r8 = await request('POST', '/api/products/evaluate', {
    product: { product_name: '테스트' },
  });
  assert(r8.status === 400, 'HTTP 400 (nutrition 누락)');
  assert(r8.body.success === false, '실패 응답');

  // ── 테스트 9: POST /api/products/evaluate — OCR 이상치 감지 ──
  console.log('\n📡 테스트 9: POST /api/products/evaluate (OCR 이상치)');
  const r9 = await request('POST', '/api/products/evaluate', {
    product: {
      product_name: '테스트 제품',
      food_type: '과자',
      content_unit: 'g',
      serving_size: 30,
      total_content: 30,
    },
    nutrition: {
      calories: 50000, sodium: 100, sugars: 5,
      sat_fat: 1, total_fat: 3, cholesterol: 0,
      protein: 2, fiber: 1, trans_fat: 0,
    },
  });
  assert(r9.status === 200, 'HTTP 200');
  assert(r9.body.data.sanity_warnings.length > 0, 'OCR 이상치 경고 감지');
  assert(r9.body.data.sanity_warnings.some(w => w.nutrient === 'calories'), '열량 이상치 경고');

  // ── 테스트 10: POST /api/products/evaluate — 건조식품 예외 ──
  console.log('\n📡 테스트 10: POST /api/products/evaluate (육포 → 건조식품)');
  const r10 = await request('POST', '/api/products/evaluate', {
    product: {
      product_name: '쇠고기 육포',
      food_type: '육포',
      content_unit: 'g',
      serving_size: 25,
      total_content: 50,
    },
    nutrition: {
      calories: 80, sodium: 350, sugars: 5,
      sat_fat: 0.5, total_fat: 1.5, cholesterol: 20,
      protein: 15, fiber: 0, trans_fat: 0,
    },
  });
  assert(r10.status === 200, 'HTTP 200');
  assert(r10.body.data.evaluation.food_category === 'dried', '건조식품 분류');
  assert(r10.body.data.evaluation.is_dried_exception === true, '건조식품 예외 적용');
  assert(r10.body.data.evaluation.nutrients.sodium.basis === 'pct_dv', '나트륨 %DV만 적용');

  // ── 결과 요약 ──
  console.log(`\n${'═'.repeat(54)}`);
  console.log(`📊 API 테스트 결과: ${passed} 통과 / ${failed} 실패 (총 ${passed + failed}개)`);
  console.log(`${'═'.repeat(54)}`);

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('\n✅ REST API 테스트 전체 통과!');
  }
}

// ── 서버 시작 → 테스트 → 서버 종료 ──
server = http.createServer(app);
server.listen(0, async () => {
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`테스트 서버 시작: ${baseUrl}\n`);

  try {
    await runTests();
  } catch (err) {
    console.error('테스트 오류:', err);
    process.exit(1);
  } finally {
    server.close();
  }
});
