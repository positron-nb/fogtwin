"""
The surveyed road network — the twin's static layer.

This module is the reason the system works in fog: it can answer "where is the
road ahead of me, and how wide is it" from geometry alone, with no perception
whatsoever. Everything the HUD draws as road comes from `corridor_ahead()`.
"""

from __future__ import annotations

import heapq
import json
import math
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Tuple

from .config import ROADGRAPH_PATH

# Grid cell for the snap index. Comfortably larger than a haul road is wide,
# comfortably smaller than the gap between benches.
GRID_CELL_M = 60.0


@dataclass
class Node:
    id: str
    name: str
    x: float
    y: float
    z: float


@dataclass
class Edge:
    id: str
    a: str
    b: str
    half_width: float
    speed_class_kmh: float
    conflict_zone: Optional[str] = None
    length: float = 0.0
    gradient: float = 0.0          # rise / run, signed a -> b
    heading: float = 0.0           # radians, a -> b


@dataclass
class ConflictZone:
    id: str
    name: str
    capacity: int
    approach_m: float
    edge_ids: List[str] = field(default_factory=list)


@dataclass
class Snap:
    """Result of projecting a world point onto the network."""
    edge_id: str
    s: float                       # metres along the edge from node a
    lateral_m: float               # signed offset from centreline, + = left of a->b
    x: float                       # the snapped point
    y: float
    z: float
    off_road: bool                 # lateral exceeds half_width -> berm departure risk


