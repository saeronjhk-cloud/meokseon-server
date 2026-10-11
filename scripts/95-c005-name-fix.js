/**
 * 95-c005-name-fix.js — c005(품목제조번호) 묶음의 깨진 글자(U+FFFD) 제품명·제조사·브랜드 복구 (미리보기 → 적용 → 되돌리기)  세션76c 2026-10-11
 * ============================================================================
 * 왜: 186 §6 U75-1 — 제품명·제조사에 U+FFFD(�)가 들어간 행 약 571개(세션75 90b 실측). 화면·검색(search_text 생성 컬럼)에 깨진 글자가 그대로 보인다.
 * 방법: 같은 품목제조번호 묶음의 «깨지지 않은» 형제 값 중 깨진 값과 퍼지 일치하는 것이 «정확히 하나»일 때만 그 값으로 바꾼다.
 *   퍼지 = 90 fuzzyEq 와 같은 규칙: � 가 k개 연속이면 1~k 글자 아무거나(UTF-8 한 글자 3바이트가 1~3개의 � 로 깨진다).
 *   안전장치: 깨지지 않은 글자 2자 이상 · 후보 길이의 50% 이상이 확정 글자 · 후보 2개 이상이면 hold · 후보 0이면 hold.
 * 쓰는 것: products.product_name / manufacturer / brand 한 칸씩(WHERE 원래 값 = 미리보기 값 — 그 사이 바뀌었으면 전체 롤백)
 *          + product_entity_audit(action 'c005_name_fix', before_json/after_json) + 배치 기록 파일(먼저 쓰고 COMMIT).
 * 쓰지 않는 것: nutrition_data · 엔티티 · 원재료 · updated_at(되돌리기를 정확히 하려고 건드리지 않는다).
 *
 * 실행 (제이 PC · meokseon-server 폴더):
 *   node scripts/95-c005-name-fix.js               미리보기(읽기 전용) → .tmp/s76/95_preview_<날짜>.csv
 *   node scripts/95-c005-name-fix.js --apply       적용(트랜잭션 1개) → .tmp/s76/95_batch_<id>.json
 *   node scripts/95-c005-name-fix.js --self-test
 *   (비상용 --undo <batch_id>)
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* */ }
const fs = require('fs');
const path = require('path');

const VERSION = 'c005_namefix@1';
const FIELDS = ['product_name', 'manufacturer', 'brand']; // 화이트리스트 — SQL 에 끼우는 칸 이름은 여기서만
const F = '�';

