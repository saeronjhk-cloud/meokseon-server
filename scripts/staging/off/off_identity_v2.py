# -*- coding: utf-8 -*-
r"""
off_identity_v2.py — OFF 제품 정체성 게이트 v2.1 (교차자문 2회차 반영)
SOURCE: D:\먹선\IP\off_identity_gate_v2.md  (v1 off_integration_v1.md §6.1 대체)
EVAL:   D:\먹선\eval_set\eval_set_off_identity_v2.md / test_off_identity_v2.py

핵심(v2.1):
- accept = 교차입증(accept_eligible). 브랜드 단독·generic 제품 단독·name_sim 단독 accept 금지(→review).
- 구조: hard-negative → variant-conflict → accept_eligible → weak(review) → reject.
- specific(강)/generic(약) 2-tier 제품 alias, 보수적 법인정규화(순서고정·그룹사 분리), 수기 음역,
  용량 조건부 reject, name_sim 0.80 강.
- alias는 ./alias/*.json 로드. 로더가 key·value 전부 _norm() 강제(human-error 방지).
순수 로직(DB·덤프 불필요) → eval 단독 검증 가능.
"""
import os, json, re

_DIR = os.path.dirname(os.path.abspath(__file__))
_ALIAS = os.path.join(_DIR, "alias")


# ── 정규화 유틸 ──────────────────────────────────────────────────────────────
def _norm(s):
    return "".join((s or "").lower().split())


def _bigrams(s):
    s = _norm(s)
    return set(s[i:i+2] for i in range(len(s) - 1)) if len(s) >= 2 else ({s} if s else set())


def _jaccard(a, b):
    A, B = _bigrams(a), _bigrams(b)
    return len(A & B) / len(A | B) if A and B else 0.0


# ── alias 로더 (key·value _norm 강제) ────────────────────────────────────────
def _load(name):
    with open(os.path.join(_ALIAS, name), encoding="utf-8") as f:
        raw = json.load(f)
    raw.pop("_comment", None)
    return raw


def _norm_map(d):
    """{key:[aliases]} → {norm(key):[norm(alias)...]} (빈값 제거)"""
    out = {}
    for k, vs in d.items():
        nk = _norm(k)
        if not nk:
            continue
        out[nk] = sorted({_norm(v) for v in vs if _norm(v)})
    return out


_BRANDS = _norm_map(_load("brand_aliases.json"))
_BRANDS_REVIEW = _norm_map(_load("brand_review_aliases.json"))
_PA = _load("product_aliases.json")
_SPECIFIC = _norm_map(_PA.get("specific", {}))
_GENERIC = _norm_map(_PA.get("generic", {}))
_BUCKETS = _norm_map(_load("category_buckets.json"))
_VT = _load("variant_tokens.json")
# variant: group -> {label: [norm tokens]}
_VARIANTS = {g: {lab: sorted({_norm(t) for t in toks}) for lab, toks in labs.items()}
             for g, labs in _VT.items()}

CORP_SUFFIX = ["(주)", "㈜", "주식회사", "(유)", "식품", "제과", "음료", "유업"]  # ⚠ 'F&B' 제외(동원F&B 보존)
# 수출용/글로벌 전용 규칙은 제거(2026-06-29 결정): 수출SKU는 내국인 미스캔이라 실효 없고,
# 내수제품↔OFF해외기여 위험은 countries_tags 노이즈로 신뢰탐지 불가 + OFF가 이미 low-confidence/경고로 완화.
CAT_COMPATIBLE = [frozenset({"음료", "유제품"}),
                  frozenset({"음료", "커피"}),    # 커피는 음료의 하위 — grounding(Maxim 커피믹스 오거부)에서 발견
                  frozenset({"유제품", "커피"})]  # 라떼류(커피+유제품)
# 제품 핵심명 → 버킷(코어충돌 판정용)
_CORE_BUCKET = {}
for _b, _kws in _BUCKETS.items():
    for _k in list(_GENERIC) + list(_SPECIFIC):
        if any(_k == kw or _k in _b for kw in _kws) or _k in _kws:
            pass
# 단순화: generic/specific 코어의 버킷은 한글 키가 어느 버킷 키워드에 들어가는지로 판정
def _core_bucket(core):
    for b, kws in _BUCKETS.items():
        if any(core == _norm(kw) or core in _norm(kw) or _norm(kw) in core for kw in kws):
            return b
    return None


# ── 카테고리 ─────────────────────────────────────────────────────────────────
def _bucket(*texts):
    blob = _norm(" ".join(t or "" for t in texts))
    for b, kws in _BUCKETS.items():
        if any(kw in blob for kw in kws):
            return b
    return None


def _cat_agree(a, b):
    return bool(a) and bool(b) and (a == b or frozenset({a, b}) in CAT_COMPATIBLE)


def _cat_conflict(a, b):
    return bool(a) and bool(b) and not _cat_agree(a, b)


