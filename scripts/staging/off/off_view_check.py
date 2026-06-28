# -*- coding: utf-8 -*-
r"""
off_view_check.py — findByBarcode view 전환 검증(배포 전, 실DB).
검증: ①OFF 적재 제품이 view 로 영양 노출(source=openfoodfacts) ②식약처 제품 무회귀 ③쿼리 성능(EXPLAIN).
사용: $env:DATABASE_URL=...; python off_view_check.py
"""
import os, sys, getpass
try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2-binary 필요.", file=sys.stderr); sys.exit(1)

# productModel.findByBarcode 와 동일 쿼리(영양 컬럼만 발췌)
Q = """
SELECT p.barcode, p.product_name,
       r.calories, r.sodium, r.serving_size AS nutrition_serving_size,
       r.resolved_source AS nutrition_source, r.off_grade, r.confidence,
       r.source_license, r.basis_confident, r.verified_at
FROM products p
LEFT JOIN product_nutrition_resolved r ON r.product_id = p.product_id
WHERE p.barcode = %s LIMIT 1
"""


def get_db_url():
    u = os.environ.get('DATABASE_URL', '').strip()
    if u and 'railway.internal' not in u and u.startswith(('postgresql://', 'postgres://')):
        return u
    u = getpass.getpass("DATABASE_URL (PUBLIC): ").strip()
    if not u.startswith(('postgresql://', 'postgres://')) or 'railway.internal' in u:
        print("ERROR: PUBLIC URL 필요.", file=sys.stderr); sys.exit(1)
    return u


def main():
    conn = psycopg2.connect(get_db_url()); cur = conn.cursor()

    # 샘플 바코드: OFF load 1건 + 식약처(nd) 1건
    cur.execute("""SELECT p.barcode FROM openfoodfacts_product_match m
                   JOIN products p ON p.product_id=m.product_id
                   WHERE m.decision='load' AND m.off_grade IN ('A','B') LIMIT 1""")
    off_bc = (cur.fetchone() or [None])[0]
    cur.execute("""SELECT p.barcode FROM products p JOIN nutrition_data n ON n.product_id=p.product_id
                   WHERE p.barcode IS NOT NULL LIMIT 1""")
    nd_bc = (cur.fetchone() or [None])[0]

    cols = [c.split(" AS ")[-1].strip() for c in
            ["barcode", "product_name", "calories", "sodium", "nutrition_serving_size",
             "nutrition_source", "off_grade", "confidence", "source_license", "basis_confident", "verified_at"]]

    for label, bc in (("OFF 적재 제품", off_bc), ("식약처(nd) 제품", nd_bc)):
        print(f"\n=== {label}: barcode={bc} ===")
        if not bc:
            print("  (샘플 없음)"); continue
        cur.execute(Q, (bc,))
        row = cur.fetchone()
        for k, v in zip(cols, row):
            print(f"  {k}: {v}")

    # 성능: OFF 제품 1건 EXPLAIN ANALYZE
    if off_bc:
        print(f"\n=== EXPLAIN ANALYZE (barcode={off_bc}) ===")
        cur.execute("EXPLAIN (ANALYZE, BUFFERS, TIMING) " + Q.replace("%s", "%(bc)s"), {"bc": off_bc})
        slow = False
        for (line,) in cur.fetchall():
            print("  " + line)
            if "Seq Scan on nutrition_data" in line:
                slow = True
        print("\n  ⚠ nutrition_data Seq Scan 감지 — 성능 점검 필요(인덱스 푸시다운 안 됨)" if slow
              else "\n  ✓ nutrition_data 전체 Seq Scan 없음(인덱스 경로)")
    cur.close(); conn.close()
    print("\n확인 포인트: OFF 제품 nutrition_source=openfoodfacts·confidence=low·source_license=ODbL-1.0,")
    print("            식약처 제품 nutrition_source=public_nutrition·verified_at 존재, Execution Time 양호.")


if __name__ == "__main__":
    main()
