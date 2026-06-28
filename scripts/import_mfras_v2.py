"""
MFRAS v2.0 데이터 import — 665종 → production additives 테이블
=====================================================================

SOURCE: OneDrive/MeokSeon/IP/database/migration_008_mfras_v2_spec.md §4

선행 조건:
  - 008_mfras_v2.sql (스키마 변경) 이미 production 에 적용 완료
  - DATABASE_URL 환경 변수 설정
  - psycopg2-binary 설치 (pip install psycopg2-binary)
  - mfras_scored_665.json 파일 접근 가능

사용법 (사용자 PowerShell, D:\\AI MeokSeon\\):
  $env:DATABASE_URL="postgresql://..."
  python meokseon-server/scripts/import_mfras_v2.py week1_pipeline/mfras_scored_665.json

또는 dry-run (실제 INSERT 없이 매핑만 확인):
  python meokseon-server/scripts/import_mfras_v2.py week1_pipeline/mfras_scored_665.json --dry-run
"""

import json
import os
import sys
import getpass
from datetime import datetime

try:
    import psycopg2
    from psycopg2.extras import Json, execute_values
except ImportError:
    print("ERROR: psycopg2-binary required. Run: pip install psycopg2-binary", file=sys.stderr)
    sys.exit(1)


def get_db_url():
    """
    DATABASE_URL을 안전하게 획득 (apply_008_block2.py와 동일 패턴).
    환경변수 우선, 비정상 길이/형식이면 getpass로 직접 입력.
    """
    url = os.environ.get('DATABASE_URL', '').strip()
    if url:
        try:
            pw = url.split('postgres:', 1)[1].split('@', 1)[0]
            host_part = url.split('@', 1)[1].split('/', 1)[0]
            if len(pw) >= 20 and 'railway.internal' not in host_part:
                print(f"환경변수 DATABASE_URL 사용 (패스워드 {len(pw)}자, host: {host_part})")
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
        print("ERROR: 빈 입력.", file=sys.stderr)
        sys.exit(1)
    if not (url.startswith('postgresql://') or url.startswith('postgres://')):
        print("ERROR: postgresql:// 로 시작해야 합니다.", file=sys.stderr)
        sys.exit(1)
    try:
        pw = url.split('postgres:', 1)[1].split('@', 1)[0]
        host_part = url.split('@', 1)[1].split('/', 1)[0]
        if len(pw) < 20:
            print(f"ERROR: 패스워드 {len(pw)}자 — 비정상.", file=sys.stderr)
            sys.exit(1)
        if 'railway.internal' in host_part:
            print(f"ERROR: 내부 호스트 ({host_part}) — DATABASE_PUBLIC_URL 필요.", file=sys.stderr)
            sys.exit(1)
        print(f"✅ URL 형식 정상 (패스워드 {len(pw)}자, host: {host_part})")
    except (IndexError, ValueError):
        print("ERROR: URL 형식 잘못됨.", file=sys.stderr)
        sys.exit(1)

    return url


# ============================================================
# 1. 환경 설정
# ============================================================

DB_URL = get_db_url()

JSON_PATH = sys.argv[1] if len(sys.argv) > 1 else "mfras_scored_665.json"
DRY_RUN = "--dry-run" in sys.argv

if not os.path.isfile(JSON_PATH):
    print(f"ERROR: JSON file not found: {JSON_PATH}", file=sys.stderr)
    sys.exit(1)


# ============================================================
# 2. 매핑 함수
# ============================================================

def normalize_apostrophe(s):
    """U+2019 (right single quotation mark) → ASCII U+0027.
    8개 뉴클레오티드 영양강화제 매칭 이슈 해결 (노션 보고서 §4 참조)."""
    if s is None:
        return None
    return s.replace("’", "'")


def lower_color(c):
    """JSON 의 'YELLOW' → ENUM 'yellow' 매핑. None → None."""
    if not c:
        return None
    return c.lower()


def to_v1_grade(color):
    """v2 color → v1 risk_grade INTEGER 매핑 (호환성 유지)."""
    return {"green": 1, "yellow": 2, "orange": 3, "red": 4}.get(color, 0)


def dims_tuple(record):
    """mfras_dims dict → (a, b, c, d, e) 5튜플."""
    d = record.get("mfras_dims") or {}
    return (
        d.get("A"),
        d.get("B"),
        d.get("C"),
        d.get("D"),
        d.get("E"),
    )


