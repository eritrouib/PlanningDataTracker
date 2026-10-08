#!/usr/bin/env python3
"""
Planning Data Tracker: which key planning datasets are actually available on
planning.data.gov.uk for each local planning authority in England, plus some
data-quality checks on Article 4 directions.

Run from the repository folder (Python 3.8+, no extra packages):

    python scripts/build_tracker.py            # all authorities (takes ~20-40 minutes)
    python scripts/build_tracker.py --limit 5  # quick trial run

Writes:
    data/tracker.json            results per authority
    data/lpa-boundaries.geojson  simplified authority boundaries for the map
    js/data.js                   both, bundled so the page also works from disk

Runs weekly on GitHub (.github/workflows/update.yml).
"""
import argparse
import json
import math
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

API = os.environ.get("PLANNING_API", "https://www.planning.data.gov.uk").rstrip("/")
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# Datasets councils are responsible for publishing (keep in step with js/tracker.js).
DATASETS = [
    "article-4-direction-area",
    "conservation-area",
    "tree-preservation-zone",
    "tree",
    "locally-listed-building",
    "brownfield-land",
    "building-preservation-notice",
    "asset-of-community-value",
    "local-green-space",
    "contaminated-land",
]

USER_AGENT = "PlanningDataTracker (github.com/eritrouib/PlanningDataTracker)"
_lock = threading.Lock()
_last = [0.0]
MIN_INTERVAL = float(os.environ.get("TRACKER_MIN_INTERVAL", "0.12"))  # be polite: ~8 requests/second max


def get_json(url, retries=3, timeout=60):
    for attempt in range(retries + 1):
        with _lock:
            wait = _last[0] + MIN_INTERVAL - time.time()
            if wait > 0:
                time.sleep(wait)
            _last[0] = time.time()
        req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code in (400, 404, 422):
                return {"__status": e.code}
            if attempt == retries:
                raise
        except (urllib.error.URLError, TimeoutError, ValueError):
            if attempt == retries:
                raise
        time.sleep(2 * (attempt + 1))


def url(path, **params):
    q = urllib.parse.urlencode([(k, v) for k, v in params.items() if v is not None], doseq=True)
    return f"{API}/{path}?{q}"


def fetch_all(path, key, **params):
    items, link = [], url(path, **params)
    for _ in range(100):
        page = get_json(link)
        if "__status" in page:
            break
        batch = page.get(key) or []
        items.extend(batch)
        nxt = (page.get("links") or {}).get("next")
        if not nxt or not batch:
            break
        link = nxt if nxt.startswith("http") else API + nxt
    return items


# ---------------------------------------------------------------------------
# Boundaries (simplified for a light map)
# ---------------------------------------------------------------------------
def _perp(p, a, b):
    (x, y), (x1, y1), (x2, y2) = p, a, b
    dx, dy = x2 - x1, y2 - y1
    if dx == dy == 0:
        return math.hypot(x - x1, y - y1)
    t = max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))


def simplify_ring(ring, tol):
    """Douglas-Peucker, iterative. Keeps ring closed and at least 4 points."""
    if len(ring) <= 4:
        return ring
    keep = [False] * len(ring)
    keep[0] = keep[-1] = True
    stack = [(0, len(ring) - 1)]
    while stack:
        s, e = stack.pop()
        best, idx = 0, None
        for i in range(s + 1, e):
            d = _perp(ring[i], ring[s], ring[e])
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(s, idx), (idx, e)]
    out = [p for p, k in zip(ring, keep) if k]
    return out if len(out) >= 4 else ring


def simplify_geometry(geom, tol=0.0015):
    def poly(rings):
        out = []
        for i, r in enumerate(rings):
            s = [[round(x, 5), round(y, 5)] for x, y in simplify_ring(r, tol)]
            if i == 0 or len(s) >= 4:
                out.append(s)
        return out
    if not geom:
        return None
    if geom["type"] == "Polygon":
        return {"type": "Polygon", "coordinates": poly(geom["coordinates"])}
    if geom["type"] == "MultiPolygon":
        parts = [poly(p) for p in geom["coordinates"]]
        # drop tiny islands to keep the file small
        parts = [p for p in parts if p and len(p[0]) >= 4]
        return {"type": "MultiPolygon", "coordinates": parts}
    return geom


# ---------------------------------------------------------------------------
# Checks per authority
# ---------------------------------------------------------------------------
def count_in_area(dataset, area_entity):
    data = get_json(url("entity.json", dataset=dataset, geometry_entity=area_entity,
                        geometry_relation="intersects", limit=1, field=["entity", "dataset"]))
    if "__status" in data:
        return 0 if data["__status"] in (400, 404, 422) else None
    ents = data.get("entities") or []
    # Guard against an ignored filter (whole register or other datasets returned).
    if any(e.get("dataset") and e.get("dataset") != dataset for e in ents):
        return None
    count = data.get("count")
    if isinstance(count, int) and count > 1_000_000:
        return None
    return count if isinstance(count, int) else len(ents)


