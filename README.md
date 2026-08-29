# Bailadila FogTwin

Digital twin for safe dumper operation at 3–5 m visibility.
SIH problem statement **26007** — Ministry of Steel / NMDC.

> **Core premise.** The static world (road edges, berms, benches, ramps, tip points)
> does not change during a shift, so it is not perceived — it is surveyed once into
> the twin and streamed into the cab. Only the dynamic world is sensed live, with
> 77 GHz radar that fog cannot degrade. Fog stops being a perception problem and
> becomes a data-synchronisation problem.

---

## Quick start

```bash
pip install -r requirements.txt
```

```bash
python -m twin.main
```

Then open:

| Surface | URL |
| --- | --- |
| Control room | http://localhost:8000/control |
| Cab HUD (dumper DT-101) | http://localhost:8000/hud?vehicle=DT-101 |
| Hardware demonstrator | http://localhost:8000/hardware |
| Measured results | http://localhost:8000/results |
| ESP32 prototype node | http://localhost:8000/prototype |
| API docs | http://localhost:8000/docs |

The server starts an in-process fleet simulator by default (6 dumpers driving the
real road graph), so both screens are populated immediately with no hardware.
Set `FOGTWIN_SIM=0` to disable it and feed real rovers instead.

---

## Repository layout

```
schema/          THE FROZEN CONTRACT — message models + topic map. Read this first.
twin/            The twin server: state store, road graph, tokens, visibility, risk.
scripts/         Build-time: fetch the DEM, lay the road network on it. Run once.
data/dem/        Real Bailadila elevations, 480x480 Int16 metres + metadata.
data/            roadgraph.json — nodes, edges, conflict zones, met stations.
sim/             Fleet simulator — in-process, plus an HTTP publisher for a second machine.
firmware/        Rover node: ESP32 sketch and the same protocol in Python.
run_demo.py      One command: twin up, three surfaces open, running order printed.
data/hardware.json  The kit: mounts, coverage, wiring, BOM, rover mapping. One manifest.
web/             Control room, cab HUD, hardware, results and prototype pages.
web/vendor/      three.js r160 (MIT), vendored — the mine network is air-gapped.
tests/           Invariant checks worth being able to run in front of a judge.
```

### Module map

| File | Owns |
| --- | --- |
| `schema/messages.py` | Every message on the wire. **Freeze this in hour one.** |
| `twin/roadgraph.py` | Road graph load, snap-to-road, corridor extraction |
| `twin/state.py` | Fleet state, staleness, dead-reckoning, neighbour queries |
| `twin/tokens.py` | Conflict-zone token allocator (lease-based, fail-closed) |
| `twin/visibility.py` | Per-segment visibility field, IDW + elevation covariate |
| `twin/risk.py` | Time-to-collision, alert ladder levels |
| `twin/main.py` | FastAPI app, ingest, WebSocket fan-out, 5 Hz twin tick |

---

## Ingest paths

Two transports, one schema. Use whichever your hardware can reach.

**HTTP** (simplest — works from an ESP32 with `HTTPClient`)

```bash
curl -X POST http://localhost:8000/ingest/state -H 'content-type: application/json' \
  -d '{"vehicle_id":"DT-101","t":0,"x":330,"y":380,"z":970,"heading":1.2,"speed":6.5,"loaded":true,"pos_conf":0.03}'
```

**MQTT** (the production path — set `FOGTWIN_MQTT=broker.local` to enable)

```
mine/v1/vehicle/{id}/state        vehicle -> twin   @ 5 Hz
mine/v1/vehicle/{id}/detections   vehicle -> twin   @ 5 Hz
mine/v1/env/{station}/met         station -> twin   @ 0.1 Hz
mine/v1/vehicle/{id}/advisory     twin -> vehicle   @ 5 Hz
```

Full field-by-field spec: [`schema/mqtt_schema.md`](schema/mqtt_schema.md).

---

## The site is a real mine

The terrain is the **actual Bailadila range** — Deposit 14 / 11C above Kirandul,
Dantewada — not a procedural hill. `scripts/fetch_dem.py` pulls public elevation
tiles (AWS Open Data Terrain Tiles, SRTM/ASTER derived, no API key), decodes
them, and bakes a 480 x 480 raster into `data/dem/`. The ridge crest comes out
at **1266 m** against a published summit of ~1276 m, and the valley floor at
423 m.

