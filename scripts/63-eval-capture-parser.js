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

/* ── 평가셋 위치 (세션51) ─────────────────────────────────────────────────────
 * 정본 : backends/먹선/eval_set/capture_label_eval_v1.jsonl   ← 저장소 «밖» (IP 분리 원칙)
 * 사본 : meokseon-server/eval_set/capture_label_eval_v1.jsonl ← 저장소 «안»
 *
 * 왜 사본이 필요한가: 이 스크립트는 CI(`.github/workflows/gate.yml` 의 마지막 스텝)에서도
 * 돈다. CI 체크아웃에는 저장소 밖 경로가 존재하지 않아 **정본만 보면 반드시 실패한다.**
 * 세션51에 GitHub Actions gate #2 가 실제로 이것 하나 때문에 빨간불이었다
 * (다른 스위트는 전부 초록이었다. 재현: 커밋된 blob 만 풀어 낸 트리에서 전건 통과).
 *
 * ⚠ 사본은 갈라질 수 있다. 그래서 **둘 다 있으면 내용이 같은지 대조하고 다르면 멈춘다.**
 *   `src/services/allergenName.js` ↔ `IP/allergens_19_korea.json` 이 쓰는 것과 같은 방식이다.
 *   사본을 갱신할 때는 정본을 그대로 복사할 것. 손으로 고치지 말 것.
 */
const EVAL_CANONICAL = path.join(__dirname, '..', '..', 'eval_set', 'capture_label_eval_v1.jsonl');
const EVAL_INREPO = path.join(__dirname, '..', 'eval_set', 'capture_label_eval_v1.jsonl');

const hasCanon = fs.existsSync(EVAL_CANONICAL);
const hasRepo = fs.existsSync(EVAL_INREPO);

if (!hasCanon && !hasRepo) {
  console.error('[중단] 평가셋 없음. 다음 두 곳 어디에도 없다:');
  console.error(`   정본: ${EVAL_CANONICAL}`);
  console.error(`   사본: ${EVAL_INREPO}`);
  process.exit(1);
}

if (hasCanon && hasRepo) {
  const a = fs.readFileSync(EVAL_CANONICAL, 'utf8').replace(/\r\n/g, '\n').trimEnd();
  const b = fs.readFileSync(EVAL_INREPO, 'utf8').replace(/\r\n/g, '\n').trimEnd();
  if (a !== b) {
    console.error('[중단] 평가셋 정본과 저장소 사본이 다르다 — CI 가 낡은 기준으로 초록을 낼 수 있다.');
    console.error(`   정본: ${EVAL_CANONICAL}`);
    console.error(`   사본: ${EVAL_INREPO}`);
    console.error('   → 정본을 사본 위치로 그대로 복사한 뒤 커밋할 것.');
    process.exit(1);
  }
}

const EVAL_PATH = hasCanon ? EVAL_CANONICAL : EVAL_INREPO;
console.log(`평가셋 출처: ${hasCanon ? '정본(저장소 밖)' : '저장소 사본(CI 경로)'}`);

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
