#!/usr/bin/env node
/**
 * 105-fffd-repair.js — 세션79: 적재·OCR 시 UTF-8 조각 경계 깨짐(U+FFFD)으로 손상된 운영 DB 텍스트를
 *   «원천 API 재조회 → 정확 대조 → 미리보기 → 적용(배치) → 되돌리기» 로 복구한다.
 *
 * 원인: http 응답을 `data += chunk` 로 이어 붙인 적재 스크립트(C002·C003·HACCP 등)와 ocrService(79a 에서 수정).
 * 대조 규칙(엄격): 깨진 글자 덩어리(U+FFFD 연속) 하나 = 원문 «정확히 한 글자», 나머지 글자는 모두 같아야 채택.
 *   하나라도 어긋나면 그 행은 손대지 않고 보고만 한다(수동 검토).
 *
 * 대상(1단계): product_ingredients.raw_text(+ 같은 행 parsed_ingredients 의 같은 깨진 조각) · product_allergens.allergen_name(HACCP)
 *
 * 사용(meokseon-server 폴더):
 *   node scripts/105-fffd-repair.js --scan                   대상 수
 *   node scripts/105-fffd-repair.js --fetch [--max-sec 140] [--max-calls 95]  원천 재조회(캐시 · 재개 가능 · DB 읽기만 · C002/C003 은 시간당 100회 제한)
 *   node scripts/105-fffd-repair.js --preview                대조 결과 CSV(DB 읽기만)
 *   node scripts/105-fffd-repair.js --apply                  적용(한 트랜잭션 · 배치 기록 JSON)
 *   node scripts/105-fffd-repair.js --undo <batch_id>        되돌리기(배치 기록의 이전 값으로 · 그 사이 값이 바뀐 행은 건너뜀)
 *   node scripts/105-fffd-repair.js --self-test              대조 함수 단위 검사
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch (_) { /* */ }
const fs = require('fs'); const path = require('path'); const https = require('https'); const http = require('http');
const OUT = path.join(__dirname, '..', '..', '.tmp', 's79', 'fffd');
const CACHE = path.join(OUT, 'cache.json');
const FF = '�';

