# Wire contract — FogTwin v1

**Freeze this in hour one.** Build against `sim/fleet_sim.py` until real rovers exist.
Canonical definitions live in [`messages.py`](messages.py); this file is the human copy.

## Conventions

| Thing | Rule |
| --- | --- |
| Coordinates | Local ENU **metres** from origin `18.6600 N, 81.2300 E` |
| Heading | Radians, `0 = east`, counter-clockwise positive |
| Time | Float seconds, UTC epoch. Send `0` if you have no clock; the twin stamps it. |
| Encoding | UTF-8 JSON. QoS 0 for state, QoS 1 for token requests. |
| Rate | State 5 Hz, detections 5 Hz, met 0.1 Hz, advisory 5 Hz |

## Topics

| Topic | Direction | Payload |
| --- | --- | --- |
| `mine/v1/vehicle/{id}/state` | vehicle → twin | `VehicleState` |
| `mine/v1/vehicle/{id}/detections` | vehicle → twin | `DetectionSet` |
| `mine/v1/env/{station}/met` | station → twin | `MetReading` |
| `mine/v1/vehicle/{id}/advisory` | twin → vehicle | `Advisory` |

HTTP mirrors for hardware without an MQTT client:
`POST /ingest/state`, `POST /ingest/detections`, `POST /ingest/met`,
`GET /advisory/{vehicle_id}`.

## VehicleState — the one message that matters

```json
{
  "vehicle_id": "DT-101",
  "t": 1740000000.0,
  "x": 330.0, "y": 380.0, "z": 970.0,
  "heading": 1.21,
  "speed": 6.5,
  "vclass": "dumper",
  "loaded": true,
  "payload_t": 92.0,
  "pos_conf": 0.03,
  "vis_est": 18.0,
  "emergency": false
}
```

`pos_conf` is the 1-sigma position error in metres. It drives Mode D: above
`1.0 m` the twin refuses tokens and issues a guided-stop advisory. An ESP32
rover with ArUco or UWB positioning should report an honest number here —
the whole design depends on the system knowing when it does not know.

## Advisory — the 5 Hz downlink

```json
{
  "vehicle_id": "DT-101",
  "t": 1740000000.2,
  "mode": "A",
  "alert": "caution",
  "alert_reason": "DT-104 closing, 62 m",
  "speed_advisory_ms": 3.3,
  "segment_id": "E6",
  "visibility_m": 12.0,
  "neighbours": [ { "vehicle_id": "DT-104", "range_m": 62.1, "around_corner": true, "...": "..." } ],
  "token": { "zone_id": "BEND-B", "state": "held", "queue_pos": 1, "hold_dist_m": 41.0 },
  "corridor": [[520.0, 300.0, 955.0, 11.0], [545.0, 297.0, 954.2, 11.0]]
}
```

`corridor` is the surveyed road ahead as `[x, y, z, half_width]` points. **The HUD
draws the road from this, never from a camera.** That single field is why the
system works at 3 m visibility.

`around_corner: true` marks a neighbour that is not in line of sight — knowledge
the twin has and no on-vehicle sensor could produce. Render these differently;
it is the most persuasive thing on the HUD.

## Token lifecycle

```
approaching (200 m out) --> REQUEST --> arbitrate --> GRANTED (15 s lease)
                                          |
                                          +-------> HELD (queue_pos, hold point)
GRANTED --renew every 5 s--> GRANTED
GRANTED --geofence exit--> released
lease expires with no renewal --> released, and the vehicle must treat it as NO ENTRY
```

Fail-closed, exactly like railway interlocking. Losing comms cannot grant you a
zone; it can only take one away.

## Rover minimum viable publisher

A rover only needs `vehicle_id`, `x`, `y`, `heading`, `speed`, `pos_conf`.
Everything else has a default. This is deliberate — hardware should be able to
join the twin with a six-field JSON POST.
