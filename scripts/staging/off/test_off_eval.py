"""
test_off_eval.py — OFF 품질게이트 Eval 합성 케이스 실행
SOURCE: D:\\먹선\\eval_set\\eval_set_off_v1.md (B/C/D/E/F)
골든셋(A)은 실제 덤프 필요 → 본 하니스는 로직 케이스만(덤프 무관).
실행: python3 test_off_eval.py
"""
import off_normalize as off

PASS, FAIL = 0, 0
fails = []


def check(name, got, exp):
    global PASS, FAIL
    ok = got == exp
    if ok:
        PASS += 1
    else:
        FAIL += 1
        fails.append(f"{name}: got={got!r} exp={exp!r}")
    print(f"  [{'OK' if ok else 'XX'}] {name}: got={got!r} exp={exp!r}")


def approx(name, got, exp, tol=0.5):
    global PASS, FAIL
    ok = got is not None and abs(got - exp) <= tol
    if ok:
        PASS += 1
    else:
        FAIL += 1
        fails.append(f"{name}: got={got!r} exp~={exp!r}")
    print(f"  [{'OK' if ok else 'XX'}] {name}: got={got!r} exp~={exp!r}")


def grade(fields_n, sodium_g=None, salt_g=None, identity="accept"):
    g, info = off.quality_grade(fields_n, sodium_g, salt_g, identity)
    return g, info


# ── B. 단위변환 ────────────────────────────────────────────────────────────
print("\n== B. 단위변환 ==")
n, _ = off.normalize_off({"sodium_100g": 0.5})
approx("U1 sodium 0.5g->mg", n["sodium_mg"], 500)
n, _ = off.normalize_off({"salt_100g": 1.25})
approx("U2 salt 1.25g->sodium mg", n["sodium_mg"], 500)
n, _ = off.normalize_off({"energy-kcal_100g": 250, "energy_100g": 1046})
check("U3 kcal priority", (n["calories"], n["energy_source"]), (250.0, "kcal"))
n, _ = off.normalize_off({"energy_100g": 1046})
approx("U4 kJ->kcal", n["calories"], 250.0, tol=1.0)
check("U4 source", n["energy_source"], "kJ_converted")
n, _ = off.normalize_off({"cholesterol_100g": 0.06})
approx("U5 cholesterol 0.06g->mg", n["cholesterol_mg"], 60)
n, _ = off.normalize_off({"sugars_100g": ""})
check("U6 empty->None", n["total_sugars"], None)
n, _ = off.normalize_off({"trans-fat_100g": 0})
check("U7 explicit 0", n["trans_fat"], 0.0)

# ── C. 품질게이트 ──────────────────────────────────────────────────────────
print("\n== C. 품질게이트 ==")
full = lambda **kw: {**{
    "calories": None, "protein": None, "total_fat": None, "saturated_fat": None,
    "trans_fat": None, "total_carbs": None, "total_sugars": None,
    "dietary_fiber": None, "sodium_mg": None, "cholesterol_mg": None,
    "basis_confident": True}, **kw}

q1 = full(calories=400, total_carbs=50, protein=10, total_fat=15, saturated_fat=5,
          total_sugars=10, sodium_mg=300, dietary_fiber=3)
g, i = grade(q1)
check("Q1 all good ±8% -> A", g, "A")

q2 = full(calories=400, total_carbs=60, protein=10, total_fat=22, saturated_fat=8,
          total_sugars=10, sodium_mg=300, dietary_fiber=3)
g, i = grade(q2)
check("Q2 energy ~20% -> B", g, "B")

q3 = full(calories=412, total_carbs=100, protein=3, total_fat=0, saturated_fat=0,
          total_sugars=50, sodium_mg=300, dietary_fiber=2)
g, i = grade(q3)
check("Q3 macro 103 warn -> A/B", g in ("A", "B"), True)
check("Q3 warn flag", i.get("warn"), True)

g, i = grade(full(protein=10, total_fat=10, total_carbs=90))
check("Q4 macro 110 -> Reject", g, "Reject")

g, i = grade(full(total_sugars=60, total_carbs=40))
check("Q5 sugars>carbs -> Reject", g, "Reject")

g, i = grade(full(saturated_fat=12, total_fat=8))
check("Q6 satfat>fat -> Reject", g, "Reject")

g, i = grade(full(sodium_mg=500), sodium_g=0.5, salt_g=2.0)
check("Q7 sodium/salt conflict -> Reject", g, "Reject")

g, i = grade(full(calories=400, total_carbs=10, protein=5, total_fat=5))
check("Q8 energy ±45% -> Reject", g, "Reject")

q9 = full(calories=400, total_carbs=50, protein=10, total_fat=15, saturated_fat=5,
          total_sugars=10, sodium_mg=300)  # dietary_fiber 결측(1)
g, i = grade(q9)
check("Q9 core7 partial -> B", g, "B")

g, i = grade(full(calories=400, protein=10))  # 대부분 결측
check("Q10 many missing -> C", g, "C")

# ── D. 제품 정체성 ─────────────────────────────────────────────────────────
print("\n== D. 제품 정체성 ==")
check("I1 romaji brand match -> accept",
      off.identity_check("신라면", "농심", "라면", "Shin Ramyun", "Nongshim", "noodles", "south-korea", "8801043"),
      "accept")
check("I2 category conflict -> reject",
      off.identity_check("신라면", "농심", "라면", "Vanilla Ice Cream", "Some", "ice cream", "south-korea", "880"),
      "reject")
check("I3 brand mismatch foreign -> reject",
      off.identity_check("포카칩", "오리온", "과자", "Lay's Classic Chips", "Lay's", "chips", "united-states", "0028400"),
      "reject")
