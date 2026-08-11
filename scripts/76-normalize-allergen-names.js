/**
 * 76-normalize-allergen-names.js — `product_allergens.allergen_name` 오염 백필
 * ============================================================================
 * 무엇을 고치나 —
 *   HACCP 적재 스크립트(19·26)의 `parseAllergy` 가 자유 서술문을 쪼개 넣은 탓에
 *   `allergen_name` 에 문장 조각이 들어 있다. 020 마이그레이션의 기본값 `contains` 를 받아
 *   **사용자 화면에 「직접 함유: 밀(성분)」으로 나간다** (운영 실물: GET /api/products/8801005013130).
 *
 *   실측(2026-07-31, `parseAllergy` 를 import 해 실제 HACCP 덤프에 실행):
 *     적재분 5,649행 / distinct 106종 → **705행(12.5%)·87종이 19종 정본이 아니다.**
 *     예) 계란 339 · 조개류(굴) 65 · 소고기 34 · 난류 24 · 홍합) 22 · 밀(성분) 1
 *
 * 무엇을 하나 —
 *   ① 정규화 (`src/services/allergenName.js` — 19종 화이트리스트 + 별칭표 + 오타표)
 *      "계란"→"난류(가금류)" · "조개류(굴"→"조개류" · "밀(성분)"→"밀"
 *   ② 혼입 문장은 `evidence_level='may_contain'` 으로 백필
 *   ③ 정규화 불가는 **삭제하지 않는다.** CSV 로 리포트만 한다(제이가 결정).
 *      ⚠ 단, DB 에 남는 것과 화면에 나가는 것은 다르다 —
 *        노출 경로 `src/models/productModel.js:getAllergens()` 가 `normalizeAllergenRows` 로
 *        19종에 못 붙는 이름을 **응답 직전에 버린다**(세션47). 아래 콘솔 문구 참조.
 *   ④ UNIQUE `(product_id, allergen_name)` 충돌 — 정규화하면 반드시 중복이 생긴다
 *      ("계란"·"난류"·"난각칼슘(계란)" 이 모두 `난류(가금류)`).
 *      → 대표 1행으로 병합한다. evidence_level 은 **강한 쪽**, source_count 는 합.
 *        ★ 강한 쪽을 남기는 이유: 병합이 경고를 약화시키면 그것이 곧 과소경고다.
 *   ⑤ 병합으로 사라지는 행의 **출처(`detected_via`)·상태(`status`)를 대표 행이 승계한다.**
 *      (세션48 4차 검증 결함1 — 아래 `buildPlan` 의 「출처 승계」 주석에 근거를 적었다.)
 *
 * 안전 —
 *   · 기본은 DRY-RUN. 쓰기는 `--apply` 에서만.
 *   · 쓰기는 단일 트랜잭션. 중간 실패 시 통째로 롤백된다.
 *   · 실행 전/후 집계를 **같은 쿼리로** 뽑아 나란히 출력한다.
 *
 * 실행:
 *   node scripts/76-normalize-allergen-names.js              # DRY-RUN (기본)
 *   node scripts/76-normalize-allergen-names.js --apply      # 실제 반영
 *   node scripts/76-normalize-allergen-names.js --apply --backup   # 반영 전 원본 JSON 백업
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const {
  CANONICAL_19, normalizeAllergenNames, strongerLevel, isCanonicalAllergenName,
} = require('../src/services/allergenName');

const APPLY = process.argv.includes('--apply');
const BACKUP = process.argv.includes('--backup');
const CANON = new Set(CANONICAL_19);

const pool = new Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } }
  : {
    host: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'meokseon', user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  });

const outDir = path.join(__dirname, 'output');
const out = (p) => path.join(outDir, p);
const pad = (s, n) => String(s).padEnd(n, ' ');
const padL = (s, n) => String(s).padStart(n, ' ');

// ── 집계 (전/후를 같은 함수로 뽑는다 — 다른 쿼리를 쓰면 비교가 거짓말이 된다) ──
async function census(client) {
  const { rows } = await client.query(
    `SELECT allergen_name, evidence_level, count(*)::int AS c
       FROM product_allergens GROUP BY 1, 2`,
  );
  const byName = new Map();
  let total = 0, canonical = 0, polluted = 0;
  const levels = {};
  for (const r of rows) {
    total += r.c;
    byName.set(r.allergen_name, (byName.get(r.allergen_name) || 0) + r.c);
    levels[r.evidence_level || '(null)'] = (levels[r.evidence_level || '(null)'] || 0) + r.c;
    if (CANON.has(r.allergen_name)) canonical += r.c; else polluted += r.c;
  }
  return {
    total, canonical, polluted, levels,
    distinct: byName.size,
    distinctPolluted: [...byName.keys()].filter((n) => !CANON.has(n)).length,
    byName,
  };
}

function printCensus(label, c) {
  console.log(`\n── ${label} ─────────────────────────────────`);
  console.log(`  전체 행           : ${c.total}`);
  console.log(`  distinct 이름     : ${c.distinct}  (그중 19종 정본이 아닌 것: ${c.distinctPolluted})`);
  console.log(`  정본 이름 행      : ${c.canonical}`);
  console.log(`  ★ 오염 이름 행    : ${c.polluted}`
    + (c.total ? `  (${(c.polluted / c.total * 100).toFixed(1)}%)` : ''));
  console.log(`  evidence_level    : ${Object.entries(c.levels).map(([k, v]) => `${k}=${v}`).join(' · ') || '-'}`);
}

// ── 출처 승계 (세션48 4차 검증 결함1) ──────────────────────────────────────
//   `product_allergens.detected_via` 중 **공적 출처**는 `'haccp_api'` 하나다.
//   (`grep -rn "detected_via" src/ scripts/` → 쓰기 리터럴은 `'haccp_api'` · `'crowdsource_merge'` 둘뿐.)
const PUBLIC_DETECTED_VIA = 'haccp_api';

//   `status` 서열. `admin_verified` 만이 mergeService 의 DELETE 를 막는 값이다.
const STATUS_RANK = { admin_verified: 3, confirmed: 2, candidate: 1 };
const statusRank = (s) => STATUS_RANK[s] || 0;

/**
 * 제품 단위 계획 수립.
 * @returns {{updates:Array, deletes:Array, unresolved:Array, stats:Object}}
 */
