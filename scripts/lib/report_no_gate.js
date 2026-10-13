'use strict';
/**
 * report_no_gate.js — ★ 세션78 · 판매처 라벨(OCR)과 우리 DB 제품이 «같은 품목»인지 품목보고번호로 판정한다.
 *   쓰는 곳: 판매처 상세 이미지로 결손을 채우는 배치(쇼핑몰 페이지엔 바코드가 거의 없다 — eval_websearch_fill_v1).
 *   정답: IP/eval_report_no_gate_v1/cases_v1.json (구현 전 고정) = tests/fixtures/report_no_gate_v1.json
 * 판정
 *   match    — 라벨에서 읽은 번호(서로 다른 것)가 «하나»이고 DB 번호와 정확히 같다 → 채움 허용(검토 대기열로)
 *   multi    — 번호가 여럿이고 그중 하나가 일치(묶음 페이지) → 보류(어느 라벨 값인지 모른다)
 *   partial  — 한쪽이 다른 쪽의 접두(OCR 자릿수 잘림/덧붙음, 10자리 이상) → 보류
 *   near     — 같은 길이에 한 자리만 다름(OCR 오독 가능) → 보류
 *   mismatch — 번호가 있는데 위 어느 것도 아님(다른 제품) → 거부
 *   missing  — 라벨에서 번호를 못 읽음 → 보류 · no_db — DB 번호 없음/숫자 10자리 미만 → 보류
 * ⚠ 같은 품목보고번호를 여러 바코드(용량 차이)가 공유한다(DB 최대 90개). 원재료·알레르기·100g당 영양은 같지만
 *   1회분 값은 용량별로 다를 수 있다 — 채움 쪽에서 100g 기준으로만 비교·저장할 것.
 */
const LABEL = /품목\s{0,3}(?:제조\s{0,3})?보고\s{0,3}번호/g;

function extractAll(text) {
  const t = String(text || '').slice(0, 50000);
  const out = [];
  for (const m of t.matchAll(LABEL)) {
    const win = t.slice(m.index + m[0].length, m.index + m[0].length + 60);
    const g = win.match(/^[\s:：.]{0,6}([\d][\d\s-]{8,24}\d)/);
    if (!g) continue;
    const d = g[1].replace(/[\s-]/g, '');
    if (d.length >= 10 && d.length <= 16) out.push(d);
  }
  return [...new Set(out)];
}

function reportNoGate(text, dbReportNo) {
  const db = String(dbReportNo || '').replace(/\D/g, '');
  const found = extractAll(text);
  if (db.length < 10) return { status: 'no_db', found };
  if (!found.length) return { status: 'missing', found };
  const exact = found.includes(db);
  if (exact) return { status: found.length === 1 ? 'match' : 'multi', found };
  if (found.some((f) => Math.min(f.length, db.length) >= 10 && f !== db && (f.startsWith(db) || db.startsWith(f)))) return { status: 'partial', found };
  if (found.some((f) => f.length === db.length && [...f].filter((c, i) => c !== db[i]).length === 1)) return { status: 'near', found };
  return { status: 'mismatch', found };
}

module.exports = { reportNoGate, extractReportNosAll: extractAll };
