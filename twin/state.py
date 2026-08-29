"""
Fleet state store.

Two ideas carry the safety story here:

1. **Staleness is first-class.** Every track carries an age, and age grows the
   rendered uncertainty. A twin that lags is a twin that lies, so the HUD shows
   a widening dashed ellipse rather than a crisp icon that is quietly wrong.

2. **Dead reckoning on the road graph.** When a vehicle goes quiet we do not
   freeze it; we propagate it along the surveyed corridor at its last speed.
   That is a far better prior than "it stopped where I last saw it".
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from schema.messages import DetectionSet, Mode, VehicleState

from . import clock, config
from .roadgraph import RoadGraph


@dataclass
class Track:
    state: VehicleState
    last_rx: float                       # wall clock of last real message
    detections: Optional[DetectionSet] = None
    dr_x: float = 0.0                    # dead-reckoned position
    dr_y: float = 0.0
    dr_z: float = 0.0
    dr_heading: float = 0.0

    @property
    def age(self) -> float:
        return clock.now() - self.last_rx

    @property
    def uncertainty_m(self) -> float:
        """1-sigma, grown by staleness. Speed makes an unheard vehicle vaguer."""
        drift = self.age * max(1.0, self.state.speed) * 0.35
        return self.state.pos_conf + drift

    def mode(self) -> Mode:
        if self.state.pos_conf > config.POS_CONF_FAULT_M:
            return Mode.D_FAULT
        a = self.age
        if a > config.AGE_ISLANDED_S:
            return Mode.C_ISLANDED
        if a > config.AGE_DEGRADED_S:
            return Mode.B_DEGRADED
        return Mode.A_NOMINAL


class FleetState:
    def __init__(self, graph: RoadGraph) -> None:
        self.graph = graph
        self.tracks: Dict[str, Track] = {}

    # ------------------------------------------------------------------
    def ingest_state(self, msg: VehicleState) -> None:
        now = clock.now()
        if msg.t <= 0:
            msg.t = now
        tr = self.tracks.get(msg.vehicle_id)
        if tr is None:
            tr = Track(state=msg, last_rx=now)
            self.tracks[msg.vehicle_id] = tr
        else:
            tr.state = msg
            tr.last_rx = now
        tr.dr_x, tr.dr_y, tr.dr_z = msg.x, msg.y, msg.z
        tr.dr_heading = msg.heading

    def ingest_detections(self, msg: DetectionSet) -> None:
        tr = self.tracks.get(msg.vehicle_id)
        if tr is not None:
            tr.detections = msg

    # ------------------------------------------------------------------
    def tick(self) -> None:
        """Advance dead reckoning and forget vehicles that are long gone."""
        drop = []
        for vid, tr in self.tracks.items():
            if tr.age > config.AGE_DROP_S:
                drop.append(vid)
                continue
            if tr.age <= config.TICK_DT:
                continue
            # propagate along the corridor rather than in a straight line
            step = tr.state.speed * config.TICK_DT
            if step <= 0.01:
                continue
            corr = self.graph.corridor_ahead(tr.dr_x, tr.dr_y, tr.dr_heading,
                                             horizon_m=max(step * 2, 20.0), step_m=6.0)
            if corr:
                tx, ty = corr[0][0], corr[0][1]
                d = math.hypot(tx - tr.dr_x, ty - tr.dr_y)
                if d > 0.01:
                    tr.dr_heading = math.atan2(ty - tr.dr_y, tx - tr.dr_x)
            tr.dr_x += math.cos(tr.dr_heading) * step
            tr.dr_y += math.sin(tr.dr_heading) * step
        for vid in drop:
            del self.tracks[vid]

    # ------------------------------------------------------------------
    def position(self, vid: str) -> Optional[tuple[float, float, float, float]]:
        """Best current estimate: (x, y, z, heading). Dead-reckoned if stale."""
        tr = self.tracks.get(vid)
        if tr is None:
            return None
        if tr.age <= config.AGE_DEGRADED_S:
            s = tr.state
            return s.x, s.y, s.z, s.heading
        return tr.dr_x, tr.dr_y, tr.dr_z, tr.dr_heading

    def all_tracks(self) -> List[Track]:
        return list(self.tracks.values())

    def active_ids(self) -> List[str]:
        """Vehicles the twin will arbitrate for. Islanded vehicles are excluded
        from token allocation — we cannot promise anything to a truck we cannot
        hear, and pretending otherwise is how interlocking systems kill people."""
        return [
            vid for vid, tr in self.tracks.items()
            if tr.age <= config.AGE_ISLANDED_S
            and tr.state.pos_conf <= config.POS_CONF_FAULT_M
        ]

    def snapshot_states(self) -> List[VehicleState]:
        """States with dead-reckoned positions folded in, for the control room."""
        out: List[VehicleState] = []
        for tr in self.tracks.values():
            s = tr.state.model_copy()
            if tr.age > config.AGE_DEGRADED_S:
                s.x, s.y, s.z, s.heading = tr.dr_x, tr.dr_y, tr.dr_z, tr.dr_heading
            out.append(s)
        return out
