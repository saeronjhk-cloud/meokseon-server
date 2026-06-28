# -*- coding: utf-8 -*-
r"""
off_identity_diag.py — 정체성 게이트 거부 원인 진단(데이터 기반)
WHY: dry-run 에서 identity_reject 가 과도(신라면까지 reject) → 실제 우리제품 vs OFF 필드와
     identity_check 내부 신호(cat/brand_match/name_sim/foreign)를 출력해 근본원인 확인.
사용:
  $env:DATABASE_URL="postgresql://...PUBLIC..."
  python off_identity_diag.py
"""
import os, sys, getpass
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import off_normalize as off
import off_load_railway as L

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2-binary 필요.", file=sys.stderr); sys.exit(1)

PARQUET = os.path.join(os.path.expanduser("~/off_work"), "korea_off.parquet").replace("\\", "/")


def get_db_url():
    u = os.environ.get('DATABASE_URL', '').strip()
    if u and 'railway.internal' not in u and u.startswith(('postgresql://', 'postgres://')):
        return u
    u = getpass.getpass("DATABASE_URL (PUBLIC): ").strip()
    if not u.startswith(('postgresql://', 'postgres://')) or 'railway.internal' in u:
        print("ERROR: PUBLIC URL 필요.", file=sys.stderr); sys.exit(1)
    return u


def signals(p, orow):
    flat = L.flatten(orow)
    off_name = L.pname(orow.get("product_name"))
    off_brands = orow.get("brands") or ""
    off_cat = flat["categories_tags_str"]
    off_countries = orow.get("countries_tags") or []
    our_name = p["product_name"] or ""
    our_brand = p.get("brand") or p.get("manufacturer") or ""
    our_cat = " ".join(x for x in [p.get("food_type"), p.get("food_category")] if x)
    cat_our = off._major_cat(our_cat, our_name)
    cat_off = off._major_cat(off_cat, off_name)
    bm = off._brand_match(our_brand, off_brands, off_name)
    sim = round(off._jaccard(our_name, off_name), 3)
    countries = off._norm(" ".join(off_countries) if isinstance(off_countries, list) else str(off_countries))
    is_korea = any(k in countries for k in ("korea", "southkorea", "대한민국", "한국")) or str(p["barcode"]).startswith("880")
    foreign = bool(countries) and not is_korea
    ident = off.identity_check(our_name, our_brand, our_cat, off_name, off_brands, off_cat, off_countries, str(p["barcode"]))
    return dict(off_name=off_name, off_brands=off_brands, our_name=our_name, our_brand=our_brand,
                our_cat=our_cat, cat_our=cat_our, cat_off=cat_off, brand_match=bm, name_sim=sim,
                foreign=foreign, identity=ident)


def show(tag, p, s):
    print(f"\n[{tag}] barcode={p['barcode']}  → identity={s['identity']}")
    print(f"   우리: name='{s['our_name'][:35]}' brand='{s['our_brand']}' cat='{s['our_cat']}'")
    print(f"   OFF : name='{s['off_name'][:35]}' brands='{s['off_brands'][:25]}'")
    print(f"   신호: cat_our={s['cat_our']} cat_off={s['cat_off']} brand_match={s['brand_match']} "
          f"name_sim={s['name_sim']} foreign={s['foreign']}")


def main():
    off_by_code = L.load_off(PARQUET)
    conn = psycopg2.connect(get_db_url()); cur = conn.cursor()
    cur.execute("""
        SELECT p.product_id, p.barcode, p.product_name, p.brand, p.manufacturer,
               p.food_category::text, p.food_type, (nd.nutrition_id IS NOT NULL) AS has_nutr
        FROM products p
        LEFT JOIN LATERAL (SELECT nutrition_id FROM nutrition_data WHERE product_id=p.product_id LIMIT 1) nd ON TRUE
        WHERE p.is_active AND p.barcode = ANY(%s)
    """, (list(off_by_code.keys()),))
    cols = [d[0] for d in cur.description]
    prods = [dict(zip(cols, r)) for r in cur.fetchall()]
    cur.close(); conn.close()

    rejects, brand_fail_korea, cat_conflict, foreign_rej = [], 0, 0, 0
    golden_done = set()
    for p in prods:
        orow = off_by_code.get(str(p["barcode"]))
        if not orow:
            continue
        s = signals(p, orow)
        # 골든셋
        for t in ("신라면", "코카콜라", "새우깡", "박카스"):
            if t in (p["product_name"] or "") and t not in golden_done:
                show(f"골든:{t}", p, s); golden_done.add(t)
        if s["identity"] == "reject":
            rejects.append((p, s))
            if s["cat_our"] and s["cat_off"] and s["cat_our"] != s["cat_off"]:
                cat_conflict += 1
            elif s["foreign"] and not s["brand_match"] and s["name_sim"] < 0.45:
                foreign_rej += 1
            elif not s["brand_match"] and s["name_sim"] < 0.45:
                brand_fail_korea += 1

    print(f"\n=== reject 원인 요약 (총 reject {len(rejects):,}) ===")
    print(f"  카테고리 충돌: {cat_conflict:,}")
    print(f"  외국제품+무관: {foreign_rej:,}")
    print(f"  브랜드불일치+이름유사도<0.45(국내추정): {brand_fail_korea:,}  ← 과도거부 의심 핵심")
    print("\n=== reject 표본 15건 ===")
    for p, s in rejects[:15]:
        show("reject", p, s)


if __name__ == "__main__":
    main()
