/**
 * 97-c002name-audit.js — 이름매칭(c002_name) 원재료 감사: 맞는 것만 남기고 숨김 + HACCP 원문 채움 (미리보기 → 적용 → 되돌리기)  세션77 2026-10-12
 * ============================================================================
 * 왜: 187 §6-1(원재료 hold 755)을 조사해 보니 보류의 뿌리는 기증자의 c002_name 원재료였고, 그 원재료가 운영 화면 6,149 제품에
 *     그대로 표시되고 있었다. HACCP 라벨 원문과 대조하니 다른 제품의 원재료가 섞여 있었다
 *     (서울우유 원유100% → «서울우유 커피» 원재료 · 빠삐코 아이스크림 → «빠삐코미니샌드» 빵 원재료).
 * 규칙(엔진 · AI 추론 없음):
 *   유지 = 제품명 정규화 일치(공백·문장부호만 제거, 괄호 «안 내용»은 남김) AND 제조사 같음(merge/utils isSameMaker)
 *   그 밖 = 숨김(행 삭제 · 전체 행을 배치 기록·audit 에 보존 → --undo 로 원상복구). 그 제품의 product_additives(전부 c002_name 원문에서 나온 것)도 같이 숨김.
 *   다른 원재료 출처가 함께 있는 제품은 건드리지 않는다(hold).
 * HACCP 채움: 원재료 행이 «없는»(숨김 후 포함) 활성 제품 중 HACCP 덤프(scripts/output/haccp_dump.ndjson · 2026-07 수집)에
 *   바코드 정확일치 또는 품목보고번호 정확일치가 있고, 원문이 하나로 정해지면 product_ingredients(source 'haccp_api') 1행을 넣는다.
 *   두 경로 모두 7월 19·24번과 같은 G2(이름 Dice>=0.45 또는 포함)·G3(제조사 겹침) 게이트를 통과해야 한다. 첨가물은 저장하지 않는다(서버가 원문에서 derived_additives 로 검출).
 * 게이트(76-15 방식): IP/eval_c002name_v1/gold_v1.json 에서 유지로 분류된 사례에 final='wrong' 이 하나라도 있으면 --apply 거부.
 * 쓰지 않는 것: products · nutrition · 엔티티 · allergens · updated_at.
 *
 * 실행 (제이 PC · meokseon-server 폴더):
 *   node scripts/97-c002name-audit.js               미리보기(읽기 전용) → .tmp/s77/97_preview_<시각>.csv
 *   node scripts/97-c002name-audit.js --apply       적용(트랜잭션 1개) → .tmp/s77/97_batch_<id>.json
 *   node scripts/97-c002name-audit.js --self-test
 *   (비상용 --undo <batch_id>)
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* */ }
const fs = require('fs');
const path = require('path');
const { isSameMaker } = require('./merge/utils/normalize-maker');

const VERSION = 'c002name_audit@1';
const GOLD = path.resolve(__dirname, '../../IP/eval_c002name_v1/gold_v1.json');
const HACCP = path.join(__dirname, 'output', 'haccp_dump.ndjson');

