#!/usr/bin/env node
/**
 * 104-web-label-gate.js — web_label 노출 품질 게이트 적용(세션79). 판정 규칙 = scripts/lib/web_label_gate.js(정답 eval_web_label_gate_v1 37/37).
 *   대상 ① web_label.products(status·nutrition_ok·food_type 정리·quality) ② web_label.public_supplements(status·quality)
 *   ⚠ 사람이 정한 상태(rejected · withdrawn · superseded)는 건드리지 않는다. needs_review·active·stale 만 다시 판정.
 *   알레르기 교차확인의 «원재료»: ① 신규 품목 = web_label.product_ingredients ② 보충 = public 제품의 product_ingredients.
 * 사용(meokseon-server): node scripts/104-web-label-gate.js            미리보기(상태 분포)
 *                        node scripts/104-web-label-gate.js --apply    적용(한 트랜잭션 · 바뀐 행만 · 기록 JSON)
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch (_) { /* */ }
const fs = require('fs'); const path = require('path');
const G = require('./lib/web_label_gate');
const { allergensFromIngredients } = require('../src/services/allergenFromIngredients');
const KEEP = new Set(['rejected', 'withdrawn', 'superseded']);
const inferOf = (raw) => (raw ? allergensFromIngredients(raw).names : null);

function judgeProduct(p) {
  const label = (p.alg || []).filter((a) => a.l === 'contains').map((a) => a.a);
  const n = p.nut || null; const nut449 = G.nutritionOk(n);
  // ★ 세션80 v1.1(R10) — 같은 품목보고번호 K-FIND 와 교차확인. conflict 면 4·4·9 를 통과해도 신호등 끔. kfind 표가 없으면(kf undefined) 종전과 같다.
  const kf = G.kfindCheck(n, p.kf || []);
  const nutOk = nut449 === true && kf && kf.result === 'conflict' ? false : nut449;
  const alg = G.allergenCheck(label, inferOf(p.ing));
  const status = G.productStatus({ allergen: alg, has_alg: label.length > 0, has_nut: !!(n && n.calories != null) });
  const ft = G.cleanFoodType(p.food_type);
  return { status, nutrition_ok: nutOk, food_type: ft, quality: { allergen: alg, nutrition_ok: nutOk, nutrition_449: nut449, kfind: kf, label, inferred: inferOf(p.ing), gate: 'web_label_gate_v1.1' } };
}
function judgeSupplement(s) {
  if (s.axis === 'allergens') { const lab = (s.data && s.data.contains) || []; const a = G.allergenCheck(lab, inferOf(s.ing)); return { status: a === 'ok' ? 'active' : 'needs_review', quality: { allergen: a, inferred: inferOf(s.ing), gate: 'web_label_gate_v1' } }; }
  const ok = G.nutritionOk(s.data); return { status: ok ? 'active' : 'needs_review', quality: { nutrition_ok: ok, gate: 'web_label_gate_v1' } };
}

async function main() {
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect(); const APPLY = process.argv.includes('--apply');
  try {
    const P = (await c.query(`select p.product_id, p.status, p.food_type, p.nutrition_ok,
        (select json_agg(json_build_object('a',allergen_name,'l',evidence_level)) from web_label.product_allergens a where a.product_id=p.product_id) alg,
        (select row_to_json(n) from web_label.nutrition_data n where n.product_id=p.product_id limit 1) nut,
        (select raw_text from web_label.product_ingredients i where i.product_id=p.product_id order by id limit 1) ing,
        (select json_agg(json_build_object('food_cd',k.food_cd,'calories',k.calories,'sodium',k.sodium,'total_sugars',k.total_sugars,'total_fat',k.total_fat))
           from kfind.products k where k.report_no=p.c005_report_no and k.status='active') kf
      from web_label.products p`)).rows;
    const Sx = (await c.query(`select s.supplement_id, s.product_id, s.axis, s.data, s.status, s.reviewed_by,
        (select raw_text from public.product_ingredients i where i.product_id=s.product_id order by id limit 1) ing
      from web_label.public_supplements s`)).rows;
    const chP = [], chS = [];
    for (const p of P) { if (KEEP.has(p.status)) continue; const j = judgeProduct(p); if (j.status !== p.status || j.nutrition_ok !== p.nutrition_ok || j.food_type !== p.food_type) chP.push({ id: p.product_id, from: p.status, ...j, food_type_before: p.food_type }); else chP.push({ id: p.product_id, same: true, ...j }); }
    for (const s of Sx) { if (KEEP.has(s.status) || s.reviewed_by) continue;   /* 세션79 — 사람이 정정·확정한 보충(reviewed_by)은 다시 판정하지 않는다(제이 F 정정이 게이트에 되돌려지는 것 방지) */ const j = judgeSupplement(s); chS.push({ id: s.supplement_id, from: s.status, ...j }); }
    const dist = (a) => a.reduce((m, x) => { m[x.status] = (m[x.status] || 0) + 1; return m; }, {});
    const kfd = chP.reduce((m, x) => { const r = x.quality.kfind ? x.quality.kfind.result : 'none'; m[r] = (m[r] || 0) + 1; return m; }, {});
    console.log('K-FIND 교차확인(v1.1)', JSON.stringify(kfd), '| 그 때문에 신호등 끔', chP.filter((x) => x.quality.kfind && x.quality.kfind.result === 'conflict' && x.quality.nutrition_449 === true).length);
    console.log('품목', P.length, '판정', dist(chP), '| 신호등 끔(nutrition_ok=false)', chP.filter((x) => x.nutrition_ok === false).length, '| 식품유형 정리', chP.filter((x) => !x.same && x.food_type_before !== x.food_type).length);
    console.log('보충', Sx.length, '(사람 판정 유지', Sx.filter((s) => KEEP.has(s.status) || s.reviewed_by).length + ')', '판정', dist(chS), '축별', JSON.stringify(chS.reduce((m, x) => { const s = Sx.find((y) => y.supplement_id === x.id); const k = s.axis + ':' + x.status; m[k] = (m[k] || 0) + 1; return m; }, {})));
    if (!APPLY) return;
    await c.query('BEGIN');
    // ★ 문장 2개(원격 RTT ~0.3초 · 행마다 보내면 수백 초 → 시간 초과 롤백 실측)
    await c.query(`update web_label.products t set status=u.st, nutrition_ok=u.nok, food_type=u.ft, quality=u.q::jsonb, updated_at=now()
      from unnest($1::bigint[], $2::text[], $3::boolean[], $4::text[], $5::text[]) u(id, st, nok, ft, q) where t.product_id=u.id`,
      [chP.map((x) => x.id), chP.map((x) => x.status), chP.map((x) => x.nutrition_ok), chP.map((x) => x.food_type), chP.map((x) => JSON.stringify(x.quality))]);
    await c.query(`update web_label.public_supplements t set status=u.st, quality=coalesce(t.quality,'{}'::jsonb) || u.q::jsonb, updated_at=now()
      from unnest($1::bigint[], $2::text[], $3::text[]) u(id, st, q) where t.supplement_id=u.id`,
      [chS.map((x) => x.id), chS.map((x) => x.status), chS.map((x) => JSON.stringify(x.quality))]);
    await c.query('COMMIT');
    const f = path.join(__dirname, '..', '..', 'IP', 'eval_web_label_gate_v1', `gate_apply_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}.json`);
    fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), products: chP, supplements: chS }, null, 1)); console.log('✅ 적용 →', f);
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); await pool.end(); }
}
if (require.main === module) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
module.exports = { judgeProduct, judgeSupplement };
