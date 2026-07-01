# -*- coding: utf-8 -*-
r"""
off_v2_impact.py — v2.3 적용 시 영향 dry-run (DB read-only, 미변경)
SOURCE: D:\먹선\IP\off_identity_gate_v2.md

WHY: 실제 적재 전에 "v2.3 + 제이 수동결정으로 분류하면 어떻게 되나"를 미리 봄.
     load(신호등 노출)/hold_review(미노출)/skip 분포 + 현재 라이브(v1) 대비 변화 + 미리보기 CSV.
     ⚠ DB에 아무것도 쓰지 않음(SELECT만). 실제 적재는 별도(백업·BEGIN·rollback).

사용(제이 PC):
  $env:DATABASE_URL="<PUBLIC>"
  python off_v2_impact.py
  → 콘솔 분포 + D:\먹선\eval_set\off_v2_impact_preview.csv (load/conflict 대상 미리보기)
"""
import os, sys, csv, getpass, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import off_load_railway as L
import off_classify_v2 as C

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2-binary 필요.", file=sys.stderr); sys.exit(1)

PARQUET = os.path.join(os.path.expanduser("~/off_work"), "korea_off.parquet").replace("\\", "/")
OUT = r"D:\먹선\eval_set\off_v2_impact_preview.csv"


def get_db_url():
    u = os.environ.get('DATABASE_URL', '').strip()
    if u and 'railway.internal' not in u and u.startswith(('postgresql://', 'postgres://')):
        return u
    u = getpass.getpass("DATABASE_URL (PUBLIC): ").strip()
    if not u.startswith(('postgresql://', 'postgres://')) or 'railway.internal' in u:
        print("ERROR: PUBLIC URL 필요.", file=sys.stderr); sys.exit(1)
    return u


def main():
    off_by_code = L.load_off(PARQUET)
    manual = C.load_manual()
    print(f"[i] 수동결정 {len(manual)}건 로드 (accept {sum(v=='accept' for v in manual.values())} / reject {sum(v=='reject' for v in manual.values())})")

    conn = psycopg2.connect(get_db_url()); cur = conn.cursor()
    cur.execute("""
        SELECT p.barcode, p.product_name, p.brand, p.manufacturer, p.food_category::text, p.food_type,
               EXISTS(SELECT 1 FROM nutrition_data nd WHERE nd.product_id=p.product_id) AS has_nutr
        FROM products p WHERE p.is_active AND p.barcode = ANY(%s)
    """, (list(off_by_code.keys()),))
    cols = [d[0] for d in cur.description]
    prods = [dict(zip(cols, r)) for r in cur.fetchall()]
    cur.close(); conn.close()

    dist = collections.Counter()
    src = collections.Counter()
    preview = []
    for p in prods:
        orow = off_by_code.get(str(p["barcode"]))
        if not orow:
            continue
        r = C.classify_match_v2(p, orow, manual)
        dist[r["decision"]] += 1
        src[r["identity_src"]] += 1
        if r["decision"] in ("load", "conflict"):
            preview.append(dict(
                decision=r["decision"], identity_src=r["identity_src"], barcode=p["barcode"],
                our_name=p["product_name"], off_name=r["off_name"], grade=r["grade"],
                off_kcal=r["n"].get("calories"), off_sodium_mg=r["n"].get("sodium_mg")))

    total = sum(dist.values())
    print(f"\n=== v2.3 적용 시 분류 ({total:,} 매칭) ===")
    for k in ("load", "conflict", "hold_review", "skip_identity", "skip_reject"):
        print(f"  {k:14} {dist.get(k,0):6,}")
    print(f"  (정체성 판정 출처: auto {src.get('auto',0):,} / manual {src.get('manual',0):,})")
    print(f"\n※ 참고 라이브(v1): load 332 · 노출 185. v2.3 load = 신호등 노출 대상(accept+결측).")
    print(f"※ hold_review = 사용자 미노출(수동 큐). 제이 태깅 accept 늘수록 load 증가.")

    if preview:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=list(preview[0].keys()))
            w.writeheader(); w.writerows(preview)
        print(f"\nload/conflict 미리보기 {len(preview)}건 → {OUT}")
    print("\n⚠ DB 미변경(SELECT만). 실제 적재는 off_load_railway v2 배선 + 백업·BEGIN·rollback으로.")


if __name__ == "__main__":
    main()
