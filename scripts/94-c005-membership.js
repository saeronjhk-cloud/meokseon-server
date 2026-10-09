/**
 * 94-c005-membership.js — c005(품목제조번호) U2 묶음의 엔티티 승인 멤버십 보강 (미리보기 → 적용 → 되돌리기)  세션76 2026-10-09
 * ============================================================================
 * 왜: 91(형제 영양 채움)이 «승인 엔티티 밖 멤버 있음»으로 227 바코드를 보류했다(186 §6 U75-4).
 *     7월 이름 엔티티(search_text 키)에 묶음 일부만 승인돼 있거나, 아예 엔티티가 없는 c005 묶음이다.
 * 근거: 7월 자문 결정 (i) «강조건(c005 정확일치)은 사람 1클릭 대량 승인»(scripts/staging/domestic/approve_auto_entities.js 선례)
 *       + 75i 제이 결정 «U2 적용 진행»(영양 일치 96.7% · 원재료 독립 HACCP 94.5%).
 *
 * 판정(묶음 단위 · 하나라도 어긋나면 skip — 사유 기록):
 *   · 91 planGroup 의 영양 보류 사유가 정확히 «승인 엔티티 밖 멤버 있음» 인 묶음만
 *   · 사람이 내린 결정 존중: 묶음 멤버 중 어떤 엔티티에서든 rejected/split/undone 행이 있으면 skip
 *   · 묶음 안 승인 엔티티 1개(E):
 *       E 의 승인 멤버가 전부 묶음 안 · E 에 프로필(거절 제외) 없음 → 빠진 멤버를 E 에 approved
 *       (E 에 candidate 행이 있으면 UPDATE, 없으면 INSERT)
 *   · 승인 엔티티 0개: 엔티티 F 하나에 묶음 전원이 행을 갖고 F 의 (거절 아닌) 멤버가 전부 묶음 안 → F 에서 전원 approved
 *       아니면 새 엔티티 entity_key='c005:<품목제조번호>' (route AUTO_APPROVE_ENTITY · relation_type same_sku) 에 전원 approved
 *       (같은 entity_key 가 이미 있으면 skip — 멱등)
 *   · 승인 엔티티 2개 이상 → skip
 * 쓰지 않는 것: products · nutrition_data · 프로필(프로필은 91 이 새 배치로 붙인다) · contributions
 *
 * 실행 (제이 PC · meokseon-server 폴더):
 *   node scripts/94-c005-membership.js --cls U2            미리보기(읽기 전용) → .tmp/s76/94_preview_U2_<날짜>.csv
 *   node scripts/94-c005-membership.js --cls U2 --apply    적용(트랜잭션 1개) → .tmp/s76/94_batch_<id>.json
 *   node scripts/94-c005-membership.js --self-test
 *   (비상용 되돌리기 --undo <batch_id> — 91 의 같은 묶음 배치를 먼저 되돌린 뒤에만)
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* */ }
const fs = require('fs');
const path = require('path');

const VERSION = 'c005_member@1';
const HOLD_REASON = '승인 엔티티 밖 멤버 있음';
const HUMAN_BLOCK = new Set(['rejected', 'split', 'undone']); // undone = 누군가 승인을 되돌린 흔적 → 다시 승인하지 않는다

/**
 * 순수 함수. g = { rn, cls, members:[{product_id, product_name}] , nutReason }
 * ctx = { rows: Map(product_id → [{member_id, entity_id, status}]), approvedOf: Map(entity_id → product_id[]),
 *         nonRejectedOf: Map(entity_id → product_id[]), hasProfile: Set(entity_id), keyExists: Set(entity_key) }
 * 반환 { action:'extend'|'reuse'|'create'|'skip', reason, entity_id, entity_key, ops:[{op:'insert'|'update', product_id, member_id?, prev_status?}] }
 */