def record_to_row(record):
    """JSON record → SQL VALUES 튜플 매핑.

    스펙 §4-2 매핑 표 그대로.
    name_ko 는 normalize_apostrophe 로 U+2019 정규화.
    """
    color = lower_color(record.get("mfras_color"))
    name_ko = normalize_apostrophe(record.get("name_kr"))

    return (
        name_ko,                                    # name_ko
        record.get("name_en"),
        record.get("aliases") or [],                # TEXT[]
        record.get("ins_no"),
        record.get("cas_no"),                       # cas_number (v1)
        record.get("e_number"),
        record.get("category"),
        record.get("section"),
        record.get("page"),
        record.get("usage_standard_raw"),
        record.get("purposes") or [],
        Json(record.get("max_limits") or []),
        record.get("has_quantity_limit"),
        record.get("usage_type"),
        record.get("adi_type"),
        record.get("adi_value"),
        record.get("edi"),
        record.get("iarc_group"),
        record.get("genotox_status"),
        record.get("regulatory_status"),
        record.get("klimisch_level"),
        record.get("last_eval_year"),
        record.get("data_sufficiency"),
        *dims_tuple(record),                        # dim_a~e
        record.get("mfras_score"),                  # mfras_total
        color,                                      # mfras_grade
        record.get("mfras_override"),
        Json(record.get("mfras_rationales") or {}),
        to_v1_grade(color),                         # v1 호환 risk_grade
        color,                                      # v1 호환 risk_color
    )


# ============================================================
# 3. JSON 로드
# ============================================================

print(f"[1/5] Loading {JSON_PATH}...")
with open(JSON_PATH, encoding="utf-8") as f:
    records = json.load(f)
print(f"      {len(records)} records loaded")


# ============================================================
# 4. 매핑
# ============================================================

print("[2/5] Mapping records to SQL rows...")
rows = []
errors = []
for i, r in enumerate(records):
    try:
        rows.append(record_to_row(r))
    except Exception as e:
        errors.append((i, r.get("name_kr"), str(e)))

print(f"      mapped: {len(rows)}, errors: {len(errors)}")
if errors:
    print("      ERROR samples (first 5):")
    for idx, name, err in errors[:5]:
        print(f"        [{idx}] {name}: {err}")
    sys.exit(1)


# ============================================================
# 5. 정합 사전 점검 (Dry-run 시 stop)
# ============================================================

if DRY_RUN:
    print("\n[DRY-RUN] Sample of first 3 mapped rows:")
    for i in range(min(3, len(rows))):
        print(f"  --- row {i+1} ---")
        cols = [
            "name_ko", "name_en", "ins_no", "section", "mfras_total",
            "mfras_grade", "mfras_override"
        ]
        for j, col in enumerate(cols):
            idx_map = {
                "name_ko": 0, "name_en": 1, "ins_no": 3, "section": 7,
                "mfras_total": 28, "mfras_grade": 29, "mfras_override": 30
            }
            print(f"    {col}: {rows[i][idx_map[col]]}")
    print(f"\n[DRY-RUN] Total {len(rows)} rows ready. No DB changes made.")
    sys.exit(0)


# ============================================================
# 6. DB 적용
# ============================================================

print("[3/5] Connecting to database...")
try:
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()
except Exception as e:
    print(f"ERROR: DB connection failed: {e}", file=sys.stderr)
    sys.exit(1)

# 사전 점검: additives 테이블 + mfras_grade 컬럼 존재 확인
cur.execute("""
    SELECT column_name FROM information_schema.columns
    WHERE table_name='additives' AND column_name='mfras_grade';
""")
if cur.fetchone() is None:
    print("ERROR: additives.mfras_grade column not found. Run 008_mfras_v2.sql first.", file=sys.stderr)
    cur.close()
    conn.close()
    sys.exit(1)

# UNIQUE 제약 확인 (ON CONFLICT 가능 여부)
cur.execute("""
    SELECT constraint_name FROM information_schema.table_constraints
    WHERE table_name='additives' AND constraint_type='UNIQUE'
      AND constraint_name LIKE '%name_ko%';
""")
unique_exists = cur.fetchone() is not None
if not unique_exists:
    # name_ko UNIQUE 제약 없으면 중복 확인 + 추가 시도
    print("[INFO] additives.name_ko UNIQUE constraint not found. Checking for duplicates...")
    cur.execute("""
        SELECT name_ko, COUNT(*) FROM additives
        GROUP BY name_ko HAVING COUNT(*) > 1 LIMIT 5;
    """)
    dups = cur.fetchall()
    if dups:
        print("ERROR: Duplicate name_ko found in additives. Cannot add UNIQUE.", file=sys.stderr)
        for name, count in dups:
            print(f"  - {name}: {count} rows", file=sys.stderr)
        cur.close()
        conn.close()
        sys.exit(1)
    print("[INFO] No duplicates. Adding UNIQUE constraint...")
    cur.execute("ALTER TABLE additives ADD CONSTRAINT additives_name_ko_unique UNIQUE (name_ko);")
    conn.commit()
    print("[INFO] UNIQUE constraint added.")


# ============================================================
# 7. INSERT (ON CONFLICT DO UPDATE)
# ============================================================

print(f"[4/5] Inserting/updating {len(rows)} records...")

