/**
 * 26-apply-haccp-dump.js — HACCP 전체 덤프 게이트 통과분 적재 (기본 DRY-RUN)
 *
 * 입력:
 *   - output/haccp_dump_overlap.json  (24: 게이트 통과 matches — 텍스트 미포함)
 *   - output/haccp_dump.ndjson        (23: rawmtrl/allergy 본문 재결합용)
 *
 * 게이트: 24에서 G1(바코드 exact)+G2(이름)+G3(제조사) 통과분만 입력됨. 여기서 재검증 1회 더.
 *
 * 반영 (--commit, 트랜잭션):
 *   - product_ingredients 없음 & rawmtrl>20자 → INSERT (source='haccp_api')
 *   - 있으나 부실(<60자) & rawmtrl>100자 → UPDATE (기존값 파일 백업 후)
 *   - 충실 → SKIP (알레르기만 적재)
 *   - allergy 파싱 → product_allergens (스키마 introspect, SAVEPOINT 분리)
 *
 * 교훈 반영(07-02 사고): merge_log는 트랜잭션 밖 + 커밋 후 재조회 검증 필수.
 *
 * Eval (dry-run 출력): SKIP군(기존 충실 원재료 보유) 20개 샘플에서
 *   기존 raw_text vs HACCP rawmtrl 토큰 교집합 측정 — 낮으면(<50%) 적재 중단 권고.
 *
 * 실행: run-26-apply.bat (dry-run) → 로그 검수 → run-26-apply-commit.bat
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Pool } = require('pg');
const { buildAllergenUpsert } = require('./lib/allergenUpsert');

const COMMIT = process.argv.includes('--commit');
const pool = new Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } }
  : { host: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 5432), database: process.env.DB_NAME || 'meokseon', user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || '' });

const out = (p) => path.join(__dirname, 'output', p);
const normBc = (b) => (b || '').toString().replace(/[^0-9]/g, '').replace(/^0+/, '');
const normName = (s) => (s || '').toString().toLowerCase().replace(/\(주\)|주식회사|㈜|\s|\.|,|·|&|%/g, '');
const bigrams = (s) => { const r = new Set(); for (let i = 0; i < s.length - 1; i++) r.add(s.slice(i, i + 2)); return r; };
const dice = (a, b) => {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
};
// ── 알레르겐 파싱 ────────────────────────────────────────────────────────────
// 세션50 수정 3건. 기준선 `.tmp/s50/parse/FINDINGS.md` · 수정 후 `.tmp/s50/parse3/RESULT.md`.
//   ① `/알수없음|없음|해당없음/.test(s)` 가 **부분 일치**라, 라벨 어딘가의 `해당없음` 한 줄이
//      입력 전체를 `[]` 로 만들었다 (전사 014 = 함유 8종 + 혼입 7종이 동시에 사라졌다).
//      → **절(clause) 단위**로만 무효화한다. 「진짜 알레르겐 없음」은 그대로 `[]` 다.
//   ② 구분자가 `, · / |` 4개뿐이라 개행·괄호·마침표·공백이 문장을 자르지 못했고,
//      마지막 알레르겐이 뒤따르는 안내문을 통째로 삼킨 뒤 `length <= 15` 에 버려졌다
//      (L1 의 84~90%. 잣 검출률 52% · 전사 031 은 우유 제품에서 우유 소실 · 전사 013 은 16자).
//      → 문장·라벨항목·괄호·공백까지 분리하고, **길이가 아니라 정본 19종 사전**으로 거른다.
//        길이 필터를 그냥 늘리면 오검출(L4)이 는다. 정밀도는 사전이 맡는다.
//   ③ 정본 이름이 없어 `계란`·`알류`·`달걀`·`조개류(굴` 이 그대로 DB 로 갔다
//      (난류·조개류의 D_raw 검출률 0% / 3.6%). → 정본 19종으로 반환하고 중복을 없앤다.
// ⚠ 반환형은 그대로 `string[]` 이다. 근거 등급(L3)은 여기서 만들지 않는다 —
//   `scripts/lib/allergenUpsert.js` 주석 참조(등급 보정은 76 이 문장을 보고 한다).
// ⚠ `19-apply-haccp.js` 에 **같은 함수**가 있다. 반드시 함께 고칠 것.
//   `tests/test_parse_allergy.js` §0 과 `tests/test_allergen_name_normalize.js:395` 가 동일성을 강제한다.
const { normalizeAllergenNames } = require('../src/services/allergenName');
/** 「알레르겐 없음」 선언 — 절 단위로만 본다. 입력 전체를 무효화하지 않는다. */
const ALLERGY_NONE_RE = /알\s*수\s*없음|해당\s*(?:사항\s*)?없음|없\s*음|없슴/;
/** 절(문장·라벨 항목) 경계. `없음` 판정은 이 단위로 한다. */
const ALLERGY_CLAUSE_RE = /[\r\n.。;；!?！？/／|｜•※▶◆■▲▼★☆◎●○]+/;
/** 절 안의 토큰 경계. 정밀도는 정본 사전이 맡으므로 넉넉히 자른다. */
const ALLERGY_TOKEN_RE = /[\s,，、·ㆍ‧∙:：()（）[\]{}<>「」『』"'“”‘’*+~=%\-–—0-9]+/;
const parseAllergy = (s) => {
  if (!s) return [];
  const out = [];
  const seen = new Set();
  for (const clause of String(s).replace(/함유|포함/g, ' ').split(ALLERGY_CLAUSE_RE)) {
    if (!clause.trim() || ALLERGY_NONE_RE.test(clause)) continue;   // ① 절 단위 무효화
    for (const token of clause.split(ALLERGY_TOKEN_RE)) {           // ② 문장·괄호·공백까지 분리
      if (!token) continue;
      for (const hit of normalizeAllergenNames(token)) {            // ③ 정본 19종으로
        if (!seen.has(hit.name)) { seen.add(hit.name); out.push(hit.name); }
      }
    }
  }
  return out;
};
const tok = (s) => new Set((s || '').split(/[,、\/()\[\]{}:·]+/).map(t => normName(t)).filter(t => t.length >= 2));

async function loadDumpMap() {
  const byKey = new Map(); // reportNo|nbc → item (24와 동일 dedupe: rawmtrl 있는 쪽 우선)
  const rl = readline.createInterface({ input: fs.createReadStream(out('haccp_dump.ndjson')), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let it; try { it = JSON.parse(line); } catch { continue; }
    const key = (it.reportNo || '') + '|' + normBc(it.bc);
    const prev = byKey.get(key);
    if (!prev || (!prev.raw && it.raw)) byKey.set(key, it);
  }
  return byKey;
}

async function main() {
  console.log('\n====== HACCP 덤프 적재 (' + (COMMIT ? 'COMMIT' : 'DRY-RUN') + ') ======');
  const m0 = await pool.query('SELECT current_database() db');
  console.log('DB: ' + m0.rows[0].db + (COMMIT ? '' : ' | 쓰기 없음') + '\n');

  const overlap = JSON.parse(fs.readFileSync(out('haccp_dump_overlap.json'), 'utf-8'));
  const dumpMap = await loadDumpMap();
  console.log(`게이트 통과 matches: ${overlap.matches.length} | 덤프 항목: ${dumpMap.size}`);

  // 본문 재결합 + 게이트 재검증 + product_id 중복 dedupe (rawmtrl 긴 쪽)
  const byPid = new Map();
  let noText = 0, regateFail = 0;
  for (const m of overlap.matches) {
    const it = dumpMap.get((m.reportNo || '') + '|' + m.nbc);
    if (!it || (!it.raw && !it.alg)) { noText++; continue; }
    // 재검증 (24와 동일 기준)
    const d = dice(normName(m.db_name), normName(it.nm));
    const incl = normName(m.db_name).includes(normName(it.nm)) || normName(it.nm).includes(normName(m.db_name));
    if (!((incl || d >= 0.45) && (incl || d >= 0.6 || m.g3))) { regateFail++; continue; }
    const c = {
      product_id: m.product_id, db_name: m.db_name, nbc: m.nbc, reportNo: m.reportNo,
      haccp_name: it.nm, rawmtrl: it.raw || '', allergy: it.alg || null,
      gateNote: `dice=${d.toFixed(2)} incl=${incl} mfr=${m.g3}`,
    };
    const prev = byPid.get(c.product_id);
    if (!prev || c.rawmtrl.length > prev.rawmtrl.length) byPid.set(c.product_id, c);
  }
  const cands = [...byPid.values()];
  console.log(`본문 결합 후보: ${cands.length} (본문없음 ${noText}, 재검증 탈락 ${regateFail})\n`);

  // DB 현재 상태
  const pids = cands.map(c => c.product_id);
  const { rows: dbRows } = await pool.query(`
    SELECT p.product_id, pi.id AS pi_id, pi.raw_text
    FROM products p LEFT JOIN product_ingredients pi ON pi.product_id = p.product_id
    WHERE p.product_id = ANY($1)`, [pids]);
  const dbMap = new Map(dbRows.map(r => [r.product_id, r]));

  // 계획 수립
  const plan = { insert: [], update: [], skip: [] };
  for (const c of cands) {
    const db = dbMap.get(c.product_id);
    if (!db) continue;
    const item = { ...c, allergens: parseAllergy(c.allergy), old_raw: db.raw_text ?? null };
    if (db.raw_text == null && c.rawmtrl.length > 20) plan.insert.push(item);
    else if (db.raw_text != null && db.raw_text.length < 60 && c.rawmtrl.length > 100) plan.update.push(item);
    else plan.skip.push(item);
  }
  console.log('── 계획 ──');
  console.log(`INSERT(원재료 신규): ${plan.insert.length} | UPDATE(부실→전성분): ${plan.update.length} | SKIP(기존 충실/본문 짧음): ${plan.skip.length}`);

  // 알레르기 스키마 introspect (19와 동일)
  const { rows: cols } = await pool.query(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name = 'product_allergens' ORDER BY ordinal_position`);
  const colNames = cols.map(c => c.column_name);
  const allergenMode = colNames.includes('allergen_name') ? 'name'
    : (colNames.includes('allergen_id') ? 'fk' : (cols.length ? 'unknown' : 'missing'));
  let allergenMaster = new Map();
  if (allergenMode === 'fk') {
    const { rows: al } = await pool.query('SELECT * FROM allergens');
    const idCol = Object.keys(al[0] || {}).find(k => /allergen_id|^id$/.test(k));
    const nmCol = Object.keys(al[0] || {}).find(k => /name/.test(k));
    for (const a of al) allergenMaster.set(normName(a[nmCol]), a[idCol]);
  }
  const allergenRows = [];
  for (const x of [...plan.insert, ...plan.update, ...plan.skip]) {
    for (const a of x.allergens) {
      if (allergenMode === 'fk') {
        const id = allergenMaster.get(normName(a));
        if (id != null) allergenRows.push({ product_id: x.product_id, allergen_id: id });
      } else if (allergenMode === 'name') {
        allergenRows.push({ product_id: x.product_id, allergen_name: a });
      }
    }
  }
  console.log(`알레르기 적재 예정: ${allergenRows.length}행 (mode=${allergenMode})\n`);

  // ── Eval: SKIP군(기존 충실 원재료) vs HACCP rawmtrl 토큰 대조 ──
  const evalPool = plan.skip.filter(x => (x.old_raw || '').length >= 100 && x.rawmtrl.length >= 100);
  const sample = evalPool.filter((_, i) => i % Math.max(1, Math.floor(evalPool.length / 20)) === 0).slice(0, 20);
  let evalOk = true;
  if (sample.length >= 5) {
    let sum = 0;
    console.log(`── Eval: 기존 충실 원재료 vs HACCP (${sample.length}개 샘플) ──`);
    for (const x of sample) {
      const L = tok(x.old_raw), H = tok(x.rawmtrl);
      let inter = 0; for (const t of L) if (H.has(t)) inter++;
      const pct = L.size ? 100 * inter / L.size : 0;
      sum += pct;
      if (pct < 40) console.log(`  ⚠ ${x.product_id} ${x.db_name.slice(0, 20)}: 일치 ${pct.toFixed(0)}%`);
    }
    const avg = sum / sample.length;
    console.log(`평균 토큰 일치율: ${avg.toFixed(0)}% ${avg >= 50 ? '(양호)' : '(낮음 — 적재 중단 권고!)'}`);
    evalOk = avg >= 50;
  } else {
    console.log('── Eval: 대조 가능한 SKIP 샘플 부족 (기존 신뢰 소스와 대조 생략) ──');
  }

  if (!COMMIT) {
    fs.writeFileSync(out('haccp_dump_apply_plan.json'), JSON.stringify({
      generated_at: new Date().toISOString(),
      counts: { insert: plan.insert.length, update: plan.update.length, skip: plan.skip.length, allergen_rows: allergenRows.length, allergen_mode: allergenMode },
      eval_ok: evalOk,
      updates_preview: plan.update.slice(0, 50).map(x => ({ pid: x.product_id, name: x.db_name, old: (x.old_raw || '').slice(0, 60), new_len: x.rawmtrl.length })),
      inserts_preview: plan.insert.slice(0, 50).map(x => ({ pid: x.product_id, name: x.db_name, new_len: x.rawmtrl.length })),
    }, null, 2), 'utf-8');
    console.log('\n※ DRY-RUN 종료. 계획 저장: scripts/output/haccp_dump_apply_plan.json');
    console.log('   검수 후 반영: run-26-apply-commit.bat');
    await pool.end();
    return;
  }

  if (!evalOk) {
    console.log('\n❌ Eval 실패 상태로 COMMIT 불가. dry-run 로그의 저일치 샘플을 먼저 조사하세요.');
    await pool.end();
    process.exit(1);
  }

  // ── COMMIT ──
  fs.writeFileSync(out(`haccp_dump_apply_backup_${Date.now()}.json`), JSON.stringify({
    updates: plan.update.map(x => ({ product_id: x.product_id, old_raw: x.old_raw })),
  }, null, 2), 'utf-8');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let ins = 0, upd = 0, alg = 0;
    for (const x of plan.insert) {
      await client.query(
        `INSERT INTO product_ingredients (product_id, raw_text, prdlst_report_no, source) VALUES ($1,$2,$3,'haccp_api')
         ON CONFLICT DO NOTHING`, [x.product_id, x.rawmtrl, x.reportNo || null]);
      ins++;
      if (ins % 200 === 0) console.log(`  INSERT ${ins}/${plan.insert.length}...`);
    }
    for (const x of plan.update) {
      await client.query(
        `UPDATE product_ingredients SET raw_text=$2, prdlst_report_no=COALESCE($3, prdlst_report_no), source='haccp_api' WHERE product_id=$1`,
        [x.product_id, x.rawmtrl, x.reportNo || null]);
      upd++;
      if (upd % 200 === 0) console.log(`  UPDATE ${upd}/${plan.update.length}...`);
    }
    await client.query('SAVEPOINT sp_allergen');
    try {
      for (const r of allergenRows) {
        if (allergenMode === 'fk') {
          // fk 스키마는 운영에 없다(운영은 allergen_name). 승격 대상 컬럼도 없어 DO NOTHING 유지.
          await client.query(`INSERT INTO product_allergens (product_id, allergen_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [r.product_id, r.allergen_id]);
        } else if (allergenMode === 'name') {
          // ★ 세션47 3차검증 중대2 — DO NOTHING 이면 크라우드 merge 행이 먼저 있을 때
          //   detected_via 가 'crowdsource_merge' 로 남아 다음 merge 의 DELETE 에 지워진다.
          //   공적 출처가 크라우드 출처를 승격한다. 근거는 scripts/lib/allergenUpsert.js 주석.
          await client.query(buildAllergenUpsert(colNames), [r.product_id, r.allergen_name]);
        }
        alg++;
        if (alg % 500 === 0) console.log(`  ALLERGEN ${alg}/${allergenRows.length}...`);
      }
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT sp_allergen');
      alg = 0;
      console.log('⚠ 알레르기 적재 실패(원재료 반영은 유지): ' + e.message);
    }
    await client.query('COMMIT');

    // merge_log: 트랜잭션 밖 (07-02 교훈)
    try {
      await pool.query(`INSERT INTO merge_log (step, status, source_table, target_product_id, detail) VALUES ('step26_haccp_dump_apply','matched','haccp_api',NULL,$1)`,
        [JSON.stringify({ insert: ins, update: upd, allergens: alg })]);
    } catch (e) { console.log('(merge_log 기록 건너뜀: ' + e.message.slice(0, 50) + ')'); }

    // 커밋 후 자체 검증 (07-02 교훈: 반영 실존 확인)
    const v1 = await pool.query(`SELECT count(*) c FROM product_ingredients WHERE source='haccp_api'`);
    const v2 = await pool.query(`SELECT count(*) c FROM product_allergens`);
    const sampleIns = plan.insert[0];
    const v3 = sampleIns ? await pool.query(`SELECT length(raw_text) l FROM product_ingredients WHERE product_id=$1`, [sampleIns.product_id]) : { rows: [] };
    console.log(`\n✅ 반영 완료: INSERT ${ins} | UPDATE ${upd} | 알레르기 ${alg}`);
    console.log(`[검증] haccp_api 행: ${v1.rows[0].c} | product_allergens: ${v2.rows[0].c}행 | 샘플(${sampleIns ? sampleIns.product_id : '-'}) raw_text: ${v3.rows[0] ? v3.rows[0].l : '-'}자`);
    if (sampleIns && (!v3.rows[0] || !v3.rows[0].l)) console.log('⚠ 검증 실패 — INSERT 샘플이 조회되지 않음. 원인 조사 필요.');
    console.log('다음: run-20-rematch-and-audit.bat (07b --commit → 13 재측정)');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ ROLLBACK: ' + e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

// 감사·회귀에서 parseAllergy 를 「그대로」 재사용할 수 있도록 export 한다. (19 와 동일)
module.exports = { parseAllergy };

if (require.main === module) {
  main().catch(async (e) => { console.error('오류:', e.message); try { await pool.end(); } catch (_) {} process.exit(1); });
}
