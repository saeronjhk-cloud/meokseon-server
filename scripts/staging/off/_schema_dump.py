# -*- coding: utf-8 -*-
"""_schema_dump.py — production 실제 컬럼 확인(일회성). DATABASE_URL 필요."""
import os, sys
import psycopg2
conn = psycopg2.connect(os.environ["DATABASE_URL"])
cur = conn.cursor()
for t in ("products", "nutrition_data"):
    cur.execute("""SELECT column_name, data_type FROM information_schema.columns
                   WHERE table_name=%s ORDER BY ordinal_position""", (t,))
    cols = cur.fetchall()
    print(f"\n=== {t} ({len(cols)} cols) ===")
    for name, typ in cols:
        print(f"  {name} : {typ}")
# data_source enum 값
cur.execute("""SELECT e.enumlabel FROM pg_enum e
               JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='data_source_type'
               ORDER BY e.enumsortorder""")
print("\n=== data_source_type enum ===")
print("  ", [r[0] for r in cur.fetchall()])
cur.close(); conn.close()