sql = """
INSERT INTO additives (
  name_ko, name_en, aliases, ins_no, cas_number, e_number, category,
  section, page, usage_standard_raw, purposes, max_limits, has_quantity_limit, usage_type,
  adi_type, adi_value, edi, iarc_group, genotox_status, regulatory_status,
  klimisch_level, last_eval_year, data_sufficiency,
  dim_a_toxicity, dim_b_exposure, dim_c_genotox, dim_d_regulation, dim_e_data_quality,
  mfras_total, mfras_grade, mfras_override, mfras_rationales,
  risk_grade, risk_color
) VALUES %s
ON CONFLICT (name_ko) DO UPDATE SET
  name_en = EXCLUDED.name_en,
  aliases = EXCLUDED.aliases,
  ins_no = EXCLUDED.ins_no,
  cas_number = EXCLUDED.cas_number,
  e_number = EXCLUDED.e_number,
  category = EXCLUDED.category,
  section = EXCLUDED.section,
  page = EXCLUDED.page,
  usage_standard_raw = EXCLUDED.usage_standard_raw,
  purposes = EXCLUDED.purposes,
  max_limits = EXCLUDED.max_limits,
  has_quantity_limit = EXCLUDED.has_quantity_limit,
  usage_type = EXCLUDED.usage_type,
  adi_type = EXCLUDED.adi_type,
  adi_value = EXCLUDED.adi_value,
  edi = EXCLUDED.edi,
  iarc_group = EXCLUDED.iarc_group,
  genotox_status = EXCLUDED.genotox_status,
  regulatory_status = EXCLUDED.regulatory_status,
  klimisch_level = EXCLUDED.klimisch_level,
  last_eval_year = EXCLUDED.last_eval_year,
  data_sufficiency = EXCLUDED.data_sufficiency,
  dim_a_toxicity = EXCLUDED.dim_a_toxicity,
  dim_b_exposure = EXCLUDED.dim_b_exposure,
  dim_c_genotox = EXCLUDED.dim_c_genotox,
  dim_d_regulation = EXCLUDED.dim_d_regulation,
  dim_e_data_quality = EXCLUDED.dim_e_data_quality,
  mfras_total = EXCLUDED.mfras_total,
  mfras_grade = EXCLUDED.mfras_grade,
  mfras_override = EXCLUDED.mfras_override,
  mfras_rationales = EXCLUDED.mfras_rationales,
  risk_grade = EXCLUDED.risk_grade,
  risk_color = EXCLUDED.risk_color,
  evaluated_at = NOW()
"""

try:
    execute_values(cur, sql, rows, page_size=100)
    conn.commit()
    print(f"      ✓ Insert/Update complete: {len(rows)} records")
except Exception as e:
    conn.rollback()
    print(f"ERROR: Insert failed: {e}", file=sys.stderr)
    cur.close()
    conn.close()
    sys.exit(1)


# ============================================================
# 8. 검증 — 분포 확인 (스펙 §4-5)
# ============================================================

print("[5/5] Verifying distribution...")

print("\n  ── mfras_grade 분포 ──")
cur.execute("""
    SELECT mfras_grade, COUNT(*)
    FROM additives WHERE mfras_grade IS NOT NULL
    GROUP BY mfras_grade ORDER BY mfras_grade;
""")
for grade, count in cur.fetchall():
    print(f"    {grade}: {count}")
print("  기대: green ~327, yellow ~227, orange ~106, red 5")

print("\n  ── mfras_override 분포 ──")
cur.execute("""
    SELECT COALESCE(mfras_override, 'none') AS override, COUNT(*)
    FROM additives
    GROUP BY mfras_override ORDER BY COUNT(*) DESC;
""")
for override, count in cur.fetchall():
    print(f"    {override}: {count}")
print("  기대: none/null=349, auto_green=314, auto_red=2")

print("\n  ── section 분포 ──")
cur.execute("""
    SELECT section, COUNT(*)
    FROM additives WHERE section IS NOT NULL
    GROUP BY section ORDER BY COUNT(*) DESC;
""")
for section, count in cur.fetchall():
    print(f"    {section}: {count}")
print("  기대: 일반식품첨가물=475, 영양강화제=95, 가공보조제=74, 기구등의살균소독제=12, 혼합제제류=9")

print("\n  ── 🔴 빨강(red) 5건 ──")
cur.execute("""
    SELECT name_ko, mfras_total, mfras_override
    FROM additives WHERE mfras_grade = 'red'
    ORDER BY mfras_total DESC;
""")
for name, total, override in cur.fetchall():
    print(f"    {name}: total={total}, override={override}")
print("  기대: 식용색소적색제2호·동알루미늄레이크·적색제3호·아질산나트륨·발색제제")


cur.close()
conn.close()
print(f"\n✓ Import complete: {len(rows)} records · {datetime.now().isoformat()}")
print("\n다음 단계: application 코드 갱신 (스펙 §9)")
