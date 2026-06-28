# -*- coding: utf-8 -*-
"""
off_smoke_test.py — OFF 적재 직후 post-flight 검증 (런북 4단계)
SOURCE: 자문 reconcile 런북 (Gemini·ChatGPT 합의 post-flight)
검증: ①식약처 미덮어쓰기 ②OFF fallback 출처/confidence/ODbL ③basis unknown → 신호등 절대량 차단(serving NULL)
      ④(선택) /api/health·/ready 응답
사용:
  $env:DATABASE_URL="postgresql://...PUBLIC..."
  python meokseon-server/scripts/staging/off/off_smoke_test.py
  python meokseon-server/scripts/staging/off/off_smoke_test.py --api-url https://meokseon-server-production.up.railway.app
"""
import os, sys, getpass

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2-binary 필요. py -m pip install psycopg2-binary", file=sys.stderr); sys.exit(1)

API_URL = sys.argv[sys.argv.index("--api-url") + 1] if "--api-url" in sys.argv else None
P, F = 0, 0


def chk(name, cond, detail=""):
    global P, F
    P += bool(cond); F += (not cond)
    print(f"  [{'OK' if cond else 'XX'}] {name}{(' — ' + detail) if detail else ''}")


def get_db_url():
    url = os.environ.get('DATABASE_URL', '').strip()
    if url and 'railway.internal' not in url and url.startswith(('postgresql://', 'postgres://')):
        return url
    url = getpass.getpass("DATABASE_URL (PUBLIC): ").strip()
    if not url.startswith(('postgresql://', 'postgres://')) or 'railway.internal' in url:
        print("ERROR: PUBLIC postgresql:// URL 필요.", file=sys.stderr); sys.exit(1)
    return url


def main():
    conn = psycopg2.connect(get_db_url())
    cur = conn.cursor()

    # 0) 적재 존재 여부
    cur.execute("SELECT count(*) FROM openfoodfacts_nutrition_norm")
    norm = cur.fetchone()[0]
    cur.execute("SELECT count(*) FROM openfoodfacts_product_match WHERE decision='load'")
    loaded = cur.fetchone()[0]
    print(f"[0] norm={norm:,} | 브릿지 load={loaded:,}")
    chk("적재 데이터 존재", norm > 0 and loaded > 0)

    # 1) 식약처 미덮어쓰기: conflict(영양보유+OFF매칭) 제품은 OFF 가 아닌 식약처/OCR 로 노출
    cur.execute("""
        SELECT r.resolved_source, count(*)
        FROM openfoodfacts_product_match m
        JOIN product_nutrition_resolved r ON r.product_id = m.product_id
        WHERE m.decision='conflict'
        GROUP BY 1""")
    rows = cur.fetchall()
    if rows:
        bad = sum(c for s, c in rows if s == 'openfoodfacts')
        chk("식약처 미덮어쓰기(conflict→OFF 아님)", bad == 0, f"OFF로 노출 {bad}건")
    else:
        print("  [--] conflict 매칭 없음 → 미덮어쓰기 케이스 N/A")

    # 2) OFF fallback: load 제품은 resolved_source=openfoodfacts·confidence=low·ODbL
    cur.execute("""
        SELECT r.resolved_source, r.confidence, r.source_license, r.off_grade, r.calories
        FROM openfoodfacts_product_match m
        JOIN product_nutrition_resolved r ON r.product_id = m.product_id
        WHERE m.decision='load' AND r.calories IS NOT NULL
        LIMIT 20""")
    s = cur.fetchall()
    if s:
        chk("OFF fallback source=openfoodfacts", all(r[0] == 'openfoodfacts' for r in s))
        chk("OFF fallback confidence=low", all(r[1] == 'low' for r in s))
        chk("OFF fallback license=ODbL-1.0", all(r[2] == 'ODbL-1.0' for r in s))
        chk("OFF fallback off_grade∈A/B", all(r[3] in ('A', 'B') for r in s))
        print(f"      표본: {s[0]}")
    else:
        chk("OFF fallback 표본 존재", False, "load 제품 resolved 결합 0 — 점검 필요")

    # 3) basis unknown → serving 마커 NULL (신호등 절대량 미적용)
    cur.execute("""
        SELECT count(*) , count(*) FILTER (WHERE r.serving_size IS NOT NULL)
        FROM openfoodfacts_product_match m
        JOIN openfoodfacts_nutrition_norm n ON n.code = m.code
        JOIN product_nutrition_resolved r ON r.product_id = m.product_id
        WHERE m.decision='load' AND n.basis_unit='unknown'""")
    tot, nonnull = cur.fetchone()
    if tot:
        chk("basis unknown → serving NULL", nonnull == 0, f"unknown {tot}건 중 serving 비NULL {nonnull}건")
    else:
        print("  [--] basis unknown 적재분 없음 → N/A")

    # 4) 고아·음수 칼로리 (무결성)
    cur.execute("SELECT count(*) FROM openfoodfacts_nutrition_norm WHERE code NOT IN (SELECT code FROM openfoodfacts_raw)")
    chk("norm 고아 0", cur.fetchone()[0] == 0)
    cur.execute("SELECT count(*) FROM openfoodfacts_nutrition_norm WHERE calories < 0")
    chk("음수 칼로리 0", cur.fetchone()[0] == 0)
    cur.close(); conn.close()

    # 5) (선택) API health
    if API_URL:
        import urllib.request
        for path in ("/api/health", "/api/health/ready"):
            try:
                with urllib.request.urlopen(API_URL.rstrip("/") + path, timeout=10) as resp:
                    chk(f"API {path} 200", resp.status == 200)
            except Exception as e:
                chk(f"API {path} 200", False, str(e)[:50])

    print(f"\n=== smoke test: {P} passed, {F} failed ===")
    print("ALL GREEN ✅ — production 적재 정상 확인" if F == 0 else "✗ 실패 — 롤백/점검 검토")
    sys.exit(1 if F else 0)


if __name__ == "__main__":
    main()
