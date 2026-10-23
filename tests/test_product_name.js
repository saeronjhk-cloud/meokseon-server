/** test_product_name.js — ★ 세션83 사진 제보 OCR 제품명. 정답 tests/fixtures/product_name_v1.json (= IP/eval_product_name_v1 · 운영 제보 63 · 정답 변경 8 · 나머지 기준선 동결) */
'use strict';
const fs = require('fs'); const path = require('path');
const { extractProductMeta } = require('../src/services/ocrParser');
const { cases } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'product_name_v1.json'), 'utf8'));
let pass = 0, fail = 0;
for (const c of cases) {
  const got = extractProductMeta(c.text).product_name ?? null;
  if (got === c.expected) { pass++; continue; }
  fail++; console.log(`  ❌ ${c.id}${c.changed ? ' (정답 변경)' : ' (★ 기준선 회귀)'} 기대 ${JSON.stringify(c.expected)} 실제 ${JSON.stringify(got)}`);
}
console.log(`\n[product name] ${pass}/${pass + fail} · 정답 변경 ${cases.filter((c) => c.changed).length}`); process.exit(fail ? 1 : 0);