function fuzzyPattern(s) {
  return new RegExp('^' + String(s).replace(/�+|[^�]/gu, (t) => (t[0] === F ? `.{1,${t.length}}` : t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) + '$', 'u');
}

/**
 * 순수 함수. members = [{product_id, product_name, manufacturer, brand}] (같은 품목제조번호)
 * 반환 [{product_id, field, old, new|null, action:'fix'|'hold', reason}]
 */
function planFix(members) {
  const out = [];
  for (const m of members) {
    for (const f of FIELDS) {
      const v = m[f];
      if (v == null || !String(v).includes(F)) continue;
      const known = [...String(v)].filter((ch) => ch !== F).length;
      const re = fuzzyPattern(v);
      const cands = [...new Set(members.filter((o) => o.product_id !== m.product_id && o[f] && !String(o[f]).includes(F) && re.test(String(o[f]))).map((o) => String(o[f])))];
      const base = { product_id: m.product_id, field: f, old: String(v), new: null };
      if (known < 2) { out.push({ ...base, action: 'hold', reason: '확정 글자 2자 미만' }); continue; }
      if (!cands.length) { out.push({ ...base, action: 'hold', reason: '일치하는 깨끗한 형제 값 없음' }); continue; }
      if (cands.length > 1) { out.push({ ...base, action: 'hold', reason: `후보 ${cands.length}개(${cands.slice(0, 3).join(' / ')})` }); continue; }
      if (known / [...cands[0]].length < 0.5) { out.push({ ...base, action: 'hold', reason: '확정 글자 50% 미만' }); continue; }
      out.push({ ...base, new: cands[0], action: 'fix', reason: '' });
    }
  }
  return out;
}

async function applyFixes(c, fixes, rec, actor) {
  for (const x of fixes) {
    if (x.action !== 'fix') continue;
    if (!FIELDS.includes(x.field)) throw new Error(`허용되지 않은 칸: ${x.field}`);
    const r = await c.query(`UPDATE products SET ${x.field} = $2 WHERE product_id = $1 AND ${x.field} = $3 RETURNING product_id`, [x.product_id, x.new, x.old]);
    if (r.rows.length !== 1) throw new Error(`값이 미리보기 뒤 바뀜(product_id ${x.product_id} · ${x.field}) — 전체 롤백`);
    const a = await c.query(`INSERT INTO product_entity_audit (entity_id, product_id, action, before_json, after_json, classifier_version, eval_version, actor)
      VALUES (NULL, $1, 'c005_name_fix', $2, $3, $4, $5, $6) RETURNING audit_id`,
      [x.product_id, JSON.stringify({ [x.field]: x.old, rn: x.rn || null }), JSON.stringify({ [x.field]: x.new }), VERSION, rec.batch, actor]);
    rec.fixes.push({ product_id: x.product_id, field: x.field, old: x.old, new: x.new });
    rec.audits.push(Number(a.rows[0].audit_id));
  }
}

async function undoBatch(c, rec) {
  let n = 0;
  for (const x of rec.fixes) {
    if (!FIELDS.includes(x.field)) throw new Error(`허용되지 않은 칸: ${x.field}`);
    const r = await c.query(`UPDATE products SET ${x.field} = $2 WHERE product_id = $1 AND ${x.field} = $3 RETURNING product_id`, [x.product_id, x.old, x.new]);
    n += r.rows.length;
  }
  await c.query(`UPDATE product_entity_audit SET undone_at = now() WHERE audit_id = ANY($1::bigint[])`, [rec.audits]);
  if (n !== rec.fixes.length) throw new Error(`기록과 수가 다름(${n}/${rec.fixes.length}) — 그 사이 값이 바뀐 행이 있다 · 되돌리기 중단`);
  return { reverted: n };
}

if (require.main === module && process.argv.includes('--self-test')) {
  let ok = 0, bad = 0;
  const eq = (a, b, n) => { const s = JSON.stringify(a) === JSON.stringify(b); s ? ok++ : bad++; console.log(`  ${s ? '✅' : '❌'} ${n}${s ? '' : `\n     기대 ${JSON.stringify(b)}\n     실제 ${JSON.stringify(a)}`}`); };
  const P = (id, name, mk, br = null) => ({ product_id: id, product_name: name, manufacturer: mk, brand: br });
  const pick = (r) => r.map((x) => [x.product_id, x.field, x.action, x.new]);
  eq(pick(planFix([P(1, '양송��맛스프', 'A'), P(2, '양송이맛스프', 'A')])), [[1, 'product_name', 'fix', '양송이맛스프']], 'n1 제품명 복구');
  eq(pick(planFix([P(1, 'X', '씨��이제일제당(주)'), P(2, 'X', '씨제이제일제당(주)')])), [[1, 'manufacturer', 'fix', '씨제이제일제당(주)']], 'n2 제조사 복구(�� = 1글자)');
  eq(planFix([P(1, '제이이스��메디팜', 'A'), P(2, '제이이스트메디��', 'A')]).map((x) => x.action), ['hold', 'hold'], 'n3 서로 깨짐 → hold');
  eq(planFix([P(1, '김치�', 'A'), P(2, '김치찌개', 'A')])[0].reason, '일치하는 깨끗한 형제 값 없음', 'n4 � 1개 = 1글자만(4글자 후보와 안 맞음)');
  eq(planFix([P(1, '김치��', 'A'), P(2, '김치찌개', 'A'), P(3, '김치전', 'A')])[0].reason.startsWith('후보 2개'), true, 'n5 후보 둘 → hold');
  eq(planFix([P(1, '김���', 'A'), P(2, '김치', 'A')])[0].reason, '확정 글자 2자 미만', 'n6 확정 글자 부족');
  eq(planFix([P(1, '라��', 'A'), P(2, '라면사리랑떡볶이', 'A')])[0].action, 'hold', 'n7 �� 는 최대 2글자 — 긴 후보와 안 맞음');
  eq(planFix([P(1, '맛김��', 'A'), P(2, '맛김치', 'A')]).length, 1, 'n8 깨끗한 행은 계획에 없음');
  eq(pick(planFix([P(1, 'A', 'B', '해태��'), P(2, 'A', 'B', '해태제과')])), [[1, 'brand', 'fix', '해태제과']], 'n9 브랜드');
  eq(planFix([P(1, '(주)��', 'A'), P(2, '(주)대상', 'A')])[0].action, 'fix', 'n10 특수문자는 정규식 이스케이프');
  console.log(`\nself-test: ${ok} 통과 · ${bad} 실패`);
  process.exit(bad ? 1 : 0);
}

module.exports = { planFix, applyFixes, undoBatch, fuzzyPattern, VERSION, FIELDS };

async function main() {
  const { Pool } = require('pg');
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const APPLY = process.argv.includes('--apply');
  const UNDO = arg('--undo');
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
      const bf = path.join(DIR, `95_batch_${UNDO}.json`);
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
    console.log(`[${APPLY ? '적용' : '미리보기 · 읽기 전용'}] c005 묶음 깨진 글자 복구`);
    const t0 = Date.now();
    // 깨진 행이 있는 품목제조번호만 → 그 묶음 전체(단순 조회 2개 — 거대 CTE 금지 · 186 8-I)
    const rns = (await pool.query(`SELECT DISTINCT btrim(c005_report_no) AS rn FROM products
      WHERE is_active AND btrim(COALESCE(c005_report_no,'')) <> ''
        AND (strpos(product_name, U&'\\FFFD') > 0 OR strpos(manufacturer, U&'\\FFFD') > 0 OR strpos(brand, U&'\\FFFD') > 0)`)).rows.map((r) => r.rn);
    const prods = rns.length ? (await pool.query(`SELECT product_id, barcode, product_name, manufacturer, brand, btrim(c005_report_no) AS rn
      FROM products WHERE is_active AND btrim(c005_report_no) = ANY($1::text[])`, [rns])).rows : [];
    const byRn = new Map(); for (const p of prods) { if (!byRn.has(p.rn)) byRn.set(p.rn, []); byRn.get(p.rn).push(p); }
    const fixes = [];
    for (const [rn, ms] of byRn) for (const x of planFix(ms)) { const m = ms.find((y) => y.product_id === x.product_id); fixes.push({ ...x, rn, barcode: m.barcode }); }
    const tally = {};
    for (const x of fixes) { const k = `${x.field}|${x.action}${x.reason ? '|' + x.reason.replace(/\(.*$/, '') : ''}`; tally[k] = (tally[k] || 0) + 1; }
    console.log(`품목제조번호 ${rns.length.toLocaleString()} · 제품 ${prods.length.toLocaleString()} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(40)} ${v.toLocaleString()}`);
    const csvCell = (v) => { const s = v == null ? '' : String(v).replace(/\r?\n/g, ' '); return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const cols = ['rn', 'product_id', 'barcode', 'field', 'action', 'reason', 'old', 'new'];
    const f = path.join(DIR, `95_preview_${new Date().toISOString().slice(0, 10)}.csv`);
    fs.writeFileSync(f, '﻿' + [cols.join(','), ...fixes.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n'));
    console.log(`미리보기 파일: ${f}`);
    if (!APPLY) { console.log('※ 쓰기 없음.'); return; }

    const batch = `c005namefix_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    const rec = { batch, version: VERSION, actor: ACTOR, at: new Date().toISOString(), fixes: [], audits: [] };
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await applyFixes(c, fixes, rec, ACTOR);
      const bf = path.join(DIR, `95_batch_${batch}.json`);
      fs.writeFileSync(bf, JSON.stringify(rec, null, 1)); // 기록 먼저, 그 뒤 COMMIT
      await c.query('COMMIT');
      console.log(`\n✅ 적용 완료 — 배치 ${batch} · 복구 ${rec.fixes.length}칸`);
      console.log(`기록: ${bf}`);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  } finally { await pool.end(); }
}
if (require.main === module && !process.argv.includes('--self-test')) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
