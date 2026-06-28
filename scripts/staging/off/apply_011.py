# -*- coding: utf-8 -*-
"""
apply_011.py — 011_openfoodfacts_tables.sql 을 Railway 에 적용 + 검증
SOURCE: scripts/migrations/011_openfoodfacts_tables.sql
선행: korea_off 게이트 eval(off_extract_gate.py) 검토 완료(Eval-First).
사용:
  $env:DATABASE_URL="postgresql://...DATABASE_PUBLIC_URL..."
  python meokseon-server/scripts/staging/off/apply_011.py            # 적용
  python meokseon-server/scripts/staging/off/apply_011.py --check     # 객체 존재만 확인(미적용)
동작: 파일 자체가 BEGIN..COMMIT 이라 원자 적용. 적용 후 테이블 3종+view+products.off_code 확인.
"""
import os, sys, getpass

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2-binary 필요. py -m pip install psycopg2-binary", file=sys.stderr); sys.exit(1)

CHECK_ONLY = "--check" in sys.argv
HERE = os.path.dirname(os.path.abspath(__file__))
SQL_PATH = os.path.normpath(os.path.join(HERE, "..", "..", "migrations", "011_openfoodfacts_tables.sql"))

OBJECTS = [
    ("table", "openfoodfacts_raw"),
    ("table", "openfoodfacts_nutrition_norm"),
    ("table", "nutrition_conflict_queue"),
    ("view",  "product_nutrition_resolved"),
]


def get_db_url():
    url = os.environ.get('DATABASE_URL', '').strip()
    if url:
        try:
            pw = url.split('postgres:', 1)[1].split('@', 1)[0]
            host = url.split('@', 1)[1].split('/', 1)[0]
            if len(pw) >= 20 and 'railway.internal' not in host:
                print(f"환경변수 DATABASE_URL 사용 (host: {host})")
                return url
        except (IndexError, ValueError):
            pass
        print("⚠ 환경변수 비정상 — 직접 입력.")
    print("\n=== DATABASE_URL (Railway → Postgres → Variables → DATABASE_PUBLIC_URL) ===")
    url = getpass.getpass("DATABASE_URL: ").strip()
    if not (url.startswith('postgresql://') or url.startswith('postgres://')):
        print("ERROR: postgresql:// 로 시작해야 함.", file=sys.stderr); sys.exit(1)
    if 'railway.internal' in url:
        print("ERROR: 내부 호스트 — PUBLIC URL 필요.", file=sys.stderr); sys.exit(1)
    return url


def verify(cur):
    ok = True
    for kind, name in OBJECTS:
        cur.execute("SELECT to_regclass(%s)", (f"public.{name}",))
        exists = cur.fetchone()[0] is not None
        print(f"  [{'OK' if exists else 'XX'}] {kind} {name}")
        ok = ok and exists
    cur.execute("""SELECT 1 FROM information_schema.columns
                   WHERE table_name='products' AND column_name='off_code'""")
    off_col = cur.fetchone() is not None
    print(f"  [{'OK' if off_col else 'XX'}] column products.off_code")
    return ok and off_col


def main():
    if not os.path.exists(SQL_PATH):
        print(f"ERROR: SQL 없음: {SQL_PATH}", file=sys.stderr); sys.exit(1)
    url = get_db_url()
    conn = psycopg2.connect(url)
    conn.autocommit = True   # 파일 내부 BEGIN/COMMIT 가 원자성 담당
    cur = conn.cursor()

    if CHECK_ONLY:
        print("[CHECK] 객체 존재 확인(적용 안 함)")
        ok = verify(cur)
        cur.close(); conn.close()
        print("결과:", "모두 존재 ✅" if ok else "일부 누락 — 적용 필요")
        return

    sql = open(SQL_PATH, encoding="utf-8").read()
    print(f"[1/2] 011 적용: {SQL_PATH} ({len(sql):,} chars)")
    try:
        cur.execute(sql)
    except Exception as e:
        print(f"ERROR: 적용 실패: {e}", file=sys.stderr)
        cur.close(); conn.close(); sys.exit(1)
    print("[2/2] 객체 검증")
    ok = verify(cur)
    cur.close(); conn.close()
    if not ok:
        print("✗ 검증 실패 — 일부 객체 누락. 롤백 SQL(파일 하단) 참고.", file=sys.stderr); sys.exit(1)
    print("\n✓ 011 적용 완료. 다음: python off_load_railway.py --dry-run")


if __name__ == "__main__":
    main()
