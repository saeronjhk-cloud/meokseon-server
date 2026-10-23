/** test_error_no_stack.js — ★ 세션83 오류 응답에 스택을 싣지 않는다(운영 NODE_ENV=development 실측 · EXPOSE_ERROR_STACK=1 일 때만). */
'use strict';
const assert = require('assert');
const { errorHandler, NotFoundError } = require('../src/middleware/errorHandler');
function run(env) {
  const save = { N: process.env.NODE_ENV, E: process.env.EXPOSE_ERROR_STACK };
  process.env.NODE_ENV = env.N; if (env.E == null) delete process.env.EXPOSE_ERROR_STACK; else process.env.EXPOSE_ERROR_STACK = env.E;
  let body = null, code = null;
  const res = { status(c) { code = c; return this; }, json(b) { body = b; return this; } };
  try { errorHandler(new NotFoundError('제품'), { method: 'GET', path: '/x' }, res, () => {}); }
  finally { process.env.NODE_ENV = save.N; if (save.E == null) delete process.env.EXPOSE_ERROR_STACK; else process.env.EXPOSE_ERROR_STACK = save.E; }
  return { code, body };
}
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('  ✅ ' + n); } catch (e) { fail++; console.log('  ❌ ' + n + ' → ' + e.message); } };
t('S1 NODE_ENV=development(운영 실제 상태) → 스택 없음', () => { const r = run({ N: 'development' }); assert.strictEqual(r.code, 404); assert.strictEqual(r.body.error.code, 'NOT_FOUND'); assert.ok(!('stack' in r.body.error)); });
t('S2 NODE_ENV=production → 스택 없음', () => { const r = run({ N: 'production' }); assert.ok(!('stack' in r.body.error)); });
t('S3 EXPOSE_ERROR_STACK=1 일 때만 스택', () => { const r = run({ N: 'development', E: '1' }); assert.ok(typeof r.body.error.stack === 'string'); });
console.log(`\n[error no stack] ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