function buildPlan(allRows) {
  const byProduct = new Map();
  for (const r of allRows) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id).push(r);
  }

  const updates = [];     // {id, product_id, from, to, fromLevel, toLevel, sourceCount, via, status, mergedFrom:[]}
  const deletes = [];     // {id, product_id, name}
  const inserts = [];     // {product_id, name, level, fromId, via, status} — 한 행이 2종 이상으로 갈라진 나머지
  const unresolved = [];  // {id, product_id, name, level}
  const stats = {
    products: byProduct.size, rowsIn: allRows.length,
    untouched: 0, renamed: 0, levelChanged: 0, merged: 0, unresolved: 0,
    viaPromoted: 0, statusPromoted: 0,
  };

  for (const [productId, rows] of byProduct) {
    // 정본 이름 → 이 이름으로 모이는 행들
    const groups = new Map();
    for (const r of rows) {
      const hits = normalizeAllergenNames(r.allergen_name);
      if (!hits.length) {
        unresolved.push({ id: r.id, product_id: productId, name: r.allergen_name, level: r.evidence_level });
        stats.unresolved += 1;
        continue;   // ★ 삭제하지 않는다. 리포트만.
      }
      for (const hit of hits) {
        // hit.level 이 null 이면 기존 등급 유지. 혼입 어휘가 잡혔을 때만 may_contain.
        const lvl = hit.level || r.evidence_level || 'contains';
        if (!groups.has(hit.name)) {
          groups.set(hit.name, { rows: [], level: null, sourceCount: 0, via: null, status: null });
        }
        const g = groups.get(hit.name);
        g.rows.push(r);
        g.level = g.level ? strongerLevel(g.level, lvl) : lvl;
        g.sourceCount += Number(r.source_count) || 0;
        // ★ 그룹 안에 공적 출처 행이 하나라도 있으면 그 그룹은 공적 출처다(아래 승계 주석 참조).
        if (r.detected_via === PUBLIC_DETECTED_VIA) g.via = PUBLIC_DETECTED_VIA;
        if (statusRank(r.status) > statusRank(g.status)) g.status = r.status;
      }
    }

    // ★ 대표 행(keeper) 배정.
    //   ⚠ 한 행이 여러 정본으로 갈라지는 경우가 실재한다("대두 밀", "계란.토마토").
    //     그 행은 **한 정본의 대표로만** 쓸 수 있다. 나머지 정본은 새 행이 필요하다.
    //     (예전 판은 같은 id 에 UPDATE 를 두 번 걸어 뒤엣것이 앞엣것을 덮어썼다 = 알레르겐 손실)
    //   ★ 「이미 그 이름인 행」을 최우선 대표로 삼는다 — 이름을 안 바꾸면 UNIQUE 충돌 가능성이 0.
    //
    // ★★★ 세션48 4차 검증 결함1 — keeper 선택은 그대로 두고 **출처를 승계**한다.
    //   무엇이 문제였나 —
    //     세션47 이 `scripts/lib/allergenUpsert.js` 로 넣은 HACCP 승격은
    //       ON CONFLICT DO UPDATE SET detected_via = 'haccp_api'
    //     로 공적 출처를 표시한다. 그런데 HACCP 가 만든 행의 이름은 `parseAllergy` 산
    //     **조각 이름**(`계란`·`조개류(굴)`)이고 크라우드 행은 **정본 이름**이다.
    //     정규화로 두 행이 한 그룹이 되면 위 규칙상 **항상 크라우드 행이 대표**가 되고
    //     `haccp_api` 행이 DELETE 된다. 그 다음 크라우드 merge 의
    //       DELETE ... AND detected_via = 'crowdsource_merge'  (src/services/mergeService.js:532 부근)
    //     가 **식약처가 확인한 알레르겐을 다시 지운다.** 세션47 중대2 가 76 을 통해 되살아난다.
    //     실측(정본 buildPlan 실호출): id 500 계란(haccp_api) · id 10 조개류(굴)(haccp_api) 가 DELETE 되고
    //     살아남는 행의 detected_via 는 둘 다 crowdsource_merge 였다.
    //
    //   왜 keeper 선택에 출처 우선순위를 **넣지 않았나** —
    //     「이름이 정확히 그 이름인 행 우선」은 취향이 아니라 **UNIQUE(product_id, allergen_name)
    //     충돌 회피 장치**다(위 137행 주석). keeper 를 haccp_api 조각 행으로 바꾸면
    //     그 행은 반드시 rename 되고, 같은 제품에 이미 정본 이름 행이 있는 상태에서
    //     rename 이 일어난다. 지금 apply 는 「DELETE 먼저 → UPDATE」 순서라 우연히 살아남지만,
    //     그 순서 의존은 무료로 얻는 안전이 아니다. 한 행이 2종으로 갈라지는 경우
    //     (`대두 밀`)와 겹치면 배정 순서까지 뒤집혀 검증하기 어려워진다.
    //   → **keeper 는 그대로. UPDATE 시 그룹 안의 공적 출처를 대표 행으로 이월한다.**
    //     이러면 UNIQUE 충돌 위험이 0 이고(이름 배정 로직을 한 글자도 안 건드린다),
    //     삭제되는 행의 공적 출처 표시는 대표 행이 물려받아 mergeService 의 DELETE 사정권 밖에 남는다.
    //     승계는 **단방향(승격)만** 한다 — haccp_api 를 crowdsource_merge 로 낮추는 일은 없다.
    //   ★ status 도 같은 이유로 승계한다(강한 쪽). `admin_verified` 가 바로 위 DELETE 의
    //     다른 하나의 방패이기 때문이다. 지금 저장소에 admin_verified 를 쓰는 코드는 없지만
    //     (mergeService 주석 참조), 병합이 방패를 깎는 코드로 남아 있으면 안 된다.
    //   ★ evidence_level 은 **건드리지 않았다.** HACCP `allergy` 는 직접함유/혼입을 구분하지 않는
    //     자유 서술문이라 여기서 등급을 정하면 틀린 등급을 공적 출처 이름으로 확정한다
    //     (`scripts/lib/allergenUpsert.js` 헤더와 같은 판단). 등급은 기존대로 **문장을 보고**
    //     `normalizeAllergenNames` 가 잡은 혼입 어휘로만 정한다.
    //   ★ source_count 는 이미 그룹 합계라 별도 승계가 필요 없다.
    const usedIds = new Set();
    const targets = [...groups.keys()].sort((a, b) => {
      const ax = groups.get(a).rows.some((r) => r.allergen_name === a) ? 0 : 1;
      const bx = groups.get(b).rows.some((r) => r.allergen_name === b) ? 0 : 1;
      return ax - bx;   // 정확히 그 이름인 행을 가진 정본을 먼저 배정한다
    });

    for (const target of targets) {
      const g = groups.get(target);
      const free = g.rows.filter((r) => !usedIds.has(r.id));
      const exact = free.filter((r) => r.allergen_name === target);
      const keeper = exact.length
        ? exact.reduce((a, b) => (a.id <= b.id ? a : b))
        : (free.length ? free.reduce((a, b) => (a.id <= b.id ? a : b)) : null);

      if (!keeper) {
        // 대표로 쓸 행이 없다 = 원본 행이 이미 다른 정본에 배정됐다 → 새 행을 만든다.
        //   ★ 새 행도 그룹의 공적 출처·상태를 물려받는다. 원본 행 하나(g.rows[0])의 값을
        //     그대로 쓰면 그 행이 우연히 크라우드 행일 때 공적 출처가 통째로 증발한다.
        inserts.push({
          product_id: productId, name: target, level: g.level, fromId: g.rows[0].id,
          via: g.via, status: g.status,
        });
        continue;
      }
      usedIds.add(keeper.id);

      const nameChanged = keeper.allergen_name !== target;
      const levelChanged = (keeper.evidence_level || 'contains') !== g.level;
      const countChanged = Number(keeper.source_count || 0) !== g.sourceCount;
      const dupeCount = free.length - 1;
      // ★ 승격만 한다(강등 없음). 바꿀 것이 없으면 null → SET 목록에서 아예 뺀다.
      const viaPromote = (g.via === PUBLIC_DETECTED_VIA && keeper.detected_via !== PUBLIC_DETECTED_VIA)
        ? PUBLIC_DETECTED_VIA : null;
      const statusPromote = (statusRank(g.status) > statusRank(keeper.status)) ? g.status : null;
      if (nameChanged || levelChanged || countChanged || dupeCount > 0 || viaPromote || statusPromote) {
        updates.push({
          id: keeper.id, product_id: productId,
          from: keeper.allergen_name, to: target,
          fromLevel: keeper.evidence_level || 'contains', toLevel: g.level,
          sourceCount: g.sourceCount || Number(keeper.source_count) || 1,
          via: viaPromote, status: statusPromote,
          fromVia: keeper.detected_via || null, fromStatus: keeper.status || null,
          mergedFrom: g.rows.filter((r) => r.id !== keeper.id).map((r) => r.allergen_name),
        });
        if (nameChanged) stats.renamed += 1;
        if (levelChanged) stats.levelChanged += 1;
        if (viaPromote) stats.viaPromoted += 1;
        if (statusPromote) stats.statusPromoted += 1;
      } else {
        stats.untouched += 1;
      }
    }

    // 배정되지 못한(= 대표가 아닌) 정규화 가능 행은 중복이므로 지운다.
    for (const r of rows) {
      if (usedIds.has(r.id)) continue;
      if (unresolved.some((u) => u.id === r.id)) continue;   // ★ 정규화 불가는 지우지 않는다
      deletes.push({ id: r.id, product_id: productId, name: r.allergen_name });
      stats.merged += 1;
    }
  }

  return { updates, deletes, inserts, unresolved, stats };
}

