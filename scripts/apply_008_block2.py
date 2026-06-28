"""
Migration 008 묶음 2 — additives v2.0 컬럼 28개 추가 (psycopg2 직접 실행).

배경:
  Railway Query Console 한계로 ALTER TABLE 다중 실행이 silently 실패함.
    - 단일 ALTER TABLE + 콤마분리 다중 ADD COLUMN: 실패
    - 동질 multi-statement (ALTER TABLE × N): 실패
  → 007 적용 때 검증된 psycopg2 직접 연결 패턴 재사용 (Railway Console 우회).

사전 조건:
  PowerShell> pip install psycopg2-binary  # native 컴파일 없는 binary 휠
  PowerShell> $env:DATABASE_URL='postgresql://postgres:****@hopper.proxy.rlwy.net:21355/railway'

사용법:
  PowerShell> cd 'D:\\AI MeokSeon\\meokseon-server'
  PowerShell> python scripts\\apply_008_block2.py --dry-run   # 실행할 SQL 표시
  PowerShell> python scripts\\apply_008_block2.py             # 실제 적용

특징:
  - autocommit 모드: 각 ALTER TABLE이 독립 트랜잭션 (한 개 실패해도 나머지 진행)
  - IF NOT EXISTS: 멱등 — 재실행 안전
  - 적용 후 자동 검증: 컬럼 수, 핵심 v2 컬럼 존재 여부

SOURCE: D:\\AI MeokSeon\\meokseon-server\\scripts\\migrations\\008_mfras_v2.sql 묶음 2 사본.
"""
import os
import sys
import getpass

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2가 설치되어 있지 않습니다.")
    print("       PowerShell> pip install psycopg2-binary")
    sys.exit(1)


def get_db_url():
    """
    DATABASE_URL을 안전하게 획득.
    우선순위:
      1) 환경변수 DATABASE_URL (정상 길이 확인)
      2) 환경변수가 없거나 비정상 길이면 getpass로 직접 입력 (화면 미표시)
    """
    url = os.environ.get('DATABASE_URL', '').strip()

    # 환경변수가 있어도 패스워드 길이가 너무 짧으면 무시 (오염 가능성)
    if url:
        try:
            pw = url.split('postgres:', 1)[1].split('@', 1)[0]
            if len(pw) >= 20:
                print(f"환경변수 DATABASE_URL 사용 (패스워드 {len(pw)}자)")
                return url
            else:
                print(f"⚠ 환경변수 DATABASE_URL의 패스워드가 {len(pw)}자 — 비정상. 무시하고 직접 입력 받습니다.")
        except (IndexError, ValueError):
            print("⚠ 환경변수 DATABASE_URL 형식 비정상. 무시하고 직접 입력 받습니다.")

    print()
    print("=== DATABASE_URL 입력 ===")
    print("Railway 대시보드 → Postgres → Variables → DATABASE_URL 복사 후 아래에 붙여넣기")
    print("(보안: 입력은 화면에 표시되지 않습니다)")
    url = getpass.getpass("DATABASE_URL: ").strip()

    if not url:
        print("ERROR: 빈 입력. 종료합니다.")
        sys.exit(1)

    # 입력값 검증
    if not url.startswith('postgresql://') and not url.startswith('postgres://'):
        print("ERROR: postgresql:// 또는 postgres:// 로 시작해야 합니다.")
        sys.exit(1)

    try:
        pw = url.split('postgres:', 1)[1].split('@', 1)[0]
        if len(pw) < 20:
            print(f"ERROR: 패스워드 길이 {len(pw)}자 — 정상 Railway 패스워드는 32자입니다. 다시 확인하세요.")
            sys.exit(1)
        print(f"✅ URL 형식 정상 (패스워드 {len(pw)}자)")
    except (IndexError, ValueError):
        print("ERROR: URL 형식이 잘못됨. postgresql://user:pass@host:port/db 형식이어야 합니다.")
        sys.exit(1)

    return url