`scripts/build_roadgraph.py` then lays a haul network onto that terrain the way
a hilltop iron ore mine is actually developed:

* bench roads every 20 m of lift, each following the **real contour** at its
  elevation, found by marching outward from the crest until the ground drops
* contours clamped to a designed pit slope (32-50 m of cut-back per lift, about
  30 degrees overall) so the roads stop chasing natural spurs 800 m down the ridge
* each bench works a 292 degree arc; the remaining arc is the **ramp** down to
  the next bench, laid as an arc hugging the wall rather than a chord across the pit
* a haul road out to a crusher seated where the ground is lowest that a 7.5%
  ruling gradient can still reach

Regenerate either stage with `python -m scripts.fetch_dem` /
`python -m scripts.build_roadgraph`. Both outputs are committed, so the project
runs fully offline afterwards — which matters, because the mine network is
air-gapped and hall wifi cannot be trusted.

Resulting gradients: benches flat, ramps median 4.9% / max 9.2%, haul road 6.9%.
Those are real mine numbers, and they are checked by the test suite.

> **Honest scope.** The terrain is real. The road layout is *illustrative* — the
> problem statement ships no dataset and NMDC's surveyed network is not public.
> Swapping in a real survey means replacing `data/roadgraph.json`; no code
> changes, because every consumer reads the same schema.

## Coordinates

Local **ENU metres** from the ridge crest at `18.66423 N, 81.22562 E`, read from
`roadgraph.json` so there is one source of truth (`twin/config.py` picks it up).
Everything internal is metres — no degrees, no projections, no float-precision
surprises. Convert at the edges only (`twin.config.enu_to_lonlat`).

---

## Degradation modes

The server implements the four modes from the blueprint. Nothing safety-critical
depends on the network — these describe what the **twin** can still offer.

| Mode | Trigger | Twin behaviour |
| --- | --- | --- |
| A — nominal | fresh state, all links | neighbours, tokens, advisories |
| B — degraded | state age 2–8 s | grown uncertainty ellipse, conservative speed cap |
| C — islanded | state age > 8 s | vehicle dropped from token arbitration; last pose held |
| D — fault | `pos_conf` > 1.0 m | guided-stop advisory, tokens refused |

---

## The 3D twin

Both surfaces render the **same world** from `web/js/world.js` — the control
room orbits it, the cab sits inside it. That is not a rendering convenience; it
is the claim the project makes. The controller and the operator are looking at
one model, not at two pictures that happen to agree.

| Piece | Where it comes from |
| --- | --- |
| Terrain | The real Bailadila DEM, with the haul network **carved into it** |
| Roads on the ground | Road elevations are *designed*; the terrain is cut and filled to meet them. Drape roads over raw terrain instead and they float, sink, and merge into the hillside |
| Safety berms | A windrow thrown up either side of every carriageway, in the carve itself |
| Haul roads | Extruded ribbons at each edge's real `half_width`, with berm rails |
| Conflict-zone gates | Pillars at each zone, green when free, red when a token is held |
| Dumpers | Rear-dump models at 1.6× scale, ore load visible, beacon coloured by alert level |
| Staleness rings | Radius **is** the twin's uncertainty: `pos_conf + age × speed × 0.35` |
| Fog blanket | Vertex alpha sampled from the visibility field — the same field driving the speed policy, not a decorative overlay |

Control room: drag to orbit, wheel to dolly, right-drag or shift-drag to pan,
click any dumper to follow it. `Pit view` / `Plan` / `Ramp A` are preset camera
positions worth rehearsing before the demo.

Cab HUD: pick any dumper from the **cab selector** in the topbar, or step
through the fleet with the arrow buttons / left and right arrow keys. Switching
tears down the old vehicle's corridor and traffic and teleports the camera
rather than flying it across the pit, so a controller can walk the whole fleet
cab by cab during a shift review. The URL tracks the selection
(`?vehicle=DT-104`), so any cab is still directly linkable, and the control
room's fleet table links straight into one.

**Plan radar (PiP)** — press **R** or the topbar button for a bird's-eye of the
near field, ego at centre, nose up. It draws the *actual* sensor fans from
`data/hardware.json`, the range rings, and the blind arcs. The blip style is the
point: a filled blip is a vehicle a sensor on this truck can really see, a
hollow dashed one is a vehicle only the twin knows about. Click the PiP to cycle
250 / 120 / 60 m. Below 60 m visibility it switches to **RADAR ONLY** — the
optical sectors are dropped rather than drawn, because implying camera coverage
in dense fog would be a lie told by a safety display.

