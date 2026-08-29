"""
One command to bring the whole demo up.

    python run_demo.py

Starts the twin, waits until it is genuinely serving, opens the three surfaces
in a browser, and prints the demo script. Optionally starts a rover node too.

This exists because demo day is the worst possible time to be typing three
commands and remembering a URL, and because a judge watching you fumble a
terminal has already formed an opinion before the fog rolls in.

    python run_demo.py --fog 6          start already fogged in
    python run_demo.py --rover          also start a desktop rover node
    python run_demo.py --no-browser     just the server
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BASE = "http://localhost:8000"

SCRIPT = """
  DEMO RUNNING ORDER
  ------------------
   1  Control room .... the pit is the real Bailadila ridge, benches on true
                        contours. Six dumpers running a live twin.
   2  Fog crest bench . one bench blinded, crusher road still green.
                        THIS is the selectivity argument.
   3  Cab HUD ......... press V. Left pane is the windscreen at 6 m. Right pane
                        is the same instant from surveyed geometry.
   4  Plan radar ...... press R. Hollow blips are vehicles only the twin knows
                        about. In fog, most of them.
   5  Conflict token .. watch a dumper hold at an amber countdown, then go.
   6  Hardware ........ the kit, coverage volumes, blind spots, BOM.
   7  Numbers ......... scripts/experiment.py output. Measured, not claimed.
"""


def wait_for_server(timeout_s: float = 40.0) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{BASE}/api/snapshot", timeout=1.5) as r:
                json.loads(r.read())
                return True
        except Exception:
            time.sleep(0.6)
    return False


def post(path: str) -> None:
    try:
        req = urllib.request.Request(BASE + path, method="POST")
        urllib.request.urlopen(req, timeout=3).read()
    except Exception as exc:
        print(f"  ! {path} failed: {exc}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fog", type=float, default=None,
                    help="start with this visibility in metres, site wide")
    ap.add_argument("--rover", action="store_true",
                    help="also start a desktop rover node")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    print("starting the twin ...")
    server = subprocess.Popen([sys.executable, "-m", "twin.main"], cwd=str(ROOT))

    if not wait_for_server():
        print("twin did not come up. Is port 8000 already in use?")
        server.terminate()
        sys.exit(1)
    print("twin is serving on " + BASE)

    rover = None
    if args.rover:
        rover = subprocess.Popen(
            [sys.executable, "firmware/rover_desktop.py", "--twin", BASE],
            cwd=str(ROOT), stdout=subprocess.DEVNULL)
        print("rover node RV-201 publishing")

    if args.fog is not None:
        post(f"/demo/fog?visibility_m={args.fog}&station=all")
        print(f"visibility set to {args.fog:.0f} m")

    if not args.no_browser:
        for path in ("/control", "/hud?vehicle=DT-101", "/hardware"):
            webbrowser.open(BASE + path)
            time.sleep(0.8)

    print(SCRIPT)
    print("  fog controls are in the control room sidebar")
    print("  ctrl-c here stops everything\n")

    try:
        server.wait()
    except KeyboardInterrupt:
        print("\nstopping ...")
    finally:
        for p in (rover, server):
            if p and p.poll() is None:
                p.terminate()


if __name__ == "__main__":
    main()
