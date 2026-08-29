"""
Lay a haul road network onto the real Bailadila ridge.

    python -m scripts.build_roadgraph

Bailadila's deposits are worked from the top of a ridge downwards, so the road
network is not an arbitrary graph — it is a stack of bench roads that follow the
contours around the hill, each one linked to the next by a ramp that spirals
down the flank. This script derives exactly that from the DEM:

  * bench elevations every BENCH_LIFT metres below the crest
  * each bench road is the real contour at that elevation, found by marching
    outward from the crest until the ground drops below it
  * benches are cut as ~300 degree arcs; the remaining arc is the ramp down to
    the next bench, which is what makes the whole thing a descending spiral
  * a haul road runs from the toe of the spiral out to the crusher in the valley

Because the geometry comes from the terrain, roads sit ON the ground rather than
hovering over it, gradients are real, and the switchbacks are where the hill
actually allows them.

The network is illustrative, not NMDC's surveyed layout — the problem statement
ships no dataset. Replacing data/roadgraph.json with a real survey requires no
code change; every consumer reads the same schema.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DEM_DIR = ROOT / "data" / "dem"
OUT = ROOT / "data" / "roadgraph.json"

BENCH_LIFT = 20.0          # metres of vertical per bench
N_BENCHES = 9
BENCH_ARC_DEG = 292.0      # flat working arc; the rest of the turn is the ramp
NODES_PER_BENCH = 9
NODES_PER_RAMP = 4
START_BELOW_CREST = 18.0   # first bench road sits this far below the summit
RAMP_ROTATE_DEG = 22.0     # stagger successive ramps around the hill

# Pit slope design. A bench is cut back from the one above by (bench road width
# + face setback); the resulting overall slope angle is what keeps the highwall
# standing. Where the natural contour runs further out than this — along a spur
# of the ridge — the wall is CUT rather than followed, which is exactly what a
# real pit does and what stops the generated roads wandering 800 m down a spur.
# A bench carrying a 20 m carriageway needs road + berm + the face setback of
# the lift above it, so the cut-back cannot be much below 20 + 4 + 8. Set it
# tighter and consecutive bench roads overlap, leaving no face between them, and
# a vehicle can "depart" one bench straight onto the next. Set it much wider and
# the overall slope flattens to about 15 degrees, which reads as a terraced
# plateau rather than a pit. 20 m of lift per 32-50 m of cut-back gives an
# overall slope near 30 degrees, which is what these haematite walls stand at.
CUT_BACK_MIN_M = 32.0
CUT_BACK_MAX_M = 50.0
CREST_RADIUS_MAX_M = 210.0

BENCH_HALF_W = 10.0        # 20 m carriageway: two-way for a 100 t dumper
RAMP_HALF_W = 7.5
HAUL_HALF_W = 12.0


# --------------------------------------------------------------------------
# DEM sampling in local ENU metres
# --------------------------------------------------------------------------

class Dem:
    def __init__(self) -> None:
        self.meta = json.loads((DEM_DIR / "bailadila.json").read_text())
        h, w = self.meta["height"], self.meta["width"]
        self.grid = np.fromfile(DEM_DIR / "bailadila.bin", dtype=np.int16) \
                      .reshape(h, w).astype(np.float64)
        self.h, self.w = h, w

    def latlon_to_cell(self, lat: float, lon: float) -> tuple[float, float]:
        m = self.meta
        col = (lon - m["west"]) / (m["east"] - m["west"]) * (self.w - 1)
        row = (m["north"] - lat) / (m["north"] - m["south"]) * (self.h - 1)
        return col, row

    def sample_cell(self, col: float, row: float) -> float:
        col = min(max(col, 0), self.w - 1.001)
        row = min(max(row, 0), self.h - 1.001)
        c0, r0 = int(col), int(row)
        fc, fr = col - c0, row - r0
        g = self.grid
        return (g[r0, c0] * (1 - fc) * (1 - fr) + g[r0, c0 + 1] * fc * (1 - fr) +
                g[r0 + 1, c0] * (1 - fc) * fr + g[r0 + 1, c0 + 1] * fc * fr)

    def crest(self) -> tuple[float, float, float]:
        iy, ix = np.unravel_index(np.argmax(self.grid), self.grid.shape)
        m = self.meta
        lat = m["north"] - iy / (self.h - 1) * (m["north"] - m["south"])
        lon = m["west"] + ix / (self.w - 1) * (m["east"] - m["west"])
        return lat, lon, float(self.grid[iy, ix])


class Enu:
    """Local east-north-up frame anchored on the crest."""

    def __init__(self, lat0: float, lon0: float, dem: Dem) -> None:
        self.lat0, self.lon0 = lat0, lon0
        self.m_lat = 111_320.0
        self.m_lon = 111_320.0 * math.cos(math.radians(lat0))
        self.dem = dem

    def to_latlon(self, x: float, y: float) -> tuple[float, float]:
        return self.lat0 + y / self.m_lat, self.lon0 + x / self.m_lon

    def elev(self, x: float, y: float) -> float:
        lat, lon = self.to_latlon(x, y)
        return self.dem.sample_cell(*self.dem.latlon_to_cell(lat, lon))


# --------------------------------------------------------------------------
# contour extraction
# --------------------------------------------------------------------------

def contour_radius(enu: Enu, theta: float, target_z: float,
                   r_max: float = 2400.0, step: float = 8.0) -> float:
    """March outward from the crest until the ground falls below target_z."""
    prev_r, prev_z = 0.0, enu.elev(0.0, 0.0)
    r = step
    while r < r_max:
        z = enu.elev(math.cos(theta) * r, math.sin(theta) * r)
        if z <= target_z:
            if prev_z != z:                     # linear refine
                f = (prev_z - target_z) / (prev_z - z)
                return prev_r + f * (r - prev_r)
            return r
        prev_r, prev_z = r, z
        r += step
    return r_max


def smooth_ring(values: list[float], passes: int = 3) -> list[float]:
    """Circular moving average — 30 m DEM contours are far too jagged to drive."""
    v = list(values)
    n = len(v)
    for _ in range(passes):
        v = [(v[(i - 1) % n] + 2 * v[i] + v[(i + 1) % n]) / 4 for i in range(n)]
    return v


# --------------------------------------------------------------------------

def main() -> None:
    dem = Dem()
    lat0, lon0, crest_z = dem.crest()
    enu = Enu(lat0, lon0, dem)
    print(f"crest {crest_z:.0f} m at {lat0:.5f}N {lon0:.5f}E")

    nodes: list[dict] = []
    edges: list[dict] = []
    zones: list[dict] = []

    # ---- bench rings -----------------------------------------------------
    # Sample each contour densely, smooth it, then keep NODES_PER_BENCH points
    # across the working arc. Dense sampling first matters: taking nine raw
    # DEM samples straight from the contour gives a road that zig-zags into the
    # hillside, which is what makes a generated mine look generated.
    DENSE = 180
    bench_rings: list[list[tuple[float, float, float]]] = []
    bench_z: list[float] = []

    for k in range(N_BENCHES):
        z = crest_z - START_BELOW_CREST - k * BENCH_LIFT
        radii = [contour_radius(enu, 2 * math.pi * i / DENSE, z) for i in range(DENSE)]
        radii = smooth_ring(radii, passes=6)
        bench_rings.append([(2 * math.pi * i / DENSE, radii[i], z) for i in range(DENSE)])
        bench_z.append(z)
        print(f"  bench {k}: z={z:6.0f} m  radius {min(radii):5.0f}-{max(radii):5.0f} m")

    # ---- constrain the contours to a designed pit slope ----------------
    # r_k(theta) = clamp(natural contour, r_(k-1) + min cut-back, + max cut-back)
    prev = None
    designed: list[list[float]] = []
    for k, ring in enumerate(bench_rings):
        radii = [pt[1] for pt in ring]
        if prev is None:
            radii = [min(r, CREST_RADIUS_MAX_M) for r in radii]
        else:
            radii = [min(max(r, prev[i] + CUT_BACK_MIN_M), prev[i] + CUT_BACK_MAX_M)
                     for i, r in enumerate(radii)]
        radii = smooth_ring(radii, passes=4)
        designed.append(radii)
        prev = radii
    print(f"  designed pit: crest ring {min(designed[0]):.0f}-{max(designed[0]):.0f} m, "
          f"toe ring {min(designed[-1]):.0f}-{max(designed[-1]):.0f} m")

    def ring_r(k: int, theta: float) -> float:
        idx = int((theta % (2 * math.pi)) / (2 * math.pi) * DENSE) % DENSE
        return designed[k][idx]

    # ---- lay the spiral: flat bench arc, then a ramp arc down the wall ---
    # The ramp is an ARC, not a chord. A straight line between the end of one
    # bench and the start of the next would cut clean across the middle of the
    # pit; a real ramp hugs the wall all the way down.
    arc = math.radians(BENCH_ARC_DEG)
    for k in range(N_BENCHES):
        start = math.radians(k * RAMP_ROTATE_DEG)
        z_here = bench_z[k]
        ids = []

        for i in range(NODES_PER_BENCH):
            theta = start + arc * i / (NODES_PER_BENCH - 1)
            r = ring_r(k, theta)
            nid = f"B{k}_{i}"
            nodes.append({
                "id": nid,
                "name": f"Bench {N_BENCHES - k} " +
                        ("ramp head" if i == NODES_PER_BENCH - 1 else f"ch {i}"),
                "x": round(math.cos(theta) * r, 1),
                "y": round(math.sin(theta) * r, 1),
                "z": round(z_here, 1),
            })
            ids.append(nid)

        for i in range(NODES_PER_BENCH - 1):
            edges.append({
                "id": f"E_B{k}_{i}", "a": ids[i], "b": ids[i + 1],
                "half_width": BENCH_HALF_W, "speed_class": 30,
            })

        if k + 1 >= N_BENCHES:
            continue

        # ramp arc: sweep the remaining angle, descending to the next bench
        zone_id = f"RAMP-{chr(ord('A') + k)}"
        single_lane = k in (1, 4, 7)
        theta_a = start + arc
        theta_b = math.radians((k + 1) * RAMP_ROTATE_DEG) + 2 * math.pi
        z_next = bench_z[k + 1]

        ramp_ids = [ids[-1]]
        for j in range(1, NODES_PER_RAMP + 1):
            t = j / (NODES_PER_RAMP + 1)
            theta = theta_a + (theta_b - theta_a) * t
            r = ring_r(k, theta) * (1 - t) + ring_r(k + 1, theta) * t
            nid = f"R{k}_{j}"
            nodes.append({
                "id": nid, "name": f"Ramp {chr(ord('A') + k)} ch {j}",
                "x": round(math.cos(theta) * r, 1),
                "y": round(math.sin(theta) * r, 1),
                "z": round(z_here + (z_next - z_here) * t, 1),
            })
            ramp_ids.append(nid)
        ramp_ids.append(f"B{k + 1}_0")

        for j in range(len(ramp_ids) - 1):
            e = {"id": f"E_R{k}_{j}", "a": ramp_ids[j], "b": ramp_ids[j + 1],
                 "half_width": RAMP_HALF_W, "speed_class": 20}
            if single_lane:
                e["conflict_zone"] = zone_id
            edges.append(e)

        if single_lane:
            zones.append({"id": zone_id, "name": f"Ramp {chr(ord('A') + k)} single lane",
                          "capacity": 1, "approach_m": 180})

    # ---- haul road from the toe out to the crusher ----------------------
    # A haul road is DESIGNED, not draped. Node elevations come from a chosen
    # ruling gradient and the terrain is cut or filled to meet them — take the
    # elevation straight off the DEM instead and you get a 58% ramp that no
    # loaded dumper could climb, let alone descend in the wet.
    MAX_GRADE = 0.075
    toe = f"B{N_BENCHES - 1}_{NODES_PER_BENCH - 1}"
    toe_node = next(n for n in nodes if n["id"] == toe)
    toe_r = math.hypot(toe_node["x"], toe_node["y"])
    bearing = math.atan2(toe_node["y"], toe_node["x"])

    # Seat the crusher where the ground is lowest that we can still reach on
    # grade: the drop we can afford is MAX_GRADE x the distance we travel.
    best = None
    for dth in (-0.6, -0.35, -0.15, 0.0, 0.15, 0.35, 0.6):
        th = bearing + dth
        for extra in range(500, 1700, 40):
            x = math.cos(th) * (toe_r + extra)
            y = math.sin(th) * (toe_r + extra)
            ground = enu.elev(x, y)
            reachable = toe_node["z"] - MAX_GRADE * extra
            z = max(ground, reachable)          # cut down to ground, or bench up
            fill = z - ground                   # how much embankment we need
            if fill > 25:                       # too much fill to be credible
                continue
            if best is None or z < best[2]:
                best = (x, y, z, extra)
    cx, cy, cz, run = best
    grade = (toe_node["z"] - cz) / run
    print(f"  crusher seat: {cz:.0f} m, {run:.0f} m of haul from the toe, "
          f"ruling grade {grade * 100:.1f}%")

    haul_ids = [toe]
    STEPS = 6
    for i in range(1, STEPS + 1):
        t = i / STEPS
        x = toe_node["x"] + (cx - toe_node["x"]) * t
        y = toe_node["y"] + (cy - toe_node["y"]) * t
        nodes.append({
            "id": f"H{i}",
            "name": "Crusher tip" if i == STEPS else
                    ("Crusher approach" if i == STEPS - 1 else f"Haul road ch {i}"),
            "x": round(x, 1), "y": round(y, 1),
            "z": round(toe_node["z"] + (cz - toe_node["z"]) * t, 1),
        })
        haul_ids.append(f"H{i}")

    for i in range(len(haul_ids) - 1):
        e = {"id": f"E_H{i}", "a": haul_ids[i], "b": haul_ids[i + 1],
             "half_width": HAUL_HALF_W, "speed_class": 40}
        if i == len(haul_ids) - 2:
            e.update({"half_width": 8.0, "speed_class": 15,
                      "conflict_zone": "TIP-CRUSHER"})
        edges.append(e)
    zones.append({"id": "TIP-CRUSHER", "name": "Crusher tip point",
                  "capacity": 1, "approach_m": 140})

    # ---- loading bays at the two top benches ----------------------------
    for k, zid in ((0, "SHOVEL-TOP"), (2, "SHOVEL-MID")):
        anchor = next(n for n in nodes if n["id"] == f"B{k}_0")
        th = math.atan2(anchor["y"], anchor["x"])
        x = anchor["x"] - math.cos(th) * 70
        y = anchor["y"] - math.sin(th) * 70
        nid = f"S{k}"
        nodes.append({"id": nid, "name": f"Bench {N_BENCHES - k} shovel face",
                      "x": round(x, 1), "y": round(y, 1),
                      "z": round(bench_z[k], 1)})   # the face is cut to bench level
        edges.append({"id": f"E_S{k}", "a": nid, "b": anchor["id"],
                      "half_width": 10.0, "speed_class": 15,
                      "conflict_zone": zid})
        zones.append({"id": zid, "name": f"Bench {N_BENCHES - k} loading bay",
                      "capacity": 1, "approach_m": 120})

    # ---- met stations, spread across the elevation range ----------------
    met = []
    for label, ref, sid in (("Crest bench", f"B0_4", "MET-CREST"),
                            ("Upper ramp", f"B2_6", "MET-RAMP"),
                            ("Mid bench", f"B4_3", "MET-MID"),
                            ("Toe bench", f"B{N_BENCHES - 1}_5", "MET-TOE"),
                            ("Crusher", f"H{STEPS - 1}", "MET-CRUSHER")):
        n = next(x for x in nodes if x["id"] == ref)
        met.append({"station_id": sid, "name": label,
                    "x": n["x"], "y": n["y"], "z": n["z"]})

    payload = {
        "_comment": ("Haul network derived from the real Bailadila DEM by "
                     "scripts/build_roadgraph.py. Bench roads follow true "
                     "contours; ramps spiral down the flank. ENU metres from "
                     "the ridge crest. Illustrative layout, real terrain — "
                     "replace with NMDC survey when available."),
        "origin": {"lat": round(lat0, 6), "lon": round(lon0, 6),
                   "alt_m": round(crest_z, 1), "note": "Bailadila crest, Deposit 14"},
        "dem": "data/dem/bailadila.json",
        "nodes": nodes,
        "edges": edges,
        "conflict_zones": zones,
        "met_stations": met,
        "cycles": [
            {"from": "S0", "to": f"H{STEPS}"},
            {"from": "S2", "to": f"H{STEPS}"},
        ],
    }
    OUT.write_text(json.dumps(payload, indent=1))

    by_kind = {"bench": [], "ramp": [], "haul": []}
    for e in edges:
        a = next(n for n in nodes if n["id"] == e["a"])
        b = next(n for n in nodes if n["id"] == e["b"])
        L = math.hypot(b["x"] - a["x"], b["y"] - a["y"])
        if L < 1:
            continue
        kind = ("ramp" if e["id"].startswith("E_R") else
                "haul" if e["id"].startswith("E_H") else "bench")
        by_kind[kind].append(abs(b["z"] - a["z"]) / L)

    print(f"\nwrote {OUT.relative_to(ROOT)}")
    print(f"  {len(nodes)} nodes, {len(edges)} edges, {len(zones)} conflict zones")
    for kind, gs in by_kind.items():
        if gs:
            print(f"  {kind:6} gradient: median {sorted(gs)[len(gs) // 2] * 100:4.1f}%  "
                  f"max {max(gs) * 100:4.1f}%   ({len(gs)} edges)")
    worst = max(max(gs) for gs in by_kind.values() if gs)
    if worst > 0.12:
        print(f"  WARNING: {worst * 100:.0f}% exceeds what a loaded dumper should see")


if __name__ == "__main__":
    main()
