"""
off_normalize.py — OpenFoodFacts 정규화 + 품질게이트 (순수 로직, I/O 분리)
SOURCE: D:\\먹선\\IP\\off_integration_v1.md §5(필드매핑·단위변환), §6(품질게이트), §8(blind spots)
Eval: D:\\먹선\\eval_set\\eval_set_off_v1.md

설계 메모:
- 외부 의존성 없음(duckdb/ijson은 추출 I/O 스크립트에서만). → eval로 단독 검증 가능.
- core7(A등급 필수): calories, sodium, sugars, sat_fat, total_fat, protein, fiber.
  cholesterol·trans는 0오염 우려로 A 필수에서 제외(§8.3), 있으면 보조로만 사용.
- energy 재구성 >40% 불일치는 'core value(열량 vs 매크로) 충돌'로 보아 Reject(§6 보수 해석).
"""

PARSER_VERSION = "off_parse_v1"
NORMALIZER_VERSION = "off_norm_v1"
QUALITY_GATE_VERSION = "off_gate_v1"

CORE7 = ["calories", "sodium_mg", "total_sugars", "saturated_fat", "total_fat", "protein", "dietary_fiber"]


# ── §5 파싱: 빈문자/키없음 → None, 명시적 0 → 0 ────────────────────────────
def parse_amt(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if s == "" or s.lower() in ("n/a", "na", "-", "null", "none"):
        return None
    s = s.replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


def _get(d, key):
    return parse_amt(d.get(key)) if key in d else None


# ── §5 정규화 + 단위변환 ───────────────────────────────────────────────────
def normalize_off(fields):
    """OFF _100g 필드(dict) → 정규화 dict. fields는 raw의 nutriments 평면 dict 가정."""
    out = {}

    # energy: kcal 우선, 없으면 kJ/4.184
    kcal = _get(fields, "energy-kcal_100g")
    if kcal is not None:
        out["calories"] = kcal
        out["energy_source"] = "kcal"
    else:
        kj = _get(fields, "energy_100g")  # OFF energy_100g는 kJ
        if kj is not None:
            out["calories"] = round(kj / 4.184, 2)
            out["energy_source"] = "kJ_converted"
        else:
            out["calories"] = None
            out["energy_source"] = None

    out["protein"]       = _get(fields, "proteins_100g")
    out["total_fat"]     = _get(fields, "fat_100g")
    out["saturated_fat"] = _get(fields, "saturated-fat_100g")
    out["trans_fat"]     = _get(fields, "trans-fat_100g")
    out["total_carbs"]   = _get(fields, "carbohydrates_100g")
    out["total_sugars"]  = _get(fields, "sugars_100g")
    out["dietary_fiber"] = _get(fields, "fiber_100g")

    # sodium: sodium_100g(g)*1000. 없으면 salt/2.5*1000
    sodium_g = _get(fields, "sodium_100g")
    salt_g = _get(fields, "salt_100g")
    if sodium_g is not None:
        out["sodium_mg"] = round(sodium_g * 1000, 2)
    elif salt_g is not None:
        out["sodium_mg"] = round(salt_g / 2.5 * 1000, 2)
    else:
        out["sodium_mg"] = None

    chol_g = _get(fields, "cholesterol_100g")
    out["cholesterol_mg"] = round(chol_g * 1000, 2) if chol_g is not None else None

    # basis 판정(§5/§7): 카테고리 단독 추정 금지. nutrition_data_per/serving 등 강근거시만.
    out["basis_amount"] = 100
    bu, conf = derive_basis(fields)
    out["basis_unit"] = bu
    out["basis_confident"] = conf

    return out, (sodium_g, salt_g)


def derive_basis(fields):
    """(basis_unit, confident). 'g'|'mL'|'unknown'. 액상 강근거 있을 때만 mL."""
    per = (fields.get("nutrition_data_per") or "").lower()
    # OFF nutrition_data_per는 '100g'|'100ml'|'serving' 등
    if "ml" in per or "100ml" in per:
        return "mL", True
    if per in ("100g",):
        return "g", True
    # 보조: serving_size/quantity 단위에 ml/l
    q = (str(fields.get("serving_size") or "") + " " + str(fields.get("quantity") or "")).lower()
    if any(t in q for t in ("ml", " l", "liter", "litre")):
        return "mL", True
    if any(t in q for t in (" g", "gram", "kg")):
        return "g", True
    # §5: 카테고리 단독 추정 금지 → 단위 근거 없으면 unknown(불확실)
    return "unknown", False


# ── §6 단위 충돌 게이트 ────────────────────────────────────────────────────
def sodium_salt_conflict(sodium_g, salt_g):
    """둘 다 존재 시 |diff|>max(50mg,20%) → True(충돌)."""
    if sodium_g is None or salt_g is None:
        return False
    sodium_direct = sodium_g * 1000.0
    sodium_from_salt = salt_g / 2.5 * 1000.0
    diff = abs(sodium_direct - sodium_from_salt)
    thresh = max(50.0, 0.20 * max(sodium_direct, sodium_from_salt, 1e-9))
    return diff > thresh


# ── §6 불변식 ──────────────────────────────────────────────────────────────
def invariant_violation(n):
    def gt(a, b):
        return a is not None and b is not None and a > b + 1e-9
    if gt(n.get("total_sugars"), n.get("total_carbs")):
        return "sugars>carbs"
    if gt(n.get("saturated_fat"), n.get("total_fat")):
        return "satfat>fat"
    if gt(n.get("trans_fat"), n.get("total_fat")):
        return "trans>fat"
    s = n.get("sodium_mg")
    if s is not None and s >= 100000:
        return "sodium>=100000"
    return None


def macro_sum(n):
    p, f, c = n.get("protein"), n.get("total_fat"), n.get("total_carbs")
    if None in (p, f, c):
        return None
    return p + f + c


def energy_band(n):
    """'A'|'B'|'C'|'REJECT'. recon = carbs*4 + protein*4 + fat*9."""
    cal = n.get("calories")
    p, f, c = n.get("protein"), n.get("total_fat"), n.get("total_carbs")
    if cal is None or None in (p, f, c) or cal <= 0:
        return "C"  # 계산 불가 → C
    recon = c * 4 + p * 4 + f * 9
    diff = abs(recon - cal) / cal
    if diff <= max(0.15, 40.0 / cal):
        return "A"
    if diff <= 0.25:
        return "B"
    if diff <= 0.40:
        return "C"
    return "REJECT"  # >40%: 열량 vs 매크로(핵심값) 충돌 → Reject


def core7_presence(n):
    present = [k for k in CORE7 if n.get(k) is not None]
    return present, [k for k in CORE7 if n.get(k) is None]


# ── §6 종합 등급 판정 ──────────────────────────────────────────────────────
def quality_grade(n, sodium_g=None, salt_g=None, identity="accept"):
    """
    return (grade, info)
      grade: 'A' | 'B' | 'C' | 'Reject'
      info: dict(reasons, warn, energy_band, missing_core7)
    identity: 'accept' | 'review' | 'reject' (제품정체성 게이트 결과 §6.1)
    """
    reasons = []

    inv = invariant_violation(n)
    if inv:
        return "Reject", {"reasons": [f"invariant:{inv}"]}

    ms = macro_sum(n)
    if ms is not None and ms > 105 + 1e-9:
        return "Reject", {"reasons": [f"macro_sum>{105}:{round(ms,2)}"]}

    if sodium_salt_conflict(sodium_g, salt_g):
        return "Reject", {"reasons": ["sodium_salt_conflict"]}

    if identity == "reject":
        return "Reject", {"reasons": ["identity_reject"]}

    eb = energy_band(n)
    if eb == "REJECT":
        return "Reject", {"reasons": ["energy_recon>40%"]}

    warn = ms is not None and 100 - 1e-9 <= ms <= 105 + 1e-9
    if warn:
        reasons.append(f"macro_sum_warn:{round(ms,2)}")

    present, missing = core7_presence(n)
    info = {"reasons": reasons, "warn": warn, "energy_band": eb, "missing_core7": missing}

    # identity review → 최대 B
    if identity == "review":
        info["reasons"].append("identity_review")
        return ("B" if eb in ("A", "B") and not missing else "C"), info

    # A: 정체성 accept + core7 전부 + basis 확실 + energy A
    if (identity == "accept" and not missing
            and n.get("basis_confident", True) and eb == "A"):
        return "A", info

    # B: 불변식 OK + (core7 대체로 존재 or energy A/B)
    if eb in ("A", "B") and len(missing) <= 2:
        return "B", info

    return "C", info


# ── §6.1 제품 정체성 게이트 (토큰 분리 비교, 양 자문 reconcile) ─────────────
# 단순 전체 문자열 유사도 단독 금지. 브랜드/카테고리/핵심명 토큰 분리.
BRAND_SYNONYMS = {
    "농심": ["nongshim"], "오뚜기": ["ottogi"], "삼양": ["samyang"],
    "롯데": ["lotte"], "해태": ["haitai"], "오리온": ["orion"],
    "동원": ["dongwon"], "풀무원": ["pulmuone"], "빙그레": ["binggrae"],
    "씨제이": ["cj"], "코카콜라": ["coca-cola", "coca cola", "cocacola"],
}
FLAVOR_TOKENS = ["오리지널", "오리지날", "original", "매운맛", "순한맛", "spicy",
                 "제로", "zero", "라이트", "light", "컵", "봉지", "cup"]
CAT_BUCKETS = {
    "라면": ["라면", "면", "noodle", "ramyun", "ramen"],
    "음료": ["음료", "주스", "콜라", "사이다", "beverage", "drink", "juice", "soda", "cola", "water"],
    "과자": ["과자", "스낵", "snack", "biscuit", "cookie", "크래커", "cracker", "chip", "칩"],
    "아이스크림": ["아이스크림", "ice cream", "icecream", "빙과"],
    "유제품": ["우유", "요거트", "milk", "yogurt", "치즈", "cheese"],
}


def _norm(s):
    return "".join((s or "").lower().split())


def _has_hangul(s):
    return any("가" <= ch <= "힣" for ch in (s or ""))


def _has_latin(s):
    return any("a" <= ch.lower() <= "z" for ch in (s or ""))


def _bigrams(s):
    s = _norm(s)
    return set(s[i:i+2] for i in range(len(s) - 1)) if len(s) >= 2 else ({s} if s else set())


def _jaccard(a, b):
    A, B = _bigrams(a), _bigrams(b)
    if not A or not B:
        return 0.0
    return len(A & B) / len(A | B)


def _major_cat(*texts):
    blob = _norm(" ".join(t or "" for t in texts))
    for bucket, kws in CAT_BUCKETS.items():
        if any(_norm(k) in blob for k in kws):
            return bucket
    return None


# 호환 카테고리쌍(오충돌 방지·동일성 양성신호로 인정). 예: 우유음료는 우리'음료'·OFF'유제품'.
CAT_COMPATIBLE = [frozenset({"음료", "유제품"})]


def _cat_agree(a, b):
    if not a or not b:
        return False
    return a == b or frozenset({a, b}) in CAT_COMPATIBLE


def _cat_conflict(a, b):
    return bool(a) and bool(b) and not _cat_agree(a, b)


def _brand_match(our_brand, off_brands, off_name):
    ob = _norm(our_brand)
    target = _norm((off_brands or "") + " " + (off_name or ""))
    if not ob or not target:
        return False
    if ob and ob in target:
        return True
    for ko, romaji in BRAND_SYNONYMS.items():
        kob = _norm(ko)
        variants = [kob] + [_norm(r) for r in romaji]
        if ob in variants or any(v in target for v in variants) and (ob == kob or ob in variants):
            # our_brand가 이 그룹에 속하고, off에 그룹 변형 중 하나라도 있으면 매치
            if any(v in target for v in variants):
                return True
    return False


def _flavor_set(name):
    n = _norm(name)
    return set(t for t in FLAVOR_TOKENS if _norm(t) in n)


def identity_check(our_name, our_brand, our_category,
                   off_name, off_brands, off_category, off_countries, barcode):
    """return 'accept' | 'review' | 'reject' (§6.1, 2026-06-27 재보정).

    매칭이 '정확 바코드(EAN)' 기반이므로 바코드 자체가 강한 동일성 신호다.
    → 게이트는 '양성 매칭 강요'가 아니라 '충돌 차단' 안전망으로 동작한다.
    (배경: 우리 products.brand 가 대체로 비어 있고, 한국 OFF 제품명이 로마자라
     기존 'brand_match or 높은 name_sim 필요' 로직이 정상매칭을 87% 오거부했음 — 실데이터 진단.)

    규칙(순서 중요):
      1) 카테고리 대분류 충돌(호환쌍 제외) → reject  (바코드 재사용/충돌 의심)
      2) off_name 비어있음 → accept (비교 불가, 바코드 신뢰)
      3) 외국 원산지 + 브랜드불일치 + 이름유사도<0.6 → reject (외국 제품 바코드 재사용)
      4) 양성 신호 하나라도 → accept:
         - 브랜드/제조사 일치(맛/제형 토큰 충돌 시 review)
         - 카테고리 대분류 일치(호환쌍 포함) — 로마자 이름이라 유사도 0 여도 강한 동일성 증거
         - 이름 유사도 >= 0.6
      5) 중간 유사도(0.45~0.6) → review
      6) 양성 신호 전무(카테고리 불명 + 브랜드 없음 + 이름 무관) → reject (진짜 충돌 차단)
    """
    off_name = off_name or ""
    cat_our = _major_cat(our_category, our_name)
    cat_off = _major_cat(off_category, off_name)
    brand_match = _brand_match(our_brand, off_brands, off_name)
    name_sim = _jaccard(our_name, off_name)
    countries = _norm(off_countries if isinstance(off_countries, str) else " ".join(off_countries or []))
    is_korea = any(k in countries for k in ("korea", "southkorea", "대한민국", "한국")) or str(barcode or "").startswith("880")
    foreign = bool(countries) and not is_korea

    # 1) 카테고리 대분류 충돌 → reject
    if _cat_conflict(cat_our, cat_off):
        return "reject"
    # 2) off_name 비어있으면 비교 불가 → 바코드 신뢰
    if _norm(off_name) == "":
        return "accept"
    # 3) 외국 원산지 + 양성신호 전무 → reject (foreign 은 동일카테고리여도 다른 제품일 위험 큼)
    if foreign and not brand_match and name_sim < 0.6:
        return "reject"
    # 4) 양성 신호 → accept
    if brand_match:
        fset_o, fset_f = _flavor_set(our_name), _flavor_set(off_name)
        if fset_o and fset_f and fset_o != fset_f:
            return "review"   # 브랜드 일치하나 맛/제형 토큰 불일치
        return "accept"
    if _cat_agree(cat_our, cat_off) or name_sim >= 0.6:
        return "accept"
    # 5) 중간 유사도 → review
    if name_sim >= 0.45:
        return "review"
    # 6) 양성 신호 전무 → reject (예: 우리콩쌈장 ↔ Dol gim)
    return "reject"


if __name__ == "__main__":
    print("off_normalize", PARSER_VERSION, NORMALIZER_VERSION, QUALITY_GATE_VERSION)
