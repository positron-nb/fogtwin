/* FogTwin prototype node dashboard.

   One physical board on a desk, drawn as instruments. Deliberately standalone:
   nothing on this page comes from the simulated fleet, the road graph or the
   interlocking. If a number is here, the board measured it.

   The charts are built for someone who has not seen the project before, so
   they carry labelled axes in real units, a marked zero line and named series
   rather than the unlabelled sparklines that were here before. A trace nobody
   can read is decoration.

   Everything is polled from the twin's public endpoints, so the page has no
   privileged access. When nothing is publishing it says so and empties itself,
   because a dashboard that invents a plausible attitude is worse than none. */

import * as THREE from '../vendor/three.module.js';

// 8 Hz against a board publishing at roughly 3. Comfortably above Nyquist for
// the source, so no sample waits for the next poll, without the 20 requests a
// second the page was making before.
const HZ = 8;
const WINDOW_S = 30;               // how much history the charts show
// Generous on purpose: the board publishes at roughly 3 Hz over Wi-Fi, and
// this threshold separates "connected" from "gone", not jitter from calm.
const STALE_S = 4.0;

const CONE_DEG = 15;               // HC-SR04 beam width, near enough
const DIST_MAX = 4;                // its reach, in metres

/* Demonstration thresholds, labelled as such wherever they are shown. A board
   in your hand has no real tip angle; these are picked to be reachable by hand
   while keeping the same shape of response — caution, then alarm. */
const LEAN_DEG = 22;
const TIP_DEG = 38;
const NEAR_M = 0.60;
/* A return shows instantly; clearing waits. Real proximity alarms are
   asymmetric like this, and being late to warn is a different kind of wrong
   from being late to stop warning. */
const RELEASE_MS = 800;

let renderer, scene, camera, truck;
let nodeId = null;
let idle = true;

const hist = [];                   // { t, pitch, roll, dist }
let prevRange = null, closing = false;
let heldRange = null, heldUntil = 0;
let packets = 0, lastWall = 0, rate = 0;
let lastImuT = 0, lastSonT = 0, sonarEverSeen = false;

const $ = id => document.getElementById(id);

/* ================================================================== */
/* the machine                                                         */
/* ================================================================== */

function buildTruck() {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0xD9A81E, roughness: 0.55, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23282C, roughness: 0.85 });
  const ore = new THREE.MeshStandardMaterial({ color: 0x3A3D42, roughness: 1 });

  const box = (w, h, d, x, y, z, m) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z);
    g.add(b);
    return b;
  };

  box(4.6, 0.5, 2.4, -0.1, 0.75, 0, body);          // frame
  box(3.3, 1.15, 2.6, -0.6, 1.6, 0, body);          // dump body
  box(2.6, 0.5, 2.2, -0.6, 2.3, 0, ore);            // load
  box(1.0, 1.0, 1.5, 1.55, 1.75, 0.4, dark);        // cab
  box(0.08, 0.66, 1.0, 2.06, 1.8, 0.4, new THREE.MeshStandardMaterial(
    { color: 0x8FC7E8, roughness: 0.2, metalness: 0.1 }));   // glazing
  box(1.3, 0.42, 2.5, 2.0, 0.62, 0, body);          // front deck

  const wheel = new THREE.CylinderGeometry(0.62, 0.62, 0.42, 18);
  for (const [wx, wz] of [[1.5, 1.15], [1.5, -1.15], [-1.2, 1.2], [-1.2, -1.2]]) {
    const w = new THREE.Mesh(wheel, dark);
    w.rotation.x = Math.PI / 2;
    w.position.set(wx, 0.62, wz);
    g.add(w);
  }
  return g;
}

