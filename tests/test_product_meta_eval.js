/**
 * ★ 세션73 U72-6 — 제품 메타(brand·manufacturer) 오염 eval (product_meta_eval_v1)
 *   정본: IP/eval_product_meta_v1/cases.json · 사본: tests/fixtures/product_meta_eval_v1.json
 *   · 실물 전사 28건(판매원·제조원 표기가 있는 것 전부) + 합성 3건.
 *   · changed=true 만 정답이 기준선과 다르다(반품·교환 문장 오독 · 「제조원 및 판매원」 복합 라벨).
 *   · 나머지는 기준선 동결 — 한 건이라도 바뀌면 실패(회귀 금지).
 *   ⚠ 이 값은 crowdsourceService 가 products.brand/manufacturer 에 «영구 저장»한다(COALESCE — 한번 들어가면 안 덮인다).
 */
const fs = require('fs');
const path = require('path');
const { extractProductMeta } = require('../src/services/ocrParser');

const FIX = path.join(__dirname, 'fixtures', 'product_meta_eval_v1.json');
const { cases } = JSON.parse(fs.readFileSync(FIX, 'utf8'));
let pass = 0; let fail = 0; let fixed = 0;
for (const c of cases) {
  const m = extractProductMeta(c.text);
  const got = { brand: m.brand ?? null, manufacturer: m.manufacturer ?? null };
  const ok = got.brand === c.expected.brand && got.manufacturer === c.expected.manufacturer;
  if (ok) { pass++; if (c.changed) fixed++; continue; }
  fail++;
  console.log(`  ❌ ${c.id}${c.changed ? ' (정답 변경 건)' : ' (★ 기준선 회귀)'}`);
  console.log(`     기대 ${JSON.stringify(c.expected)}\n     실제 ${JSON.stringify(got)}${c.why ? `\n     근거 ${c.why}` : ''}`);
}
// ── 운영 정리 스크립트(scripts/73-brand-junk-cleanup.js) 판정 — 기준선 잔해는 전부 잡고, 정답 회사명은 하나도 안 잡는다 ──
{
  const dbPath = require.resolve('../src/config/database');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {} };
  const { isJunk } = require('../scripts/73-brand-junk-cleanup');
  const junk = []; const legit = [];
  for (const c of cases) {
    for (const k of ['brand', 'manufacturer']) {
      if (c.expected[k]) legit.push(c.expected[k]);
      if (c.changed && c.baseline && c.baseline[k] && c.baseline[k] !== c.expected[k]) junk.push(c.baseline[k]);
    }
  }
  junk.push('\uBC0F \uAD6C\uC785\uCC98 \uB0B4');   // 운영 306268 실제 값(및 구입처 내)
  const missed = junk.filter((v) => !isJunk(v));
  const falsePos = legit.filter((v) => isJunk(v));
  if (missed.length || falsePos.length || junk.length < 5) {
    fail++;
    console.log(`  ❌ 정리 스크립트 판정 — 놓침 ${JSON.stringify(missed)} · 오탐 ${JSON.stringify(falsePos)} · 잔해 ${junk.length}`);
  } else { pass++; console.log(`  ✅ 정리 스크립트 판정 — 잔해 ${junk.length}건 전부 · 정상 회사명 ${legit.length}건 오탐 0`); }
}

console.log(`\n[product meta eval v1] 통과 ${pass}/${cases.length + 1} · 정답 변경 반영 ${fixed}/${cases.filter((c) => c.changed).length} · 실패 ${fail}`);
process.exit(fail ? 1 : 0);