async function main() {
  console.log('\n============================================================');
  console.log(`  76 · 알레르겐 이름 정규화 백필  [${APPLY ? '★ APPLY (실제 반영)' : 'DRY-RUN (쓰기 없음)'}]`);
  console.log('============================================================');

  const who = await pool.query('SELECT current_database() db, current_user u');
  console.log(`DB: ${who.rows[0].db} / user=${who.rows[0].u}`);
  console.log(`정규화 정본: src/services/allergenName.js (식약처 19종 · IP/allergens_19_korea.json)`);

  const before = await census(pool);
  printCensus('실행 전 집계', before);

  if (before.total === 0) {
    console.log('\nproduct_allergens 가 비어 있다. 할 일이 없다.');
    await pool.end();
    return;
  }

  const { rows: allRows } = await pool.query(
    `SELECT id, product_id, allergen_name, evidence_level, source_count, status, detected_via
       FROM product_allergens ORDER BY product_id, id`,
  );
  const plan = buildPlan(allRows);

  console.log('\n── 계획 ─────────────────────────────────────');
  console.log(`  대상 제품            : ${plan.stats.products}`);
  console.log(`  입력 행              : ${plan.stats.rowsIn}`);
  console.log(`  손댈 필요 없음       : ${plan.stats.untouched}`);
  console.log(`  UPDATE (대표행)      : ${plan.updates.length}   (이름변경 ${plan.stats.renamed} · 등급변경 ${plan.stats.levelChanged})`);
  console.log(`  DELETE (중복병합)    : ${plan.deletes.length}`);
  console.log(`  INSERT (1행→2알레르겐): ${plan.inserts.length}`);
  // ★★★ 세션60 추가 — INSERT 내역을 «전부» 찍는다.
  //   왜: 「대두 밀 → 대두」·「계란.토마토 → 토마토」 처럼 rename 표에는 «한쪽»만 보인다.
  //   나머지 한쪽은 여기 INSERT 로 살아나는데, 개수만 찍으면 **알레르겐이 소실된 것처럼 보인다.**
  //   실제로 세션60 검토에서 이 표기 때문에 「과소경고 아닌가」를 의심했다.
  //   ⇒ 개수가 아니라 «무엇이» 살아나는지를 보여야 apply 를 납득하고 누를 수 있다.
  if (plan.inserts.length) {
    console.log('     ── INSERT 상세 (원본 1행이 2종으로 갈라진 나머지 쪽) ──');
    for (const ins of plan.inserts) {
      const src = allRows.find((r) => r.id === ins.fromId);
      console.log(`       product ${ins.product_id} · row ${ins.fromId}`
        + `  "${src ? src.allergen_name : '?'}"  →  «${ins.name}» 를 새 행으로 살린다`
        + `  [${ins.level}${ins.via ? ' · ' + ins.via : ''}]`);
    }
    console.log('     ⇒ 이 행들이 없으면 그 알레르겐은 «사라진다». 과소경고 방지의 핵심이다.');
  }
  console.log(`  ⚠ 정규화 불가(보존)  : ${plan.unresolved.length}  ← 삭제하지 않는다. CSV 리포트 참조`);
  console.log(`  ★ 공적 출처 승계     : detected_via→'${PUBLIC_DETECTED_VIA}' ${plan.stats.viaPromoted}행`
    + ` · status 승격 ${plan.stats.statusPromoted}행`);
  if (plan.stats.viaPromoted) {
    console.log(`     (병합으로 사라지는 HACCP 행의 공적 출처를 대표 행이 물려받는다.`);
    console.log(`      승계하지 않으면 다음 크라우드 merge 의 DELETE ... detected_via='crowdsource_merge' 가`);
    console.log(`      식약처 확인 알레르겐을 지운다 — mergeService.js:532 부근.)`);
  }

  // ── 이름 변경 요약 (from → to, 빈도순) ──
  const renameCount = new Map();
  for (const u of plan.updates) {
    if (u.from === u.to) continue;
    const k = `${u.from}  →  ${u.to}`;
    renameCount.set(k, (renameCount.get(k) || 0) + 1);
  }
  const renameTop = [...renameCount.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n── 이름 변경 ${renameTop.length}종 (빈도순 상위 40) ──`);
  for (const [k, c] of renameTop.slice(0, 40)) console.log(`  ${padL(c, 6)}  ${k}`);
  if (renameTop.length > 40) console.log(`  … 외 ${renameTop.length - 40}종 (전체는 CSV)`);

  // ── 등급 강등(may_contain 백필) ──
  const levelRows = plan.updates.filter((u) => u.fromLevel !== u.toLevel);
  console.log(`\n── evidence_level 변경 ${levelRows.length}행 ──`);
  for (const u of levelRows.slice(0, 20)) {
    console.log(`  product ${u.product_id}  ${u.from} : ${u.fromLevel} → ${u.toLevel}`);
  }
  if (levelRows.length > 20) console.log(`  … 외 ${levelRows.length - 20}행`);

  // ── 정규화 불가 리포트 ──
  const unresolvedByName = new Map();
  for (const u of plan.unresolved) unresolvedByName.set(u.name, (unresolvedByName.get(u.name) || 0) + 1);
  const unresolvedTop = [...unresolvedByName.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n── ⚠ 정규화 불가 ${unresolvedTop.length}종 / ${plan.unresolved.length}행 (DB 에는 보존됨) ──`);
  console.log('   이 이름들은 19종 어디에도 붙지 않았다. 이 스크립트는 지우지 않는다.');
  // ★★ 세션48 4차 검증 결함2 — 예전 문구는 「지우지 않았으니 그대로 화면에 나간다」였다. 거짓이다.
  //   세션47 이 노출 경로에 정규화를 넣은 뒤로, DB 에 남는 것과 화면에 나가는 것은 다르다.
  console.log('   ★ 그러나 DB 에 남아도 **화면에는 나가지 않는다.**');
  console.log('     src/models/productModel.js:getAllergens() 가 normalizeAllergenRows 로');
  console.log('     19종에 못 붙는 이름을 응답 직전에 버린다(세션47). 즉 지금 이미 사용자에게 안 보인다.');
  console.log('   ⚠ 실측 — 이 목록에는 19종 **밖의 실제 알레르겐**이 섞여 있다:');
  console.log('       적재분 6행/5종 중 1행 = "생선" (그 제품의 유일한 알레르겐 행이다)');
  console.log('       HACCP universe 53행/23종 중 18행 = 아몬드5·페닐알라닌5·참깨2·옥수수2·피칸1·헤이즐넛1·생선1·적두1');
  console.log('   제이 결정 필요:');
  console.log('     (a) allergenName.js 별칭표에 추가 → 19종으로 접혀 **화면에 나간다**');
  console.log('     (b) 수동 삭제 → DB 에서도 없앤다 (되돌릴 수 없다)');
  console.log('     (c) 그대로 둔다 → DB 에만 남고 **화면엔 영원히 안 나간다** (지금 상태 유지)');
  for (const [n, c] of unresolvedTop.slice(0, 40)) console.log(`  ${padL(c, 6)}  ${JSON.stringify(n)}`);
  if (unresolvedTop.length > 40) console.log(`  … 외 ${unresolvedTop.length - 40}종`);

  try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
  const csvPath = out('76_unresolved_allergen_names.csv');
  fs.writeFileSync(csvPath,
    '﻿product_id,row_id,allergen_name,evidence_level\n'
    + plan.unresolved.map((u) => `${u.product_id},${u.id},"${String(u.name).replace(/"/g, '""')}",${u.level || ''}`).join('\n'),
    'utf8');
  const renamePath = out('76_rename_plan.csv');
  fs.writeFileSync(renamePath,
    '﻿product_id,row_id,from,to,from_level,to_level,from_via,to_via,from_status,to_status,merged_from\n'
    + plan.updates.map((u) => `${u.product_id},${u.id},"${u.from.replace(/"/g, '""')}","${u.to}",${u.fromLevel},${u.toLevel},`
      + `${u.fromVia || ''},${u.via || ''},${u.fromStatus || ''},${u.status || ''},`
      + `"${u.mergedFrom.join(' | ').replace(/"/g, '""')}"`).join('\n'),
    'utf8');
  console.log(`\n리포트 파일:\n  ${csvPath}\n  ${renamePath}`);

  if (!APPLY) {
    console.log('\n────────────────────────────────────────────');
    console.log('DRY-RUN 이라 DB 를 건드리지 않았다.');
    console.log('위 계획이 납득되면 다시:  node scripts/76-normalize-allergen-names.js --apply');
    console.log('────────────────────────────────────────────\n');
    await pool.end();
    return;
  }

  if (BACKUP) {
    const bpath = out(`76_backup_${Date.now()}.json`);
    fs.writeFileSync(bpath, JSON.stringify(allRows), 'utf8');
    console.log(`\n백업: ${bpath} (${allRows.length}행)`);
  }

  const client = await pool.connect();
  let updated = 0, deleted = 0, inserted = 0, failed = false;
  try {
    await client.query('BEGIN');
    // ★ 순서가 중요하다 — 먼저 지우고(중복 제거) 그 다음 이름을 바꾼다.
    //   반대로 하면 대표행 rename 이 아직 남아 있는 중복행과 UNIQUE 충돌한다.
    for (const d of plan.deletes) {
      await client.query('DELETE FROM product_allergens WHERE id = $1', [d.id]);
      deleted += 1;
      if (deleted % 200 === 0) console.log(`  DELETE ${deleted}/${plan.deletes.length}...`);
    }
    for (const u of plan.updates) {
      // ★ detected_via·status 는 **승격이 있을 때만** SET 한다(세션48 결함1).
      //   승격이 없는 행에 자기 값을 그대로 다시 쓰면 쓸데없는 쓰기이고,
      //   NULL 을 문자열로 세탁할 여지도 생긴다(mergeService 의 NULL 보존 판단과 충돌).
      const params = [u.id, u.to, u.toLevel, u.sourceCount];
      const sets = ['allergen_name = $2', 'evidence_level = $3', 'source_count = $4'];
      if (u.via) { params.push(u.via); sets.push(`detected_via = $${params.length}`); }
      if (u.status) { params.push(u.status); sets.push(`status = $${params.length}`); }
      sets.push('updated_at = NOW()');
      await client.query(
        `UPDATE product_allergens SET ${sets.join(', ')} WHERE id = $1`,
        params,
      );
      updated += 1;
      if (updated % 200 === 0) console.log(`  UPDATE ${updated}/${plan.updates.length}...`);
    }
    for (const i of plan.inserts) {
      // 한 행이 2개 이상 정본으로 갈라진 경우의 나머지. 출처·등급은 원본 행에서 가져온다.
      const src = allRows.find((r) => r.id === i.fromId);
      await client.query(
        `INSERT INTO product_allergens (product_id, allergen_name, evidence_level, source_count, status, detected_via)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (product_id, allergen_name) DO NOTHING`,
        [i.product_id, i.name, i.level || (src && src.evidence_level) || 'contains',
          src ? src.source_count : 1,
          i.status || (src && src.status) || 'candidate',
          i.via || (src ? src.detected_via : null) || null],
      );
      inserted += 1;
    }
    await client.query('COMMIT');
    console.log(`\n✅ 반영: UPDATE ${updated} · DELETE ${deleted} · INSERT ${inserted}`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(`\n❌ ROLLBACK — 아무것도 반영되지 않았다: ${e.message}`);
    process.exitCode = 1;
    failed = true;
  } finally {
    client.release();
  }
  if (failed) { await pool.end(); return; }

  const after = await census(pool);
  printCensus('실행 후 집계', after);
  console.log('\n── 전/후 대조 ──');
  console.log(`  전체 행        : ${before.total} → ${after.total}   (${after.total - before.total})`);
  console.log(`  distinct 이름  : ${before.distinct} → ${after.distinct}`);
  console.log(`  ★ 오염 이름 행 : ${before.polluted} → ${after.polluted}`);
  if (after.polluted > 0) {
    console.log(`  ⚠ ${after.polluted}행이 남았다 — 전부 「정규화 불가」로 보존한 것이다(위 CSV).`);
    console.log('     ★ DB 에만 남는다. getAllergens() 의 normalizeAllergenRows 가 노출 직전에 버리므로');
    console.log('       화면에는 나가지 않는다. 화면에 내보내려면 별칭표에 추가해야 한다.');
    const leftover = [...after.byName.entries()].filter(([n]) => !isCanonicalAllergenName(n));
    for (const [n, c] of leftover.sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`      ${padL(c, 5)}  ${JSON.stringify(n)}`);
    }
  } else {
    console.log('  ✅ 오염 이름이 0행이다.');
  }
  console.log(`\n다음: 앱에서 검증 바코드 2개를 확인할 것`);
  console.log(`  GET /api/products/8801005013130  → contains 에 "밀(성분)" 이 없어야 한다`);
  console.log(`  GET /api/products/8801043032155  → allergens: null (미수집) 이 유지돼야 한다\n`);
  await pool.end();
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error('오류:', e.message);
    try { await pool.end(); } catch (_) {}
    process.exit(1);
  });
}

module.exports = { buildPlan, census, pad };
