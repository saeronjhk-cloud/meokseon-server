/**
 * ★ 세션73 U71-5 — 제품명 «한 글자 오독» 제안 eval + 라우트
 *   §1 운영 실례(13건) — 오독 4건(3종) 정답 제안 · 정상 9건 무제안
 *   §2 합성 오독·보류 오탐(공공 제품명 80/20 분할 · 로컬 덤프 없으면 건너뜀) — 정답 ≥95% · 오제안 0 · 보류 오탐 ≤1%
 *   §3 사전 캐시 · 라우트(GET /api/products/name-suggest) · 실패 시 null
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
let pass = 0; let fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.log(`  ❌ ${name}\n     → ${e.message.split('\n').slice(0, 4).join('\n       ')}`); } }
const SRV = path.join(__dirname, '..');
const S = require('../src/services/nameSuggest');
const EV = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'name_suggest_eval_v1.json'), 'utf8'));

function localNames() {
  const out = [];
  for (const f of ['c003_dump.ndjson', 'haccp_dump.ndjson']) {
    const p = path.join(SRV, 'scripts', 'output', f);
    if (!fs.existsSync(p)) return null;
    for (const l of fs.readFileSync(p, 'utf8').split('\n')) { try { const o = JSON.parse(l); if (o.nm) out.push(o.nm); } catch (_) { /* 빈 줄 */ } }
  }
  return out;
}

async function main() {
  const names = localNames();
  console.log('\n── §1 운영 실례');
  const base = names || [];
  const dict = S.buildDictionary([...base, ...EV.prod_known, '비비고 순살 삼치구이', '질러 육포']);
  for (const c of EV.cases) {
    await t(`§1 cid ${c.cid} [${c.kind}] 「${c.ocr}」 → ${c.expected_suggested ? `「${c.expected_suggested}」` : '제안 없음'}`, () => {
      assert.strictEqual(S.suggestName(c.ocr, dict).suggested, c.expected_suggested);
    });
  }

  console.log('\n── §2 합성 오독 · 보류 오탐');
  if (!names) { console.log('  ⏭ scripts/output 덤프 없음 — §2 건너뜀(제이 PC 에서는 있음)'); }
  else {
    let seed = 73; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const sh = names.map((n) => [rnd(), n]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const cut = Math.floor(sh.length * 0.8);
    const d2 = S.buildDictionary(sh.slice(0, cut));
    let fp = 0; const hold = sh.slice(cut, cut + 3000);
    for (const n of hold) if (S.suggestName(n, d2).suggested) fp++;
    const CH = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'; const JU = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
    const pairs = S.CONFUSE.flatMap(([a, b]) => [[a, b], [b, a]]);
    const corrupt = (tok) => {
      const chars = [...tok];
      for (let k = 0; k < 10; k++) {
        const i = Math.floor(rnd() * chars.length); const c = chars[i].charCodeAt(0) - 0xac00;
        let cho = Math.floor(c / 588); let jung = Math.floor((c % 588) / 28); const jong = c % 28;
        const [a, b] = pairs[Math.floor(rnd() * pairs.length)];
        if (CH[cho] === a && CH.includes(b)) cho = CH.indexOf(b); else if (JU[jung] === a && JU.includes(b)) jung = JU.indexOf(b); else continue;
        const n = [...chars]; n[i] = String.fromCharCode(0xac00 + cho * 588 + jung * 28 + jong); return n.join('');
      }
      return null;
    };
    const toks = [...d2.freq.entries()].filter(([, f]) => f >= 2).map((x) => x[0]);
    let ok = 0; let wrong = 0; let tot = 0;
    for (let i = 0; i < 1500 && tot < 600; i++) {
      const tk = toks[Math.floor(rnd() * toks.length)]; const c = corrupt(tk);
      if (!c || d2.freq.has(c)) continue; tot++;
      const s = S.suggestName(c, d2).tokens[0].suggestion;
      if (s === tk) ok++; else if (s) wrong++;
    }
    const th = EV.synthetic_thresholds;
    console.log(`  ⓘ 합성 ${tot} · 정답 ${ok} · 오제안 ${wrong} · 보류 오탐 ${fp}/${hold.length}`);
    await t(`§2-1 합성 오독 정답 ≥ ${th.correct_min_ratio * 100}% · 오제안 ≤ ${th.wrong_max}`, () => {
      assert.ok(ok / tot >= th.correct_min_ratio, `${ok}/${tot}`); assert.ok(wrong <= th.wrong_max, `wrong ${wrong}`);
    });
    await t(`§2-2 보류(새 제품 흉내) 오탐 ≤ ${th.holdout_false_suggest_max_ratio * 100}%`, () => {
      assert.ok(fp / hold.length <= th.holdout_false_suggest_max_ratio, `${fp}/${hold.length}`);
    });
  }

  console.log('\n── §3 사전 캐시 · 라우트');
  const D = require('../src/services/nameSuggestDict');
  await t('§3-1 사전은 한 번만 만든다(동시 요청 1회 조회) · 실패하면 null', async () => {
    D._reset(); let calls = 0;
    const db = { query: async () => { calls++; return { rows: [{ product_name: '비비고 순살 삼치구이' }] }; } };
    const [a, b] = await Promise.all([D.getDictionary(db), D.getDictionary(db)]);
    assert.strictEqual(calls, 1); assert.ok(a === b && a.freq.has('순살'));
    D._reset();
    assert.strictEqual(await D.getDictionary({ query: async () => { throw new Error('x'); } }), null);
  });
  await t('§3-2 GET /api/products/name-suggest — 제안 · name 없으면 400', async () => {
    D._reset();
    const dbPath = require.resolve('../src/config/database');
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: async () => ({ rows: [{ product_name: '비비고 순살 삼치구이' }] }) } };
    // 실제 앱(express-async-errors · errorHandler 포함)으로 — 검증 오류가 400 으로 나가는지까지 본다
    const app = require('../src/app');
    const srv = app.listen(0); const port = srv.address().port;
    const get = (p) => new Promise((res, rej) => http.get({ port, path: p }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(b) })); }).on('error', rej));
    try {
      const r = await get('/api/products/name-suggest?name=' + encodeURIComponent('비비고 군살 삼치구이'));
      assert.strictEqual(r.status, 200); assert.strictEqual(r.body.data.suggested, '비비고 순살 삼치구이');
      const r2 = await get('/api/products/name-suggest');
      assert.strictEqual(r2.status, 400);
    } finally { srv.close(); }
  });

  console.log(`\n════ 통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