function buildScene() {
  const host = $('att-host');
  host.style.cssText =
    'position:relative;width:100%;aspect-ratio:620/330;background:#0B0E10;'
    + 'border:1px solid var(--rule)';

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x0B0E10);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%';
  host.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xAFC0CE, 0x2A2320, 0.85));
  const sun = new THREE.DirectionalLight(0xFFEBD2, 1.9);
  sun.position.set(6, 8, 5);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x86AECA, 0.5);
  rim.position.set(-7, 3, -6);
  scene.add(rim);

  camera = new THREE.PerspectiveCamera(38, 620 / 330, 0.1, 200);
  camera.position.set(7.6, 4.3, 7.6);
  camera.lookAt(0, 1.3, 0);

  // A level reference the machine moves against. Without it a tilted truck on
  // a black field reads as a camera move rather than as the board being moved.
  const grid = new THREE.GridHelper(18, 18, 0x3C4A56, 0x232C34);
  grid.position.y = -0.02;
  scene.add(grid);

  truck = new THREE.Group();
  truck.add(buildTruck());
  scene.add(truck);

  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight || w * 330 / 620;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();

  let prev = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    // clamp: a backgrounded tab hands back a huge dt that would snap the mesh
    const dt = Math.min((now - prev) / 1000, 0.1);
    prev = now;
    easeAttitude(dt);
    renderer.render(scene, camera);
  });
}

/* The board publishes at ~3 Hz and this renders at 60, so driving the mesh
   straight from each sample made it hold still and then jump. What is drawn is
   eased toward the last reported attitude every frame instead. Presentation
   only: the charts still plot every raw sample. */
const TAU_S = 0.09;
const target = { pitch: 0, roll: 0, yaw: 0 };
const shown = { pitch: 0, roll: 0, yaw: 0 };
let haveAttitude = false;

function setAttitude(pitchDeg, rollDeg, yawDeg) {
  target.pitch = pitchDeg;
  target.roll = rollDeg;
  target.yaw = yawDeg;
  if (!haveAttitude) { Object.assign(shown, target); haveAttitude = true; }
}

/* Shortest way round: 359 to 1 degrees is +2, not -358. Without this the truck
   spins the long way through a full turn every time yaw crosses north. */
function wrapDelta(from, to) { return ((to - from + 540) % 360) - 180; }

function easeAttitude(dt) {
  if (!truck || !haveAttitude) return;
  const k = 1 - Math.exp(-dt / TAU_S);     // frame-rate independent
  shown.pitch += (target.pitch - shown.pitch) * k;
  shown.roll += (target.roll - shown.roll) * k;
  shown.yaw += wrapDelta(shown.yaw, target.yaw) * k;

  const d = Math.PI / 180;
  // modelled nose along +x, so roll turns about x and pitch about z
  truck.rotation.set(shown.roll * d, -shown.yaw * d, shown.pitch * d, 'YXZ');
}

/* ================================================================== */
/* charts                                                              */
/* ================================================================== */

const CW = 620, CH = 150, PAD_L = 46, PAD_R = 10, PAD_T = 12, PAD_B = 20;
const PW = CW - PAD_L - PAD_R, PH = CH - PAD_T - PAD_B;

/* One chart routine for both panels. It draws a labelled y-axis in real units
   and a marked baseline, because the previous sparklines had neither and were
   unreadable to anyone who had not written them. */
