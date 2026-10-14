/**
 * 102-web-label-load.js — 판매처 라벨(웹) OCR 수집분 적재 (미리보기 → 적용 → 되돌리기)  세션78 2026-10-13
 * ============================================================================
 * 제이 결정(10-13 20:29): 「진행하는데, DB에 없는 품목은 별도 기존 데이터베이스와 같은 양식으로 하되, 별도로 만들어.」
 * 입력: 역방향 수집 결과 JSONL(한 줄 = 판매처 페이지 1개 · .tmp/s78/r2.js 형식) + 페이지별 OCR 원문 폴더.
 * 규칙(엔진 · 추정 없음)
 *   gate in_db (라벨 품목보고번호 «하나» == public.products.c005_report_no)
 *     → 그 번호의 활성 제품마다, 빈 칸만:
 *        · 알레르기 표시란 없음 + 라벨 «함유» ≥1 → 검토 후보 axis 'allergens'
 *        · 영양 없음(nutrition_data·nutrition_data_crowd 둘 다 없음) + 100g(㎖) 환산값 + 상식 범위 → 검토 후보 axis 'nutrition'
 *        · 원재료: 쓰지 않는다(구역 추출 정확도 미달 · 결과요약_v1 역방향 v1)
 *       ★ 세션79(제이 10-14 13:54) — 후보는 public 검토 대기열이 «아니라» web_label.public_supplements(032)에 둔다.
 *         판매처 라벨 값은 전부 web_label 에서 관리(public 무접촉). 노출 여부는 품질 게이트(scripts/104-web-label-gate.js)가 status 로 정한다.
 *         (세션78 의 contributions/contribution_review 경로는 폐기 — 그 시절 배치의 되돌리기만 남긴다.)
 *   gate not_in_db (번호가 public 에 없음) → web_label 스키마(031 · public 과 같은 양식)에 신규 품목 1개:
 *        products · nutrition_data(100g 환산 · serving_size '100g'/'100ml') · product_allergens(함유 contains · 혼입 may_contain · status candidate)
 *        · product_ingredients(원재료 구역 원문 · source 'web_label_ocr'). 같은 번호가 web_label 에 이미 있으면 건너뜀.
 *   no_report_no · multi_report_no → source_pages 기록만(값 없음).
 *   모든 페이지 → web_label.source_pages(출처 URL·수집일·번호·판정·batch_id).
 * 실행 (meokseon-server 폴더):
 *   node scripts/102-web-label-load.js --in <results.jsonl> --ocr-dir <rv_ 폴더들이 있는 곳>            미리보기(CSV)
 *   … --apply        적용(한 트랜잭션) · … --slice 0:150 (구간만 · 배치 id 는 구간마다 다름)          … --undo <batch_id>   되돌리기(승인된 후보가 있으면 거부)
 *   node scripts/102-web-label-load.js --self-test   (PGlite · 000~031 적용 후 끝까지)
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* */ }
const KEYS = ['calories', 'total_fat', 'saturated_fat', 'trans_fat', 'cholesterol', 'sodium', 'total_carbs', 'total_sugars', 'protein'];
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const canon = require('./lib/capture_label_parser');
const { cleanFoodType } = require('./lib/web_label_gate');
const P = require('../src/services/ocrParser');

/** OCR 원문 → 웹 값(수집 스크립트와 무관하게 «여기서» 다시 계산 · 같은 파서). */
function webFromText(text) {
  if (!text) return null;
  const sec = P.extractIngredientSection(text); const n = P.parseNutrition(text); const a = P.detectAllergensV2(text);
  let f = null;
  if (n._basis === 'per_100g' || n._basis === 'per_100ml') f = 1; else if (n._basis === 'per_serving' && n._basis_amount) f = 100 / n._basis_amount; else if (n._basis === 'per_total' && n.total_content) f = 100 / n.total_content;
  let per100 = null; if (f != null) { per100 = {}; for (const k of KEYS) if (n[k] != null) per100[k] = Math.round(n[k] * f * 100) / 100; if (!Object.keys(per100).length) per100 = null; }
  return { ingredients_text: sec ? String(sec).slice(0, 1500) : null, basis: n._basis, basis_amount: n._basis_amount || null, per100, alg_contains: a.contains || [], alg_may: a.mayContain || [] };
}

