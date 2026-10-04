'use strict';
/**
 * additiveDetect.js — 첨가물 검출기 v2 (세션75e · 2026-10-04)
 * ============================================================================
 * 왜 (제이 실물 제보 7건 · 10-04): 원재료에 적힌 첨가물을 v1(`ocrParser.identifyAdditives`)이 대량으로 놓치고, 엉뚱한 것을 잡았다.
 *   · 용도명 단독(산도조절제·향미증진제1·유화제 3종 제제) 미인식 · 짧은 표기(글리세린에스테르) 미인식
 *   · 부분일치 선착순 오분류(글리세린에스테르 → «글리세린») · 줄바꿈 공백(폴리소르 베이트60)
 *   · 사전이 손으로 적은 ~200개라 L-글루탐산나트륨·5'-구아닐산이나트륨·소브산칼륨 등 흔한 것도 없었다
 *   · 첨가물 아닌 것(식물성유지·주정)을 첨가물로 셈
 *
 * v2 원칙 (원칙 5 «엔진»): 사전 = 식품첨가물공전 III 품목명 665(정본 사본 `src/data/additive_codex_names.json`)
 *   + 라벨 별칭(정본 `IP/additive_alias/additive_label_alias_v2.json` 사본). **부분일치 없음** — 토큰 «완전일치»만.
 *   정답 셋: `IP/eval_additive_detect_v1/` (20 라벨 · 138 정답) — 규칙을 바꾸면 그 eval 부터.
 *
 * 토큰 규칙
 *   · 쉼표·세미콜론·슬래시·괄호 경계로 자른다. «머리(내용물…)» 구조를 기억한다.
 *   · 비교는 정규화끼리(소문자 · α→알파 · Ⅲ→III · 공백/하이픈/중점/따옴표 제거). 줄바꿈 공백도 이걸로 사라진다.
 *   · 안 맞으면: 끝 번호(향미증진제1)·«N종»·«제제»·퍼센트를 떼고 다시 · 그래도 안 맞으면 공백으로 나눈 조각별로.
 *   · 용도명만 → `@용도` 가 아니라 name=용도명 · match_type='class_only'. 단 ① 머리가 물질로 맞았으면 그 괄호 속 용도명은 버린다
 *     (아질산나트륨(발색제)) ② 용도명 머리 밑에 물질이 맞으면 머리 용도명은 버린다(산화방지제(터셔리…)).
 *   · 묶음(혼합제제·향료제제·면류첨가알칼리제)은 내용물이 맞으면 묶음 이름은 안 셈.
 *   · 첨가물 아님 목록(식물성유지·주정·효모 …)은 무조건 버린다.
 * 출력은 v1 과 같은 꼴: [{ name, category, raw, match_type }] — name 은 공전 정본 이름(용도명 단독이면 용도명).
 */
const CODEX = require('../data/additive_codex_names.json');
const ALIAS = require('../data/additive_label_alias_v2.json');

