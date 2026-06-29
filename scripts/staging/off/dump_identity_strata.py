# -*- coding: utf-8 -*-
r"""
dump_identity_strata.py — v2.1 정체성 게이트 실덤프 '신호유형별 층화 샘플' 추출 (3단계 grounding)
SOURCE: D:\먹선\IP\off_identity_gate_v2.md §7 (eval grounding, false-accept=0)

WHY: 합성 21건은 로직 검증용. production 전 실 OFF matched subset에서 신호유형별 층화 샘플을 뽑아
     사람이 정답 태깅 → 그 셋에서도 false-accept=0 확인해야 적재 진입.
     무작위 샘플은 rare risk(브랜드단독·카테고리단독·name_sim단독)를 놓침 → 층화 필수.

사용(제이 PC):
  cd D:\먹선\meokseon-server\scripts\staging\off
  $env:DATABASE_URL="postgresql://...PUBLIC..."   # hopper.proxy.rlwy.net 등 PUBLIC
  python dump_identity_strata.py --per 12
  → 출력: D:\먹선\eval_set\off_identity_strata_sample.csv  (human_verdict/note 칸 비움 → 태깅용)

태깅 후: human_verdict(accept/review/reject) 채워서 Claude에게 전달 → eval에 실 케이스 편입, false-accept 검증.
"""
import os, sys, csv, getpass, argparse, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import off_load_railway as L
import off_identity_v2 as v2

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2-binary 필요.", file=sys.stderr); sys.exit(1)

PARQUET = os.path.join(os.path.expanduser("~/off_work"), "korea_off.parquet").replace("\\", "/")
OUT = r"D:\먹선\eval_set\off_identity_strata_sample.csv"
GLOBAL_BRANDS = ["코카콜라", "펩시", "오레오", "스팸", "프링글스", "켈로그", "네슬레"]


def get_db_url():
    u = os.environ.get('DATABASE_URL', '').strip()
    if u and 'railway.internal' not in u and u.startswith(('postgresql://', 'postgres://')):
        return u
    u = getpass.getpass("DATABASE_URL (PUBLIC): ").strip()
    if not u.startswith(('postgresql://', 'postgres://')) or 'railway.internal' in u:
        print("ERROR: PUBLIC URL 필요.", file=sys.stderr); sys.exit(1)
    return u


def classify_stratum(s, our_brand, off_name, barcode):
    """신호유형별 stratum. false-accept 위험 큰 단독신호를 우선 라벨."""
    if s.foreign:
        return "foreign"
    if s.variant_conflict:
        return "variant_conflict"
    if s.qty in ("review", "hard"):
        return "quantity_mismatch"
    only_brand = s.brand_match and not s.specific_match and not s.generic_match
    if only_brand and not s.category_agree:
        return "brand_only"
    if s.specific_match and not s.brand_match:
        return "specific_only"
    if s.generic_match and not s.brand_match and not s.specific_match:
        return "generic_only"
    if s.category_agree and not (s.brand_match or s.specific_match or s.generic_match):
        return "category_only"
    if s.name_sim >= 0.70 and not (s.brand_match or s.specific_match or s.generic_match):
        return "name_sim_only"
    if not (our_brand or "").strip():
        return "brand_blank"
    if str(barcode).startswith("880") and not v2._norm(off_name).encode("ascii", "ignore").decode() == "" \
            and not any("가" <= ch <= "힣" for ch in (off_name or "")):
        return "880_english_only"
    return "other"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per", type=int, default=12, help="stratum당 최대 표본 수")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()
    random.seed(args.seed)

    off_by_code = L.load_off(PARQUET)
    conn = psycopg2.connect(get_db_url()); cur = conn.cursor()
    cur.execute("""
        SELECT p.barcode, p.product_name, p.brand, p.manufacturer,
               p.food_category::text, p.food_type
        FROM products p
        WHERE p.is_active AND p.barcode = ANY(%s)
    """, (list(off_by_code.keys()),))
    cols = [d[0] for d in cur.description]
    prods = [dict(zip(cols, r)) for r in cur.fetchall()]
    cur.close(); conn.close()

    strata = {}
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

        s = v2.extract_signals(our_name, our_brand, our_cat, off_name, off_brands,
                              off_cat, off_countries, str(p["barcode"]), None, off_qty)
        verdict = v2.identity_check_v2(our_name, our_brand, our_cat, off_name, off_brands,
                                      off_cat, off_countries, str(p["barcode"]), None, off_qty)
        st = classify_stratum(s, our_brand, off_name, p["barcode"])
        if any(g in our_name for g in GLOBAL_BRANDS):
            st = "global_brand"
        strata.setdefault(st, []).append(dict(
            stratum=st, barcode=p["barcode"], our_name=our_name, our_brand=our_brand, our_cat=our_cat,
            off_name=off_name, off_brands=off_brands, off_cat=off_cat[:60],
            off_countries=";".join(off_countries) if isinstance(off_countries, list) else off_countries,
            off_qty=off_qty,
            brand=s.brand_match, spec=s.specific_match, gen=s.generic_match, cat_agree=s.category_agree,
            name_sim=round(s.name_sim, 2), variant=s.variant_conflict, foreign=s.foreign,
            v2_verdict=verdict, human_verdict="", note=""))

    rows = []
    print("=== stratum 분포 (전체 / 추출) ===")
    for st in sorted(strata):
        pool = strata[st]
        pick = random.sample(pool, min(args.per, len(pool)))
        print(f"  {st:18} 전체 {len(pool):5} → 추출 {len(pick)}")
        rows.extend(pick)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)
    print(f"\n총 {len(rows)}건 → {OUT}")
    print("다음: human_verdict(accept/review/reject) 칸 태깅 후 Claude에게 전달 → eval 편입·false-accept 검증.")


if __name__ == "__main__":
    main()