/** 깨진 문자열 C 와 원문 T 대조 → { ok, fills:[원문 글자…] } . 덩어리 하나 = 정확히 한 글자. */
function alignRepair(C, T) {
  if (C == null || T == null) return { ok: false, why: 'null' };
  const parts = String(C).split(/�+/);
  if (parts.length < 2) return { ok: false, why: 'no_fffd' };
  const t = [...String(T)]; let pos = 0; const fills = [];
  const at = (s) => { const a = [...s]; for (let i = 0; i < a.length; i++) if (t[pos + i] !== a[i]) return false; pos += a.length; return true; };
  if (!at(parts[0])) return { ok: false, why: 'prefix' };
  for (let k = 1; k < parts.length; k++) {
    const ch = t[pos]; if (ch == null || ch === FF) return { ok: false, why: 'short' };
    fills.push(ch); pos++;
    if (!at(parts[k])) return { ok: false, why: 'mismatch@' + k };
  }
  if (pos !== t.length) return { ok: false, why: 'tail' };
  return { ok: true, fills, repaired: t.join('') };
}
/** 같은 깨진 조각(앞뒤 문맥 포함)을 다른 텍스트(parsed JSON 등)에서도 바꾼다 — 문맥이 C 에서 온 것이므로 안전. */
function repairOther(text, C, fills) {
  if (text == null || !String(text).includes(FF)) return { text, n: 0 };
  const parts = String(C).split(/�+/); let out = String(text); let n = 0;
  for (let k = 1; k < parts.length; k++) {
    // 문맥 = 같은 토큰 안의 앞뒤 글자(구분자에서 멈춤 · 각 4자까지) — parsed JSON 은 토큰 경계(쉼표·괄호)가 다르다
    const DL = /[,()[\]{}\s/·:;"]/; const lA = [...parts[k - 1]]; const rA = [...parts[k]]; let L = ''; let R = '';
    for (let i = lA.length - 1; i >= 0 && L.length < 4 && !DL.test(lA[i]); i--) L = lA[i] + L;
    for (let i = 0; i < rA.length && R.length < 4 && !DL.test(rA[i]); i++) R += rA[i];
    if (!L && !R) continue;
    const re = new RegExp(L.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\uFFFD+' + R.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    out = out.replace(re, () => { n++; return L + fills[k - 1] + R; });
  }
  return { text: out, n };
}

/** 토큰 단위 대조(통째 대조 실패 시) — DB 텍스트가 원천 행 여러 개를 이어 붙인 경우.
 *  깨진 덩어리가 든 토큰(구분자 사이)마다 원천 텍스트들의 토큰 중 alignRepair 가 맞는 후보를 찾고,
 *  채울 글자가 «유일»할 때만 채운다. 하나라도 못 풀면 실패. */
const TOKDL = /[,()[\]{}\s/·:;]/;
function tokensOf(t) { return String(t || '').split(/[,()[\]{}\s/·:;]+/).filter(Boolean); }
function alignByTokens(C, sources) {
  const cand = new Set(); for (const s of sources) for (const t of tokensOf(s)) cand.add(t);
  const a = [...String(C)]; const out = []; let i = 0; const fills = [];
  while (i < a.length) {
    if (a[i] !== FF) { out.push(a[i]); i++; continue; }
    // 이 덩어리가 든 토큰 범위
    let s0 = out.length; while (s0 > 0 && !TOKDL.test(out[s0 - 1])) s0--;
    let e = i; while (e < a.length && !TOKDL.test(a[e])) e++;
    const tok = out.slice(s0).join('') + a.slice(i, e).join('');
    const opts = new Set(); let rep = null;
    for (const c of cand) { const r = alignRepair(tok, c); if (r.ok) { opts.add(r.repaired); rep = r; } }
    if (opts.size !== 1) return { ok: false, why: opts.size ? 'token_ambiguous' : 'token_none', tok };
    out.splice(s0); out.push(...[...rep.repaired]); fills.push(...rep.fills); i = e;
  }
  return { ok: true, repaired: out.join(''), fills };
}
function get(u) {
  return new Promise((res, rej) => {
    const req = (u.startsWith('https') ? https : http).get(u, { timeout: 30000 }, (r) => {
      const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => res(Buffer.concat(c).toString('utf8')));
    });
    req.on('error', rej); req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
const FS_KEY = () => process.env.FOODSAFETY_API_KEY; const DG_KEY = () => process.env.DATA_GO_KR_KEY;
async function fetchSource(api, rn) {
  if (api === 'C002' || api === 'C003') {
    const j = JSON.parse(await get(`http://openapi.foodsafetykorea.go.kr/api/${FS_KEY()}/${api}/json/1/20/PRDLST_REPORT_NO=${encodeURIComponent(rn)}`));
    const b = j[api] || {}; if (b.RESULT && !/^INFO-(000|200)$/.test(b.RESULT.CODE)) throw new Error(api + ' ' + b.RESULT.CODE);
    return (b.row || []).map((r) => ({ raw: r.RAWMTRL_NM || null, chng: r.CHNG_DT || null }));
  }
  if (api === 'HACCP') {
    const j = JSON.parse(await get(`https://apis.data.go.kr/B553748/CertImgListServiceV3/getCertImgListServiceV3?ServiceKey=${encodeURIComponent(DG_KEY())}&returnType=json&numOfRows=20&prdlstReportNo=${encodeURIComponent(rn)}`));
    const it = j && j.body && j.body.items; const arr = Array.isArray(it) ? it : (it && it.item ? [].concat(it.item) : []);
    return arr.map((x) => x.item || x).map((x) => ({ raw: x.rawmtrl || null, allergy: x.allergy || null, nm: x.prdlstNm || null }));
  }
  throw new Error('api? ' + api);
}
const API_OF = { c002: 'C002', c002_barcode: 'C002', c002_name: 'C002', c005_sibling: 'C002', c003: 'C003', haccp_api: 'HACCP' };

function pool() { const { Pool } = require('pg'); return new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); }
async function targets(p) {
  const ing = (await p.query(`select id, product_id, source, prdlst_report_no rn, raw_text, parsed_ingredients::text pj
     from product_ingredients where raw_text like '%'||chr(65533)||'%' order by id`)).rows;
  const alg = (await p.query(`select pa.id, pa.product_id, pa.allergen_name, pa.detected_via, pi.prdlst_report_no rn
     from product_allergens pa left join product_ingredients pi using(product_id) where pa.allergen_name like '%'||chr(65533)||'%' order by pa.id`)).rows;
  return { ing, alg };
}
const loadCache = () => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; } };

function plan(T, cache) {
  const rows = [];
  for (const r of T.ing) {
    const api = API_OF[r.source]; const key = api + '|' + r.rn; const c = cache[key];
    const base = { kind: 'ingredient', id: r.id, product_id: r.product_id, source: r.source, rn: r.rn, api };
    if (!api || !r.rn) { rows.push({ ...base, status: 'no_api' }); continue; }
    if (!c) { rows.push({ ...base, status: 'not_fetched' }); continue; }
    if (c.error) { rows.push({ ...base, status: 'fetch_error', why: c.error }); continue; }
    let hit = null; const whys = [];
    for (const s of c.rows) { const a = alignRepair(r.raw_text, s.raw); if (a.ok) { hit = a; break; } whys.push(a.why); }
    let how = 'whole';
    if (!hit && c.rows.length) { const t = alignByTokens(r.raw_text, c.rows.map((x) => x.raw)); if (t.ok) { hit = t; how = 'token'; } else whys.push(t.why + ':' + t.tok); }
    if (!hit) { rows.push({ ...base, status: c.rows.length ? 'no_match' : 'not_found', why: whys.join(';'), old: r.raw_text }); continue; }
    const pj = repairOther(r.pj, r.raw_text, hit.fills);
    rows.push({ ...base, status: 'ok', why: how, old: r.raw_text, new: hit.repaired, fills: hit.fills.join(''), pj_old: r.pj, pj_new: pj.text, pj_n: pj.n, pj_left: pj.text != null && String(pj.text).includes(FF) });
  }
  for (const r of T.alg) {
    const key = 'HACCP|' + r.rn; const c = cache[key]; const base = { kind: 'allergen', id: r.id, product_id: r.product_id, source: r.detected_via, rn: r.rn, api: 'HACCP' };
    if (!c || c.error) { rows.push({ ...base, status: c ? 'fetch_error' : 'not_fetched' }); continue; }
    let hit = null;
    for (const s of c.rows) for (const tok of String(s.allergy || '').split(/[,·/]\s*/)) { const a = alignRepair(r.allergen_name, tok.trim()); if (a.ok) { hit = a; break; } }
    rows.push(hit ? { ...base, status: 'ok', old: r.allergen_name, new: hit.repaired, fills: hit.fills.join('') } : { ...base, status: 'no_match', old: r.allergen_name });
  }
  return rows;
}
const csvq = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\n/g, ' ') + '"';
const stamp = () => new Date().toISOString().replace(/\D/g, '').slice(0, 14);