function planMembership(g, ctx) {
  const skip = (reason) => ({ action: 'skip', reason, ops: [] });
  if (g.nutReason !== HOLD_REASON) return skip(`대상 아님(${g.nutReason || '영양 보류 아님'})`);
  const ids = g.members.map((m) => Number(m.product_id));
  const inGroup = new Set(ids);
  const rowsOf = (pid) => ctx.rows.get(pid) || [];
  if (ids.some((pid) => rowsOf(pid).some((r) => HUMAN_BLOCK.has(r.status)))) return skip('사람이 거절·분리·되돌린 멤버 행 있음');
  const approvedE = new Set();
  for (const pid of ids) for (const r of rowsOf(pid)) if (r.status === 'approved') approvedE.add(Number(r.entity_id));
  if (approvedE.size > 1) return skip('엔티티 여럿으로 갈림');
  const opsFor = (eid, pids) => pids.map((pid) => {
    const r = rowsOf(pid).find((x) => Number(x.entity_id) === eid);
    return r ? { op: 'update', product_id: pid, member_id: Number(r.member_id), prev_status: r.status } : { op: 'insert', product_id: pid };
  });
  if (approvedE.size === 1) {
    const eid = [...approvedE][0];
    if ((ctx.approvedOf.get(eid) || []).some((pid) => !inGroup.has(Number(pid)))) return skip('엔티티에 묶음 밖 승인 멤버 있음');
    if (ctx.hasProfile.has(eid)) return skip('엔티티에 이미 프로필 있음');
    const missing = ids.filter((pid) => !rowsOf(pid).some((r) => r.status === 'approved'));
    if (!missing.length) return skip('빠진 멤버 없음');
    return { action: 'extend', entity_id: eid, ops: opsFor(eid, missing) };
  }
  // 승인 엔티티 0개 — 묶음 전원이 행을 가진 엔티티 F 가 있고 F 의 거절 아닌 멤버가 전부 묶음 안이면 재사용
  const common = ids.map((pid) => new Set(rowsOf(pid).map((r) => Number(r.entity_id))))
    .reduce((a, s) => new Set([...a].filter((x) => s.has(x))));
  const reusable = [...common].filter((eid) => !ctx.hasProfile.has(eid)
    && (ctx.nonRejectedOf.get(eid) || []).every((pid) => inGroup.has(Number(pid)))).sort((a, b) => a - b);
  if (reusable.length) return { action: 'reuse', entity_id: reusable[0], ops: opsFor(reusable[0], ids) };
  const key = `c005:${g.rn}`;
  if (ctx.keyExists.has(key)) return skip('c005 엔티티 이미 있음(멱등)');
  return { action: 'create', entity_key: key, ops: ids.map((pid) => ({ op: 'insert', product_id: pid })) };
}

/** 적용 — client.query(sql, params) → {rows, rowCount}. rec 에 넣은 행 id·이전 상태를 쌓는다. */
async function applyPlans(c, plans, rec, actor) {
  for (const { g, p } of plans) {
    if (p.action === 'skip') continue;
    let eid = p.entity_id;
    if (p.action === 'create') {
      const first = g.members[0];
      const r = await c.query(`INSERT INTO product_entities (entity_key, canonical_name, canonical_product_id, member_count, route, relation_type, status, classifier_version, eval_version)
        VALUES ($1, $2, $3, $4, 'AUTO_APPROVE_ENTITY', 'same_sku', 'active', $5, $6) RETURNING entity_id`,
        [p.entity_key, String(first.product_name || p.entity_key).slice(0, 200), Number(first.product_id), g.members.length, VERSION, rec.batch]);
      eid = Number(r.rows[0].entity_id);
      rec.entities.push(eid);
    }
    const ev = JSON.stringify({ rule: 'c005_' + g.cls, rn: g.rn, action: p.action });
    for (const o of p.ops) {
      if (o.op === 'insert') {
        const r = await c.query(`INSERT INTO product_entity_members (entity_id, product_id, status, evidence_json, batch_id, classifier_version, reviewed_by, reviewed_at)
          VALUES ($1, $2, 'approved', $3, $4, $5, $6, now()) RETURNING member_id`, [eid, o.product_id, ev, rec.batch, VERSION, actor]);
        rec.inserted.push(Number(r.rows[0].member_id));
      } else {
        const r = await c.query(`UPDATE product_entity_members SET status = 'approved', reviewed_by = $2, reviewed_at = now()
          WHERE member_id = $1 AND status = $3 RETURNING member_id`, [o.member_id, actor, o.prev_status]);
        if (r.rows.length !== 1) throw new Error(`멤버 상태가 미리보기 뒤 바뀜(member_id ${o.member_id}) — 전체 롤백`);
        rec.updated.push({ member_id: o.member_id, prev_status: o.prev_status });
      }
    }
    const a = await c.query(`INSERT INTO product_entity_audit (entity_id, product_id, action, after_json, classifier_version, eval_version, actor)
      VALUES ($1, NULL, 'c005_member_approve', $2, $3, $4, $5) RETURNING audit_id`,
      [eid, JSON.stringify({ rn: g.rn, cls: g.cls, action: p.action, products: p.ops.map((o) => o.product_id) }), VERSION, rec.batch, actor]);
    rec.audits.push(Number(a.rows[0].audit_id));
  }
}