function drawChart(el, opts) {
  const { lo, hi, ticks, unit, series, baseline } = opts;
  const y = v => PAD_T + PH - ((v - lo) / (hi - lo)) * PH;
  const now = hist.length ? hist[hist.length - 1].t : 0;
  const t0 = now - WINDOW_S;
  const x = t => PAD_L + Math.max(0, Math.min(1, (t - t0) / WINDOW_S)) * PW;

  let g = '';
  for (const tv of ticks) {
    const yy = y(tv);
    const zero = baseline != null && tv === baseline;
    g += `<line x1="${PAD_L}" y1="${yy.toFixed(1)}" x2="${CW - PAD_R}" y2="${yy.toFixed(1)}"
           stroke="${zero ? '#4A5661' : '#242C33'}" stroke-width="1"
           ${zero ? '' : 'stroke-dasharray="3 4"'}/>`;
    g += `<text x="${PAD_L - 7}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end"
           font-family="IBM Plex Mono, monospace" font-size="10"
           fill="#7C8B98">${tv}${unit}</text>`;
  }

  const win = hist.filter(h => h.t >= t0);
  for (const s of series) {
    // break the line wherever the value is missing, so a gap reads as "no
    // reading" rather than as a straight line through nothing
    let run = [], out = '';
    const flush = () => {
      if (run.length > 1) out += `<polyline points="${run.join(' ')}" fill="none"
        stroke="${s.colour}" stroke-width="2" stroke-linejoin="round"
        stroke-linecap="round"/>`;
      else if (run.length === 1) {
        const [px, py] = run[0].split(',');
        out += `<circle cx="${px}" cy="${py}" r="2" fill="${s.colour}"/>`;
      }
      run = [];
    };
    for (const h of win) {
      const v = h[s.key];
      if (v == null || Number.isNaN(v)) { flush(); continue; }
      run.push(`${x(h.t).toFixed(1)},${y(Math.max(lo, Math.min(hi, v))).toFixed(1)}`);
    }
    flush();
    g += out;
  }
  el.innerHTML = g;
}

function drawCharts() {
  const last = hist[hist.length - 1];

  drawChart($('ch-tilt'), {
    lo: -90, hi: 90, ticks: [-90, -45, 0, 45, 90], unit: '°', baseline: 0,
    series: [{ key: 'pitch', colour: '#E0A93B' }, { key: 'roll', colour: '#9B8FD0' }],
  });
  $('lg-pitch').textContent = last ? `${last.pitch.toFixed(0)}°` : '—';
  $('lg-roll').textContent = last ? `${last.roll.toFixed(0)}°` : '—';

  drawChart($('ch-dist'), {
    lo: 0, hi: DIST_MAX, ticks: [0, 1, 2, 3, 4], unit: ' m', baseline: 0,
    series: [{ key: 'dist', colour: '#E4652F' }],
  });
  const d = last && last.dist != null ? last.dist : null;
  $('lg-dist').textContent = d != null ? `${d.toFixed(2)} m` : 'nothing in range';
}

/* The beam, drawn to its real 15 degrees and pointing forward. The shape is
   doing argumentative work: it is narrow and short, and that is the point. */
function drawCone(fill) {
  const cx = 6, cy = 33, R = 66;
  const half = (CONE_DEG / 2) * Math.PI / 180;
  const wedge = (r, colour, opacity) => {
    const x1 = cx + Math.cos(-half) * r, y1 = cy + Math.sin(-half) * r;
    const x2 = cx + Math.cos(half) * r, y2 = cy + Math.sin(half) * r;
    return `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)}
             A${r},${r} 0 0 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z"
             fill="${colour}" opacity="${opacity}"/>`;
  };
  let g = wedge(R, '#3C4A56', 0.32);
  if (fill > 0) g += wedge(R * Math.min(1, fill), '#E4652F', 0.85);
  g += `<circle cx="${cx}" cy="${cy}" r="3" fill="#8FA3B0"/>`;
  $('cone').innerHTML = g;
}

/* ================================================================== */
/* the banner                                                          */
/* ================================================================== */

function setRibbon(level, tag, msg) {
  const r = $('ribbon');
  if (!level) { r.className = 'ribbon'; return; }
  r.className = `ribbon on ${level}`;
  $('ribbon-tag').textContent = tag;
  $('ribbon-msg').innerHTML = msg;
}

/* Shows the single most serious true thing, and nothing when nothing is wrong.
   A banner that is always lit stops being read. */
