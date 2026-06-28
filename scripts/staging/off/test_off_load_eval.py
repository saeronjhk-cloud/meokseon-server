# -*- coding: utf-8 -*-
"""
test_off_load_eval.py — off_load_railway.py 신규 로직 eval (DB 무관 순수 검증)
SOURCE: D:\\먹선\\eval_set\\eval_set_off_v1.md, off_integration_v1.md §6~§7
검증 대상: 분류 결정(classify_match)·충돌 환산(conflict_check)·provenance shape(builders)·정체성 적용.
게이트 내부(normalize/grade/identity)는 test_off_eval.py(34/34)에서 별도 검증됨 — 여기선 적재층만.
run: python test_off_load_eval.py
"""
import off_load_railway as L

P, F = 0, 0
def ok(name, got, exp):
    global P, F
    good = got == exp
    print(f"  [{'OK' if good else 'XX'}] {name}: got={got!r} exp={exp!r}")
    P += good; F += (not good)


def mk_off(code, name_ko, brands, countries, cats, per100, data_per="100g", lmt=1700000000):
    return {"code": code,
            "product_name": [{"lang": "ko", "text": name_ko}] if name_ko else [],
            "brands": brands, "countries_tags": countries, "categories_tags": cats,
            "nutriments": [{"name": k, "100g": v} for k, v in per100.items()],
            "nutrition_data_per": data_per, "serving_size": None, "quantity": None,
            "no_nutrition_data": False, "last_modified_t": lmt}


def mk_prod(barcode, name, brand, ftype, fcat, has_nutr=False, serving=None, nd_cal=None, nd_na=None):
    return {"product_id": 1, "barcode": barcode, "product_name": name, "brand": brand,
            "food_category": fcat, "food_type": ftype, "serving_size": serving,
            "off_code": None, "has_nutr": has_nutr, "nd_cal": nd_cal, "nd_na": nd_na}


# 양호한 라면(A등급) per-100
RAMYUN = {"energy-kcal": 450, "proteins": 9, "fat": 17, "saturated-fat": 8,
          "carbohydrates": 65, "sugars": 4, "fiber": 2, "sodium": 1.8}
KO = ["en:south-korea"]

print("== A. classify_match 결정 ==")
# A1 결측 + 정체성 accept + A등급 → load
off1 = mk_off("8801043000001", "신라면", "농심", KO, ["en:noodles"], RAMYUN)
prod1 = mk_prod("8801043000001", "신라면", "농심", "면류", "라면", has_nutr=False)
r1 = L.classify_match(prod1, off1)
ok("A1 결측+accept+A -> load", r1["decision"], "load")
ok("A1 grade", r1["grade"], "A")
ok("A1 identity", r1["identity"], "accept")
ok("A1 basis g", r1["n"]["basis_unit"], "g")
ok("A1 sodium mg", r1["n"]["sodium_mg"], 1800.0)

# A2 동일 제품 영양보유 → conflict(미덮어쓰기)
prod2 = mk_prod("8801043000001", "신라면", "농심", "면류", "라면", has_nutr=True, serving=60, nd_cal=300, nd_na=1000)
ok("A2 영양보유 -> conflict", L.classify_match(prod2, off1)["decision"], "conflict")

# A3 카테고리 충돌(우리 라면 vs OFF 음료/콜라) → skip_identity
off3 = mk_off("8801043000002", "코카콜라", "Coca-Cola", KO, ["en:beverages", "en:sodas"],
              {"energy-kcal": 42, "sugars": 10.6, "carbohydrates": 10.6})
prod3 = mk_prod("8801043000002", "신라면", "농심", "면류", "라면")
r3 = L.classify_match(prod3, off3)
ok("A3 카테고리충돌 -> skip_identity", r3["decision"], "skip_identity")
ok("A3 identity reject", r3["identity"], "reject")

# A4 불변식 위반(sugars>carbs) → skip_reject
off4 = mk_off("8801043000003", "이상치음료", "농심", KO, ["en:beverages"],
              {"energy-kcal": 100, "sugars": 80, "carbohydrates": 50}, data_per="100ml")
prod4 = mk_prod("8801043000003", "이상치음료", "농심", "음료류", "음료")
ok("A4 sugars>carbs -> skip_reject", L.classify_match(prod4, off4)["decision"], "skip_reject")
ok("A4 basis mL", L.classify_match(prod4, off4)["n"]["basis_unit"], "mL")

