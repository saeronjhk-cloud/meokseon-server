/** test_web_label_fill.js — ★ 세션83 판매처 품목 영양 새로 채우기(117 planFill). 정답 tests/fixtures/web_label_fill_v1.json (= IP/eval_web_label_fill_v1 · F01~13 · FN01~05) */
'use strict';
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const FX = path.join(__dirname, 'fixtures'); const C = require(path.join(FX, 'web_label_fill_v1.json'));
const { planFill } = require('../scripts/117-web-label-nutrition-fill');
let pass = 0, fail = 0;
for (const c of C.cases) {
  try {
    const x = planFill(fs.readFileSync(path.join(FX, c.text), 'utf8'), c.name);
    if (c.expect.skip) assert.strictEqual(x.skip, c.expect.skip, 'skip');
    else {
      assert.ok(x.row, 'row 없음: ' + x.skip);
      assert.strictEqual(x.row.serving_size, c.expect.serving_size, 'serving_size');
      assert.ok(Math.abs(x.row.calories - c.expect.calories) <= 0.01, `calories ${x.row.calories} ≠ ${c.expect.calories}`);
      const major = ['sodium', 'total_carbs', 'total_sugars', 'total_fat', 'protein'].filter((k) => x.row[k] != null).length;
      assert.ok(major >= 3, 'F3 주요 영양소 ' + major);
    }
    pass++; console.log(`  ✅ ${c.id} ${c.why.slice(0, 50)}`);
  } catch (e) { fail++; console.log(`  ❌ ${c.id} → ${e.message}`); }
}
// F6 운영 대상 목록 = 양성 product_id (실행은 DB 가 필요해 여기서는 고정 목록만 검사)
assert.strictEqual(C.cases.filter((c) => c.product_id).length, 13);
console.log(`\n[web label fill] ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