const nameKey = (s) => String(s || '').replace(/[\s\-_.,·'"()\[\]{}]/g, '').toLowerCase();
const haccpName = (s) => { const t = String(s || ''); const i = t.lastIndexOf('->'); return i >= 0 ? t.slice(i + 2) : t; };

/** 유지/숨김 판정(순수). x = {product_name, manufacturer, c002_nm, c002_bssh} */
function decideKeep(x) {
  const ne = !!nameKey(x.product_name) && nameKey(x.product_name) === nameKey(x.c002_nm);
  const me = !!isSameMaker(x.manufacturer || '', x.c002_bssh || '');
  return { keep: ne && me, reason: ne ? (me ? '' : '제조사 다름') : (me ? '제품명 다름' : '제품명·제조사 다름') };
}

/** HACCP 덤프 → {byBc, byRn} (원문 있는 행만) */
function loadHaccp(lines) {
  const byBc = new Map(), byRn = new Map();
  const add = (m, k, d) => { if (!m.has(k)) m.set(k, []); m.get(k).push(d); };
  for (const l of lines) {
    if (!l.trim()) continue;
    const d = JSON.parse(l);
    if (!d.raw || !String(d.raw).trim()) continue;
    add(byRn, String(d.reportNo).trim(), d);
    for (const b of String(d.bc || '').match(/\d[\d ]{6,16}\d/g) || []) add(byBc, b.replace(/ /g, ''), d);
  }
  return { byBc, byRn };
}

// ── 19·24번과 같은 게이트(G2 이름 Dice>=0.45 또는 포함 · G3 제조사 겹침) — 7월 HACCP 적재 기준을 그대로 쓴다 ──
const g2Name = (s) => (s || '').toString().toLowerCase().replace(/\(주\)|주식회사|㈜|\s|\.|,|·|&|%/g, '');
const bigrams = (s) => { const r = new Set(); for (let i = 0; i < s.length - 1; i++) r.add(s.slice(i, i + 2)); return r; };
const dice = (a, b) => { const A = bigrams(a), B = bigrams(b); if (!A.size || !B.size) return 0; let n = 0; for (const x of A) if (B.has(x)) n++; return (2 * n) / (A.size + B.size); };
const mfrOverlap = (a, b) => { const na = g2Name(a), nb = g2Name(b); if (!na || !nb) return false; return na.includes(nb.slice(0, 4)) || nb.includes(na.slice(0, 4)) || dice(na, nb) >= 0.4; };
const nameGate = (a, b) => { const na = g2Name(a), nb = g2Name(b); if (!na || !nb) return false; return na.includes(nb) || nb.includes(na) || dice(na, nb) >= 0.45; };

/** HACCP 채움 판정(순수). p = {barcode, rn, product_name, manufacturer}. 바코드 → 보고번호 순. 둘 다 이름·제조사 게이트를 통과해야 한다. */
function planHaccp(p, H) {
  const gate = (d) => nameGate(p.product_name, haccpName(d.nm)) && mfrOverlap(p.manufacturer, d.mfr);
  let via = 'barcode', all = H.byBc.get(String(p.barcode || '')) || [];
  if (!all.length) { via = 'rn'; all = H.byRn.get(String(p.rn || '').trim()) || []; }
  if (!all.length) return null;
  const ds = all.filter(gate);
  if (!ds.length) return { action: 'hold', via, reason: '이름·제조사 게이트 탈락', haccp_rn: String(all[0].reportNo), haccp_nm: all[0].nm };
  const raws = [...new Set(ds.map((d) => String(d.raw).trim()))];
  if (raws.length > 1) return { action: 'hold', via, reason: `원문 ${raws.length}개`, haccp_rn: String(ds[0].reportNo), haccp_nm: ds[0].nm };
  return { action: 'fill', via, raw: raws[0], haccp_rn: String(ds[0].reportNo), haccp_nm: ds[0].nm, haccp_mfr: ds[0].mfr };
}

/** 게이트: 유지로 분류된 gold 중 wrong 0 · 숨김으로 분류된 wrong 수 */
function goldGate(gold) {
  let keepWrong = [], hideWrong = 0, keepOk = 0;
  for (const c of gold.cases) {
    const k = decideKeep({ product_name: c.name, manufacturer: c.mfr, c002_nm: c.c002_name, c002_bssh: c.c002_mfr }).keep;
    if (c.final === 'unsure') continue;
    if (k && c.final === 'wrong') keepWrong.push(c.id);
    if (k && c.final !== 'wrong') keepOk++;
    if (!k && c.final === 'wrong') hideWrong++;
  }
  return { pass: keepWrong.length === 0, keepWrong, keepOk, hideWrong };
}

if (require.main === module && process.argv.includes('--self-test')) {
  let ok = 0, bad = 0;
  const eq = (a, b, n) => { const s = JSON.stringify(a) === JSON.stringify(b); s ? ok++ : bad++; console.log(`  ${s ? '✅' : '❌'} ${n}${s ? '' : `\n     기대 ${JSON.stringify(b)}\n     실제 ${JSON.stringify(a)}`}`); };
  const K = (n, m, cn, cm) => decideKeep({ product_name: n, manufacturer: m, c002_nm: cn, c002_bssh: cm });
  eq(K('농심감자면', '(주)농심', '농심감자면', '(주)농심').keep, true, 'k1 이름·제조사 같음 → 유지');
  eq(K('서울우유', '서울우유협동조합 안산공장', '서울우유 커피', '서울우유 양주신공장'), { keep: false, reason: '제품명 다름' }, 'k2 맛 단어 추가 → 숨김');
  eq(K('미니돈까스', '천일식품(주)', '미니돈까스', '(주)마니커에프앤지').reason, '제조사 다름', 'k3 같은 이름 다른 회사 → 숨김');
  eq(K('팔도 불낙볶음면', '(주) 팔도', '팔도 불낙볶음면', '(주)팔도').keep, true, 'k4 공백 차이 무시');
  eq(K('오징어땅콩(매콤)', '(주)오리온', '오징어땅콩', '(주)오리온').keep, false, 'k5 괄호 안 내용은 남김 → 다름');
  eq(K('', 'A', '', 'A').keep, false, 'k6 빈 이름은 유지 안 함');
  const H = loadHaccp([
    JSON.stringify({ reportNo: '111', nm: '서울우유(멸균) -> 서울우유', mfr: '서울우유협동조합 안산공장', bc: null, raw: '원유100%' }),
    JSON.stringify({ reportNo: '222', nm: '감자칩', mfr: '(주)갑식품', bc: '8 801234 000001', raw: '감자,팜유' }),
    JSON.stringify({ reportNo: '333', nm: '두유A', mfr: '을', bc: null, raw: '대두,설탕' }),
    JSON.stringify({ reportNo: '333', nm: '두유A', mfr: '을', bc: null, raw: '대두,올리고당' }),
    JSON.stringify({ reportNo: '444', nm: '빈원문', bc: null, raw: null }),
  ]);
  eq(planHaccp({ barcode: '8801234000001', rn: 'x', product_name: '감자칩 60g', manufacturer: '갑식품' }, H).action, 'fill', 'h1 바코드 일치(공백 제거) + 게이트 → 채움');
  eq(planHaccp({ barcode: '0', rn: '111', product_name: '서울우유 1L', manufacturer: '서울우유협동조합' }, H).raw, '원유100%', 'h2 보고번호 + 이름 포함(-> 뒤 이름) → 채움');
  eq(planHaccp({ barcode: '0', rn: '111', product_name: '딸기맛 음료', manufacturer: '서울우유협동조합' }, H).reason, '이름·제조사 게이트 탈락', 'h3 보고번호만 같고 이름 다름 → hold');
  eq(planHaccp({ barcode: '0', rn: '333', product_name: '두유A', manufacturer: '을' }, H).reason, '원문 2개', 'h4 원문 둘 → hold');
  eq(planHaccp({ barcode: '8801234000001', rn: 'x', product_name: '감자칩', manufacturer: '병회사' }, H).reason, '이름·제조사 게이트 탈락', 'h6 바코드 일치라도 제조사 다르면 hold(7월 G3)');
  eq(planHaccp({ barcode: '0', rn: '444', product_name: '빈원문' }, H), null, 'h5 원문 없는 행은 없음 취급');
  const g = goldGate({ cases: [
    { id: 'a', name: '서울우유', mfr: '서울우유', c002_name: '서울우유 커피', c002_mfr: '서울우유', final: 'wrong' },
    { id: 'b', name: 'X', mfr: '갑', c002_name: 'X', c002_mfr: '갑', final: 'ok' },
    { id: 'c', name: 'Y', mfr: '갑', c002_name: 'Y', c002_mfr: '갑', final: 'unsure' }] });
  eq([g.pass, g.keepOk, g.hideWrong], [true, 1, 1], 'g1 게이트 통과(unsure 제외)');
  eq(goldGate({ cases: [{ id: 'd', name: 'Z', mfr: '갑', c002_name: 'Z', c002_mfr: '갑', final: 'wrong' }] }).pass, false, 'g2 유지에 wrong → 거부');
  if (fs.existsSync(GOLD)) { const r = goldGate(JSON.parse(fs.readFileSync(GOLD, 'utf8'))); eq(r.pass, true, `g3 실제 gold_v1 게이트 (유지 정답 ${r.keepOk} · 숨김된 오답 ${r.hideWrong})`); }
  console.log(`\nself-test: ${ok} 통과 · ${bad} 실패`);
  process.exit(bad ? 1 : 0);
}

module.exports = { decideKeep, loadHaccp, planHaccp, goldGate, applyPlan, undoBatch, nameKey, VERSION };

const ING_COLS = ['id', 'product_id', 'raw_text', 'parsed_ingredients', 'prdlst_report_no', 'source', 'created_at', 'updated_at'];
const ADD_COLS = ['product_id', 'additive_id', 'amount', 'unit', 'detected_name', 'confidence'];

// 원격 DB 왕복을 줄이려고 묶음(500) 단위 집합 연산으로 쓴다. 검증은 «미리보기 때 본 행 그대로인가»를 묶음마다 확인한다.
const CH = 500;
const chunks = (a) => { const o = []; for (let i = 0; i < a.length; i += CH) o.push(a.slice(i, i + CH)); return o; };

async function applyPlan(c, plan, rec, actor, evalVersion) {
  for (const part of chunks(plan.hide)) {
    const pids = part.map((h) => Number(h.product_id));
    const ing = (await c.query(`SELECT ${ING_COLS.join(', ')} FROM product_ingredients WHERE product_id = ANY($1::bigint[]) ORDER BY id`, [pids])).rows;
    const byP = new Map(); for (const r of ing) { const k = Number(r.product_id); if (!byP.has(k)) byP.set(k, []); byP.get(k).push(r); }
    for (const h of part) {
      const rs = byP.get(Number(h.product_id)) || [];
      if (rs.length !== 1 || Number(rs[0].id) !== Number(h.ingredient_id) || rs[0].source !== 'c002_name') throw new Error(`원재료 행이 미리보기 뒤 바뀜(product_id ${h.product_id}) — 전체 롤백`);
    }
    const add = (await c.query(`SELECT ${ADD_COLS.join(', ')} FROM product_additives WHERE product_id = ANY($1::bigint[])`, [pids])).rows;
    const addBy = new Map(); for (const r of add) { const k = Number(r.product_id); if (!addBy.has(k)) addBy.set(k, []); addBy.get(k).push(r); }
    const da = await c.query(`DELETE FROM product_additives WHERE product_id = ANY($1::bigint[])`, [pids]);
    if ((da.rowCount ?? add.length) !== add.length) throw new Error(`첨가물 삭제 수 불일치(${da.rowCount}/${add.length}) — 전체 롤백`);
    const ids = part.map((h) => Number(h.ingredient_id));
    const d = await c.query(`DELETE FROM product_ingredients WHERE id = ANY($1::bigint[]) AND source = 'c002_name' RETURNING id`, [ids]);
    if (d.rows.length !== ids.length) throw new Error(`삭제 수 불일치(${d.rows.length}/${ids.length}) — 전체 롤백`);
    const before = part.map((h) => JSON.stringify({ ingredient: byP.get(Number(h.product_id))[0], additives: addBy.get(Number(h.product_id)) || [] }));
    const after = part.map((h) => JSON.stringify({ reason: h.reason, c002_rn: h.irn || null }));
    const a = await c.query(`INSERT INTO product_entity_audit (entity_id, product_id, action, before_json, after_json, classifier_version, eval_version, actor)
      SELECT NULL, u.pid, 'c002name_hide', u.b::jsonb, u.a::jsonb, $4, $5, $6 FROM unnest($1::bigint[], $2::text[], $3::text[]) AS u(pid, b, a) RETURNING audit_id`,
      [pids, before, after, VERSION, evalVersion, actor]);
    if (a.rows.length !== part.length) throw new Error('audit 수 불일치 — 전체 롤백');
    for (const h of part) rec.hide.push({ product_id: Number(h.product_id), ingredient: byP.get(Number(h.product_id))[0], additives: addBy.get(Number(h.product_id)) || [] });
    rec.audits.push(...a.rows.map((r) => Number(r.audit_id)));
  }
  for (const part of chunks(plan.fill)) {
    const pids = part.map((f) => Number(f.product_id));
    if (new Set(pids).size !== pids.length) throw new Error('채움 대상 중복 — 전체 롤백');
    const ex = (await c.query(`SELECT DISTINCT product_id FROM product_ingredients WHERE product_id = ANY($1::bigint[])`, [pids])).rows;
    if (ex.length) throw new Error(`채움 대상에 원재료 행이 생김(product_id ${ex[0].product_id} 외 ${ex.length - 1}) — 전체 롤백`);
    const r = await c.query(`INSERT INTO product_ingredients (product_id, raw_text, prdlst_report_no, source)
      SELECT u.pid, u.raw, u.rn, 'haccp_api' FROM unnest($1::bigint[], $2::text[], $3::text[]) WITH ORDINALITY AS u(pid, raw, rn, ord) ORDER BY u.ord RETURNING id, product_id`,
      [pids, part.map((f) => f.raw), part.map((f) => f.haccp_rn)]);
    if (r.rows.length !== part.length) throw new Error('채움 수 불일치 — 전체 롤백');
    const idOf = new Map(r.rows.map((x) => [Number(x.product_id), Number(x.id)]));
    const after = part.map((f) => JSON.stringify({ ingredient_id: idOf.get(Number(f.product_id)), via: f.via, haccp_rn: f.haccp_rn, haccp_nm: f.haccp_nm }));
    const a = await c.query(`INSERT INTO product_entity_audit (entity_id, product_id, action, before_json, after_json, classifier_version, eval_version, actor)
      SELECT NULL, u.pid, 'haccp_dump_fill', '{"ingredient":null}'::jsonb, u.a::jsonb, $3, $4, $5 FROM unnest($1::bigint[], $2::text[]) AS u(pid, a) RETURNING audit_id`,
      [pids, after, VERSION, evalVersion, actor]);
    if (a.rows.length !== part.length) throw new Error('audit 수 불일치 — 전체 롤백');
    for (const f of part) rec.fill.push({ product_id: Number(f.product_id), ingredient_id: idOf.get(Number(f.product_id)) });
    rec.audits.push(...a.rows.map((x) => Number(x.audit_id)));
  }
}

async function undoBatch(c, rec) {
  const ids = rec.fill.map((x) => x.ingredient_id);
  let removed = 0;
  for (const part of chunks(ids)) {
    const d = await c.query(`DELETE FROM product_ingredients WHERE id = ANY($1::bigint[]) AND source = 'haccp_api' RETURNING id`, [part]);
    removed += d.rows.length;
  }
  if (removed !== ids.length) throw new Error(`채움 행 수 불일치(${removed}/${ids.length}) — 되돌리기 중단`);
  let ni = 0, na = 0;
  for (const part of chunks(rec.hide)) {
    const pids = part.map((h) => Number(h.product_id));
    const ex = (await c.query(`SELECT DISTINCT product_id FROM product_ingredients WHERE product_id = ANY($1::bigint[])`, [pids])).rows;
    if (ex.length) throw new Error(`복구 대상에 이미 원재료 행이 있음(product_id ${ex[0].product_id} 외 ${ex.length - 1}) — 되돌리기 중단`);
    const ingJ = JSON.stringify(part.map((h) => h.ingredient));
    const r1 = await c.query(`INSERT INTO product_ingredients (${ING_COLS.join(', ')}) SELECT ${ING_COLS.join(', ')} FROM jsonb_populate_recordset(NULL::product_ingredients, $1::jsonb)`, [ingJ]);
    ni += r1.rowCount ?? part.length;
    const adds = part.flatMap((h) => h.additives);
    if (adds.length) { const r2 = await c.query(`INSERT INTO product_additives (${ADD_COLS.join(', ')}) SELECT ${ADD_COLS.join(', ')} FROM jsonb_populate_recordset(NULL::product_additives, $1::jsonb)`, [JSON.stringify(adds)]); na += r2.rowCount ?? adds.length; }
  }
  for (const part of chunks(rec.audits)) await c.query(`UPDATE product_entity_audit SET undone_at = now() WHERE audit_id = ANY($1::bigint[])`, [part]);
  return { fill_removed: removed, ingredients_restored: ni, additives_restored: na };
}

async function main() {
  const { Pool } = require('pg');
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const APPLY = process.argv.includes('--apply');
  const UNDO = arg('--undo');
  const ACTOR = arg('--actor') || '김재환';
  const DIR = path.resolve(__dirname, '../../.tmp/s77');
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
      const bf = path.join(DIR, `97_batch_${UNDO}.json`);
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
    const gold = JSON.parse(fs.readFileSync(GOLD, 'utf8'));
    const gate = goldGate(gold);
    const evalVersion = `gold_v1@${gold.frozen_at}`;
    console.log(`[${APPLY ? '적용' : '미리보기 · 읽기 전용'}] c002_name 감사 + HACCP 채움`);
    console.log(`gold 게이트: ${gate.pass ? '통과' : '❌ 실패 ' + gate.keepWrong.join(',')} · 유지 정답 ${gate.keepOk} · 숨김된 오답 ${gate.hideWrong}`);
    const t0 = Date.now();
    // 단순 조회만(186 8-I)
    const rows = (await pool.query(`SELECT i.id AS ingredient_id, i.product_id, i.prdlst_report_no AS irn, p.barcode, btrim(p.c005_report_no) AS rn,
        p.product_name, p.manufacturer, p.is_active
      FROM product_ingredients i JOIN products p USING (product_id) WHERE i.source = 'c002_name'`)).rows;
    const pids = rows.map((r) => r.product_id);
    const other = new Set((await pool.query(`SELECT DISTINCT product_id FROM product_ingredients WHERE product_id = ANY($1::bigint[]) AND source <> 'c002_name'`, [pids])).rows.map((r) => String(r.product_id)));
    const multi = new Set((await pool.query(`SELECT product_id FROM product_ingredients WHERE product_id = ANY($1::bigint[]) AND source = 'c002_name' GROUP BY 1 HAVING count(*) > 1`, [pids])).rows.map((r) => String(r.product_id)));
    const irns = [...new Set(rows.map((r) => r.irn).filter(Boolean))];
    const st = new Map((await pool.query(`SELECT DISTINCT ON (prdlst_report_no) prdlst_report_no, prdlst_nm, bssh_nm FROM staging_ingredients WHERE prdlst_report_no = ANY($1::text[]) ORDER BY prdlst_report_no, id`, [irns])).rows.map((r) => [r.prdlst_report_no, r]));
    const nAdd = new Map((await pool.query(`SELECT product_id, count(*)::int n FROM product_additives WHERE product_id = ANY($1::bigint[]) GROUP BY 1`, [pids])).rows.map((r) => [String(r.product_id), r.n]));
    const out = [], plan = { hide: [], fill: [] };
    for (const r of rows) {
      const s = st.get(r.irn) || {};
      const base = { kind: 'c002_name', product_id: r.product_id, barcode: r.barcode, rn: r.rn, product_name: r.product_name, manufacturer: r.manufacturer, c002_rn: r.irn, c002_nm: s.prdlst_nm || '', c002_bssh: s.bssh_nm || '', additives: nAdd.get(String(r.product_id)) || 0 };
      if (other.has(String(r.product_id)) || multi.has(String(r.product_id))) { out.push({ ...base, action: 'hold', reason: '다른 원재료 행이 함께 있음' }); continue; }
      if (!s.prdlst_nm) { out.push({ ...base, action: 'hide', reason: '매칭된 C002 행 없음' }); plan.hide.push({ ...base, ingredient_id: r.ingredient_id, irn: r.irn, reason: '매칭된 C002 행 없음' }); continue; }
      const d = decideKeep({ product_name: r.product_name, manufacturer: r.manufacturer, c002_nm: s.prdlst_nm, c002_bssh: s.bssh_nm });
      if (d.keep) { out.push({ ...base, action: 'keep', reason: '' }); continue; }
      out.push({ ...base, action: 'hide', reason: d.reason });
      plan.hide.push({ ...base, ingredient_id: r.ingredient_id, irn: r.irn, reason: d.reason });
    }
    // HACCP 채움 대상: 원재료 행이 없는 활성 제품 + 이번에 숨기는 제품
    const H = loadHaccp(fs.readFileSync(HACCP, 'utf8').split('\n'));
    const keysBc = [...H.byBc.keys()], keysRn = [...H.byRn.keys()];
    const empty = (await pool.query(`SELECT p.product_id, p.barcode, btrim(p.c005_report_no) AS rn, p.product_name, p.manufacturer FROM products p
      WHERE p.is_active AND (p.barcode = ANY($1::text[]) OR btrim(p.c005_report_no) = ANY($2::text[]))
        AND NOT EXISTS (SELECT 1 FROM product_ingredients i WHERE i.product_id = p.product_id)`, [keysBc, keysRn])).rows;
    const hid = new Map(plan.hide.map((h) => [String(h.product_id), h]));
    const hidRows = rows.filter((r) => hid.has(String(r.product_id)) && r.is_active);
    for (const p of [...empty.map((x) => ({ ...x, src: 'empty' })), ...hidRows.map((x) => ({ ...x, src: 'hidden' }))]) {
      const h = planHaccp(p, H);
      if (!h) continue;
      const base = { kind: `haccp_fill:${p.src}`, product_id: p.product_id, barcode: p.barcode, rn: p.rn, product_name: p.product_name, manufacturer: p.manufacturer, c002_rn: h.haccp_rn || '', c002_nm: h.haccp_nm || '', c002_bssh: h.via + (h.haccp_mfr ? ' · ' + String(h.haccp_mfr).slice(0, 40) : '') };
      out.push({ ...base, action: h.action, reason: h.reason || '', raw: h.raw ? h.raw.slice(0, 120) : '' });
      if (h.action === 'fill') plan.fill.push({ product_id: p.product_id, raw: h.raw, via: h.via, haccp_rn: h.haccp_rn, haccp_nm: h.haccp_nm });
    }
    const tally = {};
    for (const x of out) { const k = `${x.kind}|${x.action}${x.reason ? '|' + x.reason : ''}`; tally[k] = (tally[k] || 0) + 1; }
    console.log(`c002_name 행 ${rows.length.toLocaleString()} · 원재료 없는 HACCP 후보 ${empty.length.toLocaleString()} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(48)} ${v.toLocaleString()}`);
    console.log(`숨김에 딸린 첨가물 행: ${plan.hide.reduce((s, h) => s + h.additives, 0).toLocaleString()}`);
    const csvCell = (v) => { const s = v == null ? '' : String(v).replace(/\r?\n/g, ' '); return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const cols = ['kind', 'action', 'reason', 'product_id', 'barcode', 'rn', 'product_name', 'manufacturer', 'c002_rn', 'c002_nm', 'c002_bssh', 'additives', 'raw'];
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const f = path.join(DIR, `97_preview_${stamp}.csv`);
    fs.writeFileSync(f, '﻿' + [cols.join(','), ...out.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n'));
    console.log(`미리보기 파일: ${f}`);
    if (!APPLY) { console.log('※ 쓰기 없음.'); return; }
    if (!gate.pass) throw new Error('gold 게이트 실패 — 적용 거부(76-15)');

    const batch = `c002audit_${stamp}`;
    const rec = { batch, version: VERSION, eval: evalVersion, actor: ACTOR, at: new Date().toISOString(), hide: [], fill: [], audits: [] };
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await applyPlan(c, plan, rec, ACTOR, evalVersion);
      const bf = path.join(DIR, `97_batch_${batch}.json`);
      fs.writeFileSync(bf, JSON.stringify(rec)); // 기록 먼저, 그 뒤 COMMIT
      await c.query('COMMIT');
      console.log(`\n✅ 적용 완료 — 배치 ${batch} · 숨김 ${rec.hide.length} · HACCP 채움 ${rec.fill.length}`);
      console.log(`기록: ${bf}`);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  } finally { await pool.end(); }
}
if (require.main === module && !process.argv.includes('--self-test')) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
