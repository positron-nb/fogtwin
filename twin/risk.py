"""
Collision risk and the alert ladder.

Deliberately **not** a learned model. Braking and warning decisions come from
geometry and kinematics you can write on a whiteboard; ML in this system handles
perception, estimation and scheduling only. A mining audience trusts a system
whose stop decision is a physics calculation far more than one whose stop
decision is a neural network's opinion — and so does a regulator.
"""

from __future__ import annotations

import math
from typing import List, Optional, Tuple

from schema.messages import AlertLevel, Neighbour, VehicleState

from . import config
from .roadgraph import RoadGraph
from .state import FleetState, Track


def _wrap(a: float) -> float:
    return math.atan2(math.sin(a), math.cos(a))


def closest_approach(
    ax: float, ay: float, a_heading: float, a_speed: float,
    bx: float, by: float, b_heading: float, b_speed: float,
) -> Tuple[float, Optional[float], float]:
    """
    (range_m, ttc_s, miss_m) under constant velocity.

    `miss_m` is the separation at closest approach and it is not optional
    decoration: two dumpers on different benches can have a small time to
    closest approach while passing 200 m apart. Alerting on ttc alone produces
    exactly the kind of false intervention that makes operators switch a safety
    system off, so every threat test gates on miss distance as well.
    """
    rx, ry = bx - ax, by - ay
    rng = math.hypot(rx, ry)
    vx = b_speed * math.cos(b_heading) - a_speed * math.cos(a_heading)
    vy = b_speed * math.sin(b_heading) - a_speed * math.sin(a_heading)
    vv = vx * vx + vy * vy
    if vv < 1e-6:
        return rng, None, rng
    t = -(rx * vx + ry * vy) / vv
    if t <= 0:
        return rng, None, rng
    miss = math.hypot(rx + vx * t, ry + vy * t)
    return rng, t, miss


def closing_speed(ax: float, ay: float, a_heading: float, a_speed: float,
                  bx: float, by: float, b_heading: float, b_speed: float) -> float:
    rx, ry = bx - ax, by - ay
    rng = math.hypot(rx, ry) or 1e-6
    ux, uy = rx / rng, ry / rng
    vx = b_speed * math.cos(b_heading) - a_speed * math.cos(a_heading)
    vy = b_speed * math.sin(b_heading) - a_speed * math.sin(a_heading)
    return -(vx * ux + vy * uy)          # positive = closing


def neighbours_for(
    ego: Track, fleet: FleetState, graph: RoadGraph,
    radius_m: float = config.NEIGHBOUR_RADIUS_M,
) -> List[Neighbour]:
    """
    What the twin knows that the ego vehicle's own sensors cannot see.

    `around_corner` is the field to render most prominently in the cab: it marks
    a vehicle with no line of sight, which is knowledge no on-board sensor could
    ever produce. It is also the single most persuasive thing on the HUD.
    """
    pos = fleet.position(ego.state.vehicle_id)
    if pos is None:
        return []
    ax, ay, _az, ah = pos
    out: List[Neighbour] = []

    for tr in fleet.all_tracks():
        if tr.state.vehicle_id == ego.state.vehicle_id:
            continue
        p = fleet.position(tr.state.vehicle_id)
        if p is None:
            continue
        bx, by, bz, bh = p
        rng, ttc, miss = closest_approach(ax, ay, ah, ego.state.speed,
                                          bx, by, bh, tr.state.speed)
        if rng > radius_m:
            continue
        out.append(Neighbour(
            vehicle_id=tr.state.vehicle_id,
            x=bx, y=by, z=bz, heading=bh, speed=tr.state.speed,
            vclass=tr.state.vclass, loaded=tr.state.loaded,
            range_m=round(rng, 1),
            bearing_rad=round(_wrap(math.atan2(by - ay, bx - ax) - ah), 3),
            closing_ms=round(closing_speed(ax, ay, ah, ego.state.speed,
                                           bx, by, bh, tr.state.speed), 2),
            ttc_s=round(ttc, 1) if ttc is not None else None,
            miss_m=round(miss, 1),
            age_s=round(tr.age, 2),
            uncertainty_m=round(tr.uncertainty_m, 2),
            around_corner=not graph.line_of_sight(ax, ay, bx, by),
        ))

    out.sort(key=lambda n: (n.ttc_s if n.ttc_s is not None else 1e9, n.range_m))
    return out


def alert_for(
    ego: Track,
    neighbours: List[Neighbour],
    off_road: bool,
    token_held: bool,
    hold_dist_m: Optional[float],
    speed_advisory_ms: float,
    mode_fault: bool,
) -> Tuple[AlertLevel, str]:
    """The ladder from the blueprint, in priority order."""

    if mode_fault:
        return AlertLevel.WARNING, "position confidence lost - proceed to nearest safe bay"

    if off_road:
        return AlertLevel.WARNING, "berm departure predicted - correct right"

    # imminent conflict dominates everything
    for n in neighbours:
        if n.ttc_s is None or n.closing_ms <= 0.2:
            continue
        if n.miss_m > config.MISS_DISTANCE_M:
            continue                     # passes wide - not a conflict
        side = "ahead" if abs(n.bearing_rad) < 0.6 else (
            "left" if n.bearing_rad > 0 else "right")
        if n.ttc_s < config.TTC_INTERVENE_S:
            return AlertLevel.INTERVENE, f"{n.vehicle_id} {side}, {n.range_m:.0f} m - throttle cut"
        if n.ttc_s < config.TTC_WARNING_S:
            return AlertLevel.WARNING, f"{n.vehicle_id} {side}, {n.range_m:.0f} m"
        if n.ttc_s < config.TTC_CAUTION_S:
            corner = " around bend" if n.around_corner else ""
            return AlertLevel.CAUTION, f"{n.vehicle_id} closing{corner}, {n.range_m:.0f} m"

    if token_held:
        d = f", hold in {hold_dist_m:.0f} m" if hold_dist_m is not None else ""
        return AlertLevel.CAUTION, f"zone occupied - stop at hold point{d}"

    if ego.state.speed > speed_advisory_ms * 1.15:
        return AlertLevel.ADVISORY, f"over advisory speed ({speed_advisory_ms * 3.6:.0f} km/h)"

    if neighbours:
        return AlertLevel.INFO, f"{len(neighbours)} vehicle(s) within 250 m"

    return AlertLevel.INFO, "clear"


def is_near_miss(alert: AlertLevel, neighbours: List[Neighbour]) -> bool:
    """Worth writing a replay record for: 60 s before, 30 s after."""
    if alert.rank() < AlertLevel.WARNING.rank():
        return False
    return any(n.ttc_s is not None and n.ttc_s < config.TTC_WARNING_S
               and n.miss_m <= config.MISS_DISTANCE_M for n in neighbours)
