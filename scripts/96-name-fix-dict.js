/**
 * 96-name-fix-dict.js — 깨진 글자(U+FFFD) 제품명·제조사·브랜드 복구 2단계: 회사 접두·전체 사전 (미리보기 → 적용 → 되돌리기)  세션76d 2026-10-11
 * ============================================================================
 * 왜: 95(같은 품목제조번호 형제)로 못 고친 529칸(187 §6 U76-3). 같은 품목제조번호에 깨끗한 형제가 없다.
 * 근거 규칙: 95 적용 569/569 가 «깨진 자리(� 연속) 1곳 = 정확히 1글자»였다 → 96 은 1글자로만 맞춘다(95 의 1~k 보다 엄격).
 * 후보 범위(어느 단계든 후보가 «정확히 하나»일 때만 고친다):
 *   manufacturer·brand : ① 같은 바코드 앞 7자리(회사 접두)의 깨끗한 값 → ② 전체 활성 제품의 깨끗한 값 사전
 *   product_name       : ① 같은 바코드 앞 7자리의 깨끗한 값만(제품명은 회사 밖 사전 금지)
 *   안전장치: 확정 글자 2자 이상 · 확정 글자가 후보 길이의 50% 이상
 * Eval-First: IP/eval_name_fix_v1/gold_v1.json(20칸 · DB 보기 전 고정) — 미리보기가 precision/recall 을 출력하고,
 *   precision 이 100% 가 아니면 --apply 를 거부한다(틀린 복구 0 이 합격선).
 * 쓰는 것·되돌리기: 95 와 같다(products 한 칸 · WHERE 원래 값 · audit 'name_fix_dict' · 기록 먼저 쓰고 COMMIT).
 *
 * 실행 (제이 PC · meokseon-server 폴더):
 *   node scripts/96-name-fix-dict.js              미리보기(읽기 전용) → .tmp/s76/96_preview_<날짜시각>.csv
 *   node scripts/96-name-fix-dict.js --apply      적용(정답 precision 100% 일 때만)
 *   node scripts/96-name-fix-dict.js --self-test
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* */ }
const fs = require('fs');
const path = require('path');

const VERSION = 'name_fix_dict@1';
const FIELDS = ['product_name', 'manufacturer', 'brand'];
const F = '�';
const PREFIX_LEN = 7;

