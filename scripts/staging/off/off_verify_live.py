# -*- coding: utf-8 -*-
r"""
off_verify_live.py — #2 OFF 통합 라이브 종합 검증(§11 전 게이트)
시나리오별 view 동작 + 카운트 정합 + (선택) production API 엔진출력 확인.
사용:
  $env:DATABASE_URL="postgresql://...PUBLIC..."
  python off_verify_live.py --api-url https://meokseon-server-production.up.railway.app
"""
import os, sys, getpass, json, urllib.request
try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2-binary 필요.", file=sys.stderr); sys.exit(1)

API = sys.argv[sys.argv.index("--api-url") + 1] if "--api-url" in sys.argv else None
P = 0; F = 0
def ok(name, cond, detail=""):
    global P, F
    P += bool(cond); F += (not cond)
    print(f"  [{'OK' if cond else 'XX'}] {name}{(' — ' + detail) if detail else ''}")


def get_db_url():
    u = os.environ.get('DATABASE_URL', '').strip()
    if u and 'railway.internal' not in u and u.startswith(('postgresql://', 'postgres://')):
        return u
    u = getpass.getpass("DATABASE_URL (PUBLIC): ").strip()
    if not u.startswith(('postgresql://', 'postgres://')) or 'railway.internal' in u:
        print("ERROR: PUBLIC URL 필요.", file=sys.stderr); sys.exit(1)
    return u


VIEW_Q = """SELECT resolved_source, off_grade, serving_size, calories, sodium, confidence, source_license, basis_confident
            FROM product_nutrition_resolved WHERE barcode=%s"""


def sample(cur, where, extra_join=""):
    cur.execute(f"""
        SELECT p.barcode FROM openfoodfacts_product_match m
        JOIN products p ON p.product_id=m.product_id
        JOIN openfoodfacts_nutrition_norm n ON n.code=m.code
        LEFT JOIN nutrition_data nd ON nd.product_id=p.product_id
        {extra_join}
        WHERE p.barcode IS NOT NULL AND {where} LIMIT 1""")
    r = cur.fetchone()
    return r[0] if r else None


def view_row(cur, bc):
    cur.execute(VIEW_Q, (bc,))
    r = cur.fetchone()
    cols = ["resolved_source", "off_grade", "serving_size", "calories", "sodium", "confidence", "source_license", "basis_confident"]
    return dict(zip(cols, r)) if r else None


