/**
 * 91-apply-c005-fill.js — 품목제조번호(c005) 묶음 안에서 빈 영양·원재료 채우기 (미리보기 → 적용 → 되돌리기)  세션75i 2026-10-05
 * ============================================================================
 * 제이 결정(10-05): «U1(이름·제조사·중량 모두 같음)만 Claude 가 직접 통합 · 나머지는 엑셀로 제이 판단».
 * 묶음 분류는 90-probe-c005-groups.js 의 classifyC005Group 을 그대로 쓴다(로직 한 벌).
 *
 * 7월 결정 그대로(자문/국내제품중복병합_자문회신_결정_2026-07-07.md · 영양커버리지확장_…_2026-07-08.md):
 *   · products / nutrition_data 행은 건드리지 않는다. 통합 = 엔티티 승인 멤버십(7월에 이미 승인됨 — 90 실측 U1 49/49).
 *   · 영양 = 그 엔티티에 per-100 «프로필» 1개를 승인 상태로 붙인다 → resolved 뷰가 자기 영양 없는 멤버에게 보여 줌(serving 상속 없음).
 *   · 원재료 = 공유 경로가 없으므로 product_ingredients 에 source='c005_sibling' 행을 «새로» 넣는다(기존 행 무접촉).
 *
 * 채우는 조건(하나라도 어긋나면 hold — 사유 기록):
 *   영양: 묶음 전원이 같은 승인 엔티티 · 엔티티에 묶음 밖 승인 멤버 없음 · 엔티티에 프로필 없음(어떤 상태든)
 *         · 기증자 = 자기 nutrition_data 가 있고 기준이 100g/100ml · 기증자 여럿이면 열량·나트륨·당류·포화지방 2% 안에서 같음
 *         · 100ml 기준인데 고체로 보이는 식품(장떡·어묵 등 — 75h 표본)은 hold
 *   원재료: 기증자 원재료가 분류명뿐이 아님(«캔디류» 등) · 기증자 출처가 이름매칭(c002_name)·제보(ocr_crowdsource)가 아님(75h 표본 #20)
 *
 * 실행 (제이 PC · meokseon-server 폴더):
 *   node scripts/91-apply-c005-fill.js --cls U1             미리보기(쓰기 없음 · 읽기 전용 연결) → .tmp/s75/91_preview_<cls>_<날짜>.csv
 *   node scripts/91-apply-c005-fill.js --cls U1 --apply     적용(트랜잭션 1개) → .tmp/s75/91_batch_<id>.json (넣은 행 id = 되돌리기 근거)
 *   node scripts/91-apply-c005-fill.js --undo <batch_id>    되돌리기(그 배치가 넣은 프로필·원재료 행만 삭제 + audit undone_at)
 *   node scripts/91-apply-c005-fill.js --self-test
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* */ }
const fs = require('fs');
const path = require('path');
const { classifyC005Group, ingredientIsCategoryOnly } = require('./90-probe-c005-groups');

const VERSION = 'c005_fill@1';
const NUT = ['calories','protein','total_fat','saturated_fat','trans_fat','cholesterol','sodium','total_carbs','total_sugars','dietary_fiber'];
const AXES = ['calories', 'sodium', 'total_sugars', 'saturated_fat'];
const ING_BAD_SOURCE = new Set(['c002_name', 'ocr_crowdsource']);
const SOLID_HINT = /떡|어묵|과자|스낵|칩|빵|케이크|쿠키|비스킷|김자반|김$|햄|소시지|육포|두부|묵|캔디|사탕|젤리|초콜릿|치즈|만두|면$|국수|라면|떡볶이|전$|부침|튀김/;
const isBlank = (v) => v == null || String(v).trim() === '';
function basisOf(ss) {
  const s = String(ss || '').replace(/\s/g, '').toLowerCase();
  if (/^100ml/.test(s)) return 'per_100ml';
  if (/^100g/.test(s)) return 'per_100g';
  return null;
}
function sameWithin(a, b, rel = 0.02) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const x = parseFloat(a), y = parseFloat(b); const m = Math.max(Math.abs(x), Math.abs(y));
  return m === 0 ? true : Math.abs(x - y) / m <= rel;
}
/**
 * 순수 판정 — 한 묶음.
 * g = { rn, members:[{product_id, product_name, food_type, is_bc, has_nut, nd:{serving_size,…}|null, ing:{raw_text,source}|null, ent:{entity_id, member_status}|null}],
 *       entitySize: Map(entity_id→승인 멤버 수), entityHasProfile: Set(entity_id) }
 * 반환 { nut:{action:'profile'|'hold'|'none', reason, entity_id, basis, values, donors, targets}, ing:{action, reason, donor, targets:[…]} }
 */
