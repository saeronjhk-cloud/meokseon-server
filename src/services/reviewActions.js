/**
 * reviewActions.js — 검토 큐 상태전이 리듀서 (단일 소스, 순수·무 I/O)
 *
 * 두 검토 큐의 액션을 **순수 함수**로 판정한다. admin API(adminRoutes.js)와
 * Eval 하네스(run_import_bridge_eval.js)가 이 파일을 공유 → 로직 복제 금지.
 *
 * 설계 근거:
 *   - 인수인계 2026-07-05 밤 §8-1(#3 review 10,087 + #7 collapse 큐 3,326 통합 검토 UI).
 *   - IP/import_bridge_eval_v1.md §1.2d(검토 액션 상태전이).
 *   - 원칙(5): 답은 AI 추론이 아니라 **엔진(결정적 리듀서)** 안에서 도출. 리듀서는 시계(Date)·DB를
 *     만지지 않는다 → 완전 결정적·테스트 가능. 시각(reviewed_at)은 SQL 계층이 NOW() 로 부여.
 *   - 정책 A(015 §0.3): import_nutrition_product_match.decision='accept' 는 오직
 *     resolution_status='human_verified' 경로에만(사람 검토). 리듀서가 강제.
 *   - collapse 큐(016)는 v1 에서 **승격(accept) 경로 없음** — 모니터링·기각 중심.
 *     승격은 §8 옵션3(바코드 확보 후 별도)이라 여기서 INVALID 처리.
 *
 * 반환 규약(throw 하지 않음 — 하네스가 키 비교로 검증):
 *   {
 *     ok:      true|false,
 *     error:   null | 'INVALID_ACTION' | 'INVALID_TRANSITION' | 'MISSING_ACTOR',
 *     changed: boolean,          // false = 멱등 no-op(이미 목표 상태) 또는 오류
 *     set:     { col: value },   // UPDATE 할 non-timestamp 컬럼(changed=false 면 {})
 *     touchReviewedAt: boolean,  // true 면 SQL 계층이 reviewed_at=NOW() 부여
 *     // 편의 미러(가독성·Eval): status | decision | resolution_status
 *   }
 */

// ── 허용 액션·상태 화이트리스트(UI·API 공용 export) ──────────────────────────
const COLLAPSE_ACTIONS = Object.freeze(['dismiss', 'reviewed', 'reopen']);
const MATCH_ACTIONS = Object.freeze(['human_verified', 'reject', 'reopen']);
const COLLAPSE_STATUSES = Object.freeze(['pending', 'reviewed', 'dismissed']);
// 엔티티 멤버십 큐(product_entity_members, 018): status candidate|approved|rejected|split|undone
const ENTITY_ACTIONS = Object.freeze(['approve', 'reject', 'split', 'reopen']);
const ENTITY_STATUSES = Object.freeze(['candidate', 'approved', 'rejected', 'split', 'undone']);
// 엔티티 영양 프로필 큐(entity_nutrition_profiles, 018): status candidate|approved|rejected. reviewed_by 컬럼 없음.
const PROFILE_ACTIONS = Object.freeze(['approve', 'reject', 'reopen']);
const PROFILE_STATUSES = Object.freeze(['candidate', 'approved', 'rejected']);

// ── bulk(대량) 안전 가드(단일 소스 — API·Eval 공용) ──────────────────────────
// #3 대량 검토 운영: 10,087 match 큐를 페이지 단위로 대량 처리하되, 되돌릴 수 없거나
// per-item 확인이 필요한 액션은 bulk 에서 원천 차단한다.
//   - match  : reject|reopen 만 허용. **human_verified(승격)는 bulk 금지** —
//              승격은 보강근거(바코드·수입원·원산지·내용량)를 건별 확인해야 하는
//              안전 게이트(§4.7 ③, verifyEligibility)라 대량화하면 안 됨.
//   - collapse: dismiss|reopen 만 허용. reviewed(사람이 개별 판정) 는 bulk 금지 —
//              "봤다" 표기를 대량으로 찍으면 검토 신뢰가 무너짐. 되돌릴 땐 reopen.
// 원칙(5): 무엇을 대량화할지는 AI 추론이 아니라 이 결정적 화이트리스트가 판정.
const BULK_ALLOWED = Object.freeze({
  collapse: Object.freeze(['dismiss', 'reopen']),
  match: Object.freeze(['reject', 'reopen']),
  // 엔티티 큐(product_entity_members): 사람 1클릭 대량 승인/반려/재큐잉만.
  //   approve 는 강조건(AUTO_APPROVE_ENTITY/BULK_REVIEW_READY) route 에만 큐 계층에서 노출(HOLD/NAME_ONLY 제외).
  //   split(다른 제품 확정)은 그룹별 판단이라 bulk 제외 — 건별 처리(human_verified 를 bulk 에서 뺀 것과 동형).
  entity: Object.freeze(['approve', 'reject', 'reopen']),
  // 영양 프로필 큐: 일괄 승인/반려/재큐잉. 상이(conflict_status='review')는 큐 계층에서 제외(건별).
  profile: Object.freeze(['approve', 'reject', 'reopen']),
});
function isBulkAllowed(queue, action) {
  const list = BULK_ALLOWED[queue];
  return Array.isArray(list) && list.includes(action);
}

