/**
 * 77-verify-fresh-schema.js — 「빈 DB → 마이그레이션 → 앱이 쓰는 스키마가 전부 있다」 증명
 * ============================================================================
 * 세션47 신설 · 세션48 강화.  실행:  npm run verify:fresh-schema
 *
 * ★ 왜 이 스크립트가 있나
 *   세션46 §5 가 실측한 것: **마이그레이션 파일만으로는 운영 스키마가 재현되지 않는다.**
 *   운영에 손으로 넣고 저장소에 남기지 않은 것이 수십 건이었고, 그 결과
 *     · `ON CONFLICT (product_id)` 대상 UNIQUE 가 없어 크라우드 merge 가 통째로 실패
 *     · `products.image_url` · `additives.e_number` 가 없어 바코드 조회가 전건 500
 *   이 「빈 DB」에서 재현됐다. 그런데 **아무 회귀도 그것을 잡지 못했다.**
 *
 * ★★ 세션48 4차 검증이 이 스크립트에 대해 실측한 것 (= 아래 강화의 이유)
 *   이 검사기를 격리 트리에 복사해 `000_baseline.sql` 을 16종으로 변조하며 EXIT 를 봤다.
 *   **7종만 잡고 9종이 통과**했다. 잡힌 7종은 전부 「`src/` 가 그 **이름**을 문자열로 쓰고 있어서」
 *   잡힌 것이고, **이름이 아니라 성질(타입·NOT NULL·DEFAULT·CHECK·FK·부분UNIQUE·길이)** 을
 *   바꾼 것은 거의 전부 통과했다. 원인은 네 가지였다.
 *
 *   원인1 — `EXPLAIN (GENERIC_PLAN)` 의 원리적 한계.
 *     NOT NULL·CHECK·FK 위반은 플래너가 **원래 못 본다**(실행 시점 검사다).
 *     타입/길이/ENUM 은 「리터럴일 때만」 거부하는데 `src/` 는 값을 전부 `$1…$n` 으로 넘긴다.
 *     `GENERIC_PLAN` 은 파라미터 값을 모른다 → 네 축 모두 `src/` 에 대해 실질 사각지대다.
 *     ⇒ 실행으로만 볼 수 있는 축은 `tests/test_schema_constraints.js` 가 본다(세션48 신설).
 *        이 파일은 **덤프와의 성질 대조(§F)** 로 그 축을 정적으로 덮는다.
 *   원인2 — `walk()` 대상이 `src/` 뿐. `scripts/` 의 SQL 567건·131파일이 검사 밖이었다. → §G
 *   원인3 — `pg_trgm` 부재를 SKIP 으로 처리하고 마지막에 「전건 성립」을 찍었다(가장 큰 거짓 초록).
 *     실측: 이 DB 로 앱을 띄우면 `GET /api/products/search?q=…` 가
 *           `{"code":"42883","message":"function similarity(text, text) does not exist"}` 로 500 이다.
 *     → SKIP 이 아니라 **명시 경고**로 바꾸고, 총평에서 「전건 성립」이라고 말하지 않는다.
 *   원인4 — §B 가 `package.json` 의 **설명문(`_note*`)을 psql 호출로 셌다**(거짓 빨강 방향). → 제외.
 *
 * ★ 무엇을 증명하나 (추정 금지 — 전부 실제로 돌린다)
 *   §A 체인 성립   : package.json 의 `migrate` 가 나열한 SQL 을 **빈 pglite DB 에 그대로** 적용한다.
 *                    한 파일이라도 실패하면 여기서 멈춘다. 두 번 돌려 **멱등성**도 확인한다.
 *   §B 거짓 초록   : package.json 의 모든 psql 호출에 `-v ON_ERROR_STOP=1` 이 있는지 본다.
 *                    ★ `_note*` 키는 **설명문이지 명령이 아니다** — 세지 않는다(세션48).
 *   §C 계획 수립   : src 아래 모든 .js 에서 SQL 문을 전수 추출해 `EXPLAIN (GENERIC_PLAN)` 을 돌린다.
 *   §D ON CONFLICT : 소스에서 `ON CONFLICT (…)` 를 전수 grep 해 대응 UNIQUE 를 pg_index 로 확인한다.
 *                    ★ 세션48: 열 비교를 **집합**으로 바꿨다(Postgres 는 순서 무관하게 추론한다).
 *                    ★ 세션48: `` `${head} ON CONFLICT …` `` 처럼 **INSERT 와 다른 문자열로 쪼개진**
 *                      조각도 잡는다(`scripts/lib/allergenUpsert.js` 가 이 형태다).
 *   §E 컬럼 대조   : INSERT 컬럼 목록 + `alias.column` 참조를 전부 뽑아 information_schema 와 대조.
 *   §F 운영 대조   : `IP/production_schema_2026-07-31.txt` 와 **성질까지** diff —
 *                    타입(format_type) · NOT NULL · DEFAULT(캐스트 정규화) · FK(+ON DELETE) ·
 *                    CHECK · UNIQUE 의 partial predicate.  ★ 세션48 강화의 본체다.
 *   §G scripts/    : `scripts/` 의 SQL 도 훑는다. 단 **경고 등급**이다(§G 머리주석에 근거).
 *   §H 씨드 경로   : `migrate:all` · `migrate:020` 이 가리키는 SQL 도 검사한다.
 *                    003 의 `ON CONFLICT (barcode)` 가 **부분 UNIQUE** 와 안 맞는 것을 잡는다.
 *
 * ★ 종료 코드
 *   0 = 실패 0건 / 1 = 하나라도 실패.  경고는 EXIT 를 바꾸지 않는다(다만 총평에 반드시 실린다).
 *
 * ★ 한계 (거짓 초록을 만들지 않기 위해 명시한다)
 *   - 덤프에 없는 테이블(pulse·staging·import·entity …)은 §F 의 대조 기준이 **없다.**
 *     그 테이블들의 NOT NULL·CHECK·길이·DEFAULT 는 `tests/test_schema_constraints.js` 가
 *     **실제 실행**으로 못 박는다. 이 파일만으로는 그쪽 변조를 잡지 못한다.
 *   - 문자열 보간(`${...}`)이 든 SQL 은 치환해서 검사하므로 「부분 검증」으로 표시된다.
 *   - pglite 는 `pg_trgm` 을 탑재하지 않는다 → §C 말미의 ⚠ 블록을 반드시 읽을 것.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const SCRIPTS = path.join(ROOT, 'scripts');
const PROD_DUMP = path.join(ROOT, '..', 'IP', 'production_schema_2026-07-31.txt');

let failures = 0;
let warnings = 0;
const failList = [];
const warnList = [];

function section(t) { console.log(`\n${'━'.repeat(78)}\n${t}\n${'━'.repeat(78)}`); }
function ok(m) { console.log(`  ✅ ${m}`); }
function bad(m) { failures += 1; failList.push(m); console.log(`  ❌ ${m}`); }
function warn(m) { warnings += 1; warnList.push(m); console.log(`  ⚠  ${m}`); }
function info(m) { console.log(`     ${m}`); }

// ════════════════════════════════════════════════════════════════════════════
// ★★ 알려진 결함 대장 (KNOWN_DEFECTS) — 세션48 신설
//
//   `tests/test_path_parity.js` 의 KNOWN_DIFF 와 **같은 규약**을 쓴다.
//     · 대장에 **없는** 결함이 나오면      → 실패 (새 회귀다)
//     · 대장에 **있고 그대로 재현되면**    → ⚠ 「미해결 결함」으로 보고, 기본 실행은 EXIT 0
//     · 대장에 **있는데 이제 재현 안 되면** → 실패 (**고쳐졌으니 이 줄을 지워라**)
//     · `VERIFY_STRICT=1` 이면 미해결 결함도 실패로 센다 → 고친 뒤 이 모드가 초록이어야 한다
//
//   ★ 왜 이렇게 하나
//     003 은 **동결된 역사**다(고치지 않기로 정해져 있다). 그것을 그냥 실패로 두면
//     `npm run verify:fresh-schema` 가 영원히 빨강이 되고, 그러면 **아무도 안 본다** —
//     이 저장소가 이미 한 번 겪은 실패 방식이다(세션46 「거짓 초록」의 거울상).
//     그래서 「모르는 결함」과 「알고 두기로 한 결함」을 등급으로 나눈다.
//     대장에 올리는 순간 **그 결함이 사라지는 것도 회귀로 감지**된다.
// ════════════════════════════════════════════════════════════════════════════
const KNOWN_DEFECTS = {
  // ── S1 ────────────────────────────────────────────────────────────────────
  // `npm run migrate:all` 이 가리키는 003_seed_products.sql 의
  //   INSERT INTO products … ON CONFLICT (barcode) DO UPDATE
  // baseline·001 의 인덱스는 **부분 UNIQUE**(`WHERE barcode IS NOT NULL`)라
  // 문장에도 같은 술어가 있어야 중재자가 된다 → 지금은 42P10 으로 첫 INSERT 부터 죽는다.
  // ⇒ 저장소가 문서화한 유일한 「씨드 포함 빈 DB」 경로가 성립하지 않는다.
  // 고칠 때: 003 을 고치지 말 것(동결). 씨드가 필요하면
  //          `ON CONFLICT (barcode) WHERE barcode IS NOT NULL` 을 쓰는 새 파일을 만들 것.
  S1: 'scripts/migrations/003_seed_products.sql :: products(barcode) ON CONFLICT 이 부분 UNIQUE 와 불일치',

  // ── S2 ────────────────────────────────────────────────────────────────────
  // S1 과 **같은 뿌리**. `scripts/data-pipeline/mergePublicData.js` 가 .sql 을 **생성**하는데
  // 생성문에 `ON CONFLICT (barcode) DO UPDATE` 를 넣는다(003 이 이 스크립트의 산출물로 보인다).
  // 003 을 고치지 않기로 한 이상 생성기도 그대로 두되, **새로 생성하면 또 깨진다**는 사실을 못 박는다.
  S2: 'scripts/data-pipeline/mergePublicData.js :: 생성되는 SQL 의 products(barcode) ON CONFLICT 이 부분 UNIQUE 와 불일치',
};
const STRICT = process.env.VERIFY_STRICT === '1';
const seenDefects = new Set();
const knownHits = [];
/** 대장에 있으면 ⚠(또는 STRICT 시 실패), 없으면 실패. */
function badOrKnown(id, m) {
  if (!KNOWN_DEFECTS[id]) { bad(m); return; }
  seenDefects.add(id);
  knownHits.push({ id, m });
  if (STRICT) { bad(`[${id} · 대장 등록 · VERIFY_STRICT] ${m}`); return; }
  warnings += 1;
  warnList.push(`[${id} 미해결 결함] ${m}`);
  console.log(`  ⚠  [${id} 미해결 결함 · 대장 등록됨] ${m}`);
}