**Time-to-collision cards** — each threat gets a bar that fills as the seconds
run out, escalating caution → warning → intervene, with a closing rate. Targets
predicted to pass wider than the haul road are greyed and carry no bar: a
display that cries wolf at every truck on the next bench is one that gets
ignored.

Press **V** (or the button) to split the screen. Left is the
windscreen, with `FogExp2` density set from Koschmieder's law — `k = 3/V`, so
the pane goes white at exactly the visibility the field reports. Right is
synthetic vision drawn from the surveyed corridor, which weather cannot touch.
When a judge asks whether the fog is real or a graphic, the answer is that the
same number drives both the white-out and the speed limit.

## The hardware demonstrator

We cannot wheel a 100 tonne dumper into the hall, so `/hardware` stands in for
one. Four views, all fed from `data/hardware.json` — the 3D mounts, the coverage
volumes, the wiring diagram and the BOM read from a single manifest, so the
scene and the cost table cannot drift apart.

| View | Shows |
| --- | --- |
| **Dumper kit** | Every component modelled where it actually bolts on, at true scale against a 10.6 m machine. Click any part for its role, its behaviour in fog, its interface, draw and cost. Coverage toggles draw the real sensor volumes — the 250 m forward radar fan, the 80 m corner fans, the thermal and camera frustums, the GNSS sky mask, the UWB and radio spheres. **E** explodes the kit off the machine with leader lines back to each mount. |
| **Site infrastructure** | Roadside units, met stations, the RTK base and UWB anchors placed on the real Bailadila ridge against the actual haul network, with radio and ranging coverage on demand. |
| **Rover prototype** | The machine we did build, at true scale, with every part mapped to the production component it stands in for. One button frames it beside a true-scale dumper envelope, because the size gap is the honest part. |
| **Blind spots** | On the dumper view, the arcs no sensor reaches, drawn on the ground. Two modes: *any sensor* and *in fog*. |
| **Wiring &amp; BOM** | Power and data topology — one isolated supply, one compute hub — plus the bill of materials. Currently **&#8377;1,48,500** per dumper at **85 W** peak draw, and **&#8377;54,23,000** for a 30-dumper pilot including site infrastructure — a ~32% cut from the first pass, by re-pricing eval-kit and tactical-grade parts as their production equivalents. The forward 77 GHz radar is untouched; click any changed component on the page for the swap and why it does not cost accuracy. |

### The blind spots are shown, not hidden

`web/js/sensors.js` derives the detection sectors from the manifest and returns
the arcs nothing covers. On the current three-radar fit that is:

| | Blind arc, each front quarter |
| --- | --- |
| Any detection sensor | **54&deg;** (30&ndash;85&deg; off the nose) |
| Radar only, i.e. in dense fog | **75&deg;** (9&ndash;85&deg; off the nose) |

Both the hardware page and the cab HUD read the same module, so the coverage
shown to a judge and the coverage the operator is flying on cannot disagree —
add a fourth radar to `data/hardware.json` and both surfaces update together.

Say this before a judge finds it: two more corner radars at &#8377;18k each close
both wedges, and the reason they are not in the phase-one fit is that the two
geometries that dominate mine accident statistics — rear-end on a ramp and
reversing at a tip — are already covered.

**Guided tour** runs nine steps across all four views with the narration written
out, so it can be clicked through while presenting; arrow keys step, Escape
exits, and a judge can take the mouse at any point and explore freely.

## Does it actually help? Measured.

```bash
python -m scripts.experiment --seeds 4 --minutes 25
```

Two arms, identical road, fleet, weather and random seed. One variable: the
baseline drives to what the eye can see and has no arbitration at conflict
zones; FogTwin uses the surveyed corridor and the token interlocking.

| Visibility | Loaded tonne-km/h, baseline | FogTwin | Gain | Mean km/h | Conflict-zone co-occupancy, s/h |
| --- | --- | --- | --- | --- | --- |
| 1000 m | 6444 &plusmn;951 | 6329 &plusmn;931 | **0.98&times;** | 25.6 &rarr; 25.3 | 186 &rarr; 29 |
| 50 m | 6444 &plusmn;951 | 6329 &plusmn;931 | **0.98&times;** | 25.4 &rarr; 25.3 | 159 &rarr; 29 |
| 8 m | 3151 &plusmn;419 | 6329 &plusmn;931 | **2.01&times;** | 10.6 &rarr; 25.3 | 232 &rarr; 29 |

