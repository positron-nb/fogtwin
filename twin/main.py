"""
FogTwin server — ingest, the 5 Hz twin tick, and fan-out to cab and control room.

Run:  python -m twin.main
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
import sys
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

# allow `python -m twin.main` from the repo root without installing
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from schema.messages import (
    Advisory, AlertLevel, DetectionSet, Event, MetReading, Mode,
    TokenState, VehicleState, WorldSnapshot,
)

from . import clock, config
from .risk import alert_for, is_near_miss, neighbours_for
from .roadgraph import load_graph
from .state import FleetState
from .tokens import TokenAllocator
from .visibility import VisibilityField, nowcast_probability

# --------------------------------------------------------------------------
# Twin singletons
# --------------------------------------------------------------------------

GRAPH = load_graph()
FLEET = FleetState(GRAPH)
TOKENS = TokenAllocator(GRAPH)
VIS = VisibilityField(GRAPH)

ADVISORIES: Dict[str, Advisory] = {}
EVENTS: deque[Event] = deque(maxlen=400)
NEAR_MISSES: deque[dict] = deque(maxlen=100)
_near_miss_cooldown: Dict[str, float] = {}

SIM = None
if config.ENABLE_SIM:
    from sim.driver import SimFleet
    SIM = SimFleet(GRAPH, size=config.SIM_FLEET_SIZE)


def log_event(kind: str, text: str, level: AlertLevel = AlertLevel.INFO,
              vehicle_id: Optional[str] = None) -> None:
    EVENTS.append(Event(t=clock.now(), kind=kind, level=level,
                        vehicle_id=vehicle_id, text=text))


# --------------------------------------------------------------------------
# WebSocket hubs
# --------------------------------------------------------------------------

class Hub:
    def __init__(self) -> None:
        self.control: List[WebSocket] = []
        self.hud: Dict[str, List[WebSocket]] = {}

    async def push_control(self, payload: str) -> None:
        for ws in list(self.control):
            try:
                await ws.send_text(payload)
            except Exception:
                with contextlib.suppress(ValueError):
                    self.control.remove(ws)

    async def push_hud(self, vehicle_id: str, payload: str) -> None:
        for ws in list(self.hud.get(vehicle_id, [])):
            try:
                await ws.send_text(payload)
            except Exception:
                with contextlib.suppress(ValueError):
                    self.hud[vehicle_id].remove(ws)


HUB = Hub()


# --------------------------------------------------------------------------
# The twin tick — this is the whole system in one function
# --------------------------------------------------------------------------

def compute_advisory(vid: str) -> Optional[Advisory]:
    tr = FLEET.tracks.get(vid)
    if tr is None:
        return None
    pos = FLEET.position(vid)
    if pos is None:
        return None
    x, y, z, heading = pos

    snap = GRAPH.snap(x, y, heading)
    segment_id = snap.edge_id if snap else None
    off_road = bool(snap and snap.off_road)
    mode = tr.mode()
    twin_healthy = mode in (Mode.A_NOMINAL, Mode.B_DEGRADED)

    visibility = VIS.at(x, y, z)
    speed_ms = VIS.safe_speed_ms(x, y, z, segment_id, tr.state.loaded, twin_healthy)
    if mode == Mode.B_DEGRADED:
        speed_ms = min(speed_ms, 5.5)        # conservative cap on a stale link
    if mode in (Mode.C_ISLANDED, Mode.D_FAULT):
        speed_ms = config.SPEED_FLOOR_MS

    # --- token arbitration --------------------------------------------
    token = None
    hold_dist = None
    ahead = GRAPH.zone_ahead(x, y, heading)
    inside = GRAPH.zone_of(x, y, heading)
    gradient = GRAPH.edges[segment_id].gradient if segment_id else 0.0

    if mode == Mode.D_FAULT:
        TOKENS.withdraw(vid)
        TOKENS.release(vid)
    elif inside is not None:
        # Already committed to the zone. Renewing beats requesting — a vehicle
        # inside a single-lane ramp must never be told to queue for it.
        if TOKENS.holds(vid, inside):
            TOKENS.renew(vid, inside)
        else:
            TOKENS.request(vid, inside, 0.0, (x, y), tr.state.loaded,
                           gradient, tr.state.vclass, tr.state.emergency)
        token = TOKENS.grant_for(vid, inside, (x, y), 0.0)
    elif ahead is not None:
        zone_id, dist, hold_point = ahead
        hold_dist = dist
        TOKENS.request(vid, zone_id, dist, hold_point, tr.state.loaded,
                       gradient, tr.state.vclass, tr.state.emergency)
        token = TOKENS.grant_for(vid, zone_id, hold_point, dist)
    else:
        TOKENS.withdraw(vid)

    token_held = bool(token and token.state == TokenState.HELD)

    # --- neighbours and the alert ladder -------------------------------
    neigh = neighbours_for(tr, FLEET, GRAPH)
    alert, reason = alert_for(tr, neigh, off_road, token_held, hold_dist,
                              speed_ms, mode == Mode.D_FAULT)

    corridor = GRAPH.corridor_ahead(x, y, heading, horizon_m=180.0, step_m=12.0)

    # --- near-miss recording -------------------------------------------
    if is_near_miss(alert, neigh) and clock.now() - _near_miss_cooldown.get(vid, 0) > 20:
        _near_miss_cooldown[vid] = clock.now()
        NEAR_MISSES.append({
            "t": clock.now(), "vehicle_id": vid, "reason": reason,
            "x": x, "y": y, "visibility_m": round(visibility, 1),
            "neighbours": [n.model_dump() for n in neigh[:3]],
        })
        log_event("near_miss", f"near miss: {vid} - {reason}", AlertLevel.WARNING, vid)

    return Advisory(
        vehicle_id=vid, t=clock.now(),
        ego_x=round(x, 2), ego_y=round(y, 2), ego_z=round(z, 2),
        ego_heading=round(heading, 4),
        mode=mode, alert=alert, alert_reason=reason,
        speed_advisory_ms=round(speed_ms, 2), segment_id=segment_id,
        visibility_m=round(visibility, 1), neighbours=neigh, token=token,
        corridor=[[round(c, 2) for c in pt] for pt in corridor],
    )


async def tick_loop() -> None:
    prev_alert: Dict[str, AlertLevel] = {}
    while True:
        started = time.perf_counter()
        try:
            if SIM is not None:
                SIM.step(config.TICK_DT, ADVISORIES)
                for st in SIM.states():
                    FLEET.ingest_state(st)

            FLEET.tick()

            active = FLEET.active_ids()
            occupancy: Dict[str, Optional[str]] = {}
            for vid in list(FLEET.tracks):
                p = FLEET.position(vid)
                occupancy[vid] = GRAPH.zone_of(p[0], p[1], p[3]) if p else None

            for vid in list(FLEET.tracks):
                adv = compute_advisory(vid)
                if adv is None:
                    continue
                ADVISORIES[vid] = adv
                if prev_alert.get(vid) != adv.alert and adv.alert.rank() >= AlertLevel.CAUTION.rank():
                    log_event("alert", f"{vid}: {adv.alert_reason}", adv.alert, vid)
                prev_alert[vid] = adv.alert
                # feed the fleet-as-sensor visibility network
                if adv.mode == Mode.A_NOMINAL and FLEET.tracks[vid].state.vis_est:
                    p = FLEET.position(vid)
                    VIS.ingest_vehicle_estimate(vid, p[0], p[1], p[2],
                                                FLEET.tracks[vid].state.vis_est)

            TOKENS.tick(occupancy, active)
            for msg in TOKENS.drain_events():
                log_event("token", msg)

            await broadcast()
        except Exception as exc:                       # keep the demo alive
            log_event("error", f"tick failed: {exc}", AlertLevel.WARNING)

        await asyncio.sleep(max(0.0, config.TICK_DT - (time.perf_counter() - started)))


def build_snapshot() -> WorldSnapshot:
    states = FLEET.snapshot_states()
    speeds = [s.speed for s in states] or [0.0]
    moving = sum(1 for s in states if s.speed > 0.4)
    return WorldSnapshot(
        t=clock.now(),
        vehicles=states,
        modes={vid: tr.mode().value for vid, tr in FLEET.tracks.items()},
        alerts={vid: a.alert.value for vid, a in ADVISORIES.items()},
        ages={vid: round(tr.age, 2) for vid, tr in FLEET.tracks.items()},
        zones=TOKENS.statuses(),
        visibility=VIS.per_segment(),
        stations=VIS.station_samples(),
        site_visibility_m=round(VIS.site_worst(), 1),
        events=list(EVENTS)[-25:],
        stats={
            "fleet": len(states),
            "moving": moving,
            "held": sum(1 for a in ADVISORIES.values()
                        if a.token and a.token.state == TokenState.HELD),
            "avg_speed_kmh": round(sum(speeds) / len(speeds) * 3.6, 1),
            "near_misses": len(NEAR_MISSES),
            "worst_alert": max((a.alert.rank() for a in ADVISORIES.values()), default=0),
        },
    )


async def broadcast() -> None:
    if HUB.control:
        await HUB.push_control(build_snapshot().model_dump_json())
    for vid, sockets in HUB.hud.items():
        if sockets and vid in ADVISORIES:
            await HUB.push_hud(vid, ADVISORIES[vid].model_dump_json())


# --------------------------------------------------------------------------
# App
# --------------------------------------------------------------------------

@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(tick_loop())
    log_event("mode", f"twin online - {len(GRAPH.edges)} edges, "
                      f"{len(GRAPH.zones)} conflict zones, sim={'on' if SIM else 'off'}")
    mqtt = _start_mqtt()
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        if mqtt:
            mqtt.loop_stop()


app = FastAPI(title="Bailadila FogTwin", version="1.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(config.WEB_DIR)), name="static")


@app.get("/", include_in_schema=False)
@app.get("/control", include_in_schema=False)
def control_page():
    return FileResponse(config.WEB_DIR / "control.html")


@app.get("/hud", include_in_schema=False)
def hud_page():
    return FileResponse(config.WEB_DIR / "hud.html")


@app.get("/hardware", include_in_schema=False)
def hardware_page():
    return FileResponse(config.WEB_DIR / "hardware.html")


@app.get("/results", include_in_schema=False)
def results_page():
    return FileResponse(config.WEB_DIR / "results.html")


@app.get("/prototype", include_in_schema=False)
def prototype_page():
    return FileResponse(config.WEB_DIR / "prototype.html")


@app.get("/api/experiment")
def api_experiment():
    """A/B benefit experiment output. Regenerate with scripts/experiment.py."""
    if not config.EXPERIMENT_PATH.exists():
        return JSONResponse(
            {"error": "no experiment yet",
             "hint": "python -m scripts.experiment --seeds 4 --minutes 25"},
            status_code=404)
    with open(config.EXPERIMENT_PATH, "r", encoding="utf-8") as fh:
        return JSONResponse(json.load(fh))


@app.get("/api/hardware")
def api_hardware():
    """Mounts, coverage volumes, wiring topology, BOM and rover mapping."""
    with open(config.HARDWARE_PATH, "r", encoding="utf-8") as fh:
        return JSONResponse(json.load(fh))


@app.get("/api/roadgraph")
def api_roadgraph():
    with open(config.ROADGRAPH_PATH, "r", encoding="utf-8") as fh:
        return JSONResponse(json.load(fh))


@app.get("/api/dem")
def api_dem_meta():
    """Metadata for the terrain raster: bounds, cell size, elevation range."""
    with open(config.DEM_META_PATH, "r", encoding="utf-8") as fh:
        return JSONResponse(json.load(fh))


@app.get("/api/dem.bin")
def api_dem_raster():
    """Int16 elevations in metres, row-major, row 0 = north edge."""
    return FileResponse(config.DEM_BIN_PATH, media_type="application/octet-stream")


@app.get("/api/snapshot")
def api_snapshot():
    return build_snapshot()


@app.get("/api/near_misses")
def api_near_misses():
    return list(NEAR_MISSES)


@app.get("/api/incidents.csv")
def api_incidents_csv():
    """
    Near-miss register as CSV, for the statutory record.

    A mine keeps an accident and dangerous-occurrence register; a system that
    detects near misses and cannot hand them over in a form a safety officer
    can file is only half a safety system. One row per event, plain text, no
    tooling needed to read it on a site PC.
    """
    import csv
    import io as _io

    buf = _io.StringIO()
    w = csv.writer(buf)
    w.writerow(["timestamp_utc", "vehicle_id", "reason", "visibility_m",
                "easting_m", "northing_m", "latitude", "longitude",
                "other_vehicle", "range_m", "ttc_s", "closing_ms"])
    for n in NEAR_MISSES:
        lon, lat = config.enu_to_lonlat(n["x"], n["y"])
        other = (n.get("neighbours") or [{}])[0]
        w.writerow([
            datetime.fromtimestamp(n["t"], tz=timezone.utc).isoformat(timespec="seconds"),
            n["vehicle_id"], n["reason"], n["visibility_m"],
            round(n["x"], 2), round(n["y"], 2), round(lat, 6), round(lon, 6),
            other.get("vehicle_id", ""), other.get("range_m", ""),
            other.get("ttc_s", ""), other.get("closing_ms", ""),
        ])
    return Response(content=buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition":
                             'attachment; filename="fogtwin_incidents.csv"'})


@app.get("/advisory/{vehicle_id}")
def api_advisory(vehicle_id: str):
    adv = ADVISORIES.get(vehicle_id)
    return adv if adv else JSONResponse({"error": "unknown vehicle"}, status_code=404)


# --- ingest ---------------------------------------------------------------

@app.post("/ingest/state")
def ingest_state(msg: VehicleState):
    FLEET.ingest_state(msg)
    return {"ok": True}


@app.post("/ingest/detections")
def ingest_detections(msg: DetectionSet):
    FLEET.ingest_detections(msg)
    return {"ok": True}


@app.post("/ingest/met")
def ingest_met(msg: MetReading):
    VIS.ingest_met(msg)
    return {"ok": True, "nowcast_30min": nowcast_probability(msg, 30)}


# --- demo controls --------------------------------------------------------

@app.post("/demo/fog")
def demo_fog(visibility_m: float = 8.0, station: str = "all"):
    """
    Drop visibility for the pitch. `station=all` fogs the site. Naming a single
    station fogs that bench and clears every other one, which demonstrates the
    whole point of the visibility field: the mine restricts one bench instead
    of halting.
    """
    now = clock.now()
    for st in GRAPH.met_stations:
        # Naming one station means "fog THIS bench and clear the rest" — the
        # button says "only", so it has to actually isolate, otherwise a second
        # click after a site-wide fog leaves everything socked in.
        target = visibility_m if (station == "all" or st["station_id"] == station) else 1000.0
        VIS.ingest_met(MetReading(
            station_id=st["station_id"], t=now,
            x=st["x"], y=st["y"], z=st.get("z", 0.0),
            visibility_m=target, temp_c=19.0,
            dewpoint_c=19.0 - max(0.2, target / 60.0),
            rh_pct=99.0, wind_ms=0.8,
        ))
    log_event("mode", f"visibility set to {visibility_m:.0f} m ({station})",
              AlertLevel.CAUTION if visibility_m < 50 else AlertLevel.INFO)
    return {"ok": True, "visibility_m": visibility_m, "station": station}


@app.get("/demo/nowcast")
def demo_nowcast():
    out = []
    for st in GRAPH.met_stations:
        met = VIS.met.get(st["station_id"])
        out.append({
            "station_id": st["station_id"], "name": st.get("name", ""),
            "z": st.get("z", 0.0),
            "visibility_m": round(VIS.at(st["x"], st["y"], st.get("z", 0.0)), 1),
            "p15": nowcast_probability(met, 15) if met else 0.0,
            "p30": nowcast_probability(met, 30) if met else 0.0,
            "p60": nowcast_probability(met, 60) if met else 0.0,
        })
    return out


# --- websockets -----------------------------------------------------------

@app.websocket("/ws/control")
async def ws_control(ws: WebSocket):
    await ws.accept()
    HUB.control.append(ws)
    await ws.send_text(build_snapshot().model_dump_json())
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        with contextlib.suppress(ValueError):
            HUB.control.remove(ws)


@app.websocket("/ws/hud/{vehicle_id}")
async def ws_hud(ws: WebSocket, vehicle_id: str):
    await ws.accept()
    HUB.hud.setdefault(vehicle_id, []).append(ws)
    if vehicle_id in ADVISORIES:
        await ws.send_text(ADVISORIES[vehicle_id].model_dump_json())
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        with contextlib.suppress(ValueError):
            HUB.hud[vehicle_id].remove(ws)


# --------------------------------------------------------------------------
# Optional MQTT bridge — the production ingest path
# --------------------------------------------------------------------------

def _start_mqtt():
    if not config.MQTT_HOST:
        return None
    try:
        import paho.mqtt.client as mqtt
    except ImportError:
        log_event("error", "FOGTWIN_MQTT set but paho-mqtt is not installed")
        return None

    from schema.messages import (
        TOPIC_DETECTIONS_WILDCARD, TOPIC_MET_WILDCARD, TOPIC_STATE_WILDCARD,
    )

    def on_connect(client, _u, _f, _rc, *_a):
        client.subscribe([(TOPIC_STATE_WILDCARD, 0),
                          (TOPIC_DETECTIONS_WILDCARD, 0),
                          (TOPIC_MET_WILDCARD, 1)])
        log_event("mode", f"MQTT bridge connected to {config.MQTT_HOST}")

    def on_message(_c, _u, msg):
        try:
            payload = json.loads(msg.payload.decode())
            if msg.topic.endswith("/state"):
                FLEET.ingest_state(VehicleState(**payload))
            elif msg.topic.endswith("/detections"):
                FLEET.ingest_detections(DetectionSet(**payload))
            elif msg.topic.endswith("/met"):
                VIS.ingest_met(MetReading(**payload))
        except Exception as exc:
            log_event("error", f"bad MQTT payload on {msg.topic}: {exc}")

    client = mqtt.Client()
    client.on_connect = on_connect
    client.on_message = on_message
    try:
        client.connect(config.MQTT_HOST, config.MQTT_PORT, 30)
        client.loop_start()
        return client
    except Exception as exc:
        log_event("error", f"MQTT connect failed: {exc}")
        return None


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=config.HTTP_PORT, log_level="warning")
