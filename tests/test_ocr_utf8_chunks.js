/**
 * 세션79 — Vision 응답 UTF-8 조각 경계 깨짐 회귀 테스트.
 * 결함: ocrService.httpPost 가 `responseData += chunk` 로 Buffer 조각을 각각 문자열로 바꿔 이어 붙여,
 *       조각 경계에 걸린 한글(3바이트)이 U+FFFD 로 깨졌다(운영 제보 32건 중 21건 · 예: 영등포구 → ��등포구).
 * 검증: 로컬 서버가 응답을 1~2바이트 조각으로 쪼개 보내도 한글이 그대로 와야 한다.
 */
'use strict';
const http = require('http');
const assert = require('assert');
const { _httpPost } = require('../src/services/ocrService');

const TEXT = '원재료명:감미료(자일리톨), 껌베이스 · 우유 함유 · 제조판매원:롯데웰푸드㈜ 서울시 영등포구 양평로21길 25 · 밀 · 대두 · 땅콩';
const BODY = Buffer.from(JSON.stringify({ responses: [{ fullTextAnnotation: { text: TEXT } }] }), 'utf8');

function serve(chunkSize) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on('end', async () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        for (let i = 0; i < BODY.length; i += chunkSize) {
          res.write(BODY.subarray(i, i + chunkSize));
          await new Promise(r => setImmediate(r));   // 조각이 따로 도착하게
        }
        res.end();
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  let pass = 0, fail = 0;
  for (const size of [1, 2, 5, 7, 4096]) {
    const srv = await serve(size);
    const url = `http://127.0.0.1:${srv.address().port}/v1/images:annotate`;
    try {
      const out = await _httpPost(url, { ping: '한글' });
      const got = out.responses[0].fullTextAnnotation.text;
      assert.strictEqual(got.includes('�'), false, `조각 ${size}바이트: U+FFFD 발생`);
      assert.strictEqual(got, TEXT, `조각 ${size}바이트: 원문 불일치`);
      pass++; console.log(`  ✓ 조각 ${size}바이트`);
    } catch (e) {
      fail++; console.log(`  ✗ 조각 ${size}바이트 — ${e.message}`);
    } finally { srv.close(); }
  }
  console.log(`test_ocr_utf8_chunks: ${pass}/${pass + fail}`);
  process.exit(fail ? 1 : 0);
})();
