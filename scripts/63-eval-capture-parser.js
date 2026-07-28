/**
 * 63-eval-capture-parser.js — 캡처 라벨 파서 회귀 평가 (원칙4 Eval-First)
 * =======================================================================
 * 평가셋: backends/먹선/eval_set/capture_label_eval_v1.jsonl
 * 파서  : scripts/lib/capture_label_parser.js
 *
 * 파서를 고칠 때마다 이걸 먼저 돌린다. **통과율이 떨어지면 그 수정은 되돌린다.**
 * "느낌으로 더 좋다" 금지.
 *
 * 실행 (DB·API 안 씀, 어디서나):
 *   node scripts/63-eval-capture-parser.js
 *   node scripts/63-eval-capture-parser.js --verbose
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseLabel } = require('./lib/capture_label_parser');

const VERBOSE = process.argv.includes('--verbose');
const EVAL_PATH = path.join(__dirname, '..', '..', 'eval_set', 'capture_label_eval_v1.jsonl');

if (!fs.existsSync(EVAL_PATH)) {
  console.error(`[중단] 평가셋 없음: ${EVAL_PATH}`);
  process.exit(1);
}

const cases = fs.readFileSync(EVAL_PATH, 'utf8')
  .split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));

console.log('=== 캡처 라벨 파서 평가 ===');
console.log(`평가셋 ${cases.length}건 · ${new Date().toISOString()}\n`);

let pass = 0, fail = 0;
const failures = [];

for (const c of cases) {
  const r = parseLabel(c.text);
  const t = c.truth;
  const marks = [];

  const cmp = (key, got, exp) => {
    const ok = (got === exp) || (got == null && exp == null);
    marks.push(`${ok ? '✓' : '✗'}${key}${ok ? '' : `(${got}≠${exp})`}`);
    if (ok) pass++; else { fail++; failures.push(`${c.id} ${key}: ${got} ≠ ${exp}`); }
  };

  cmp('basis', r.basis, t.basis);
  cmp('basis_amount', r.basis_amount, t.basis_amount);
  cmp('total', r.total_content, t.total_content);
  cmp('제품명', r.product_name, t.product_name);
  cmp('식품유형', r.food_type, t.food_type);
  cmp('보고번호수', r.report_nos.length, t.n_report);
  for (const [k, v] of Object.entries(t.nutrition)) cmp(k, r.nutrition[k], v);

  const bad = marks.filter((m) => m.startsWith('✗')).length;
  console.log(`${bad ? '✗' : '✓'} ${c.id}  [${c.basis_type}]  ${bad ? bad + '건 불일치' : '전항목 일치'}`);
  if (bad || VERBOSE) console.log('   ' + marks.join(' '));
  if (VERBOSE) {
    console.log('   원재료:', (r.ingredients || '(없음)').slice(0, 70));
    console.log('   경고  :', r.warnings.map((w) => w.split(':')[0]).join(', ') || '없음');
  }
  console.log(`   메모  : ${c.note}`);
}

const total = pass + fail;
console.log('\n' + '='.repeat(56));
console.log(`통과 ${pass} / ${total}  (${(pass / total * 100).toFixed(1)}%)`);
if (failures.length) {
  console.log('\n불일치 상세:');
  for (const f of failures) console.log('  ·', f);
  process.exit(1);
}
console.log('전항목 통과 — 파서 수정 후 이 값이 유지되는지 반드시 확인할 것.');