const ORIGIN = 'web_label_ocr';

function sane(p) { // 100g(㎖)당 상식 범위 — 넘으면 영양 후보를 만들지 않는다
  if (!p || p.calories == null) return false;
  if (p.calories < 0 || p.calories > 900) return false;
  if (p.sodium != null && (p.sodium < 0 || p.sodium > 40000)) return false;
  for (const k of ['total_fat', 'total_carbs', 'protein', 'total_sugars']) if (p[k] != null && (p[k] < 0 || p[k] > 100)) return false;
  return true;
}
function maker(text) {
  // 「업소명 및 소재지 (주)오리온 …」 — 앞의 «및 소재지» 조각을 떼고 «(주)/주식회사» 가 들어간 상호만 받는다(없으면 null)
  const m = String(text || '').match(/(?:업소명|제조원|제조사)\s{0,3}(?:및\s{0,3}소재지)?\s{0,3}[:：]?\s{0,3}([^\n/,]{2,50})/);
  if (!m) return null;
  const v = m[1].replace(/^(?:및\s*)?(?:소재지\s*)?[:：]?\s*/, '').trim();
  const c = v.match(/((?:\(주\)|㈜|주식회사)\s?[가-힣A-Za-z0-9&]+(?:\s?(?:제\d+)?[가-힣]*공장)?|[가-힣A-Za-z0-9&]+\s?(?:\(주\)|㈜|주식회사))/);
  return c ? c[1].trim() : null;
}
function siteBrandName(name) { const m = String(name || '').match(/^\s*\[([^\]]+)\]\s*(.*)$/); return m ? { brand: m[1], name: m[2] } : { brand: null, name: String(name || '').trim() }; }