# (컬럼명, ALTER TABLE SQL) — 008_mfras_v2.sql 묶음 2와 동일 순서
STATEMENTS = [
    # 식별·분류 (4: name_en은 이미 production에 있음, 제외)
    ("aliases",            "ALTER TABLE additives ADD COLUMN IF NOT EXISTS aliases TEXT[]"),
    ("ins_no",             "ALTER TABLE additives ADD COLUMN IF NOT EXISTS ins_no VARCHAR(20)"),
    ("section",            "ALTER TABLE additives ADD COLUMN IF NOT EXISTS section VARCHAR(50)"),
    ("page",               "ALTER TABLE additives ADD COLUMN IF NOT EXISTS page INTEGER"),

    # 사용 기준 (5)
    ("usage_standard_raw", "ALTER TABLE additives ADD COLUMN IF NOT EXISTS usage_standard_raw TEXT"),
    ("purposes",           "ALTER TABLE additives ADD COLUMN IF NOT EXISTS purposes TEXT[]"),
    ("max_limits",         "ALTER TABLE additives ADD COLUMN IF NOT EXISTS max_limits JSONB"),
    ("has_quantity_limit", "ALTER TABLE additives ADD COLUMN IF NOT EXISTS has_quantity_limit BOOLEAN"),
    ("usage_type",         "ALTER TABLE additives ADD COLUMN IF NOT EXISTS usage_type VARCHAR(50)"),

    # 5차원 원천 데이터 (9)
    ("adi_type",           "ALTER TABLE additives ADD COLUMN IF NOT EXISTS adi_type VARCHAR(50)"),
    ("adi_value",          "ALTER TABLE additives ADD COLUMN IF NOT EXISTS adi_value VARCHAR(50)"),
    ("edi",                "ALTER TABLE additives ADD COLUMN IF NOT EXISTS edi VARCHAR(50)"),
    ("iarc_group",         "ALTER TABLE additives ADD COLUMN IF NOT EXISTS iarc_group VARCHAR(20)"),
    ("genotox_status",     "ALTER TABLE additives ADD COLUMN IF NOT EXISTS genotox_status VARCHAR(30)"),
    ("regulatory_status",  "ALTER TABLE additives ADD COLUMN IF NOT EXISTS regulatory_status VARCHAR(50)"),
    ("klimisch_level",     "ALTER TABLE additives ADD COLUMN IF NOT EXISTS klimisch_level INTEGER"),
    ("last_eval_year",     "ALTER TABLE additives ADD COLUMN IF NOT EXISTS last_eval_year INTEGER"),
    ("data_sufficiency",   "ALTER TABLE additives ADD COLUMN IF NOT EXISTS data_sufficiency VARCHAR(30)"),

    # 5차원 점수 (5)
    ("dim_a_toxicity",     "ALTER TABLE additives ADD COLUMN IF NOT EXISTS dim_a_toxicity NUMERIC(4,2)"),
    ("dim_b_exposure",     "ALTER TABLE additives ADD COLUMN IF NOT EXISTS dim_b_exposure NUMERIC(4,2)"),
    ("dim_c_genotox",      "ALTER TABLE additives ADD COLUMN IF NOT EXISTS dim_c_genotox NUMERIC(4,2)"),
    ("dim_d_regulation",   "ALTER TABLE additives ADD COLUMN IF NOT EXISTS dim_d_regulation NUMERIC(4,2)"),
    ("dim_e_data_quality", "ALTER TABLE additives ADD COLUMN IF NOT EXISTS dim_e_data_quality NUMERIC(4,2)"),

    # 종합 결과 + 메타 (5)
    ("mfras_total",        "ALTER TABLE additives ADD COLUMN IF NOT EXISTS mfras_total NUMERIC(5,2)"),
    ("mfras_grade",        "ALTER TABLE additives ADD COLUMN IF NOT EXISTS mfras_grade mfras_grade"),
    ("mfras_override",     "ALTER TABLE additives ADD COLUMN IF NOT EXISTS mfras_override VARCHAR(50)"),
    ("mfras_rationales",   "ALTER TABLE additives ADD COLUMN IF NOT EXISTS mfras_rationales JSONB"),
    ("evaluated_at",       "ALTER TABLE additives ADD COLUMN IF NOT EXISTS evaluated_at TIMESTAMPTZ DEFAULT NOW()"),
]

# 검증용 핵심 v2 컬럼 (전부 있어야 정상)
KEY_V2_COLUMNS = [
    'aliases', 'ins_no', 'section',
    'dim_a_toxicity', 'dim_b_exposure', 'dim_c_genotox', 'dim_d_regulation', 'dim_e_data_quality',
    'mfras_total', 'mfras_grade', 'mfras_override', 'mfras_rationales', 'evaluated_at'
]


def main():
    dry_run = '--dry-run' in sys.argv

    print(f"=== Migration 008 묶음 2 적용 ===")
    print(f"  총 {len(STATEMENTS)}개 ALTER TABLE 실행 예정")
    print(f"  dry-run: {dry_run}\n")

    db_url = get_db_url()

    if dry_run:
        print("실행할 SQL:")
        for i, (name, sql) in enumerate(STATEMENTS, 1):
            print(f"  [{i:2d}/{len(STATEMENTS)}] {name:25s} | {sql}")
        print("\n--dry-run 모드 — DB 변경 없음. 실제 적용은 --dry-run 빼고 재실행.")
        return

    # 사전 상태 확인
    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("""
        SELECT count(*) FROM information_schema.columns
        WHERE table_schema='public' AND table_name='additives'
    """)
    before = cur.fetchone()[0]
    print(f"적용 전 additives 컬럼 수: {before}\n")

    # 적용
    success, fail, skipped = 0, 0, 0
    for i, (name, sql) in enumerate(STATEMENTS, 1):
        try:
            cur.execute(sql)
            # IF NOT EXISTS이므로 이미 있어도 성공으로 처리 — 별도 구분 불가
            print(f"  [{i:2d}/{len(STATEMENTS)}] {name:25s} OK")
            success += 1
        except Exception as e:
            print(f"  [{i:2d}/{len(STATEMENTS)}] {name:25s} FAIL — {type(e).__name__}: {e}")
            fail += 1

    print(f"\n실행 결과: 성공 {success}, 실패 {fail}")

    # 사후 검증
    cur.execute("""
        SELECT count(*) FROM information_schema.columns
        WHERE table_schema='public' AND table_name='additives'
    """)
    after = cur.fetchone()[0]
    print(f"\n적용 후 additives 컬럼 수: {after} (전: {before}, 증가: {after - before})")

    # 핵심 v2 컬럼 존재 확인
    cur.execute("""
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='additives'
          AND column_name = ANY(%s)
        ORDER BY column_name
    """, (KEY_V2_COLUMNS,))
    present = {row[0] for row in cur.fetchall()}
    missing = set(KEY_V2_COLUMNS) - present

    print(f"\n핵심 v2 컬럼 검증 ({len(KEY_V2_COLUMNS)}개):")
    print(f"  존재: {len(present)} — {sorted(present)}")
    if missing:
        print(f"  ★ 누락: {len(missing)} — {sorted(missing)}")
    else:
        print(f"  ★ 모두 존재 — 묶음 2 적용 완료")

    cur.close()
    conn.close()


if __name__ == '__main__':
    main()