def main():
    conn = psycopg2.connect(get_db_url()); cur = conn.cursor()

    print("=== 1) 카운트 정합 ===")
    cur.execute("SELECT off_grade, count(*) FROM openfoodfacts_nutrition_norm GROUP BY 1 ORDER BY 1")
    norm = dict(cur.fetchall()); print("  norm:", norm)
    cur.execute("SELECT decision, count(*) FROM openfoodfacts_product_match GROUP BY 1 ORDER BY 1")
    bridge = dict(cur.fetchall()); print("  bridge:", bridge)
    cur.execute("SELECT count(*) FROM product_nutrition_resolved WHERE resolved_source='openfoodfacts'")
    view_off = cur.fetchone()[0]; print("  view 노출 OFF(resolved_source=openfoodfacts):", view_off)
    ab = norm.get('A', 0) + norm.get('B', 0)
    ok("view 노출 OFF ≈ norm A+B (C/Reject 제외)", view_off == ab, f"view={view_off} A+B={ab}")
    ok("norm = bridge load", sum(norm.values()) == bridge.get('load', 0), f"norm={sum(norm.values())} load={bridge.get('load')}")

    print("\n=== 2) 시나리오별 view 동작 ===")
    # 2a) OFF A/B confident(g/mL)
    bc = sample(cur, "m.decision='load' AND n.off_grade IN ('A','B') AND n.basis_unit IN ('g','mL') AND nd.nutrition_id IS NULL")
    print(f"  [2a OFF A/B confident] barcode={bc}")
    if bc:
        v = view_row(cur, bc); print("     ", v)
        ok("2a resolved_source=openfoodfacts", v["resolved_source"] == "openfoodfacts")
        ok("2a off_grade∈A/B", v["off_grade"] in ("A", "B"))
        ok("2a serving 마커 100g/100ml", v["serving_size"] in ("100g", "100ml"))
        ok("2a confidence=low·ODbL", v["confidence"] == "low" and v["source_license"] == "ODbL-1.0")
        ok("2a calories not null", v["calories"] is not None)

    # 2b) OFF basis unknown → '100unknown'
    bc_u = sample(cur, "m.decision='load' AND n.off_grade='B' AND n.basis_unit='unknown' AND nd.nutrition_id IS NULL")
    print(f"  [2b OFF basis unknown] barcode={bc_u}")
    if bc_u:
        v = view_row(cur, bc_u); print("     ", v)
        ok("2b resolved_source=openfoodfacts", v["resolved_source"] == "openfoodfacts")
        ok("2b serving 마커 '100unknown'", v["serving_size"] == "100unknown")
    else:
        print("     (unknown-basis 노출 샘플 없음 — A는 confident만, B중 unknown 없을 수 있음)")

    # 2c) OFF C → view 미노출
    bc_c = sample(cur, "m.decision='load' AND n.off_grade='C' AND nd.nutrition_id IS NULL")
    print(f"  [2c OFF C 제외] barcode={bc_c}")
    if bc_c:
        v = view_row(cur, bc_c); print("     ", v)
        ok("2c C는 view 미노출(resolved_source NULL)", v["resolved_source"] is None)
        ok("2c calories NULL(결합 제외)", v["calories"] is None)

    # 2d) 충돌(nd + OFF) → 식약처 우선(미덮어쓰기). conflict 는 norm 행이 없으므로 norm 조인 없이 샘플.
    cur.execute("""SELECT p.barcode FROM openfoodfacts_product_match m
                   JOIN products p ON p.product_id=m.product_id
                   WHERE m.decision='conflict' AND p.barcode IS NOT NULL LIMIT 1""")
    bc_x = (cur.fetchone() or [None])[0]
    print(f"  [2d 충돌→식약처 우선] barcode={bc_x}")
    if bc_x:
        v = view_row(cur, bc_x); print("     ", v)
        ok("2d resolved_source≠openfoodfacts(식약처/OCR)", v["resolved_source"] != "openfoodfacts")
        ok("2d off_grade NULL(OFF 미사용)", v["off_grade"] is None)

    cur.close(); conn.close()

    # 3) production API 엔진출력
    if API:
        print("\n=== 3) production API 엔진출력 ===")
        def fetch(bc):
            with urllib.request.urlopen(f"{API.rstrip('/')}/api/products/{bc}", timeout=15) as r:
                return json.loads(r.read())
        if bc:
            d = fetch(bc)["data"]; n = d["nutrition"]; tl = d["traffic_light"]["nutrients"]
            ok("3a API OFF source=openfoodfacts", n["source"] == "openfoodfacts")
            ok("3a API 신호등 산출됨", any(v.get("color") for v in tl.values()))
        if bc_u:
            tl = fetch(bc_u)["data"]["traffic_light"]["nutrients"]
            negs = [k for k in ("sodium", "sugars", "sat_fat", "total_fat") if tl.get(k, {}).get("data") == "present"]
            if negs:
                k = negs[0]
                ok(f"3b API unknown: {k} 절대량 스킵(per_100 null)·%DV 존재",
                   tl[k].get("per_100") is None and tl[k].get("pct_dv") is not None,
                   f"per_100={tl[k].get('per_100')} pct_dv={tl[k].get('pct_dv')}")

    print(f"\n=== 검증 결과: {P} passed, {F} failed ===")
    print("ALL GREEN ✅ — §11 진행 가능" if F == 0 else "✗ 실패 항목 점검 필요")
    sys.exit(1 if F else 0)


if __name__ == "__main__":
    main()