function planGroup(g) {
  const ms = g.members;
  const out = { nut: { action: 'none' }, ing: { action: 'none' } };
  // ── 영양 ──
  const nTargets = ms.filter((m) => m.is_bc && !m.has_nut);
  if (nTargets.length && ms.some((m) => m.has_nut)) {
    const donors = ms.filter((m) => m.nd && basisOf(m.nd.serving_size));
    const ents = new Set(ms.map((m) => (m.ent && m.ent.member_status === 'approved' ? String(m.ent.entity_id) : 'none')));
    const eid = ents.size === 1 && !ents.has('none') ? Number([...ents][0]) : null;
    const hold = (reason) => { out.nut = { action: 'hold', reason, targets: nTargets.map((m) => m.product_id) }; };
    if (!donors.length) hold('기증자 없음(자기 영양·100g/ml 기준 없음)');
    else if (eid == null) hold(ents.has('none') ? '승인 엔티티 밖 멤버 있음' : '엔티티 여럿으로 갈림');
    else if ((g.entitySize.get(eid) || 0) !== ms.length) hold('엔티티에 묶음 밖 승인 멤버 있음');
    else if (g.entityHasProfile.has(eid)) hold('엔티티에 이미 프로필 있음(후보·검토 포함)');
    else {
      const b = basisOf(donors[0].nd.serving_size);
      if (donors.some((d) => basisOf(d.nd.serving_size) !== b)) hold('기증자 기준(g/ml) 섞임');
      else if (donors.some((d) => AXES.some((k) => !sameWithin(d.nd[k], donors[0].nd[k])))) hold('기증자끼리 값 다름(2% 초과)');
      else if (b === 'per_100ml' && ms.some((m) => SOLID_HINT.test(String(m.product_name || '')) || SOLID_HINT.test(String(m.food_type || '')))) hold('100ml 기준인데 고체로 보임');
      else {
        const values = {}; for (const k of NUT) values[k] = donors[0].nd[k] == null ? null : parseFloat(donors[0].nd[k]);
        out.nut = { action: 'profile', entity_id: eid, basis: b, values, donors: donors.map((d) => d.product_id),
          method: donors.length === 1 ? 'single_source' : 'identical', targets: nTargets.map((m) => m.product_id) };
      }
    }
  }
  // ── 원재료 ──
  const iTargets = ms.filter((m) => m.is_bc && !m.ing);
  if (iTargets.length && ms.some((m) => m.ing)) {
    const PRI = { haccp_api: 0, c002_barcode: 1, c002: 2, web_pilot: 3 };
    const donors = ms.filter((m) => m.ing && !ingredientIsCategoryOnly(m.ing.raw_text) && !ING_BAD_SOURCE.has(m.ing.source))
      .sort((a, b) => (PRI[a.ing.source] ?? 9) - (PRI[b.ing.source] ?? 9));
    if (!donors.length) {
      const any = ms.some((m) => m.ing);
      out.ing = { action: 'hold', reason: any ? '기증자 원재료가 분류명뿐이거나 이름매칭·제보 출처' : '기증자 없음', targets: iTargets.map((m) => m.product_id) };
    } else {
      out.ing = { action: 'copy', donor: donors[0].product_id, raw_text: donors[0].ing.raw_text, donor_source: donors[0].ing.source, targets: iTargets.map((m) => m.product_id) };
    }
  }
  return out;
}

