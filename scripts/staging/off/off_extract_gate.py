# -*- coding: utf-8 -*-
r"""
off_extract_gate.py - OFF 한국 제품 원격 추출(파일리스) + 게이트 eval (DB 미적재)
SOURCE: D:/먹선/IP/off_integration_v1.md §4~§6
run: cd D:\먹선\meokseon-server\scripts\staging\off ; python off_extract_gate.py
- 7GB 다운로드 없이 HF 원격 parquet에서 한국 제품만 추출 → ~/off_work 캐시(McAfee 회피)
- nested nutriments -> 평면 변환 -> off_normalize 게이트 적용
- 결과 리포트만 출력(DB 미적재). 이 리포트로 eval 통과 확인 후 적재 단계로.
"""
import os, json
import duckdb
import off_normalize as off

URL = "https://huggingface.co/datasets/openfoodfacts/product-database/resolve/main/food.parquet"
CACHE_DIR = os.path.expanduser("~/off_work")
os.makedirs(CACHE_DIR, exist_ok=True)
CACHE = os.path.join(CACHE_DIR, "korea_off.parquet").replace("\\", "/")

LOCAL_SRC = os.path.join(CACHE_DIR, "food.parquet").replace("\\", "/")

con = duckdb.connect()
con.execute("SET enable_progress_bar=true;")

COLS = ("code, product_name, brands, countries_tags, categories_tags, "
        "nutriments, nutrition_data_per, serving_size, quantity, "
        "no_nutrition_data, last_modified_t")

def _cache_valid(path):
    """캐시가 존재 + 충분 크기 + parquet 로 열리는지. (손상/미완성 캐시 자동 감지)"""
    try:
        if not os.path.exists(path) or os.path.getsize(path) < 1024:
            return False
        duckdb.connect().execute(f"SELECT 1 FROM read_parquet('{path}') LIMIT 1").fetchone()
        return True
    except Exception:
        return False


if not _cache_valid(CACHE):
    if os.path.exists(CACHE):
        print(f"[1] 캐시 손상/미완성 감지 → 삭제 후 재추출: {CACHE} "
              f"({os.path.getsize(CACHE):,} bytes)")
        os.remove(CACHE)
    where = ("code LIKE '880%' OR "
             "len(list_filter(countries_tags, x -> lower(x) LIKE '%korea%')) > 0")
    if os.path.exists(LOCAL_SRC):
        print(f"[1] 로컬 원본에서 한국 제품 추출 (빠름)\n    src={LOCAL_SRC}")
        src = f"'{LOCAL_SRC}'"
    else:
        print("[1] ERROR: 유효한 캐시도, 로컬 원본(food.parquet)도 없습니다.\n"
              f"    food.parquet 기대 위치: {LOCAL_SRC}\n"
              "    → 먼저 D:\\먹선\\off\\run_download.bat 실행해 food.parquet 다운로드 후 재실행.\n"
              "    (원격 직접 추출은 7GB 스캔 429 위험으로 비권장.)")
        raise SystemExit(1)
    con.execute(f"COPY (SELECT {COLS} FROM read_parquet({src}) WHERE {where}) "
                f"TO '{CACHE}' (FORMAT PARQUET)")
    print(f"[1] 재추출 완료: {CACHE} ({os.path.getsize(CACHE):,} bytes)")
else:
    print(f"[1] 캐시 사용: {CACHE} ({os.path.getsize(CACHE):,} bytes)")

rows = con.execute(f"SELECT {COLS} FROM read_parquet('{CACHE}')").fetchall()
keys = [c.strip() for c in COLS.split(",")]
data = [dict(zip(keys, r)) for r in rows]
print(f"[2] 한국 제품 {len(data):,}건 로드")

# nested nutriments -> 평면(_100g)
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


# 게이트 적용 (identity는 적재 단계에서 우리 products와 매칭 시 판정 → 여기선 accept)
from collections import Counter
grades = Counter()
basis = Counter()
reject_reasons = Counter()
basis_unconf = 0   # A/B/C 중 basis_confident=False
graded = []
for row in data:
    flat = flatten(row)
    n, (sg, salt) = off.normalize_off(flat)
    g, info = off.quality_grade(n, sg, salt, identity="accept")
    grades[g] += 1
    if g in ("A", "B", "C"):
        basis[n["basis_unit"]] += 1
        if not n.get("basis_confident", True):
            basis_unconf += 1
    if g == "Reject":
        for r in info.get("reasons", []):
            reject_reasons[r.split(":")[0]] += 1
    graded.append((row, n, g, info))

print("\n=== 3) 등급 분포 (identity=accept 가정) ===")
for k in ("A", "B", "C", "Reject"):
    print(f"  {k}: {grades.get(k,0):,}")
print(f"  no_nutrition_data=True: {sum(1 for d in data if d.get('no_nutrition_data')):,}")

print("\n=== 4) basis_unit 분포 (A/B/C) ===")
abc = sum(grades.get(k, 0) for k in ("A", "B", "C"))
for k, v in basis.most_common():
    print(f"  {k}: {v:,}")
print(f"  basis_confident=False (A/B/C 중): {basis_unconf:,} "
      f"({(basis_unconf/abc*100 if abc else 0):.1f}%)  ← 신호등 절대량 차단 대상")

print("\n=== 4b) Reject 사유 분포 ===")
for k, v in reject_reasons.most_common():
    print(f"  {k}: {v:,}")
print(f"  (sodium_salt_conflict 건수 = {reject_reasons.get('sodium_salt_conflict', 0):,})")


def show(row, n, g):
    print(f"  [{g}] {row['code']} | {pname(row['product_name'])[:40]} | "
          f"kcal={n['calories']} prot={n['protein']} fat={n['total_fat']} "
          f"carb={n['total_carbs']} sugar={n['total_sugars']} "
          f"Na(mg)={n['sodium_mg']} basis={n['basis_unit']}")


print("\n=== 5) 골든셋(이름 검색) ===")
targets = ["신라면", "코카콜라", "coca", "새우깡", "박카스", "초코파이"]
for t in targets:
    hit = [(r, n, g) for (r, n, g, i) in graded if t.lower() in pname(r["product_name"]).lower()]
    print(f"\n  '{t}' {len(hit)}건:")
    for r, n, g in hit[:3]:
        show(r, n, g)

print("\n=== 6) A등급 샘플 8건 ===")
cnt = 0
for r, n, g, i in graded:
    if g == "A":
        show(r, n, g)
        cnt += 1
        if cnt >= 8:
            break

print("\n[eval 완료] 위 3~6 출력을 붙여넣어 주세요. 게이트 타당성 확인 후 적재 단계로 갑니다.")