/** 순수: 페이지 1개 → 할 일 목록. db = { byReport: Map(rn → [{product_id, barcode, has_alg, has_nut}]), wlReports: Set(rn) } */
function planPage(rec, ocrText, db) {
  const out = { page: { site: 'kurly', site_item_no: String(rec.no), url: rec.url, site_name: rec.name, report_no: (rec.report_nos || []).length === 1 ? rec.report_nos[0] : null, gate: rec.status, ocr_chars: ocrText.length, ocr_sha1: crypto.createHash('sha1').update(ocrText).digest('hex'), fetched_at: rec.at }, candidates: [], newProduct: null, notes: [] };
  if (!['in_db', 'not_in_db', 'no_report_no', 'multi_report_no'].includes(rec.status)) { out.page = null; out.notes.push('skip:' + rec.status); return out; }
  const wt = ocrText ? webFromText(ocrText) : null;
  const w = (wt && (wt.per100 || wt.alg_contains.length || wt.ingredients_text)) ? wt : (rec.web || wt || null); const rn = out.page.report_no;   // ★ 원문에서 다시 계산(수집 쪽 rec.web 은 in_db 에만 있었다 — 1차 적용에서 신규 품목 값 0건 사고)
  const L = canon.parseLabel(ocrText || '');
  // 액상(㎖) 판정 — 영양 100㎖ 기준인지. 라벨 기준·총량 단위 또는 판매처 상품명(240mL 등). g/㎖ 를 섞으면 승인 때 환산이 거부된다(CONVERT_BASIS_UNKNOWN).
  const unitMl = /m[lL]|㎖/.test(String(L.basis_unit || '') + String(L.total_unit || '')) || /\d\s*(?:m[lL]|㎖)\b/.test(String(rec.name || '')) || (w && w.basis === 'per_100ml');
  if (rec.status === 'in_db') {
    const prods = db.byReport.get(rn) || [];
    if (!prods.length) { out.notes.push('in_db 인데 지금 DB 에 없음 → 건너뜀'); return out; }
    for (const p of prods) {
      if (!p.has_alg && w && (w.alg_contains || []).length) out.candidates.push({ product_id: p.product_id, barcode: p.barcode, axis: 'allergens', data: { contains: w.alg_contains, may_contain: (w.alg_may || []).filter((a) => !w.alg_contains.includes(a)) } });
      if (!p.has_nut && w && sane(w.per100)) { const pn = { _basis: unitMl ? 'per_100ml' : 'per_100g' }; for (const k of KEYS) if (w.per100[k] != null) pn[k] = w.per100[k]; out.candidates.push({ product_id: p.product_id, barcode: p.barcode, axis: 'nutrition', data: pn }); }
    }
    return out;
  }
  if (rec.status === 'not_in_db') {
    if (!rn) { out.notes.push('번호 없음'); return out; }
    if (db.wlReports.has(rn)) { out.notes.push('web_label 에 같은 번호 이미 있음'); return out; }
    const sb = siteBrandName(rec.name);
    // 제품명 = 판매처 상품명(브랜드 대괄호 제거). 라벨 OCR 의 「제품명」 칸은 잡음이 많다(실측: 'bibigo'·'내용량' 등) → 참고로만 남긴다.
    const np = { label_product_name: L.product_name || null, product: { product_name: sb.name.slice(0, 100), brand: sb.brand, manufacturer: maker(ocrText), food_type: cleanFoodType(L.food_type), total_content: L.total_content || null, content_unit: L.total_unit || null, c005_report_no: rn }, nutrition: null, allergens: [], ingredients: null };
    if (w && sane(w.per100)) { const n = { serving_size: unitMl ? '100ml' : '100g' }; for (const k of KEYS) if (w.per100[k] != null) n[k] = w.per100[k]; np.nutrition = n; }
    for (const a of (w && w.alg_contains) || []) np.allergens.push({ allergen_name: a, evidence_level: 'contains' });
    for (const a of (w && w.alg_may) || []) if (!np.allergens.some((x) => x.allergen_name === a)) np.allergens.push({ allergen_name: a, evidence_level: 'may_contain' });
    if (w && w.ingredients_text) np.ingredients = String(w.ingredients_text).slice(0, 4000);
    db.wlReports.add(rn);   // 같은 배치 안에서 같은 번호 두 번 만들지 않는다(실측: 비비고 왕교자 1.05kg·455g 이 같은 번호)
    out.newProduct = np; return out;
  }
  return out; // no_report_no · multi → 기록만
}

async function loadDbState(q, reports) {
  const byReport = new Map(); const wlReports = new Set();
  if (reports.length) {
    const r = await q(`select p.product_id, p.barcode, p.c005_report_no rn,
        exists(select 1 from product_allergens a where a.product_id=p.product_id) has_alg,
        (exists(select 1 from nutrition_data n where n.product_id=p.product_id) or exists(select 1 from nutrition_data_crowd c where c.product_id=p.product_id)) has_nut
      from products p where p.is_active and p.c005_report_no = any($1)`, [reports]);
    for (const x of r.rows) { if (!byReport.has(x.rn)) byReport.set(x.rn, []); byReport.get(x.rn).push({ product_id: Number(x.product_id), barcode: x.barcode, has_alg: x.has_alg, has_nut: x.has_nut }); }
    const w = await q(`select c005_report_no rn from web_label.products where c005_report_no = any($1)`, [reports]);
    for (const x of w.rows) wlReports.add(x.rn);
  }
  return { byReport, wlReports };
}

