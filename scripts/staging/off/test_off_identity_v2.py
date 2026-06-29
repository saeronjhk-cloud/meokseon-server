# -*- coding: utf-8 -*-
r"""
test_off_identity_v2.py — OFF 정체성 게이트 v2.1 Eval (Eval-First)
SOURCE: D:\먹선\IP\off_identity_gate_v2.md
대상 로직: off_identity_v2.identity_check_v2  (v2.1 교차입증)

판정: expected가 list면 그중 하나면 통과.
metric: pass율 + ★false_accept(=expected가 review/reject인데 accept) 수. false_accept=0이 핵심 합격선.
종료코드: false_accept>0 이거나 fail 있으면 1.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import off_identity_v2 as v2

KR = ["en:south-korea"]; US = ["en:united-states"]

# (id, kind, desc, args, expected)  kind: TP/TN/RG/NV(신규)
CASES = [
    # ── TP: 건져야 할 정상매칭 (accept) ──
    ("TP1","TP","샘표 양조간장↔Sempio Soy Sauce (브랜드공란+generic, 브랜드+제품 교차)",
     dict(our_name="샘표 양조간장 501",our_brand="",our_category="소스/조미료",
          off_name="Sempio Soy Sauce 501",off_brands="Sempio",off_category="",off_countries=KR,barcode="8801005010016"),"accept"),
    ("TP2","TP","롯데 피크닉 사과↔Picnic Apple (specific 피크닉)",
     dict(our_name="피크닉 사과",our_brand="롯데칠성음료",our_category="음료",
          off_name="Picnic Apple",off_brands="Lotte",off_category="beverages",off_countries=KR,barcode="8801056190016"),"accept"),
    ("TP3","TP","대상(주) 진간장↔Daesang Jin Soy (브랜드+generic)",
     dict(our_name="진간장",our_brand="대상(주)",our_category="소스/조미료",
          off_name="Daesang Jin Soy Sauce",off_brands="Daesang",off_category="",off_countries=KR,barcode="8801052310015"),"accept"),
    ("TP4","TP","동서 맥심 모카골드↔Maxim Mocha (specific)",
     dict(our_name="맥심 모카골드 마일드",our_brand="동서식품",our_category="커피",
          off_name="Maxim Mocha Gold Mild",off_brands="Dongsuh",off_category="",off_countries=KR,barcode="8801037010016"),"accept"),
    ("TP5","TP","CJ 스팸 클래식↔Spam Classic (specific 스팸)",
     dict(our_name="스팸 클래식",our_brand="CJ제일제당",our_category="가공육",
          off_name="Spam Classic",off_brands="CJ",off_category="",off_countries=KR,barcode="8801007012345"),"accept"),
    ("TP6","TP","남양 초코에몽↔Namyang Chocoemong (브랜드+specific)",
     dict(our_name="초코에몽",our_brand="남양유업",our_category="유제품",
          off_name="Namyang Chocoemong",off_brands="Namyang",off_category="dairy",off_countries=KR,barcode="8801157012345"),"accept"),
    ("TP7","TP","해태 홈런볼 초코(브랜드공란)↔Haitai Homerun Ball (specific 홈런볼)",
     dict(our_name="해태 홈런볼 초코",our_brand="",our_category="과자",
          off_name="Haitai Homerun Ball Choco",off_brands="Haitai",off_category="snacks",off_countries=KR,barcode="8801019012345"),"accept"),
    # ── TN: 충돌 차단 (review|reject) ──
    ("TN1","TN","샘표 쌈장↔Dolgim(조미김) — 장류 vs 해조류",
     dict(our_name="샘표 쌈장",our_brand="샘표",our_category="소스/조미료",
          off_name="Dol Gim Seasoned Laver",off_brands="Dolgim",off_category="",off_countries=KR,barcode="8801005099999"),"reject"),
    ("TN2","TN","매일 바나나우유↔Maeil 딸기우유 (flavor 충돌)",
     dict(our_name="바나나맛우유",our_brand="매일유업",our_category="유제품",
          off_name="Maeil Strawberry Milk",off_brands="Maeil",off_category="dairy",off_countries=KR,barcode="8801115512345"),["review","reject"]),
    ("TN3","TN","진라면 매운맛↔Jin Ramen Mild (spicy 충돌)",
     dict(our_name="진라면 매운맛",our_brand="오뚜기",our_category="라면",
          off_name="Ottogi Jin Ramen Mild",off_brands="Ottogi",off_category="noodles",off_countries=KR,barcode="8801045512345"),["review","reject"]),
    ("TN4","TN","새우깡↔Lay's(미국·880아님)",
     dict(our_name="새우깡",our_brand="농심",our_category="과자",
          off_name="Lay's Classic",off_brands="Lay's",off_category="snacks",off_countries=US,barcode="0028400199999"),"reject"),
    ("TN5","TN","라면↔아이스크림 (카테고리 충돌)",
     dict(our_name="신라면",our_brand="농심",our_category="라면",
          off_name="Vanilla Ice Cream",off_brands="Some Co",off_category="ice-cream",off_countries=KR,barcode="8801043512345"),"reject"),
    ("TN6","TN","무관제품 (양성신호 전무)",
     dict(our_name="우리쌀 누룽지",our_brand="",our_category="",
          off_name="Acme Energy Bar",off_brands="Acme",off_category="",off_countries=KR,barcode="8801999912345"),"reject"),
    # ── NV: v2.1 신규 잠금 ──
    ("NV1","NV","브랜드+카테고리 단독(제품코어 없음) → review (브랜드단독 accept 금지)",
     dict(our_name="롯데웰푸드 빼빼로 신제품",our_brand="롯데웰푸드",our_category="과자",
          off_name="Lotte Wellfood New Snack",off_brands="Lotte Wellfood",off_category="snacks",off_countries=KR,barcode="8801062012345"),"review"),
    ("NV2","NV","generic 제품 단독(브랜드 없음) → review (generic 단독 accept 금지)",
     dict(our_name="양조간장",our_brand="",our_category="소스/조미료",
          off_name="Brewed Soy Sauce",off_brands="",off_category="",off_countries=KR,barcode="8801099912345"),"review"),
    ("CC1","NV","진간장↔Ssamjang — 같은 장류 버킷 내 core 충돌 → reject",
     dict(our_name="진간장",our_brand="대상",our_category="소스/조미료",
          off_name="Daesang Ssamjang",off_brands="Daesang",off_category="",off_countries=KR,barcode="8801052399999"),"reject"),
    ("BF1","NV","브랜드family 분리 — 롯데칠성(음료)↔롯데웰푸드(과자) 오매칭 금지",
     dict(our_name="롯데칠성 사이다",our_brand="롯데칠성",our_category="음료",
          off_name="Lotte Wellfood Pepero",off_brands="Lotte Wellfood",off_category="snacks",off_countries=KR,barcode="8801056299999"),"reject"),
    ("MP1","NV","멀티팩 용량 5배차 + multi 토큰 → reject (multipack_hard)",
     dict(our_name="농심 새우깡",our_brand="농심",our_category="과자",
          off_name="Nongshim Saewookkang Multipack",off_brands="Nongshim",off_category="snacks",
          off_countries=KR,barcode="8801043004718",our_qty="90g",off_qty="450g"),"reject"),
    # ── RG: 회귀 보호 ──
    ("RG1","RG","신라면↔Shin Ramyun (specific)",
     dict(our_name="신라면",our_brand="",our_category="라면",
          off_name="Shin Ramyun",off_brands="Nongshim",off_category="noodles",off_countries=KR,barcode="8801043015936"),"accept"),
    ("RG2","RG","새우깡↔Saewookkang (브랜드+specific)",
     dict(our_name="새우깡",our_brand="농심",our_category="과자",
          off_name="Saewookkang",off_brands="Nongshim",off_category="snacks",off_countries=KR,barcode="8801043004718"),"accept"),
    ("RG3","RG","코카콜라↔엉뚱과자 (카테고리 충돌)",
     dict(our_name="코카콜라",our_brand="코카콜라",our_category="음료",
          off_name="Potato Chips",off_brands="Frito",off_category="snacks",off_countries=US,barcode="0049000099999"),"reject"),
]


def run(c):
    cid, kind, desc, a, exp = c
    got = v2.identity_check_v2(a["our_name"], a["our_brand"], a["our_category"],
                              a["off_name"], a["off_brands"], a["off_category"],
                              a["off_countries"], a["barcode"],
                              a.get("our_qty"), a.get("off_qty"))
    ok = (got in exp) if isinstance(exp, list) else (got == exp)
    return got, ok


def main():
    print("=== OFF 정체성 게이트 v2.1 Eval (identity_check_v2) ===\n")
    fails = 0; false_accept = []
    for c in CASES:
        cid, kind, desc, a, exp = c
        got, ok = run(c)
        mark = "PASS" if ok else "FAIL"
        print(f"[{mark}] {cid:4} {kind}  got={got:7} exp={str(exp):<18} {desc}")
        if not ok:
            fails += 1
        # false-accept: 막아야 하는데(expected에 accept 없음) accept 나옴
        exp_set = exp if isinstance(exp, list) else [exp]
        if "accept" not in exp_set and got == "accept":
            false_accept.append(cid)

    print(f"\n총 {len(CASES)} / 통과 {len(CASES)-fails} / 실패 {fails}")
    print(f"  ★ false-accept(위험 오통과): {false_accept or '없음 (0)'}")
    bad = fails or false_accept
    print("\n합격선: 전 케이스 통과 AND false-accept=0." + ("  → GREEN" if not bad else "  → 미달"))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