if (require.main === module && process.argv.includes('--self-test')) {
  let pass = 0, fail = 0; const eq = (a, b, m) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log('FAIL', m, JSON.stringify(a), JSON.stringify(b)); } };
  const E = (id) => ({ entity_id: id, member_status: 'approved' });
  const base = (extra = {}) => ({ rn: 'R', entitySize: new Map([[7, 2]]), entityHasProfile: new Set(), ...extra });
  const donor = { product_id: 1, product_name: '요구르트 280mL', is_bc: true, has_nut: true, nd: { serving_size: '100ml', calories: '70', sodium: '40', total_sugars: '10', saturated_fat: '1' }, ing: null, ent: E(7) };
  const tgt = { product_id: 2, product_name: '요구르트 280mL', is_bc: true, has_nut: false, nd: null, ing: null, ent: E(7) };
  let p = planGroup(base({ members: [donor, tgt] }));
  eq([p.nut.action, p.nut.entity_id, p.nut.basis, p.nut.method, p.nut.targets], ['profile', 7, 'per_100ml', 'single_source', [2]], 'n1 단일 기증자 → 프로필');
  eq(planGroup(base({ members: [donor, tgt], entitySize: new Map([[7, 3]]) })).nut.reason, '엔티티에 묶음 밖 승인 멤버 있음', 'n2 묶음 밖');
  eq(planGroup(base({ members: [donor, tgt], entityHasProfile: new Set([7]) })).nut.action, 'hold', 'n3 기존 프로필');
  eq(planGroup(base({ members: [donor, { ...tgt, ent: null }] })).nut.action, 'hold', 'n4 엔티티 밖');
  eq(planGroup(base({ members: [{ ...donor, product_name: '장떡' }, { ...tgt, product_name: '장떡' }] })).nut.reason, '100ml 기준인데 고체로 보임', 'n5 고체 100ml');
  eq(planGroup(base({ members: [{ ...donor, nd: { ...donor.nd, serving_size: '30' } }, tgt] })).nut.reason, '기증자 없음(자기 영양·100g/ml 기준 없음)', 'n6 1회분 기준');
  const d2 = { ...donor, product_id: 3, nd: { ...donor.nd, calories: '90' } };
  eq(planGroup(base({ members: [donor, d2, tgt], entitySize: new Map([[7, 3]]) })).nut.reason, '기증자끼리 값 다름(2% 초과)', 'n7 충돌');
  const i1 = { product_id: 4, product_name: '치즈', is_bc: true, has_nut: true, nd: null, ing: { raw_text: '원유, 정제소금', source: 'haccp_api' }, ent: E(7) };
  const i2 = { product_id: 5, product_name: '치즈', is_bc: true, has_nut: true, nd: null, ing: null, ent: E(7) };
  p = planGroup(base({ members: [i1, i2] }));
  eq([p.ing.action, p.ing.donor, p.ing.targets], ['copy', 4, [5]], 'i1 원재료 복사');
  eq(planGroup(base({ members: [{ ...i1, ing: { raw_text: '캔디류', source: 'c002_barcode' } }, i2] })).ing.action, 'hold', 'i2 분류명뿐');
  eq(planGroup(base({ members: [{ ...i1, ing: { raw_text: '가공소금, 들기름', source: 'c002_name' } }, i2] })).ing.action, 'hold', 'i3 이름매칭 출처');
  eq(planGroup(base({ members: [i1, { ...i2, is_bc: false }] })).ing.action, 'none', 'i4 비바코드는 대상 아님');
  console.log(`[self-test] 통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
}

const { Pool } = require('pg');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const UNDO = arg('--undo');
const CLS = new Set(String(arg('--cls') || 'U1').split(','));
const ACTOR = arg('--actor') || '김재환';
const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } }
  : { host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'meokseon', user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || '' };
Object.assign(poolConfig, { connectionTimeoutMillis: 25000, statement_timeout: 300000, keepAlive: true });
if (!APPLY && !UNDO) poolConfig.options = '-c default_transaction_read_only=on';
const DIR = path.resolve(__dirname, '../../.tmp/s75');
const CHUNK = 5000;
const csvCell = (v) => { const s = v == null ? '' : String(v).replace(/\r?\n/g, ' '); return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function load(pool) {
  const chunked = async (ids, sql) => { const o = []; for (let i = 0; i < ids.length; i += CHUNK) o.push(...(await pool.query(sql, [ids.slice(i, i + CHUNK)])).rows); return o; };
  const prods = (await pool.query(`
    SELECT product_id, barcode, product_name, brand, manufacturer, food_type, total_content, content_unit,
           btrim(c005_report_no) AS rn, (barcode ~ '^[0-9]{8,14}$') AS is_bc
    FROM products WHERE is_active AND btrim(COALESCE(c005_report_no,'')) <> ''`)).rows;
  const byRn = new Map(); for (const p of prods) { if (!byRn.has(p.rn)) byRn.set(p.rn, []); byRn.get(p.rn).push(p); }
  const groups = [];
  for (const [rn, ms] of byRn) { if (ms.length < 2) continue; const c = classifyC005Group(ms); if (CLS.has(c.cls)) groups.push({ rn, cls: c.cls, ms }); }
  const ids = groups.flatMap((g) => g.ms.map((m) => Number(m.product_id)));
  const has = new Set((await chunked(ids, `SELECT product_id FROM product_nutrition_resolved WHERE product_id = ANY($1::bigint[]) AND (${NUT.map((k) => k + ' IS NOT NULL').join(' OR ')})`)).map((r) => Number(r.product_id)));
  const nd = new Map((await chunked(ids, `SELECT product_id, serving_size, ${NUT.join(', ')} FROM nutrition_data WHERE product_id = ANY($1::bigint[]) AND (${NUT.map((k) => k + ' IS NOT NULL').join(' OR ')})`)).map((r) => [Number(r.product_id), r]));
  const ing = new Map((await chunked(ids, `SELECT DISTINCT ON (product_id) product_id, raw_text, source FROM product_ingredients WHERE product_id = ANY($1::bigint[]) AND raw_text IS NOT NULL AND btrim(raw_text) <> '' ORDER BY product_id, id`)).map((r) => [Number(r.product_id), r]));
  const entRows = await chunked(ids, `SELECT product_id, entity_id, status AS member_status FROM product_entity_members WHERE product_id = ANY($1::bigint[]) AND status = 'approved'`);
  const ent = new Map(entRows.map((r) => [Number(r.product_id), r]));
  const eids = [...new Set(entRows.map((r) => Number(r.entity_id)))];
  const entitySize = new Map((await chunked(eids, `SELECT entity_id, count(*)::int AS n FROM product_entity_members WHERE status = 'approved' AND entity_id = ANY($1::bigint[]) GROUP BY entity_id`)).map((r) => [Number(r.entity_id), r.n]));
  const entityHasProfile = new Set((await chunked(eids, `SELECT DISTINCT entity_id FROM entity_nutrition_profiles WHERE entity_id = ANY($1::bigint[]) AND status <> 'rejected'`)).map((r) => Number(r.entity_id)));
  return groups.map((g) => ({ rn: g.rn, cls: g.cls, entitySize, entityHasProfile,
    members: g.ms.map((m) => { const id = Number(m.product_id); return { product_id: id, barcode: m.barcode, product_name: m.product_name, food_type: m.food_type, is_bc: m.is_bc,
      has_nut: has.has(id), nd: nd.get(id) || null, ing: ing.get(id) || null, ent: ent.get(id) || null }; }) }));
}

async function main() {
  const pool = new Pool(poolConfig);
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (UNDO) return await undo(pool, UNDO);
    if (!APPLY) {
      const ro = (await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only;
      if (ro !== 'on') throw new Error(`미리보기인데 읽기 전용 아님(SHOW=${ro}) — 중단`);
    }
    console.log(`[${APPLY ? '적용' : '미리보기 · 읽기 전용'}] 대상 분류 ${[...CLS].join(',')}`);
    const groups = await load(pool);
    const rows = []; const tally = {};
    const bump = (k, n = 1) => { tally[k] = (tally[k] || 0) + n; };
    const plans = groups.map((g) => ({ g, p: planGroup(g) }));
    for (const { g, p } of plans) {
      for (const ax of ['nut', 'ing']) {
        const a = p[ax]; if (a.action === 'none') continue;
        bump(`${ax === 'nut' ? '영양' : '원재료'}|${a.action}${a.reason ? '|' + a.reason : ''}`, a.targets.length);
        for (const t of a.targets) {
          const m = g.members.find((x) => x.product_id === t);
          rows.push({ cls: g.cls, rn: g.rn, axis: ax === 'nut' ? '영양' : '원재료', action: a.action, reason: a.reason || '', target_id: t, barcode: m.barcode, product_name: m.product_name,
            donor: ax === 'nut' ? (a.donors || []).join(' ') : (a.donor || ''), detail: ax === 'nut' ? (a.basis ? `${a.basis} 열량 ${a.values.calories} 나트륨 ${a.values.sodium}` : '') : String(a.raw_text || '').slice(0, 100), entity_id: a.entity_id || '' });
        }
      }
    }
    console.log(`묶음 ${groups.length.toLocaleString()}`);
    for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(46)} ${v.toLocaleString()} 바코드`);
    const d = new Date().toISOString().slice(0, 10);
    const f = path.join(DIR, `91_preview_${[...CLS].join('-')}_${d}.csv`);
    const cols = Object.keys(rows[0] || { cls: '' });
    fs.writeFileSync(f, '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n'));
    console.log(`미리보기 파일: ${f}`);
    if (!APPLY) { console.log('※ 쓰기 없음. 적용하려면 같은 명령 끝에 --apply'); return; }

    const batch = `c005fill_${[...CLS].join('-')}_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    const rec = { batch, version: VERSION, cls: [...CLS], actor: ACTOR, at: new Date().toISOString(), profiles: [], ingredients: [], audits: [] };
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const { g, p } of plans) {
        if (p.nut.action === 'profile') {
          const v = p.nut.values;
          const r = await c.query(`INSERT INTO entity_nutrition_profiles (entity_id, basis, ${NUT.join(', ')}, source_product_ids, method, conflict_status, serving_inheritance_allowed, status, profiler_version)
            VALUES ($1, $2, ${NUT.map((_, i) => '$' + (i + 3)).join(', ')}, $13::bigint[], $14, 'none', FALSE, 'approved', $15) RETURNING profile_id`,
            [p.nut.entity_id, p.nut.basis, ...NUT.map((k) => v[k]), p.nut.donors, p.nut.method, VERSION]);
          rec.profiles.push(Number(r.rows[0].profile_id));
          const a = await c.query(`INSERT INTO product_entity_audit (entity_id, product_id, action, after_json, classifier_version, eval_version, actor)
            VALUES ($1, NULL, 'c005_fill_profile', $2, $3, $4, $5) RETURNING audit_id`,
            [p.nut.entity_id, JSON.stringify({ profile_id: r.rows[0].profile_id, rn: g.rn, cls: g.cls, donors: p.nut.donors, targets: p.nut.targets, basis: p.nut.basis }), VERSION, batch, ACTOR]);
          rec.audits.push(Number(a.rows[0].audit_id));
        }
        if (p.ing.action === 'copy') {
          for (const t of p.ing.targets) {
            const r = await c.query(`INSERT INTO product_ingredients (product_id, raw_text, prdlst_report_no, source) VALUES ($1, $2, $3, 'c005_sibling') RETURNING id`, [t, p.ing.raw_text, g.rn]);
            rec.ingredients.push(Number(r.rows[0].id));
            const a = await c.query(`INSERT INTO product_entity_audit (entity_id, product_id, action, after_json, classifier_version, eval_version, actor)
              VALUES (NULL, $1, 'c005_fill_ingredient', $2, $3, $4, $5) RETURNING audit_id`,
              [t, JSON.stringify({ ingredient_id: r.rows[0].id, rn: g.rn, cls: g.cls, donor: p.ing.donor, donor_source: p.ing.donor_source }), VERSION, batch, ACTOR]);
            rec.audits.push(Number(a.rows[0].audit_id));
          }
        }
      }
      // 기록 파일을 먼저 쓴 뒤 COMMIT — 커밋됐는데 되돌리기 근거가 없는 상태를 만들지 않는다
      const bf = path.join(DIR, `91_batch_${batch}.json`);
      fs.writeFileSync(bf, JSON.stringify(rec, null, 1));
      await c.query('COMMIT');
      console.log(`\n✅ 적용 완료 — 배치 ${batch} · 프로필 ${rec.profiles.length} · 원재료 행 ${rec.ingredients.length}`);
      console.log(`기록: ${bf}`);
      console.log(`되돌리기: node scripts/91-apply-c005-fill.js --undo ${batch}`);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  } finally { await pool.end(); }
}

async function undo(pool, batch) {
  const bf = path.join(DIR, `91_batch_${batch}.json`);
  if (!fs.existsSync(bf)) throw new Error(`배치 기록 없음: ${bf}`);
  const rec = JSON.parse(fs.readFileSync(bf, 'utf8'));
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // 이 배치가 넣은 행만 — profiler_version·source 로 한 번 더 확인
    const p = await c.query(`DELETE FROM entity_nutrition_profiles WHERE profile_id = ANY($1::bigint[]) AND profiler_version = $2`, [rec.profiles, VERSION]);
    const i = await c.query(`DELETE FROM product_ingredients WHERE id = ANY($1::bigint[]) AND source = 'c005_sibling'`, [rec.ingredients]);
    await c.query(`UPDATE product_entity_audit SET undone_at = now() WHERE audit_id = ANY($1::bigint[])`, [rec.audits]);
    if (p.rowCount !== rec.profiles.length || i.rowCount !== rec.ingredients.length) throw new Error(`기록과 수가 다름(프로필 ${p.rowCount}/${rec.profiles.length} · 원재료 ${i.rowCount}/${rec.ingredients.length}) — 되돌리기 중단`);
    await c.query('COMMIT');
    console.log(`✅ 되돌리기 완료 — ${batch} · 프로필 ${p.rowCount} · 원재료 행 ${i.rowCount} 삭제`);
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

module.exports = { planGroup, basisOf, sameWithin };
if (require.main === module) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