function fail(error) {
  return { ok: false, error, changed: false, set: {}, touchReviewedAt: false };
}
function noop(mirror) {
  return { ok: true, error: null, changed: false, set: {}, touchReviewedAt: false, ...mirror };
}
function apply(set, mirror) {
  return { ok: true, error: null, changed: true, set, touchReviewedAt: true, ...mirror };
}

// ─────────────────────────────────────────────────────────────────────────────
// collapse 큐(import_collapse_conflict): status pending|reviewed|dismissed
//   dismiss  : pending|reviewed → dismissed   (dismissed 면 no-op)
//   reviewed : pending          → reviewed    (reviewed 면 no-op / dismissed 면 INVALID)
//   reopen   : reviewed|dismissed → pending   (pending 면 no-op)
// actor(reviewed_by) 는 상태를 바꾸는 액션에 필수. review_note 는 선택(컬럼 존재).
// ─────────────────────────────────────────────────────────────────────────────
function collapseAction(row, action, actor, note) {
  if (!COLLAPSE_ACTIONS.includes(action)) return fail('INVALID_ACTION');
  const cur = row && row.status;
  if (!COLLAPSE_STATUSES.includes(cur)) return fail('INVALID_TRANSITION');

  let target;
  if (action === 'dismiss') {
    if (cur === 'dismissed') return noop({ status: cur });
    target = 'dismissed';
  } else if (action === 'reviewed') {
    if (cur === 'reviewed') return noop({ status: cur });
    if (cur === 'dismissed') return fail('INVALID_TRANSITION'); // 먼저 reopen 필요
    target = 'reviewed';
  } else { // reopen
    if (cur === 'pending') return noop({ status: cur });
    target = 'pending';
  }

  if (!actor || !String(actor).trim()) return fail('MISSING_ACTOR');
  const set = { status: target, reviewed_by: String(actor).trim() };
  if (note != null && String(note).trim()) set.review_note = String(note).trim();
  // reopen 은 재큐잉 — 이전 검토자 흔적을 지워 큐에 깨끗이 재노출(review_note 는 감사로 남기지 않음).
  if (action === 'reopen') { set.reviewed_by = null; set.review_note = null; }
  return apply(set, { status: target });
}

// ─────────────────────────────────────────────────────────────────────────────
// match review 큐(import_nutrition_product_match): decision review|accept|reject
//   human_verified(승격) : review → decision=accept, resolution_status=human_verified
//   reject               : review → decision=reject, resolution_status=rejected
//   reopen               : accept|reject → decision=review, resolution_status=needs_review
// 정책 A: accept 는 human_verified 와 함께만(015 CHECK). 리듀서가 항상 쌍으로 세팅.
// 제품당 accept ≤ 1(015 uq_imp_match_accept_per_product)은 DB 가 최종 방어 → API 가 409 매핑.
// ─────────────────────────────────────────────────────────────────────────────
function matchAction(row, action, actor) {
  if (!MATCH_ACTIONS.includes(action)) return fail('INVALID_ACTION');
  const dec = row && row.decision;
  if (!['review', 'accept', 'reject'].includes(dec)) return fail('INVALID_TRANSITION');

  let decision, resolution_status;
  if (action === 'human_verified') {
    if (dec === 'accept') return noop({ decision: dec, resolution_status: row.resolution_status });
    if (dec === 'reject') return fail('INVALID_TRANSITION'); // 먼저 reopen
    decision = 'accept'; resolution_status = 'human_verified';
  } else if (action === 'reject') {
    if (dec === 'reject') return noop({ decision: dec, resolution_status: row.resolution_status });
    if (dec === 'accept') return fail('INVALID_TRANSITION'); // 먼저 reopen
    decision = 'reject'; resolution_status = 'rejected';
  } else { // reopen
    if (dec === 'review') return noop({ decision: dec, resolution_status: row.resolution_status });
    decision = 'review'; resolution_status = 'needs_review';
  }

  if (!actor || !String(actor).trim()) return fail('MISSING_ACTOR');
  const set = { decision, resolution_status, reviewed_by: String(actor).trim() };
  if (action === 'reopen') set.reviewed_by = null; // 재큐잉
  return apply(set, { decision, resolution_status });
}