function updateRibbon(att, dist) {
  const lean = att ? Math.max(Math.abs(att.roll_deg), Math.abs(att.pitch_deg)) : 0;

  if (lean >= TIP_DEG) {
    setRibbon('crit', 'Tipping',
      `The board is over at <b>${lean.toFixed(0)}°</b>. On a loaded haul truck this `
      + `is about where it stops being recoverable. (${TIP_DEG}° is a demonstration `
      + `figure, picked so you can reach it by hand.)`);
  } else if (dist != null && dist <= NEAR_M) {
    setRibbon('crit', 'Something close',
      `<b>${dist.toFixed(2)} m</b> ahead${closing ? ' and getting closer' : ''}. `
      + `That is inside the distance a machine this size would need to stop.`);
  } else if (lean >= LEAN_DEG) {
    setRibbon('warn', 'Leaning',
      `The board is over at <b>${lean.toFixed(0)}°</b>. Not dangerous yet — a driver `
      + `would see this on the dashboard before feeling it.`);
  } else if (dist != null) {
    setRibbon('warn', 'Something ahead',
      `<b>${dist.toFixed(2)} m</b> in front, inside the sensor's ${DIST_MAX} m reach.`);
  } else {
    setRibbon(null);
  }

  $('card-att').className = 'card' + (lean >= TIP_DEG ? ' hot'
                                    : lean >= LEAN_DEG ? ' caution' : '');
  $('card-dist').className = 'card' + (dist != null && dist <= NEAR_M ? ' hot'
                                     : dist != null ? ' caution' : '');
}

/* ================================================================== */
/* polling                                                             */
/* ================================================================== */

