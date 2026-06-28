# -*- coding: utf-8 -*-
"""
off_fingerprint_check.py — 정체성 브릿지 fingerprint 드리프트 점검
SOURCE: 자문 reconcile §D (Gemini safe-failure: 제품명 수정 시 fingerprint 갱신지연 → 결합 풀림)
목적: products 가 매칭 이후 변경(이름 오타수정 등)되어 브릿지 fingerprint 와 어긋난 제품을 가시화.
      decision='load' 인데 drift 면 해당 제품은 view 에서 OFF 결합이 풀려 영양이 '회색(결측)'으로 보일 수 있음.
      (월 1회 재실행 전까지 수용 가능한 안전실패지만, 조기 발견용.)
사용:
  $env:DATABASE_URL="postgresql://...PUBLIC..."
  python meokseon-server/scripts/staging/off/off_fingerprint_check.py            # drift 리포트
  python meokseon-server/scripts/staging/off/off_fingerprint_check.py --fix-list  # 재판정 필요 product_id 목록만
"""
import os, sys, getpass

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2-binary 필요. py -m pip install psycopg2-binary", file=sys.stderr); sys.exit(1)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import off_load_railway as L  # product_fingerprint 재사용(적재와 동일 로직 보장)

FIX_LIST = "--fix-list" in sys.argv


def get_db_url():
    url = os.environ.get('DATABASE_URL', '').strip()
    if url and 'railway.internal' not in url and (url.startswith('postgresql://') or url.startswith('postgres://')):
        return url
    url = getpass.getpass("DATABASE_URL (PUBLIC): ").strip()
    if not (url.startswith('postgresql://') or url.startswith('postgres://')) or 'railway.internal' in url:
        print("ERROR: PUBLIC postgresql:// URL 필요.", file=sys.stderr); sys.exit(1)
    return url


def main():
    conn = psycopg2.connect(get_db_url())
    cur = conn.cursor()
    cur.execute("""
        SELECT m.product_id, m.code, m.decision, m.product_fingerprint,
               p.product_name, p.brand, p.food_category::text, p.food_type
        FROM openfoodfacts_product_match m
        JOIN products p ON p.product_id = m.product_id
    """)
    rows = cur.fetchall()
    drift_load, drift_other = [], []
    for pid, code, decision, fp_old, name, brand, fcat, ftype in rows:
        p = {"product_name": name, "brand": brand, "food_category": fcat, "food_type": ftype}
        fp_now = L.product_fingerprint(p)
        if fp_now != fp_old:
            (drift_load if decision == "load" else drift_other).append((pid, code, decision, name))

    if FIX_LIST:
        for pid, *_ in drift_load:
            print(pid)
        cur.close(); conn.close()
        return

    print(f"브릿지 총 {len(rows):,}건 점검")
    print(f"  drift(decision=load, OFF 결합 풀림 가능): {len(drift_load):,}건")
    print(f"  drift(기타 decision): {len(drift_other):,}건")
    for pid, code, decision, name in drift_load[:20]:
        print(f"    [load] pid={pid} code={code} :: {(name or '')[:40]}")
    if drift_load:
        print("\n→ 권고: 해당 product 재판정(다음 월간 재실행 또는 off_load_railway 재실행 시 자동 정정).")
        print("  --fix-list 로 product_id 목록만 출력 가능.")
    else:
        print("  drift 없음 ✅")
    cur.close(); conn.close()


if __name__ == "__main__":
    main()
