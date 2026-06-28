"""
008 마이그레이션 후속 — VARCHAR(20) 길이 부족 진단·확장.

배경:
  import_mfras_v2.py 실행 중 'value too long for type character varying(20)' 에러.
  008 스키마에서 VARCHAR(20)인 컬럼: ins_no, iarc_group.
  실제 JSON 데이터의 max length를 측정한 뒤 필요한 만큼만 확장 (추측 금지).

사용법:
  PowerShell> cd 'D:\\AI MeokSeon\\meokseon-server'
  PowerShell> python scripts\\fix_008_varchar_length.py 'D:\\AI MeokSeon\\week1_pipeline\\mfras_scored_665.json'
"""
import json
import os
import sys
import getpass

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2-binary required.", file=sys.stderr)
    sys.exit(1)


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
        print("⚠ 환경변수 비정상 — 직접 입력 받습니다.")

    print("\n=== DATABASE_URL 입력 ===")
    print("Railway → Postgres → Variables → DATABASE_PUBLIC_URL")
    url = getpass.getpass("DATABASE_URL: ").strip()
    if not url or not url.startswith(('postgresql://', 'postgres://')):
        print("ERROR: 잘못된 URL")
        sys.exit(1)
    return url


def main():
    if len(sys.argv) < 2:
        print("Usage: python fix_008_varchar_length.py <json_path>")
        sys.exit(1)

    json_path = sys.argv[1]
    if not os.path.isfile(json_path):
        print(f"ERROR: JSON not found: {json_path}")
        sys.exit(1)

    # 1) JSON 진단 — 각 VARCHAR 컬럼의 max length
    print(f"=== JSON 진단: {json_path} ===\n")
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # 데이터 구조 추정: list of dict 또는 dict with list
    if isinstance(data, dict):
        records = data.get('items') or data.get('data') or data.get('records') or list(data.values())[0]
    else:
        records = data

    if not isinstance(records, list):
        print("ERROR: JSON 구조 인식 실패")
        sys.exit(1)

    # 008 스키마의 모든 VARCHAR 컬럼과 현재 길이
    VARCHAR_FIELDS = {
        'ins_no':            20,
        'iarc_group':        20,
        'section':           50,
        'usage_type':        50,
        'adi_type':          50,
        'adi_value':         50,
        'edi':               50,
        'genotox_status':    30,
        'regulatory_status': 50,
        'data_sufficiency':  30,
        'mfras_override':    50,
        'name_en':          300,
    }

    # 각 필드의 max length 측정
    max_lengths = {field: 0 for field in VARCHAR_FIELDS}
    max_samples = {field: '' for field in VARCHAR_FIELDS}

    for rec in records:
        for field in VARCHAR_FIELDS:
            val = rec.get(field)
            if val is None:
                continue
            s = str(val)
            if len(s) > max_lengths[field]:
                max_lengths[field] = len(s)
                max_samples[field] = s

    # 결과 출력 — 초과 여부 표시
    print(f"{'필드':25s} {'현재':>6s} {'실제 max':>9s} {'상태':6s} {'샘플'}")
    print("─" * 90)
    exceeded = []
    for field, current_len in VARCHAR_FIELDS.items():
        actual = max_lengths[field]
        sample = max_samples[field][:40]
        if actual > current_len:
            status = "❌ 초과"
            exceeded.append((field, current_len, actual))
        elif actual == 0:
            status = "  (빈값)"
        else:
            status = "✅ OK"
        print(f"{field:25s} {current_len:>6d} {actual:>9d} {status:6s} {sample}")

    if not exceeded:
        print("\n✅ 초과 컬럼 없음 — 다른 원인일 수 있습니다.")
        return

    print(f"\n초과 컬럼 {len(exceeded)}개 발견:")
    for field, cur, act in exceeded:
        # 새 길이: 실제 max + 50% 여유 (최소 30자)
        new_len = max(30, int(act * 1.5))
        new_len = ((new_len + 9) // 10) * 10  # 10자 단위 반올림
        print(f"  {field}: VARCHAR({cur}) → VARCHAR({new_len}) (실제 max {act}자, 여유 포함)")

    # 사용자 확인
    print("\n위 변경을 적용하시겠습니까? (y/N): ", end='', flush=True)
    answer = input().strip().lower()
    if answer != 'y':
        print("취소됨.")
        return

    # 2) DB 적용
    db_url = get_db_url()
    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    cur = conn.cursor()

    print("\n=== ALTER COLUMN 적용 ===")
    for field, _, act in exceeded:
        new_len = max(30, int(act * 1.5))
        new_len = ((new_len + 9) // 10) * 10
        sql = f"ALTER TABLE additives ALTER COLUMN {field} TYPE VARCHAR({new_len})"
        try:
            cur.execute(sql)
            print(f"  {field:25s} OK → VARCHAR({new_len})")
        except Exception as e:
            print(f"  {field:25s} FAIL — {e}")

    # 3) 검증
    cur.execute("""
        SELECT column_name, character_maximum_length
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name='additives'
          AND column_name = ANY(%s)
        ORDER BY column_name
    """, ([f for f, _, _ in exceeded],))
    print("\n=== 검증 ===")
    for row in cur.fetchall():
        print(f"  {row[0]}: VARCHAR({row[1]})")

    cur.close()
    conn.close()
    print("\n✅ 완료. 이제 import_mfras_v2.py 재실행 가능 (멱등 — ON CONFLICT UPDATE).")


if __name__ == '__main__':
    main()