const oneCharPattern = (s) => new RegExp('^' + String(s).replace(/�+|[^�]/gu, (t) => (t[0] === F ? '.' : t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) + '$', 'u');
const prefixOf = (bc) => (/^\d{8,14}$/.test(String(bc || '')) ? String(bc).slice(0, PREFIX_LEN) : null);

/**
 * 순수 함수.
 * broken = {product_id, barcode, field, old}
 * scope = { byPrefix: Map(prefix → Map(field → Set(clean values))), global: Map(field → Set(clean values)) }
 */
function planOne(broken, scope) {
  const v = String(broken.old);
  const base = { ...broken, new: null, stage: '' };
  const known = [...v].filter((ch) => ch !== F).length;
  if (known < 2) return { ...base, action: 'hold', reason: '확정 글자 2자 미만' };
  const re = oneCharPattern(v);
  const pick = (set) => [...(set || [])].filter((x) => re.test(x));
  const ok = (c) => known / [...c].length >= 0.5;
  const pre = prefixOf(broken.barcode);
  const local = pre ? pick((scope.byPrefix.get(pre) || new Map()).get(broken.field)) : [];
  if (local.length === 1 && ok(local[0])) return { ...base, action: 'fix', new: local[0], stage: 'prefix', reason: '' };
  if (local.length > 1) return { ...base, action: 'hold', reason: `회사 접두 후보 ${local.length}개(${local.slice(0, 3).join(' / ')})` };
  if (broken.field === 'product_name') return { ...base, action: 'hold', reason: '회사 접두 안에 일치 없음(제품명은 전체 사전 금지)' };
  const glob = pick(scope.global.get(broken.field));
  if (glob.length === 1 && ok(glob[0])) return { ...base, action: 'fix', new: glob[0], stage: 'global', reason: '' };
  if (glob.length > 1) return { ...base, action: 'hold', reason: `전체 사전 후보 ${glob.length}개(${glob.slice(0, 3).join(' / ')})` };
  return { ...base, action: 'hold', reason: '일치 없음' };
}

function scoreGold(plans, gold) {
  const byKey = new Map(plans.map((p) => [`${p.product_id}|${p.field}`, p]));
  let fixed = 0, right = 0; const wrong = [];
  for (const g of gold.items) {
    const p = byKey.get(`${g.product_id}|${g.field}`);
    if (!p || p.action !== 'fix') continue;
    fixed++;
    if (p.new === g.answer) right++; else wrong.push(`${g.old} → ${p.new} (정답 ${g.answer})`);
  }
  return { n: gold.items.length, fixed, right, wrong, precision: fixed ? right / fixed : 1, recall: right / gold.items.length };
}

async function applyFixes(c, fixes, rec, actor) {
  for (const x of fixes) {
    if (x.action !== 'fix') continue;
    if (!FIELDS.includes(x.field)) throw new Error(`허용되지 않은 칸: ${x.field}`);
    const r = await c.query(`UPDATE products SET ${x.field} = $2 WHERE product_id = $1 AND ${x.field} = $3 RETURNING product_id`, [x.product_id, x.new, x.old]);
    if (r.rows.length !== 1) throw new Error(`값이 미리보기 뒤 바뀜(product_id ${x.product_id} · ${x.field}) — 전체 롤백`);
    const a = await c.query(`INSERT INTO product_entity_audit (entity_id, product_id, action, before_json, after_json, classifier_version, eval_version, actor)
      VALUES (NULL, $1, 'name_fix_dict', $2, $3, $4, $5, $6) RETURNING audit_id`,
      [x.product_id, JSON.stringify({ [x.field]: x.old }), JSON.stringify({ [x.field]: x.new, stage: x.stage }), VERSION, rec.batch, actor]);
    rec.fixes.push({ product_id: x.product_id, field: x.field, old: x.old, new: x.new, stage: x.stage });
    rec.audits.push(Number(a.rows[0].audit_id));
  }
}

async function undoBatch(c, rec) {
  let n = 0;
  for (const x of rec.fixes) {
    if (!FIELDS.includes(x.field)) throw new Error(`허용되지 않은 칸: ${x.field}`);
    n += (await c.query(`UPDATE products SET ${x.field} = $2 WHERE product_id = $1 AND ${x.field} = $3 RETURNING product_id`, [x.product_id, x.old, x.new])).rows.length;
  }
  await c.query(`UPDATE product_entity_audit SET undone_at = now() WHERE audit_id = ANY($1::bigint[])`, [rec.audits]);
  if (n !== rec.fixes.length) throw new Error(`기록과 수가 다름(${n}/${rec.fixes.length}) — 되돌리기 중단`);
  return { reverted: n };
}

if (require.main === module && process.argv.includes('--self-test')) {
  let ok = 0, bad = 0;
  const eq = (a, b, n) => { const s = JSON.stringify(a) === JSON.stringify(b); s ? ok++ : bad++; console.log(`  ${s ? '✅' : '❌'} ${n}${s ? '' : `\n     기대 ${JSON.stringify(b)}\n     실제 ${JSON.stringify(a)}`}`); };
  const S = (pre, glob) => ({ byPrefix: new Map(Object.entries(pre).map(([k, v]) => [k, new Map(Object.entries(v).map(([f, a]) => [f, new Set(a)]))])), global: new Map(Object.entries(glob).map(([f, a]) => [f, new Set(a)])) });
  const B = (field, old, bc = '8801045000001') => ({ product_id: 1, barcode: bc, field, old });
  const sc = S({ 8801045: { manufacturer: ['주식회사 오뚜기', '오뚜기라면(주)'], product_name: ['새우탕큰사발면', '새우탕큰사발'] } },
    { manufacturer: ['주식회사 오뚜기', '(주)샤니', '(주)샤인', '롯데칠성음료(주)'] });
  let p = planOne(B('manufacturer', '주식회��� 오뚜기'), sc); eq([p.action, p.new, p.stage], ['fix', '주식회사 오뚜기', 'prefix'], 'd1 회사 접두 · ��� = 1글자');
  p = planOne(B('manufacturer', '롯데칠성음료(��)'), sc); eq([p.action, p.new, p.stage], ['fix', '롯데칠성음료(주)', 'global'], 'd2 접두에 없으면 전체 사전');
  p = planOne(B('manufacturer', '(주)샤��'), sc); eq([p.action, p.reason.startsWith('전체 사전 후보 2개')], ['hold', true], 'd3 전체 후보 둘 → hold');
  p = planOne(B('product_name', '새우탕큰사���면'), sc); eq([p.action, p.new], ['fix', '새우탕큰사발면'], 'd4 제품명 접두 안');
  p = planOne(B('product_name', '롯데칠성음료(�)'), sc); eq(p.reason, '회사 접두 안에 일치 없음(제품명은 전체 사전 금지)', 'd5 제품명은 전체 사전 금지');
  p = planOne(B('manufacturer', '주식회사 오��기', 'ABC'), sc); eq([p.action, p.stage], ['fix', 'global'], 'd6 바코드가 숫자 아님 → 접두 없이 전체');
  p = planOne(B('manufacturer', '오�'), sc); eq(p.reason, '확정 글자 2자 미만', 'd7 확정 글자 부족');
  p = planOne(B('manufacturer', '주식회� 오뚜기라면'), sc); eq(p.action, 'hold', 'd8 1글자 규칙 — 길이 다른 후보와 안 맞음');
  eq(scoreGold([{ product_id: 1, field: 'manufacturer', action: 'fix', new: 'A' }, { product_id: 2, field: 'manufacturer', action: 'fix', new: 'X' }, { product_id: 3, field: 'manufacturer', action: 'hold' }],
    { items: [{ product_id: 1, field: 'manufacturer', answer: 'A', old: 'a' }, { product_id: 2, field: 'manufacturer', answer: 'B', old: 'b' }, { product_id: 3, field: 'manufacturer', answer: 'C', old: 'c' }] }).precision, 0.5, 'd9 정답 채점 precision');
  console.log(`\nself-test: ${ok} 통과 · ${bad} 실패`);
  process.exit(bad ? 1 : 0);
}

module.exports = { planOne, scoreGold, applyFixes, undoBatch, oneCharPattern, prefixOf, VERSION, FIELDS };

async function main() {
  const { Pool } = require('pg');
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const APPLY = process.argv.includes('--apply');
  const UNDO = arg('--undo');
  const ACTOR = arg('--actor') || '김재환';
  const DIR = path.resolve(__dirname, '../../.tmp/s76');
  const GOLD = path.resolve(__dirname, '../../IP/eval_name_fix_v1/gold_v1.json');
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
      const bf = path.join(DIR, `96_batch_${UNDO}.json`);
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
    console.log(`[${APPLY ? '적용' : '미리보기 · 읽기 전용'}] 깨진 이름 복구 2단계(회사 접두 · 전체 사전)`);
    const t0 = Date.now(); const lap = (s) => console.log(`  … ${s} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    // 1) 깨진 칸
    const brokenRows = (await pool.query(`SELECT product_id, barcode, product_name, manufacturer, brand FROM products
      WHERE is_active AND (strpos(product_name, U&'\\FFFD') > 0 OR strpos(manufacturer, U&'\\FFFD') > 0 OR strpos(brand, U&'\\FFFD') > 0)`)).rows;
    const broken = [];
    for (const r of brokenRows) for (const f of FIELDS) if (r[f] && String(r[f]).includes(F)) broken.push({ product_id: Number(r.product_id), barcode: r.barcode, field: f, old: String(r[f]) });
    lap(`깨진 칸 ${broken.length}`);
    // 2) 회사 접두 범위의 깨끗한 값
    const prefixes = [...new Set(broken.map((b) => prefixOf(b.barcode)).filter(Boolean))];
    const byPrefix = new Map();
    if (prefixes.length) {
      const rows = (await pool.query(`SELECT left(barcode, ${PREFIX_LEN}) AS pre, product_name, manufacturer, brand FROM products
        WHERE is_active AND left(barcode, ${PREFIX_LEN}) = ANY($1::text[])`, [prefixes])).rows;
      for (const r of rows) {
        if (!byPrefix.has(r.pre)) byPrefix.set(r.pre, new Map(FIELDS.map((f) => [f, new Set()])));
        for (const f of FIELDS) if (r[f] && !String(r[f]).includes(F)) byPrefix.get(r.pre).get(f).add(String(r[f]));
      }
    }
    lap(`회사 접두 ${prefixes.length}`);
    // 3) 전체 사전(제조사·브랜드만)
    const global = new Map([['manufacturer', new Set()], ['brand', new Set()]]);
    for (const f of ['manufacturer', 'brand']) {
      const rows = (await pool.query(`SELECT DISTINCT ${f} AS v FROM products WHERE is_active AND ${f} IS NOT NULL AND btrim(${f}) <> '' AND strpos(${f}, U&'\\FFFD') = 0`)).rows;
      for (const r of rows) global.get(f).add(String(r.v));
    }
    lap(`전체 사전 제조사 ${global.get('manufacturer').size} · 브랜드 ${global.get('brand').size}`);
    const plans = broken.map((b) => planOne(b, { byPrefix, global }));
    const tally = {};
    for (const x of plans) { const k = `${x.field}|${x.action}${x.stage ? '|' + x.stage : ''}${x.reason ? '|' + x.reason.replace(/\(.*$/, '').replace(/\d+개/, 'N개') : ''}`; tally[k] = (tally[k] || 0) + 1; }
    for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(48)} ${v.toLocaleString()}`);
    const gold = JSON.parse(fs.readFileSync(GOLD, 'utf8'));
    const s = scoreGold(plans, gold);
    console.log(`정답(eval_name_fix_v1 · ${s.n}칸): 고침 ${s.fixed} · 정답 일치 ${s.right} · precision ${(s.precision * 100).toFixed(1)}% · recall ${(s.recall * 100).toFixed(1)}%`);
    for (const w of s.wrong) console.log(`  ✗ ${w}`);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const csvCell = (v) => { const t = v == null ? '' : String(v).replace(/\r?\n/g, ' '); return /[",]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const cols = ['product_id', 'barcode', 'field', 'action', 'stage', 'reason', 'old', 'new'];
    const f = path.join(DIR, `96_preview_${stamp}.csv`);
    fs.writeFileSync(f, '﻿' + [cols.join(','), ...plans.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n'));
    console.log(`미리보기 파일: ${f}`);
    if (!APPLY) { console.log('※ 쓰기 없음.'); return; }
    if (s.precision < 1) throw new Error('정답 precision 100% 아님 — 적용 거부(틀린 복구 0 이 합격선)');

    const batch = `namefixdict_${stamp}`;
    const rec = { batch, version: VERSION, actor: ACTOR, at: new Date().toISOString(), gold: s, fixes: [], audits: [] };
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await applyFixes(c, plans, rec, ACTOR);
      const bf = path.join(DIR, `96_batch_${batch}.json`);
      fs.writeFileSync(bf, JSON.stringify(rec, null, 1));
      await c.query('COMMIT');
      console.log(`\n✅ 적용 완료 — 배치 ${batch} · 복구 ${rec.fixes.length}칸`);
      console.log(`기록: ${bf}`);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  } finally { await pool.end(); }
}
if (require.main === module && !process.argv.includes('--self-test')) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
