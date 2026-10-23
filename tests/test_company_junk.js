/** test_company_junk.js — ★ 세션83 사진 제보 OCR 판매원·제조원 잔해. 정답 tests/fixtures/company_junk_v1.json (= IP/eval_company_junk_v1 · 제보 63 · 정답 변경 14 · 나머지 기준선 동결) */
'use strict';
const fs = require('fs'); const path = require('path');
const { extractProductMeta } = require('../src/services/ocrParser');
const { cases } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'company_junk_v1.json'), 'utf8'));
let pass = 0, fail = 0;
for (const c of cases) {
  const m = extractProductMeta(c.text); const got = { brand: m.brand ?? null, manufacturer: m.manufacturer ?? null };
  if (got.brand === c.expected.brand && got.manufacturer === c.expected.manufacturer) { pass++; continue; }
  fail++; console.log(`  ❌ ${c.id}${c.changed ? ' (정답 변경)' : ' (★ 기준선 회귀)'} 기대 ${JSON.stringify(c.expected)} 실제 ${JSON.stringify(got)}`);
}
console.log(`\n[company junk] ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
