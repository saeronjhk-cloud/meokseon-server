/**
 * test_user_barcode_gate.js — ★ 세션81 사용자 바코드 연결 판정. 정답 tests/fixtures/user_barcode_v1.json (= IP/eval_user_barcode_v1) UB01~21.
 *   + 대역 표 파일(src/data/barcode_prefix.json) 모양 · 공용 대역 '*' = unknown.
 */
'use strict';
const assert = require('assert');
const CASES = require('./fixtures/user_barcode_v1.json');
const { judgeLink, normalizeBarcode, makerKey, prefixVerdict } = require('../src/services/userBarcodeGate');
const G = require('../scripts/lib/barcode_link_gate');
let pass = 0, fail = 0; const t = (n, fn) => { try { fn(); pass++; console.log(`  ✅ ${n}`); } catch (e) { fail++; console.log(`  ❌ ${n}\n     → ${e.message}`); } };
const ean = (p12) => { const d = p12.split('').map(Number); let s = 0; for (let i = 0; i < 12; i++) s += d[i] * (i % 2 ? 3 : 1); return p12 + ((10 - (s % 10)) % 10); };
const upc = (p11) => { const d = p11.split('').map(Number); let s = 0; for (let i = 0; i < 11; i++) s += d[i] * (i % 2 ? 1 : 3); return p11 + ((10 - (s % 10)) % 10); };
const bcOf = (x) => { let m = /^B\((\d{12})\)$/.exec(x); if (m) return ean(m[1]); m = /^UPC\((\d{11})\)$/.exec(x); if (m) return upc(m[1]); return x; };

console.log('── UB 순수 판정 (정답 셋 v1)');
for (const c of CASES.cases) {
  t(`${c.id} ${c.desc}`, () => {
    const inp = { ...c.in, barcode: bcOf(c.in.barcode) };
    if (c.want_if_checksum_bad) assert.strictEqual(G.checksumOk(inp.barcode), false, '케이스 바코드가 체크섬 실패여야 한다');
    const r = judgeLink(inp);
    assert.strictEqual(r.status, c.want.status, `status ${r.status} (reason ${r.reason})`);
    assert.strictEqual(r.reason, c.want.reason, `reason ${r.reason}`);
    assert.strictEqual(r.personal, c.want.personal, `personal ${r.personal}`);
    if (c.want.prefix) assert.strictEqual(r.prefix, c.want.prefix, `prefix ${r.prefix}`);
    if (c.want.barcode_len) assert.strictEqual(r.barcode.length, c.want.barcode_len);
  });
}

console.log('── 보조');
t('N1 UPC-A 12자리 → 0 붙여 13자리 · 8자리 유지 · 7자리 null', () => { assert.strictEqual(normalizeBarcode('012345678905'), '0012345678905'); assert.strictEqual(normalizeBarcode('8801-2345'), '88012345'); assert.strictEqual(normalizeBarcode('1234567'), null); });
t('makerKey 주소 꼬리·공장 제거', () => { assert.strictEqual(makerKey('롯데칠성음료(주) 경기도 안성시 미양면'), '롯데칠성음료'); assert.strictEqual(makerKey('하이트진로(주)익산공장'), '하이트진로'); });
t('표 파일 형태: L9 우선 · 공용 대역 * = unknown · 880 아님 = unknown', () => {
  const T = { L9: { '880123456': ['부각상회'], '880999000': ['*'] }, L8: { '88012345': ['다른식품'], '88099900': ['아무개'] } };
  assert.strictEqual(prefixVerdict(ean('880123456001'), { maker: '부각상회' }, T), 'match');
  assert.strictEqual(prefixVerdict(ean('880123456001'), { maker: '다른식품' }, T), 'mismatch');
  assert.strictEqual(prefixVerdict(ean('880999000001'), { maker: '부각상회' }, T), 'unknown');
  assert.strictEqual(prefixVerdict(ean('490123456001'), { maker: '부각상회' }, T), 'unknown');
});
t('대역 표 파일(src/data/barcode_prefix.json) 모양', () => {
  const T = require('../src/data/barcode_prefix.json');
  assert.strictEqual(T.version, 'barcode_prefix_v1'); assert.ok(T.barcodes > 100000, String(T.barcodes)); assert.ok(Object.keys(T.L9).length > 5000);
  for (const [p, v] of Object.entries(T.L9).slice(0, 200)) { assert.ok(/^880\d{6}$/.test(p), p); assert.ok(Array.isArray(v) && v.length >= 1 && v.length <= T.cap); }
});
console.log(`\n${pass} 통과 · ${fail} 실패`); process.exit(fail ? 1 : 0);
