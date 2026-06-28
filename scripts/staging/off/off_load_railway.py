# -*- coding: utf-8 -*-
"""
off_load_railway.py — OFF 한국 제품 → Railway 적재 (#2, 7.4 단계)
=====================================================================
SOURCE: D:\\먹선\\IP\\off_integration_v1.md §3(격리), §6(게이트), §7(적재)
        D:\\먹선\\eval_set\\eval_set_off_v1.md
게이트: off_normalize.py (동일 모듈 직접 재사용 → eval과 byte-identical, 로직 분기 없음)
선행: 011_openfoodfacts_tables.sql 적용 완료 + korea_off.parquet 준비

설계 결정(중요):
  - 제품-주도(product-driven): 우리 products(영양 결측 + barcode) ↔ OFF 한국 제품 매칭.
    매칭된 것만 raw/norm 적재 → resolved view 에 비게이트 데이터 유입 차단(ODbL 격리·안전).
  - 정체성 게이트: identity_check(우리 제품 vs OFF) → quality_grade(identity).
    Reject/identity reject 는 미적재. A/B/C 만 norm 저장(Reject 제외).
  - 미덮어쓰기: 영양 보유 제품은 norm 미삽입(view 가 nd 우선). 대신 충돌 센서로 비교 → nutrition_conflict_queue.
  - provenance: off_snapshot_date, dump_file_name, dump_sha256, raw_hash, parser/normalizer/gate_version.
    license=ODbL-1.0 은 격리테이블 자체가 ODbL(view 에서 명시).
  - 트랜잭션 1개 + 백업 CTAS + 검증게이트(골든셋·불변식·칼로리·원본↔통합) 통과 후에만 COMMIT.

사용법 (제이 PC PowerShell, D:\\먹선\\):
  py -m pip install psycopg2-binary duckdb
  $env:DATABASE_URL="postgresql://...DATABASE_PUBLIC_URL..."
  python meokseon-server/scripts/staging/off/off_load_railway.py --dry-run        # 미적용 분류·검증만
  python meokseon-server/scripts/staging/off/off_load_railway.py                  # 실제 적재(검증 통과 시 COMMIT)

옵션:
  --parquet <path>       기본 ~/off_work/korea_off.parquet
  --snapshot-date Y-M-D  덤프 스냅샷일(기본: 오늘)
  --dump-sha256 <hex>    food.parquet 전체 해시(있으면 기록)
  --no-conflicts         충돌 센서 비활성
  --limit N              디버그: 매칭 제품 N개만
"""
import os, sys, json, hashlib, getpass
from datetime import datetime, date, timezone

# psycopg2 / duckdb 는 사용 지점에서 지연 import(순수 로직은 드라이버 없이 eval 가능).
# 같은 폴더의 게이트 모듈(SSOT) 직접 재사용
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import off_normalize as off  # noqa: E402


# ── 인자 ────────────────────────────────────────────────────────────────────
def _arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

DRY_RUN      = "--dry-run" in sys.argv
NO_CONFLICTS = "--no-conflicts" in sys.argv
SET_OFFCODE  = "--set-offcode" in sys.argv   # 기본 OFF: products UPDATE 락 회피(view 는 브릿지 사용, off_code 불필요)
PARQUET      = (_arg("--parquet") or os.path.join(os.path.expanduser("~/off_work"), "korea_off.parquet")).replace("\\", "/")
SNAPSHOT     = _arg("--snapshot-date") or date.today().isoformat()
DUMP_SHA256  = _arg("--dump-sha256")
DUMP_FILE    = "food.parquet"
LIMIT        = int(_arg("--limit") or 0)


# ── DB URL (import_mfras_v2.py 와 동일 안전패턴) ─────────────────────────────
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
    print("\n=== DATABASE_URL 입력 (Railway → Postgres → Variables → DATABASE_PUBLIC_URL) ===")
    url = getpass.getpass("DATABASE_URL: ").strip()
    if not (url.startswith('postgresql://') or url.startswith('postgres://')):
        print("ERROR: postgresql:// 로 시작해야 함.", file=sys.stderr); sys.exit(1)
    if 'railway.internal' in url:
        print("ERROR: 내부 호스트 — PUBLIC URL 필요.", file=sys.stderr); sys.exit(1)
    return url


# ── OFF parquet 로드 + 평면화 ────────────────────────────────────────────────
COLS = ("code, product_name, brands, countries_tags, categories_tags, "
        "nutriments, nutrition_data_per, serving_size, quantity, "
        "no_nutrition_data, last_modified_t")
