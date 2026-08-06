#!/usr/bin/env node
'use strict';
/**
 * 78-verify-deploy.js — 배포 후 검증 자동화 (세션51 신설)
 * ============================================================================
 * 왜 만들었나: 세션46부터 「배포 후 검증 N건」이 매 인수인계마다 «수작업 체크리스트»로
 * 반복됐고, 그래서 자주 미뤄졌다(세션50 §1 순위4 → 세션51까지 이월). 사람이 앱을 켜고
 * 바코드를 찍어 눈으로 색을 보는 방식은 재현도 기록도 안 된다.
 *
 * ★ 이 스크립트는 **읽기 전용**이다. GET 과 POST /evaluate 만 쓴다.
 *   - `/api/products/evaluate` 는 **DB 에 쓰지 않는** 순수 계산 엔드포인트다(라우터 확인함).
 *   - 사용자 생성(POST /api/users/me)·크라우드 제보는 **일부러 넣지 않았다.** 운영 DB 에
 *     테스트 행을 남기기 때문이다. 그 두 건은 여전히 수동 확인 대상이다(§맨 아래 안내).
 *
 * 실행:
 *   node scripts/78-verify-deploy.js
 *   node scripts/78-verify-deploy.js --base https://다른주소
 *   node scripts/78-verify-deploy.js --verbose
 *
 * 종료코드: 0 = 전건 통과 / 1 = 실패 있음 / 2 = 서버에 붙지 못함
 */

const BASE = (() => {
  const i = process.argv.indexOf('--base');
  return (i >= 0 && process.argv[i + 1]) || 'https://meokseon-server-production.up.railway.app';
})();
const VERBOSE = process.argv.includes('--verbose');
const POLICY_EXPECTED = 'v1.4-s49';

let pass = 0; const fails = []; const skips = [];

function ok(name, extra) { pass++; console.log(`  ✅ ${name}${extra ? '  — ' + extra : ''}`); }
function ng(name, why) { fails.push(name); console.log(`  ❌ ${name}\n       → ${why}`); }
function sk(name, why) { skips.push(name); console.log(`  ⏭  ${name}\n       → ${why}`); }

async function get(p) {
  const r = await fetch(BASE + p, { headers: { accept: 'application/json' } });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* non-json */ }
  return { status: r.status, json: j, text: t };
}
async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* non-json */ }
  return { status: r.status, json: j, text: t };
}

/** 응답 모양이 버전마다 조금씩 달라서 여러 후보를 훑는다. */
function pickList(j) {
  if (!j) return [];
  const d = j.data || j;
  for (const k of ['products', 'items', 'results', 'list']) if (Array.isArray(d[k])) return d[k];
  if (Array.isArray(d)) return d;
  return [];
}
const sanityTypes = (arr) => (Array.isArray(arr) ? arr : []).map((w) => `${w.nutrient}:${w.type}`);

// ── 픽스처 ────────────────────────────────────────────────────────────────
// 김자반형: 건조식품이고 100g 환산 열량이 상한(900)을 크게 넘는다.
const DRIED = {
  product: { product_name: '김자반(검증용)', food_type: '조미김', serving_size: 5, content_unit: 'g' },
  nutrition: { calories: 55, sodium: 130, sugars: 0.5, sat_fat: 0.4, total_fat: 3.5, protein: 1.5, fiber: 0.5, trans_fat: 0 },
};
// 대조군: 같은 수치인데 건조식품이 «아니다». 면제가 새어 나가면 여기서 잡힌다.
const NOT_DRIED = {
  product: { product_name: '일반과자(대조군)', food_type: '과자', serving_size: 5, content_unit: 'g' },
  nutrition: DRIED.nutrition,
};
// 정상 제품: sat_fat 이 total_fat 을 넘지 않는다.
const NORMAL = {
  product: { product_name: '정상제품(대조군)', food_type: '과자', serving_size: 30, content_unit: 'g' },
  nutrition: { calories: 140, sodium: 200, sugars: 2, sat_fat: 3, total_fat: 7, protein: 2, fiber: 1, trans_fat: 0 },
};

const RACC_TARGETS = [
  { label: '참기름', q: '참기름' },
  { label: '간장', q: '간장' },
  { label: '조미김', q: '김' },
];