async function applyPlans(q, plans, batch) {
  // ★ 원격 DB 왕복이 비싸다(실측 RTT ~0.3s) → 페이지 1개 = SQL 1문장(+후보마다 1문장). 데이터 수정 CTE 로 한 번에 넣는다.
  const rec = { batch, supplements: [], web_label_products: [], pages: [] };
  const urls = plans.filter((p) => p.page).map((p) => p.page.url);
  const ex = new Set((await q('select url from web_label.source_pages where url = any($1)', [urls])).rows.map((r) => r.url));
  for (const pl of plans) {
    if (!pl.page || ex.has(pl.page.url)) continue;   // 이미 적재한 페이지(멱등)
    ex.add(pl.page.url);
    let target = null, pid = null;
    for (const c of pl.candidates) {   // ★ 세션79 — public 대기열이 아니라 web_label.public_supplements(상태 needs_review → 게이트가 판정)
      const r = await q(`insert into web_label.public_supplements (product_id, axis, data, source_url, report_no, batch_id) values ($1,$2,$3::jsonb,$4,$5,$6)
        on conflict (product_id, axis, source_url) do nothing returning supplement_id`, [c.product_id, c.axis, JSON.stringify(c.data), pl.page.url, pl.page.report_no, batch]);
      if (r.rows[0]) rec.supplements.push(Number(r.rows[0].supplement_id)); target = 'public'; pid = pid || c.product_id;
    }
    const p = pl.page;
    const pageVals = [p.site, p.site_item_no, p.url, p.site_name, p.report_no, p.gate, p.ocr_chars, p.ocr_sha1, p.fetched_at, batch];
    if (pl.newProduct) {
      const P = pl.newProduct.product; const N = pl.newProduct.nutrition;
      const r = await q(`with np as (insert into web_label.products (product_name, brand, manufacturer, food_type, total_content, content_unit, c005_report_no, data_source, verification, collected_at) values ($11,$12,$13,$14,$15,$16,$17,'web_label','unverified',$9::timestamptz) returning product_id),
        nd as (insert into web_label.nutrition_data (product_id, ${KEYS.join(',')}, serving_size, data_source) select np.product_id, ${KEYS.map((k) => `(n->>'${k}')::numeric`).join(',')}, n->>'serving_size', 'web_label' from np, (select $18::jsonb n) x where $18::jsonb is not null returning 1),
        al as (insert into web_label.product_allergens (product_id, allergen_name, status, detected_via, evidence_level) select np.product_id, a.allergen_name, 'candidate', 'web_label', a.evidence_level from np, jsonb_to_recordset($19::jsonb) a(allergen_name text, evidence_level text) on conflict do nothing returning 1),
        ig as (insert into web_label.product_ingredients (product_id, raw_text, prdlst_report_no, source) select np.product_id, $20, $17, 'web_label_ocr' from np where $20::text is not null returning 1),
        sp as (insert into web_label.source_pages (site, site_item_no, url, site_name, report_no, gate, target_schema, product_id, ocr_chars, ocr_sha1, fetched_at, batch_id) select $1,$2,$3,$4,$5,$6,'web_label',np.product_id,$7,$8,$9,$10 from np returning page_id)
        select (select product_id from np) product_id, (select page_id from sp) page_id`,
        [...pageVals, P.product_name, P.brand, P.manufacturer, P.food_type, P.total_content, P.content_unit, P.c005_report_no, N ? JSON.stringify(N) : null, JSON.stringify(pl.newProduct.allergens), pl.newProduct.ingredients || null]);
      rec.web_label_products.push(Number(r.rows[0].product_id)); rec.pages.push(Number(r.rows[0].page_id));
    } else {
      const r = await q(`insert into web_label.source_pages (site, site_item_no, url, site_name, report_no, gate, target_schema, product_id, ocr_chars, ocr_sha1, fetched_at, batch_id) values ($1,$2,$3,$4,$5,$6,$11,$12,$7,$8,$9,$10) returning page_id`, [...pageVals, target, pid]);
      rec.pages.push(Number(r.rows[0].page_id));
    }
  }
  return rec;
}