/** 되돌리기 — 그 배치가 바꾼 것만. 91 프로필이 붙은 엔티티는 지우지 않고 중단(91 을 먼저 되돌릴 것). */
async function undoBatch(c, rec) {
  if (rec.entities.length) {
    const p = await c.query(`SELECT count(*)::int AS n FROM entity_nutrition_profiles WHERE entity_id = ANY($1::bigint[])`, [rec.entities]);
    if (p.rows[0].n) throw new Error(`이 배치가 만든 엔티티에 프로필 ${p.rows[0].n}개 — 91 배치를 먼저 되돌릴 것`);
  }
  const d = await c.query(`DELETE FROM product_entity_members WHERE member_id = ANY($1::bigint[]) AND batch_id = $2 RETURNING member_id`, [rec.inserted, rec.batch]);
  let u = 0;
  for (const x of rec.updated) {
    const r = await c.query(`UPDATE product_entity_members SET status = $2, reviewed_by = NULL, reviewed_at = NULL WHERE member_id = $1 AND status = 'approved' RETURNING member_id`, [x.member_id, x.prev_status]);
    u += r.rows.length;
  }
  const e = await c.query(`DELETE FROM product_entities WHERE entity_id = ANY($1::bigint[]) AND classifier_version = $2
    AND NOT EXISTS (SELECT 1 FROM product_entity_members m WHERE m.entity_id = product_entities.entity_id) RETURNING entity_id`, [rec.entities, VERSION]);
  await c.query(`UPDATE product_entity_audit SET undone_at = now() WHERE audit_id = ANY($1::bigint[])`, [rec.audits]);
  if (d.rows.length !== rec.inserted.length || u !== rec.updated.length || e.rows.length !== rec.entities.length) {
    throw new Error(`기록과 수가 다름(삽입 ${d.rows.length}/${rec.inserted.length} · 갱신 ${u}/${rec.updated.length} · 엔티티 ${e.rows.length}/${rec.entities.length}) — 되돌리기 중단`);
  }
  return { deleted: d.rows.length, reverted: u, entities: e.rows.length };
}

if (require.main === module && process.argv.includes('--self-test')) {
  let ok = 0, bad = 0;
  const eq = (a, b, n) => { const s = JSON.stringify(a) === JSON.stringify(b); s ? ok++ : bad++; console.log(`  ${s ? '✅' : '❌'} ${n}${s ? '' : `\n     기대 ${JSON.stringify(b)}\n     실제 ${JSON.stringify(a)}`}`); };
  const G = (ids, extra = {}) => ({ rn: 'R1', cls: 'U2', nutReason: HOLD_REASON, members: ids.map((id) => ({ product_id: id, product_name: 'p' + id })), ...extra });
  const C = (rows, extra = {}) => ({ rows: new Map(Object.entries(rows).map(([k, v]) => [Number(k), v])), approvedOf: new Map(), nonRejectedOf: new Map(), hasProfile: new Set(), keyExists: new Set(), ...extra });
  const R = (mid, eid, status) => ({ member_id: mid, entity_id: eid, status });
  // m1 확장: 1 승인(E7), 2 행 없음 → insert
  let p = planMembership(G([1, 2]), C({ 1: [R(11, 7, 'approved')] }, { approvedOf: new Map([[7, [1]]]) }));
  eq([p.action, p.entity_id, p.ops], ['extend', 7, [{ op: 'insert', product_id: 2 }]], 'm1 승인 엔티티 확장 · 행 없음 → insert');
  // m2 확장: 2 가 E7 candidate → update
  p = planMembership(G([1, 2]), C({ 1: [R(11, 7, 'approved')], 2: [R(12, 7, 'candidate')] }, { approvedOf: new Map([[7, [1]]]) }));
  eq(p.ops, [{ op: 'update', product_id: 2, member_id: 12, prev_status: 'candidate' }], 'm2 candidate → update');
  // m3 묶음 밖 승인 멤버
  eq(planMembership(G([1, 2]), C({ 1: [R(11, 7, 'approved')] }, { approvedOf: new Map([[7, [1, 99]]]) })).reason, '엔티티에 묶음 밖 승인 멤버 있음', 'm3 묶음 밖');
  // m4 프로필 있음
  eq(planMembership(G([1, 2]), C({ 1: [R(11, 7, 'approved')] }, { approvedOf: new Map([[7, [1]]]), hasProfile: new Set([7]) })).reason, '엔티티에 이미 프로필 있음', 'm4 프로필');
  // m5 사람이 거절
  eq(planMembership(G([1, 2]), C({ 1: [R(11, 7, 'approved')], 2: [R(12, 7, 'rejected')] }, { approvedOf: new Map([[7, [1]]]) })).reason, '사람이 거절·분리·되돌린 멤버 행 있음', 'm5 거절 존중');
  // m6 엔티티 둘
  eq(planMembership(G([1, 2]), C({ 1: [R(11, 7, 'approved')], 2: [R(12, 8, 'approved')] })).reason, '엔티티 여럿으로 갈림', 'm6 갈림');
  // m7 재사용: 둘 다 F9 candidate, F9 멤버 전부 묶음 안
  p = planMembership(G([1, 2]), C({ 1: [R(11, 9, 'candidate')], 2: [R(12, 9, 'candidate')] }, { nonRejectedOf: new Map([[9, [1, 2]]]) }));
  eq([p.action, p.entity_id, p.ops.map((o) => o.op)], ['reuse', 9, ['update', 'update']], 'm7 공통 후보 엔티티 재사용');
  // m8 재사용 불가(F9 에 묶음 밖 후보) → 새 엔티티
  p = planMembership(G([1, 2]), C({ 1: [R(11, 9, 'candidate')], 2: [R(12, 9, 'candidate')] }, { nonRejectedOf: new Map([[9, [1, 2, 50]]]) }));
  eq([p.action, p.entity_key, p.ops.length], ['create', 'c005:R1', 2], 'm8 새 c005 엔티티');
  // m9 멱등
  eq(planMembership(G([1, 2]), C({}, { keyExists: new Set(['c005:R1']) })).reason, 'c005 엔티티 이미 있음(멱등)', 'm9 멱등');
  // m10 다른 보류 사유는 대상 아님
  eq(planMembership(G([1, 2], { nutReason: '기증자 없음(자기 영양·100g/ml 기준 없음)' }), C({})).action, 'skip', 'm10 대상 아님');
  console.log(`\nself-test: ${ok} 통과 · ${bad} 실패`);
  process.exit(bad ? 1 : 0);
}