async function j(url) {
  try {
    const r = await fetch(url);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/* Whichever external node is publishing attitude. The simulated fleet never
   does, so this cannot accidentally lock onto one of them. */
async function findNode() {
  const n = await j('/api/nodes');
  const fresh = (n?.nodes || []).filter(x => x.age_s < STALE_S);
  return fresh.length ? fresh[0].vehicle_id : null;
}

function setIdle(on, reason) {
  if (on === idle) return;
  idle = on;
  $('main').classList.toggle('idle', on);
  $('waiting').style.display = on ? '' : 'none';
  const c = $('conn');
  c.textContent = on ? (reason || 'waiting') : 'live';
  c.className = on ? 'conn down' : 'conn';
  if (on) setRibbon(null);
}

function updateHealth(att, prox, age) {
  const now = Date.now() / 1000;
  const espOk = age != null && age < STALE_S;
  $('d-esp').className = 'dot ' + (espOk ? 'ok' : 'bad');
  $('r-esp').textContent = espOk ? `${rate.toFixed(1)} per second` : 'not sending';

  // An IMU that has died leaves every axis at exactly zero, including the die
  // temperature — which a working sensor never reports.
  const imuDead = att && att.ax === 0 && att.ay === 0 && att.az === 0
                      && (att.temp_c === 0 || att.temp_c == null);
  const imuOk = espOk && att && !imuDead;
  $('d-imu').className = 'dot ' + (imuOk ? 'ok' : espOk ? 'bad' : '');
  $('r-imu').textContent = !espOk ? '—'
    : imuOk ? `${att.temp_c.toFixed(0)} °C` : 'no reply';

  // The sonar cannot distinguish "nothing in range" from "broken", so neither
  // does this: it reports fitted once a real return has ever arrived.
  const sonFitted = prox && prox.t;
  $('d-son').className = 'dot ' + (!espOk || !sonFitted ? ''
                                 : sonarEverSeen ? 'ok' : '');
  $('r-son').textContent = !espOk ? '—'
    : !sonFitted ? 'not fitted'
    : prox.range_m != null ? `${prox.range_m.toFixed(2)} m`
    : sonarEverSeen ? 'nothing in range' : 'no returns yet';
}

async function tick() {
  if (!nodeId) {
    nodeId = await findNode();
    if (!nodeId) { setIdle(true, 'waiting'); updateHealth(null, null, null); return; }
    $('nodeid').textContent = nodeId;
  }

  // Both in parallel. Awaiting them one after the other cost two round trips
  // per tick and held the page to roughly a third of the rate the board was
  // actually publishing at, which showed up as a visibly laggy readout.
  const [att, prox] = await Promise.all([
    j(`/api/attitude/${nodeId}`),
    j(`/api/proximity/${nodeId}`),
  ]);
  if (!att) { nodeId = null; setIdle(true, 'waiting'); return; }

  const age = Date.now() / 1000 - att.t;
  $('attage').textContent = `${age.toFixed(1)} s ago`;
  if (age > STALE_S) {
    // it was here and has stopped: say so rather than freezing on stale data
    setIdle(true, 'stopped');
    updateHealth(att, null, age);
    return;
  }
  setIdle(false);

  const dist = updateDistance(prox);

  // one history row per genuinely new sample, since we poll faster than it sends
  const last = hist[hist.length - 1];
  if (!last || att.t > last.t) {
    hist.push({ t: att.t, pitch: att.pitch_deg, roll: att.roll_deg, dist });
    while (hist.length && hist[0].t < att.t - WINDOW_S - 2) hist.shift();

    packets++;
    const wall = performance.now();
    if (lastWall) rate = rate * 0.8 + (1000 / (wall - lastWall)) * 0.2;
    lastWall = wall;
    $('uprate').textContent = `${packets} readings`;
  }

  setAttitude(att.pitch_deg, att.roll_deg, att.yaw_deg);
  const cls = a => Math.abs(a) >= TIP_DEG ? 'v tip'
                 : Math.abs(a) >= LEAN_DEG ? 'v lean' : 'v';
  $('v-pitch').innerHTML = `${att.pitch_deg.toFixed(1)}<small>°</small>`;
  $('v-pitch').className = cls(att.pitch_deg);
  $('v-roll').innerHTML = `${att.roll_deg.toFixed(1)}<small>°</small>`;
  $('v-roll').className = cls(att.roll_deg);
  $('v-yaw').innerHTML = `${att.yaw_deg.toFixed(0)}<small>°</small>`;

  drawCharts();
  updateRibbon(att, dist);
  updateHealth(att, prox, age);
}

/* Returns the distance to show, which is the live reading when there is one and
   the last reading for a short while after it goes. */
function updateDistance(prox) {
  const fitted = prox && prox.t;
  const raw = fitted ? prox.range_m : null;
  const max = (prox && prox.max_range_m) || DIST_MAX;
  if (raw != null) sonarEverSeen = true;

  const now = performance.now();
  if (raw != null) { heldRange = raw; heldUntil = now + RELEASE_MS; }
  const holding = raw == null && heldRange != null && now < heldUntil;
  const r = raw != null ? raw : (holding ? heldRange : null);
  if (!holding && raw == null) heldRange = null;

  $('diststate').textContent = !fitted ? 'no sensor'
                             : raw != null ? 'something ahead'
                             : holding ? 'holding' : 'clear';
  $('rmax').textContent = `${max} m`;

  const v = $('v-dist'), fill = $('rulerfill');
  if (r != null) {
    if (raw != null) {
      // closing only counts when the move is bigger than the sensor's jitter
      closing = prevRange != null && (prevRange - raw) > 0.03;
      prevRange = raw;
    }
    v.className = 'dist-val ' + (r <= NEAR_M ? 'near' : '');
    v.innerHTML = `${r.toFixed(2)}<small> m</small>`
      + (closing ? '<span class="closing">getting closer</span>' : '');
    // the bar grows as the thing gets nearer, so closing looks like closing
    fill.style.width = `${Math.max(2, (1 - Math.min(1, r / max)) * 100)}%`;
    fill.style.opacity = '1';
    drawCone(1 - Math.min(1, r / max));
  } else {
    prevRange = null; closing = false;
    v.className = 'dist-val clear';
    v.textContent = fitted ? 'nothing in range' : '—';
    fill.style.width = '0';
    fill.style.opacity = '0';
    drawCone(0);
  }
  return r;
}

buildScene();
drawCharts();
setInterval(tick, 1000 / HZ);
tick();
