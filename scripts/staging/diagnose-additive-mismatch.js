/**
 * 첨가물 미확인 진단 스크립트
 *
 * 신라면/무파마(비타민B2), 에이스(비타민B1염산염), 핫식스(비타민C) 4건에 대해
 * 실제 raw_text의 문자 코드를 분석하여 매칭 실패 원인을 파악합니다.
 *
 * 사용법: node scripts/staging/diagnose-additive-mismatch.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'meokseon',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

// 진단 대상 (바코드 → 키워드)
const TARGETS = [
  { barcode: '8801043032704', name: '신라면', keyword: '비타민B2' },
  { barcode: '8801043052238', name: '무파마탕면', keyword: '비타민B2' },
  { barcode: '8801019200007', name: '해태 에이스', keyword: '비타민B1염산염' },
  { barcode: '8801056059309', name: '핫식스라이트', keyword: '비타민C' },
];

// blind-test-popular.js와 동일한 normalize 함수
const normalize = (s) => s
  .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/\s+/g, '')
  .toLowerCase();

function charCodes(str) {
  return [...str].map(c => `${c}(U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')})`).join(' ');
}

async function main() {
  const client = await pool.connect();

  try {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  첨가물 미확인 진단');
    console.log('═══════════════════════════════════════════════════════════\n');

    for (const target of TARGETS) {
      console.log(`\n── ${target.name} (${target.barcode}) ──`);
      console.log(`  검색 키워드: ${target.keyword}`);

      // 1. 제품 찾기
      const { rows: products } = await client.query(
        `SELECT product_id, name FROM products WHERE barcode = $1`, [target.barcode]
      );
      if (products.length === 0) {
        console.log('  ❌ 제품 미발견');
        continue;
      }
      const pid = products[0].product_id;

      // 2. raw_text 가져오기
      const { rows: ingredients } = await client.query(
        `SELECT raw_text FROM product_ingredients WHERE product_id = $1`, [pid]
      );
      if (ingredients.length === 0 || !ingredients[0].raw_text) {
        console.log('  ❌ raw_text 없음');
        continue;
      }
      const rawText = ingredients[0].raw_text;

      // 3. 키워드 주변 문자 분석
      const keywordLower = target.keyword.toLowerCase();
      const keywordBase = target.keyword.replace(/[0-9]/g, ''); // 숫자 제거한 기본 이름

      // raw_text에서 키워드 관련 부분 찾기
      const rawLower = rawText.toLowerCase();
      const searchTerms = [
        target.keyword,
        keywordLower,
        keywordBase.toLowerCase(),
        '비타민',
      ];

      console.log(`\n  [raw_text에서 "비타민" 포함 구간 검색]`);

      // 비타민이 포함된 모든 위치 찾기
      let idx = 0;
      let found = false;
      while (true) {
        const pos = rawLower.indexOf('비타민', idx);
        if (pos === -1) break;
        found = true;

        // 앞뒤 20자 추출
        const start = Math.max(0, pos - 5);
        const end = Math.min(rawText.length, pos + 30);
        const snippet = rawText.substring(start, end);

        console.log(`\n  위치 ${pos}: "${snippet}"`);
        console.log(`  문자 코드: ${charCodes(snippet)}`);

        // normalize 적용 후
        const snippetNorm = normalize(snippet);
        console.log(`  정규화 후: "${snippetNorm}"`);

        idx = pos + 1;
      }

      if (!found) {
        console.log('  ❌ raw_text에 "비타민" 문자열 없음');

        // 전각 비타민 검색
        const fullwidthSearch = rawText.indexOf('비타민');
        console.log(`  전각 "비타민" 검색: ${fullwidthSearch >= 0 ? '발견' : '없음'}`);
      }

      // 4. 연결된 첨가물 확인
      const { rows: additives } = await client.query(
        `SELECT a.additive_id, a.name_ko, a.name_en, a.category
         FROM product_additives pa
         JOIN additives a ON pa.additive_id = a.additive_id
         WHERE pa.product_id = $1
         ORDER BY a.name_ko`, [pid]
      );

      console.log(`\n  [연결된 첨가물: ${additives.length}건]`);
      for (const add of additives) {
        const nameKoNorm = normalize(add.name_ko || '');
        const rawTextNorm = normalize(rawText);
        const matchResult = rawTextNorm.includes(nameKoNorm);
        console.log(`  ${matchResult ? '✅' : '❌'} ${add.name_ko} (${add.name_en || '-'}) [${add.category}]`);
        if (!matchResult) {
          console.log(`      DB 이름 정규화: "${nameKoNorm}"`);
          console.log(`      DB 이름 문자코드: ${charCodes(add.name_ko || '')}`);
          // raw_text에서 유사한 부분 찾기
          const nameChars = nameKoNorm.substring(0, 3);
          const findPos = rawTextNorm.indexOf(nameChars);
          if (findPos >= 0) {
            const ctx = rawTextNorm.substring(findPos, findPos + nameKoNorm.length + 10);
            console.log(`      rawText에서 "${nameChars}" 발견 위치 ${findPos}: "${ctx}"`);
          }
        }
      }

      // 5. 전체 normalize 비교
      console.log(`\n  [전체 정규화 매칭 테스트]`);
      const rawTextNorm = normalize(rawText);
      const keyNorm = normalize(target.keyword);
      const includes = rawTextNorm.includes(keyNorm);
      console.log(`  normalize("${target.keyword}") = "${keyNorm}"`);
      console.log(`  rawTextNorm.includes("${keyNorm}") = ${includes}`);

      if (!includes) {
        // 부분 매칭 시도
        for (let len = keyNorm.length - 1; len >= 2; len--) {
          const partial = keyNorm.substring(0, len);
          if (rawTextNorm.includes(partial)) {
            const pos = rawTextNorm.indexOf(partial);
            const ctx = rawTextNorm.substring(pos, pos + keyNorm.length + 5);
            console.log(`  부분매칭 "${partial}" 발견! 위치 ${pos}: "${ctx}"`);
            console.log(`  → 매칭 실패 지점: "${keyNorm.substring(len)}" 부분`);
            // 실패 지점 문자 코드 비교
            if (pos + len < rawTextNorm.length) {
              const expected = keyNorm.charAt(len);
              const actual = rawTextNorm.charAt(pos + len);
              console.log(`  → 기대: "${expected}" (U+${expected.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')})`);
              console.log(`  → 실제: "${actual}" (U+${actual.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')})`);
            }
            break;
          }
        }
      }
    }

    console.log('\n\n═══════════════════════════════════════════════════════════');
    console.log('  진단 완료');
    console.log('═══════════════════════════════════════════════════════════');

  } catch (err) {
    console.error('❌ 오류:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