async function main() {
  const a = process.argv.slice(2); const has = (f) => a.includes(f); const val = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };
  fs.mkdirSync(OUT, { recursive: true });
  if (has('--self-test')) return selfTest();
  const p = pool();
  try {
    if (has('--scan')) { const T = await targets(p); const by = {}; for (const r of T.ing) by[r.source] = (by[r.source] || 0) + 1; console.log({ ingredient_rows: T.ing.length, by_source: by, parsed_with_fffd: T.ing.filter((r) => r.pj && r.pj.includes(FF)).length, allergen_rows: T.alg.length }); return; }
    if (has('--fetch')) {
      const maxSec = Number(val('--max-sec') || 140); const maxCalls = Number(val('--max-calls') || 0); const t0 = Date.now(); const T = await targets(p); const cache = loadCache();
      const keys = [...new Set([...T.ing.filter((r) => API_OF[r.source] && r.rn).map((r) => API_OF[r.source] + '|' + r.rn), ...T.alg.filter((r) => r.rn).map((r) => 'HACCP|' + r.rn)])];
      let n = 0; const todo = keys.filter((k) => !cache[k] || cache[k].error);
      for (const k of todo) {
        if ((Date.now() - t0) / 1000 > maxSec) break;
        if (maxCalls && n >= maxCalls) break;   // 식품안전나라: 보고번호 조회는 시간당 100회(INFO-320)
        const [api, rn] = k.split('|');
        try { cache[k] = { rows: await fetchSource(api, rn), at: new Date().toISOString() }; } catch (e) { cache[k] = { error: String(e.message || e).slice(0, 120) }; }
        if (cache[k].error && /INFO-320/.test(cache[k].error)) { n++; console.log('INFO-320(시간당 100회 초과) — 이번 회차 중단'); break; }   // 거절된 호출도 한도를 먹을 수 있어 즉시 멈춘다
        n++; await new Promise((r) => setTimeout(r, 200));   // 식품안전나라 INFO-320(연속 호출 제한) 회피
        if (n % 25 === 0) fs.writeFileSync(CACHE, JSON.stringify(cache));
      }
      fs.writeFileSync(CACHE, JSON.stringify(cache));
      const left = keys.filter((k) => !cache[k] || cache[k].error).length;
      console.log(`fetch: 이번 ${n} · 키 ${keys.length} · 남음/오류 ${left}`); return;
    }
    if (has('--preview') || has('--apply')) {
      const T = await targets(p); const rows = plan(T, loadCache()); const st = {};
      for (const r of rows) { const k = r.kind + ':' + r.status; st[k] = (st[k] || 0) + 1; }
      const ts = stamp(); const f = path.join(OUT, `105_preview_${ts}.csv`);
      fs.writeFileSync(f, '﻿' + ['kind,id,product_id,source,report_no,status,fills,why,old,new,pj_n,pj_left'].concat(rows.map((r) => [r.kind, r.id, r.product_id, r.source, r.rn, r.status, r.fills, r.why, r.old, r.new, r.pj_n, r.pj_left].map(csvq).join(','))).join('\n'));
      console.log(st, '→', f);
      if (!has('--apply')) return;
      const ok = rows.filter((r) => r.status === 'ok'); const batch = 'fffd_' + ts; const c = await p.connect();
      try {
        await c.query('BEGIN');
        // ★ 문장 2개(원격 RTT ~0.3초 · 행마다 보내면 수백 초) — 배열 unnest 로 한 번에. 조건 raw_text=old 로 그 사이 바뀐 행은 건너뜀.
        const I = ok.filter((r) => r.kind === 'ingredient'); const A = ok.filter((r) => r.kind === 'allergen');
        const ni = (await c.query(`update product_ingredients t set raw_text=u.nw, parsed_ingredients=coalesce(u.pj::jsonb, t.parsed_ingredients), updated_at=now()
           from unnest($1::bigint[], $2::text[], $3::text[], $4::text[]) u(id, nw, pj, od) where t.id=u.id and t.raw_text=u.od`,
          [I.map((r) => r.id), I.map((r) => r.new), I.map((r) => (r.pj_n ? r.pj_new : null)), I.map((r) => r.old)])).rowCount;
        const na = (await c.query(`update product_allergens t set allergen_name=u.nw, updated_at=now()
           from unnest($1::bigint[], $2::text[], $3::text[]) u(id, nw, od) where t.id=u.id and t.allergen_name=u.od`,
          [A.map((r) => r.id), A.map((r) => r.new), A.map((r) => r.old)])).rowCount;
        const rec = { batch, at: new Date().toISOString(), rows: ok.map((r) => ({ kind: r.kind, id: r.id, old: r.old, new: r.new, pj_old: r.pj_n ? r.pj_old : undefined, pj_new: r.pj_n ? r.pj_new : undefined })) };
        fs.writeFileSync(path.join(OUT, `105_batch_${batch}.json`), JSON.stringify(rec));
        await c.query('COMMIT'); console.log(`apply ${batch}: 원재료 ${ni} · 알레르기 ${na}`);
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
      return;
    }
    if (has('--undo')) {
      const b = val('--undo'); const rec = JSON.parse(fs.readFileSync(path.join(OUT, `105_batch_${b}.json`), 'utf8')); const c = await p.connect(); let n = 0;
      try {
        await c.query('BEGIN');
        const I = rec.rows.filter((r) => r.kind === 'ingredient'); const A = rec.rows.filter((r) => r.kind === 'allergen');
        n += (await c.query(`update product_ingredients t set raw_text=u.od, parsed_ingredients=coalesce(u.pj::jsonb, t.parsed_ingredients), updated_at=now()
           from unnest($1::bigint[], $2::text[], $3::text[], $4::text[]) u(id, od, pj, nw) where t.id=u.id and t.raw_text=u.nw`,
          [I.map((r) => r.id), I.map((r) => r.old), I.map((r) => r.pj_old || null), I.map((r) => r.new)])).rowCount;
        n += (await c.query(`update product_allergens t set allergen_name=u.od, updated_at=now()
           from unnest($1::bigint[], $2::text[], $3::text[]) u(id, od, nw) where t.id=u.id and t.allergen_name=u.nw`,
          [A.map((r) => r.id), A.map((r) => r.old), A.map((r) => r.new)])).rowCount;
        await c.query('COMMIT'); console.log(`undo ${b}: ${n}/${rec.rows.length}`);
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
      return;
    }
    console.log('사용: --scan | --fetch | --preview | --apply | --undo <batch> | --self-test');
  } finally { await p.end(); }
}

function selfTest() {
  let pass = 0, fail = 0; const eq = (a, b, m) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log('✗', m, JSON.stringify(a), '≠', JSON.stringify(b)); } };
  eq(alignRepair('면류첨가알��리제, 소맥분', '면류첨가알칼리제, 소맥분').repaired, '면류첨가알칼리제, 소맥분', '2개 덩어리 = 1글자');
  eq(alignRepair('이산화���소', '이산화탄소').fills, ['탄'], '3개 덩어리 = 1글자');
  eq(alignRepair('조���류(굴)', '조개류(굴)').repaired, '조개류(굴)', '알레르기명');
  eq(alignRepair('A��B�C', 'A가B나C').fills, ['가', '나'], '여러 덩어리');
  eq(alignRepair('면류첨가알��리제', '면류첨가알칼칼리제').ok, false, '두 글자는 거부');
  eq(alignRepair('면류첨가알��리제', '면류첨가알리제').ok, false, '0글자는 거부');
  eq(alignRepair('우��, 밀', '우유, 밀가루').ok, false, '꼬리 다르면 거부');
  eq(alignRepair('우��, 대두', '우유, 밀').ok, false, '중간 다르면 거부');
  eq(alignRepair('정상 텍스트', '정상 텍스트').ok, false, '깨짐 없음은 대상 아님');
  eq(alignRepair('��두', '�두').ok, false, '원문도 깨졌으면 거부');
  eq(alignRepair('가😀��나', '가😀다나').repaired, '가😀다나', '서로게이트 쌍 안전');
  const r = repairOther('[{"name":"면류첨가알��리제"}]', '중합인산염, 면류첨가알��리제, 기타', ['칼']);
  eq([r.text, r.n], ['[{"name":"면류첨가알칼리제"}]', 1], 'parsed JSON 같은 조각 교체');
  eq(repairOther('[{"name":"없음"}]', '알�리', ['칼']).n, 0, '깨짐 없는 JSON 무변경');
  eq(alignByTokens('인스턴트\uFFFD\uFFFD피, 결정과당, 인스턴트커피, 결정과당', ['인스턴트커피, 결정과당']).repaired, '인스턴트커피, 결정과당, 인스턴트커피, 결정과당', '토큰: 중복 연결 텍스트');
  eq(alignByTokens('착향료(\uFFFD\uFFFD터향), 밀', ['착향료(버터향)']).repaired, '착향료(버터향), 밀', '토큰: 괄호 안');
  eq(alignByTokens('\uFFFD\uFFFD당', ['사탕, 설탕']).ok, false, '토큰: 후보 둘(사당?·설당?) 없으면 실패');
  eq(alignByTokens('\uFFFD당, 밀', ['과당, 포도당']).repaired, '과당, 밀', '토큰: 한 글자 패턴은 과당만(포도당은 두 글자) → 유일');
  eq(alignByTokens('\uFFFD당, 밀', ['과당, 설당']).ok, false, '토큰: 후보 둘(과당·설당) → 거부');
  eq(alignByTokens('\uFFFD\uFFFD당', ['당근']).ok, false, '토큰: 후보 없음 → 거부');
  console.log(`105 self-test: ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { alignRepair, repairOther, alignByTokens };
