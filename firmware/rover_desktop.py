"""
The rover node, in Python, speaking exactly the protocol the ESP32 speaks.

    python firmware/rover_desktop.py --twin http://localhost:8000 --id RV-201

Same two calls, same message, same obedience rules as rover_esp32.ino: POST a
VehicleState at 5 Hz, GET the advisory back, slow for the speed advisory, stop
when the conflict-zone token is refused.

Why this exists: it lets you prove the external-node path works before any
hardware arrives, and it lets you run the node on a second laptop or a phone so
a judge can see a machine that is genuinely not the server joining the twin.
When the ESP32 turns up it is a drop-in — the twin cannot tell them apart,
which is the entire claim.

Run it against a twin started with FOGTWIN_SIM=1 and the rover appears in the
control room and the cab picker beside the simulated fleet.
"""

from __future__ import annotations

import argparse
import json
import math
import time
import urllib.error
import urllib.request

# A short loop of twin ENU waypoints near the middle benches, chosen because a
# conflict zone sits on the way round, so tokens actually fire during a demo.
ROUTE = [
    (260.0, -40.0), (235.0, 136.0), (89.0, 210.0),
    (-140.0, 564.0), (-274.0, -128.0), (102.0, -646.0),
]


def post(url: str, payload: dict, timeout: float = 1.0) -> None:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=timeout).read()


def get(url: str, timeout: float = 1.0) -> dict | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read())
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--twin", default="http://localhost:8000")
    ap.add_argument("--id", default="RV-201")
    ap.add_argument("--hz", type=float, default=5.0)
    ap.add_argument("--speed", type=float, default=6.0, help="m/s, twin scale")
    ap.add_argument("--z", type=float, default=1173.0)
    args = ap.parse_args()

    x, y = ROUTE[0]
    heading, speed, leg = 0.0, args.speed, 1
    dt = 1.0 / args.hz
    pos_conf = 0.05
    held = False

    print(f"rover {args.id} -> {args.twin} at {args.hz} Hz  (ctrl-c to stop)")
    while True:
        started = time.perf_counter()

        tx, ty = ROUTE[leg]
        dx, dy = tx - x, ty - y
        if math.hypot(dx, dy) < 12.0:
            leg = (leg + 1) % len(ROUTE)
        else:
            heading = math.atan2(dy, dx)
        x += math.cos(heading) * speed * dt
        y += math.sin(heading) * speed * dt

        try:
            post(f"{args.twin}/ingest/state", {
                "vehicle_id": args.id, "t": 0,
                "x": round(x, 2), "y": round(y, 2), "z": args.z,
                "heading": round(heading, 4), "speed": round(speed, 2),
                "loaded": True, "payload_t": 92.0, "pos_conf": pos_conf,
            })
        except Exception as exc:
            print(f"  uplink down: {exc}")
            time.sleep(dt)
            continue

        adv = get(f"{args.twin}/advisory/{args.id}")
        if adv:
            limit = adv.get("speed_advisory_ms", args.speed)
            token = adv.get("token") or {}
            was_held = held
            held = token.get("state") == "held"
            if held:
                speed = 0.0
            elif adv.get("alert") == "intervene":
                speed = 0.0
            else:
                speed = min(args.speed, limit) if limit else args.speed

            if held != was_held:
                print(f"  {'HOLD at ' + token.get('zone_id', '?') if held else 'GO'}")
            print(f"  x {x:7.0f}  y {y:7.0f}  v {speed:4.1f} m/s  "
                  f"limit {limit:4.1f}  vis {adv.get('visibility_m', 0):6.0f} m  "
                  f"{adv.get('alert', '')}: {adv.get('alert_reason', '')}")

        time.sleep(max(0.0, dt - (time.perf_counter() - started)))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nstopped")