const GREEK = ALIAS.normalization_rules.greek;
const ROMAN = ALIAS.normalization_rules.roman;
function norm(s) {
  let t = String(s || '').toLowerCase();
  for (const [k, v] of Object.entries(GREEK)) t = t.split(k).join(v);
  for (const [k, v] of Object.entries(ROMAN)) t = t.split(k.toLowerCase()).join(v.toLowerCase()).split(k).join(v.toLowerCase());
  return t.replace(/[\s\-‧·･–'’′`"]/g, '');
}

const MASTER = new Map();            // norm → { name, category }
for (const it of CODEX.items) MASTER.set(norm(it.n), { name: it.n, category: (it.p && it.p[0]) || '기타' });
const ALIASES = new Map();
for (const [k, v] of Object.entries(ALIAS.alias_exact)) { const m = MASTER.get(norm(v)); if (m) ALIASES.set(norm(k), m); }
const CLASSES = new Set();
for (const it of CODEX.items) for (const p of it.p || []) CLASSES.add(norm(p));
for (const c of ALIAS.class_only.extra || []) CLASSES.add(norm(c));
const CLASS_PREFIX = (ALIAS.class_only.prefix_strip || []).map(norm);
const classOf = (n) => {
  if (CLASSES.has(n)) return n;
  for (const p of CLASS_PREFIX) if (n.startsWith(p) && CLASSES.has(n.slice(p.length))) return n.slice(p.length);
  return null;
};
const NOT_ADDITIVE = new Set(ALIAS.not_additive.names.map(norm));
const CONTAINERS = new Set(ALIAS.containers.names.map(norm));
const GENERIC = new Map(Object.entries(ALIAS.generic_family.names).map(([k, v]) => [norm(k), { name: k, category: v }]));
const CONTAINER_SUFFIX = (ALIAS.containers.suffix || []).map(norm);

/** 원재료 구간 → 트리 [{ text, children: [...] }] */
function tokenize(section) {
  const root = { text: '', children: [] };
  const stack = [root];
  let buf = '';
  const flush = () => {
    const t = buf.trim(); buf = '';
    if (t) stack[stack.length - 1].children.push({ text: t, children: [] });
  };
  const s = String(section || '').replace(/\r?\n/g, ' ');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ('([{<'.includes(c)) {
      const t = buf.trim(); buf = '';
      const node = { text: t, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else if (')]}>'.includes(c)) {
      flush();
      if (stack.length > 1) stack.pop();
    } else if (',;/:'.includes(c) || (c === '.' && !(/\d/.test(s[i - 1] || '') && /\d/.test(s[i + 1] || '')))) {
      flush();
    } else buf += c;
  }
  flush();
  return root.children;
}

function stripVariants(t) {
  const out = [t];
  let x = t.replace(/\d+(\.\d+)?\s*%/g, '').trim(); out.push(x);
  x = x.replace(/\s*제제$/, '').trim(); out.push(x);
  x = x.replace(/\s*\d+\s*종$/, '').trim(); out.push(x);
  x = x.replace(/\s*\d+(\.\d+)?$/, '').trim(); out.push(x);   // 향미증진제1 · 코치닐추출색소2.0
  return [...new Set(out.filter(Boolean))];
}

/** 토큰 하나 판정 → { kind: 'sub'|'class'|'container'|'none', name, category } */
function classify(text) {
  for (const v of stripVariants(text)) {
    const n = norm(v);
    if (!n) continue;
    if (NOT_ADDITIVE.has(n)) return { kind: 'none' };
    if (CONTAINERS.has(n) || CONTAINER_SUFFIX.some((x) => n.length > x.length && n.endsWith(x))) return { kind: 'container', ...(MASTER.get(n) || { name: v, category: '복합첨가물' }) };
    const m = MASTER.get(n) || ALIASES.get(n);
    if (m) return { kind: 'sub', ...m };
    // 계열 이름만(카라멜색소 · 비타민D …) — 공전 품목 하나로 못 정하므로 계열 이름 그대로(지어내지 않음)
    if (GENERIC.has(n)) return { kind: 'sub', ...GENERIC.get(n), via: 'generic' };
    const cl = classOf(n);
    if (cl) { const nm = v.replace(/\s/g, '').replace(/^(합성|천연)/, ''); return { kind: 'class', name: nm, category: nm }; }
    // 용도명이 꼬리에 붙은 표기(아스파탐감미료 · L-글루타민산나트륨향미증진제) → 앞부분이 물질이면 물질
    for (const c of CLASSES) {
      if (n.length > c.length + 1 && n.endsWith(c)) {
        const head = n.slice(0, -c.length);
        const m = MASTER.get(head) || ALIASES.get(head) || GENERIC.get(head);
        if (m) return { kind: 'sub', ...m, via: 'glued' };
      }
    }
  }
  // 조각별(OCR 꼬리 잡음: «L-글루탐산나트륨 미증진제» · «치자황색소 스프류 중 백합»)
  // ★ 맞는 조각을 «전부» 돌려준다 — «면류첨가알칼리제(탄산칼륨 탄산나트륨)» 처럼 쉼표 없이 공백으로만 나뉜 목록이 있다(HACCP 보류 검증)
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    const items = [];
    for (const p of parts) {
      const r = classify(p);
      if (r.kind === 'sub') items.push({ ...r, via: 'chunk' });
      else if (r.kind === 'multi') items.push(...r.items);
    }
    if (items.length === 1) return items[0];
    if (items.length > 1) return { kind: 'multi', items };
  }
  return { kind: 'none' };
}

/** 괄호 깊이 0 에서만 자른 «원재료 한 항목» 원문들 — detected_name(라벨 원문) 용 */
function splitTopLevel(section) {
  const s = String(section || '').replace(/\r?\n/g, ' ');
  const out = []; let depth = 0; let start = 0;
  for (let i = 0; i <= s.length; i++) {
    const c = s[i];
    if (c !== undefined && '([{<'.includes(c)) depth++;
    else if (c !== undefined && ')]}>'.includes(c)) depth = Math.max(0, depth - 1);
    else if (c === undefined || (depth === 0 && (',;'.includes(c)))) {
      const t = s.slice(start, i).trim(); if (t) out.push(t); start = i + 1;
    }
  }
  return out;
}

function detectAdditives(section) {
  const found = [];
  const seen = new Set();
  const push = (r, raw, type) => {
    const key = norm(r.name);
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ name: r.name, category: r.category, raw, match_type: type });
  };
  /** @returns {boolean} 이 노드들 중 «첨가물로 판정된 것»이 있었는가(이미 본 이름이라 목록에 안 늘어도 true) */
  function walk(nodes, parentIsSubstance, raw) {
    let any = false;
    for (const node of nodes) {
      const r = classify(node.text);
      // 머리가 물질이면 괄호 속 용도명·설명은 버린다(아스파탐(감미료, 페닐알라닌함유))
      // ★ 「목록이 늘었나」로 보면 안 된다 — 이미 본 이름(향료·글리세린지방산에스테르)이 다시 나오면 안 늘어서
      //   «유화제(글리세린지방산에스테르)» 의 머리 용도명이 군더더기로 남았다(eval 023·018·009 실측).
      const childMatched = walk(node.children, r.kind === 'sub' || r.kind === 'multi', raw);
      if (r.kind === 'sub') { push(r, raw, r.via ? `exact(${r.via})` : 'exact'); any = true; }
      else if (r.kind === 'multi') { for (const it of r.items) push(it, raw, 'exact(chunk)'); any = true; }
      else if (r.kind === 'container') { if (!childMatched) push(r, raw, 'exact(container)'); any = true; }
      else if (r.kind === 'class') { if (!childMatched && !parentIsSubstance) { push(r, raw, 'class_only'); any = true; } }
      if (childMatched) any = true;
    }
    return any;
  }
  // ★ raw = «원재료 한 항목» 원문(괄호 포함) — `product_additives.detected_name` 계약(라벨에 실제로 뭐라 적혔나 · 세션65 C1)
  for (const item of splitTopLevel(section)) walk(tokenize(item), false, item);
  return found;
}

module.exports = { detectAdditives, tokenize, classify, norm, splitTopLevel };
