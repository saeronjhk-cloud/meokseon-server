/**
 * 19-apply-haccp.js — HACCP 확보분 적재 (기본 DRY-RUN)
 *
 * 입력:
 *   - scripts/output/haccp_flagship_probe.json  (17: 대표 바코드 exact 8건)
 *   - scripts/output/haccp_crossmatch.json      (18: 교차 exact 86건)
 *
 * 3중 게이트 (안전정보 앱 — 정밀도 우선):
 *   G1 바코드 exact (이미 충족)
 *   G2 이름 유사도: 정규화 후 포함관계 OR bigram Dice >= 0.45
 *   G3 제조사 토큰 겹침 (G2가 Dice 0.45~0.6 경계면 필수, 그 외 참고)
 *   → 탈락분은 REJECTED로 기록만 (환타↔닥터페퍼 류 오탐 차단)
 *
 * 반영 (--commit 시, 트랜잭션):
 *   - product_ingredients 없음 → INSERT (source='haccp_api')
 *   - 있으나 부실(raw_text < 60자) & HACCP rawmtrl > 100자 → UPDATE (기존값 JSON 백업 후)
 *   - 있고 충실 → SKIP (기록만)
 *   - allergy 파싱 → product_allergens 적재 (스키마 introspect 후, 미지 스키마면 건너뛰고 보고)
 *
 * Eval (dry-run에 항상 출력):
 *   - 신라면: HACCP rawmtrl vs 공식 라벨(flagship_labels_pilot.json) 토큰 대조
 *
 * 실행: run-19-apply.bat (dry-run) → 로그 검수 → run-19-apply-commit.bat
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { buildAllergenUpsert } = require('./lib/allergenUpsert');

const COMMIT = process.argv.includes('--commit');
const pool = new Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } }
  : { host: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 5432), database: process.env.DB_NAME || 'meokseon', user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || '' });

const out = (p) => path.join(__dirname, 'output', p);
const normName = (s) => (s || '').toString().toLowerCase().replace(/\(주\)|주식회사|㈜|\s|\.|,|·|&|%/g, '');
const bigrams = (s) => { const r = new Set(); for (let i = 0; i < s.length - 1; i++) r.add(s.slice(i, i + 2)); return r; };
const dice = (a, b) => {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
};
const mfrOverlap = (a, b) => {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return false;
  return na.includes(nb.slice(0, 4)) || nb.includes(na.slice(0, 4)) || dice(na, nb) >= 0.4;
};
const parseAllergy = (s) => {
  if (!s || /알수없음|없음|해당없음/.test(s)) return [];
  return s.replace(/함유|포함/g, '').split(/[,·\/|]/).map(x => x.trim()).filter(x => x && x.length <= 15);
};

function collectCandidates() {
  const probe = JSON.parse(fs.readFileSync(out('haccp_flagship_probe.json'), 'utf-8'));
  const cross = JSON.parse(fs.readFileSync(out('haccp_crossmatch.json'), 'utf-8'));
  const cands = [];
  for (const r of probe.results) {
    if (r.status === 'BARCODE_MATCH' && r.matched && r.matched.rawmtrl && r.matched.rawmtrl.length > 20) {
      cands.push({ src: 'probe17', flagKey: r.key, product_id: r.product_id, barcode: r.barcode,
        haccp_name: r.matched.prdlstNm, haccp_mfr: r.matched.manufacture, reportNo: r.matched.prdlstReportNo,
        rawmtrl: r.matched.rawmtrl, allergy: r.matched.allergy });
    }
  }
  for (const m of cross.matches) {
    if (m.rawmtrl && m.rawmtrl.length > 20) {
      cands.push({ src: 'cross18', flagKey: m.flagKey, product_id: m.product_id, barcode: m.barcode,
        db_name: m.db_name, db_mfr: m.db_mfr,
        haccp_name: m.haccp_name, haccp_mfr: m.haccp_mfr, reportNo: m.haccp_reportNo,
        rawmtrl: m.rawmtrl, allergy: m.allergy });
    }
  }
  // product_id 중복 → rawmtrl 가장 긴 것 채택
  const byPid = new Map();
  for (const c of cands) {
    const prev = byPid.get(c.product_id);
    if (!prev || (c.rawmtrl || '').length > (prev.rawmtrl || '').length) byPid.set(c.product_id, c);
  }
  return [...byPid.values()];
}

async function main() {
  console.log('\n====== HACCP 적재 (' + (COMMIT ? 'COMMIT' : 'DRY-RUN') + ') ======');
  const m = await pool.query('SELECT current_database() db');
  console.log('DB: ' + m.rows[0].db + (COMMIT ? '' : ' | 쓰기 없음') + '\n');

  const cands = collectCandidates();
  console.log(`고유 product 후보: ${cands.length}건\n`);

  // DB 현재 상태 로드 (이름/제조사/원재료)
  const pids = cands.map(c => c.product_id);
  const { rows: dbRows } = await pool.query(`
    SELECT p.product_id, p.product_name, p.manufacturer,
           pi.id AS pi_id, pi.raw_text
    FROM products p
    LEFT JOIN product_ingredients pi ON pi.product_id = p.product_id
    WHERE p.product_id = ANY($1)`, [pids]);
  const dbMap = new Map(dbRows.map(r => [r.product_id, r]));

  // ── 게이트 적용 ──
  const plan = { insert: [], update: [], skip: [], rejected: [] };
  for (const c of cands) {
    const db = dbMap.get(c.product_id);
    if (!db) { plan.rejected.push({ ...c, reason: 'DB에 product 없음' }); continue; }
    const dbName = db.product_name, dbMfr = db.manufacturer;

    const nA = normName(dbName), nB = normName(c.haccp_name);
    const d = dice(nA, nB);
    const contained = nA.includes(nB) || nB.includes(nA);
    const mfrOk = mfrOverlap(dbMfr, c.haccp_mfr);

    let pass = false, gateNote = `dice=${d.toFixed(2)} contained=${contained} mfr=${mfrOk}`;
    if (contained || d >= 0.6) pass = true;
    else if (d >= 0.45 && mfrOk) pass = true;

    if (!pass) { plan.rejected.push({ pid: c.product_id, db_name: dbName, haccp_name: c.haccp_name, gateNote }); continue; }

    const item = {
      product_id: c.product_id, db_name: dbName, haccp_name: c.haccp_name, gateNote,
      reportNo: c.reportNo, rawmtrl: c.rawmtrl, allergy: c.allergy, allergens: parseAllergy(c.allergy),
      old_raw: db.raw_text ?? null, pi_id: db.pi_id ?? null,
    };
    if (db.raw_text == null) plan.insert.push(item);
    else if (db.raw_text.length < 60 && c.rawmtrl.length > 100) plan.update.push(item);
    else plan.skip.push(item);
  }

  console.log('── 계획 ──');
  console.log(`INSERT(원재료 신규): ${plan.insert.length} | UPDATE(부실→전성분): ${plan.update.length} | SKIP(기존 충실): ${plan.skip.length} | REJECTED(게이트 탈락): ${plan.rejected.length}\n`);
  for (const x of plan.insert) console.log(`  [INS] ${x.product_id} ${x.db_name} <= ${x.haccp_name} (${x.rawmtrl.length}자, 알레르기 ${x.allergens.length})`);
  for (const x of plan.update) console.log(`  [UPD] ${x.product_id} ${x.db_name} <= ${x.haccp_name} (${(x.old_raw || '').length}자→${x.rawmtrl.length}자) 기존:"${(x.old_raw || '').slice(0, 40)}"`);
  for (const x of plan.rejected) console.log(`  [REJ] ${x.pid || ''} ${x.db_name || ''} vs ${x.haccp_name || ''} | ${x.gateNote || x.reason}`);

  // ── 알레르기 스키마 introspect ──
  const { rows: cols } = await pool.query(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name = 'product_allergens' ORDER BY ordinal_position`);
  console.log('\nproduct_allergens 스키마: ' + (cols.length ? cols.map(c => c.column_name + '(' + c.data_type + ')').join(', ') : '테이블 없음'));
  const colNames = cols.map(c => c.column_name);
  const allergenMode = colNames.includes('allergen_name') ? 'name'
    : (colNames.includes('allergen_id') ? 'fk' : (cols.length ? 'unknown' : 'missing'));
  let allergenMaster = new Map();
  if (allergenMode === 'fk') {
    try {
      const { rows: al } = await pool.query('SELECT * FROM allergens');
      const idCol = Object.keys(al[0] || {}).find(k => /allergen_id|^id$/.test(k));
      const nmCol = Object.keys(al[0] || {}).find(k => /name/.test(k));
      for (const a of al) allergenMaster.set(normName(a[nmCol]), a[idCol]);
      console.log(`allergens 마스터: ${al.length}종`);
    } catch (e) { console.log('allergens 마스터 조회 실패: ' + e.message); }
  }
  const allergenRows = [];
  for (const x of [...plan.insert, ...plan.update, ...plan.skip]) {
    for (const a of x.allergens) {
      if (allergenMode === 'fk') {
        const id = allergenMaster.get(normName(a));
        if (id != null) allergenRows.push({ product_id: x.product_id, allergen_id: id, name: a });
      } else if (allergenMode === 'name') {
        allergenRows.push({ product_id: x.product_id, allergen_name: a });
      }
    }
  }
  console.log(`알레르기 적재 예정: ${allergenRows.length}행 (mode=${allergenMode})`);

  // ── Eval: 신라면 HACCP vs 공식 라벨 ──
  try {
    const pilot = JSON.parse(fs.readFileSync(out('flagship_labels_pilot.json'), 'utf-8'));
    const shin = pilot.items.find(i => i.key === '신라면');
    const shinH = cands.find(c => c.flagKey === '신라면');
    if (shin && shinH) {
      const tok = (s) => new Set(s.split(/[,、\/()\[\]{}:·]+/).map(t => normName(t)).filter(t => t.length >= 2));
      const L = tok(shin.raw_text), H = tok(shinH.rawmtrl);
      let inter = 0; for (const t of L) if (H.has(t)) inter++;
      console.log('\n── Eval: 신라면 (공식 라벨 vs HACCP) ──');
      console.log(`라벨 토큰 ${L.size} | HACCP 토큰 ${H.size} | 교집합 ${inter} (라벨 대비 ${(100 * inter / L.size).toFixed(0)}%)`);
      console.log(`라벨에만: ${[...L].filter(t => !H.has(t)).slice(0, 8).join(', ')}`);
      console.log(`HACCP에만: ${[...H].filter(t => !L.has(t)).slice(0, 8).join(', ')}`);
    }
  } catch (e) { console.log('eval 생략: ' + e.message); }

  if (!COMMIT) {
    fs.writeFileSync(out('haccp_apply_plan.json'), JSON.stringify({ generated_at: new Date().toISOString(), plan, allergen_mode: allergenMode, allergen_rows: allergenRows.length }, null, 2), 'utf-8');
    console.log('\n※ DRY-RUN 종료. 계획 저장: scripts/output/haccp_apply_plan.json');
    console.log('   검수 후 반영: run-19-apply-commit.bat');
    await pool.end();
    return;
  }

  // ── COMMIT ──
  // 기존값 백업 먼저 (파일)
  fs.writeFileSync(out(`haccp_apply_backup_${Date.now()}.json`), JSON.stringify({ updates: plan.update.map(x => ({ product_id: x.product_id, pi_id: x.pi_id, old_raw: x.old_raw })) }, null, 2), 'utf-8');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let ins = 0, upd = 0, alg = 0;
    for (const x of plan.insert) {
      await client.query(
        `INSERT INTO product_ingredients (product_id, raw_text, prdlst_report_no, source) VALUES ($1,$2,$3,'haccp_api')
         ON CONFLICT DO NOTHING`, [x.product_id, x.rawmtrl, x.reportNo || null]);
      ins++;
    }
    for (const x of plan.update) {
      await client.query(
        `UPDATE product_ingredients SET raw_text=$2, prdlst_report_no=COALESCE($3, prdlst_report_no), source='haccp_api' WHERE product_id=$1`,
        [x.product_id, x.rawmtrl, x.reportNo || null]);
      upd++;
    }
    // 알레르기: SAVEPOINT로 분리 — 실패해도 원재료 반영은 유지
    await client.query('SAVEPOINT sp_allergen');
    try {
      if (allergenMode === 'fk') {
        // fk 스키마는 운영에 존재하지 않는다(운영은 allergen_name 방식).
        // 승격 대상 컬럼(detected_via)도 없으므로 DO NOTHING 을 유지한다.
        for (const r of allergenRows) {
          await client.query(`INSERT INTO product_allergens (product_id, allergen_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [r.product_id, r.allergen_id]);
          alg++;
        }
      } else if (allergenMode === 'name') {
        // ★ 세션47 3차검증 중대2 — DO NOTHING 이면 크라우드 merge 행이 먼저 있을 때
        //   detected_via 가 'crowdsource_merge' 로 남아 다음 merge 의 DELETE 에 지워진다.
        //   공적 출처가 크라우드 출처를 승격한다. 근거는 scripts/lib/allergenUpsert.js 주석.
        for (const r of allergenRows) {
          await client.query(buildAllergenUpsert(colNames), [r.product_id, r.allergen_name]);
          alg++;
        }
      }
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT sp_allergen');
      alg = 0;
      console.log('⚠ 알레르기 적재 실패(원재료 반영은 유지): ' + e.message);
    }
    await client.query('COMMIT');

    // merge_log는 트랜잭션 밖에서 (프로덕션에 테이블 부재 — 실패해도 무해)
    try {
      await pool.query(`INSERT INTO merge_log (step, status, source_table, target_product_id, detail) VALUES ('step19_haccp_apply','matched','haccp_api',NULL,$1)`,
        [JSON.stringify({ insert: ins, update: upd, allergens: alg })]);
    } catch (e) { console.log('(merge_log 기록 건너뜀: ' + e.message.slice(0, 50) + ')'); }

    // 커밋 후 자체 검증 (반영 실존 확인)
    const v1 = await pool.query(`SELECT count(*) c FROM product_ingredients WHERE source='haccp_api'`);
    const v2 = await pool.query(`SELECT count(*) c FROM product_allergens`);
    const v3 = await pool.query(`SELECT length(raw_text) l FROM product_ingredients WHERE product_id=86838`);
    console.log(`\n✅ 반영 완료: INSERT ${ins} | UPDATE ${upd} | 알레르기 ${alg}`);
    console.log(`[검증] haccp_api 행: ${v1.rows[0].c} | product_allergens: ${v2.rows[0].c}행 | 신라면 raw_text: ${v3.rows[0] ? v3.rows[0].l : '-'}자`);
    if (Number(v1.rows[0].c) === 0) console.log('⚠ 검증 실패 — 반영이 유실됨. 원인 추가 조사 필요.');
    console.log('다음: node scripts/merge/07b-rematch-additives-v2.js --commit  → node scripts/13-flagship-audit.js');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ ROLLBACK: ' + e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

// 감사·회귀에서 parseAllergy 를 「그대로」 재사용할 수 있도록 export 한다.
// (사본을 만들면 감사 대상과 실제 코드가 갈라진다 — 반드시 이 함수 자체를 쓸 것)
module.exports = { parseAllergy };

if (require.main === module) {
  main().catch(async (e) => { console.error('오류:', e.message); try { await pool.end(); } catch (_) {} process.exit(1); });
}
