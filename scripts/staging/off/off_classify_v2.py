# -*- coding: utf-8 -*-
r"""
off_classify_v2.py — v2.3 적재 분류 (identity_check_v2 + 수동결정 override), DB 무관·eval 가능
SOURCE: D:\먹선\IP\off_identity_gate_v2.md

classify_match_v2(p, orow, manual) → decision:
  'load'        : accept + 결측 → 적재·노출(신호등)
  'conflict'    : accept + 이미 영양보유 → 미덮어쓰기, 충돌센서만
  'hold_review' : review → 사용자 미노출(수동 판단 큐 대상). 적재 안 함.
  'skip_identity': reject(정체성) → 미사용
  'skip_reject' : 품질게이트 Reject → 미사용

수동결정(제이 태깅) override:
  off_review_queue.csv 의 human_verdict(accept/reject) 또는 off_manual_decisions.json → barcode별 강제.
  accept=같은제품 확정(신호등 승격), reject=폐기.
"""
import os, sys, csv, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import off_normalize as off
import off_identity_v2 as v2
import off_load_railway as L

_DIR = os.path.dirname(os.path.abspath(__file__))
MANUAL_JSON = os.path.join(_DIR, "off_manual_decisions.json")   # 큐레이션 whitelist/blacklist
REVIEW_CSV = r"D:\먹선\eval_set\off_review_queue.csv"           # 제이 태깅본


def load_manual(csv_path=REVIEW_CSV, json_path=MANUAL_JSON):
    """{barcode(str): 'accept'|'reject'} 병합. json이 csv를 덮어씀(큐레이션 우선)."""
    m = {}
    if csv_path and os.path.exists(csv_path):
        with open(csv_path, encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                v = (r.get("human_verdict") or "").strip().lower()
                if v in ("accept", "reject"):
                    m[str(r["barcode"]).strip()] = v
    if json_path and os.path.exists(json_path):
        with open(json_path, encoding="utf-8") as f:
            for k, v in (json.load(f) or {}).items():
                if str(v).lower() in ("accept", "reject"):
                    m[str(k).strip()] = str(v).lower()
    return m


def classify_match_v2(p, orow, manual=None):
    flat = L.flatten(orow)
    n, (sodium_g, salt_g) = off.normalize_off(flat)
    off_name = L.pname(orow.get("product_name"))
    our_cat = " ".join(x for x in [p.get("food_type"), p.get("food_category")] if x)
    our_brand = p.get("brand") or p.get("manufacturer") or ""
    bc = str(p["barcode"])

    src = "auto"
    if manual and bc in manual:
        identity = manual[bc]           # 사람 판단(accept/reject) 강제
        src = "manual"
    else:
        identity = v2.identity_check_v2(
            p["product_name"], our_brand, our_cat, off_name,
            orow.get("brands") or "", flat["categories_tags_str"],
            orow.get("countries_tags") or [], bc, None, flat.get("quantity"))

    grade, info = off.quality_grade(n, sodium_g, salt_g,
                                    identity=("accept" if identity == "accept" else
                                              "review" if identity == "review" else "reject"))
    if identity == "reject":
        decision = "skip_identity"
    elif grade == "Reject":
        decision = "skip_reject"
    elif identity == "review":
        decision = "hold_review"        # 미노출·수동 큐 대상 (v2.3: 확정 전 노출 안 함)
    elif p.get("has_nutr"):
        decision = "conflict"           # 식약처/OCR 값 보유 → 미덮어쓰기(센서만)
    else:
        decision = "load"               # accept + 결측 → 적재·노출
    return {"decision": decision, "identity": identity, "identity_src": src,
            "grade": grade, "n": n, "sodium_g": sodium_g, "salt_g": salt_g, "off_name": off_name}


if __name__ == "__main__":
    m = load_manual()
    print(f"off_classify_v2 loaded. 수동결정 {len(m)}건 (accept {sum(v=='accept' for v in m.values())} / reject {sum(v=='reject' for v in m.values())})")
