"""
THE FROZEN CONTRACT.

Every byte that crosses between a vehicle, a roadside unit, and the twin is one
of these models. Agree this in hour one and do not change it after; every
hackathon integration disaster traces back to a schema that moved at 3 a.m.

Coordinates are local ENU metres from the origin in twin/config.py.
Angles are radians, 0 = east, counter-clockwise positive.
Timestamps are float seconds, UTC epoch. Vehicles that lack a clock may send
t = 0 and the twin will stamp arrival time.
"""

from __future__ import annotations

from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


# --------------------------------------------------------------------------
# Topic map. Keep the string builders here so nobody hand-writes a topic.
# --------------------------------------------------------------------------

TOPIC_PREFIX = "mine/v1"


def topic_state(vehicle_id: str) -> str:
    return f"{TOPIC_PREFIX}/vehicle/{vehicle_id}/state"


def topic_detections(vehicle_id: str) -> str:
    return f"{TOPIC_PREFIX}/vehicle/{vehicle_id}/detections"


def topic_advisory(vehicle_id: str) -> str:
    return f"{TOPIC_PREFIX}/vehicle/{vehicle_id}/advisory"


def topic_met(station_id: str) -> str:
    return f"{TOPIC_PREFIX}/env/{station_id}/met"


TOPIC_STATE_WILDCARD = f"{TOPIC_PREFIX}/vehicle/+/state"
TOPIC_DETECTIONS_WILDCARD = f"{TOPIC_PREFIX}/vehicle/+/detections"
TOPIC_MET_WILDCARD = f"{TOPIC_PREFIX}/env/+/met"


# --------------------------------------------------------------------------
# Enums
# --------------------------------------------------------------------------

class VehicleClass(str, Enum):
    DUMPER = "dumper"
    SHOVEL = "shovel"
    DOZER = "dozer"
    LIGHT_VEHICLE = "light_vehicle"
    AMBULANCE = "ambulance"
    PERSON = "person"


class AlertLevel(str, Enum):
    """The alert ladder from the blueprint. Ordered; compare by rank()."""
    INFO = "info"
    ADVISORY = "advisory"
    CAUTION = "caution"
    WARNING = "warning"
    INTERVENE = "intervene"

    def rank(self) -> int:
        return _ALERT_RANK[self]


_ALERT_RANK = {
    AlertLevel.INFO: 0,
    AlertLevel.ADVISORY: 1,
    AlertLevel.CAUTION: 2,
    AlertLevel.WARNING: 3,
    AlertLevel.INTERVENE: 4,
}


class Mode(str, Enum):
    """Degradation mode, decided by the twin per vehicle."""
    A_NOMINAL = "A"
    B_DEGRADED = "B"
    C_ISLANDED = "C"
    D_FAULT = "D"


class TokenState(str, Enum):
    GRANTED = "granted"
    HELD = "held"       # queued, must stop at the hold point
    NONE = "none"


# --------------------------------------------------------------------------
# Uplink: vehicle -> twin
# --------------------------------------------------------------------------

class VehicleState(BaseModel):
    """5 Hz pose beacon. The single most important message in the system."""

    vehicle_id: str
    t: float = 0.0
    x: float                                   # ENU east, metres
    y: float                                   # ENU north, metres
    z: float = 0.0                             # ENU up, metres
    heading: float = 0.0                       # radians, 0 = east
    speed: float = 0.0                         # m/s along heading
    vclass: VehicleClass = VehicleClass.DUMPER
    loaded: bool = False
    payload_t: float = 0.0                     # tonnes
    pos_conf: float = 0.03                     # 1-sigma position error, metres
    vis_est: Optional[float] = None            # vehicle-derived visibility, metres
    operator_id: Optional[str] = None
    emergency: bool = False


class Attitude(BaseModel):
    """
    Which way up a machine is, straight off its IMU.

    Not part of the pose beacon: a dumper's attitude is telemetry for a
    dashboard and for detecting a tip-over, whereas VehicleState is the message
    the interlocking runs on. Keeping them apart means a node can publish one
    without implementing the other.

    Pitch and roll come from the gravity vector and are absolute -- they do not
    drift. Yaw is integrated from the gyro and does, which is why it is reported
    beside them rather than mixed in.
    """

    vehicle_id: str
    t: float = 0.0
    pitch_deg: float = 0.0                     # nose up positive
    roll_deg: float = 0.0                      # right side down positive
    yaw_deg: float = 0.0                       # integrated, drifts
    ax: float = 0.0                            # g, vehicle frame
    ay: float = 0.0
    az: float = 0.0
    gx: float = 0.0                            # deg/s
    gy: float = 0.0
    gz: float = 0.0
    temp_c: Optional[float] = None             # the MPU-6050 die, near enough


class RadarTrack(BaseModel):
    """One tracked object from the on-vehicle radar/thermal fusion."""

    track_id: int
    rel_x: float                               # metres, vehicle frame, forward
    rel_y: float                               # metres, vehicle frame, left
    rel_vx: float = 0.0                        # m/s
    rel_vy: float = 0.0
    rcs: float = 0.0                           # radar cross-section, dBsm
    thermal: bool = False                      # confirmed warm body
    vclass: VehicleClass = VehicleClass.DUMPER
    conf: float = 0.5


class DetectionSet(BaseModel):
    vehicle_id: str
    t: float = 0.0
    tracks: List[RadarTrack] = Field(default_factory=list)


