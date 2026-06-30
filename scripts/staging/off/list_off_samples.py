# -*- coding: utf-8 -*-
r"""list_off_samples.py — 앱에서 OFF 배지 확인용 샘플 제품 목록(이름·바코드).
사용: $env:DATABASE_URL=...; python list_off_samples.py
이름 검색 가능한(한글) 제품 위주로 보여줌 → 앱에서 그 이름으로 검색하면 OFF 배지 확인 가능.
"""
import os, re, sys
try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2-binary 필요.", file=sys.stderr); sys.exit(1)

c = psycopg2.connect(os.environ['DATABASE_URL']).cursor()
c.execute("""
    SELECT p.barcode, p.product_name, n.off_grade, n.basis_unit
    FROM openfoodfacts_product_match m
    JOIN products p ON p.product_id = m.product_id
    JOIN openfoodfacts_nutrition_norm n ON n.code = m.code
    WHERE m.decision='load' AND n.off_grade IN ('A','B') AND p.product_name IS NOT NULL
    ORDER BY p.product_name
""")
rows = c.fetchall()

def is_hangul_only(s):  # 영어 없는 순수 한글 이름(이름검색 잘 됨)
    return not re.search(r'[A-Za-z]', s or '')

ko = [r for r in rows if is_hangul_only(r[1])]
print(f"OFF 노출 제품 총 {len(rows)}건 (이름검색 쉬운 한글 이름 {len(ko)}건)\n")
print("=== 이름 검색 추천(한글) — 앱 검색창에 '이름' 입력 ===")
for bc, name, g, bu in ko[:15]:
    print(f"  [{g}/{bu}] {name}   (바코드 {bc})")
print("\n=== 바코드 직접 입력용(아무거나) ===")
for bc, name, g, bu in rows[:8]:
    print(f"  {bc}  [{g}]  {name[:40]}")
