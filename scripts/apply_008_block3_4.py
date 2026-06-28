"""
Migration 008 묶음 3+4 적용 + 진단용 test_single_col 정리 (psycopg2 직접 실행).

배경:
  묶음 2에서 Railway Console이 ALTER TABLE multi-statement를 silently 실패시킴이 확인됨.
  묶음 3 (인덱스)·묶음 4 (COMMENT)도 같은 패턴 위험 → 동일하게 Python 우회.

사전 조건:
  - 묶음 2 완료 (additives 컬럼 40개 — 12 기존 + 28 신규)

사용법:
  PowerShell> cd 'D:\\AI MeokSeon\\meokseon-server'
  PowerShell> python scripts\\apply_008_block3_4.py --dry-run   # SQL만 표시
  PowerShell> python scripts\\apply_008_block3_4.py             # 실제 적용

SOURCE: D:\\AI MeokSeon\\meokseon-server\\scripts\\migrations\\008_mfras_v2.sql 묶음 3+4 사본.
"""
import os
import sys
import getpass

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2-binary 설치 필요. PowerShell> pip install psycopg2-binary")
    sys.exit(1)


# 묶음 3 — 인덱스 3개
INDEXES = [
    ("idx_additives_mfras_grade",
     "CREATE INDEX IF NOT EXISTS idx_additives_mfras_grade ON additives(mfras_grade)"),
    ("idx_additives_ins_no",
     "CREATE INDEX IF NOT EXISTS idx_additives_ins_no ON additives(ins_no) WHERE ins_no IS NOT NULL"),
    ("idx_additives_section",
     "CREATE INDEX IF NOT EXISTS idx_additives_section ON additives(section)"),
]

# 묶음 4 — COMMENT 8개 (E'...' escape literal로 작은따옴표 안전 처리)
COMMENTS = [
    ("dim_a_toxicity", "차원 A — 독성학적 프로파일 (ADI 기반), 1~10, 가중치 25%. SOURCE: 먹선_위해성평가_프레임워크_v2.0.md §3.2"),
    ("dim_b_exposure", "차원 B — 노출 비율 (EDI/ADI Ratio), 1~10, 가중치 25%. EDI 산출 불가 시 기본값 5."),
    ("dim_c_genotox", "차원 C — 유전독성·발암성 (IARC Group 기반), 1~10, 가중치 20%."),
    ("dim_d_regulation", "차원 D — 국제 규제 합의 (JECFA·EFSA·FDA·식약처), 1~10, 가중치 15%."),
    ("dim_e_data_quality", "차원 E — 연구 데이터 품질·충분성 (Klimisch 등급 + 2005년 이전 보정), 1~10, 가중치 15%."),
    ("mfras_total", "5차원 가중 평균: A×0.25 + B×0.25 + C×0.20 + D×0.15 + E×0.15"),
    ("mfras_grade", "4색 분류: green(≤2.5) / yellow(≤4.5) / orange(≤6.5) / red(>6.5). Override 규칙 우선. 'blue' 값은 production ENUM에 잔존하나 사용 금지."),
    ("mfras_override", "NULL=정상 스코어링, 'auto_green'=ADI 미설정+무독성+전승인, 'auto_red'=IARC 1/2A 또는 ADI 철회"),
]

# 정리: 진단용 컬럼
CLEANUP = [
    ("test_single_col", "ALTER TABLE additives DROP COLUMN IF EXISTS test_single_col"),
]


def get_db_url():
    url = os.environ.get('DATABASE_URL', '').strip()
    if url:
        try:
            pw = url.split('postgres:', 1)[1].split('@', 1)[0]
            if len(pw) >= 20:
                print(f"환경변수 DATABASE_URL 사용 (패스워드 {len(pw)}자)")
                return url
        except (IndexError, ValueError):
            pass
        print("⚠ 환경변수 비정상 — 직접 입력 받습니다.")

    print()
    print("=== DATABASE_URL 입력 ===")
    print("Railway 대시보드 → Postgres → Variables → DATABASE_PUBLIC_URL 복사 (★ PUBLIC)")
    print("(보안: 입력은 화면에 표시되지 않습니다)")
    url = getpass.getpass("DATABASE_URL: ").strip()

    if not url:
        print("ERROR: 빈 입력.")
        sys.exit(1)
    if not (url.startswith('postgresql://') or url.startswith('postgres://')):
        print("ERROR: postgresql:// 로 시작해야 합니다.")
        sys.exit(1)
    try:
        pw = url.split('postgres:', 1)[1].split('@', 1)[0]
        if len(pw) < 20:
            print(f"ERROR: 패스워드 {len(pw)}자 — 비정상.")
            sys.exit(1)
        # 내부 호스트 거부
        host_part = url.split('@', 1)[1].split('/', 1)[0]
        if 'railway.internal' in host_part:
            print(f"ERROR: 내부 호스트 ({host_part}) — 로컬에선 DATABASE_PUBLIC_URL 사용 필요.")
            sys.exit(1)
        print(f"✅ URL 형식 정상 (패스워드 {len(pw)}자, host: {host_part})")
    except (IndexError, ValueError):
        print("ERROR: URL 형식 잘못됨.")
        sys.exit(1)

    return url


