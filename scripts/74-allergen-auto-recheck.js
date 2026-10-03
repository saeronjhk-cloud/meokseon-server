/**
 * 74-allergen-auto-recheck.js — 이미 «자동 반영»된 알레르기 행을 새 게이트(v3)로 다시 판정 (세션74 U72-9 · 읽기 전용)
 * =============================================================================
 * 왜: 게이트 v2 는 3음절 이상 이름 오독(돼지고기→돼지고가 등)과 불용어 겹침 오독(밀→및)을 통과시켰다.
 *     그 사이 자동 반영된 행이 있다면 «알레르기 누락» 상태로 앱에 나가 있을 수 있다.
 * 하는 일: contribution_review(axis=allergens · status=auto_applied) 의 제보 OCR 원문을 v3 게이트로 다시 판정해
 *     «이제는 큐로 갈 것»을 줄로 찍는다. ★ DB 를 바꾸지 않는다. 나온 행은 /admin 에서 사진 보며 되돌리기·정정.
 * 사용(Railway 콘솔 · 명령에 한글 0):  node /app/scripts/74-allergen-auto-recheck.js
 * 출력: RECHECK {review_id, product_id, contribution_id, gate_then, pass_now, reason, residue}  · 끝에 SUMMARY
 */
const db = require('../src/config/database');
const { evaluateAllergenAutoGate, GATE_VERSION } = require('../src/services/allergenAutoGate');

(async () => {
  const r = await db.query(
    "SELECT r.review_id, r.product_id, r.contribution_id, r.evidence, c.data FROM contribution_review r " +
    "JOIN contributions c ON c.contribution_id = r.contribution_id " +
    "WHERE r.axis = 'allergens' AND r.status = 'auto_applied' ORDER BY r.review_id");
  let still = 0; let flip = 0; let noText = 0;
  for (const x of r.rows) {
    const d = typeof x.data === 'string' ? JSON.parse(x.data) : (x.data || {});
    const ev = typeof x.evidence === 'string' ? JSON.parse(x.evidence) : (x.evidence || {});
    const text = d && d.ocr_raw_text;
    if (!text) { noText++; continue; }
    const g = evaluateAllergenAutoGate({ text });
    if (g.pass) { still++; continue; }
    flip++;
    console.log('RECHECK', JSON.stringify({ review_id: x.review_id, product_id: x.product_id, contribution_id: x.contribution_id,
      gate_then: ev.auto_gate && ev.auto_gate.gate_version, pass_now: false, reason: g.reason, residue: g.residue }));
  }
  console.log('SUMMARY', JSON.stringify({ gate_now: GATE_VERSION, auto_applied: r.rows.length, still_pass: still, now_queue: flip, no_text: noText }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
