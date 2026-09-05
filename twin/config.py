"""Site constants and the geodetic origin. Everything internal is ENU metres."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
WEB_DIR = ROOT / "web"
ROADGRAPH_PATH = DATA_DIR / "roadgraph.json"
HARDWARE_PATH = DATA_DIR / "hardware.json"
EXPERIMENT_PATH = DATA_DIR / "experiment.json"
DEM_META_PATH = DATA_DIR / "dem" / "bailadila.json"
DEM_BIN_PATH = DATA_DIR / "dem" / "bailadila.bin"

# The ENU origin is the ridge crest of Bailadila Deposit 14, read from the road
# graph so there is exactly one source of truth. scripts/build_roadgraph.py
# derives it from the DEM; swap in NMDC's surveyed control point by replacing
# data/roadgraph.json and nothing else.
def _origin() -> tuple[float, float, float]:
    try:
        with open(ROADGRAPH_PATH, "r", encoding="utf-8") as fh:
            o = json.load(fh).get("origin", {})
        return o.get("lat", 18.66), o.get("lon", 81.23), o.get("alt_m", 1266.0)
    except (OSError, ValueError):
        return 18.66, 81.23, 1266.0


ORIGIN_LAT, ORIGIN_LON, ORIGIN_ALT = _origin()

TICK_HZ = 5.0
TICK_DT = 1.0 / TICK_HZ

# --- staleness thresholds, drive the degradation modes -------------------
AGE_DEGRADED_S = 2.0        # -> Mode B
AGE_ISLANDED_S = 8.0        # -> Mode C
AGE_DROP_S = 60.0           # forget the vehicle entirely
POS_CONF_FAULT_M = 1.0      # -> Mode D

# --- token allocator ------------------------------------------------------
TOKEN_LEASE_S = 15.0        # fail-closed: no renewal means no entry
TOKEN_RENEW_S = 5.0

# --- alert ladder, seconds of time-to-collision --------------------------
TTC_CAUTION_S = 15.0
TTC_WARNING_S = 8.0
TTC_INTERVENE_S = 3.0
NEIGHBOUR_RADIUS_M = 250.0  # what the twin tells you about
# Separation at closest approach below which a pair counts as a conflict. A
# haul road is ~24 m wide, so anything passing wider than this is traffic, not
# a threat — gating on this is what keeps the alert ladder credible.
MISS_DISTANCE_M = 18.0

# --- speed policy ---------------------------------------------------------
# Safe speed is min(segment class, visibility-derived, curvature-derived).
# Visibility rule: you must be able to stop within what you can see. With the
# twin the "seen" distance is the twin's horizon, not the fog's — but we keep a
# conservative floor so the system degrades sensibly if the twin is stale.
SIGHT_STOP_REACTION_S = 1.5
DECEL_LOADED_MS2 = 1.2      # a loaded dumper on wet laterite. Deliberately low.
SPEED_FLOOR_MS = 1.4        # ~5 km/h crawl
SPEED_CEIL_MS = 12.0        # ~43 km/h

# Vehicle-id prefixes that identify a bench prototype rather than a machine in
# the pit. They are full participants in the twin -- they publish, they are
# given advisories and conflict-zone leases, and they obey them -- but they are
# hidden from the control room and the cab HUD, which exist to show a
# controller real traffic.
PROTOTYPE_PREFIXES = ("RV-",)


def is_prototype(vehicle_id: str) -> bool:
    return vehicle_id.startswith(PROTOTYPE_PREFIXES)


# --- environment ----------------------------------------------------------
ENABLE_SIM = os.environ.get("FOGTWIN_SIM", "1") != "0"
SIM_FLEET_SIZE = int(os.environ.get("FOGTWIN_FLEET", "6"))
MQTT_HOST = os.environ.get("FOGTWIN_MQTT", "")
MQTT_PORT = int(os.environ.get("FOGTWIN_MQTT_PORT", "1883"))
# Render, Railway, Fly and most PaaS hosts inject PORT and expect the app
# to bind it; FOGTWIN_PORT stays as a manual override for local runs.
HTTP_PORT = int(os.environ.get("PORT", os.environ.get("FOGTWIN_PORT", "8000")))

_R_EARTH = 6378137.0


def enu_to_lonlat(x: float, y: float) -> tuple[float, float]:
    """ENU metres -> (lon, lat) degrees. Flat-earth is fine over a 2 km pit."""
    lat = ORIGIN_LAT + math.degrees(y / _R_EARTH)
    lon = ORIGIN_LON + math.degrees(x / (_R_EARTH * math.cos(math.radians(ORIGIN_LAT))))
    return lon, lat


def lonlat_to_enu(lon: float, lat: float) -> tuple[float, float]:
    y = math.radians(lat - ORIGIN_LAT) * _R_EARTH
    x = math.radians(lon - ORIGIN_LON) * _R_EARTH * math.cos(math.radians(ORIGIN_LAT))
    return x, y
