# -*- coding: utf-8 -*-
r"""
apply_migration.py — 임의 마이그레이션 SQL 적용(범용). 파일이 BEGIN/COMMIT 포함이면 원자.
사용:
  $env:DATABASE_URL="postgresql://...PUBLIC..."
  python apply_migration.py ..\..\migrations\012_resolved_view_basis_marker.sql
"""
import os, sys, getpass
try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2-binary 필요.", file=sys.stderr); sys.exit(1)

if len(sys.argv) < 2:
    print("사용: python apply_migration.py <sql파일경로>", file=sys.stderr); sys.exit(1)
SQL_PATH = sys.argv[1]
if not os.path.exists(SQL_PATH):
    print(f"ERROR: 파일 없음: {SQL_PATH}", file=sys.stderr); sys.exit(1)


def get_db_url():
    u = os.environ.get('DATABASE_URL', '').strip()
    if u and 'railway.internal' not in u and u.startswith(('postgresql://', 'postgres://')):
        return u
    u = getpass.getpass("DATABASE_URL (PUBLIC): ").strip()
    if not u.startswith(('postgresql://', 'postgres://')) or 'railway.internal' in u:
        print("ERROR: PUBLIC postgresql:// URL 필요.", file=sys.stderr); sys.exit(1)
    return u


def main():
    sql = open(SQL_PATH, encoding="utf-8").read()
    conn = psycopg2.connect(get_db_url())
    conn.autocommit = True  # 파일 내부 BEGIN/COMMIT 가 원자성 담당
    cur = conn.cursor()
    print(f"[적용] {SQL_PATH} ({len(sql):,} chars)")
    try:
        cur.execute(sql)
    except Exception as e:
        print(f"ERROR: 적용 실패: {e}", file=sys.stderr)
        cur.close(); conn.close(); sys.exit(1)
    cur.close(); conn.close()
    print("✓ 적용 완료")


if __name__ == "__main__":
    main()