# ── 브랜드 ───────────────────────────────────────────────────────────────────
def _strip_corp(s):
    out = s
    for suf in CORP_SUFFIX:
        out = out.replace(_norm(suf), "")
    return out


def _resolve_brand(our_brand, our_name):
    """canonical brand key(norm) 또는 None. 순서: alias-exact → 접미제거 → 이름토큰."""
    nb = _norm(our_brand)
    keys = sorted(_BRANDS, key=len, reverse=True)  # 긴 키(합성 브랜드) 우선 — 그룹사 분리 보존
    if nb:
        for k in keys:
            if k in nb:
                return k
        nb2 = _strip_corp(nb)
        for k in keys:
            if k in nb2:
                return k
    # 브랜드 공란 → 제품명에서 known-brand 정확 탐색
    nn = _norm(our_name)
    for k in keys:
        if k in nn:
            return k
    return None


def _brand_match(our_brand, our_name, off_brands, off_name, table):
    key = _resolve_brand(our_brand, our_name)
    if not key or key not in table:
        return False
    target = _norm((off_brands or "") + " " + (off_name or ""))
    variants = [key] + table[key]
    return any(v and v in target for v in variants)


# ── 이름 거의 동일(same-SKU 확신) 판정 — v2.3 ───────────────────────────────
def _strip_for_match(name):
    """정규화 + 법인접미·한글 브랜드 토큰 제거 후 영숫자/한글만. (브랜드만 다른 동일제품 매칭용)"""
    n = _norm(name)
    for suf in CORP_SUFFIX:
        n = n.replace(_norm(suf), "")
    for key, aliases in _BRANDS.items():
        for tok in [key] + aliases:
            if tok and any("가" <= ch <= "힣" for ch in tok):  # 한글 브랜드 토큰만 제거
                n = n.replace(tok, "")
    return re.sub(r"[^0-9a-z가-힣]", "", n)


def _name_match_strong(our_name, off_name, name_sim):
    """same-SKU 확신: 브랜드 제거 후 완전일치 or name_sim>=0.88."""
    a, b = _strip_for_match(our_name), _strip_for_match(off_name)
    if a and b and len(a) >= 2 and a == b:
        return True
    return name_sim >= 0.88


# ── 제품 코어(specific/generic) ──────────────────────────────────────────────
def _cores(text, table):
    """text(한글 또는 로마자)에 존재하는 코어 키 집합."""
    nt = _norm(text)
    found = set()
    for k, aliases in table.items():
        if k in nt or any(a and a in nt for a in aliases):
            found.add(k)
    return found


# ── variant ──────────────────────────────────────────────────────────────────
def _variant_labels(text, group):
    nt = _norm(text)
    labs = set()
    for lab, toks in _VARIANTS.get(group, {}).items():
        if any(t and t in nt for t in toks):
            labs.add(lab)
    return labs


def _variant_status(our_name, off_name):
    """(conflict, critical, one_sided). 자문 2차: 한쪽만 명시(OFF generic)도 '확정 불가' → review.
    conflict  : 양쪽 다 토큰 있고 다름
    one_sided : 한쪽에만 토큰 있음(예: 우리 '매운맛' ↔ OFF generic)
    critical  : diet(제로/라이트/저당/저염) 충돌·한쪽 — 영양 직접영향, 운영 후 reject 승격 후보
    """
    conflict = one_sided = critical = False
    for g in _VARIANTS:
        o = _variant_labels(our_name, g)
        f = _variant_labels(off_name, g)
        if o and f and o != f:
            conflict = True
            if g == "diet":
                critical = True
        elif bool(o) != bool(f):  # 정확히 한쪽만
            one_sided = True
            if g == "diet":
                critical = True
    return conflict, critical, one_sided


def _has_any(text, tokens):
    nt = _norm(text)
    return any(_norm(t) in nt for t in tokens)


# ── 용량 ─────────────────────────────────────────────────────────────────────
def _parse_qty(q):
    """'120g','1.25L','5x30g' → 그램/ml 환산 대략값(float) 또는 None."""
    if not q:
        return None
    s = str(q).lower().replace(" ", "")
    m = re.match(r"(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)", s)
    mult = 1.0
    if m:
        mult = float(m.group(1))
        s = s[m.end():]
    m2 = re.search(r"(\d+(?:\.\d+)?)\s*(kg|g|l|ml)", s)
    if not m2:
        return None
    val = float(m2.group(1)); unit = m2.group(2)
    if unit == "kg":
        val *= 1000
    elif unit == "l":
        val *= 1000
    return val * mult


def _qty_signal(our_qty, off_qty, off_name):
    """return ('hard'|'review'|'match'|None). 둘 다 파싱될 때만."""
    a, b = _parse_qty(our_qty), _parse_qty(off_qty)
    if a is None or b is None or a <= 0 or b <= 0:
        return None
    r = max(a, b) / min(a, b)
    multi = bool(_variant_labels(off_name, "form") & {"multi"})
    if r >= 3:
        return "hard" if multi else "review"
    if r > 1.2:
        return "review"
    return "match"


