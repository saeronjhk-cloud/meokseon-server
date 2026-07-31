/**
 * 75-dump-production-schema.js — 운영 스키마 덤프 (읽기 전용 · psql 불필요)  2026-07-31 세션46
 * ============================================================================
 * 왜 필요한가 —
 *   세션46 이 발견한 것: **마이그레이션 파일로는 운영 스키마가 재현되지 않는다.**
 *   `nutrition_data(product_id)` UNIQUE 처럼 운영에만 손으로 넣은 것이 최소 8건이다.
 *   다음 세션이 `021_align_schema_with_production_v2.sql` 을 쓰려면
 *   **추정이 아니라 실제 운영 스키마**가 있어야 한다. 없으면 또 추정으로 SQL 을 쓰게 된다.
 *
 * 무엇을 하나 —
 *   ① 주요 테이블의 컬럼 목록 (이름 · 타입 · NULL 허용 · 기본값)
 *   ② 인덱스·제약 전부 (UNIQUE 가 어디에 있는지가 핵심)
 *   ③ ON CONFLICT 타깃이 될 수 있는 UNIQUE 후보 요약
 *   ④ UNIQUE 를 새로 걸기 전에 확인해야 할 **중복 행 수**
 *      ★ 중복이 있으면 CREATE UNIQUE INDEX 가 실패한다. 021 을 쓰기 전에 반드시 본다.
 *
 * 안전 —
 *   - **읽기 전용**으로 접속한다(스타트업 파라미터 + SHOW 로 엔진에 직접 확인).
 *     70·71-probe 와 같은 패턴이다(세션40 §3-3 교훈: connect 핸들러 SET 은 경합한다).
 *   - DB 를 한 글자도 바꾸지 않는다.
 *
 * 실행 (제이 PC — 샌드박스는 Railway Postgres 미접속)
 *   cd "D:\서박사의 영양공식\backends\먹선\meokseon-server"
 *   node scripts/75-dump-production-schema.js
 *
 *   → 콘솔 출력 + `..\IP\production_schema_<날짜>.txt` 파일로 저장된다.
 *     다음 세션은 그 파일만 읽으면 된다. **재조사 불필요.**
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// 세션46 §5 가 지목한 테이블 + 알레르기 경로
const TABLES = [
  'products', 'nutrition_data', 'nutrition_traffic_light', 'product_allergens',
  'product_ingredients', 'product_additives', 'additives', 'contributions', 'users',
];

// UNIQUE 를 새로 걸기 전에 중복을 세야 하는 곳 (세션46 §5-5)
const UNIQUE_CANDIDATES = [
  ['nutrition_data', 'product_id'],
  ['nutrition_traffic_light', 'product_id'],
  ['users', 'firebase_uid'],
  ['product_allergens', 'product_id, allergen_name'],
  ['product_additives', 'product_id, additive_id'],
];

const out = [];
function say(line = '') { out.push(line); console.log(line); }

function makePool() {
  const base = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL,
        ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } }
    : { host: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 5432),
        database: process.env.DB_NAME || 'meokseon', user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '' };
  // ★ 읽기 전용을 **스타트업 파라미터**로 건다. connect 핸들러에서 SET 하면 경합한다.
  return new Pool({ ...base, options: '-c default_transaction_read_only=on' });
}

(async () => {
  const pool = makePool();
  try {
    const ro = (await pool.query('SHOW default_transaction_read_only')).rows[0];
    const roVal = ro[Object.keys(ro)[0]];
    if (roVal !== 'on') {
      console.error(`[X] 중단: 읽기 전용이 걸리지 않았다 (default_transaction_read_only = ${roVal})`);
      process.exit(1);
    }
    const dbName = (await pool.query('SELECT current_database() d')).rows[0].d;

    say('='.repeat(78));
    say(`운영 스키마 덤프 — ${dbName}   ${new Date().toISOString()}`);
    say('읽기 전용 확인: default_transaction_read_only = on');
    say('='.repeat(78));

    // ── ① 컬럼 ────────────────────────────────────────────────────────────
    for (const t of TABLES) {
      const exists = (await pool.query(`SELECT to_regclass($1) AS t`, [`public.${t}`])).rows[0].t;
      say('');
      say(`── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`);
      if (!exists) { say('  ⚠ 테이블 없음'); continue; }
      const cols = await pool.query(
        `SELECT column_name, data_type, udt_name, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position`, [t]);
      for (const c of cols.rows) {
        const type = c.data_type === 'USER-DEFINED' ? `${c.udt_name} (enum)` : c.data_type;
        const nn = c.is_nullable === 'NO' ? ' NOT NULL' : '';
        const df = c.column_default ? `  DEFAULT ${c.column_default}` : '';
        say(`  ${c.column_name.padEnd(28)} ${type}${nn}${df}`);
      }
      const idx = await pool.query(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=$1
          ORDER BY indexname`, [t]);
      if (idx.rows.length) {
        say('  [인덱스]');
        for (const i of idx.rows) say(`    ${i.indexdef}`);
      }
      const con = await pool.query(
        `SELECT conname, pg_get_constraintdef(oid) AS def
           FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname`, [t]);
      if (con.rows.length) {
        say('  [제약]');
        for (const c of con.rows) say(`    ${c.conname}: ${c.def}`);
      }
      const cnt = (await pool.query(`SELECT count(*)::bigint n FROM ${t}`)).rows[0].n;
      say(`  [행 수] ${Number(cnt).toLocaleString()}`);
    }

    // ── ② UNIQUE 후보 · 중복 검사 ─────────────────────────────────────────
    say('');
    say('='.repeat(78));
    say('★ UNIQUE 신설 전 중복 검사 (세션46 §5-5 — 중복이 있으면 021 이 실패한다)');
    say('='.repeat(78));
    for (const [t, cols] of UNIQUE_CANDIDATES) {
      const exists = (await pool.query(`SELECT to_regclass($1) AS t`, [`public.${t}`])).rows[0].t;
      if (!exists) { say(`  ${t}(${cols}) : 테이블 없음`); continue; }
      // 컬럼이 실제로 있는지 먼저 확인 (없는 컬럼이면 건너뛴다)
      const names = cols.split(',').map((s) => s.trim());
      const have = (await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 AND column_name = ANY($2::text[])`,
        [t, names])).rows.map((r) => r.column_name);
      if (have.length !== names.length) {
        say(`  ${t}(${cols}) : ⚠ 컬럼 없음 (${names.filter((n) => !have.includes(n)).join(', ')})`);
        continue;
      }
      const dup = await pool.query(
        `SELECT count(*)::bigint n FROM (
           SELECT ${cols} FROM ${t} GROUP BY ${cols} HAVING count(*) > 1) x`);
      const n = Number(dup.rows[0].n);
      const already = (await pool.query(
        `SELECT count(*)::bigint n FROM pg_indexes
          WHERE schemaname='public' AND tablename=$1 AND indexdef LIKE '%UNIQUE%'
            AND indexdef LIKE '%(' || $2 || ')%'`, [t, cols])).rows[0].n;
      const mark = n === 0 ? '✅ 중복 없음' : `❌ 중복 ${n}조 — UNIQUE 를 걸 수 없다. 먼저 정리할 것`;
      say(`  ${t}(${cols})`.padEnd(52) + `${mark}   [기존 UNIQUE ${already}]`);
    }

    // ── ③ 020 적용 여부 ───────────────────────────────────────────────────
    say('');
    say('='.repeat(78));
    const has020 = (await pool.query(
      `SELECT count(*)::bigint n FROM information_schema.columns
        WHERE table_name='product_allergens' AND column_name='evidence_level'`)).rows[0].n;
    say(`★ 마이그레이션 020 적용 여부: ${Number(has020) > 0 ? '✅ 적용됨' : '❌ 미적용'}`);
    if (Number(has020) > 0) {
      const dist = await pool.query(
        `SELECT evidence_level, count(*)::bigint n FROM product_allergens
          GROUP BY 1 ORDER BY 2 DESC`);
      for (const r of dist.rows) say(`    ${r.evidence_level.padEnd(14)} ${Number(r.n).toLocaleString()}`);
    }
    say('='.repeat(78));

    const stamp = new Date().toISOString().slice(0, 10);
    const dest = path.join(__dirname, '..', '..', 'IP', `production_schema_${stamp}.txt`);
    fs.writeFileSync(dest, out.join('\n'), 'utf8');
    console.log(`\n✅ 저장: ${dest}`);
    console.log('   → 다음 세션은 이 파일만 읽으면 된다. 재조사 불필요.');
  } catch (e) {
    console.error('[X] 실패:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