module.exports = { planMembership, applyPlans, undoBatch, VERSION, HOLD_REASON };

async function main() {
  const { Pool } = require('pg');
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const APPLY = process.argv.includes('--apply');
  const UNDO = arg('--undo');
  const CLS = String(arg('--cls') || 'U2');
  const ACTOR = arg('--actor') || '김재환';
  const DIR = path.resolve(__dirname, '../../.tmp/s76');
  fs.mkdirSync(DIR, { recursive: true });
  const poolConfig = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } }
    : { host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'meokseon', user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || '' };
  Object.assign(poolConfig, { connectionTimeoutMillis: 25000, statement_timeout: 300000, keepAlive: true });
  if (!APPLY && !UNDO) poolConfig.options = '-c default_transaction_read_only=on';
  const pool = new Pool(poolConfig);
  try {
    if (UNDO) {
      const bf = path.join(DIR, `94_batch_${UNDO}.json`);
      if (!fs.existsSync(bf)) throw new Error(`배치 기록 없음: ${bf}`);
      const rec = JSON.parse(fs.readFileSync(bf, 'utf8'));
      const c = await pool.connect();
      try { await c.query('BEGIN'); const r = await undoBatch(c, rec); await c.query('COMMIT'); console.log(`✅ 되돌리기 완료 — ${UNDO}`, r); }
      catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
      return;
    }
    if (!APPLY) {
      const ro = (await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only;
      if (ro !== 'on') throw new Error(`미리보기인데 읽기 전용 아님(SHOW=${ro}) — 중단`);
    }
    console.log(`[${APPLY ? '적용' : '미리보기 · 읽기 전용'}] 대상 분류 ${CLS}`);
    // 91 과 같은 로더·판정(로직 한 벌) — 91 은 --cls 를 process.argv 에서 읽는다
    const { load, planGroup } = require('./91-apply-c005-fill');
    const t0 = Date.now();
    const groups = (await load(pool)).filter((g) => g.cls === CLS);
    const held = groups.map((g) => ({ g, nutReason: planGroup(g).nut.reason })).filter((x) => x.nutReason === HOLD_REASON);
    console.log(`묶음 ${groups.length.toLocaleString()} · 대상(${HOLD_REASON}) ${held.length.toLocaleString()} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const ids = held.flatMap((x) => x.g.members.map((m) => Number(m.product_id)));
    const q = async (sql, arr) => (arr.length ? (await pool.query(sql, [arr])).rows : []);
    const memRows = await q(`SELECT member_id, entity_id, product_id, status FROM product_entity_members WHERE product_id = ANY($1::bigint[])`, ids);
    const rows = new Map(); for (const r of memRows) { const k = Number(r.product_id); if (!rows.has(k)) rows.set(k, []); rows.get(k).push(r); }
    const eids = [...new Set(memRows.map((r) => Number(r.entity_id)))];
    const allOf = await q(`SELECT entity_id, product_id, status FROM product_entity_members WHERE entity_id = ANY($1::bigint[])`, eids);
    const approvedOf = new Map(); const nonRejectedOf = new Map();
    for (const r of allOf) {
      const e = Number(r.entity_id);
      if (r.status === 'approved') { if (!approvedOf.has(e)) approvedOf.set(e, []); approvedOf.get(e).push(Number(r.product_id)); }
      if (r.status !== 'rejected') { if (!nonRejectedOf.has(e)) nonRejectedOf.set(e, []); nonRejectedOf.get(e).push(Number(r.product_id)); }
    }
    const hasProfile = new Set((await q(`SELECT DISTINCT entity_id FROM entity_nutrition_profiles WHERE entity_id = ANY($1::bigint[]) AND status <> 'rejected'`, eids)).map((r) => Number(r.entity_id)));
    const keys = held.map((x) => `c005:${x.g.rn}`);
    const keyExists = new Set((await q(`SELECT entity_key FROM product_entities WHERE entity_key = ANY($1::text[])`, keys)).map((r) => r.entity_key));
    const ctx = { rows, approvedOf, nonRejectedOf, hasProfile, keyExists };
    const plans = held.map(({ g, nutReason }) => ({ g: { ...g, nutReason }, p: planMembership({ ...g, nutReason }, ctx) }));
    const tally = {}; const out = [];
    for (const { g, p } of plans) {
      const k = `${p.action}${p.reason ? '|' + p.reason : ''}`; tally[k] = (tally[k] || 0) + 1;
      for (const m of g.members) {
        const o = p.ops.find((x) => x.product_id === Number(m.product_id));
        out.push({ rn: g.rn, action: p.action, reason: p.reason || '', entity: p.entity_id || p.entity_key || '', product_id: m.product_id, barcode: m.barcode,
          product_name: m.product_name, has_nut: m.has_nut ? 'Y' : '', op: o ? o.op : '', prev_status: o && o.prev_status ? o.prev_status : '' });
      }
    }
    for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(40)} ${v.toLocaleString()} 묶음`);
    const nOps = plans.reduce((a, x) => a + x.p.ops.length, 0);
    console.log(`  멤버 승인 ${nOps.toLocaleString()} (insert ${plans.reduce((a, x) => a + x.p.ops.filter((o) => o.op === 'insert').length, 0)} · update ${plans.reduce((a, x) => a + x.p.ops.filter((o) => o.op === 'update').length, 0)}) · 새 엔티티 ${plans.filter((x) => x.p.action === 'create').length}`);
    const csvCell = (v) => { const s = v == null ? '' : String(v).replace(/\r?\n/g, ' '); return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const f = path.join(DIR, `94_preview_${CLS}_${new Date().toISOString().slice(0, 10)}.csv`);
    const cols = Object.keys(out[0] || { rn: '' });
    fs.writeFileSync(f, '﻿' + [cols.join(','), ...out.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n'));
    console.log(`미리보기 파일: ${f}`);
    if (!APPLY) { console.log('※ 쓰기 없음.'); return; }

    const batch = `c005member_${CLS}_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    const rec = { batch, version: VERSION, cls: CLS, actor: ACTOR, at: new Date().toISOString(), entities: [], inserted: [], updated: [], audits: [] };
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await applyPlans(c, plans, rec, ACTOR);
      const bf = path.join(DIR, `94_batch_${batch}.json`);
      fs.writeFileSync(bf, JSON.stringify(rec, null, 1)); // 기록 먼저, 그 뒤 COMMIT
      await c.query('COMMIT');
      console.log(`\n✅ 적용 완료 — 배치 ${batch} · 새 엔티티 ${rec.entities.length} · 승인 insert ${rec.inserted.length} · update ${rec.updated.length}`);
      console.log(`기록: ${bf}`);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  } finally { await pool.end(); }
}
if (require.main === module && !process.argv.includes('--self-test')) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