# ── 신호 종합 ────────────────────────────────────────────────────────────────
class S:  # signals
    pass


def extract_signals(our_name, our_brand, our_category, off_name, off_brands,
                    off_category, off_countries, barcode, our_qty=None, off_qty=None):
    s = S()
    s.cat_our = _bucket(our_category, our_name)
    s.cat_off = _bucket(off_category, off_name)
    s.cat_conflict = _cat_conflict(s.cat_our, s.cat_off)
    s.category_agree = _cat_agree(s.cat_our, s.cat_off)

    s.brand_match = _brand_match(our_brand, our_name, off_brands, off_name, _BRANDS)
    s.brand_review_match = (not s.brand_match) and _brand_match(our_brand, our_name, off_brands, off_name, _BRANDS_REVIEW)

    our_spec, off_spec = _cores(our_name, _SPECIFIC), _cores(off_name, _SPECIFIC)
    our_gen, off_gen = _cores(our_name, _GENERIC), _cores(off_name, _GENERIC)
    s.specific_match = bool(our_spec & off_spec)
    s.generic_match = bool(our_gen & off_gen)

    # core_name_conflict: 양쪽 다 코어 있는데 공유 없음
    s.core_conflict = False
    if our_spec and off_spec and not (our_spec & off_spec):
        s.core_conflict = True
    if our_gen and off_gen and not (our_gen & off_gen):
        # 같은 버킷일 때만 충돌(다른 버킷이면 cat_conflict가 처리)
        ob = {_core_bucket(c) for c in our_gen}
        fb = {_core_bucket(c) for c in off_gen}
        if ob & fb:
            s.core_conflict = True

    s.name_sim = _jaccard(our_name, off_name)

    countries = _norm(off_countries if isinstance(off_countries, str) else " ".join(off_countries or []))
    is_korea = any(k in countries for k in ("korea", "southkorea", "대한민국", "한국")) or str(barcode or "").startswith("880")
    s.foreign = bool(countries) and not is_korea

    s.variant_conflict, s.critical_variant, s.variant_one_sided = _variant_status(our_name, off_name)

    s.qty = _qty_signal(our_qty, off_qty, off_name)
    s.quantity_match = (s.qty == "match")
    s.multipack_hard = (s.qty == "hard")
    if s.qty == "review":
        s.variant_conflict = True  # 용량 리뉴얼 의심 → variant 취급

    # accept_eligible (v2.3) — same-SKU 확신만. 이름 거의 동일 OR 강신호+용량일치.
    # specific/brand/generic/로마자 '단독'은 accept 아님 → review (SKU 미확정).
    s.strong_alias = s.brand_match or s.specific_match
    s.name_match_strong = _name_match_strong(our_name, off_name, s.name_sim)
    s.accept_eligible = (
        not s.core_conflict and not s.cat_conflict and not s.foreign
        and not s.variant_conflict and not s.variant_one_sided
        and not s.critical_variant and not s.multipack_hard
        and (
            s.name_match_strong
            or (s.strong_alias and s.quantity_match)
        )
    )
    s.review_eligible = (
        s.brand_match or s.brand_review_match or s.specific_match or s.generic_match
        or s.category_agree or s.name_sim >= 0.45
    )
    return s


def identity_check_v2(our_name, our_brand, our_category, off_name, off_brands,
                      off_category, off_countries, barcode, our_qty=None, off_qty=None):
    """return 'accept' | 'review' | 'reject'."""
    s = extract_signals(our_name, our_brand, our_category, off_name, off_brands,
                        off_category, off_countries, barcode, our_qty, off_qty)
    # 1) HARD CONFLICT
    if s.core_conflict:
        return "reject"
    if s.cat_conflict:
        return "reject"
    if s.foreign and not s.accept_eligible:
        return "reject"
    if s.multipack_hard:
        return "reject"
    # 2) diet(제로/라이트/저당/저염) 충돌·불확실 → reject (제로에 일반 수치는 '참고'가 아니라 위해)
    if s.critical_variant:
        return "reject"
    # 3) 그 외 variant 충돌 OR 한쪽-variant(맛·매운정도·용기/SKU) → review (확정 불가)
    if s.variant_conflict or s.variant_one_sided:
        return "review"
    # 4) ACCEPT — same-SKU 확신(이름 거의 동일 OR 강신호+용량일치)만
    if s.accept_eligible:
        return "accept"
    # 4) weak positive → review
    if s.review_eligible:
        return "review"
    return "reject"


if __name__ == "__main__":
    print("off_identity_v2 loaded:",
          len(_BRANDS), "brands /", len(_SPECIFIC), "specific /",
          len(_GENERIC), "generic /", len(_BUCKETS), "buckets")