async function undoBatch(q, batch) {
  // 세션78 배치(public 대기열 경로): 승인/반영된 후보가 있으면 거부
  const ap = await q(`select count(*)::int n from contribution_review where evidence->>'batch_id'=$1 and evidence->>'origin'=$2 and status not in ('candidate','superseded','undone','rejected')`, [batch, ORIGIN]);
  if (ap.rows[0].n) throw new Error(`UNDO_REFUSED: 이 배치 후보 중 ${ap.rows[0].n}건이 이미 승인/반영됨 — 관리자 화면에서 먼저 되돌릴 것`);
  const c = await q(`delete from contributions where contribution_type=$2 and data->>'batch_id'=$1 returning contribution_id`, [batch, ORIGIN]); // review 는 CASCADE
  const ps = await q(`delete from web_label.public_supplements where batch_id=$1 returning supplement_id`, [batch]);   // 세션79 경로
  const w = await q(`delete from web_label.products where product_id in (select product_id from web_label.source_pages where batch_id=$1 and target_schema='web_label') returning product_id`, [batch]);
  const s = await q(`delete from web_label.source_pages where batch_id=$1 returning page_id`, [batch]);
  return { contributions: c.rows.length, supplements: ps.rows.length, web_label_products: w.rows.length, pages: s.rows.length };
}