// ════════════════════════════════════════════════════════════════════════════
// 0. 유틸 — 파일 수집
//    ★ scripts/ 를 훑게 되면서 제외 디렉터리가 필요해졌다.
//      scripts/output 은 73MB 의 로그·CSV 이고 .js 가 없다. node_modules 도 마찬가지다.
// ════════════════════════════════════════════════════════════════════════════
const SKIP_DIRS = new Set(['node_modules', 'output', '.tmp', '.git', 'data', 'logs', 'public']);
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (SKIP_DIRS.has(e.name)) continue; walk(p, acc); }
    else if (e.isFile() && e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. JS 소스에서 문자열 리터럴을 뽑는다 (주석·이스케이프 처리)
//    ★ 정규식 하나로 긁으면 주석 속 SQL 이나 잘린 문자열이 섞인다.
//      그래서 문자 단위로 상태를 따라간다.
// ════════════════════════════════════════════════════════════════════════════
function scanStringLiterals(src) {
  const out = [];
  let i = 0; let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line += 1; i += 1; }
      i += 2; continue;
    }
    if (c === "'" || c === '"') {
      const q = c; const startLine = line; let s = ''; i += 1;
      while (i < n) {
        if (src[i] === '\\') { s += src[i + 1] === 'n' ? '\n' : src[i + 1]; i += 2; continue; }
        if (src[i] === q) { i += 1; break; }
        if (src[i] === '\n') { line += 1; }
        s += src[i]; i += 1;
      }
      out.push({ text: s, line: startLine, tpl: false });
      continue;
    }
    if (c === '`') {
      const startLine = line; let s = ''; i += 1; let depth = 0;
      while (i < n) {
        if (src[i] === '\\') { s += src[i] + src[i + 1]; i += 2; continue; }
        if (depth === 0 && src[i] === '`') { i += 1; break; }
        if (depth === 0 && src[i] === '$' && src[i + 1] === '{') { depth = 1; s += '${'; i += 2; continue; }
        if (depth > 0) {
          if (src[i] === '{') depth += 1;
          else if (src[i] === '}') depth -= 1;
        }
        if (src[i] === '\n') line += 1;
        s += src[i]; i += 1;
      }
      out.push({ text: s, line: startLine, tpl: true });
      continue;
    }
    i += 1;
  }
  return out;
}

const SQL_HEAD = /^\s*(WITH|SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;
function looksLikeSql(t) { return SQL_HEAD.test(t) && /\s/.test(t.trim()); }

/**
 * `${...}` 를 균형 잡힌 괄호까지 찾아 치환한다. `$${...}` 는 파라미터 번호이므로 숫자로 바꾼다.
 * ★ 구멍이 **어디에 뚫렸는지**를 보고 채운다. 한 가지 값으로 전부 채우면
 *   `SELECT a, ${x}, b` 와 `ORDER BY ${y}` 를 동시에 만족시킬 수 없어 멀쩡한 SQL 이
 *   「스키마 결함」으로 잘못 보고된다(= 거짓 빨강). 위치를 보고 문법상 맞는 것을 넣는다.
 * @returns {{sql:string, unresolved:string[]}} unresolved 가 비어 있지 않으면 정적 검증 불가.
 */
function replaceHolesContextual(text, filler, firstColOf) {
  let out = ''; let i = 0;
  const unresolved = [];
  const setHoles = [];
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '{') {
      let depth = 1; let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') depth -= 1;
        j += 1;
      }
      const expr = text.slice(i + 2, j - 1);
      if (out.endsWith('$')) {                                    // `$${n}` → 파라미터 번호
        out += '1';
      } else if (filler !== null) {                               // 강제 필러 모드(폴백)
        out += filler;
      } else {
        const tail = out.replace(/\s+$/, ' ');
        if (/\bSET\s$/i.test(tail)) { setHoles.push(out.length); out += '@@SETHOLE@@'; }
        else if (/\b(WHERE|AND|OR|HAVING|ON)\s$/i.test(tail)) out += 'TRUE';
        else if (/\b(ORDER\s+BY|GROUP\s+BY)\s$/i.test(tail)) out += '';
        else if (/(SELECT|,)\s$/i.test(tail)) out += 'NULL';
        else if (/=\s$/.test(tail)) out += 'NULL';
        else if (/\b(FROM|JOIN|INTO|UPDATE|TABLE)\s$/i.test(tail)) { unresolved.push(expr); out += '@@RELHOLE@@'; }
        else { unresolved.push(expr); out += '@@HOLE@@'; }
      }
      i = j;
      continue;
    }
    out += text[i]; i += 1;
  }
  // SET 구멍은 대상 테이블의 첫 컬럼으로 채운다 (문법만 세우면 된다)
  if (setHoles.length) {
    const m = out.match(/UPDATE\s+([a-z_][a-z0-9_]*)/i);
    const col = m && firstColOf ? firstColOf(m[1].toLowerCase()) : null;
    if (col) out = out.replace(/@@SETHOLE@@/g, `${col} = NULL`);
    else { out = out.replace(/@@SETHOLE@@/g, '@@HOLE@@'); unresolved.push('SET'); }
  }
  return { sql: out, unresolved };
}
function hasHole(text) { return /\$\{/.test(text); }

// ════════════════════════════════════════════════════════════════════════════
// 2. 운영 덤프 파서
//    ★ 세션48: 컬럼명·UNIQUE 열 이름만 읽던 것을 **성질**까지 읽도록 넓혔다.
//      (구현은 4차 검증의 `.tmp/s48/agentE/p2_blindspots.js` 의 parseDump()/normDef() 를 이식했다.
//       그 대조는 실측상 불일치 0건이었다 — 즉 정상 저장소에서는 초록이어야 맞다.)
//
//    덤프 한 줄의 생김새(75-dump-production-schema.js 가 찍는다):
//      `  product_id                   bigint NOT NULL  DEFAULT nextval('products_product_id_seq'::regclass)`
//      `  food_category                food_category (enum)  DEFAULT 'general'::food_category`
//      `  aliases                      ARRAY`                       ← information_schema 의 data_type
//    [인덱스] 절 : `CREATE UNIQUE INDEX idx_products_barcode_unique ON public.products USING btree (barcode) WHERE (barcode IS NOT NULL)`
//    [제약]  절 : `..._fkey: FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE`
//                 `..._chk: CHECK (((evidence_level)::text = ANY (…)))`
//                 `..._not_null: NOT NULL x`   ← 컬럼 절이 이미 담고 있으므로 무시한다
// ════════════════════════════════════════════════════════════════════════════
function parseProductionDump(file) {
  const tables = new Map();
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let cur = null; let mode = 'cols'; let ord = 0;
  for (const raw of lines) {
    const mTable = raw.match(/^──\s+([a-z_][a-z0-9_]*)\s+─/);
    if (mTable) {
      cur = { cols: new Map(), uniques: [], fks: [], checks: [] };
      tables.set(mTable[1], cur); mode = 'cols'; ord = 0; continue;
    }
    if (!cur) continue;
    if (/^\s{2}\[인덱스\]/.test(raw)) { mode = 'idx'; continue; }
    if (/^\s{2}\[제약\]/.test(raw)) { mode = 'con'; continue; }
    if (/^\s{2}\[행 수\]/.test(raw)) { mode = 'done'; continue; }
    if (/^={10,}/.test(raw)) { cur = null; continue; }
    if (mode === 'cols') {
      const m = raw.match(/^\s{2}([a-z_][a-z0-9_]*)\s{2,}(.+?)\s*$/);
      if (m) {
        const rest = m[2];
        const dm = rest.match(/DEFAULT\s+(.*)$/);
        const type = rest
          .replace(/\s*NOT NULL\s*/, ' ')
          .replace(/\s*DEFAULT.*$/, '')
          .replace(/\(enum\)/, '')
          .trim();
        cur.cols.set(m[1], {
          type,
          notnull: /\bNOT NULL\b/.test(rest),
          def: dm ? dm[1].trim() : null,
          ord: (ord += 1),
        });
      }
    } else if (mode === 'idx') {
      // 열 목록은 `[^)]*` 로 잡는다. `(.*)` 로 잡으면 뒤의 `WHERE (…)` 까지 삼켜
      // 「UNIQUE 가 없다」는 거짓 빨강이 난다(세션48 실측).
      const m = raw.match(/CREATE (UNIQUE )?INDEX (\S+) ON public\.\S+ USING (\w+) \(([^)]*)\)(\s+WHERE\s+(.*))?$/);
      if (m && m[1]) {
        cur.uniques.push({
          name: m[2],
          cols: m[4].split(',').map((s) => s.trim().replace(/\s+DESC$/i, '')),
          pred: m[6] || null,
        });
      }
    } else if (mode === 'con') {
      const f = raw.match(/FOREIGN KEY \(([^)]*)\) REFERENCES (\w+)\(([^)]*)\)(.*)$/);
      if (f) cur.fks.push({ cols: f[1], reft: f[2], refc: f[3], extra: f[4].trim() });
      const c = raw.match(/^\s+(\S+): (CHECK \(.*)$/);
      if (c) cur.checks.push({ name: c[1], def: c[2] });
    }
  }
  return tables;
}

