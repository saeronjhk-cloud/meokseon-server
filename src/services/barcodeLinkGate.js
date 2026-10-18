/**
 * barcode_link_gate.js — (정본 위치 src/services/barcodeLinkGate.js · 세션81 이동) ★ 세션79 바코드 잇기 판정(엔진 규칙 · AI 아님). 정답 IP/eval_barcode_link_v1/cases_v1.json(E2 16).
 *   decide(in) → { status: 'auto'|'needs_review'|'reject', reason, checks }
 *   in = { source:'haccp'|'ocr', barcode, web:{report_no,name,maker,content,unit}, cand:{report_no,name,maker},
 *          public_hit?:{product_id,report_no}, linked_other?:bool, siblings_pass?:int, haccp_same?:bool }
 */
'use strict';

function checksumOk(bc) {
  const s = String(bc || '');
  if (!/^(\d{8}|\d{13})$/.test(s)) return false;
  const d = s.split('').map(Number); const n = d.length; let t = 0;
  for (let i = 0; i < n - 1; i++) t += d[i] * (((n - 1 - i) % 2 === 1) ? 3 : 1);
  return (10 - (t % 10)) % 10 === d[n - 1];
}
const digits = (s) => String(s || '').replace(/\D/g, '');
const SIZE_RE = /(\d+(?:\.\d+)?)\s*(kg|g|ml|mL|ML|l|L|㎖|ℓ)(?![a-z가-힣])/i;
function sizeOf(name) {
  const m = String(name || '').match(SIZE_RE); if (!m) return null;
  const v = Number(m[1]); const u = m[2].toLowerCase();
  if (u === 'kg') return { v: v * 1000, u: 'g' }; if (u === 'g') return { v, u: 'g' };
  if (u === 'l' || u === 'ℓ') return { v: v * 1000, u: 'ml' }; return { v, u: 'ml' };
}
const compact = (s) => String(s || '').toLowerCase().replace(SIZE_RE, '').replace(/[^0-9a-z가-힣]/g, '');
function tokens(name) {
  return String(name || '').toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/[^0-9a-z가-힣]+/)
    .filter((t) => t && !/^\d+(\.\d+)?(kg|g|ml|l|입|개|봉|팩|매|ea)?$/.test(t) && !/^\d+$/.test(t))
    .filter((t) => t.length >= 2);
}
/** 이름 일치: web 토큰의 60% 이상이 후보 이름(공백 제거)에 들어 있거나, 공백 제거 이름이 서로 포함. */
// 변형어 — 한쪽 이름에만 있으면 다른 제품(제로 vs 원제품 등 · E8-08 실측). 비교는 소문자·공백 제거 문자열에서.
const VARIANTS = ['제로', 'zero', '라이트', 'light', '무가당', '저당', '무설탕', '슈가프리', '디카페인', '로우', '무지방', '저지방', '순한', '매운', '오리지널'];
const variantsOf = (s) => { const c = String(s || '').toLowerCase().replace(/\s/g, ''); return VARIANTS.filter((v) => c.includes(v)).join('|'); };
function nameMatch(a, b) {
  if (!a || !b) return false;
  if (variantsOf(a) !== variantsOf(b)) return false;
  const ca = compact(a); const cb = compact(b);
  if (ca.length >= 2 && cb.length >= 2 && (ca.includes(cb) || cb.includes(ca))) return true;
  // 붙여 쓴 이름(토큰 1개 · 예: «순창궁12가지양념쌈장») — web 이름 글자쌍의 80% 이상이 후보 이름에 있으면 일치(E2-15).
  if (ca.length >= 4) { const bg = []; for (let i = 0; i < ca.length - 1; i++) bg.push(ca.slice(i, i + 2)); if (bg.filter((g) => cb.includes(g)).length >= Math.ceil(bg.length * 0.8)) return true; }
  const ta = tokens(a); if (!ta.length) return false;
  const hit = ta.filter((t) => cb.includes(t)).length;
  return hit >= Math.max(1, Math.ceil(ta.length * 0.6));
}
const corp = (s) => String(s || '').replace(/\(주\)|㈜|주식회사|농업회사법인|유한회사|\(유\)|제?\d*공장|[a-z가-힣]*공장/g, '').replace(/[^0-9a-z가-힣]/gi, '').toLowerCase();
function makerMatch(a, b) { const x = corp(a); const y = corp(b); return x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x)); }

function decide(inp) {
  const checks = {};
  checks.checksum = checksumOk(inp.barcode);
  if (!checks.checksum) return { status: 'reject', reason: 'checksum', checks };
  checks.report_no = !!digits(inp.web.report_no) && digits(inp.web.report_no) === digits(inp.cand.report_no);
  if (!checks.report_no) return { status: 'reject', reason: 'report_no', checks };
  if (inp.public_hit) return { status: 'needs_review', reason: 'conflict_public', checks };
  if (inp.linked_other) return { status: 'needs_review', reason: 'conflict_linked', checks };
  if (inp.source === 'ocr') return inp.haccp_same ? { status: 'auto', reason: 'ocr_haccp_agree', checks } : { status: 'needs_review', reason: 'ocr_only', checks };
  const ws = (inp.web.content > 0 && inp.web.unit) ? { v: Number(inp.web.content), u: String(inp.web.unit).toLowerCase().replace('㎖', 'ml') === 'ml' ? 'ml' : 'g' } : sizeOf(inp.web.name);
  const cs = sizeOf(inp.cand.name);
  checks.size = !(ws && cs) || (ws.u === cs.u && Math.abs(ws.v - cs.v) < 0.5);
  if (!checks.size) return { status: 'needs_review', reason: 'size_mismatch', checks };
  checks.name = nameMatch(inp.web.name, inp.cand.name); checks.maker = makerMatch(inp.web.maker, inp.cand.maker);
  if (!checks.name && !checks.maker) return { status: 'needs_review', reason: 'identity', checks };
  if ((inp.siblings_pass || 1) > 1) return { status: 'needs_review', reason: 'multi', checks };
  return { status: 'auto', reason: 'haccp_exact', checks };
}

module.exports = { decide, checksumOk, nameMatch, makerMatch, sizeOf };