function readInput(inPath, ocrDir) {
  const recs = fs.readFileSync(inPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const seen = new Set(); const out = [];
  for (const r of recs) { if (seen.has(r.url)) continue; seen.add(r.url); const f = path.join(ocrDir, 'rv_' + r.no, 'ocr.txt'); out.push({ rec: r, text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' }); }
  return out;
}

async function selfTest() {
  const { PGlite } = require('@electric-sql/pglite'); const db = new PGlite(); const MIG = path.join(__dirname, 'migrations');
  for (const f of ['000_baseline.sql', '021_supabase_auth.sql', '022_additive_detected_count.sql', '023_data_inspection.sql', '024_contribution_review.sql', '025_nutrition_data_crowd.sql', '026_crowd_nutrition_split.sql', '029_review_auto_applied.sql', '030_contribution_photos.sql', '031_web_label_schema.sql', '032_web_label_exposure.sql']) await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
  const q = (s, p) => db.query(s, p);
  let ok = 0, bad = 0; const eq = (a, b, n) => { const s = JSON.stringify(a) === JSON.stringify(b); s ? ok++ : bad++; console.log(`  ${s ? '✅' : '❌'} ${n}${s ? '' : `\n     기대 ${JSON.stringify(b)}\n     실제 ${JSON.stringify(a)}`}`); };
  const mk = async (bc, rn) => Number((await q("insert into products (barcode, product_name, data_source, c005_report_no) values ($1,'p','public_c005',$2) returning product_id", [bc, rn])).rows[0].product_id);
  const p1 = await mk('880001', '1976048700593'); const p2 = await mk('880002', '1976048700593'); const p3 = await mk('880003', '2001044505524');
  await q("insert into product_allergens (product_id, allergen_name) values ($1,'밀')", [p2]);
  await q("insert into nutrition_data (product_id, calories) values ($1, 500)", [p3]);
  const web = { per100: { calories: 494.12, sodium: 588.24, total_carbs: 64.71, protein: 5.88 }, basis: 'per_serving', alg_contains: ['대두', '밀'], alg_may: ['땅콩'], ingredients_text: '감자분말, 식물성유지' };
  const recs = [
    { no: 1, url: 'https://www.kurly.com/goods/1', name: '[오리온] 예감 치즈 그라탕 204g', at: '2026-10-13T00:00:00Z', status: 'in_db', report_nos: ['1976048700593'], web },
    { no: 2, url: 'https://www.kurly.com/goods/2', name: '[오뚜기] 골드 마요네스', at: '2026-10-13T00:00:00Z', status: 'in_db', report_nos: ['2001044505524'], web: { ...web, per100: { calories: 9999 } } },
    { no: 3, url: 'https://www.kurly.com/goods/3', name: '[농심] 먹태깡 60g', at: '2026-10-13T00:00:00Z', status: 'not_in_db', report_nos: ['19720154001491'], web },
    { no: 4, url: 'https://www.kurly.com/goods/4', name: '[농심] 신라면', at: '2026-10-13T00:00:00Z', status: 'no_report_no', report_nos: [] },
  ];
  const texts = { 1: '라벨', 2: '라벨', 3: '제품명 먹태깡청양마요맛\n식품유형 과자\n업소명 및 소재지 (주)농심 / 서울\n', 4: '' };
  const st = await loadDbState(q, ['1976048700593', '2001044505524', '19720154001491']);
  const plans = recs.map((r) => planPage(r, texts[r.no], st));
  eq(plans[0].candidates.map((c) => [c.product_id, c.axis]), [[p1, 'allergens'], [p1, 'nutrition'], [p2, 'nutrition']], 'in_db: 같은 번호 제품 2개 — 빈 칸만(p2 는 알레르기 있음)');
  eq(plans[0].candidates[1].data._basis, 'per_100g', '영양 후보는 100g 환산 기준');
  eq(plans[0].candidates[0].data, { contains: ['대두', '밀'], may_contain: ['땅콩'] }, '알레르기 보충 값 = 함유·혼입');
  eq(plans[1].candidates.map((c) => c.axis), ['allergens'], '상식 범위 밖 영양(9999kcal) → 영양 후보 안 만듦 · 영양 있는 제품은 애초에 제외');
  eq([plans[2].newProduct.product.product_name, plans[2].newProduct.label_product_name, plans[2].newProduct.product.manufacturer, plans[2].newProduct.product.food_type], ['먹태깡 60g', '먹태깡청양마요맛', '(주)농심', '과자'], 'not_in_db: 제품명=판매처 상품명(브랜드 제거) · 라벨 제품명은 참고 · 업소명·식품유형');
  eq(planPage({ ...recs[2], no: 5, url: 'https://www.kurly.com/goods/5' }, texts[3], st).newProduct, null, '같은 배치에서 같은 번호 두 번째 페이지 → 신규 만들지 않음');
  eq(plans[2].newProduct.allergens, [{ allergen_name: '대두', evidence_level: 'contains' }, { allergen_name: '밀', evidence_level: 'contains' }, { allergen_name: '땅콩', evidence_level: 'may_contain' }], 'not_in_db: 함유/혼입 등급');
  const pubBefore = (await q("select (select count(*)::int from public.product_allergens) a, (select count(*)::int from public.nutrition_data_crowd) c, (select count(*)::int from contributions) k")).rows[0];
  const rec = await applyPlans(q, plans, 'wl_test');
  eq([rec.supplements.length, rec.web_label_products.length, rec.pages.length], [4, 1, 4], '적용: 보충 4 · 신규 품목 1 · 페이지 4');
  const sp = (await q("select product_id::int pid, axis, status, batch_id from web_label.public_supplements order by supplement_id")).rows;
  eq(sp.map((x) => [x.pid, x.axis, x.status]), [[p1, 'allergens', 'needs_review'], [p1, 'nutrition', 'needs_review'], [p2, 'nutrition', 'needs_review'], [p3, 'allergens', 'needs_review']], '보충은 web_label.public_supplements · 상태 needs_review(게이트 전)');
  const pubAfter = (await q("select (select count(*)::int from public.product_allergens) a, (select count(*)::int from public.nutrition_data_crowd) c, (select count(*)::int from contributions) k")).rows[0];
  eq(pubAfter, pubBefore, '★ public 무접촉(알레르기·제보 영양·제보 행 수 그대로)');
  const wl = (await q("select (select count(*)::int from web_label.nutrition_data) n, (select count(*)::int from web_label.product_allergens) a, (select count(*)::int from web_label.product_ingredients) i, (select count(*)::int from public.products) pp, (select status from web_label.products limit 1) st")).rows[0];
  eq([wl.n, wl.a, wl.i, wl.pp, wl.st], [1, 3, 1, 3, 'needs_review'], 'web_label 신규 품목에 영양·알레르기·원재료 · 상태 needs_review · public 제품 수 무변경');
  const rec2 = await applyPlans(q, plans, 'wl_test2');
  eq(rec2.pages.length + rec2.supplements.length, 0, '재실행 멱등(같은 URL 은 건너뜀)');
  eq(await undoBatch(q, 'wl_test'), { contributions: 0, supplements: 4, web_label_products: 1, pages: 4 }, '되돌리기: 보충·신규 품목·페이지 전부');
  const left = (await q("select (select count(*)::int from web_label.public_supplements) s, (select count(*)::int from web_label.product_allergens) a, (select count(*)::int from public.product_allergens) pa")).rows[0];
  eq([left.s, left.a, left.pa], [0, 0, 1], '되돌린 뒤 잔여 0 · public 기존 알레르기 무접촉');
  console.log(`\nself-test: ${ok} 통과 · ${bad} 실패`); process.exit(bad ? 1 : 0);
}

async function main() {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const UNDO = arg('--undo');
  if (UNDO) { const c = await pool.connect(); try { await c.query('begin'); const r = await undoBatch((s, p) => c.query(s, p), UNDO); await c.query('commit'); console.log('되돌림', UNDO, r); } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); await pool.end(); } return; }
  const IN = arg('--in'); const OCR = arg('--ocr-dir'); if (!IN || !OCR) throw new Error('--in 과 --ocr-dir 필요');
  let items = readInput(IN, OCR);
  const SL = arg('--slice'); if (SL) { const [a, b] = SL.split(':').map(Number); items = items.slice(a, b); }   // 원격 DB 왕복이 많아 한 번에 다 넣으면 시간 초과 → 구간으로 나눠 적용(배치는 구간마다 따로)
  const reports = [...new Set(items.flatMap((x) => x.rec.report_nos || []))];
  const st = await loadDbState((s, p) => pool.query(s, p), reports);
  const plans = items.map((x) => planPage(x.rec, x.text, st));
  const rows = [['url', 'gate', 'report_no', 'action', 'product_id', 'axis', 'detail']];
  for (const pl of plans) { if (!pl.page) continue; if (pl.candidates.length) for (const c of pl.candidates) rows.push([pl.page.url, pl.page.gate, pl.page.report_no, 'supplement', c.product_id, c.axis, JSON.stringify(c.data).slice(0, 200)]); else if (pl.newProduct) rows.push([pl.page.url, pl.page.gate, pl.page.report_no, 'web_label_new', '', '', JSON.stringify(pl.newProduct.product)]); else rows.push([pl.page.url, pl.page.gate, pl.page.report_no, 'record_only', '', '', pl.notes.join(';')]); }
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14); const outDir = path.dirname(path.resolve(IN));
  const csv = rows.map((r) => r.map((v) => { const s = String(v ?? '').replace(/\r?\n/g, ' '); return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n');
  const pf = path.join(outDir, `102_preview_${stamp}.csv`); fs.writeFileSync(pf, '﻿' + csv);
  const cnt = (a) => rows.filter((r) => r[3] === a).length;
  console.log(`미리보기 ${pf}\n  페이지 ${plans.filter((p) => p.page).length} · 보충 ${cnt('supplement')}(알레르기 ${rows.filter((r) => r[5] === 'allergens').length} · 영양 ${rows.filter((r) => r[5] === 'nutrition').length}) · web_label 신규 ${cnt('web_label_new')} · 기록만 ${cnt('record_only')}`);
  if (process.argv.includes('--apply')) {
    const batch = `weblabel_${stamp}`; const c = await pool.connect();
    try { await c.query('begin'); const rec = await applyPlans((s, p) => c.query(s, p), plans, batch); await c.query('commit');
      fs.writeFileSync(path.join(outDir, `102_batch_${batch}.json`), JSON.stringify({ ...rec, at: new Date().toISOString(), input: IN }, null, 1));
      console.log(`✅ 적용 ${batch} — 보충 ${rec.supplements.length} · web_label 신규 ${rec.web_label_products.length} · 페이지 ${rec.pages.length}`);
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  }
  await pool.end();
}

module.exports = { webFromText, planPage, applyPlans, undoBatch, sane, maker };
if (require.main === module) (process.argv.includes('--self-test') ? selfTest() : main()).catch((e) => { console.error('ERR', e.message); process.exit(1); });