Read honestly:

* **In clear weather the twin is very slightly worse (0.98&times;).** That is the
  interlocking charging its throughput price with no fog benefit to pay for it.
  Keep this row in the deck. A model that only ever flatters the product is a
  model nobody believes.
* **At 8 m visibility it doubles loaded haulage work** at 2.4&times; the speed,
  while cutting time spent with two machines in one single-lane zone by 8&times;.
* **Co-occupancy does not reach zero**, and cannot in phase one: the twin has no
  vehicle-control authority, so a dumper already inside a zone when its token is
  refused can be advised but not braked. Exposure reduced, not eliminated.
* **Proximity events per hour go up in the twin arm at 8 m** (0 &rarr; 13.8), and
  that is not a safety regression: the baseline is crawling at 10.6 km/h so
  machines barely meet. Normalised per 1000 tonne-km the co-occupancy figures
  are 73.7 &rarr; 4.6. Adjacency on an open bench between two machines that can
  each see the other in the twin is ordinary haulage, not a near miss.
* This is a simulation of our own model. It is evidence about the design, not a
  measurement of Bailadila.

Two bugs this experiment found, both now fixed and both worth knowing about:

1. `zone_ahead` followed a single best-heading corridor, so at a ramp head it
   guessed the bench and dumpers entered single-lane ramps having never
   requested a token &mdash; 280 co-occupancy steps on RAMP-E in 20 minutes. It now
   searches every forward branch.
2. `VisibilityField.at()` returned 1000 m &mdash; *clear* &mdash; once every met sample
   aged past `SENSOR_STALE_S`. If the stations stop reporting, the twin was
   telling the fleet the mine was clear. It now holds the last known field and
   exposes `is_stale()`.

### Two pages that read from data, not from prose

`/results` renders `data/experiment.json` — every number, error bar and
honest-reading note is computed from the file, so the page cannot drift from the
experiment and you can regenerate it in front of a judge.

`/prototype` is the ESP32 build page: bill of materials at **&#8377;880**
required, a wiring diagram, flashing steps with the two gotchas that will
actually catch you (Windows Firewall on port 8000, and 2.4 GHz-only ESP32 radios
against a 5 GHz hotspot), the exact JSON the node puts on the wire, and a **live
indicator** that lights up when an `RV-` node is publishing. No hardware yet?
`python firmware/rover_desktop.py` speaks the identical protocol and lights the
same indicator.

## Demo controls

The control room's fog buttons hit these, and so can you:

```bash
curl -X POST "http://localhost:8000/demo/fog?visibility_m=6&station=all"
```

```bash
curl -X POST "http://localhost:8000/demo/fog?visibility_m=5&station=MET-CREST"
```

The second one fogs **only the crest bench**. Watch the control room paint those
benches red while the crusher haul road stays green and keeps running at full speed —
that selectivity is where most of the recovered production comes from, and it is
the single most persuasive thing to show an NMDC judge.

Press **V** on the cab HUD to split the screen: the windscreen on the left, the
synthetic road on the right, at the same instant, at the same visibility.

## Tests

```bash
python -m tests.test_twin
```

18 checks across four areas — the interlocking (capacity never exceeded,
fail-closed on comms loss, emergency pre-emption, loaded-over-empty priority),
the surveyed geometry (corridor generation, berm departure, line-of-sight
occlusion at the blind bend), the visibility field (fog stratifying by
elevation, twin vs. eyes-only safe speed, nowcaster), and collision risk
(head-on detection, and wide passes correctly *not* alerting).

Two results worth quoting:

* At 6 m visibility on segment E7, eyes-only stopping-sight gives **9 km/h**;
  with the twin's surveyed corridor the same segment supports **25 km/h**.
* Fogging the crest bench alone puts its haul road at **5 m** while the crusher
  approach stays around **500 m** — restrict one bench, keep the mine running.
* Every generated edge is inside a drivable gradient (steepest 9.2%).

## Status

Scaffold is runnable end to end: road graph → simulated fleet → twin tick →
tokens + advisories → control room + HUD. Perception (radar/thermal), the fog
nowcaster, and the RTK/IMU fusion are stubbed behind clean interfaces —
`twin/risk.py` and `twin/visibility.py` are where those land.
