# -*- coding: utf-8 -*-
r"""
test_off_identity_v2.py — OFF 정체성 게이트 v2.3 Eval (Eval-First)
SOURCE: D:\먹선\IP\off_identity_gate_v2.md
대상: off_identity_v2.identity_check_v2

v2.3 원칙(자문 3차): accept = same-SKU 확신(이름 거의 동일 OR 강신호+용량일치)만.
  specific/brand/generic/로마자 단독·용기(SKU)토큰 한쪽·한쪽맛 → review.  diet 충돌·불확실 → reject.
metric: ★false_accept(expected에 accept 없는데 accept) = 0 이 핵심 합격선.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import off_identity_v2 as v2

KR = ["en:south-korea"]; US = ["en:united-states"]

CASES = [
    # ── ACCEPT: same-SKU 확신만 ──
    ("ACC1","ACC","동일명 → accept (브랜드제거 후 완전일치)",
     dict(our_name="콘푸라이트",our_brand="동서식품",our_category="시리얼",
          off_name="콘푸라이트",off_brands="Post",off_category="",off_countries=KR,barcode="8801037075649"),"accept"),
    ("ACC2","ACC","브랜드만 더 붙은 동일제품 → accept (청정원 제거 후 '까나리액젓' 일치)",
     dict(our_name="청정원 까나리액젓",our_brand="대상",our_category="액젓",
          off_name="까나리액젓",off_brands="청정원",off_category="",off_countries=KR,barcode="8801052773179"),"accept"),
    ("ACC3","ACC","로마자라도 용량 일치 pathway → accept (샘표 양조간장 500ml ↔ Sempio 500ml)",
     dict(our_name="샘표 양조간장",our_brand="",our_category="소스/조미료",
          off_name="Sempio Soy Sauce",off_brands="Sempio",off_category="",off_countries=KR,
          barcode="8801005010016",our_qty="500ml",off_qty="500ml"),"accept"),

    # ── REVIEW: 관련 있으나 SKU 미확정(수치는 노출, 신호등 OFF) ──
    ("RV1","RV","로마자 brand+generic, 용량없음 → review (샘표 양조간장 ↔ Sempio Soy Sauce)",
     dict(our_name="샘표 양조간장 501",our_brand="",our_category="소스/조미료",
          off_name="Sempio Soy Sauce 501",off_brands="Sempio",off_category="",off_countries=KR,barcode="8801005010017"),"review"),
    ("RV2","RV","로마자 specific 단독 → review (피크닉 사과 ↔ Picnic Apple)",
     dict(our_name="피크닉 사과",our_brand="롯데칠성음료",our_category="음료",
          off_name="Picnic Apple",off_brands="Lotte",off_category="beverages",off_countries=KR,barcode="8801056190016"),"review"),
    ("RV3","RV","로마자 specific 단독 → review (신라면 ↔ Shin Ramyun)",
     dict(our_name="신라면",our_brand="",our_category="라면",
          off_name="Shin Ramyun",off_brands="Nongshim",off_category="noodles",off_countries=KR,barcode="8801043015936"),"review"),
    ("RV4","RV","로마자 specific 단독 → review (스팸 클래식 ↔ Spam Classic)",
     dict(our_name="스팸 클래식",our_brand="CJ제일제당",our_category="가공육",
          off_name="Spam Classic",off_brands="CJ",off_category="",off_countries=KR,barcode="8801007012345"),"review"),
    ("RV5","RV","★용기(SKU) 토큰 한쪽 → review (신라면블랙 사발 ↔ 신라면 블랙) — 기존 false-accept 교정",
     dict(our_name="신라면블랙 사발",our_brand="농심",our_category="라면",
          off_name="신라면 블랙",off_brands="농심",off_category="noodles",off_countries=KR,barcode="8801043041447"),"review"),
    ("RV6","RV","generic OFF명 → review (Maxim 슈프림골드 커피믹스 ↔ Maxim Coffee)",
     dict(our_name="Maxim 슈프림골드 커피믹스",our_brand="동서식품",our_category="커피",
          off_name="Instant Maxim Coffee",off_brands="Maxim",off_category="",off_countries=KR,barcode="8801037002928"),"review"),
    ("RV7","RV","한쪽 맛(우리만 명시) → review (진라면 순한맛 ↔ Jin Ramen)",
     dict(our_name="오뚜기 진라면 순한맛",our_brand="오뚜기",our_category="라면",
          off_name="Jin Ramen",off_brands="Ottogi",off_category="noodles",off_countries=KR,barcode="8801045571362"),"review"),
    ("RV8","RV","브랜드+카테고리만(제품코어 없음) → review",
     dict(our_name="롯데웰푸드 빼빼로 신제품",our_brand="롯데웰푸드",our_category="과자",
          off_name="Lotte Wellfood New Snack",off_brands="Lotte Wellfood",off_category="snacks",off_countries=KR,barcode="8801062012345"),"review"),
    ("RV9","RV","generic 단독(브랜드 없음) → review",
     dict(our_name="양조간장",our_brand="",our_category="소스/조미료",
          off_name="Brewed Soy Sauce",off_brands="",off_category="",off_countries=KR,barcode="8801099912345"),"review"),
    ("RV10","RV","flavor 충돌 → review (매일 바나나우유 ↔ 딸기우유)",
     dict(our_name="바나나맛우유",our_brand="매일유업",our_category="유제품",
          off_name="Maeil Strawberry Milk",off_brands="Maeil",off_category="dairy",off_countries=KR,barcode="8801115512345"),"review"),
    ("RV11","RV","spicy 충돌 → review (진라면 매운맛 ↔ Jin Ramen Mild)",
     dict(our_name="진라면 매운맛",our_brand="오뚜기",our_category="라면",
          off_name="Ottogi Jin Ramen Mild",off_brands="Ottogi",off_category="noodles",off_countries=KR,barcode="8801045512345"),"review"),

    # ── REJECT ──
    ("RJ1","RJ","장류 vs 해조류 (core/카테고리 충돌) — 샘표 쌈장 ↔ Dolgim",
     dict(our_name="샘표 쌈장",our_brand="샘표",our_category="소스/조미료",
          off_name="Dol Gim Seasoned Laver",off_brands="Dolgim",off_category="",off_countries=KR,barcode="8801005099999"),"reject"),
    ("RJ2","RJ","같은 장류 버킷 내 core 충돌 — 진간장 ↔ Ssamjang",
     dict(our_name="진간장",our_brand="대상",our_category="소스/조미료",
          off_name="Daesang Ssamjang",off_brands="Daesang",off_category="",off_countries=KR,barcode="8801052399999"),"reject"),
    ("RJ3","RJ","외국제품 바코드재사용 — 새우깡 ↔ Lay's(미국·880아님)",
     dict(our_name="새우깡",our_brand="농심",our_category="과자",
          off_name="Lay's Classic",off_brands="Lay's",off_category="snacks",off_countries=US,barcode="0028400199999"),"reject"),
    ("RJ4","RJ","카테고리 대분류 충돌 — 라면 ↔ 아이스크림",
     dict(our_name="신라면",our_brand="농심",our_category="라면",
          off_name="Vanilla Ice Cream",off_brands="Some Co",off_category="ice-cream",off_countries=KR,barcode="8801043512345"),"reject"),
    ("RJ5","RJ","양성신호 전무 — 무관 제품",
     dict(our_name="우리쌀 누룽지",our_brand="",our_category="",
          off_name="Acme Energy Bar",off_brands="Acme",off_category="",off_countries=KR,barcode="8801999912345"),"reject"),
    ("RJ6","RJ","카테고리 충돌 회귀 — 코카콜라 ↔ 과자",
     dict(our_name="코카콜라",our_brand="코카콜라",our_category="음료",
          off_name="Potato Chips",off_brands="Frito",off_category="snacks",off_countries=US,barcode="0049000099999"),"reject"),
    ("RJ7","RJ","★diet 한쪽(우리 제로↔OFF generic) → reject (제로에 일반 수치는 위해)",
     dict(our_name="칠성사이다 제로",our_brand="롯데칠성음료",our_category="음료",
          off_name="Lemon-Lime Soda",off_brands="",off_category="beverages",off_countries=KR,barcode="8801056177676"),"reject"),
    ("RJ8","RJ","★diet 한쪽(우리 라이트↔OFF generic) → reject",
     dict(our_name="스팸 라이트",our_brand="CJ제일제당",our_category="가공육",
          off_name="Spam",off_brands="Spam",off_category="",off_countries=KR,barcode="8801007512260"),"reject"),
    ("RJ9","RJ","멀티팩 용량 5배차 + multi 토큰 → reject",
     dict(our_name="농심 새우깡",our_brand="농심",our_category="과자",
          off_name="Nongshim Saewookkang Multipack",off_brands="Nongshim",off_category="snacks",
          off_countries=KR,barcode="8801043004718",our_qty="90g",off_qty="450g"),"reject"),
]


def run(c):
    cid, kind, desc, a, exp = c
    got = v2.identity_check_v2(a["our_name"], a["our_brand"], a["our_category"],
                              a["off_name"], a["off_brands"], a["off_category"],
                              a["off_countries"], a["barcode"], a.get("our_qty"), a.get("off_qty"))
    ok = (got in exp) if isinstance(exp, list) else (got == exp)
    return got, ok


def main():
    print("=== OFF 정체성 게이트 v2.3 Eval (accept=same-SKU 확신) ===\n")
    fails = 0; false_accept = []
    for c in CASES:
        cid, kind, desc, a, exp = c
        got, ok = run(c)
        print(f"[{'PASS' if ok else 'FAIL'}] {cid:5} {kind}  got={got:7} exp={str(exp):<18} {desc}")
        if not ok:
            fails += 1
        exp_set = exp if isinstance(exp, list) else [exp]
        if "accept" not in exp_set and got == "accept":
            false_accept.append(cid)
    print(f"\n총 {len(CASES)} / 통과 {len(CASES)-fails} / 실패 {fails}")
    print(f"  ★ false-accept(위험 오통과): {false_accept or '없음 (0)'}")
    bad = fails or false_accept
    print("합격선: 전 케이스 통과 AND false-accept=0." + ("  → GREEN" if not bad else "  → 미달"))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