NUT = {'energy-kcal': 'energy-kcal_100g', 'energy': 'energy_100g',
       'proteins': 'proteins_100g', 'fat': 'fat_100g',
       'saturated-fat': 'saturated-fat_100g', 'trans-fat': 'trans-fat_100g',
       'carbohydrates': 'carbohydrates_100g', 'sugars': 'sugars_100g',
       'fiber': 'fiber_100g', 'sodium': 'sodium_100g', 'salt': 'salt_100g',
       'cholesterol': 'cholesterol_100g'}


def flatten(row):
    flat = {}
    for n in (row.get("nutriments") or []):
        k = NUT.get(n.get("name"))
        if k:
            v = n.get("100g")
            if v is not None:
                flat[k] = v
    flat["nutrition_data_per"] = row.get("nutrition_data_per")
    flat["serving_size"] = row.get("serving_size")
    flat["quantity"] = row.get("quantity")
    flat["categories_tags_str"] = ",".join(row.get("categories_tags") or [])
    return flat


def pname(pn):
    if not pn:
        return ""
    d = {x.get("lang"): x.get("text") for x in pn}
    return d.get("ko") or d.get("main") or d.get("en") or (pn[0].get("text") if pn else "")


def raw_subset(row):
    """raw JSONB 로 저장할 투영본(이미지 등 비영양 필드 제외 = ODbL 풋프린트 최소·CC BY-SA 회피)."""
    return {
        "code": row.get("code"),
        "product_name": row.get("product_name"),
        "brands": row.get("brands"),
        "countries_tags": row.get("countries_tags"),
        "categories_tags": row.get("categories_tags"),
        "nutriments": row.get("nutriments"),
        "nutrition_data_per": row.get("nutrition_data_per"),
        "serving_size": row.get("serving_size"),
        "quantity": row.get("quantity"),
        "no_nutrition_data": row.get("no_nutrition_data"),
        "last_modified_t": row.get("last_modified_t"),
    }


