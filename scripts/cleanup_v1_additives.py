"""
v1 잔존 row 정리 — additives 테이블 v1/v2 잡종 상태 진단·백업·DELETE.

배경 (2026-05-23):
  Migration 008 적용 후 import_mfras_v2.py로 665종 import 했으나, count(*)=1086 발견.
  원인 추정: 기존 v1.0 시절 additives 데이터(~421개)가 이미 있었고, v2 name_ko와
  표기가 disjoint하여 ON CONFLICT(name_ko) DO UPDATE가 작동 안 함 → 모두 새 INSERT.
  결과: v1 421 + v2 665 = 1086 잡종 상태.

식별 기준:
  v2 row = mfras_grade IS NOT NULL (008에서 신규 추가된 ENUM 컬럼, v1엔 디폴트 NULL)
  v1 row = mfras_grade IS NULL

처리:
  1) 진단 — total / v2 / v1 카운트
  2) v1 row 전체 백업 → JSON 파일 (IP/database/backups/)
  3) 사용자 확인
  4) DELETE FROM additives WHERE mfras_grade IS NULL
  5) 검증 — count(*) == 665

사용법:
  PowerShell> cd 'D:\\AI MeokSeon\\meokseon-server'
  PowerShell> python scripts\\cleanup_v1_additives.py --diagnose      # 진단만
  PowerShell> python scripts\\cleanup_v1_additives.py --backup-only   # 진단+백업, DELETE 안 함
  PowerShell> python scripts\\cleanup_v1_additives.py                 # 진단+백업+DELETE (y/N 확인)
"""
import os
import sys
import json
import getpass
from datetime import datetime

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except ImportError:
    print("ERROR: psycopg2-binary required.", file=sys.stderr)
    sys.exit(1)


BACKUP_DIR = r'C:\Users\saero\OneDrive\MeokSeon\IP\database\backups'


def get_db_url():
    url = os.environ.get('DATABASE_URL', '').strip()
    if url:
        try:
            pw = url.split('postgres:', 1)[1].split('@', 1)[0]
            host_part = url.split('@', 1)[1].split('/', 1)[0]
            if len(pw) >= 20 and 'railway.internal' not in host_part:
                print(f"환경변수 DATABASE_URL 사용 (host: {host_part})")
                return url
        except (IndexError, ValueError):
            pass

    print("\n=== DATABASE_URL 입력 ===")
    print("Railway → Postgres → Variables → DATABASE_PUBLIC_URL")
    url = getpass.getpass("DATABASE_URL: ").strip()
    if not url or not url.startswith(('postgresql://', 'postgres://')):
        print("ERROR")
        sys.exit(1)
    return url


