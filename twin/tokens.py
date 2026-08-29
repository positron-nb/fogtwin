"""
Conflict-zone token allocator — the signature feature.

Borrowed from railway interlocking and airport surface movement control. Every
place two vehicles can occupy conflicting space (single-lane ramp, blind bend,
tip point, loading bay) is a resource with a capacity, usually one. Right of way
is *granted*, never guessed.

Two properties do the real work:

* **Fail-closed.** A grant is a short lease that must be renewed. Losing comms
  cannot give you a zone, it can only take one away. Exactly the failure
  philosophy of railway signalling.

* **Collision avoidance becomes scheduling.** Two dumpers never need to see each
  other if they were never permitted into the same space. Fog is irrelevant to a
  scheduler — that is the whole point.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from schema.messages import TokenGrant, TokenState, VehicleClass, ZoneStatus

from . import clock, config
from .roadgraph import RoadGraph


# A grant issued on approach is reclaimed if the holder never arrives — a
# stopped or diverted dumper must not block a ramp indefinitely.
APPROACH_TIMEOUT_S = 90.0


@dataclass
class _Lease:
    vehicle_id: str
    granted_at: float
    expires_at: float
    entered: bool = False        # has the holder actually reached the zone yet?


@dataclass
class _Request:
    vehicle_id: str
    base_priority: float                 # from vehicle attributes, static
    distance_m: float
    requested_at: float
    hold_point: Tuple[float, float]

    def priority(self, now: float) -> float:
        """Base plus a waiting bonus, so nobody starves at a busy junction."""
        return self.base_priority + min(now - self.requested_at, 120.0) * 0.5


class TokenAllocator:
    def __init__(self, graph: RoadGraph) -> None:
        self.graph = graph
        self.leases: Dict[str, List[_Lease]] = {z: [] for z in graph.zones}
        self.queues: Dict[str, List[_Request]] = {z: [] for z in graph.zones}
        self.events: List[str] = []

    # ------------------------------------------------------------------
    @staticmethod
    def base_priority(loaded: bool, gradient: float, vclass: VehicleClass,
                      emergency: bool) -> float:
        """
        Higher wins. The ordering encodes real haulage practice: emergency
        first, then loaded over empty (restarting 100 t on a wet ramp is both
        slow and dangerous), then uphill over downhill.
        """
        p = 0.0
        if emergency or vclass == VehicleClass.AMBULANCE:
            p += 1000.0
        if loaded:
            p += 50.0
        if gradient > 0.01:          # climbing
            p += 25.0
        if vclass == VehicleClass.LIGHT_VEHICLE:
            p -= 10.0
        return p

    # ------------------------------------------------------------------
    def request(
        self,
        vehicle_id: str,
        zone_id: str,
        distance_m: float,
        hold_point: Tuple[float, float],
        loaded: bool,
        gradient: float,
        vclass: VehicleClass,
        emergency: bool,
    ) -> None:
        if zone_id not in self.queues:
            return
        if self._holds(vehicle_id, zone_id):
            return
        base = self.base_priority(loaded, gradient, vclass, emergency)
        q = self.queues[zone_id]
        for r in q:
            if r.vehicle_id == vehicle_id:
                r.distance_m = distance_m
                r.hold_point = hold_point
                r.base_priority = base
                return
        q.append(_Request(
            vehicle_id=vehicle_id,
            base_priority=base,
            distance_m=distance_m,
            requested_at=clock.now(),
            hold_point=hold_point,
        ))

    def withdraw(self, vehicle_id: str, zone_id: Optional[str] = None) -> None:
        zones = [zone_id] if zone_id else list(self.queues)
        for z in zones:
            self.queues[z] = [r for r in self.queues[z] if r.vehicle_id != vehicle_id]

    def release(self, vehicle_id: str, zone_id: Optional[str] = None) -> None:
        zones = [zone_id] if zone_id else list(self.leases)
        for z in zones:
            before = len(self.leases[z])
            self.leases[z] = [l for l in self.leases[z] if l.vehicle_id != vehicle_id]
            if len(self.leases[z]) != before:
                self.events.append(f"{vehicle_id} released {z}")

    def renew(self, vehicle_id: str, zone_id: str) -> None:
        for l in self.leases.get(zone_id, []):
            if l.vehicle_id == vehicle_id:
                l.expires_at = clock.now() + config.TOKEN_LEASE_S

    # ------------------------------------------------------------------
    def tick(self, occupancy: Dict[str, Optional[str]], active: List[str]) -> None:
        """
        occupancy: vehicle_id -> zone_id it is physically inside (or None)
        active:    vehicles the twin can currently hear
        """
        now = clock.now()

        # 1. expire leases. Fail-closed: no renewal means no entry.
        for zid, leases in self.leases.items():
            keep = []
            for l in leases:
                if l.expires_at <= now:
                    self.events.append(f"{l.vehicle_id} lease expired on {zid} (fail-closed)")
                elif l.vehicle_id not in active:
                    self.events.append(f"{l.vehicle_id} unreachable, {zid} reclaimed")
                else:
                    keep.append(l)
            self.leases[zid] = keep

        # 2. release when the holder has entered and then physically left.
        #    A grant is issued on approach, so we must not reclaim it merely
        #    because the vehicle has not arrived yet — that is the difference
        #    between an interlocking and a race condition.
        for zid, leases in self.leases.items():
            for l in list(leases):
                inside = occupancy.get(l.vehicle_id) == zid
                if inside:
                    l.entered = True
                    l.expires_at = max(l.expires_at, now + config.TOKEN_LEASE_S)
                elif l.entered:
                    self.release(l.vehicle_id, zid)
                elif l.vehicle_id in active and now - l.granted_at <= APPROACH_TIMEOUT_S:
                    # still approaching and still audible: hold the reservation
                    l.expires_at = max(l.expires_at, now + config.TOKEN_LEASE_S)
                elif now - l.granted_at > APPROACH_TIMEOUT_S:
                    self.events.append(f"{l.vehicle_id} never entered {zid}, reclaimed")
                    self.release(l.vehicle_id, zid)

        # 3. grant to the highest-priority waiter while capacity allows
        for zid, q in self.queues.items():
            cap = self.graph.zones[zid].capacity if zid in self.graph.zones else 1
            q[:] = [r for r in q if r.vehicle_id in active]
            q.sort(key=lambda r: (-r.priority(now), r.distance_m))
            while len(self.leases[zid]) < cap and q:
                r = q.pop(0)
                self.leases[zid].append(_Lease(r.vehicle_id, now, now + config.TOKEN_LEASE_S))
                self.events.append(f"{r.vehicle_id} granted {zid}")

    # ------------------------------------------------------------------
    def grant_for(self, vehicle_id: str, zone_id: Optional[str],
                  hold_point: Optional[Tuple[float, float]] = None,
                  hold_dist: Optional[float] = None) -> Optional[TokenGrant]:
        if zone_id is None:
            return None
        if self._holds(vehicle_id, zone_id):
            lease = next(l for l in self.leases[zone_id] if l.vehicle_id == vehicle_id)
            return TokenGrant(
                zone_id=zone_id, state=TokenState.GRANTED,
                expires_in_s=max(0.0, lease.expires_at - clock.now()),
            )
        q = self.queues.get(zone_id, [])
        for i, r in enumerate(q):
            if r.vehicle_id == vehicle_id:
                return TokenGrant(
                    zone_id=zone_id, state=TokenState.HELD, queue_pos=i + 1,
                    hold_x=(hold_point or r.hold_point)[0],
                    hold_y=(hold_point or r.hold_point)[1],
                    hold_dist_m=hold_dist,
                )
        return TokenGrant(zone_id=zone_id, state=TokenState.NONE)

    def holds(self, vehicle_id: str, zone_id: str) -> bool:
        """True if this vehicle currently owns a live lease on the zone."""
        return self._holds(vehicle_id, zone_id)

    def _holds(self, vehicle_id: str, zone_id: str) -> bool:
        return any(l.vehicle_id == vehicle_id for l in self.leases.get(zone_id, []))

    def statuses(self) -> List[ZoneStatus]:
        now = clock.now()
        out = []
        for zid, zone in self.graph.zones.items():
            leases = self.leases.get(zid, [])
            out.append(ZoneStatus(
                zone_id=zid, name=zone.name, capacity=zone.capacity,
                holder=leases[0].vehicle_id if leases else None,
                queue=[r.vehicle_id for r in self.queues.get(zid, [])],
                lease_left_s=max(0.0, leases[0].expires_at - now) if leases else 0.0,
            ))
        return out

    def drain_events(self) -> List[str]:
        out, self.events = self.events, []
        return out