def main():
    dry_run = '--dry-run' in sys.argv

    print(f"=== Migration 008 묶음 3+4 + 정리 적용 ===")
    print(f"  인덱스: {len(INDEXES)}개")
    print(f"  COMMENT: {len(COMMENTS)}개")
    print(f"  정리: {len(CLEANUP)}개")
    print(f"  dry-run: {dry_run}\n")

    db_url = get_db_url()

    if dry_run:
        print("\n[묶음 3 인덱스]")
        for name, sql in INDEXES:
            print(f"  {name}: {sql}")
        print("\n[묶음 4 COMMENT]")
        for col, text in COMMENTS:
            print(f"  {col}: COMMENT ON COLUMN additives.{col} IS '{text[:60]}...'")
        print("\n[정리]")
        for name, sql in CLEANUP:
            print(f"  {name}: {sql}")
        print("\n--dry-run — DB 변경 없음.")
        return

    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    cur = conn.cursor()

    success, fail = 0, 0

    # 묶음 3 — 인덱스
    print("\n[묶음 3] 인덱스 생성")
    for i, (name, sql) in enumerate(INDEXES, 1):
        try:
            cur.execute(sql)
            print(f"  [{i}/{len(INDEXES)}] {name:30s} OK")
            success += 1
        except Exception as e:
            print(f"  [{i}/{len(INDEXES)}] {name:30s} FAIL — {e}")
            fail += 1

    # 묶음 4 — COMMENT (parameterized binding으로 SQL injection·escape 안전)
    print("\n[묶음 4] COMMENT 추가")
    for i, (col, text) in enumerate(COMMENTS, 1):
        try:
            # psycopg2가 안전하게 quote 처리 — E'...' literal 직접 만들 필요 없음
            cur.execute(f"COMMENT ON COLUMN additives.{col} IS %s", (text,))
            print(f"  [{i}/{len(COMMENTS)}] {col:25s} OK")
            success += 1
        except Exception as e:
            print(f"  [{i}/{len(COMMENTS)}] {col:25s} FAIL — {e}")
            fail += 1

    # 정리 — test_single_col 삭제
    print("\n[정리] 진단용 임시 컬럼 제거")
    for i, (name, sql) in enumerate(CLEANUP, 1):
        try:
            cur.execute(sql)
            print(f"  [{i}/{len(CLEANUP)}] {name:25s} OK (DROP COLUMN IF EXISTS)")
            success += 1
        except Exception as e:
            print(f"  [{i}/{len(CLEANUP)}] {name:25s} FAIL — {e}")
            fail += 1

    print(f"\n실행 결과: 성공 {success}, 실패 {fail}")

    # 검증 1: 인덱스 3개 존재
    print("\n=== 검증 ===")
    cur.execute("""
        SELECT indexname FROM pg_indexes
        WHERE schemaname='public' AND tablename='additives'
          AND indexname IN ('idx_additives_mfras_grade','idx_additives_ins_no','idx_additives_section')
        ORDER BY indexname
    """)
    indexes = [row[0] for row in cur.fetchall()]
    print(f"인덱스 ({len(indexes)}/3): {indexes}")

    # 검증 2: COMMENT 8개 존재
    cur.execute("""
        SELECT a.attname, col_description(a.attrelid, a.attnum) AS comment
        FROM pg_attribute a
        WHERE a.attrelid = 'additives'::regclass
          AND a.attname IN ('dim_a_toxicity','dim_b_exposure','dim_c_genotox','dim_d_regulation',
                            'dim_e_data_quality','mfras_total','mfras_grade','mfras_override')
        ORDER BY a.attname
    """)
    comment_rows = cur.fetchall()
    has_comments = sum(1 for _, c in comment_rows if c)
    print(f"COMMENT ({has_comments}/8): {[name for name, c in comment_rows if c]}")

    # 검증 3: test_single_col 제거 확인
    cur.execute("""
        SELECT count(*) FROM information_schema.columns
        WHERE table_schema='public' AND table_name='additives' AND column_name='test_single_col'
    """)
    test_remaining = cur.fetchone()[0]
    if test_remaining == 0:
        print("test_single_col: 제거됨 ✅")
    else:
        print(f"test_single_col: ⚠ 아직 존재")

    # 검증 4: 총 컬럼 수
    cur.execute("""
        SELECT count(*) FROM information_schema.columns
        WHERE table_schema='public' AND table_name='additives'
    """)
    total = cur.fetchone()[0]
    print(f"additives 총 컬럼 수: {total} (기대: 40 — 11 기존 v1 + 28 신규 v2 + name_en)")

    cur.close()
    conn.close()


if __name__ == '__main__':
    main()
