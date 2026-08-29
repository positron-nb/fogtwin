"""
Standalone fleet simulator — publishes over HTTP to a twin on another machine.

Use when you want the twin and the traffic on separate laptops (or to prove to a
judge that vehicles are genuinely external clients speaking the frozen schema,
not an internal loop).

    python -m sim.fleet_sim --twin http://192.168.1.20:8000 --fleet 6

Run the twin with FOGTWIN_SIM=0 so it does not also generate traffic.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx

from schema.messages import Advisory
from twin.roadgraph import load_graph

from .driver import SimFleet


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--twin", default="http://localhost:8000")
    ap.add_argument("--fleet", type=int, default=6)
    ap.add_argument("--hz", type=float, default=5.0)
    args = ap.parse_args()

    graph = load_graph()
    fleet = SimFleet(graph, size=args.fleet)
    dt = 1.0 / args.hz
    client = httpx.Client(base_url=args.twin, timeout=2.0)
    advisories: dict[str, Advisory] = {}

    print(f"publishing {args.fleet} dumpers to {args.twin} at {args.hz} Hz "
          f"(ctrl-c to stop)")

    while True:
        started = time.perf_counter()
        fleet.step(dt, advisories)

        for state in fleet.states():
            try:
                client.post("/ingest/state", json=state.model_dump(mode="json"))
            except httpx.HTTPError as exc:
                print(f"  uplink lost for {state.vehicle_id}: {exc}")
                continue
            # pull the downlink so the sim obeys tokens and speed advisories
            try:
                r = client.get(f"/advisory/{state.vehicle_id}")
                if r.status_code == 200:
                    advisories[state.vehicle_id] = Advisory(**r.json())
            except httpx.HTTPError:
                advisories.pop(state.vehicle_id, None)

        time.sleep(max(0.0, dt - (time.perf_counter() - started)))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nstopped")