class RoadGraph:
    def __init__(self, payload: dict) -> None:
        self.nodes: Dict[str, Node] = {
            n["id"]: Node(n["id"], n.get("name", n["id"]), n["x"], n["y"], n.get("z", 0.0))
            for n in payload["nodes"]
        }
        self.edges: Dict[str, Edge] = {}
        for e in payload["edges"]:
            edge = Edge(
                id=e["id"], a=e["a"], b=e["b"],
                half_width=e.get("half_width", 10.0),
                speed_class_kmh=e.get("speed_class", 30.0),
                conflict_zone=e.get("conflict_zone"),
            )
            na, nb = self.nodes[edge.a], self.nodes[edge.b]
            dx, dy, dz = nb.x - na.x, nb.y - na.y, nb.z - na.z
            edge.length = math.hypot(dx, dy)
            edge.gradient = dz / edge.length if edge.length else 0.0
            edge.heading = math.atan2(dy, dx)
            self.edges[edge.id] = edge

        self.zones: Dict[str, ConflictZone] = {}
        for z in payload.get("conflict_zones", []):
            zone = ConflictZone(z["id"], z.get("name", z["id"]),
                                z.get("capacity", 1), z.get("approach_m", 150.0))
            zone.edge_ids = [e.id for e in self.edges.values() if e.conflict_zone == zone.id]
            self.zones[zone.id] = zone

        self.met_stations: List[dict] = payload.get("met_stations", [])
        self.cycles: List[dict] = payload.get("cycles", [])

        # adjacency: node -> [(neighbour_node, edge_id, length)]
        self.adj: Dict[str, List[Tuple[str, str, float]]] = {nid: [] for nid in self.nodes}
        for e in self.edges.values():
            self.adj[e.a].append((e.b, e.id, e.length))
            self.adj[e.b].append((e.a, e.id, e.length))

        self._build_index()

    # ------------------------------------------------------------------
    def _build_index(self) -> None:
        """
        Uniform grid over the network, so snapping does not scan every edge.

        A generated Bailadila pit has ~120 edges and the server snaps several
        times per vehicle per tick; corridor_ahead snaps once per corridor
        point on top of that. Linear scan is fine for six trucks on a laptop
        and quadratic misery for a hundred on a real site, so bucket the edges
        once and test only the neighbourhood.
        """
        self._cell = GRID_CELL_M
        self._grid: Dict[Tuple[int, int], List[str]] = {}
        for e in self.edges.values():
            na, nb = self.nodes[e.a], self.nodes[e.b]
            # walk the segment, stamping it into every cell it passes through
            steps = max(1, int(e.length / (self._cell * 0.5)) + 1)
            for i in range(steps + 1):
                t = i / steps
                cx = int((na.x + (nb.x - na.x) * t) // self._cell)
                cy = int((na.y + (nb.y - na.y) * t) // self._cell)
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        self._grid.setdefault((cx + dx, cy + dy), [])
                        bucket = self._grid[(cx + dx, cy + dy)]
                        if e.id not in bucket:
                            bucket.append(e.id)
        if self._grid:
            cs = [c for c in self._grid]
            span_x = max(c[0] for c in cs) - min(c[0] for c in cs)
            span_y = max(c[1] for c in cs) - min(c[1] for c in cs)
            self._max_ring = max(span_x, span_y) + 2
        else:
            self._max_ring = 1

    def _seg_dist(self, e: "Edge", x: float, y: float) -> float:
        na, nb = self.nodes[e.a], self.nodes[e.b]
        dx, dy = nb.x - na.x, nb.y - na.y
        len2 = dx * dx + dy * dy
        t = 0.0 if len2 == 0 else ((x - na.x) * dx + (y - na.y) * dy) / len2
        t = 0.0 if t < 0 else (1.0 if t > 1 else t)
        return math.hypot(x - (na.x + t * dx), y - (na.y + t * dy))

    def _candidates(self, x: float, y: float) -> List[Edge]:
        """
        Edges near a point, with a guarantee.

        Returning the first ring that happens to contain anything is the
        tempting version and it is wrong: an edge one ring further out can be
        closer than the corner of the ring you stopped at. Off the network that
        silently picks the wrong road, which is exactly where berm-departure
        detection lives. So keep widening until the best distance found is
        inside the radius already searched, and only then stop.
        """
        cx, cy = int(x // self._cell), int(y // self._cell)
        seen: set[str] = set()
        out: List[Edge] = []
        ring = 1
        while ring <= self._max_ring:
            for dx in range(-ring, ring + 1):
                for dy in range(-ring, ring + 1):
                    if max(abs(dx), abs(dy)) != ring and ring > 1:
                        continue                      # only the new annulus
                    for eid in self._grid.get((cx + dx, cy + dy), ()):
                        if eid not in seen:
                            seen.add(eid)
                            out.append(self.edges[eid])
            if out:
                best = min(self._seg_dist(e, x, y) for e in out)
                if best <= ring * self._cell:
                    return out
            ring += 1
        return list(self.edges.values())

    # ------------------------------------------------------------------
    @classmethod
    def load(cls, path=ROADGRAPH_PATH) -> "RoadGraph":
        with open(path, "r", encoding="utf-8") as fh:
            return cls(json.load(fh))

    # ------------------------------------------------------------------
    def snap(self, x: float, y: float, heading: Optional[float] = None) -> Optional[Snap]:
        """
        Nearest point on the network — map-matching, minus the filter.

        At a junction several edges are equidistant, so pass `heading` when you
        know it: among edges within `TIE_M` of the best, the one best aligned
        with travel direction wins. Without this a vehicle sitting on a junction
        node gets its corridor drawn down whichever spur happened to sort first.
        """
        TIE_M = 6.0
        candidates: List[tuple[float, Snap, Edge]] = []
        for e in self._candidates(x, y):
            na, nb = self.nodes[e.a], self.nodes[e.b]
            dx, dy = nb.x - na.x, nb.y - na.y
            if e.length == 0:
                continue
            t = ((x - na.x) * dx + (y - na.y) * dy) / (e.length ** 2)
            t = max(0.0, min(1.0, t))
            px, py = na.x + t * dx, na.y + t * dy
            d = math.hypot(x - px, y - py)
            cross = dx * (y - na.y) - dy * (x - na.x)
            candidates.append((d, Snap(
                edge_id=e.id, s=t * e.length,
                lateral_m=math.copysign(d, cross) if d else 0.0,
                x=px, y=py, z=na.z + t * (nb.z - na.z),
                off_road=d > e.half_width,
            ), e))

        if not candidates:
            return None
        candidates.sort(key=lambda c: c[0])
        best_d = candidates[0][0]
        if heading is None:
            return candidates[0][1]

        tied = [c for c in candidates if c[0] <= best_d + TIE_M]
        return max(tied, key=lambda c: abs(math.cos(heading - c[2].heading)))[1]

    # ------------------------------------------------------------------
    def route(self, from_node: str, to_node: str) -> List[str]:
        """Dijkstra over node ids. Returns the node sequence, inclusive."""
        if from_node == to_node:
            return [from_node]
        dist = {from_node: 0.0}
        prev: Dict[str, str] = {}
        pq = [(0.0, from_node)]
        seen = set()
        while pq:
            d, u = heapq.heappop(pq)
            if u in seen:
                continue
            seen.add(u)
            if u == to_node:
                break
            for v, _eid, w in self.adj[u]:
                nd = d + w
                if nd < dist.get(v, float("inf")):
                    dist[v] = nd
                    prev[v] = u
                    heapq.heappush(pq, (nd, v))
        if to_node not in dist:
            return []
        path = [to_node]
        while path[-1] != from_node:
            path.append(prev[path[-1]])
        return list(reversed(path))

    def edge_between(self, a: str, b: str) -> Optional[Edge]:
        for v, eid, _w in self.adj.get(a, []):
            if v == b:
                return self.edges[eid]
        return None

    # ------------------------------------------------------------------
    def corridor_ahead(
        self,
        x: float,
        y: float,
        heading: float,
        horizon_m: float = 180.0,
        step_m: float = 12.0,
    ) -> List[List[float]]:
        """
        The road ahead as [[x, y, z, half_width], ...].

        THE money function. In 3 m fog the operator's HUD draws this, and it is
        exactly as accurate as it is on a clear day, because it is survey data.

        We walk the network forward from the snapped position, at each node
        choosing the continuation whose heading best matches current travel
        direction — i.e. "keep going the way you are pointing", which is what a
        driver does and what the survey geometry supports without a route plan.
        """
        snap = self.snap(x, y, heading)
        if snap is None:
            return []
        edge = self.edges[snap.edge_id]

        # Which way along this edge are we travelling?
        forward = math.cos(heading - edge.heading) >= 0
        cur_edge, cur_s = edge, snap.s
        out: List[List[float]] = []
        travelled = 0.0
        guard = 0

        while travelled < horizon_m and guard < 64:
            guard += 1
            na = self.nodes[cur_edge.a]
            nb = self.nodes[cur_edge.b]
            end_s = cur_edge.length if forward else 0.0
            remaining = abs(end_s - cur_s)

            while remaining > 0 and travelled < horizon_m:
                cur_s += step_m if forward else -step_m
                cur_s = min(cur_edge.length, max(0.0, cur_s))
                t = cur_s / cur_edge.length if cur_edge.length else 0.0
                out.append([
                    na.x + t * (nb.x - na.x),
                    na.y + t * (nb.y - na.y),
                    na.z + t * (nb.z - na.z),
                    cur_edge.half_width,
                ])
                travelled += step_m
                remaining -= step_m

            # hop to the next edge at the node we just reached
            at_node = cur_edge.b if forward else cur_edge.a
            exit_heading = cur_edge.heading if forward else cur_edge.heading + math.pi
            nxt = self._best_continuation(at_node, cur_edge.id, exit_heading)
            if nxt is None:
                break
            cur_edge = nxt
            forward = cur_edge.a == at_node
            cur_s = 0.0 if forward else cur_edge.length

        return out

    def _best_continuation(self, node_id: str, from_edge: str, heading: float) -> Optional[Edge]:
        best, best_align = None, -2.0
        for _v, eid, _w in self.adj[node_id]:
            if eid == from_edge:
                continue
            e = self.edges[eid]
            h = e.heading if e.a == node_id else e.heading + math.pi
            align = math.cos(h - heading)
            if align > best_align:
                best_align, best = align, e
        # a hairpin switchback is a legitimate continuation; only reject dead ends
        return best

    # ------------------------------------------------------------------
    def zone_ahead(
        self, x: float, y: float, heading: float
    ) -> Optional[Tuple[str, float, Tuple[float, float]]]:
        """
        (zone_id, distance_m, hold_point) for the nearest conflict zone you
        could reach, or None.

        This searches every forward branch, not just the one you look most
        likely to take. The earlier version walked a single best-heading
        corridor, and at a ramp head — where a bench road continues straight
        and the ramp peels off — it guessed the bench. A dumper then entered a
        single-lane ramp having never requested the token, and the allocator
        was powerless: it had granted correctly to somebody else and the second
        machine simply drove in. Measured at 280 co-occupancy steps on RAMP-E
        in a twenty minute run.

        Reserving a zone you turn out not to enter costs a few seconds of
        somebody else's waiting, and the approach timeout hands it back.
        Failing to reserve one you do enter is a head-on on a single-lane ramp.
        The asymmetry decides the design: explore both branches.
        """
        snap = self.snap(x, y, heading)
        if snap is None:
            return None
        edge = self.edges[snap.edge_id]
        forward = math.cos(heading - edge.heading) >= 0

        horizon = max((z.approach_m for z in self.zones.values()), default=150.0)
        start_node = edge.b if forward else edge.a
        remaining = (edge.length - snap.s) if forward else snap.s

        best: Optional[Tuple[str, float, Tuple[float, float]]] = None
        pq: List[Tuple[float, str]] = [(remaining, start_node)]
        seen_edges = {edge.id}
        seen_nodes: Dict[str, float] = {start_node: remaining}

        while pq:
            pq.sort()
            d, node = pq.pop(0)
            if d > horizon or (best is not None and d >= best[1]):
                continue
            for _v, eid, _w in self.adj[node]:
                if eid in seen_edges:
                    continue
                seen_edges.add(eid)
                e2 = self.edges[eid]
                nxt = e2.b if e2.a == node else e2.a

                if e2.conflict_zone:
                    zone = self.zones.get(e2.conflict_zone)
                    approach = zone.approach_m if zone else horizon
                    if d <= approach and (best is None or d < best[1]):
                        entry = self.nodes[node]
                        # hold 15 m short of the entry, on the line back to us
                        vx, vy = x - entry.x, y - entry.y
                        L = math.hypot(vx, vy) or 1.0
                        hold = (entry.x + vx / L * 15.0, entry.y + vy / L * 15.0)
                        best = (e2.conflict_zone, d, hold)
                    continue        # do not search through a zone

                nd = d + e2.length
                if nd < seen_nodes.get(nxt, float("inf")) and nd <= horizon:
                    seen_nodes[nxt] = nd
                    pq.append((nd, nxt))

        return best

    def zone_of(self, x: float, y: float, heading: Optional[float] = None) -> Optional[str]:
        s = self.snap(x, y, heading)
        if s is None:
            return None
        return self.edges[s.edge_id].conflict_zone

    # ------------------------------------------------------------------
    def curvature_at(self, edge_id: str) -> float:
        """Crude turn severity at the far end of an edge, radians. Feeds speed."""
        e = self.edges[edge_id]
        nxt = self._best_continuation(e.b, e.id, e.heading)
        if nxt is None:
            return 0.0
        h = nxt.heading if nxt.a == e.b else nxt.heading + math.pi
        d = abs(math.atan2(math.sin(h - e.heading), math.cos(h - e.heading)))
        return d

    def line_of_sight(self, ax: float, ay: float, bx: float, by: float) -> bool:
        """
        True if A can plausibly see B — i.e. the straight line between them stays
        on the road network. In a terraced pit, leaving the corridor means rock
        in the way. Cheap, and good enough to flag `around_corner`.
        """
        dist = math.hypot(bx - ax, by - ay)
        if dist < 1.0:
            return True
        steps = max(2, int(dist / 12.0))
        for i in range(1, steps):
            t = i / steps
            px, py = ax + (bx - ax) * t, ay + (by - ay) * t
            s = self.snap(px, py)
            if s is None or abs(s.lateral_m) > self.edges[s.edge_id].half_width * 1.6:
                return False
        return True


def load_graph() -> RoadGraph:
    return RoadGraph.load()