def main():
    diagnose_only = '--diagnose' in sys.argv
    backup_only = '--backup-only' in sys.argv

    db_url = get_db_url()
    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    cur = conn.cursor(cursor_factory=RealDictCursor)

    # ─── 1) 진단 ───
    print("\n=== [1] 진단 ===")
    cur.execute("""
        SELECT
          count(*) AS total,
          count(*) FILTER (WHERE mfras_grade IS NOT NULL) AS v2_records,
          count(*) FILTER (WHERE mfras_grade IS NULL) AS v1_only
        FROM additives
    """)
    row = cur.fetchone()
    total = row['total']
    v2_n = row['v2_records']
    v1_n = row['v1_only']

    print(f"  총 row 수:       {total}")
    print(f"  v2 record (mfras_grade NOT NULL): {v2_n}")
    print(f"  v1 only (mfras_grade IS NULL):    {v1_n}")
    print(f"  검증: v2 + v1 = {v2_n + v1_n} (= total {'✅' if v2_n + v1_n == total else '❌'})")

    if v1_n == 0:
        print("\n✅ v1 잔존 row 없음 — 정리 불필요. additives = v2 only.")
        cur.close()
        conn.close()
        return

    # v1 row 샘플
    cur.execute("""
        SELECT additive_id, name_ko, name_en, risk_grade, risk_color, category
        FROM additives WHERE mfras_grade IS NULL
        ORDER BY additive_id LIMIT 5
    """)
    samples = cur.fetchall()
    print(f"\n  v1 row 샘플 (처음 5개):")
    for s in samples:
        print(f"    id={s['additive_id']:4d}  name_ko={s['name_ko']!r}  category={s['category']!r}  risk_color={s['risk_color']!r}")

    if diagnose_only:
        print("\n--diagnose 모드 — 백업·DELETE 안 함.")
        cur.close()
        conn.close()
        return

    # ─── 2) 백업 ───
    print(f"\n=== [2] v1 row 백업 ({v1_n}개) ===")

    # v1 row 전체 fetch (모든 컬럼)
    cur.execute("""
        SELECT * FROM additives WHERE mfras_grade IS NULL
        ORDER BY additive_id
    """)
    v1_rows = cur.fetchall()

    # 날짜·datetime 직렬화
    def json_default(o):
        if isinstance(o, datetime):
            return o.isoformat()
        if hasattr(o, 'isoformat'):
            return o.isoformat()
        return str(o)

    os.makedirs(BACKUP_DIR, exist_ok=True)
    backup_filename = f"additives_v1_backup_{datetime.now().strftime('%Y-%m-%d_%H%M%S')}.json"
    backup_path = os.path.join(BACKUP_DIR, backup_filename)

    with open(backup_path, 'w', encoding='utf-8') as f:
        json.dump(
            {
                "backup_date": datetime.now().isoformat(),
                "row_count": len(v1_rows),
                "purpose": "Migration 008 후 잔존 v1 row (mfras_grade IS NULL). production DELETE 전 보존.",
                "rows": [dict(r) for r in v1_rows]
            },
            f, ensure_ascii=False, indent=2, default=json_default
        )

    backup_size_kb = os.path.getsize(backup_path) / 1024
    print(f"  ✅ 백업 저장: {backup_path}")
    print(f"     크기: {backup_size_kb:.1f} KB, row {len(v1_rows)}개")

    if backup_only:
        print("\n--backup-only 모드 — DELETE 안 함. 백업만 완료.")
        cur.close()
        conn.close()
        return

    # ─── 3) 사용자 확인 ───
    print(f"\n=== [3] DELETE 확인 ===")
    print(f"  대상: additives WHERE mfras_grade IS NULL ({v1_n}개)")
    print(f"  백업: {backup_path}")
    print(f"\n  진행하시겠습니까? (yes 입력 — 명시적): ", end='', flush=True)
    answer = input().strip()
    if answer.lower() != 'yes':
        print("취소됨. 백업은 유지됩니다.")
        cur.close()
        conn.close()
        return

    # ─── 4) DELETE ───
    print(f"\n=== [4] DELETE 실행 ===")
    cur.execute("DELETE FROM additives WHERE mfras_grade IS NULL")
    deleted = cur.rowcount
    print(f"  ✅ {deleted}개 row 삭제 완료")

    # ─── 5) 검증 ───
    print(f"\n=== [5] 사후 검증 ===")
    cur.execute("SELECT count(*) AS n FROM additives")
    after_total = cur.fetchone()['n']
    print(f"  additives 총 row 수: {after_total} (기대: 665)")

    cur.execute("""
        SELECT mfras_grade, count(*) AS n
        FROM additives
        WHERE mfras_grade IS NOT NULL
        GROUP BY mfras_grade
        ORDER BY mfras_grade
    """)
    print(f"\n  mfras_grade 분포:")
    for r in cur.fetchall():
        print(f"    {r['mfras_grade']:8s} {r['n']}")

    if after_total == 665:
        print(f"\n✅ 정합성 회복 — additives = v2 only (665종).")
    else:
        print(f"\n⚠ 예상과 다름 (기대 665, 실제 {after_total}). 추가 진단 필요.")

    cur.close()
    conn.close()


if __name__ == '__main__':
    main()
