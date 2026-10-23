/** test_context_messages.js — ★ 세션83 신호등 맥락 안내 문구(단정 표현 가드레일). 정답 tests/fixtures/context_messages_v1.json (= IP/eval_context_messages_v1 · CM01~05 · M1~M4) */
'use strict';
const assert = require('assert'); const path = require('path');
const C = require(path.join(__dirname, 'fixtures', 'context_messages_v1.json'));
const { evaluateNutrition } = require('../src/services/nutritionTrafficLight');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✅ ' + name); } catch (e) { fail++; console.log('  ❌ ' + name + ' → ' + e.message); } };
for (const c of C.cases) t(`${c.id} ${c.why.slice(0, 50)}`, () => { assert.deepStrictEqual(evaluateNutrition(c.product, c.nutrition).context_messages, c.expect); });
t('M4 서버 소스의 안내 문구에 금지어 없음', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'services', 'nutritionTrafficLight.js'), 'utf8');
  const msgs = [...src.matchAll(/context_messages\.push\(\s*['`]([^'`]+)['`]/g)].map((m) => m[1]);
  assert.ok(msgs.length >= 2, 'push 문구 ' + msgs.length);
  for (const m of msgs) for (const b of C.banned) assert.ok(!m.includes(b), `«${b}» in ${m}`);
});
t('M1·M2 문구가 정답 wording 과 글자 단위로 같다', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'services', 'nutritionTrafficLight.js'), 'utf8');
  for (const w of Object.values(C.wording)) assert.ok(src.includes(w), w);
});
console.log(`\n[context messages] ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
