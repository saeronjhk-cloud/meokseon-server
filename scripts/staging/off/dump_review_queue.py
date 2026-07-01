# -*- coding: utf-8 -*-
r"""
dump_review_queue.py — v2.3 'review' 후보 수동 판단 큐 (풍부한 데이터)
SOURCE: D:\먹선\IP\off_identity_gate_v2.md (review = 사람이 accept/폐기 판단할 내부 큐)

WHY: v2.3에서 '이름이 유사하나 동일 확정 불가'는 전부 review. 이걸 이름만으론 사람도 못 가린다(Maxim 슈프림골드↔Maxim Coffee).
     → 우리정보 + OFF 전체명·영양수치·용량·원산지 + OFF 제품페이지 링크 를 한 행에 모아 사람이 판단.
     판단: human_verdict 칸에 accept(=같은제품 확정) / reject(=폐기, 확정불가/다름) 기입.

사용(제이 PC):
  cd D:\먹선\meokseon-server\scripts\staging\off
  $env:DATABASE_URL="<Railway DATABASE_PUBLIC_URL 전체>"
  python dump_review_queue.py --limit 300
  → D:\먹선\eval_set\off_review_queue.csv  (우선순위 정렬: specific→name_sim→brand→generic→…)

판단법: off_url 링크를 열어 실제 OFF 제품(이미지·원재료·전체명) 확인 + 영양수치가 우리 제품 기대치와 맞는지.
        같은 제품 확정 → human_verdict=accept / 확정 불가하거나 다른 제품 → reject(폐기).
"""
import os, sys, csv, getpass, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import off_load_railway as L
import off_normalize as off
import off_identity_v2 as v2

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2-binary 필요.", file=sys.stderr); sys.exit(1)

PARQUET = os.path.join(os.path.expanduser("~/off_work"), "korea_off.parquet").replace("\\", "/")
OUT = r"D:\먹선\eval_set\off_review_queue.csv"
# 판단 우선순위(같은 제품일 확률·검증가치 높은 순)
PRIORITY = ["specific_only", "name_sim_only", "brand_only", "generic_only",
            "global_brand", "category_only", "other", "880_english_only", "variant_conflict"]


def get_db_url():
    u = os.environ.get('DATABASE_URL', '').strip()
    if u and 'railway.internal' not in u and u.startswith(('postgresql://', 'postgres://')):
        return u
    u = getpass.getpass("DATABASE_URL (PUBLIC): ").strip()
    if not u.startswith(('postgresql://', 'postgres://')) or 'railway.internal' in u:
        print("ERROR: PUBLIC URL 필요.", file=sys.stderr); sys.exit(1)
    return u


def stratum_of(s, our_brand, off_name, barcode):
    if s.foreign:
        return "foreign"
    if s.variant_conflict or s.variant_one_sided:
        return "variant_conflict"
    if s.specific_match and not s.brand_match:
        return "specific_only"
    if s.name_sim >= 0.70 and not (s.brand_match or s.specific_match or s.generic_match):
        return "name_sim_only"
    only_brand = s.brand_match and not s.specific_match and not s.generic_match
    if only_brand:
        return "brand_only"
    if s.generic_match and not s.brand_match:
        return "generic_only"
    if s.category_agree and not (s.brand_match or s.specific_match or s.generic_match):
        return "category_only"
    if not (our_brand or "").strip():
        return "other"
    return "other"


def num(x):
    return "" if x is None else round(x, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=300, help="최대 출력 행(우선순위 상위부터)")
    args = ap.parse_args()

    off_by_code = L.load_off(PARQUET)
    conn = psycopg2.connect(get_db_url()); cur = conn.cursor()
    cur.execute("""
        SELECT p.barcode, p.product_name, p.brand, p.manufacturer, p.food_category::text, p.food_type
        FROM products p WHERE p.is_active AND p.barcode = ANY(%s)
    """, (list(off_by_code.keys()),))
    cols = [d[0] for d in cur.description]
    prods = [dict(zip(cols, r)) for r in cur.fetchall()]
    cur.close(); conn.close()

    rows = []
    for p in prods:
        orow = off_by_code.get(str(p["barcode"]))
        if not orow:
            continue
        flat = L.flatten(orow)
        off_name = L.pname(orow.get("product_name"))
        off_brands = orow.get("brands") or ""
        off_cat = flat["categories_tags_str"]
        off_countries = orow.get("countries_tags") or []
        off_qty = flat.get("quantity")
        our_name = p["product_name"] or ""
        our_brand = p.get("brand") or p.get("manufacturer") or ""
        our_cat = " ".join(x for x in [p.get("food_type"), p.get("food_category")] if x)

        verdict = v2.identity_check_v2(our_name, our_brand, our_cat, off_name, off_brands,
                                      off_cat, off_countries, str(p["barcode"]), None, off_qty)
        if verdict != "review":
            continue
        s = v2.extract_signals(our_name, our_brand, our_cat, off_name, off_brands,
                              off_cat, off_countries, str(p["barcode"]), None, off_qty)
        st = stratum_of(s, our_brand, off_name, p["barcode"])
        try:
            n, _ = off.normalize_off(flat)
        except Exception:
            n = {}
        rows.append(dict(
            stratum=st, barcode=p["barcode"], our_name=our_name, our_brand=our_brand, our_cat=our_cat,
            off_name=off_name, off_brands=off_brands, off_cat=off_cat[:50],
            off_countries=";".join(off_countries) if isinstance(off_countries, list) else off_countries,
            off_qty=off_qty,
            off_kcal=num(n.get("calories")), off_sodium_mg=num(n.get("sodium_mg")),
            off_sugars=num(n.get("total_sugars")), off_protein=num(n.get("protein")),
            off_fat=num(n.get("total_fat")), off_carbs=num(n.get("total_carbs")),
            off_url=f"https://world.openfoodfacts.org/product/{p['barcode']}",
            human_verdict="", note=""))

    rows.sort(key=lambda r: (PRIORITY.index(r["stratum"]) if r["stratum"] in PRIORITY else 99, r["barcode"]))
    rows = rows[:args.limit]

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)
    print(f"review 후보 {len(rows)}건(우선순위 상위) → {OUT}")
    print("판단: off_url 열어 실제 제품 확인 + 영양수치 대조 → human_verdict=accept(같은제품) / reject(폐기).")


if __name__ == "__main__":
    main()
