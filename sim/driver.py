"""
Fleet simulator.

Not a toy: it drives virtual dumpers around the *real* road graph, obeys the
twin's speed advisories, and stops at hold points when its token is denied. That
means the control room and the HUD are populated and stress-tested from hour one,
before a single rover exists — and when real rovers arrive they publish the same
schema and mix in seamlessly.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from schema.messages import Advisory, TokenState, VehicleClass, VehicleState

from twin import clock
from twin.roadgraph import RoadGraph


def _cycles(graph: RoadGraph) -> List[List[str]]:
    """
    Haul cycles as node sequences, routed by the graph itself.

    Reading the endpoints from roadgraph.json and shortest-pathing between them
    means the simulator survives a change of mine layout — when NMDC's real
    survey replaces the generated network, nothing here needs editing.
    """
    out: List[List[str]] = []
    for spec in getattr(graph, "cycles", []) or []:
        path = graph.route(spec.get("from", ""), spec.get("to", ""))
        if len(path) > 1:
            out.append(path)
    if not out:                       # fall back to the two extreme nodes
        ids = list(graph.nodes)
        out.append(graph.route(ids[0], ids[-1]))
    return out


@dataclass
class SimVehicle:
    vehicle_id: str
    route: List[str]
    idx: int = 0                 # index of the edge we are on within the route
    s: float = 0.0               # metres along that edge
    speed: float = 4.0
    loaded: bool = True
    forward: bool = True         # travelling route order, or reversed
    dwell_until: float = 0.0     # loading / tipping pause
    pos_conf: float = 0.03

    x: float = 0.0
    y: float = 0.0
    z: float = 0.0
    heading: float = 0.0


class SimFleet:
    def __init__(self, graph: RoadGraph, size: int = 6, seed: int = 7) -> None:
        self.graph = graph
        self.rng = random.Random(seed)
        self.cycles = _cycles(graph)
        self.vehicles: List[SimVehicle] = []
        for i in range(size):
            route = self.cycles[i % len(self.cycles)]
            v = SimVehicle(
                vehicle_id=f"DT-{101 + i}",
                route=list(route),
                # spread the fleet around the cycle so they do not all spawn
                # nose to tail in the loading bay
                idx=int((i / max(1, size)) * (len(route) - 1)),
                s=self.rng.uniform(0, 40),
                loaded=self.rng.random() < 0.5,
            )
            self.vehicles.append(v)
            self._place(v)

    # ------------------------------------------------------------------
    def _edge_for(self, v: SimVehicle):
        a = v.route[v.idx]
        b = v.route[v.idx + 1]
        if not v.forward:
            a, b = b, a
        e = self.graph.edge_between(a, b)
        return e, a, b

    def _place(self, v: SimVehicle) -> None:
        e, a, b = self._edge_for(v)
        if e is None:
            return
        na, nb = self.graph.nodes[a], self.graph.nodes[b]
        t = min(1.0, v.s / e.length) if e.length else 0.0
        v.x = na.x + t * (nb.x - na.x)
        v.y = na.y + t * (nb.y - na.y)
        v.z = na.z + t * (nb.z - na.z)
        v.heading = math.atan2(nb.y - na.y, nb.x - na.x)

    # ------------------------------------------------------------------
    def step(self, dt: float, advisories: Optional[Dict[str, Advisory]] = None) -> None:
        advisories = advisories or {}
        now = clock.now()

        for v in self.vehicles:
            if now < v.dwell_until:
                v.speed = 0.0
                continue

            adv = advisories.get(v.vehicle_id)
            target = adv.speed_advisory_ms if adv else 8.0

            # obey a denied token: decelerate to a stop at the hold point
            if adv and adv.token and adv.token.state == TokenState.HELD:
                d = adv.token.hold_dist_m
                if d is not None:
                    target = min(target, max(0.0, (d - 8.0) * 0.35))

            # emergency response to an intervene-level alert
            if adv and adv.alert.value == "intervene":
                target = min(target, 1.0)

            # first-order approach to target speed, asymmetric like a real dumper
            accel = 0.6 if target > v.speed else 1.4
            v.speed += max(-accel * dt, min(accel * dt, target - v.speed))
            v.speed = max(0.0, v.speed)

            e, _a, _b = self._edge_for(v)
            if e is None:
                continue
            v.s += v.speed * dt

            while e is not None and v.s >= e.length:
                v.s -= e.length
                self._advance(v)
                e, _a, _b = self._edge_for(v)

            self._place(v)

    def _advance(self, v: SimVehicle) -> None:
        """Move to the next edge, reversing and swapping load state at the ends."""
        last = len(v.route) - 2
        if v.forward:
            if v.idx >= last:
                v.forward = False
                v.idx = last
                v.loaded = False
                v.dwell_until = clock.now() + self.rng.uniform(12, 25)   # tipping
            else:
                v.idx += 1
        else:
            if v.idx <= 0:
                v.forward = True
                v.idx = 0
                v.loaded = True
                v.dwell_until = clock.now() + self.rng.uniform(20, 40)   # loading
            else:
                v.idx -= 1

    # ------------------------------------------------------------------
    def states(self) -> List[VehicleState]:
        now = clock.now()
        return [
            VehicleState(
                vehicle_id=v.vehicle_id, t=now,
                x=round(v.x, 2), y=round(v.y, 2), z=round(v.z, 2),
                heading=round(v.heading, 4), speed=round(v.speed, 2),
                vclass=VehicleClass.DUMPER, loaded=v.loaded,
                payload_t=92.0 if v.loaded else 0.0,
                pos_conf=v.pos_conf,
                operator_id=f"OP-{v.vehicle_id[-3:]}",
            )
            for v in self.vehicles
        ]
