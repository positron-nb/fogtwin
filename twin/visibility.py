"""
The per-segment visibility field.

Fog on a hilltop mine is not uniform. Bench 12 can sit inside cloud while the
crusher 200 m below is clear. Treating visibility as one site-wide number is
exactly why current controls are blunt — the whole mine halts because one bench
is blind. Here it is a spatial field V(x, y, z, t) in metres, interpolated
across the road graph, so the twin can green-light the lower haul road at
40 km/h while restricting Bench 12 to 12 km/h.

That selectivity is where most of the recovered production comes from.

Interpolation is inverse-distance weighting with an **elevation covariate** —
fog stratifies strongly by height on Bailadila's ridges, so two stations 300 m
apart horizontally but 150 m apart vertically should barely inform each other.
Kriging with an elevation drift is the production answer; IDW with a vertical
penalty is 95% of the benefit for 5% of the code.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, List, Optional

from schema.messages import MetReading

from . import clock, config
from .roadgraph import RoadGraph

# metres of vertical separation counted as this many metres of horizontal
VERTICAL_PENALTY = 4.0
IDW_POWER = 2.0
SENSOR_STALE_S = 300.0


@dataclass
class _Sample:
    x: float
    y: float
    z: float
    visibility_m: float
    t: float
    source: str          # "station" or a vehicle_id


class VisibilityField:
    def __init__(self, graph: RoadGraph) -> None:
        self.graph = graph
        self.samples: Dict[str, _Sample] = {}
        self.met: Dict[str, MetReading] = {}
        # seed every declared station with clear conditions so the field is
        # defined before any hardware reports
        for st in graph.met_stations:
            self.samples[st["station_id"]] = _Sample(
                st["x"], st["y"], st.get("z", 0.0), 1000.0, clock.now(), "station"
            )

    # ------------------------------------------------------------------
    def ingest_met(self, msg: MetReading) -> None:
        if msg.t <= 0:
            msg.t = clock.now()
        self.met[msg.station_id] = msg
        self.samples[msg.station_id] = _Sample(
            msg.x, msg.y, msg.z, msg.visibility_m, msg.t, "station"
        )

    def ingest_vehicle_estimate(self, vehicle_id: str, x: float, y: float, z: float,
                                visibility_m: float) -> None:
        """
        Each dumper runs a dark-channel-prior transmission estimate and compares
        image contrast against known-distance twin landmarks. The fleet becomes a
        roving sensor network for free — dozens of extra samples, no extra
        hardware. Weighted lower than a calibrated forward-scatter sensor.
        """
        self.samples[f"veh:{vehicle_id}"] = _Sample(
            x, y, z, visibility_m, clock.now(), vehicle_id
        )

    # ------------------------------------------------------------------
    def at(self, x: float, y: float, z: float = 0.0) -> float:
        """
        Interpolate in **extinction space**, not in metres of visibility.

        Meteorological visibility V relates to the extinction coefficient k by
        Koschmieder: k = 3 / V. Extinction is what physically adds up along a
        path, and it is what varies smoothly through a fog bank; visibility is
        its reciprocal and does not interpolate sensibly. Averaging metres
        directly lets one clear station 300 m away drag a 5 m fog pocket up to
        200 m, because 1000 dominates any linear mean — the fog evaporates in
        the model while sitting solidly on the bench in reality.
        """
        now = clock.now()
        fresh = [s for s in self.samples.values() if now - s.t <= SENSOR_STALE_S]
        # Fail safe, not optimistic. If every station has gone quiet the honest
        # answer is "we do not know", and the dangerous answer is "clear" —
        # which is what returning the 1000 m default amounted to. Fog does not
        # lift because a sensor stopped reporting, so hold the last known field
        # and let the staleness show up as a degraded mode instead.
        usable = fresh if fresh else list(self.samples.values())

        num = 0.0
        den = 0.0
        for s in usable:
            d_h = math.hypot(x - s.x, y - s.y)
            d_v = abs(z - s.z) * VERTICAL_PENALTY
            d = math.sqrt(d_h * d_h + d_v * d_v)
            if d < 1.0:
                return s.visibility_m
            w = 1.0 / (d ** IDW_POWER)
            if s.source != "station":
                w *= 0.4                      # uncalibrated, trust it less
            num += w * (3.0 / max(s.visibility_m, 1.0))
            den += w
        if not den:
            return 1000.0
        k = num / den
        return min(1000.0, 3.0 / k) if k > 0 else 1000.0

    def per_segment(self) -> Dict[str, float]:
        """Visibility at each edge midpoint — what the control room paints."""
        out: Dict[str, float] = {}
        for e in self.graph.edges.values():
            na, nb = self.graph.nodes[e.a], self.graph.nodes[e.b]
            out[e.id] = round(self.at((na.x + nb.x) / 2,
                                      (na.y + nb.y) / 2,
                                      (na.z + nb.z) / 2), 1)
        return out

    def station_samples(self) -> List[dict]:
        """Current samples, for clients that interpolate the field themselves."""
        now = clock.now()
        out = [
            {"station_id": sid, "x": s.x, "y": s.y, "z": s.z,
             "visibility_m": round(s.visibility_m, 1), "source": s.source,
             "age_s": round(now - s.t, 1)}
            for sid, s in self.samples.items()
        ]
        fresh = [o for o in out if o["age_s"] <= SENSOR_STALE_S]
        return fresh if fresh else out

    def is_stale(self) -> bool:
        """True when no station has reported inside the staleness window."""
        now = clock.now()
        return not any(now - s.t <= SENSOR_STALE_S for s in self.samples.values())

    def site_worst(self) -> float:
        seg = self.per_segment()
        return min(seg.values()) if seg else 1000.0

    # ------------------------------------------------------------------
    def safe_speed_ms(self, x: float, y: float, z: float, edge_id: Optional[str],
                      loaded: bool, twin_healthy: bool) -> float:
        """
        min(segment class, curvature limit, sight-stopping limit).

        The sight-stopping term is the interesting one. Classically you must be
        able to stop within the distance you can *see*. With the twin, the road
        ahead is known from survey, so the binding constraint is the distance
        over which the twin can promise the corridor is clear — not the fog. We
        therefore use the twin horizon when the twin is healthy, and fall back to
        raw optical visibility when it is not. That fallback is what makes the
        degraded modes safe rather than merely slower.
        """
        limit = config.SPEED_CEIL_MS

        if edge_id and edge_id in self.graph.edges:
            e = self.graph.edges[edge_id]
            limit = min(limit, e.speed_class_kmh / 3.6)
            curve = self.graph.curvature_at(edge_id)
            if curve > 0.35:
                limit = min(limit, 8.0)
            if curve > 0.9:                    # switchback
                limit = min(limit, 4.5)
            if e.gradient < -0.06 and loaded:  # loaded, descending
                limit = min(limit, 7.0)

        sight_m = 120.0 if twin_healthy else self.at(x, y, z)
        decel = config.DECEL_LOADED_MS2
        # v such that v * t_react + v^2 / (2a) <= sight
        a, b, c = 1.0 / (2 * decel), config.SIGHT_STOP_REACTION_S, -sight_m
        v_sight = (-b + math.sqrt(b * b - 4 * a * c)) / (2 * a)
        limit = min(limit, v_sight)

        return max(config.SPEED_FLOOR_MS, min(limit, config.SPEED_CEIL_MS))


# --------------------------------------------------------------------------
# Fog nowcaster — interface stub.
#
# Production model is LightGBM per station on dry-bulb minus dew-point spread
# and its rate of change, RH trajectory, wind, elevation, hour of day, and the
# previous 3 h of visibility, trained on IMD Kirandul history. Until that is
# trained, this physical heuristic gives an honest, explainable baseline that
# already tracks radiation fog well enough to demo.
# --------------------------------------------------------------------------

def nowcast_probability(met: MetReading, horizon_min: int = 30) -> float:
    """P(visibility < 50 m at station within `horizon_min`). 0..1."""
    if met.temp_c is None or met.dewpoint_c is None:
        return 0.0
    spread = met.temp_c - met.dewpoint_c
    # spread below ~2 C with light wind is the classic radiation-fog signature
    p = max(0.0, min(1.0, (2.5 - spread) / 2.5))
    wind = met.wind_ms if met.wind_ms is not None else 1.0
    if wind > 4.0:
        p *= 0.35                      # mixing disperses it
    elif wind < 1.0:
        p = min(1.0, p * 1.25)
    if met.visibility_m < 200:
        p = min(1.0, p + 0.25)         # already deteriorating
    p *= {15: 0.85, 30: 1.0, 60: 0.75}.get(horizon_min, 1.0)
    return round(min(1.0, p), 2)
