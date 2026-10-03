/**
 * ★★ 세션74 U72-9 — 알레르기 자동 반영 게이트 «선언 안 오독» eval (residue v3)
 *
 * 정본: `IP/eval_allergen_residue_v1/` (README · build.js) · 결정 `IP/결정_U72-9_잔여토큰v3_2026-10-03.md`
 * 음성 98건(실물 GT 30 + 전사 68): 게이트 결과(pass·contains·may)가 기준선과 «완전히 같아야» 한다.
 * 양성 4,743건: 음성 중 통과 텍스트에서 «선언 안» 이름 한 출현을 오독으로 바꾼 것(빌더가 «파서가 그 이름을 잃는» 것만 남김).
 *   정답 = 큐. 통과(= 그 알레르기 누락 채 자동 반영 · 치명)는 0 이어야 한다.
 * 기준선(v2): 놓침 2,714/4,743 — 3음절 이상 2,421/2,421 전부 · 불용어 167/198 · 2음절 117/1,817 · 1음절 9/307.
 */
const path = require('path');
const fx = require(path.join(__dirname, 'fixtures', 'allergen_residue_eval_v1.json'));
const { evaluateAllergenAutoGate: gate } = require('../src/services/allergenAutoGate');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  ✅', m); else { fails++; console.log('  ❌', m); } };
const J = (x) => JSON.stringify(x);

const neg = new Map(fx.negatives.map((n) => [n.key, n]));
const changed = [];
for (const n of fx.negatives) {
  const g = gate({ text: n.text });
  if (g.pass !== n.base.pass || J(g.contains) !== J(n.base.contains) || J(g.may_contain) !== J(n.base.may)) changed.push(`${n.key}:${g.reason}:${J(g.residue)}`);
}
const missed = []; const tot = {};
for (const p of fx.positives) {
  const t = neg.get(p.src).text;
  const g = gate({ text: t.slice(0, p.at) + p.to + t.slice(p.at + p.from.length) });
  const k = `${p.kind}:${[...p.from].length}`; tot[k] = (tot[k] || 0) + 1;
  if (g.pass) missed.push(p.key);
}
console.log('\n[allergen residue eval v1]', J({ negatives: fx.negatives.length, positives: fx.positives.length, tot }));
for (const c of changed.slice(0, 10)) console.log('    음성 변화', c);
for (const m of missed.slice(0, 10)) console.log('    놓침', m);
ok(changed.length === 0, `실물 음성 ${fx.negatives.length}건 게이트 결과 변화 0 (실측 ${changed.length})`);
ok(missed.length === 0, `선언 안 오독 ${fx.positives.length}건 놓침 0 (실측 ${missed.length} · v2 기준선 2,714)`);
ok(fx.positives.length >= 4743 && fx.negatives.length === 98, '케이스 수 고정(빌더 재실행으로 줄면 빨강)');

// 사람이 읽을 수 있는 대표 사례(빌더 밖에서 직접 고정)
const R = (t) => gate({ text: t });
ok(R('알레르기 유발물질: 돼지고가, 대두 함유').reason === 'RESIDUE', '(c) 4음절 오독 돼지고기→돼지고가 → 큐');
ok(R('알레르기 유발물질: 쇠고가, 대두 함유').reason === 'RESIDUE', '(c) 끝 글자가 조사처럼 보이는 오독 쇠고기→쇠고가 → 큐');
ok(R('밀, 대두, 돼지고기 함유').pass === true && R('및, 대두, 돼지고기 함유').reason === 'RESIDUE', '(d) 밀→및 (쉼표 항목 전체) → 큐');
ok(R('이 제품은 및, 대두를 사용한 제품과 같은 제조시설에서 제조').reason === 'RESIDUE', '(d) 쉼표 앞 낱말 및 → 큐');
ok(R('알레르기 유발물질: 대두, 모두, 우유 함유').reason === 'RESIDUE', '(d) 호두→모두 → 큐');
ok(R('알레르기 유발물질: 대두\n일 함유').reason === 'RESIDUE', '(b) 이름 없는 선언 `일 함유` → 큐');
ok(R('•무유, 메밀, 땅콩을 사용한 제품과 같은 시설에서 제조\n알레르기 유발물질: 대두 함유').reason === 'RESIDUE', '(a) 글머리표 붙은 오독 •무유 → 큐');
ok(R('알레르기 유발물질: 대두유(대두), 땅콩 함유').pass === true, 'FP 방지: 이름을 품은 낱말(대두유)은 흔적 아님');
ok(R('알레르기 유발물질: 우유 및 대두 함유').pass === true, 'FP 방지: 항목 안의 및(우유 및 대두)은 흔적 아님');
ok(R('알레르기 유발물질: 대두, 조개류(굴, 홍합 포함)를 사용').pass !== undefined && R('이 제품은 대두, 조개류(굴, 홍합 포함)를 사용한 제품과 같은 시설에서 제조\n알레르기 유발물질: 밀 함유').pass === true,
  'FP 방지: 괄호 뒤 조사 `를` 은 흔적 아님');

console.log(fails ? `\n❌ ${fails} 실패` : '\n✅ allergen residue eval 전부 통과');
process.exit(fails ? 1 : 0);