async function main() {
  console.log('먹선 — 배포 후 검증 (scripts/78-verify-deploy.js)');
  console.log(`대상: ${BASE}`);
  console.log(`실행: ${new Date().toISOString()}\n`);

  // ── A. 서버가 살아 있는가 ────────────────────────────────────────────────
  console.log('── A. 서버 ──');
  let h;
  try { h = await get('/api/health'); } catch (e) {
    console.log(`  ❌ 서버에 붙지 못했다: ${e.message}`);
    console.log('\n     주소가 맞는지, 배포가 끝났는지 확인할 것. --base 로 주소를 바꿀 수 있다.');
    process.exit(2);
  }
  h.status === 200 ? ok('GET /api/health → 200') : ng('GET /api/health', `status=${h.status}`);

  // ── B. 정책 버전 · D2 이중 노출 · 건조식품 면제 (전부 /evaluate — DB 미변경) ──
  console.log('\n── B. 신호등 엔진 (POST /api/products/evaluate · DB 에 쓰지 않는다) ──');
  const dried = await post('/api/products/evaluate', DRIED);
  if (dried.status !== 200 || !dried.json || !dried.json.data) {
    ng('건조식품 평가 호출', `status=${dried.status} body=${dried.text.slice(0, 160)}`);
  } else {
    const ev = dried.json.data.evaluation || {};
    const top = dried.json.data.sanity_warnings;

    // B1 정책 버전
    ev.traffic_light_policy_version === POLICY_EXPECTED
      ? ok('traffic_light_policy_version', ev.traffic_light_policy_version)
      : ng('traffic_light_policy_version', `기대 ${POLICY_EXPECTED} · 실제 ${ev.traffic_light_policy_version} — 배포가 아직 안 됐을 수 있다`);

    // B2 D2 — 이중 노출이 사라졌는가 (세션50 해결분)
    const a = JSON.stringify(sanityTypes(ev.sanity_warnings).sort());
    const b = JSON.stringify(sanityTypes(top).sort());
    a === b
      ? ok('D2 — evaluation.sanity_warnings 와 최상위 sanity_warnings 가 같다', a === '[]' ? '둘 다 비었음' : a)
      : ng('D2 — sanity_warnings 이중 노출', `엔진 ${a} ≠ 최상위 ${b}  (종전엔 이 둘이 반대였다)`);

    // B3 건조식품 100g 상한 면제
    const driedTypes = sanityTypes(ev.sanity_warnings);
    const has100g = driedTypes.some((t) => t.endsWith(':per_100g_exceeded'));
    ev.is_dried_exception === true
      ? ok('조미김이 건조식품으로 판정된다 (is_dried_exception=true)')
      : ng('건조식품 판정', `is_dried_exception=${ev.is_dried_exception} — 면제가 걸리지 않는다`);
    !has100g
      ? ok('건조식품은 100g 상한 경고를 받지 않는다', '= 크라우드 제보가 반려되지 않는 이유')
      : ng('건조식품 100g 면제', `여전히 경고가 붙는다: ${driedTypes.join(', ')}`);
  }

  // B4 대조군 — 면제가 «전 제품»으로 새지 않았는가
  const nd = await post('/api/products/evaluate', NOT_DRIED);
  if (nd.status === 200 && nd.json && nd.json.data) {
    const t = sanityTypes((nd.json.data.evaluation || {}).sanity_warnings);
    t.some((x) => x.endsWith(':per_100g_exceeded'))
      ? ok('대조군 — 비건조 동일 수치는 «여전히» 경고를 받는다', '면제가 새지 않았다')
      : ng('대조군(비건조)', `경고가 없다: ${t.join(', ') || '(없음)'} — 면제가 전 제품에 걸렸을 수 있다`);
  } else ng('대조군 평가 호출', `status=${nd.status}`);

  // B5 정상 제품에 근거 없는 경고가 붙지 않는가 (D3)
  const nm = await post('/api/products/evaluate', NORMAL);
  if (nm.status === 200 && nm.json && nm.json.data) {
    const t = sanityTypes((nm.json.data.evaluation || {}).sanity_warnings);
    !t.includes('sat_fat:exceeds_total_fat')
      ? ok('정상 제품에 sat_fat:exceeds_total_fat 가 붙지 않는다 (D3)')
      : ng('D3 — 정상 제품 오경고', `sat_fat 3g ≤ total_fat 7g 인데 경고가 붙었다: ${t.join(', ')}`);
  } else ng('정상 제품 평가 호출', `status=${nm.status}`);

  // ── C. RACC — 소량섭취 식품의 1회량 출처 (세션49 치명B) ───────────────────
  console.log('\n── C. RACC 1회량 (세션49 치명B — 사용자에게 «색»으로 보이는 변화) ──');
  for (const t of RACC_TARGETS) {
    const s = await get(`/api/products/search?q=${encodeURIComponent(t.q)}`);
    const list = pickList(s.json);
    if (!list.length) { sk(`${t.label} — 검색 결과 없음`, `GET /api/products/search?q=${t.q} status=${s.status}`); continue; }

    let found = null;
    for (const p of list.slice(0, 8)) {
      const bc = p.barcode || p.bc || (p.product && p.product.barcode);
      if (!bc) continue;
      const d = await get(`/api/products/${bc}`);
      const tl = d.json && d.json.data && d.json.data.traffic_light;
      if (!tl) continue;
      const src = tl.serving_basis && tl.serving_basis.source;
      if (VERBOSE) console.log(`       · ${bc} ${(p.product_name || p.name || '').slice(0, 24)} → source=${src}`);
      if (src === 'racc') { found = { bc, name: p.product_name || p.name, tl }; break; }
      if (!found) found = { bc, name: p.product_name || p.name, tl, notRacc: src };
    }
    if (!found) sk(`${t.label} — 바코드로 조회되는 제품이 없음`, '검색 결과에 barcode 가 없다');
    else if (found.notRacc !== undefined) ng(`${t.label} — RACC 1회량이 안 걸린다`, `${found.bc} ${found.name || ''} · serving_basis.source=${found.notRacc} (기대 racc). 상위 8건 전부 아님`);
    else ok(`${t.label} — serving_basis.source = racc`, `${found.bc} ${found.name || ''}`);
  }

  // ── D. 알레르기 노출 계약 ────────────────────────────────────────────────
  console.log('\n── D. 알레르기 (⚠ 재적재 전이라 «값»은 아직 옛 상태다 — 계약만 본다) ──');
  const jerky = await get('/api/products/8801005013130');
  if (jerky.status !== 200 || !jerky.json || !jerky.json.data) {
    sk('8801005013130 (질러 한입 육포)', `조회 실패 status=${jerky.status} — 이 바코드가 DB 에 없을 수 있다`);
  } else {
    const d = jerky.json.data;
    d.allergens_available === true
      ? ok('allergens_available = true')
      : ng('allergens_available', `${d.allergens_available} — 미수집으로 나온다`);
    const flat = Array.isArray(d.allergens) ? d.allergens : [];
    flat.includes('밀')
      ? ok('육포 알레르겐에 밀이 있다', flat.join(', '))
      : ng('육포 알레르겐', `밀이 없다: [${flat.join(', ')}]`);
    typeof d.allergens_flat_complete === 'boolean'
      ? ok('allergens_flat_complete 가 응답에 있다', String(d.allergens_flat_complete))
      : ng('allergens_flat_complete', '응답에 없다 — 구버전 앱 계약이 깨진다');
  }

  // ── 정리 ────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(74));
  console.log(`통과 ${pass} · 실패 ${fails.length} · 건너뜀 ${skips.length}`);
  if (fails.length) { console.log('\n실패:'); fails.forEach((f) => console.log('  ·', f)); }
  if (skips.length) { console.log('\n건너뜀(데이터가 없어 판정 못 함 — 실패가 아니다):'); skips.forEach((f) => console.log('  ·', f)); }

  console.log('\n※ 이 스크립트가 «보지 않는» 것 — 수동 확인이 필요하다:');
  console.log('   1) 크라우드 제보 저장 게이트 (POST 라 운영 DB 에 행을 남긴다)');
  console.log('      → 앱에서 김·김자반·육포를 제보해 «반려되지 않는지» 볼 것. 종전엔 반려됐다.');
  console.log('   2) 501자 User-Agent 가입(PC1)·21자 동의버전 거부(PC2) — users 행이 생긴다.');
  console.log('   3) OCR 응답의 traffic_light.sanity_warnings ↔ data.sanity_warnings 동일성');
  console.log('      → 사진이 필요하다. 위 B2 가 같은 코드 경로를 /evaluate 로 대신 확인한다.');
  console.log('   4) ⚠ 알레르기 «값»은 DB 재적재(26 → 19 → 76) 전까지 바뀌지 않는다.');

  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('\n[중단] 예상 못 한 오류:', e && e.stack || e); process.exit(2); });