/** DEFAULT 식 정규화 — `::type` 캐스트·공백·따옴표를 지운다. 표기만 다르고 같은 것을 구분 못 하게 한다. */
function normDef(d) {
  if (d === null || d === undefined) return null;
  return String(d).replace(/::[a-z_ "\.]+(\[\])?/gi, '').replace(/\s+/g, '').replace(/'/g, '').toLowerCase();
}
/** CHECK·인덱스 술어 정규화 — 캐스트·괄호·공백·따옴표를 지운다. */
function normExpr(d) {
  if (d === null || d === undefined) return null;
  return String(d).replace(/::[a-z_ "\.]+(\[\])?/gi, '').replace(/[()\s]/g, '').replace(/'/g, '').toLowerCase();
}

// ════════════════════════════════════════════════════════════════════════════
// 3. ON CONFLICT 추출기 (세션48 신설 · §D 와 §G 가 공유한다)
//
//    ★ 왜 「문자열마다」가 아니라 「파일 단위 순서」로 보나
//      `scripts/lib/allergenUpsert.js` 는 이렇게 쓴다:
//          const head = `INSERT INTO product_allergens (${cols}) VALUES (${vals})`;
//          return `${head} ON CONFLICT (product_id, allergen_name) DO UPDATE SET …`;
//      두 번째 문자열은 `INSERT` 로 시작하지 않아 looksLikeSql() 이 걸러내고,
//      같은 문자열 안에 `INSERT INTO t` 도 없다. 그래서 기존 §D 가 **전혀 보지 못했다.**
//      구 코드의 `DO NOTHING` 은 UNIQUE 가 없어도 돌지만 이 `DO UPDATE` 는
//      **UNIQUE 가 없으면 문장 자체가 42P10 으로 실패**한다. 사각지대로 둘 수 없다.
//      → 대상 테이블은 「같은 파일에서 **직전에** 나온 INSERT INTO」로 추론하고,
//        추론했다는 사실을 `inferred` 로 표시해 오추론이 눈에 보이게 한다.
// ════════════════════════════════════════════════════════════════════════════
function extractConflicts(literals, file) {
  const out = [];
  let lastTable = null;
  for (const lit of literals) {
    const flat = lit.text.replace(/\s+/g, ' ');
    const im = flat.match(/INSERT\s+INTO\s+([a-z_][a-z0-9_]*)\b/i);
    if (im) lastTable = im[1].toLowerCase();
    const re = /ON\s+CONFLICT\s*\(([^)]*)\)(\s*WHERE\s+[^)]*?)?\s*DO\b/gi;
    let cm;
    while ((cm = re.exec(flat)) !== null) {
      const cols = cm[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (!cols.length) continue;
      out.push({
        file, line: lit.line, table: im ? im[1].toLowerCase() : lastTable,
        cols, partial: !!cm[2], inferred: !im,
      });
    }
    if (/ON\s+CONFLICT\s+ON\s+CONSTRAINT/i.test(flat)) {
      out.push({ file, line: lit.line, table: im ? im[1].toLowerCase() : lastTable, byConstraint: true });
    }
  }
  return out;
}

/**
 * ON CONFLICT 절 ↔ UNIQUE 인덱스 매칭.
 * ★ 세션48: 열 비교를 **집합**으로 한다. Postgres 는 `ON CONFLICT (b, a)` 로도
 *   `UNIQUE (a, b)` 를 중재자로 추론한다. 순서로 비교하면 멀쩡한 코드가 빨강이 된다
 *   (실측: `import_nutrition_product_match(product_id, import_key)` ↔ `imp_match_uq(import_key, product_id)`).
 * ★ 부분 UNIQUE 는 문장에도 술어가 있어야 중재자가 된다 → `c.partial || !u.partial`.
 */
function matchConflict(cands, c) {
  const want = new Set(c.cols);
  return cands.find((u) => u.cols.length === want.size
    && u.cols.every((x) => want.has(x))
    && (c.partial || !u.partial));
}

// ════════════════════════════════════════════════════════════════════════════
// 4. 「그 스크립트가 CREATE 하는가」 — §G 의 allowlist 근거 수집기 (세션48 신설)
//
//    ★ 왜 하드코딩하지 않나
//      4차 검증이 scripts/ 를 훑었을 때 실패 58건이 나왔지만 전수 추적 결과 **실질 결함은 0건**이었다.
//      `merge_log` · `staging_product_report` · `unmatched_nutrition_pool` 은
//      **다른 스크립트가 런타임에 CREATE 하는 작업용 테이블**이다.
//      이름 목록을 상수로 박아 두면 그 목록이 곧 거짓말이 된다(테이블이 사라져도 계속 통과한다).
//      그래서 **저장소 안에서 `CREATE TABLE`/`CREATE VIEW` 하는 파일이 실제로 있는지**를 근거로 삼고,
//      제외할 때 **그 근거 파일 경로를 함께 출력**한다. 근거가 사라지면 자동으로 경고가 살아난다.
//    ★ 컬럼도 같다 — `ALTER TABLE t ADD COLUMN c` 를 스크립트가 직접 하는 경우가 있다
//      (`merge/09b-fast-nutrition-match.js:113` 의 `staging_nutrition.deep_norm_name`).
// ════════════════════════════════════════════════════════════════════════════
function collectCreators(files) {
  const rel = new Map();   // 테이블/뷰 이름 -> [만드는 파일]
  const col = new Map();   // "t.c"        -> [만드는 파일]
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const short = path.relative(ROOT, f).replace(/\\/g, '/');
    const add = (map, key) => {
      const k = key.toLowerCase();
      if (!map.has(k)) map.set(k, []);
      if (!map.get(k).includes(short)) map.get(k).push(short);
    };
    for (const m of text.matchAll(/CREATE\s+(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+|GLOBAL\s+|LOCAL\s+)*TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) add(rel, m[1]);
    for (const m of text.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) add(rel, m[1]);
    for (const m of text.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) add(col, `${m[1]}.${m[2]}`);
  }
  return { rel, col };
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════
(async () => {
  console.log('먹선 — 빈 DB 스키마 성립 검증 (scripts/77-verify-fresh-schema.js)');
  console.log(`실행: ${new Date().toISOString()}`);

  // ──────────────────────────────────────────────────────────────────────────
  section('§B. package.json 의 psql 호출에 -v ON_ERROR_STOP=1 이 있는가 (거짓 초록 제거)');
  // ──────────────────────────────────────────────────────────────────────────
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  // ★ 세션48 — `_note*` 키는 **설명문이지 명령이 아니다.**
  //   `_note:migrate2` 가 "psql 호출에는 반드시 -v ON_ERROR_STOP=1 을 넣을 것" 이라고 쓰여 있어
  //   `psql` 과 `-v ON_ERROR_STOP=1` 을 둘 다 포함한다 → 「통과한 psql 호출」로 집계됐다.
  //   실제 호출은 4건인데 5건으로 세고 있었다(거짓 빨강 방향의 오류라 아무도 못 봤다).
  const psqlCalls = [];
  const skippedNotes = [];
  for (const [name, body] of Object.entries(pkg.scripts || {})) {
    if (typeof body !== 'string') continue;
    if (/^_note/i.test(name)) { if (/\bpsql\b/.test(body)) skippedNotes.push(name); continue; }
    for (const seg of body.split('&&')) {
      if (/\bpsql\b/.test(seg)) psqlCalls.push({ name, seg: seg.trim() });
    }
  }
  if (skippedNotes.length) info(`설명문 키 제외: ${skippedNotes.join(', ')} (psql 문자열을 담고 있지만 명령이 아니다)`);
  if (psqlCalls.length === 0) warn('package.json 에 psql 호출이 없다 (체인이 사라졌는지 확인할 것)');
  let missingStop = 0;
  for (const c of psqlCalls) {
    if (!/-v\s+ON_ERROR_STOP=1/.test(c.seg)) {
      bad(`ON_ERROR_STOP 누락 — scripts.${c.name}: ${c.seg}`);
      missingStop += 1;
    }
  }
  if (missingStop === 0) ok(`psql 호출 ${psqlCalls.length}건 전부 -v ON_ERROR_STOP=1 을 갖고 있다`);

  // ──────────────────────────────────────────────────────────────────────────
  section('§A. migrate 체인을 빈 pglite DB 에 그대로 적용한다');
  // ──────────────────────────────────────────────────────────────────────────
  const chainRaw = pkg.scripts && pkg.scripts.migrate;
  if (!chainRaw) { bad('package.json 에 scripts.migrate 가 없다'); process.exit(1); }
  const chain = [...chainRaw.matchAll(/-f\s+(\S+\.sql)/g)].map((m) => m[1]);
  info(`체인(package.json 에서 읽음): ${chain.map((f) => path.basename(f)).join(' → ')}`);
  if (chain.length === 0) { bad('migrate 체인에서 .sql 파일을 찾지 못했다'); process.exit(1); }

  let PGlite;
  try { ({ PGlite } = require('@electric-sql/pglite')); } catch (e) {
    bad('@electric-sql/pglite 미설치 — 검증 불가 (npm i -D @electric-sql/pglite)');
    process.exit(1);
  }

  const t0 = Date.now();
  const db = new PGlite();                 // ★ 인스턴스는 하나만. 부팅이 가장 비싸다.
  await db.query('SELECT 1');
  info(`pglite 부팅 ${Date.now() - t0}ms · ${(await db.query('SHOW server_version')).rows[0].server_version}`);

  // ★ SQL 을 손대지 않는다. 손대는 순간 「정본을 검증했다」고 말할 수 없다.
  for (const rel of chain) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { bad(`체인 파일 없음: ${rel}`); continue; }
    try {
      await db.exec(fs.readFileSync(p, 'utf8'));
      ok(`적용 성공: ${path.basename(rel)}`);
    } catch (e) {
      bad(`적용 실패: ${path.basename(rel)} → ${e.message}`);
    }
  }
  if (failures > missingStop) {
    console.log('\n체인이 서지 않았다. 이후 검사는 의미가 없으므로 중단한다.');
    process.exit(1);
  }

  // 멱등성 — 같은 체인을 한 번 더
  let idem = true;
  for (const rel of chain) {
    try { await db.exec(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch (e) {
      idem = false; bad(`멱등성 실패(2회차): ${path.basename(rel)} → ${e.message}`);
    }
  }
  if (idem) ok('체인 2회차도 오류 없음 — 멱등하다 (운영에 실수로 돌아가도 무해)');

  // ── 실제 스키마를 읽어 둔다 ────────────────────────────────────────────────
  // ★ 세션48: information_schema.columns 대신 pg_attribute 를 쓴다.
  //   `format_type(atttypid, atttypmod)` 라야 **VARCHAR 길이·NUMERIC 정밀도**가 보인다.
  //   information_schema.data_type 은 `character varying` 까지만 알려주므로
  //   「VARCHAR → VARCHAR(50)」 변조를 원리적으로 못 잡는다(4차 검증 뮤테이션 ⑭).
  const attRows = (await db.query(`
    SELECT c.relname AS tbl, a.attname AS col,
           format_type(a.atttypid, a.atttypmod) AS ftype,
           a.attnotnull AS notnull, a.attnum AS ord, a.attgenerated AS gen,
           pg_get_expr(d.adbin, d.adrelid) AS def
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`)).rows;
  const liveAtt = new Map();               // table -> Map(col -> row)
  for (const r of attRows) {
    if (!liveAtt.has(r.tbl)) liveAtt.set(r.tbl, new Map());
    liveAtt.get(r.tbl).set(r.col, r);
  }
  // 뷰까지 포함한 컬럼 목록 (§E 가 쓴다 — product_nutrition_resolved 같은 뷰를 봐야 한다)
  const colRows = (await db.query(
    `SELECT table_name, column_name, data_type, udt_name
       FROM information_schema.columns WHERE table_schema = 'public'`)).rows;
  const live = new Map();
  for (const r of colRows) {
    if (!live.has(r.table_name)) live.set(r.table_name, new Map());
    live.get(r.table_name).set(r.column_name, r.data_type === 'USER-DEFINED' ? r.udt_name : r.data_type);
  }
  const relKind = new Map((await db.query(
    `SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p')`)).rows.map((r) => [r.relname, r.relkind]));
  info(`생성된 관계: 테이블/뷰 ${relKind.size}개 · 컬럼 ${colRows.length}개`);

  // 제약 (FK · CHECK)
  const liveCon = new Map();
  for (const r of (await db.query(`
    SELECT rel.relname AS tbl, c.contype, c.conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = 'public'`)).rows) {
    if (!liveCon.has(r.tbl)) liveCon.set(r.tbl, []);
    liveCon.get(r.tbl).push(r);
  }

  // UNIQUE 인덱스 목록 (partial 술어 포함)
  const uniqRows = (await db.query(`
    SELECT t.relname AS tbl, i.relname AS idx,
           ix.indpred IS NOT NULL AS partial,
           pg_get_expr(ix.indpred, ix.indrelid) AS pred,
           ARRAY(SELECT a.attname FROM unnest(ix.indkey) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                 ORDER BY k.ord) AS cols
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND ix.indisunique`)).rows;
  const uniquesByTable = new Map();
  for (const r of uniqRows) {
    if (!uniquesByTable.has(r.tbl)) uniquesByTable.set(r.tbl, []);
    uniquesByTable.get(r.tbl).push({ idx: r.idx, cols: r.cols, partial: r.partial, pred: r.pred });
  }

  // ──────────────────────────────────────────────────────────────────────────
  section('§C. src/ 의 SQL 전수 — EXPLAIN (GENERIC_PLAN) 으로 실제 플래너에 통과시킨다');
  // ──────────────────────────────────────────────────────────────────────────
  const srcFiles = walk(SRC).sort();
  const srcLits = new Map();               // file -> literals (§D 가 재사용한다)
  const statements = [];
  for (const f of srcFiles) {
    const srcText = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const lits = scanStringLiterals(srcText);
    srcLits.set(rel, lits);
    for (const lit of lits) {
      if (looksLikeSql(lit.text)) statements.push({ file: rel, line: lit.line, sql: lit.text });
      // 건강 검사 — SQL 키워드가 든 문자열인데 SQL 로 분류되지 않은 것 (스캐너가 잘랐을 수 있다)
      else if (/\b(FROM\s+[a-z_]|INSERT\s+INTO|ON\s+CONFLICT)\b/i.test(lit.text)) {
        warn(`${rel}:${lit.line} — SQL 조각으로 보이는데 문장 시작이 아니라 §C 대상에서 빠졌다 (§D 는 본다)`);
      }
    }
  }
  info(`추출한 SQL 문: ${statements.length}건 (${srcFiles.length}개 파일)`);

  const firstColOf = (t) => { const m = live.get(t); return m ? [...m.keys()][0] : null; };
  const FALLBACK_FILLERS = ['', 'TRUE', 'NULL', '1', "'x'"];
  let cOk = 0; let cPartial = 0; const cSkip = []; const cFail = []; const cTrgm = [];
  for (const st of statements) {
    const body = st.sql.trim().replace(/;\s*$/, '');
    if (/;\s*\S/.test(body)) { cSkip.push({ ...st, msg: '한 문자열에 statement 가 여러 개 — §C 대상 아님' }); continue; }
    const dynamic = hasHole(body);
    const variants = [];
    if (dynamic) {
      const ctx = replaceHolesContextual(body, null, firstColOf);
      if (ctx.unresolved.length === 0) variants.push(ctx.sql);
      else {
        cSkip.push({ ...st, msg: `동적 SQL — 정적으로 세울 수 없다 (미해결 보간: ${ctx.unresolved.join(' · ')})` });
        continue;
      }
      for (const f of FALLBACK_FILLERS) variants.push(replaceHolesContextual(body, f, firstColOf).sql);
    } else {
      variants.push(body);
    }
    let lastErr = null; let passed = false;
    for (const v of variants) {
      try { await db.exec(`EXPLAIN (GENERIC_PLAN) ${v}`); passed = true; break; }
      catch (e) { lastErr = e; }
    }
    if (passed) { if (dynamic) cPartial += 1; else cOk += 1; continue; }
    const msg = lastErr ? lastErr.message : '알 수 없음';
    // ★ 세션48 — pg_trgm 은 SKIP 이 아니라 **경고**다. 아래 §C-trgm 블록이 그 대가를 적는다.
    if (/similarity|gin_trgm|operator does not exist|function similarity/.test(msg)) cTrgm.push({ ...st, msg });
    else cFail.push({ ...st, msg });
  }
  if (cFail.length === 0) {
    ok(`플래너 통과 ${cOk}건 (정적) + ${cPartial}건 (보간 치환 후) · 실패 0건`);
  } else {
    for (const f of cFail) bad(`${f.file}:${f.line} — ${f.msg}\n       ${f.sql.trim().slice(0, 160).replace(/\s+/g, ' ')}`);
  }
  if (cSkip.length) {
    info(`SKIP ${cSkip.length}건 — §C 가 세우지 못한 것(동적 SQL 등). 컬럼 존재는 §E 가 따로 본다.`);
    for (const s of cSkip) info(`· ${s.file}:${s.line} — ${s.msg}`);
  }

  // ── §C-trgm. pg_trgm 부재를 SKIP 으로 덮지 않는다 (세션48) ──────────────────
  // ★ 4차 검증 실측: 이 DB 위에 src/app.js 를 실제로 띄우면
  //     200 /api/health · 200 /api/products/:barcode · 200 /additives · 200 /recent
  //     500 /api/products/search?q=…  → {"code":"42883","message":"function similarity(text, text) does not exist"}
  //   즉 「빈 DB 가 성립한다」는 말은 **검색 기능에 대해서는 거짓**이다.
  //   000_baseline.sql 이 CREATE EXTENSION 예외를 삼키고 gin_trgm 인덱스를 건너뛰기 때문이다.
  const hasTrgm = (await db.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`)).rows.length > 0;
  const trgmIdxWanted = [];                       // 운영 덤프가 갖고 있는 gin_trgm 인덱스
  if (fs.existsSync(PROD_DUMP)) {
    for (const m of fs.readFileSync(PROD_DUMP, 'utf8').matchAll(/CREATE INDEX (\S+) ON public\.(\S+) USING gin \(([^)]*gin_trgm_ops[^)]*)\)/g)) {
      trgmIdxWanted.push({ idx: m[1], tbl: m[2], cols: m[3] });
    }
  }
  if (!hasTrgm) {
    warn('pg_trgm 이 이 DB 에 없다 — 이것은 SKIP 이 아니라 **증명하지 못한 구간**이다.');
    info('· 000_baseline.sql 이 CREATE EXTENSION 실패를 예외로 삼키고 gin_trgm 인덱스를 건너뛴다.');
    info(`· 그 결과 운영이 가진 gin_trgm 인덱스 ${trgmIdxWanted.length}개가 이 DB 에 없다: ${trgmIdxWanted.map((x) => x.idx).join(', ') || '(덤프 없음)'}`);
    info(`· §C 에서 세우지 못한 SQL ${cTrgm.length}건이 전부 이 이유다:`);
    for (const s of cTrgm) info(`    - ${s.file}:${s.line} — ${s.msg.split('\n')[0]}`);
    info('· ★ 실측(4차 검증): 이 DB 로 앱을 띄우면 GET /api/products/search?q=… 가 **500** 이다.');
    info('    {"code":"42883","message":"function similarity(text, text) does not exist"}');
    info('    /api/health · /api/products/:barcode · /additives · /recent 는 200 이다.');
    info('· 운영(railway)에는 pg_trgm 이 있으므로 운영 장애는 아니다. 다만 **이 검사기는 검색 경로를 증명하지 못한다.**');
  } else if (cTrgm.length) {
    for (const s of cTrgm) bad(`${s.file}:${s.line} — pg_trgm 이 있는데도 세우지 못했다: ${s.msg}`);
  } else {
    ok(`pg_trgm 존재 — 검색 경로도 §C 가 검증했다 (gin_trgm 인덱스 ${trgmIdxWanted.length}개 대조 대상)`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  section('§D. ON CONFLICT 전수 grep → 대응 UNIQUE 존재 확인 (§C 와 독립된 이중 검사)');
  // ──────────────────────────────────────────────────────────────────────────
  const srcConflicts = [];
  for (const [rel, lits] of srcLits) srcConflicts.push(...extractConflicts(lits, rel));
  if (srcConflicts.length === 0) warn('src/ 에서 ON CONFLICT 를 하나도 찾지 못했다 — 추출기 점검 필요');
  for (const c of srcConflicts) {
    if (c.byConstraint) { warn(`${c.file}:${c.line} — ON CONFLICT ON CONSTRAINT 형태는 이 검사가 다루지 않는다`); continue; }
    if (!c.table) { warn(`${c.file}:${c.line} — ON CONFLICT (${c.cols.join(', ')}) 의 대상 테이블을 추론하지 못했다`); continue; }
    const hit = matchConflict(uniquesByTable.get(c.table) || [], c);
    const tag = c.inferred ? ' [테이블 추론]' : '';
    if (hit) ok(`${c.table}(${c.cols.join(', ')}) ← ${hit.idx}${hit.partial ? ' [partial]' : ''}${tag}   (${c.file}:${c.line})`);
    else bad(`${c.table}(${c.cols.join(', ')}) 에 대응하는 UNIQUE 가 없다 — ${c.file}:${c.line} 의 ON CONFLICT 가 런타임에 통째로 실패한다${tag}`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  section('§E. SQL 이 참조하는 테이블·컬럼 전수 대조 (동적 SQL 조각 포함)');
  // ──────────────────────────────────────────────────────────────────────────
  const NOT_A_TABLE = new Set(['select', 'set', 'values', 'where', 'from', 'join', 'on', 'and', 'or',
    'lateral', 'only', 'unnest', 'generate_series', 'dual']);
  const NOT_AN_ALIAS = new Set(['on', 'set', 'where', 'left', 'right', 'inner', 'outer', 'full', 'cross',
    'join', 'group', 'order', 'limit', 'using', 'values', 'as', 'and', 'or', 'select', 'returning', 'natural']);
  // CTE 이름 추출 — `AS MATERIALIZED (` / `AS NOT MATERIALIZED (` 도 CTE 다(세션48).
  // (이 한 줄이 없으면 scripts/staging/domestic/probe_*.js 의 CTE 4종이 「테이블 없음」으로 오탐된다.)
  const CTE_RE = /(?:WITH|,)\s+([a-z_][a-z0-9_]*)\s+AS\s+(?:(?:NOT\s+)?MATERIALIZED\s+)?\(/gi;

  function analyseRefs(stmts, sink) {
    const seen = new Set();
    for (const st of stmts) {
      const flat = st.sql.replace(/\s+/g, ' ');
      const cteNames = new Set([...flat.matchAll(CTE_RE)].map((m) => m[1].toLowerCase()));
      const alias = new Map();
      const tRe = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi;
      let tm;
      while ((tm = tRe.exec(flat)) !== null) {
        const tbl = tm[1].toLowerCase();
        if (NOT_A_TABLE.has(tbl) || cteNames.has(tbl)) continue;
        if (tbl === 'information_schema' || tbl === 'pg_catalog' || /^pg_/.test(tbl)) continue;
        if (flat.includes(`information_schema.${tbl}`)) continue;
        seen.add(tbl);
        if (!relKind.has(tbl)) { sink.table(tbl, st); continue; }
        // ★ 세션48 — CTE 이름이 별칭을 **가린다.**
        //   `WITH p AS (SELECT … FROM products p …) SELECT … FROM p JOIN … ON p.nm = …` 에서
        //   CTE 안쪽의 `products p` 가 alias 를 선점하면 바깥의 `p.nm` 이 `products.nm` 으로 풀려
        //   「products.nm 컬럼 없음」이라는 거짓 빨강이 난다(실측: probe_nutrition_fill.js:68).
        const a2 = tm[2] && tm[2].toLowerCase();
        if (a2 && !NOT_AN_ALIAS.has(a2) && !cteNames.has(a2)) alias.set(a2, tbl);
        if (!cteNames.has(tbl)) alias.set(tbl, tbl);
      }
      const im = flat.match(/INSERT\s+INTO\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/i);
      if (im && relKind.has(im[1].toLowerCase())) {
        const tbl = im[1].toLowerCase();
        for (const raw of im[2].split(',')) {
          const col = raw.trim().toLowerCase();
          if (!/^[a-z_][a-z0-9_]*$/.test(col)) continue;
          if (!(live.get(tbl) || new Map()).has(col)) sink.column(tbl, col, st, 'INSERT');
        }
      }
      const um = flat.match(/UPDATE\s+([a-z_][a-z0-9_]*)\s+SET\s+(.*?)(?:\s+WHERE\s|\s+RETURNING\s|$)/i);
      if (um && relKind.has(um[1].toLowerCase())) {
        const tbl = um[1].toLowerCase();
        for (const m of um[2].matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*=/g)) {
          const col = m[1].toLowerCase();
          if (!(live.get(tbl) || new Map()).has(col)) sink.column(tbl, col, st, 'UPDATE SET');
        }
      }
      for (const rm of flat.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/g)) {
        const a = rm[1].toLowerCase(); const col = rm[2].toLowerCase();
        if (a === 'information_schema' || a === 'pg_catalog' || a === 'excluded' || a === 'public') continue;
        const tbl = alias.get(a);
        if (!tbl) continue;
        const cols = live.get(tbl);
        if (!cols) continue;
        if (!cols.has(col)) sink.column(tbl, col, st, 'ref');
      }
    }
    return seen;
  }

  const badRefs = [];
  const seenTables = analyseRefs(statements, {
    table: (t, st) => badRefs.push(`테이블 없음: ${t}  (${st.file}:${st.line})`),
    column: (t, c, st, how) => badRefs.push(`컬럼 없음(${how}): ${t}.${c}  (${st.file}:${st.line})`),
  });
  const uniqBad = [...new Set(badRefs)];
  if (uniqBad.length === 0) {
    ok(`참조한 테이블 ${seenTables.size}종 · 컬럼 참조 전건 존재`);
    info(`테이블: ${[...seenTables].sort().join(', ')}`);
  } else {
    for (const b of uniqBad) bad(b);
  }

  // ──────────────────────────────────────────────────────────────────────────
  section('§F. 생성된 스키마 ↔ IP/production_schema_2026-07-31.txt — 이름이 아니라 성질로 대조');
  // ──────────────────────────────────────────────────────────────────────────
  // ★ 세션48 강화의 본체.  기존 §F 는 「컬럼 이름이 있는가 · UNIQUE 열 이름이 같은가」만 봤다.
  //   그래서 아래 변조가 **전부 EXIT=0 으로 통과**했다(4차 검증 실측):
  //     타입 INTEGER→BIGINT · BIGSERIAL→SERIAL · NOT NULL 제거 · DEFAULT 제거 ·
  //     CHECK 제거 · 부분UNIQUE→전체UNIQUE · VARCHAR 길이 부여 · FK 제거
  //   전부 「이름은 그대로인데 성질만 바뀐」 것이다. 여기서 성질을 본다.
  const prod = parseProductionDump(PROD_DUMP);
  if (!prod) {
    warn(`운영 덤프를 찾지 못했다: ${PROD_DUMP} — §F 를 건너뛴다(이 실행은 성질 대조를 하지 못했다)`);
  } else {
    info(`덤프가 담고 있는 테이블 ${prod.size}종 (75-dump 의 TABLES 배열 범위)`);
    info('덤프에 없는 테이블은 §F 의 기준이 없다 → tests/test_schema_constraints.js 가 실행으로 본다');
    let diffs = 0;
    const ordNotes = [];
    for (const [tbl, def] of prod) {
      const cols = liveAtt.get(tbl);
      if (!cols) { bad(`운영에 있는 테이블이 빈 DB 에 없다: ${tbl}`); diffs += 1; continue; }
      const missing = [...def.cols.keys()].filter((c) => !cols.has(c));
      const extra = [...cols.keys()].filter((c) => !def.cols.has(c));
      if (missing.length) { bad(`${tbl}: 운영에 있고 빈 DB 에 없는 컬럼 → ${missing.join(', ')}`); diffs += 1; }
      if (extra.length) { warn(`${tbl}: 빈 DB 에만 있는 컬럼 → ${extra.join(', ')}`); diffs += 1; }

      for (const [c, pd] of def.cols) {
        const l = cols.get(c);
        if (!l) continue;                                   // 위에서 이미 실패로 셌다
        // ① 타입 — format_type 수준. 덤프의 `ARRAY` 는 information_schema 표기라
        //    원소 타입을 알 수 없다(text[] 인지 int[] 인지). 그때만 대조를 포기한다.
        if (pd.type !== 'ARRAY' && l.ftype !== pd.type) {
          bad(`${tbl}.${c} 타입 불일치 — 운영="${pd.type}" 빈DB="${l.ftype}"`); diffs += 1;
        }
        // ② NOT NULL
        if (l.notnull !== pd.notnull) {
          bad(`${tbl}.${c} NOT NULL 불일치 — 운영=${pd.notnull} 빈DB=${l.notnull}`); diffs += 1;
        }
        // ③ DEFAULT — 생성열(GENERATED)은 pg_attrdef 에 생성식이 들어가는데
        //    덤프(information_schema.column_default)는 그것을 담지 않는다. 대조 불가 → 건너뛴다.
        //    (실측: products.search_text 하나가 여기 해당한다.)
        if (!l.gen) {
          const p = normDef(pd.def); const q = normDef(l.def);
          const eq = (p === q) || (p === 'null' && q === null)
            || (p && q && p.replace(/\(\)/g, '') === q.replace(/\(\)/g, ''));
          if (!eq) { bad(`${tbl}.${c} DEFAULT 불일치 — 운영=${pd.def} 빈DB=${l.def}`); diffs += 1; }
        }
        // ④ 컬럼 순서 — 무해하지만 드리프트다. 실패로 세지 않고 기록만 한다.
        if (l.ord !== pd.ord) ordNotes.push(`${tbl}.${c} 운영#${pd.ord} 빈DB#${l.ord}`);
      }

      const cons = liveCon.get(tbl) || [];
      // ⑤ FK — 참조 대상 + ON DELETE 동작까지
      for (const f of def.fks) {
        const want = `FOREIGN KEY (${f.cols}) REFERENCES ${f.reft}(${f.refc})`;
        const hit = cons.filter((x) => x.contype === 'f')
          .find((x) => x.def.replace(/\s+/g, ' ').startsWith(want));
        if (!hit) { bad(`${tbl}: 운영의 FK 가 빈 DB 에 없다 — ${want} ${f.extra}`); diffs += 1; }
        else if (f.extra && !hit.def.includes(f.extra)) {
          bad(`${tbl}: FK 동작 불일치 — 운영="${want} ${f.extra}" 빈DB="${hit.def}"`); diffs += 1;
        }
      }
      // ⑥ CHECK
      for (const ck of def.checks) {
        const want = normExpr(ck.def);
        const hit = cons.filter((x) => x.contype === 'c').find((x) => normExpr(x.def) === want);
        if (!hit) {
          bad(`${tbl}: 운영의 CHECK 가 빈 DB 에 없다 — ${ck.name}: ${ck.def.slice(0, 120)}`); diffs += 1;
        }
      }
      // ⑦ UNIQUE — 열 집합 + partial 술어
      const liveU = uniquesByTable.get(tbl) || [];
      for (const u of def.uniques) {
        const want = new Set(u.cols);
        const hit = liveU.find((x) => x.cols.length === want.size && x.cols.every((y) => want.has(y)));
        if (!hit) { bad(`${tbl}: 운영의 UNIQUE(${u.cols.join(', ')}) 가 빈 DB 에 없다`); diffs += 1; continue; }
        if (normExpr(u.pred) !== normExpr(hit.pred)) {
          bad(`${tbl}: UNIQUE(${u.cols.join(', ')}) 의 부분 술어 불일치 — 운영=${u.pred || '(전체)'} 빈DB=${hit.pred || '(전체)'}`
            + '  ★ 부분/전체가 바뀌면 ON CONFLICT 중재자 추론이 달라져 INSERT 가 통째로 실패하거나 중복이 들어온다');
          diffs += 1;
        }
      }
    }
    if (ordNotes.length) {
      info(`컬럼 순서 드리프트 ${ordNotes.length}건 (무해 — SELECT * 의 열 순서만 다르다): ${ordNotes.join(' · ')}`);
    }
    if (diffs === 0) {
      ok(`덤프의 ${prod.size}개 테이블 — 컬럼·타입·NOT NULL·DEFAULT·FK·CHECK·UNIQUE(부분술어 포함) 전건 일치`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  section('§G. scripts/ 의 SQL — 경고 등급 (일회성·자가생성이 섞여 있어 실패로 세지 않는다)');
  // ──────────────────────────────────────────────────────────────────────────
  // ★ 왜 경고 등급인가 (4차 검증 근거)
  //   scripts/ 를 훑으면 실패 58건이 나오지만 전수 추적 결과 **실질 결함은 0건**이었다:
  //     · merge_log · staging_product_report · unmatched_nutrition_pool
  //       → 다른 스크립트가 런타임에 CREATE 하는 작업 테이블 (아래 allowlist 가 근거와 함께 제외한다)
  //     · deep_normalize · strip_corp_indicator → CREATE OR REPLACE FUNCTION 으로 만든다
  //     · allergens · product_allergens.allergen_id → **죽은 fk 폴백**(소스 주석이 「운영에 없다」고 명시)
  //     · scan_miss → 소스가 "테이블 없을 수 있으니 실패 허용" 이라고 try 로 감쌌다
  //     · products.name → 일회성 진단 스크립트 자체의 버그
  //   이것을 실패로 두면 EXIT 가 늘 1 이 되고, **그러면 아무도 안 본다.**
  //   그래서 경고로 분리하되 **반드시 출력**하고, 총평의 경고 수에 싣는다.
  // ★ ON CONFLICT 만은 다르다 → 아래 §G-2 참조.
  const scriptFiles = walk(SCRIPTS)
    .filter((f) => !/77-verify-fresh-schema|75-dump-production-schema/.test(f))
    .sort();
  const creators = collectCreators(scriptFiles);
  const scriptLits = new Map();
  const scriptStmts = [];
  for (const f of scriptFiles) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const lits = scanStringLiterals(fs.readFileSync(f, 'utf8'));
    scriptLits.set(rel, lits);
    for (const lit of lits) if (looksLikeSql(lit.text)) scriptStmts.push({ file: rel, line: lit.line, sql: lit.text });
  }
  info(`scripts/ SQL 문 ${scriptStmts.length}건 (${scriptFiles.length}개 파일)`);

  const gTable = new Map(); const gCol = new Map(); const gAllow = new Map();
  analyseRefs(scriptStmts, {
    table: (t, st) => {
      if (creators.rel.has(t)) {                                   // 자가생성 — 근거와 함께 제외
        const k = `${t} ← CREATE 하는 파일: ${creators.rel.get(t).join(', ')}`;
        gAllow.set(k, (gAllow.get(k) || 0) + 1); return;
      }
      if (!gTable.has(t)) gTable.set(t, new Set());
      gTable.get(t).add(`${st.file}:${st.line}`);
    },
    column: (t, c, st, how) => {
      const key = `${t}.${c}`;
      if (creators.col.has(key)) {
        const k = `${key} ← ALTER ADD COLUMN 하는 파일: ${creators.col.get(key).join(', ')}`;
        gAllow.set(k, (gAllow.get(k) || 0) + 1); return;
      }
      const kk = `${key} (${how})`;
      if (!gCol.has(kk)) gCol.set(kk, new Set());
      gCol.get(kk).add(`${st.file}:${st.line}`);
    },
  });
  if (gAllow.size) {
    info(`자가생성 allowlist 로 제외 ${gAllow.size}종 (하드코딩이 아니라 소스의 CREATE 문이 근거다):`);
    for (const [k, n] of [...gAllow].sort()) info(`  · ${k}  ×${n}`);
  }
  if (gTable.size === 0 && gCol.size === 0) {
    ok('scripts/ 의 테이블·컬럼 참조도 전건 존재한다');
  } else {
    for (const [t, where] of [...gTable].sort()) {
      warn(`scripts/ 테이블 부재: ${t}  ← ${[...where].slice(0, 3).join(', ')}${where.size > 3 ? ` 외 ${where.size - 3}곳` : ''}`);
    }
    for (const [c, where] of [...gCol].sort()) {
      warn(`scripts/ 컬럼 부재: ${c}  ← ${[...where].slice(0, 3).join(', ')}${where.size > 3 ? ` 외 ${where.size - 3}곳` : ''}`);
    }
    info('★ 위 경고는 「무시해도 된다」가 아니라 「일회성·죽은 폴백일 수 있다」는 뜻이다. 새 항목이 생기면 그것부터 볼 것.');
    info('  4차 검증 시점의 목록(전부 실질 결함 아님으로 판정됨):');
    info('   · allergens / product_allergens.allergen_id — 죽은 fk 폴백(19·26-apply-haccp 의 주석이 「운영에 없다」 명시)');
    info('   · scan_miss — export_gap_sample.js 가 "테이블 없을 수 있으니 실패 허용" 이라고 try 로 감쌌다');
    info('   · staging_nutrition.deep_norm_name — 같은 스크립트가 ALTER ADD COLUMN 하는데 UPDATE 가 먼저 잡혔다');
  }

  // ── §G-2. scripts/ 의 ON CONFLICT 는 **실패 등급**이다 ─────────────────────
  // ★ 근거: ON CONFLICT 대상 UNIQUE 가 없으면 그 문장은 42P10 으로 **통째로 실패**한다.
  //   경고로 두면 「돌려 보니 아무것도 안 들어갔다」를 다음 세션이 다시 겪는다.
  //   특히 세션47이 만든 scripts/lib/allergenUpsert.js 의
  //   `ON CONFLICT (product_id, allergen_name) DO UPDATE` 가 여기서 처음 검사된다
  //   (구 코드의 `DO NOTHING` 은 UNIQUE 없이도 돌았지만 DO UPDATE 는 그렇지 않다).
  //   단, 대상 테이블이 baseline 에 아예 없으면(=스크립트가 자기가 만드는 작업 테이블이면)
  //   판단 근거가 없으므로 경고로 낮춘다.
  const scriptConflicts = [];
  for (const [rel, lits] of scriptLits) scriptConflicts.push(...extractConflicts(lits, rel));
  let gcOk = 0;
  for (const c of scriptConflicts) {
    if (c.byConstraint) { warn(`${c.file}:${c.line} — ON CONFLICT ON CONSTRAINT 형태는 이 검사가 다루지 않는다`); continue; }
    if (!c.table) { warn(`${c.file}:${c.line} — ON CONFLICT (${c.cols.join(', ')}) 의 대상 테이블을 추론하지 못했다`); continue; }
    if (!relKind.has(c.table)) { warn(`${c.file}:${c.line} — ON CONFLICT 대상 ${c.table} 가 baseline 에 없다(스크립트 작업 테이블로 보인다)`); continue; }
    const hit = matchConflict(uniquesByTable.get(c.table) || [], c);
    if (hit) { gcOk += 1; continue; }
    const msg = `scripts/ ON CONFLICT: ${c.table}(${c.cols.join(', ')}) 에 대응하는 UNIQUE 가 없다`
      + ` — ${c.file}:${c.line}${c.inferred ? ' [테이블 추론]' : ''}  ⇒ 42P10 으로 문장 전체가 실패한다`;
    // 대장에 등록된 것(S2 = mergePublicData 생성기)만 ⚠ 로 내린다. 그 밖은 실패다.
    if (/data-pipeline\/mergePublicData\.js/.test(c.file) && c.table === 'products') badOrKnown('S2', msg);
    else bad(msg);
  }
  if (scriptConflicts.length) ok(`scripts/ ON CONFLICT ${gcOk}/${scriptConflicts.length}건이 대응 UNIQUE 를 갖는다`);

  // ──────────────────────────────────────────────────────────────────────────
  section('§H. migrate:all · migrate:020 이 가리키는 SQL (씨드 포함 「빈 DB」 경로)');
  // ──────────────────────────────────────────────────────────────────────────
  // ★ 왜 필요한가 (4차 검증 실측)
  //   기존 §A 는 `scripts.migrate` 만 읽었다. 저장소가 문서화한 유일한 「씨드 포함 빈 DB」 경로인
  //   `npm run migrate:all` 은 **첫 INSERT 부터 죽는다**:
  //     003_seed_products.sql: INSERT … ON CONFLICT (barcode) DO UPDATE
  //     → 42P10 there is no unique or exclusion constraint matching the ON CONFLICT specification
  //   baseline(과 001)의 인덱스가 **부분 UNIQUE**(`WHERE barcode IS NOT NULL`)이기 때문이다.
  //   003 은 **동결된 역사**다 — 이 검사기는 고치지 않고 **보고만** 한다.
  //   (고치려면 003 이 `ON CONFLICT (barcode) WHERE barcode IS NOT NULL` 을 써야 한다.)
  const chainSet = new Set(chain);
  const extraSql = new Map();               // 파일 -> [그것을 가리키는 npm script]
  for (const [name, body] of Object.entries(pkg.scripts || {})) {
    if (typeof body !== 'string' || /^_note/i.test(name)) continue;
    for (const m of body.matchAll(/-f\s+(\S+\.sql)/g)) {
      if (chainSet.has(m[1])) continue;
      if (!extraSql.has(m[1])) extraSql.set(m[1], []);
      extraSql.get(m[1]).push(name);
    }
  }
  if (extraSql.size === 0) info('체인 밖에서 가리키는 .sql 이 없다');
  for (const [rel, byWho] of extraSql) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { bad(`scripts.${byWho.join('/')} 가 가리키는 파일이 없다: ${rel}`); continue; }
    const sql = fs.readFileSync(p, 'utf8');
    info(`${rel}  ← scripts.${byWho.join(', scripts.')}`);

    // ① 파싱 — SQL 파일 안의 ON CONFLICT 를 실제 UNIQUE 와 대조한다 (같은 형태는 한 번만 보고)
    const seen = new Set();
    const flatAll = sql.replace(/\s+/g, ' ');
    const insRe = /INSERT\s+INTO\s+([a-z_][a-z0-9_]*)[^;]*?ON\s+CONFLICT\s*\(([^)]*)\)(\s*WHERE\s+[^)]*?)?\s*DO\b/gi;
    let im;
    while ((im = insRe.exec(flatAll)) !== null) {
      const table = im[1].toLowerCase();
      const cols = im[2].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const key = `${table}|${cols.join(',')}|${!!im[3]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = matchConflict(uniquesByTable.get(table) || [], { table, cols, partial: !!im[3] });
      if (hit) { ok(`  ${table}(${cols.join(', ')}) ← ${hit.idx}${hit.partial ? ' [partial]' : ''}`); continue; }
      const partialCand = (uniquesByTable.get(table) || [])
        .filter((u) => u.partial && u.cols.length === cols.length && u.cols.every((x) => cols.includes(x)));
      if (partialCand.length && !im[3]) {
        const msg = `${rel}: ON CONFLICT (${cols.join(', ')}) 가 **부분 UNIQUE** 와 맞지 않는다`
          + ` — ${partialCand.map((u) => `${u.idx} WHERE ${u.pred}`).join(' / ')}`
          + `  ⇒ 42P10 으로 실패한다. 003 은 동결이므로 고치지 말고, 씨드가 필요하면`
          + ` \`ON CONFLICT (${cols.join(', ')}) WHERE ${partialCand[0].pred}\` 형태의 새 파일을 쓸 것`;
        if (/003_seed_products\.sql$/.test(rel) && table === 'products') badOrKnown('S1', msg);
        else bad(msg);
      } else {
        bad(`  ${rel}: ${table}(${cols.join(', ')}) 에 대응하는 UNIQUE 가 없다 — 이 파일은 빈 DB 에서 실패한다`);
      }
    }

    // ② 실행 — 트랜잭션 안에서 적용해 보고 즉시 ROLLBACK 한다(같은 인스턴스, 상태 오염 없음)
    let applied = null;
    try { await db.exec('BEGIN'); await db.exec(sql); }
    catch (e) { applied = e.message.split('\n')[0]; }
    try { await db.exec('ROLLBACK'); } catch (e) { /* 이미 정리됨 */ }
    if (applied) info(`  실행 결과: ❌ ${applied}   (ROLLBACK 함 — DB 는 그대로다)`);
    else info('  실행 결과: ✅ 적용 가능 (ROLLBACK 함 — DB 는 그대로다)');
  }

  await db.close();

  // ──────────────────────────────────────────────────────────────────────────
  // ★ 대장에 있는데 **이제 재현되지 않는** 결함 → 실패.
  //   고쳐졌다는 뜻이므로 대장에서 지우고 그 사실을 인수인계에 남겨야 한다.
  //   (대장을 지우지 않으면 다음 세션은 「아직 안 고쳐졌다」고 잘못 읽는다.)
  for (const id of Object.keys(KNOWN_DEFECTS)) {
    if (!seenDefects.has(id)) {
      bad(`[${id} 고쳐졌다] 대장에 있는 결함이 더 이상 재현되지 않는다 — 「${KNOWN_DEFECTS[id]}」`
        + '  ⇒ 77 의 KNOWN_DEFECTS 에서 이 줄을 지우고 인수인계에 적을 것');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`실패 ${failures}건 · 경고 ${warnings}건`);
  if (knownHits.length) {
    console.log(`\n⚠  미해결 결함(대장 등록) ${knownHits.length}건 — 값이 대장과 같다:`);
    for (const h of knownHits) console.log(`   ${h.id}: ${KNOWN_DEFECTS[h.id]}`);
    console.log('   ★ 고친 뒤에는 VERIFY_STRICT=1 로 돌렸을 때 초록이어야 한다.');
  }
  if (failures) {
    console.log('\n실패 목록:');
    for (const f of failList) console.log(`  - ${f.split('\n')[0]}`);
    console.log('\n❌ 빈 DB 가 운영과 같지 않다. 위 목록을 000_baseline.sql 에 반영할 것.');
    process.exit(1);
  }

  // ★ 세션48 — 총평에서 「전건 성립」이라고 말하지 않는다.
  //   말할 수 있는 것은 「검사한 범위에서 실패가 없다」까지다. 검사하지 못한 범위를 함께 적는다.
  console.log('\n✅ 실패 0건 — 다만 **「전건 성립」이 아니다.** 이 검사기가 증명하지 못한 범위:');
  if (!hasTrgm) {
    console.log('   · pg_trgm 부재 — 검색 경로를 증명하지 못했다.');
    console.log('     이 DB 로 앱을 띄우면 GET /api/products/search?q=… 는 **500** 이다');
    console.log('     ({"code":"42883","message":"function similarity(text, text) does not exist"}).');
    console.log(`     세우지 못한 SQL ${cTrgm.length}건 · 빠진 gin_trgm 인덱스 ${trgmIdxWanted.length}개.`);
  }
  console.log('   · NOT NULL·CHECK·FK·VARCHAR 길이·DEFAULT 는 EXPLAIN(GENERIC_PLAN) 이 원리적으로 못 본다.');
  console.log('     (src/ 는 값을 전부 $1…$n 파라미터로 넘기므로 리터럴 검사도 걸리지 않는다.)');
  console.log('     → 그 축은 §F(덤프 성질 대조)와 tests/test_schema_constraints.js(실제 실행)가 본다.');
  console.log('   · 운영 덤프에 없는 테이블(pulse·staging·import·entity …)은 §F 의 대조 기준이 없다.');
  if (warnings) {
    console.log(`   · 경고 ${warnings}건 — 아래를 읽을 것:`);
    for (const w of warnList) console.log(`     - ${w.split('\n')[0]}`);
  }
  process.exit(0);
})().catch((e) => { console.error('예상 못 한 예외:', e); process.exit(1); });