class Proximity(BaseModel):
    """
    Short-range obstacle distance from an ultrasonic sensor.

    Its own message, and never a RadarTrack. An HC-SR04 is a pressure wave in
    air: it is a genuine close-in proximity aid, of the kind haul trucks
    already carry for reversing, and it is also everything radar is not. It
    reaches a few metres, sees only what is directly in front of it, cannot
    tell you what it found or how fast that thing is closing, and it is
    stopped dead by the first solid object -- so it can never see around the
    bend that hides the machine you needed to know about.

    Those limits are why this exists as a separate message. Published as a
    radar track it would quietly inherit radar's claims; published as
    proximity it stays exactly what it is, and the gap between the four metres
    it reaches and the two hundred and fifty the twin already knows about is
    the clearest single argument the project has.
    """

    vehicle_id: str
    t: float = 0.0
    range_m: Optional[float] = None            # None == nothing within reach
    max_range_m: float = 4.0                   # datasheet ceiling for HC-SR04
    cone_deg: float = 15.0                     # roughly the -6 dB beam width
    sensor: str = "ultrasonic"


class NodeReport(BaseModel):
    """
    Everything one vehicle has to say this tick, in a single envelope.

    Purely a transport container. Each field is the same model the dedicated
    endpoint takes, and the twin routes them to the same stores, so nothing
    downstream can tell whether a message arrived here or on its own endpoint.
    It exists because four HTTP round trips per tick held an ESP32 to a quarter
    of a hertz, and a dashboard that lags a second behind the hand waving at it
    is not evidence of anything.

    Every field is optional: a node sends what it has.
    """

    state: Optional[VehicleState] = None
    attitude: Optional[Attitude] = None
    proximity: Optional[Proximity] = None
    detections: Optional[DetectionSet] = None


class MetReading(BaseModel):
    """Micro-met station. Ground truth for the visibility field."""

    station_id: str
    t: float = 0.0
    x: float
    y: float
    z: float = 0.0
    visibility_m: float                        # forward-scatter sensor
    temp_c: Optional[float] = None
    dewpoint_c: Optional[float] = None
    rh_pct: Optional[float] = None
    wind_ms: Optional[float] = None
    rain_mmhr: Optional[float] = None


# --------------------------------------------------------------------------
# Downlink: twin -> vehicle
# --------------------------------------------------------------------------

class Neighbour(BaseModel):
    """What the twin knows that this vehicle's own sensors cannot see."""

    vehicle_id: str
    x: float
    y: float
    z: float = 0.0
    heading: float = 0.0
    speed: float = 0.0
    vclass: VehicleClass = VehicleClass.DUMPER
    loaded: bool = False
    range_m: float                             # from the receiving vehicle
    bearing_rad: float                         # relative to receiver heading
    closing_ms: float                          # positive = closing
    ttc_s: Optional[float] = None
    miss_m: float = 1e6                        # separation at closest approach
    age_s: float = 0.0                         # staleness -> uncertainty ellipse
    uncertainty_m: float = 0.5                 # render radius, grows with age
    around_corner: bool = False                # not line-of-sight; twin-only knowledge


class TokenGrant(BaseModel):
    zone_id: str
    state: TokenState
    queue_pos: int = 0
    expires_in_s: float = 0.0                  # lease. Expiry means NO ENTRY.
    hold_x: Optional[float] = None             # where to stop if held
    hold_y: Optional[float] = None
    hold_dist_m: Optional[float] = None


class Advisory(BaseModel):
    """The 5 Hz downlink. Everything the cab needs for one frame."""

    vehicle_id: str
    t: float
    # the twin's own estimate of the receiver's pose — echoed back so the cab
    # can render the corridor even if its local fix has degraded
    ego_x: float = 0.0
    ego_y: float = 0.0
    ego_z: float = 0.0
    ego_heading: float = 0.0
    mode: Mode = Mode.A_NOMINAL
    alert: AlertLevel = AlertLevel.INFO
    alert_reason: str = ""
    speed_advisory_ms: float = 11.0            # segment safe speed
    segment_id: Optional[str] = None
    visibility_m: float = 1000.0               # at this vehicle's position
    neighbours: List[Neighbour] = Field(default_factory=list)
    token: Optional[TokenGrant] = None
    corridor: List[List[float]] = Field(default_factory=list)
    # corridor = [[x, y, z, half_width], ...] ahead of the vehicle, from the
    # twin's surveyed geometry. This is what the HUD draws as the road. It is
    # produced from the map, never from a camera — that is the whole idea.


# --------------------------------------------------------------------------
# Twin -> control room (WebSocket)
# --------------------------------------------------------------------------

class ZoneStatus(BaseModel):
    zone_id: str
    name: str
    capacity: int
    holder: Optional[str] = None
    queue: List[str] = Field(default_factory=list)
    lease_left_s: float = 0.0


class Event(BaseModel):
    t: float
    kind: str                                  # near_miss | token | mode | alert
    level: AlertLevel = AlertLevel.INFO
    vehicle_id: Optional[str] = None
    text: str = ""


class WorldSnapshot(BaseModel):
    """One frame of the whole twin, pushed to the control room at 5 Hz."""

    t: float
    vehicles: List[VehicleState] = Field(default_factory=list)
    modes: dict = Field(default_factory=dict)          # vehicle_id -> Mode
    alerts: dict = Field(default_factory=dict)         # vehicle_id -> AlertLevel
    ages: dict = Field(default_factory=dict)           # vehicle_id -> seconds
    zones: List[ZoneStatus] = Field(default_factory=list)
    visibility: dict = Field(default_factory=dict)     # segment_id -> metres
    stations: List[dict] = Field(default_factory=list) # met samples, for the
    # client-side fog field: [{station_id, x, y, z, visibility_m}, ...]. The 3D
    # view interpolates these itself so the fog blanket moves at frame rate
    # rather than at the twin's 5 Hz tick.
    site_visibility_m: float = 1000.0
    events: List[Event] = Field(default_factory=list)
    stats: dict = Field(default_factory=dict)