_org_cache = {}


def _org_article4(org):
    """Areas and directions published by one organisation (cached: several authorities can share one)."""
    with _lock:
        if org in _org_cache:
            return _org_cache[org]
    org_areas = fetch_all("entity.json", "entities", dataset="article-4-direction-area",
                          organisation_entity=org, limit=500, exclude_field="geometry")
    directions = fetch_all("entity.json", "entities", dataset="article-4-direction",
                           organisation_entity=org, limit=500)
    with _lock:
        _org_cache[org] = (org_areas, directions)
    return org_areas, directions


def article4_quality(area_entity):
    """Article 4 checks for the councils whose Article 4 areas fall in this authority."""
    areas = fetch_all("entity.json", "entities", dataset="article-4-direction-area", geometry_entity=area_entity,
                      geometry_relation="intersects", limit=500, exclude_field="geometry")
    orgs = sorted({a.get("organisation-entity") for a in areas if a.get("organisation-entity")}, key=str)
    result = {"areas": 0, "directions": 0, "unlinked": 0, "no_location": 0, "orgs": []}
    for org in orgs:
        org_areas, directions = _org_article4(org)
        refs = {d.get("reference") for d in directions if d.get("reference")}
        unlinked = [a for a in org_areas if str(a.get("article-4-direction") or "") not in refs]
        no_loc = [a for a in org_areas if not a.get("point")]
        result["areas"] += len(org_areas)
        result["directions"] += len(directions)
        result["unlinked"] += len(unlinked)
        result["no_location"] += len(no_loc)
        result["orgs"].append({"organisation": org, "areas": len(org_areas), "directions": len(directions),
                               "unlinked": len(unlinked), "no_location": len(no_loc),
                               "examples": [a.get("name") or a.get("reference") for a in (unlinked or no_loc)[:3]]})
    return result


def check_authority(lpa):
    counts = {}
    for ds in DATASETS:
        try:
            counts[ds] = count_in_area(ds, lpa["entity"])
        except Exception as e:  # noqa: BLE001 - record and carry on
            print(f"  ! {lpa['name']} {ds}: {e}", file=sys.stderr)
            counts[ds] = None
    a4 = None
    if counts.get("article-4-direction-area"):
        try:
            a4 = article4_quality(lpa["entity"])
        except Exception as e:  # noqa: BLE001
            print(f"  ! {lpa['name']} article 4 checks: {e}", file=sys.stderr)
    return {"entity": lpa["entity"], "name": lpa["name"], "reference": lpa.get("reference"),
            "counts": counts, "article4": a4}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="only check the first N authorities (for testing)")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    today = datetime.now(timezone.utc).date().isoformat()
    print("Fetching local planning authorities ...")
    lpas = fetch_all("entity.json", "entities", dataset="local-planning-authority", limit=500,
                     exclude_field="geometry")
    lpas = [l for l in lpas if not l.get("end-date") or l["end-date"] > today]
    lpas.sort(key=lambda l: l.get("name") or "")
    if args.limit:
        lpas = lpas[: args.limit]
    print(f"{len(lpas)} authorities")

    print("Fetching and simplifying boundaries ...")
    feats = fetch_all("entity.geojson", "features", dataset="local-planning-authority", limit=100)
    wanted = {l["entity"] for l in lpas}
    boundaries = {"type": "FeatureCollection", "features": []}
    for f in feats:
        p = f.get("properties") or {}
        if p.get("entity") in wanted and f.get("geometry"):
            boundaries["features"].append({"type": "Feature", "properties": {"entity": p["entity"], "name": p.get("name")},
                                           "geometry": simplify_geometry(f["geometry"])})

    print("Checking datasets per authority ...")
    results = []
    done = [0]

    def run(lpa):
        r = check_authority(lpa)
        with _lock:
            done[0] += 1
            if done[0] % 10 == 0 or done[0] == len(lpas):
                print(f"  {done[0]}/{len(lpas)}")
        return r

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(run, lpas))

    tracker = {
        "generated": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "source": API,
        "datasets": DATASETS,
        "authorities": results,
    }
    DATA.mkdir(exist_ok=True)
    (DATA / "tracker.json").write_text(json.dumps(tracker, separators=(",", ":")), encoding="utf-8")
    (DATA / "lpa-boundaries.geojson").write_text(json.dumps(boundaries, separators=(",", ":")), encoding="utf-8")
    bundle = f"// Generated by scripts/build_tracker.py. Do not edit by hand.\nwindow.TRACKER_DATA = {json.dumps(tracker, separators=(',', ':'))};\nwindow.TRACKER_BOUNDARIES = {json.dumps(boundaries, separators=(',', ':'))};\n"
    (ROOT / "js" / "data.js").write_text(bundle, encoding="utf-8")
    kb = len(bundle) / 1024
    print(f"Saved {len(results)} authorities, {len(boundaries['features'])} boundaries (bundle {kb:.0f} KB)")


if __name__ == "__main__":
    main()