def row_hash(d):
    return hashlib.sha256(json.dumps(d, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")).hexdigest()


def ts_from_epoch(v):
    try:
        return datetime.fromtimestamp(int(v), tz=timezone.utc) if v else None
    except (ValueError, TypeError):
        return None


# ── 적재 row 빌더 (컬럼 리스트가 튜플·INSERT 를 동시 구동 → 정렬 드리프트 차단) ──
NORM_COLS = ["code", "calories", "protein", "total_fat", "saturated_fat", "trans_fat",
             "total_carbs", "total_sugars", "dietary_fiber", "sodium_mg", "cholesterol_mg",
             "basis_amount", "basis_unit", "basis_confident", "off_grade", "energy_source",
             "parser_version", "normalizer_version", "quality_gate_version", "last_modified"]
RAW_COLS = ["code", "raw", "last_modified", "off_snapshot_date",
            "dump_file_name", "dump_sha256", "raw_hash"]
MATCH_COLS = ["product_id", "code", "decision", "identity", "off_grade",
              "product_fingerprint", "off_raw_hash", "snapshot_id"]


def build_norm_row(code, grade, n, last_modified):
    return (code, n["calories"], n["protein"], n["total_fat"], n["saturated_fat"], n["trans_fat"],
            n["total_carbs"], n["total_sugars"], n["dietary_fiber"], n["sodium_mg"], n["cholesterol_mg"],
            n["basis_amount"], n["basis_unit"], n["basis_confident"], grade, n.get("energy_source"),
            off.PARSER_VERSION, off.NORMALIZER_VERSION, off.QUALITY_GATE_VERSION, last_modified)


def build_raw_row(code, orow, snapshot, dump_file, dump_sha, json_wrap=lambda x: x):
    rs = raw_subset(orow)
    return (code, json_wrap(rs), ts_from_epoch(orow.get("last_modified_t")),
            snapshot, dump_file, dump_sha, row_hash(rs))


def _upsert_sql(table, cols, conflict="code", extra_set="updated_at=now()"):
    sets = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols if c != conflict)
    if extra_set:
        sets += ", " + extra_set
    return (f"INSERT INTO {table} ({', '.join(cols)}) VALUES %s "
            f"ON CONFLICT ({conflict}) DO UPDATE SET {sets}")


def load_off(parquet):
    if not os.path.exists(parquet):
        print(f"ERROR: parquet 없음: {parquet}\n  먼저 off_extract_gate.py 로 korea_off.parquet 생성.", file=sys.stderr)
        sys.exit(1)
    try:
        import duckdb
    except ImportError:
        print("ERROR: duckdb 필요. py -m pip install duckdb", file=sys.stderr); sys.exit(1)
    print(f"[1/6] OFF parquet 로드: {parquet}")
    con = duckdb.connect()
    rows = con.execute(f"SELECT {COLS} FROM read_parquet('{parquet}')").fetchall()
    keys = [c.strip() for c in COLS.split(",")]
    off_by_code = {}
    for r in rows:
        d = dict(zip(keys, r))
        if d.get("code"):
            off_by_code[str(d["code"])] = d
    print(f"      한국 OFF {len(off_by_code):,}건 (코드 유니크)")
    return off_by_code


# ── 충돌 센서: KFDA(per-serving) vs OFF(per-100) 비교 ────────────────────────
def conflict_check(field, kfda_val, kfda_serving, kfda_unit, off_per100, off_basis_unit):
    """둘 다 존재 + 단위 비교가능 + serving 으로 per-100 환산 가능할 때만. (diff_pct, conflict_bool).
    자문 reconcile(B-1): serving_unit 이 중량/부피(g/mL)이고 OFF basis_unit 과 같을 때만 비교.
    (serving_size 가 '1봉' 같은 개수면 거짓충돌 → 비교 스킵.)"""
    if kfda_val is None or off_per100 is None or not kfda_serving or float(kfda_serving) <= 0:
        return None, False
    ku = (kfda_unit or "").strip().lower()
    ou = (off_basis_unit or "").strip().lower()
    if ku not in ("g", "ml") or ou not in ("g", "ml") or ku != ou:
        return None, False  # 단위 불명/불일치 → 비교 불가(노이즈 방지)
    kfda_per100 = float(kfda_val) / float(kfda_serving) * 100.0
    base = max(abs(kfda_per100), abs(off_per100), 1e-9)
    diff_pct = abs(kfda_per100 - off_per100) / base * 100.0
    # 보수: 칼로리/나트륨 같은 핵심값에서 >35% 차이면 센서 큐(리뉴얼/오류 의심)
    return round(diff_pct, 1), diff_pct > 35.0


def product_fingerprint(p):
    """매칭 시점 제품 정체성 해시(브랜드/카테고리/이름). 추후 products 변경 시 무효화 탐지."""
    parts = [off._norm(p.get("product_name") or ""), off._norm(p.get("brand") or ""),
             off._norm(p.get("food_category") or ""), off._norm(p.get("food_type") or "")]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:32]


# ── 순수 분류 결정 (DB 무관 → eval 가능) ─────────────────────────────────────
def classify_match(p, orow):
    """우리 제품 p ↔ OFF row → 적재 결정. off_normalize 게이트 직접 사용.
    decision: 'load'(결측+통과) | 'conflict'(영양보유) | 'skip_reject' | 'skip_identity'."""
    flat = flatten(orow)
    n, (sodium_g, salt_g) = off.normalize_off(flat)
    off_name = pname(orow.get("product_name"))
    our_cat = " ".join(x for x in [p.get("food_type"), p.get("food_category")] if x)
    our_brand = p.get("brand") or p.get("manufacturer") or ""   # brand 대체로 빔 → manufacturer 폴백
    identity = off.identity_check(
        our_name=p["product_name"], our_brand=our_brand, our_category=our_cat,
        off_name=off_name, off_brands=orow.get("brands") or "",
        off_category=flat["categories_tags_str"], off_countries=orow.get("countries_tags") or [],
        barcode=str(p["barcode"]))
    grade, info = off.quality_grade(n, sodium_g, salt_g, identity=identity)
    if identity == "reject":
        decision = "skip_identity"
    elif grade == "Reject":
        decision = "skip_reject"
    elif p.get("has_nutr"):
        decision = "conflict"
    else:
        decision = "load"
    return {"decision": decision, "grade": grade, "identity": identity, "n": n,
            "sodium_g": sodium_g, "salt_g": salt_g, "off_name": off_name}


