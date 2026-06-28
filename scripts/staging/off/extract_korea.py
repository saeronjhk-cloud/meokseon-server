"""
extract_korea.py — OFF 덤프에서 한국 제품만 추출 (덤프 도착 후 실행)
SOURCE: D:\\먹선\\IP\\off_integration_v1.md §4
입력: D:\\먹선\\off\\food.parquet  (또는 --jsonl 로 openfoodfacts-products.jsonl.gz)
출력: D:\\먹선\\off\\korea_off.parquet  (880 OR countries=korea, 필요 영양컬럼)

1단계: 스키마 자동 점검(필요 영양필드 존재 확인 — parquet simplified 누락 대비)
2단계: 한국 제품 필터 추출
3단계: (다음 단계) off_normalize 게이트 → openfoodfacts_nutrition_norm 적재

실행: python3 extract_korea.py            # parquet
      python3 extract_korea.py --schema   # 스키마만 점검
"""
import sys
import duckdb

OFF_DIR = r"/sessions/stoic-wonderful-cori/mnt/먹선/off"  # bash 마운트 경로
PARQUET = f"{OFF_DIR}/food.parquet"
OUT = f"{OFF_DIR}/korea_off.parquet"

# 필요 영양필드(§5). parquet은 nutriments가 struct/list일 수 있어 실제 스키마로 보정 필요.
NEEDED = [
    "code", "product_name", "brands", "countries_tags", "categories_tags",
    "nutrition_data_per", "serving_size", "quantity",
    "energy-kcal_100g", "energy_100g", "proteins_100g", "fat_100g",
    "saturated-fat_100g", "trans-fat_100g", "carbohydrates_100g",
    "sugars_100g", "fiber_100g", "sodium_100g", "salt_100g", "cholesterol_100g",
    "last_modified_t",
]


def schema(con):
    cols = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{PARQUET}')").fetchall()
    names = [c[0] for c in cols]
    print(f"[schema] {len(names)} columns")
    for c in cols:
        print("  ", c[0], c[1])
    missing = [n for n in NEEDED if n not in names]
    print("\n[schema] 필요필드 중 직접 매칭 안 되는 것:", missing)
    print("[schema] ↑ nutriments가 nested(struct/list)면 위 필드는 nutriments 안에 있음 → 추출쿼리에서 unnest/dot 접근 필요. 실제 스키마 보고 보정.")
    return names


def extract(con):
    # 한국 제품: 바코드 880 시작 OR countries_tags 에 korea
    # countries_tags 가 LIST 면 list_contains, VARCHAR 면 LIKE — 스키마 따라 택1.
    q = f"""
    COPY (
      SELECT *
      FROM read_parquet('{PARQUET}')
      WHERE code LIKE '880%'
         OR lower(CAST(countries_tags AS VARCHAR)) LIKE '%korea%'
    ) TO '{OUT}' (FORMAT PARQUET);
    """
    con.execute(q)
    n = con.execute(f"SELECT count(*) FROM read_parquet('{OUT}')").fetchone()[0]
    print(f"[extract] 한국 제품 {n:,} rows -> {OUT}")


if __name__ == "__main__":
    con = duckdb.connect()
    print("=== OFF 한국 제품 추출 ===")
    names = schema(con)
    if "--schema" in sys.argv:
        sys.exit(0)
    extract(con)
    print("[done] 다음: off_normalize 게이트 적용 → DB 적재(검증게이트 통과 후 COMMIT).")