check("I4 brand ok flavor mismatch -> review",
      off.identity_check("새우깡 오리지널", "농심", "스낵", "Saewookkang 매운맛", "Nongshim", "snack", "south-korea", "880"),
      "review")
check("I5 foreign unrelated -> reject",
      off.identity_check("신라면", "농심", "라면", "Spaghetti Barilla", "Barilla", "pasta", "italy", "8076800"),
      "reject")
check("I6 brand match(다국어) -> accept",
      off.identity_check("비비고 만두", "씨제이", "frozen", "Bibigo 비비고 Dumpling 만두", "CJ", "frozen", "south-korea", "880"),
      "accept")
# 재보정(2026-06-27) 실데이터 케이스: brand 비어있고 OFF 이름 로마자인 국내 정상매칭 구제 + 진짜충돌 차단
check("I7 신라면 brand없음+카테고리일치 -> accept",
      off.identity_check("신라면", "", "유탕면 general", "Shin Ramyun", "Nongshim", "noodles", "south-korea", "8801043014809"),
      "accept")
check("I8 우유음료 음료/유제품 호환 -> accept",
      off.identity_check("빙그레 바나나맛 우유", "", "가공유 beverage", "빙그레 바나나맛 우유", "빙그레,binggrae", "dairy", "south-korea", "88002798"),
      "accept")
check("I9 쌈장↔Dolgim 무신호 -> reject",
      off.identity_check("우리콩쌈장", "", "혼합장 general", "Dol gim", "Sempio", "", "south-korea", "8801005000215"),
      "reject")
check("I10 코카콜라 로마자+카테고리일치 -> accept",
      off.identity_check("코카콜라", "", "탄산음료 beverage", "Coca Cola", "Coca-Cola", "sodas", "south-korea", "8801094"),
      "accept")
check("I11 manufacturer폴백 브랜드일치(외국이어도) -> accept",
      off.identity_check("몬스터에너지 망고로코", "Monster", "음료", "Mango Loco", "Monster", "energy-drinks", "united-states", "4897036693339"),
      "accept")

# ── E. basis 판정 ──────────────────────────────────────────────────────────
print("\n== E. basis ==")
_, _ = off.normalize_off({"nutrition_data_per": "100ml"})
check("Ba1 100ml -> (mL,True)", off.derive_basis({"nutrition_data_per": "100ml"}), ("mL", True))
check("Ba2 100g -> (g,True)", off.derive_basis({"nutrition_data_per": "100g"}), ("g", True))
check("Ba3 ambiguous -> (unknown,False)", off.derive_basis({"categories_tags_str": "beverages"}), ("unknown", False))

# ── F. resolved 우선순위 (011 view 로직 미러: source-atomic + 브릿지 decision) ──
print("\n== F. resolved (source-atomic + 브릿지 decision='load' 미러) ==")


def resolve(nd, off_norm, off_decision="load"):
    """011 product_nutrition_resolved 의미 미러 (자문 reconcile 후).
    - source-atomic: nd 있으면 OFF 전혀 미사용(필드 혼합 금지, 프랑켄슈타인 방지).
    - OFF 는 nd 없음 + 브릿지 decision='load' + off_grade A/B 일 때만 결합."""
    off_usable = (off_norm is not None and off_decision == "load"
                  and off_norm.get("off_grade") in ("A", "B"))
    if nd is not None:
        return {"source": nd.get("data_source"), "confidence": None, "off_grade": None,
                "calories": nd.get("calories"), "sodium": nd.get("sodium")}
    if off_usable:
        return {"source": "openfoodfacts", "confidence": "low", "off_grade": off_norm.get("off_grade"),
                "calories": off_norm.get("calories"), "sodium": off_norm.get("sodium")}
    return {"source": None, "confidence": None, "off_grade": None, "calories": None, "sodium": None}


r = resolve({"data_source": "public_nutrition", "calories": 350, "sodium": 200}, {"off_grade": "A", "calories": 400, "sodium": 600})
check("R1 식약처+OFF(A) -> 식약처", r["source"], "public_nutrition")
check("R1 식약처값 유지", r["calories"], 350)
r = resolve(None, {"off_grade": "A", "calories": 400, "sodium": 600})
check("R2 OFF(A) only -> off low", (r["source"], r["confidence"]), ("openfoodfacts", "low"))
r = resolve(None, {"off_grade": "B", "calories": 400})
check("R3 OFF(B) -> off grade B", r["off_grade"], "B")
r = resolve(None, {"off_grade": "C", "calories": 400})
check("R4 OFF(C) -> 결합제외(None)", r["source"], None)
r = resolve(None, None)
check("R5 둘 다 없음 -> None", r["source"], None)
# 자문 reconcile 추가: 프랑켄슈타인 방지 + 브릿지 우회 차단
r = resolve({"data_source": "public_nutrition", "calories": 350, "sodium": None}, {"off_grade": "A", "calories": 400, "sodium": 600})
check("R6 nd부분결측+OFF -> sodium은 OFF로 안채움(atomic)", r["sodium"], None)
check("R6b source는 식약처 유지", r["source"], "public_nutrition")
r = resolve(None, {"off_grade": "A", "calories": 400}, off_decision="conflict")
check("R7 브릿지 decision!=load -> OFF 미결합", r["source"], None)
r = resolve(None, {"off_grade": "A", "calories": 400}, off_decision="skip_identity")
check("R8 정체성 우회 차단(skip) -> None", r["source"], None)

# ── 결과 ───────────────────────────────────────────────────────────────────
print(f"\n=== 결과: {PASS} passed, {FAIL} failed ===")
if fails:
    print("실패:")
    for f in fails:
        print("  -", f)
    raise SystemExit(1)
print("ALL GREEN ✅")