# ── 메인 ─────────────────────────────────────────────────────────────────────
def main():
    try:
        import psycopg2
        from psycopg2.extras import Json, execute_values
    except ImportError:
        print("ERROR: psycopg2-binary 필요. py -m pip install psycopg2-binary", file=sys.stderr); sys.exit(1)
    off_by_code = load_off(PARQUET)
    db_url = get_db_url()
    print("[2/6] DB 연결...")
    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    cur = conn.cursor()

    # 선행 점검: 011 적용 여부
    cur.execute("""SELECT to_regclass('public.openfoodfacts_raw'),
                          to_regclass('public.openfoodfacts_nutrition_norm'),
                          to_regclass('public.nutrition_conflict_queue'),
                          to_regclass('public.product_nutrition_resolved')""")
    reg = cur.fetchone()
    if not all(reg):
        print(f"ERROR: 011 미적용. 누락={reg}\n  먼저 011_openfoodfacts_tables.sql 적용.", file=sys.stderr)
        conn.close(); sys.exit(1)
    cur.execute("""SELECT 1 FROM information_schema.columns
                   WHERE table_name='products' AND column_name='off_code'""")
    if cur.fetchone() is None:
        print("ERROR: products.off_code 없음(011 미적용).", file=sys.stderr)
        conn.close(); sys.exit(1)

    # 런북 체크1: nutrition_data 제품당 중복 0 (있으면 view nd_one 방어해도 적재 보류 권고)
    cur.execute("""SELECT count(*) FROM (
                     SELECT product_id FROM nutrition_data
                     GROUP BY product_id HAVING count(*) > 1
                   ) d""")
    dup = cur.fetchone()[0]
    if dup > 0:
        print(f"  ⚠ nutrition_data 중복 product_id {dup:,}건 — view nd_one 이 1행 방어하나, "
              f"적재 전 중복 해소+UNIQUE 인덱스 권고(자문 D-3).")
        if not DRY_RUN and "--allow-dup" not in sys.argv:
            print("  ✗ 중복 존재 → 실적재 보류(검토 후 --allow-dup 로 강행 가능). 중단.", file=sys.stderr)
            conn.close(); sys.exit(1)
    else:
        print("  ✓ nutrition_data 중복 0")

    # 우리 products 중 OFF 바코드와 매칭되는 것 조회(+영양 보유 여부, 충돌비교용 nd값)
    codes = list(off_by_code.keys())
    print(f"[3/6] 매칭 제품 조회 (barcode ∈ OFF {len(codes):,}) ...")
    cur.execute("""
        SELECT p.product_id, p.barcode, p.product_name, p.brand, p.manufacturer,
               p.food_category::text, p.food_type, p.serving_size, p.serving_unit, p.off_code,
               (nd.nutrition_id IS NOT NULL) AS has_nutr,
               nd.calories AS nd_cal, nd.sodium AS nd_na
        FROM products p
        LEFT JOIN LATERAL (
            SELECT nutrition_id, calories, sodium
            FROM nutrition_data WHERE product_id = p.product_id
            ORDER BY nutrition_id LIMIT 1
        ) nd ON TRUE
        WHERE p.is_active AND p.barcode = ANY(%s)
    """, (codes,))
    prod_cols = [d[0] for d in cur.description]
    products = [dict(zip(prod_cols, r)) for r in cur.fetchall()]
    if LIMIT:
        products = products[:LIMIT]
    print(f"      매칭 제품 {len(products):,}건 (그 중 영양보유 {sum(1 for p in products if p['has_nutr']):,})")

    # 분류
    to_raw, to_norm, to_conflict, bridge_rows = [], [], [], []
    set_offcode = []
    cnt = {"A": 0, "B": 0, "C": 0, "Reject": 0, "identity_reject": 0, "skipped_has_nutr": 0}
    golden = {}

    for p in products:
        code = str(p["barcode"])
        orow = off_by_code.get(code)
        if not orow:
            continue
        res = classify_match(p, orow)
        decision, grade, identity, n = res["decision"], res["grade"], res["identity"], res["n"]
        off_name = res["off_name"]

        # 골든셋 캡처
        for t in ("신라면", "코카콜라", "coca"):
            if t.lower() in (off_name.lower() + " " + (p["product_name"] or "").lower()):
                golden.setdefault(t, (p["product_name"], n, grade, identity))

        # 브릿지 row: 모든 매칭 제품에 대해 판정 기록(view 는 decision='load' 만 결합)
        bridge_rows.append((p["product_id"], code, decision, identity,
                            (grade if grade in ("A", "B", "C", "Reject") else None),
                            product_fingerprint(p), row_hash(raw_subset(orow)), SNAPSHOT))

        if decision == "skip_identity":
            cnt["identity_reject"] += 1
            continue
        if decision == "skip_reject":
            cnt["Reject"] += 1
            continue

        # 영양 보유 제품 → 미덮어쓰기. 충돌 센서만.
        if decision == "conflict":
            cnt["skipped_has_nutr"] += 1
            if not NO_CONFLICTS:
                for field, kfda_v, off_v in (("calories", p["nd_cal"], n["calories"]),
                                             ("sodium",   p["nd_na"],  n["sodium_mg"])):
                    diff, is_conf = conflict_check(field, kfda_v, p["serving_size"],
                                                   p.get("serving_unit"), off_v, n["basis_unit"])
                    if is_conf:
                        to_conflict.append((p["product_id"], code, code, field,
                                            float(kfda_v) if kfda_v is not None else None,
                                            float(off_v) if off_v is not None else None, diff))
            continue

        # 영양 결측 + 게이트 통과(A/B/C) → 적재
        cnt[grade] += 1
        lm = ts_from_epoch(orow.get("last_modified_t"))
        to_raw.append(build_raw_row(code, orow, SNAPSHOT, DUMP_FILE, DUMP_SHA256, Json))
        to_norm.append(build_norm_row(code, grade, n, lm))
        if SET_OFFCODE:
            set_offcode.append((code, p["product_id"]))

    from collections import Counter
    conf_fields = Counter(c[3] for c in to_conflict)
    print(f"[4/6] 분류 결과: A={cnt['A']:,} B={cnt['B']:,} C={cnt['C']:,} "
          f"Reject={cnt['Reject']:,} identity_reject={cnt['identity_reject']:,} "
          f"영양보유-skip={cnt['skipped_has_nutr']:,} | 충돌큐={len(to_conflict):,}")
    print(f"      적재 대상(norm/load) {len(to_norm):,}건 | 브릿지 판정 {len(bridge_rows):,}건 "
          f"| off_code 갱신 {'ON' if SET_OFFCODE else 'OFF(락 회피)'}")
    if to_conflict:
        print(f"      충돌큐 필드분포: " + ", ".join(f"{k}={v:,}" for k, v in conf_fields.most_common()))

    # 골든셋 출력
    print("\n  ── 골든셋 (적재 전 확인) ──")
    for t, (pn_, n, g, idn) in golden.items():
        print(f"    [{g}/{idn}] {t} :: {pn_[:30]} | kcal={n['calories']} Na(mg)={n['sodium_mg']} "
              f"sugar={n['total_sugars']} basis={n['basis_unit']}")

    # ── 검증게이트 1: 적재 전 불변식 재확인(게이트와 독립 2차) ──
    # 드리프트 방지: NORM_COLS 인덱스 맵으로 컬럼 추출(하드코딩 인덱스 금지).
    _ix = {c: i for i, c in enumerate(NORM_COLS)}
    bad = []
    for t in to_norm:
        nn = {k: t[_ix[k]] for k in
              ("total_sugars", "total_carbs", "saturated_fat", "total_fat", "trans_fat", "sodium_mg")}
        v = off.invariant_violation(nn)
        if v:
            bad.append((t[0], v))
    if bad:
        print(f"\n  ✗ 검증게이트 실패: 불변식 위반 {len(bad)}건 (예: {bad[:3]}) → 중단", file=sys.stderr)
        conn.rollback(); conn.close(); sys.exit(1)
    print(f"\n  ✓ 불변식 게이트: {len(to_norm):,}건 위반 0")

    if DRY_RUN:
        print("\n[DRY-RUN] DB 미변경. 위 분류·골든셋·검증으로 게이트 타당성 확인 후 실적재.")
        conn.rollback(); conn.close()
        return

    # ── 트랜잭션: 백업 → 적재 → 검증 → COMMIT/ROLLBACK ──
    print("\n[5/6] 트랜잭션 적재 시작...")
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    try:
        # 백업: 격리테이블 풀백업(재실행 시 upsert 덮어쓰기 롤백용) + off_code 스냅샷
        cur.execute(f'CREATE TABLE off_raw_bak_{stamp} AS TABLE openfoodfacts_raw')
        cur.execute(f'CREATE TABLE off_norm_bak_{stamp} AS TABLE openfoodfacts_nutrition_norm')
        cur.execute(f'CREATE TABLE off_match_bak_{stamp} AS TABLE openfoodfacts_product_match')
        if SET_OFFCODE:
            cur.execute(f'CREATE TABLE off_offcode_bak_{stamp} AS '
                        f'SELECT product_id, off_code FROM products WHERE barcode = ANY(%s)', (codes,))

        if bridge_rows:
            execute_values(cur, _upsert_sql("openfoodfacts_product_match", MATCH_COLS,
                                            conflict="product_id", extra_set="matched_at=now()"),
                           bridge_rows, page_size=500)
        if to_raw:
            execute_values(cur, _upsert_sql("openfoodfacts_raw", RAW_COLS, extra_set="imported_at=now()"),
                           to_raw, page_size=500)
        if to_norm:
            execute_values(cur, _upsert_sql("openfoodfacts_nutrition_norm", NORM_COLS,
                                            extra_set="updated_at=now()"),
                           to_norm, page_size=500)
        if SET_OFFCODE and set_offcode:
            # 선택: products.off_code 포인터 갱신(라이브 테이블 락 발생). 기본 OFF — view 는 브릿지 사용.
            execute_values(cur,
                "UPDATE products AS p SET off_code = v.code "
                "FROM (VALUES %s) AS v(code, pid) WHERE p.product_id = v.pid",
                set_offcode, page_size=500)
        if to_conflict and not NO_CONFLICTS:
            execute_values(cur, """
                INSERT INTO nutrition_conflict_queue
                  (product_id, barcode, off_code, field, kfda_value, off_value, diff_pct)
                VALUES %s
            """, to_conflict, page_size=500)

        # ── 검증게이트 2: 원본↔통합 정합 + 칼로리 + resolved view ──
        cur.execute("SELECT count(*) FROM openfoodfacts_nutrition_norm")
        norm_total = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM openfoodfacts_nutrition_norm WHERE code NOT IN (SELECT code FROM openfoodfacts_raw)")
        orphan = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM openfoodfacts_nutrition_norm WHERE calories IS NOT NULL AND calories < 0")
        neg_cal = cur.fetchone()[0]
        # resolved view: 방금 적재한 결측제품이 브릿지(decision=load) 경유로 OFF 채워졌는지 표본 확인
        view_ok = True
        if to_norm:
            sample = [t[0] for t in to_norm[:20]]  # t[0]=code(=barcode)
            cur.execute("""SELECT count(*) FROM product_nutrition_resolved
                           WHERE barcode = ANY(%s) AND resolved_source='openfoodfacts'
                                 AND calories IS NOT NULL""", (sample,))
            view_hits = cur.fetchone()[0]
            view_ok = view_hits > 0

        print(f"  검증: norm총={norm_total:,} 고아(norm-raw누락)={orphan} 음수칼로리={neg_cal} "
              f"resolved표본채움={'OK' if view_ok else 'FAIL'}")
        if orphan != 0 or neg_cal != 0 or not view_ok:
            print("  ✗ 검증게이트 2 실패 → ROLLBACK", file=sys.stderr)
            conn.rollback(); conn.close(); sys.exit(1)

        conn.commit()
        print(f"  ✓ COMMIT 완료. 백업: off_*_bak_{stamp}")
    except Exception as e:
        conn.rollback()
        print(f"ERROR: 적재 실패 → ROLLBACK: {e}", file=sys.stderr)
        conn.close(); sys.exit(1)

    # ── 사후 분포 ──
    print("\n[6/6] 사후 분포")
    cur.execute("SELECT off_grade, count(*) FROM openfoodfacts_nutrition_norm GROUP BY 1 ORDER BY 1")
    for g, c in cur.fetchall():
        print(f"    grade {g}: {c:,}")
    cur.execute("SELECT basis_unit, count(*) FROM openfoodfacts_nutrition_norm GROUP BY 1 ORDER BY 2 DESC")
    for b, c in cur.fetchall():
        print(f"    basis {b}: {c:,}")
    cur.execute("SELECT count(*) FROM nutrition_conflict_queue WHERE status='pending'")
    print(f"    충돌큐(pending): {cur.fetchone()[0]:,}")
    cur.execute("SELECT decision, count(*) FROM openfoodfacts_product_match GROUP BY 1 ORDER BY 2 DESC")
    for d, c in cur.fetchall():
        print(f"    브릿지 {d}: {c:,}")
    cur.close(); conn.close()
    print(f"\n✓ 적재 완료 · {datetime.now().isoformat()}")
    print("  다음: nutritionTrafficLight.js 무회귀 테스트 → UI 배지(§11) Flutter 구현.")


if __name__ == "__main__":
    main()