print("\n== B. conflict_check (단위 비교가능할 때만; KFDA per-serving->per100 vs OFF per100) ==")
ok("B1 일치(±1%) g/g", L.conflict_check("calories", 300, 60, "g", 505, "g"), (1.0, False))
ok("B2 큰차이->충돌 g/g", L.conflict_check("calories", 300, 60, "g", 200, "g"), (60.0, True))
ok("B3 serving 없음", L.conflict_check("calories", 300, None, "g", 505, "g"), (None, False))
ok("B4 off 없음", L.conflict_check("calories", 300, 60, "g", None, "g"), (None, False))
ok("B5 serving 0", L.conflict_check("sodium", 500, 0, "g", 800, "g"), (None, False))
ok("B6 단위불일치 g/mL", L.conflict_check("calories", 300, 60, "g", 200, "mL"), (None, False))
ok("B7 serving_unit None", L.conflict_check("calories", 300, 60, None, 200, "g"), (None, False))
ok("B8 개수단위(ea)->스킵", L.conflict_check("sodium", 500, 1, "ea", 800, "g"), (None, False))
ok("B9 OFF basis unknown", L.conflict_check("sodium", 500, 30, "g", 800, "unknown"), (None, False))

print("\n== C. raw_subset / row_hash 재현성·이미지 제외 ==")
rs1 = L.raw_subset(off1)
rs1b = L.raw_subset(off1)
ok("C1 동일입력 동일해시", L.row_hash(rs1) == L.row_hash(rs1b), True)
off1m = mk_off("8801043000001", "신라면", "농심", KO, ["en:noodles"], dict(RAMYUN, sodium=2.0))
ok("C2 값다르면 해시다름", L.row_hash(rs1) != L.row_hash(L.raw_subset(off1m)), True)
ok("C3 이미지키 없음", any("image" in k.lower() for k in rs1.keys()), False)
ok("C4 raw 키수=11", len(rs1.keys()), 11)

print("\n== D. provenance 빌더 shape (드리프트 차단) ==")
nrow = L.build_norm_row("8801043000001", "A", r1["n"], None)
ok("D1 norm 튜플 길이=NORM_COLS", len(nrow), len(L.NORM_COLS))
ok("D1 norm[0]=code", nrow[0], "8801043000001")
ok("D1 norm[14]=grade", nrow[L.NORM_COLS.index("off_grade")], "A")
ok("D1 norm parser_version", nrow[L.NORM_COLS.index("parser_version")], L.off.PARSER_VERSION)
rraw = L.build_raw_row("8801043000001", off1, "2026-06-27", "food.parquet", "deadbeef")
ok("D2 raw 튜플 길이=RAW_COLS", len(rraw), len(L.RAW_COLS))
ok("D2 raw snapshot", rraw[L.RAW_COLS.index("off_snapshot_date")], "2026-06-27")
ok("D2 raw dump_file", rraw[L.RAW_COLS.index("dump_file_name")], "food.parquet")
ok("D2 raw_hash==row_hash(subset)", rraw[L.RAW_COLS.index("raw_hash")], L.row_hash(L.raw_subset(off1)))
sql = L._upsert_sql("openfoodfacts_nutrition_norm", L.NORM_COLS, extra_set="updated_at=now()")
ok("D3 upsert ON CONFLICT", "ON CONFLICT (code) DO UPDATE" in sql, True)
ok("D3 upsert calories EXCLUDED", "calories=EXCLUDED.calories" in sql, True)
ok("D3 upsert code 미갱신", "code=EXCLUDED.code" not in sql, True)

print("\n== E. 정체성 브릿지 (fingerprint·MATCH_COLS) ==")
ok("E1 MATCH_COLS=8", len(L.MATCH_COLS), 8)
ok("E2 fingerprint 결정적", L.product_fingerprint(prod1) == L.product_fingerprint(prod1), True)
prod1b = mk_prod("8801043000001", "신라면 블랙", "농심", "면류", "라면")  # 이름 변경
ok("E3 제품 변경 -> fingerprint 변경", L.product_fingerprint(prod1) != L.product_fingerprint(prod1b), True)
ok("E4 브랜드만 달라도 변경", L.product_fingerprint(prod1) != L.product_fingerprint(
    mk_prod("8801043000001", "신라면", "오뚜기", "면류", "라면")), True)
match_sql = L._upsert_sql("openfoodfacts_product_match", L.MATCH_COLS,
                          conflict="product_id", extra_set="matched_at=now()")
ok("E5 브릿지 upsert product_id 충돌", "ON CONFLICT (product_id) DO UPDATE" in match_sql, True)
ok("E6 브릿지 decision EXCLUDED", "decision=EXCLUDED.decision" in match_sql, True)

print(f"\n=== 결과: {P} passed, {F} failed ===")
print("ALL GREEN ✅" if F == 0 else "FAILED ✗")
import sys; sys.exit(1 if F else 0)