// ─────────────────────────────────────────────────────────────────────────────
// 엔티티 멤버십 큐(product_entity_members, 018): 비파괴 소프트 병합 상태전이.
//   approve : candidate → approved   (이 멤버가 엔티티에 속함 = resolved view 상속 자격. 정책(i) 사람 1클릭)
//   reject  : candidate → rejected   (엔티티에서 제외)
//   split   : candidate → split      (같은 이름이나 다른 제품 확정 = 병합 금지)
//   reopen  : approved|rejected|split → candidate (재큐잉; 오병합 되돌리기 = FK 무접촉, status 만)
// approve/reject/split 은 상호 배타 결정 → 바꾸려면 reopen 먼저(match 리듀서와 동형).
// own nutrition 무접촉: approve 는 "그룹 동일성" 승인일 뿐, 영양 상속은 entity_nutrition_profiles 승인이 별도.
// 제품당 approved ≤1(018 uq_pem_approved_per_product)은 DB 가 최종 방어 → API 가 409 매핑.
// ─────────────────────────────────────────────────────────────────────────────
function entityAction(row, action, actor) {
  if (!ENTITY_ACTIONS.includes(action)) return fail('INVALID_ACTION');
  const cur = row && row.status;
  if (!ENTITY_STATUSES.includes(cur)) return fail('INVALID_TRANSITION');

  let target;
  if (action === 'approve') {
    if (cur === 'approved') return noop({ status: cur });
    if (cur === 'rejected' || cur === 'split') return fail('INVALID_TRANSITION'); // reopen 먼저
    target = 'approved';
  } else if (action === 'reject') {
    if (cur === 'rejected') return noop({ status: cur });
    if (cur === 'approved' || cur === 'split') return fail('INVALID_TRANSITION');
    target = 'rejected';
  } else if (action === 'split') {
    if (cur === 'split') return noop({ status: cur });
    if (cur === 'approved' || cur === 'rejected') return fail('INVALID_TRANSITION');
    target = 'split';
  } else { // reopen
    if (cur === 'candidate') return noop({ status: cur });
    target = 'candidate';
  }

  if (!actor || !String(actor).trim()) return fail('MISSING_ACTOR');
  const set = { status: target, reviewed_by: String(actor).trim() };
  if (action === 'reopen') set.reviewed_by = null; // 재큐잉
  return apply(set, { status: target });
}

// ─────────────────────────────────────────────────────────────────────────────
// 엔티티 영양 프로필 큐(entity_nutrition_profiles, 018): 승인 시 resolved view 가 상속(own 없을 때만).
//   approve : candidate → approved   (per-100 공유 영양 활성. serving 은 절대 상속 안 함=DB CHECK)
//   reject  : candidate → rejected
//   reopen  : approved|rejected → candidate
// ★ 멤버 승인(entityAction)과 분리(자문 "승인 버튼 분리"): 그룹 동일성 승인 ≠ 영양 공유 승인.
//   resolved view 상속 = 멤버 approved AND 프로필 approved AND conflict_status='none'.
// entity_nutrition_profiles 엔 reviewed_by/at 컬럼이 없어 status 만 UPDATE(touchReviewedAt=false).
// 엔티티당 approved 프로필 ≤1(018 uq_enp_approved_per_entity)은 DB 최종 방어 → API 가 409 매핑.
// ─────────────────────────────────────────────────────────────────────────────
function profileAction(row, action, actor) {
  if (!PROFILE_ACTIONS.includes(action)) return fail('INVALID_ACTION');
  const cur = row && row.status;
  if (!PROFILE_STATUSES.includes(cur)) return fail('INVALID_TRANSITION');
  let target;
  if (action === 'approve') {
    if (cur === 'approved') return noop({ status: cur });
    if (cur === 'rejected') return fail('INVALID_TRANSITION');
    target = 'approved';
  } else if (action === 'reject') {
    if (cur === 'rejected') return noop({ status: cur });
    if (cur === 'approved') return fail('INVALID_TRANSITION');
    target = 'rejected';
  } else { // reopen
    if (cur === 'candidate') return noop({ status: cur });
    target = 'candidate';
  }
  if (!actor || !String(actor).trim()) return fail('MISSING_ACTOR');
  return { ok: true, error: null, changed: true, set: { status: target }, touchReviewedAt: false, status: target };
}

module.exports = {
  collapseAction,
  matchAction,
  entityAction,
  profileAction,
  isBulkAllowed,
  BULK_ALLOWED,
  COLLAPSE_ACTIONS,
  MATCH_ACTIONS,
  COLLAPSE_STATUSES,
  ENTITY_ACTIONS,
  ENTITY_STATUSES,
  PROFILE_ACTIONS,
  PROFILE_STATUSES,
};
